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
import { Orchestrator } from "@autoresearch/orchestrator";
import { buildSelfBootstrapRunTemplate, generateInitialPlan } from "@autoresearch/planner";
import {
  appendRunJournal,
  getAttemptContract,
  ensureWorkspace,
  getAttemptEvaluation,
  getAttemptLogExcerpt,
  getAttemptResult,
  getAttemptRuntimeVerification,
  getCurrentDecision,
  getBranch,
  getContextBoard,
  getGoal,
  getPlanArtifacts,
  getReport,
  getRun,
  getRunReport,
  getWriteback,
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

export async function buildServer(
  options: {
    workspaceRoot?: string;
    startOrchestrator?: boolean;
  } = {}
) {
  const runtimeRoot = options.workspaceRoot ?? repositoryRoot;
  const workspacePaths = resolveWorkspacePaths(runtimeRoot);
  const contextManager = new ContextManager();
  const adapter = new CodexCliWorkerAdapter(loadCodexCliConfig(process.env));
  const orchestrator = new Orchestrator(workspacePaths, adapter);
  const app = Fastify({
    logger: true
  });
  let orchestratorStarted = false;

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

  app.get("/health", async () => ({
    status: "ok",
    codex_command: process.env.CODEX_CLI_COMMAND ?? "codex",
    codex_model: process.env.CODEX_MODEL ?? null
  }));

  app.get("/runs", async () => {
    const runs = await listRuns(workspacePaths);
    const data = await Promise.all(
      runs.map(async (run) => {
        const [current, attempts] = await Promise.all([
          getCurrentDecision(workspacePaths, run.id),
          listAttempts(workspacePaths, run.id)
        ]);
        const latestAttempt =
          attempts.find((attempt) => attempt.id === current?.latest_attempt_id) ??
          attempts.at(-1) ??
          null;
        const latestContract = latestAttempt
          ? await getAttemptContract(workspacePaths, run.id, latestAttempt.id)
          : null;

        return {
          run,
          current,
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
          task_focus: latestContract?.objective ?? latestAttempt?.objective ?? run.description,
          verification_command_count:
            latestContract?.verification_plan?.commands.length ?? 0
        };
      })
    );

    return { runs: data };
  });

  app.get("/runs/:runId", async (request, reply) => {
    const { runId } = request.params as { runId: string };

    try {
      const [run, current, attempts, steers, journal, report] = await Promise.all([
        getRun(workspacePaths, runId),
        getCurrentDecision(workspacePaths, runId),
        listAttempts(workspacePaths, runId),
        listRunSteers(workspacePaths, runId),
        listRunJournal(workspacePaths, runId),
        getRunReport(workspacePaths, runId)
      ]);
      const attemptDetails = await Promise.all(
        attempts.map(async (attempt) => ({
          attempt,
          contract: await getAttemptContract(workspacePaths, runId, attempt.id),
          result: await getAttemptResult(workspacePaths, runId, attempt.id),
          evaluation: await getAttemptEvaluation(workspacePaths, runId, attempt.id),
          runtime_verification: await getAttemptRuntimeVerification(
            workspacePaths,
            runId,
            attempt.id
          ),
          stdout_excerpt: await getAttemptLogExcerpt(
            workspacePaths,
            runId,
            attempt.id,
            "stdout"
          ),
          stderr_excerpt: await getAttemptLogExcerpt(
            workspacePaths,
            runId,
            attempt.id,
            "stderr"
          ),
          journal: journal.filter((entry) => entry.attempt_id === attempt.id)
        }))
      );

      return {
        run,
        current,
        attempts,
        attempt_details: attemptDetails,
        steers,
        journal,
        report
      };
    } catch {
      return reply.code(404).send({ message: `Run ${runId} not found` });
    }
  });

  app.post("/runs", async (request, reply) => {
    const input = CreateRunInputSchema.parse(request.body);
    const run = createRun(input);
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
          owner_id: run.owner_id
        }
      })
    );

    return reply.code(201).send({ run, current });
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
      workspaceRoot: runtimeRoot,
      ownerId: body.owner_id,
      focus: body.focus
    });
    const run = createRun(template.runInput);
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
      await getRun(workspacePaths, runId);
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
        recommended_next_action:
          current.recommended_next_action ?? "start_first_attempt",
        recommended_attempt_type:
          current.recommended_attempt_type ?? "research",
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
    } catch {
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

  return app;
}

const port = Number(process.env.CONTROL_API_PORT ?? process.env.PORT ?? "8787");
const host = process.env.CONTROL_API_HOST ?? process.env.HOST ?? "127.0.0.1";

const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  buildServer()
    .then((app) => app.listen({ port, host }))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
