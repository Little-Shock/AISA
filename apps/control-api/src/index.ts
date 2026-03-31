import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import { config as loadEnv } from "dotenv";
import Fastify from "fastify";
import {
  CreateRunInputSchema,
  CreateGoalInputSchema,
  createBranch,
  createCurrentDecision,
  createEvent,
  createGoal,
  createRun,
  createRunJournalEntry,
  createRunSteer,
  createSteer,
  updateCurrentDecision,
  updateBranch,
  updateGoal
} from "@autoresearch/domain";
import { ContextManager } from "@autoresearch/context-manager";
import { appendEvent, listEvents } from "@autoresearch/event-log";
import {
  assessRunHealth,
  buildRuntimeWorkspaceScopeRoots,
  createRunWorkspaceScopePolicy,
  lockRunWorkspaceRoot,
  Orchestrator,
  resolveRuntimeLayout,
  syncRuntimeLayoutHint,
  RunWorkspaceScopeError
} from "@autoresearch/orchestrator";
import { buildSelfBootstrapRunTemplate, generateInitialPlan } from "@autoresearch/planner";
import {
  appendRunJournal,
  getAttemptContract,
  getAttemptContext,
  ensureWorkspace,
  getAttemptEvaluation,
  getAttemptHeartbeat,
  getAttemptReviewPacket,
  getAttemptLogExcerpt,
  getAttemptResult,
  getAttemptRuntimeState,
  getAttemptRuntimeVerification,
  getCurrentDecision,
  getBranch,
  getContextBoard,
  getGoal,
  getPlanArtifacts,
  getReport,
  getRun,
  getRunGovernanceState,
  getRunReport,
  getWriteback,
  listAttemptRuntimeEvents,
  listAttempts,
  listBranches,
  listGoals,
  listRunJournal,
  listRuns,
  listRunSteers,
  listSteers,
  listWorkerRuns,
  resolveWorkspacePaths,
  saveCurrentDecision,
  saveBranch,
  saveGoal,
  savePlanArtifacts,
  saveRun,
  saveRunSteer,
  saveSteer
} from "@autoresearch/state-store";
import { CodexCliWorkerAdapter, loadCodexCliConfig } from "@autoresearch/worker-adapters";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(currentDir, "..", "..", "..");
loadEnv({ path: join(repositoryRoot, ".env") });

function inferLaunchAttemptType(input: {
  current: Awaited<ReturnType<typeof getCurrentDecision>> | null;
  attempts: Awaited<ReturnType<typeof listAttempts>>;
}): "research" | "execution" {
  const latestAttempt =
    input.current?.latest_attempt_id
      ? input.attempts.find((attempt) => attempt.id === input.current?.latest_attempt_id) ?? null
      : input.attempts.at(-1) ?? null;

  return (
    input.current?.recommended_attempt_type ??
    latestAttempt?.attempt_type ??
    "research"
  );
}

function inferLaunchNextAction(input: {
  current: Awaited<ReturnType<typeof getCurrentDecision>> | null;
  attempts: Awaited<ReturnType<typeof listAttempts>>;
}): string {
  const currentAction = input.current?.recommended_next_action;
  if (currentAction && currentAction !== "wait_for_human") {
    return currentAction;
  }

  const latestAttempt =
    input.current?.latest_attempt_id
      ? input.attempts.find((attempt) => attempt.id === input.current?.latest_attempt_id) ?? null
      : input.attempts.at(-1) ?? null;

  if (!latestAttempt) {
    return "start_first_attempt";
  }

  if (latestAttempt.status === "failed" || latestAttempt.status === "stopped") {
    return "retry_attempt";
  }

  return inferLaunchAttemptType(input) === "execution"
    ? "continue_execution"
    : "continue_research";
}

export async function buildServer(
  options: {
    workspaceRoot?: string;
    runtimeRepoRoot?: string;
    devRepoRoot?: string;
    runtimeDataRoot?: string;
    managedWorkspaceRoot?: string;
    startOrchestrator?: boolean;
    allowedRunWorkspaceRoots?: string[];
    enableSelfRestart?: boolean;
  } = {}
) {
  const runtimeLayout = resolveRuntimeLayout({
    repositoryRoot,
    workspaceRoot: options.workspaceRoot,
    runtimeRepoRoot: options.runtimeRepoRoot,
    devRepoRoot: options.devRepoRoot,
    runtimeDataRoot: options.runtimeDataRoot,
    managedWorkspaceRoot: options.managedWorkspaceRoot,
    env: process.env
  });
  syncRuntimeLayoutHint(runtimeLayout);
  const workspacePaths = resolveWorkspacePaths(runtimeLayout.runtimeDataRoot);
  const defaultRunWorkspaceRoot = runtimeLayout.devRepoRoot;
  const contextManager = new ContextManager();
  const adapter = new CodexCliWorkerAdapter(loadCodexCliConfig(process.env));
  const app = Fastify({
    logger: true
  });
  const runHealthStaleMs = readPositiveIntegerEnv("AISA_RUN_HEALTH_STALE_MS", 180_000);
  const runWorkspaceScopePolicy = await createRunWorkspaceScopePolicy({
    runtimeRoot: runtimeLayout.runtimeRepoRoot,
    allowedRoots: buildRuntimeWorkspaceScopeRoots(
      runtimeLayout,
      options.allowedRunWorkspaceRoots
    ),
    envValue: process.env.AISA_ALLOWED_WORKSPACE_ROOTS,
    managedWorkspaceRoot: runtimeLayout.managedWorkspaceRoot
  });
  let orchestratorStarted = false;
  let restartPending = false;
  let orchestrator: Orchestrator;
  const requestRuntimeRestart = (request: {
    runId: string;
    attemptId: string;
    reason: "runtime_source_drift" | "runtime_promotion";
    affectedFiles: string[];
    message: string;
    promotedSha?: string | null;
  }): void => {
    if (!options.enableSelfRestart || restartPending) {
      return;
    }

    restartPending = true;
    app.log.warn(
      {
        run_id: request.runId,
        attempt_id: request.attemptId,
        reason: request.reason,
        affected_files: request.affectedFiles,
        promoted_sha: request.promotedSha ?? null
      },
      "Runtime restart requested. Scheduling control-api restart."
    );

    if (orchestratorStarted) {
      orchestrator.stop();
      orchestratorStarted = false;
    }

    setTimeout(() => {
      void app.close().finally(() => {
        process.exit(readRestartExitCode());
      });
    }, 0);
  };
  orchestrator = new Orchestrator(workspacePaths, adapter, undefined, undefined, {
    runWorkspaceScopePolicy,
    requestRuntimeRestart,
    runtimeLayout
  });

  await ensureWorkspace(workspacePaths);
  await app.register(cors, {
    origin: true
  });

  if (options.startOrchestrator !== false) {
    app.addHook("onListen", async () => {
      if (orchestratorStarted) {
        return;
      }
      orchestrator.start();
      orchestratorStarted = true;
    });
  }

  app.addHook("onClose", async () => {
    if (orchestratorStarted) {
      orchestrator.stop();
      orchestratorStarted = false;
    }
  });

  const buildAttemptDetail = async (input: {
    runId: string;
    attempt: Awaited<ReturnType<typeof listAttempts>>[number];
    journal: Awaited<ReturnType<typeof listRunJournal>>;
  }) => {
    const { runId, attempt, journal } = input;
    const [
      contract,
      context,
      reviewPacket,
      result,
      evaluation,
      runtimeVerification,
      runtimeState,
      runtimeEvents,
      heartbeat,
      stdoutExcerpt,
      stderrExcerpt
    ] = await Promise.all([
      getAttemptContract(workspacePaths, runId, attempt.id),
      getAttemptContext(workspacePaths, runId, attempt.id),
      getAttemptReviewPacket(workspacePaths, runId, attempt.id),
      getAttemptResult(workspacePaths, runId, attempt.id),
      getAttemptEvaluation(workspacePaths, runId, attempt.id),
      getAttemptRuntimeVerification(workspacePaths, runId, attempt.id),
      getAttemptRuntimeState(workspacePaths, runId, attempt.id),
      listAttemptRuntimeEvents(workspacePaths, runId, attempt.id, 80),
      getAttemptHeartbeat(workspacePaths, runId, attempt.id),
      getAttemptLogExcerpt(workspacePaths, runId, attempt.id, "stdout"),
      getAttemptLogExcerpt(workspacePaths, runId, attempt.id, "stderr")
    ]);

    return {
      attempt,
      contract,
      context,
      failure_context: reviewPacket?.failure_context ?? null,
      result,
      evaluation,
      runtime_verification: runtimeVerification,
      runtime_state: runtimeState,
      runtime_events: runtimeEvents,
      heartbeat,
      stdout_excerpt: stdoutExcerpt,
      stderr_excerpt: stderrExcerpt,
      journal: journal.filter((entry) => entry.attempt_id === attempt.id)
    };
  };

  const buildRunDetailPayload = async (runId: string) => {
    const [run, current, governance, attempts, steers, journal, report] = await Promise.all([
      getRun(workspacePaths, runId),
      getCurrentDecision(workspacePaths, runId),
      getRunGovernanceState(workspacePaths, runId),
      listAttempts(workspacePaths, runId),
      listRunSteers(workspacePaths, runId),
      listRunJournal(workspacePaths, runId),
      getRunReport(workspacePaths, runId)
    ]);
    const attemptDetails = await Promise.all(
      attempts.map((attempt) =>
        buildAttemptDetail({
          runId,
          attempt,
          journal
        })
      )
    );
    const latestAttempt =
      attempts.find((attempt) => attempt.id === current?.latest_attempt_id) ??
      attempts.at(-1) ??
      null;
    const latestAttemptDetail =
      attemptDetails.find((detail) => detail.attempt.id === latestAttempt?.id) ?? null;
    const runHealth = assessRunHealth({
      current,
      latestAttempt,
      latestRuntimeState: latestAttemptDetail?.runtime_state ?? null,
      latestHeartbeat: latestAttemptDetail?.heartbeat ?? null,
      staleAfterMs: runHealthStaleMs
    });

    return {
      run,
      current,
      governance,
      run_health: runHealth,
      attempts,
      attempt_details: attemptDetails,
      steers,
      journal,
      report
    };
  };

  const buildRunSummaryItem = async (run: Awaited<ReturnType<typeof listRuns>>[number]) => {
    const [current, governance, attempts] = await Promise.all([
      getCurrentDecision(workspacePaths, run.id),
      getRunGovernanceState(workspacePaths, run.id),
      listAttempts(workspacePaths, run.id)
    ]);
    const latestAttempt =
      attempts.find((attempt) => attempt.id === current?.latest_attempt_id) ??
      attempts.at(-1) ??
      null;
    const [latestContract, latestRuntimeState, latestHeartbeat] = await Promise.all([
      latestAttempt
        ? getAttemptContract(workspacePaths, run.id, latestAttempt.id)
        : Promise.resolve(null),
      latestAttempt
        ? getAttemptRuntimeState(workspacePaths, run.id, latestAttempt.id)
        : Promise.resolve(null),
      latestAttempt
        ? getAttemptHeartbeat(workspacePaths, run.id, latestAttempt.id)
        : Promise.resolve(null)
    ]);

    return {
      run,
      current,
      governance,
      run_health: assessRunHealth({
        current,
        latestAttempt,
        latestRuntimeState,
        latestHeartbeat,
        staleAfterMs: runHealthStaleMs
      }),
      attempt_count: attempts.length,
      latest_attempt: latestAttempt
        ? {
            id: latestAttempt.id,
            attempt_type: latestAttempt.attempt_type,
            status: latestAttempt.status,
            worker: latestAttempt.worker,
            objective: latestAttempt.objective,
            created_at: latestAttempt.created_at,
            started_at: latestAttempt.started_at,
            ended_at: latestAttempt.ended_at
          }
        : null,
      latest_attempt_runtime_state: latestRuntimeState,
      latest_attempt_heartbeat: latestHeartbeat,
      task_focus: latestContract?.objective ?? latestAttempt?.objective ?? run.description,
      verification_command_count:
        latestContract?.verification_plan?.commands.length ?? 0
    };
  };

  app.get("/health", async () => {
    const runSummaries = await Promise.all((await listRuns(workspacePaths)).map((run) => buildRunSummaryItem(run)));
    const degradedRuns = runSummaries
      .filter((item) => item.run_health.likely_zombie)
      .map((item) => ({
        run_id: item.run.id,
        title: item.run.title,
        latest_attempt_id: item.run_health.latest_attempt_id,
        status: item.run_health.status,
        summary: item.run_health.summary,
        latest_activity_at: item.run_health.latest_activity_at,
        latest_activity_age_ms: item.run_health.latest_activity_age_ms
      }));

    return {
      status: degradedRuns.length > 0 ? "degraded" : "ok",
      codex_command: process.env.CODEX_CLI_COMMAND ?? "codex",
      codex_model: process.env.CODEX_MODEL ?? null,
      runtime_layout: {
        repository_root: runtimeLayout.repositoryRoot,
        dev_repo_root: runtimeLayout.devRepoRoot,
        runtime_repo_root: runtimeLayout.runtimeRepoRoot,
        runtime_data_root: runtimeLayout.runtimeDataRoot,
        managed_workspace_root: runtimeLayout.managedWorkspaceRoot
      },
      allowed_run_workspace_roots: runWorkspaceScopePolicy.allowedRoots,
      run_health_stale_ms: runHealthStaleMs,
      run_count: runSummaries.length,
      degraded_run_count: degradedRuns.length,
      degraded_runs: degradedRuns
    };
  });

  app.get("/runs", async () => {
    const runs = await listRuns(workspacePaths);
    const data = await Promise.all(runs.map((run) => buildRunSummaryItem(run)));

    return { runs: data };
  });

  app.get("/runs/:runId", async (request, reply) => {
    const { runId } = request.params as { runId: string };

    try {
      return await buildRunDetailPayload(runId);
    } catch {
      return reply.code(404).send({ message: `Run ${runId} not found` });
    }
  });

  app.get("/runs/:runId/stream", async (request, reply) => {
    const { runId } = request.params as { runId: string };

    try {
      await getRun(workspacePaths, runId);
    } catch {
      return reply.code(404).send({ message: `Run ${runId} not found` });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    reply.raw.write(": connected\n\n");

    let closed = false;
    let lastSnapshot = "";
    let snapshotTimer: NodeJS.Timeout | null = null;
    let keepAliveTimer: NodeJS.Timeout | null = null;

    const closeStream = () => {
      if (closed) {
        return;
      }

      closed = true;
      if (snapshotTimer) {
        clearInterval(snapshotTimer);
      }
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
      }
      reply.raw.end();
    };

    const pushSnapshot = async () => {
      if (closed) {
        return;
      }

      try {
        const snapshot = await buildRunDetailPayload(runId);
        const serialized = JSON.stringify(snapshot);
        if (serialized === lastSnapshot) {
          return;
        }

        lastSnapshot = serialized;
        reply.raw.write(`event: snapshot\ndata: ${serialized}\n\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply.raw.write(
          `event: error\ndata: ${JSON.stringify({ message })}\n\n`
        );
      }
    };

    request.raw.on("close", closeStream);
    request.raw.on("end", closeStream);

    snapshotTimer = setInterval(() => {
      void pushSnapshot();
    }, 1000);
    keepAliveTimer = setInterval(() => {
      if (!closed) {
        reply.raw.write(`: keepalive ${Date.now()}\n\n`);
      }
    }, 15_000);

    await pushSnapshot();
    return reply;
  });

  app.post("/runs", async (request, reply) => {
    try {
      const input = CreateRunInputSchema.parse(request.body);
      const lockedWorkspaceRoot = await lockWorkspaceRootOrThrow(
        input.workspace_root ?? defaultRunWorkspaceRoot
      );
      const run = createRun({
        ...input,
        workspace_root: lockedWorkspaceRoot
      });
      const current = createCurrentDecision({
        run_id: run.id,
        run_status: "draft",
        summary: "Run created. Waiting for first attempt."
      });

      await saveRun(workspacePaths, run);
      await saveCurrentDecision(workspacePaths, current);
      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: run.id,
          type: "run.created",
          payload: {
            title: run.title,
            owner_id: run.owner_id,
            workspace_root: run.workspace_root
          }
        })
      );

      return reply.code(201).send({ run, current });
    } catch (error) {
      return reply.code(400).send({
        message: describeWorkspaceScopeError(error)
      });
    }
  });

  app.post("/runs/self-bootstrap", async (request, reply) => {
    const body = (request.body as
      | {
          owner_id?: string;
          focus?: string;
          launch?: boolean;
          seed_steer?: boolean;
        }
      | undefined) ?? {
      launch: true,
      seed_steer: true
    };
    const template = buildSelfBootstrapRunTemplate({
      workspaceRoot: runtimeLayout.devRepoRoot,
      ownerId: body.owner_id,
      focus: body.focus
    });
    let run;
    try {
      const lockedWorkspaceRoot = await lockWorkspaceRootOrThrow(
        template.runInput.workspace_root ?? defaultRunWorkspaceRoot
      );
      run = createRun({
        ...template.runInput,
        workspace_root: lockedWorkspaceRoot
      });
    } catch (error) {
      return reply.code(400).send({
        message: describeWorkspaceScopeError(error)
      });
    }
    let current = createCurrentDecision({
      run_id: run.id,
      run_status: "draft",
      summary: "Self-bootstrap run created. Waiting to launch."
    });

    await saveRun(workspacePaths, run);
    await saveCurrentDecision(workspacePaths, current);
    await appendRunJournal(
      workspacePaths,
      createRunJournalEntry({
        run_id: run.id,
        type: "run.created",
        payload: {
          title: run.title,
          owner_id: run.owner_id,
          template: "self-bootstrap"
        }
      })
    );

    let runSteer = null;
    if (body.seed_steer !== false) {
      runSteer = createRunSteer({
        run_id: run.id,
        content: template.initialSteer
      });
      await saveRunSteer(workspacePaths, runSteer);
      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: run.id,
          type: "run.steer.queued",
          payload: {
            content: runSteer.content,
            template: "self-bootstrap"
          }
        })
      );
    }

    if (body.launch !== false) {
      current = updateCurrentDecision(current, {
        run_status: "running",
        waiting_for_human: false,
        blocking_reason: null,
        recommended_next_action: "start_first_attempt",
        recommended_attempt_type: "research",
        summary: "Self-bootstrap run launched. Loop will create the first attempt."
      });
      await saveCurrentDecision(workspacePaths, current);
      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: run.id,
          type: "run.launched",
          payload: {
            template: "self-bootstrap"
          }
        })
      );
    }

    return reply.code(201).send({
      run,
      current,
      steer: runSteer,
      template: "self-bootstrap"
    });
  });

  app.post("/runs/:runId/launch", async (request, reply) => {
    const { runId } = request.params as { runId: string };

    try {
      const run = await getRun(workspacePaths, runId);
      await lockWorkspaceRootOrThrow(run.workspace_root);
      const attempts = await listAttempts(workspacePaths, runId);
      const current =
        (await getCurrentDecision(workspacePaths, runId)) ??
        createCurrentDecision({
          run_id: runId,
          run_status: "draft"
        });
      const nextAction = inferLaunchNextAction({
        current,
        attempts
      });
      const nextAttemptType = inferLaunchAttemptType({
        current,
        attempts
      });

      const nextCurrent = updateCurrentDecision(current, {
        run_status: "running",
        waiting_for_human: false,
        blocking_reason: null,
        recommended_next_action: nextAction,
        recommended_attempt_type: nextAttemptType,
        summary:
          current.latest_attempt_id === null
            ? "Run launched. Loop will create the first attempt."
            : "Run resumed. Loop will continue from the latest decision."
      });

      await saveCurrentDecision(workspacePaths, nextCurrent);
      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          type: "run.launched",
          payload: {}
        })
      );

      return { current: nextCurrent };
    } catch (error) {
      if (error instanceof RunWorkspaceScopeError) {
        return reply.code(400).send({ message: error.message });
      }
      return reply.code(404).send({ message: `Run ${runId} not found` });
    }
  });

  app.post("/runs/:runId/steers", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body = request.body as {
      content: string;
      attempt_id?: string | null;
    };

    try {
      await getRun(workspacePaths, runId);
      const runSteer = createRunSteer({
        run_id: runId,
        attempt_id: body.attempt_id ?? null,
        content: body.content
      });
      await saveRunSteer(workspacePaths, runSteer);

      const current =
        (await getCurrentDecision(workspacePaths, runId)) ??
        createCurrentDecision({
          run_id: runId,
          run_status: "draft"
        });
      const nextCurrent = updateCurrentDecision(current, {
        run_status: "running",
        waiting_for_human: false,
        blocking_reason: null,
        recommended_next_action: "apply_steer",
        summary: "Steer queued. Loop will use it in the next attempt."
      });
      await saveCurrentDecision(workspacePaths, nextCurrent);

      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: runSteer.attempt_id,
          type: "run.steer.queued",
          payload: {
            content: runSteer.content
          }
        })
      );

      return reply.code(201).send({ steer: runSteer, current: nextCurrent });
    } catch {
      return reply.code(404).send({ message: `Run ${runId} not found` });
    }
  });

  app.get("/goals", async () => {
    const goals = await listGoals(workspacePaths);
    const data = await Promise.all(
      goals.map(async (goal) => {
        const branches = await listBranches(workspacePaths, goal.id);
        return {
          goal,
          branch_count: branches.length,
          running_count: branches.filter((branch) => branch.status === "running").length,
          kept_count: branches.filter((branch) => branch.status === "kept").length
        };
      })
    );
    return { goals: data };
  });

  app.get("/goals/:goalId", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    try {
      const [goal, branches, workerRuns, steers, events, context, report] =
        await Promise.all([
          getGoal(workspacePaths, goalId),
          listBranches(workspacePaths, goalId),
          listWorkerRuns(workspacePaths, goalId),
          listSteers(workspacePaths, goalId),
          listEvents(workspacePaths, goalId),
          getContextBoard(workspacePaths, goalId),
          getReport(workspacePaths, goalId)
        ]);

      const branchDetails = await Promise.all(
        branches.map(async (branch) => ({
          branch,
          writeback: await getWriteback(workspacePaths, goalId, branch.id)
        }))
      );

      return {
        goal,
        branches: branchDetails,
        worker_runs: workerRuns,
        steers,
        context,
        report,
        events
      };
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  app.post("/goals", async (request, reply) => {
    const input = CreateGoalInputSchema.parse(request.body);
    const goal = createGoal(input);

    await saveGoal(workspacePaths, goal);
    await contextManager.initializeGoal(workspacePaths, goal);
    await appendEvent(
      workspacePaths,
      createEvent({
        goal_id: goal.id,
        type: "goal.created",
        payload: {
          title: goal.title,
          owner_id: goal.owner_id
        }
      })
    );

    return reply.code(201).send({ goal });
  });

  app.post("/goals/:goalId/plan", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    try {
      const goal = await getGoal(workspacePaths, goalId);
      const plan = generateInitialPlan(goal);

      await savePlanArtifacts(
        workspacePaths,
        goal.id,
        plan.planMarkdown,
        plan.branchSpecs,
        plan.evalSpec
      );

      await appendEvent(
        workspacePaths,
        createEvent({
          goal_id: goal.id,
          type: "plan.generated",
          payload: {
            branch_count: plan.branchSpecs.length,
            dimensions: plan.evalSpec.dimensions
          }
        })
      );

      return {
        goal_id: goal.id,
        branch_specs: plan.branchSpecs,
        eval_spec: plan.evalSpec
      };
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  app.post("/goals/:goalId/launch", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    try {
      let goal = await getGoal(workspacePaths, goalId);
      let plan = await getPlanArtifacts(workspacePaths, goalId);

      if (!plan) {
        const generated = generateInitialPlan(goal);
        await savePlanArtifacts(
          workspacePaths,
          goal.id,
          generated.planMarkdown,
          generated.branchSpecs,
          generated.evalSpec
        );
        plan = generated;
      }

      const existingBranches = await listBranches(workspacePaths, goal.id);
      if (existingBranches.length === 0) {
        for (const spec of plan.branchSpecs) {
          const branch = createBranch(goal.id, spec, "pending");
          const queuedBranch = updateBranch(branch, {
            status: "queued"
          });
          await saveBranch(workspacePaths, queuedBranch);
          await appendEvent(
            workspacePaths,
            createEvent({
              goal_id: goal.id,
              branch_id: queuedBranch.id,
              type: "branch.spawned",
              payload: {
                hypothesis: queuedBranch.hypothesis
              }
            })
          );
          await appendEvent(
            workspacePaths,
            createEvent({
              goal_id: goal.id,
              branch_id: queuedBranch.id,
              type: "branch.queued",
              payload: {
                reason: "goal.launch"
              }
            })
          );
        }
      }

      goal = updateGoal(goal, {
        status: "planned"
      });
      await saveGoal(workspacePaths, goal);

      return {
        goal,
        branch_count: (await listBranches(workspacePaths, goal.id)).length
      };
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  app.post("/goals/:goalId/steers", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const body = request.body as {
      content: string;
      scope?: "goal" | "branch" | "worker";
      branch_id?: string | null;
    };

    try {
      await getGoal(workspacePaths, goalId);
      const steer = createSteer({
        goal_id: goalId,
        branch_id: body.branch_id ?? null,
        scope: body.scope ?? "goal",
        content: body.content
      });
      await saveSteer(workspacePaths, steer);
      await appendEvent(
        workspacePaths,
        createEvent({
          goal_id: goalId,
          branch_id: steer.branch_id,
          type: "steer.queued",
          payload: {
            content: steer.content,
            scope: steer.scope
          }
        })
      );

      return reply.code(201).send({ steer });
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  app.post("/goals/:goalId/branches/:branchId/rerun", async (request, reply) => {
    const { goalId, branchId } = request.params as { goalId: string; branchId: string };

    try {
      const branch = await getBranch(workspacePaths, goalId, branchId);
      const queuedBranch = updateBranch(branch, {
        status: "queued",
        score: null,
        confidence: null
      });
      await saveBranch(workspacePaths, queuedBranch);
      await appendEvent(
        workspacePaths,
        createEvent({
          goal_id: goalId,
          branch_id: branchId,
          type: "branch.queued",
          payload: {
            rerun: true
          }
        })
      );

      return { branch: queuedBranch };
    } catch {
      return reply.code(404).send({ message: `Branch ${branchId} not found` });
    }
  });

  app.get("/goals/:goalId/report", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    try {
      await getGoal(workspacePaths, goalId);
      return {
        report: await getReport(workspacePaths, goalId)
      };
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  app.get("/goals/:goalId/context", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    try {
      await getGoal(workspacePaths, goalId);
      return {
        context: await getContextBoard(workspacePaths, goalId)
      };
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  async function lockWorkspaceRootOrThrow(
    workspaceRoot: string
  ): Promise<string> {
    const lockedWorkspace = await lockRunWorkspaceRoot(
      workspaceRoot,
      runWorkspaceScopePolicy
    );
    return lockedWorkspace.resolvedRoot;
  }

  function describeWorkspaceScopeError(error: unknown): string {
    if (error instanceof RunWorkspaceScopeError) {
      return error.message;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  return app;
}

const port = Number(process.env.CONTROL_API_PORT ?? process.env.PORT ?? "8787");
const host = process.env.CONTROL_API_HOST ?? process.env.HOST ?? "127.0.0.1";

const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  buildServer({
    enableSelfRestart:
      process.env.AISA_CONTROL_API_ENABLE_SELF_RESTART === "1" ||
      process.env.AISA_CONTROL_API_SUPERVISED === "1"
  })
    .then((app) => app.listen({ port, host }))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

function readRestartExitCode(): number {
  const raw = process.env.AISA_CONTROL_API_RESTART_EXIT_CODE;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 75;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
