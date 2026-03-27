import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  createAttempt,
  createAttemptContract,
  createCurrentDecision,
  createEvent,
  createRunJournalEntry,
  createWorkerRun,
  finishWorkerRun,
  isExecutionAttemptContractReady,
  isExecutionContractDraftReady,
  updateAttempt,
  updateBranch,
  updateCurrentDecision,
  updateGoal,
  updateRunSteer,
  updateSteer,
  type Attempt,
  type AttemptContract,
  type AttemptContractDraft,
  type AttemptEvaluation,
  type AttemptReviewPacket,
  type AttemptRuntimeVerification,
  type Branch,
  type CurrentDecision,
  type ExecutionVerificationPlan,
  type EvalSpec,
  type Goal,
  type ReviewPacketArtifact,
  type Run,
  type WorkerWriteback
} from "@autoresearch/domain";
import { appendEvent } from "@autoresearch/event-log";
import { evaluateAttempt, evaluateBranch } from "@autoresearch/judge";
import { buildGoalReport } from "@autoresearch/report-builder";
import {
  appendRunJournal,
  getAttempt,
  getAttemptContract,
  getAttemptContext,
  getAttemptHeartbeat,
  getAttemptEvaluation,
  getAttemptReviewPacket,
  getAttemptResult,
  getAttemptRuntimeVerification,
  getCurrentDecision,
  getBranch,
  getContextBoard,
  getEvalResult,
  getGoal,
  getPlanArtifacts,
  getRun,
  getRunRuntimeHealthSnapshot,
  listAttempts,
  listRunJournal,
  getWriteback,
  listBranches,
  listGoals,
  listRuns,
  listRunSteers,
  listSteers,
  resolveAttemptPaths,
  resolveBranchArtifactPaths,
  resolveRunPaths,
  saveAttempt,
  saveAttemptContract,
  saveAttemptContext,
  saveAttemptEvaluation,
  saveAttemptHeartbeat,
  saveAttemptReviewPacket,
  saveAttemptResult,
  saveBranch,
  saveCurrentDecision,
  saveEvalResult,
  saveGoal,
  saveReport,
  saveRunReport,
  saveRunSteer,
  saveSteer,
  saveWorkerRun,
  type WorkspacePaths
} from "@autoresearch/state-store";
import { ContextManager } from "@autoresearch/context-manager";
import { CodexCliWorkerAdapter } from "@autoresearch/worker-adapters";
import {
  captureAttemptCheckpointPreflight,
  maybeCreateVerifiedExecutionCheckpoint,
  type AttemptCheckpointOutcome
} from "./git-checkpoint.js";
import {
  detectLiveRuntimeSourceDrift,
  runAttemptRuntimeVerification,
  type AttemptRuntimeVerificationOutcome
} from "./runtime-verification.js";
import {
  assertAttemptWorkspaceWithinRunScope,
  createDefaultRunWorkspaceScopePolicy,
  lockRunWorkspaceRoot,
  RunWorkspaceScopeError,
  type RunWorkspaceScopePolicy
} from "./workspace-scope.js";

export interface OrchestratorOptions {
  attemptHeartbeatIntervalMs?: number;
  attemptHeartbeatStaleMs?: number;
  waitingHumanAutoResumeMs?: number;
  maxAutomaticResumeCycles?: number;
  providerRateLimitAutoResumeMs?: number;
  maxProviderRateLimitAutoResumeCycles?: number;
  runtimeSourceDriftAutoResumeMs?: number;
  runWorkspaceScopePolicy?: RunWorkspaceScopePolicy;
  requestRuntimeRestart?: (request: RuntimeRestartRequest) => Promise<void> | void;
}

export type RuntimeRestartRequest = {
  runId: string;
  attemptId: string;
  affectedFiles: string[];
  message: string;
};

export class Orchestrator {
  private timer: NodeJS.Timeout | null = null;
  private readonly activeBranches = new Set<string>();
  private readonly activeAttempts = new Set<string>();
  private readonly instanceId = `orch_${randomUUID().slice(0, 8)}`;
  private readonly attemptHeartbeatIntervalMs: number;
  private readonly attemptHeartbeatStaleMs: number;
  private readonly waitingHumanAutoResumeMs: number;
  private readonly maxAutomaticResumeCycles: number;
  private readonly providerRateLimitAutoResumeMs: number;
  private readonly maxProviderRateLimitAutoResumeCycles: number;
  private readonly runtimeSourceDriftAutoResumeMs: number;
  private readonly runWorkspaceScopePolicy: RunWorkspaceScopePolicy;
  private readonly requestRuntimeRestart: ((
    request: RuntimeRestartRequest
  ) => Promise<void> | void) | null;
  private readonly instanceStartedAtMs: number;

  constructor(
    private readonly workspacePaths: WorkspacePaths,
    private readonly adapter: CodexCliWorkerAdapter,
    private readonly contextManager = new ContextManager(),
    private readonly pollIntervalMs = 1500,
    options: OrchestratorOptions = {}
  ) {
    this.attemptHeartbeatIntervalMs = options.attemptHeartbeatIntervalMs ?? 1000;
    this.attemptHeartbeatStaleMs = options.attemptHeartbeatStaleMs ?? 5000;
    this.waitingHumanAutoResumeMs =
      options.waitingHumanAutoResumeMs ??
      readPositiveIntegerEnv("AISA_WAITING_HUMAN_AUTO_RESUME_MS", 120_000);
    this.maxAutomaticResumeCycles =
      options.maxAutomaticResumeCycles ??
      readPositiveIntegerEnv("AISA_MAX_AUTOMATIC_RESUME_CYCLES", 3);
    this.providerRateLimitAutoResumeMs =
      options.providerRateLimitAutoResumeMs ??
      readPositiveIntegerEnv("AISA_PROVIDER_RATE_LIMIT_AUTO_RESUME_MS", 15_000);
    this.maxProviderRateLimitAutoResumeCycles =
      options.maxProviderRateLimitAutoResumeCycles ??
      readPositiveIntegerEnv("AISA_MAX_PROVIDER_RATE_LIMIT_AUTO_RESUME_CYCLES", 8);
    this.runtimeSourceDriftAutoResumeMs =
      options.runtimeSourceDriftAutoResumeMs ??
      readPositiveIntegerEnv("AISA_RUNTIME_SOURCE_DRIFT_AUTO_RESUME_MS", 1_000);
    this.runWorkspaceScopePolicy =
      options.runWorkspaceScopePolicy ??
      createDefaultRunWorkspaceScopePolicy(this.workspacePaths.rootDir);
    this.requestRuntimeRestart = options.requestRuntimeRestart ?? null;
    this.instanceStartedAtMs = Date.now();
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);

    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    const goals = await listGoals(this.workspacePaths);

    for (const goal of goals) {
      if (!["planned", "running", "reviewing"].includes(goal.status)) {
        continue;
      }

      const branches = await listBranches(this.workspacePaths, goal.id);
      const queuedBranches = branches.filter((branch) => branch.status === "queued");
      const runningCount = branches.filter((branch) => branch.status === "running").length;
      const availableSlots = Math.max(0, goal.budget.max_concurrency - runningCount);

      for (const branch of queuedBranches.slice(0, availableSlots)) {
        const activeKey = this.getActiveBranchKey(goal.id, branch.id);

        if (this.activeBranches.has(activeKey)) {
          continue;
        }

        this.activeBranches.add(activeKey);
        void this.executeBranch(goal.id, branch.id).finally(() => {
          this.activeBranches.delete(activeKey);
        });
      }
    }

    await this.tickRuns();
  }

  async executeBranch(goalId: string, branchId: string): Promise<void> {
    const goal = await getGoal(this.workspacePaths, goalId);
    let branch = await getBranch(this.workspacePaths, goalId, branchId);
    const plan = await getPlanArtifacts(this.workspacePaths, goalId);

    if (!plan) {
      throw new Error(`No plan artifacts found for goal ${goalId}`);
    }

    const queuedSteers = (await listSteers(this.workspacePaths, goalId)).filter(
      (steer) =>
        steer.status === "queued" &&
        (steer.scope === "goal" || steer.branch_id === branchId || steer.scope === "branch")
    );

    const snapshot = await this.contextManager.buildSnapshot({
      workspacePaths: this.workspacePaths,
      goal,
      branch,
      steers: queuedSteers
    });

    branch = updateBranch(branch, {
      status: "running",
      context_snapshot_id: snapshot.id
    });
    await saveBranch(this.workspacePaths, branch);
    await appendEvent(
      this.workspacePaths,
      createEvent({
        goal_id: goal.id,
        branch_id: branch.id,
        type: "worker.started",
        payload: {
          branch_id: branch.id,
          context_snapshot_id: snapshot.id
        }
      })
    );

    const artifactDir = resolveBranchArtifactPaths(
      this.workspacePaths,
      goal.id,
      branch.id
    ).branchDir;
    let run = createWorkerRun(
      goal.id,
      branch.id,
      this.adapter.type,
      {
        hypothesis: branch.hypothesis,
        objective: branch.objective,
        success_criteria: branch.success_criteria
      },
      artifactDir
    );

    await saveWorkerRun(this.workspacePaths, run);
    branch = updateBranch(branch, {
      latest_run_id: run.id
    });
    await saveBranch(this.workspacePaths, branch);

    try {
      const execution = await this.adapter.runBranchTask({
        goal,
        branch,
        contextSnapshot: snapshot,
        workspacePaths: this.workspacePaths
      });

      run = finishWorkerRun(run, {
        state: "completed",
        writeback_file: resolveBranchArtifactPaths(
          this.workspacePaths,
          goal.id,
          branch.id
        ).writebackFile
      });
      await saveWorkerRun(this.workspacePaths, run);
      await appendEvent(
        this.workspacePaths,
        createEvent({
          goal_id: goal.id,
          branch_id: branch.id,
          run_id: run.id,
          type: "worker.finished",
          payload: {
            writeback_file: run.writeback_file
          }
        })
      );

      await this.contextManager.applyWriteback({
        workspacePaths: this.workspacePaths,
        goal,
        branch,
        writeback: execution.writeback
      });

      const evaluation = evaluateBranch({
        goal,
        branch,
        writeback: execution.writeback,
        evalSpec: plan.evalSpec as EvalSpec
      });
      await saveEvalResult(this.workspacePaths, evaluation);

      branch = updateBranch(branch, {
        status:
          evaluation.recommendation === "keep"
            ? "kept"
            : evaluation.recommendation === "rerun"
              ? "respawned"
              : "discarded",
        score: evaluation.score,
        confidence: evaluation.confidence
      });
      await saveBranch(this.workspacePaths, branch);

      for (const steer of queuedSteers) {
        await saveSteer(
          this.workspacePaths,
          updateSteer(steer, {
            status: "applied"
          })
        );
      }

      await appendEvent(
        this.workspacePaths,
        createEvent({
          goal_id: goal.id,
          branch_id: branch.id,
          run_id: run.id,
          type: "judge.completed",
          payload: {
            recommendation: evaluation.recommendation,
            score: evaluation.score
          }
        })
      );

      await this.completeGoalIfDone(goal.id);
      await this.refreshGoalReport(goal.id);
    } catch (error) {
      run = finishWorkerRun(run, {
        state: "failed"
      });
      await saveWorkerRun(this.workspacePaths, run);
      branch = updateBranch(branch, {
        status: "failed"
      });
      await saveBranch(this.workspacePaths, branch);
      await appendEvent(
        this.workspacePaths,
        createEvent({
          goal_id: goal.id,
          branch_id: branch.id,
          run_id: run.id,
          type: "worker.failed",
          payload: {
            message: error instanceof Error ? error.message : String(error)
          }
        })
      );
    }
  }

  async refreshGoalReport(goalId: string): Promise<string> {
    const goal = await getGoal(this.workspacePaths, goalId);
    const branches = await listBranches(this.workspacePaths, goalId);
    const contextBoard = await getContextBoard(this.workspacePaths, goalId);
    const writebacks = Object.fromEntries(
      await Promise.all(
        branches.map(async (branch) => [branch.id, await getWriteback(this.workspacePaths, goalId, branch.id)] as const)
      )
    );
    const evaluations = Object.fromEntries(
      await Promise.all(
        branches.map(async (branch) => [branch.id, await getEvalResult(this.workspacePaths, goalId, branch.id)] as const)
      )
    );

    const report = buildGoalReport({
      goal,
      branches,
      contextBoard,
      writebacks,
      evaluations
    });

    await saveReport(this.workspacePaths, goalId, report);
    await appendEvent(
      this.workspacePaths,
      createEvent({
        goal_id: goalId,
        type: "report.updated",
        payload: {
          branch_count: branches.length
        }
      })
    );

    return report;
  }

  private async completeGoalIfDone(goalId: string): Promise<void> {
    const goal = await getGoal(this.workspacePaths, goalId);
    const branches = await listBranches(this.workspacePaths, goalId);

    if (
      branches.length > 0 &&
      branches.every((branch) =>
        ["kept", "discarded", "respawned", "failed", "stopped"].includes(branch.status)
      )
    ) {
      const nextStatus: Goal["status"] = branches.some((branch) => branch.status === "kept")
        ? "completed"
        : "failed";

      await saveGoal(
        this.workspacePaths,
        updateGoal(goal, {
          status: nextStatus
        })
      );
      await appendEvent(
        this.workspacePaths,
        createEvent({
          goal_id: goalId,
          type: "goal.completed",
          payload: {
            status: nextStatus
          }
        })
      );
    } else if (goal.status !== "running") {
      await saveGoal(
        this.workspacePaths,
        updateGoal(goal, {
          status: "running"
        })
      );
    }
  }

  private getActiveBranchKey(goalId: string, branchId: string): string {
    return `${goalId}:${branchId}`;
  }

  private async tickRuns(): Promise<void> {
    const runs = await listRuns(this.workspacePaths);

    for (const run of runs) {
      const current = await getCurrentDecision(this.workspacePaths, run.id);
      const attempts = await listAttempts(this.workspacePaths, run.id);
      await this.ensureSettledAttemptReviewPackets(run.id, current, attempts);

      if (!current) {
        continue;
      }

      const workspaceScopeError = await this.getRunWorkspaceScopeError(run);
      if (workspaceScopeError) {
        await this.persistRunWorkspaceScopeBlocked(run, current, workspaceScopeError);
        continue;
      }

      if (current.waiting_for_human) {
        await this.maybeAutoResumeWaitingRun(run.id, current, attempts);
        continue;
      }

      if (current.run_status !== "running") {
        continue;
      }

      const runningAttempt = attempts.find((attempt) => attempt.status === "running");

      if (runningAttempt) {
        const activeKey = this.getActiveAttemptKey(run.id, runningAttempt.id);

        if (!this.activeAttempts.has(activeKey)) {
          if (await this.isAttemptHeartbeatFresh(run.id, runningAttempt.id)) {
            continue;
          }

          await this.recoverRunningAttempt(run.id, runningAttempt, current);
        }
        continue;
      }

      const pendingAttempt = attempts.find((attempt) =>
        ["created", "queued"].includes(attempt.status)
      );

      if (pendingAttempt) {
        const activeKey = this.getActiveAttemptKey(run.id, pendingAttempt.id);
        if (!this.activeAttempts.has(activeKey)) {
          this.activeAttempts.add(activeKey);
          void this.executeAttempt(run.id, pendingAttempt.id).finally(() => {
            this.activeAttempts.delete(activeKey);
          });
        }
        continue;
      }

      if (this.hasActiveAttemptForRun(run.id)) {
        continue;
      }

      const nextAttempt = await this.planNextAttempt(run.id, current, attempts);
      if (!nextAttempt) {
        continue;
      }

      await saveAttempt(this.workspacePaths, nextAttempt.attempt);
      await saveAttemptContract(this.workspacePaths, nextAttempt.contract);
      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: run.id,
          attempt_id: nextAttempt.attempt.id,
          type: "attempt.created",
          payload: {
            attempt_type: nextAttempt.attempt.attempt_type,
            objective: nextAttempt.attempt.objective
          }
        })
      );
    }
  }

  private async recoverRunningAttempt(
    runId: string,
    attempt: Attempt,
    current: CurrentDecision | null
  ): Promise<void> {
    const message =
      `尝试 ${attempt.id} 在编排器恢复时仍被标记为运行中。` +
      "会先短暂等待人工接管，超时后自动恢复。";
    const stoppedAttempt = updateAttempt(attempt, {
      status: "stopped",
      ended_at: new Date().toISOString()
    });
    const nextCurrent = updateCurrentDecision(
      current ?? createCurrentDecision({ run_id: runId }),
      {
        run_status: "waiting_steer",
        latest_attempt_id: attempt.id,
        recommended_next_action: "wait_for_human",
        recommended_attempt_type: attempt.attempt_type,
        summary: message,
        blocking_reason: message,
        waiting_for_human: true
      }
    );

    await appendRunJournal(
      this.workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: attempt.id,
          type: "attempt.recovery_required",
          payload: {
            previous_status: attempt.status,
            recovery_policy: "auto_resume_after_human_window"
          }
        })
      );
    await this.saveSettledAttemptState({
      runId,
      attempt: stoppedAttempt,
      currentSnapshot: nextCurrent
    });
  }

  private async planNextAttempt(
    runId: string,
    current: CurrentDecision,
    attempts: Attempt[]
  ): Promise<{ attempt: Attempt; contract: AttemptContract } | null> {
    const run = await getRun(this.workspacePaths, runId);
    const queuedSteers = (await listRunSteers(this.workspacePaths, runId)).filter(
      (runSteer) => runSteer.status === "queued"
    );
    const latestAttempt = this.getLatestAttempt(current, attempts);
    const latestResult = latestAttempt
      ? await getAttemptResult(this.workspacePaths, run.id, latestAttempt.id)
      : null;
    const nextExecutionDraft = isExecutionContractDraftReady(
      latestResult?.next_attempt_contract
    )
      ? latestResult.next_attempt_contract
      : latestResult
        ? null
        : await this.findLatestExecutionContractDraft(run.id, attempts);

    if (attempts.length === 0) {
      if (queuedSteers.length > 0) {
        const attempt = createAttempt({
          run_id: run.id,
          attempt_type: "research",
          worker: this.adapter.type,
          objective: this.buildSteeredAttemptObjective(
            run,
            current,
            "research",
            null,
            queuedSteers.map((runSteer) => runSteer.content)
          ),
          success_criteria: run.success_criteria,
          workspace_root: run.workspace_root
        });
        return {
          attempt,
          contract: await this.buildAttemptContract(run, attempt, null, "start_first_attempt", null)
        };
      }

      const attempt = createAttempt({
        run_id: run.id,
        attempt_type: "research",
        worker: this.adapter.type,
        objective: `Understand the repository and surface the best next step for goal: ${run.title}`,
        success_criteria: run.success_criteria,
        workspace_root: run.workspace_root
      });
      return {
        attempt,
        contract: await this.buildAttemptContract(run, attempt, null, "start_first_attempt", null)
      };
    }

    if (current.waiting_for_human || current.run_status !== "running") {
      return null;
    }

    const attemptType =
      current.recommended_attempt_type ?? latestAttempt?.attempt_type ?? "research";
    const objective =
      queuedSteers.length > 0
        ? this.buildSteeredAttemptObjective(
            run,
            current,
            attemptType,
            latestResult,
            queuedSteers.map((runSteer) => runSteer.content)
          )
          : attemptType === "execution" && nextExecutionDraft?.objective
            ? nextExecutionDraft.objective
            : attemptType === "execution" && latestResult?.recommended_next_steps[0]
              ? latestResult.recommended_next_steps[0]
              : this.buildPlannedAttemptObjective(run, current, attemptType, latestResult);

    if (!objective) {
      return null;
    }

    const attempt = createAttempt({
      run_id: run.id,
      attempt_type: attemptType,
      worker: this.adapter.type,
      objective,
      success_criteria:
        attemptType === "execution" && nextExecutionDraft?.success_criteria
          ? nextExecutionDraft.success_criteria
          : run.success_criteria,
      workspace_root: run.workspace_root
    });
    return {
      attempt,
      contract: await this.buildAttemptContract(
        run,
        attempt,
        nextExecutionDraft,
        current.recommended_next_action,
        latestAttempt
      )
    };
  }

  private async executeAttempt(runId: string, attemptId: string): Promise<void> {
    const run = await getRun(this.workspacePaths, runId);
    let attempt = await getAttempt(this.workspacePaths, runId, attemptId);
    const attemptContract = await getAttemptContract(
      this.workspacePaths,
      runId,
      attemptId
    );
    const attemptPaths = resolveAttemptPaths(this.workspacePaths, runId, attemptId);
    const steers = await listRunSteers(this.workspacePaths, runId);
    const attempts = await listAttempts(this.workspacePaths, runId);
    const current = await getCurrentDecision(this.workspacePaths, runId);
    const previousAttempts = (
      await Promise.all(
        attempts
          .filter((item) => item.id !== attempt.id)
          .slice(-3)
          .map(async (item) => ({
            attempt: item,
            result: await getAttemptResult(this.workspacePaths, runId, item.id)
          }))
      )
    ).map(({ attempt: previousAttempt, result }) => ({
      id: previousAttempt.id,
      type: previousAttempt.attempt_type,
      status: previousAttempt.status,
      summary: result?.summary ?? ""
    }));
    const runtimeHealthSnapshot = await getRunRuntimeHealthSnapshot(
      this.workspacePaths,
      runId
    );

    const context = {
      contract: {
        title: run.title,
        description: run.description,
        success_criteria: run.success_criteria,
        constraints: run.constraints,
        workspace_root: run.workspace_root
      },
      current_decision: current,
      queued_steers: steers
        .filter((runSteer) => runSteer.status === "queued")
        .map((runSteer) => ({
          id: runSteer.id,
          content: runSteer.content
        })),
      previous_attempts: previousAttempts,
      ...(runtimeHealthSnapshot
        ? {
            runtime_health_snapshot: {
              path: relative(
                this.workspacePaths.rootDir,
                resolveRunPaths(this.workspacePaths, runId).runtimeHealthSnapshotFile
              ),
              verify_runtime: {
                status: runtimeHealthSnapshot.verify_runtime.status,
                summary: runtimeHealthSnapshot.verify_runtime.summary
              },
              history_contract_drift: {
                status: runtimeHealthSnapshot.history_contract_drift.status,
                summary: runtimeHealthSnapshot.history_contract_drift.summary,
                drift_count: runtimeHealthSnapshot.history_contract_drift.drift_count
              },
              created_at: runtimeHealthSnapshot.created_at
            }
          }
        : {})
    };

    let heartbeatTimer: NodeJS.Timeout | null = null;
    let heartbeatStarted = false;
    let runtimeRestartRequest: RuntimeRestartRequest | null = null;

    try {
      await this.assertAttemptWorkspaceScope(run, attempt);
      attempt = updateAttempt(attempt, {
        status: "running",
        started_at: new Date().toISOString()
      });
      await saveAttempt(this.workspacePaths, attempt);
      await saveCurrentDecision(
        this.workspacePaths,
        updateCurrentDecision(current ?? createCurrentDecision({ run_id: runId }), {
          run_status: "running",
          latest_attempt_id: attempt.id,
          recommended_next_action: "attempt_running",
          recommended_attempt_type: attempt.attempt_type,
          summary: `Running ${attempt.attempt_type} attempt: ${attempt.objective}`,
          blocking_reason: null,
          waiting_for_human: false
        })
      );
      await saveAttemptContext(this.workspacePaths, runId, attempt.id, context);
      attempt = updateAttempt(attempt, {
        input_context_ref: this.buildAttemptContextRef(runId, attempt.id)
      });
      await saveAttempt(this.workspacePaths, attempt);
      await this.writeAttemptHeartbeat({
        runId,
        attemptId: attempt.id,
        startedAt: attempt.started_at ?? new Date().toISOString(),
        status: "active"
      });
      heartbeatStarted = true;
      heartbeatTimer = setInterval(() => {
        void this.writeAttemptHeartbeat({
          runId,
          attemptId: attempt.id,
          startedAt: attempt.started_at ?? new Date().toISOString(),
          status: "active"
        });
      }, this.attemptHeartbeatIntervalMs);
      heartbeatTimer.unref?.();
      const checkpointPreflight = await captureAttemptCheckpointPreflight({
        attempt,
        attemptPaths
      });
      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: attempt.id,
          type: "attempt.started",
          payload: {
            attempt_type: attempt.attempt_type
          }
        })
      );

      this.assertDispatchableAttemptContract(attempt, attemptContract);
      const execution = await this.adapter.runAttemptTask({
        run,
        attempt,
        attemptContract,
        context,
        workspacePaths: this.workspacePaths
      });

      await saveAttemptResult(this.workspacePaths, runId, attempt.id, execution.writeback);
      const runtimeVerification = await runAttemptRuntimeVerification({
        run,
        attempt,
        attemptContract,
        result: execution.writeback,
        attemptPaths
      });
      const completedAttemptForEvaluation = updateAttempt(attempt, {
        status: "completed",
        ended_at: new Date().toISOString(),
        result_ref: `runs/${runId}/attempts/${attempt.id}/result.json`,
        evaluation_ref: null
      });
      const reviewPacketForEvaluation = await this.buildAttemptReviewPacket({
        runId,
        attempt: completedAttemptForEvaluation,
        attemptContract,
        currentSnapshot: current,
        context,
        result: execution.writeback,
        evaluation: null,
        runtimeVerification: runtimeVerification.verification,
        journal: await listRunJournal(this.workspacePaths, runId)
      });
      const evaluation = evaluateAttempt({
        reviewPacket: reviewPacketForEvaluation
      });
      await saveAttemptEvaluation(this.workspacePaths, evaluation);

      attempt = updateAttempt(completedAttemptForEvaluation, {
        evaluation_ref: `runs/${runId}/attempts/${attempt.id}/evaluation.json`
      });

      const completedAttempts = [...attempts.filter((item) => item.id !== attempt.id), attempt];
      let nextCurrent = this.buildNextCurrentDecision({
        run,
        current,
        attempt,
        attempts: completedAttempts,
        evaluation,
        result: execution.writeback
      });
      const checkpointOutcome = await maybeCreateVerifiedExecutionCheckpoint({
        run,
        attempt,
        evaluation,
        attemptPaths,
        preflight: checkpointPreflight
      });
      nextCurrent = this.applyCheckpointOutcomeToCurrentDecision(
        nextCurrent,
        attempt,
        checkpointOutcome
      );
      const runtimeSourceDriftFiles = detectLiveRuntimeSourceDrift(
        runtimeVerification.verification.changed_files
      );
      if (runtimeSourceDriftFiles.length > 0) {
        runtimeRestartRequest = {
          runId,
          attemptId: attempt.id,
          affectedFiles: runtimeSourceDriftFiles,
          message: this.buildRuntimeSourceDriftMessage(runtimeSourceDriftFiles)
        };
      }
      nextCurrent = this.applyRuntimeSourceDriftOutcomeToCurrentDecision(
        nextCurrent,
        attempt,
        runtimeSourceDriftFiles
      );
      await saveRunReport(
        this.workspacePaths,
        runId,
        this.buildRunReport(
          run,
          attempt,
          execution.writeback,
          evaluation,
          runtimeVerification,
          nextCurrent
        )
      );

      for (const runSteer of steers.filter((item) => item.status === "queued")) {
        await saveRunSteer(
          this.workspacePaths,
          updateRunSteer(runSteer, {
            status: "applied"
          })
        );
      }

      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: attempt.id,
          type: "attempt.completed",
          payload: {
            recommendation: evaluation.recommendation,
            goal_progress: evaluation.goal_progress,
            suggested_attempt_type: evaluation.suggested_attempt_type
          }
        })
      );
      await this.appendRuntimeVerificationJournal(runId, attempt.id, runtimeVerification);
      await this.appendCheckpointJournal(runId, attempt.id, checkpointOutcome);
      await this.appendRuntimeSourceDriftJournal(
        runId,
        attempt.id,
        runtimeSourceDriftFiles,
        runtimeVerification.artifact_path
      );
      await this.saveSettledAttemptState({
        runId,
        attempt,
        currentSnapshot: nextCurrent
      });
    } catch (error) {
      if (error instanceof RunWorkspaceScopeError) {
        await this.appendRunWorkspaceScopeBlockedEntry(run.id, attempt.id, error);
      }
      attempt = updateAttempt(attempt, {
        status: "failed",
        ended_at: new Date().toISOString()
      });
      const failedCurrentDecision = updateCurrentDecision(
        current ?? createCurrentDecision({ run_id: runId }),
        {
          run_status: "waiting_steer",
          latest_attempt_id: attempt.id,
          recommended_next_action: "wait_for_human",
          recommended_attempt_type: attempt.attempt_type,
          summary: error instanceof Error ? error.message : String(error),
          blocking_reason: error instanceof Error ? error.message : String(error),
          waiting_for_human: true
        }
      );
      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: attempt.id,
          type: "attempt.failed",
          payload: {
            message: error instanceof Error ? error.message : String(error)
          }
        })
      );
      await this.saveSettledAttemptState({
        runId,
        attempt,
        currentSnapshot: failedCurrentDecision
      });
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (heartbeatStarted) {
        await this.writeAttemptHeartbeat({
          runId,
          attemptId: attempt.id,
          startedAt: attempt.started_at ?? new Date().toISOString(),
          status: "released"
        });
      }
      if (runtimeRestartRequest) {
        await this.requestRuntimeRestart?.(runtimeRestartRequest);
      }
    }
  }

  private async saveSettledAttemptState(input: {
    runId: string;
    attempt: Attempt;
    currentSnapshot: CurrentDecision | null;
  }): Promise<void> {
    const [
      attemptContract,
      context,
      result,
      evaluation,
      runtimeVerification,
      journal
    ] = await Promise.all([
      getAttemptContract(this.workspacePaths, input.runId, input.attempt.id),
      getAttemptContext(this.workspacePaths, input.runId, input.attempt.id),
      getAttemptResult(this.workspacePaths, input.runId, input.attempt.id),
      getAttemptEvaluation(this.workspacePaths, input.runId, input.attempt.id),
      getAttemptRuntimeVerification(this.workspacePaths, input.runId, input.attempt.id),
      listRunJournal(this.workspacePaths, input.runId)
    ]);
    const reviewPacket = await this.buildAttemptReviewPacket({
      runId: input.runId,
      attempt: input.attempt,
      attemptContract,
      currentSnapshot: input.currentSnapshot,
      context,
      result,
      evaluation,
      runtimeVerification,
      journal
    });

    await saveAttemptReviewPacket(this.workspacePaths, reviewPacket);
    await saveAttempt(this.workspacePaths, input.attempt);
    if (input.currentSnapshot) {
      await saveCurrentDecision(this.workspacePaths, input.currentSnapshot);
    }
  }

  private async appendRuntimeVerificationJournal(
    runId: string,
    attemptId: string,
    verificationOutcome: AttemptRuntimeVerificationOutcome
  ): Promise<void> {
    if (verificationOutcome.verification.status === "not_applicable") {
      return;
    }

    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: attemptId,
        type:
          verificationOutcome.verification.status === "passed"
            ? "attempt.verification.passed"
            : "attempt.verification.failed",
        payload: {
          status: verificationOutcome.verification.status,
          failure_code: verificationOutcome.verification.failure_code,
          failure_reason: verificationOutcome.verification.failure_reason,
          changed_files: verificationOutcome.verification.changed_files,
          command_count: verificationOutcome.verification.command_results.length,
          artifact_path: verificationOutcome.artifact_path
        }
      })
    );
  }

  private buildAttemptContextRef(runId: string, attemptId: string): string {
    return `runs/${runId}/attempts/${attemptId}/context.json`;
  }

  private async ensureSettledAttemptReviewPackets(
    runId: string,
    current: CurrentDecision | null,
    attempts: Attempt[]
  ): Promise<void> {
    for (const attempt of attempts) {
      if (!["completed", "failed", "stopped"].includes(attempt.status)) {
        continue;
      }

      const reviewPacket = await getAttemptReviewPacket(
        this.workspacePaths,
        runId,
        attempt.id
      );
      if (reviewPacket) {
        continue;
      }

      await this.persistAttemptReviewPacket(runId, attempt.id, current);
    }
  }

  private async persistAttemptReviewPacket(
    runId: string,
    attemptId: string,
    currentSnapshot: CurrentDecision | null
  ): Promise<void> {
    const [
      attempt,
      attemptContract,
      context,
      result,
      evaluation,
      runtimeVerification,
      journal
    ] = await Promise.all([
      getAttempt(this.workspacePaths, runId, attemptId),
      getAttemptContract(this.workspacePaths, runId, attemptId),
      getAttemptContext(this.workspacePaths, runId, attemptId),
      getAttemptResult(this.workspacePaths, runId, attemptId),
      getAttemptEvaluation(this.workspacePaths, runId, attemptId),
      getAttemptRuntimeVerification(this.workspacePaths, runId, attemptId),
      listRunJournal(this.workspacePaths, runId)
    ]);
    const reviewPacket = await this.buildAttemptReviewPacket({
      runId,
      attempt,
      attemptContract,
      currentSnapshot,
      context,
      result,
      evaluation,
      runtimeVerification,
      journal
    });

    await saveAttemptReviewPacket(this.workspacePaths, reviewPacket);
  }

  private async buildAttemptReviewPacket(input: {
    runId: string;
    attempt: Attempt;
    attemptContract: AttemptContract | null;
    currentSnapshot: CurrentDecision | null;
    context: unknown | null;
    result: WorkerWriteback | null;
    evaluation: AttemptEvaluation | null;
    runtimeVerification: AttemptRuntimeVerification | null;
    journal: Awaited<ReturnType<typeof listRunJournal>>;
  }): Promise<AttemptReviewPacket> {
    const attemptPaths = resolveAttemptPaths(
      this.workspacePaths,
      input.runId,
      input.attempt.id
    );
    const attemptJournal = input.journal.filter((entry) => entry.attempt_id === input.attempt.id);
    const failureEntry = [...attemptJournal].reverse().find((entry) =>
      [
        "attempt.failed",
        "attempt.recovery_required",
        "attempt.restart_required"
      ].includes(entry.type)
    );
    const failureMessage =
      this.getReviewPacketFailureMessage(failureEntry?.payload) ??
      input.runtimeVerification?.failure_reason ??
      (["failed", "stopped"].includes(input.attempt.status)
        ? input.currentSnapshot?.blocking_reason ??
          `Attempt ${input.attempt.id} ended as ${input.attempt.status}.`
        : null);

    return {
      run_id: input.runId,
      attempt_id: input.attempt.id,
      attempt: input.attempt,
      attempt_contract: input.attemptContract,
      current_decision_snapshot: input.currentSnapshot,
      context: input.context,
      journal: attemptJournal,
      failure_context: failureMessage
        ? {
            message: failureMessage,
            journal_event_id: failureEntry?.id ?? null,
            journal_event_ts: failureEntry?.ts ?? null
          }
        : null,
      result: input.result,
      evaluation: input.evaluation,
      runtime_verification: input.runtimeVerification,
      artifact_manifest: await this.buildAttemptArtifactManifest({
        attemptPaths,
        result: input.result,
        runtimeVerification: input.runtimeVerification,
        journal: attemptJournal
      }),
      generated_at: new Date().toISOString()
    };
  }

  private async buildAttemptArtifactManifest(input: {
    attemptPaths: ReturnType<typeof resolveAttemptPaths>;
    result: WorkerWriteback | null;
    runtimeVerification: AttemptRuntimeVerification | null;
    journal: Awaited<ReturnType<typeof listRunJournal>>;
  }): Promise<ReviewPacketArtifact[]> {
    const candidatePaths = new Map<string, { kind: string; rawPath: string }>();
    const addPath = (kind: string, rawPath: string | null | undefined): void => {
      if (!rawPath) {
        return;
      }

      const key = `${kind}:${rawPath}`;
      if (!candidatePaths.has(key)) {
        candidatePaths.set(key, { kind, rawPath });
      }
    };

    addPath("attempt_meta", input.attemptPaths.metaFile);
    addPath("attempt_contract", input.attemptPaths.contractFile);
    addPath("attempt_context", input.attemptPaths.contextFile);
    addPath("attempt_result", input.attemptPaths.resultFile);
    addPath("attempt_evaluation", input.attemptPaths.evaluationFile);
    addPath("runtime_verification", input.attemptPaths.runtimeVerificationFile);
    addPath("heartbeat", input.attemptPaths.heartbeatFile);
    addPath("stdout", input.attemptPaths.stdoutFile);
    addPath("stderr", input.attemptPaths.stderrFile);

    for (const artifact of input.result?.artifacts ?? []) {
      addPath(`worker_${artifact.type}`, artifact.path);
    }

    for (const commandResult of input.runtimeVerification?.command_results ?? []) {
      addPath("verification_stdout", commandResult.stdout_file);
      addPath("verification_stderr", commandResult.stderr_file);
    }

    for (const entry of input.journal) {
      const artifactPath =
        entry.payload && typeof entry.payload === "object" && "artifact_path" in entry.payload
          ? entry.payload.artifact_path
          : null;
      if (typeof artifactPath === "string" && artifactPath.length > 0) {
        addPath(entry.type, artifactPath);
      }
    }

    return await Promise.all(
      [...candidatePaths.values()].map(async ({ kind, rawPath }) => {
        const { displayPath, resolvedPath } = this.resolveReviewArtifactPath(
          input.attemptPaths.attemptDir,
          rawPath
        );

        try {
          const fileStat = await stat(resolvedPath);
          return {
            kind,
            path: displayPath,
            exists: true,
            size_bytes: fileStat.isFile() ? fileStat.size : null
          };
        } catch {
          return {
            kind,
            path: displayPath,
            exists: false,
            size_bytes: null
          };
        }
      })
    );
  }

  private resolveReviewArtifactPath(
    attemptDir: string,
    rawPath: string
  ): {
    displayPath: string;
    resolvedPath: string;
  } {
    const resolvedPath = resolve(attemptDir, rawPath);
    const relativePath = relative(attemptDir, resolvedPath);
    const displayPath =
      relativePath.length > 0 && !relativePath.startsWith("..")
        ? relativePath
        : rawPath;

    return {
      displayPath,
      resolvedPath
    };
  }

  private getReviewPacketFailureMessage(
    payload: Record<string, unknown> | undefined
  ): string | null {
    if (!payload) {
      return null;
    }

    const message = payload.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }

    const reason = payload.reason;
    if (typeof reason === "string" && reason.length > 0) {
      return reason;
    }

    return null;
  }

  private applyCheckpointOutcomeToCurrentDecision(
    current: CurrentDecision,
    attempt: Attempt,
    checkpointOutcome: AttemptCheckpointOutcome
  ): CurrentDecision {
    if (checkpointOutcome.status !== "blocked") {
      return current;
    }

    return updateCurrentDecision(current, {
      run_status: "waiting_steer",
      latest_attempt_id: attempt.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: attempt.attempt_type,
      summary: checkpointOutcome.message,
      blocking_reason: checkpointOutcome.message,
      waiting_for_human: true
    });
  }

  private applyRuntimeSourceDriftOutcomeToCurrentDecision(
    current: CurrentDecision,
    attempt: Attempt,
    affectedFiles: string[]
  ): CurrentDecision {
    if (attempt.attempt_type !== "execution" || affectedFiles.length === 0) {
      return current;
    }

    const message = this.buildRuntimeSourceDriftMessage(affectedFiles);
    const preservedNextAction =
      current.recommended_next_action ??
      (current.recommended_attempt_type === "execution"
        ? "continue_execution"
        : current.recommended_attempt_type === "research"
          ? "continue_research"
          : "wait_for_human");
    return updateCurrentDecision(current, {
      run_status: "waiting_steer",
      latest_attempt_id: attempt.id,
      recommended_next_action: preservedNextAction,
      recommended_attempt_type: current.recommended_attempt_type ?? attempt.attempt_type,
      summary: message,
      blocking_reason: [current.blocking_reason, message].filter(Boolean).join(" "),
      waiting_for_human: true
    });
  }

  private async appendCheckpointJournal(
    runId: string,
    attemptId: string,
    checkpointOutcome: AttemptCheckpointOutcome
  ): Promise<void> {
    if (checkpointOutcome.status === "not_applicable") {
      return;
    }

    if (checkpointOutcome.status === "created") {
      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: attemptId,
          type: "attempt.checkpoint.created",
          payload: {
            commit_sha: checkpointOutcome.commit.sha,
            commit_message: checkpointOutcome.commit.message,
            artifact_path: checkpointOutcome.artifact_path
          }
        })
      );
      return;
    }

    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: attemptId,
        type:
          checkpointOutcome.status === "blocked"
            ? "attempt.checkpoint.blocked"
            : "attempt.checkpoint.skipped",
        payload: {
          reason: checkpointOutcome.reason,
          message: checkpointOutcome.message,
          artifact_path: checkpointOutcome.artifact_path
        }
        })
      );
  }

  private async appendRuntimeSourceDriftJournal(
    runId: string,
    attemptId: string,
    affectedFiles: string[],
    artifactPath: string
  ): Promise<void> {
    if (affectedFiles.length === 0) {
      return;
    }

    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: attemptId,
        type: "attempt.restart_required",
        payload: {
          reason: "runtime_source_drift",
          message: this.buildRuntimeSourceDriftMessage(affectedFiles),
          affected_files: affectedFiles,
          artifact_path: artifactPath
        }
      })
    );
  }

  private buildRuntimeSourceDriftMessage(affectedFiles: string[]): string {
    return [
      "Execution changed live runtime source files already loaded by the in-process control-api/orchestrator.",
      `Restart before the next dispatch. Affected files: ${affectedFiles.join(", ")}`
    ].join(" ");
  }

  private buildPlannedAttemptObjective(
    run: Run,
    current: CurrentDecision,
    attemptType: Attempt["attempt_type"],
    latestResult: WorkerWriteback | null
  ): string | null {
    switch (current.recommended_next_action) {
      case "start_first_attempt":
        return `理解仓库现状并找出目标的最佳下一步：${run.title}`;
      case "continue_research": {
        const checkpointResearchHint =
          current.blocking_reason?.includes("Execution auto-checkpoint")
            ? "先区分哪些改动属于这轮目标，哪些是预存现场，再留下可回放的下一轮执行约定，避免提交时继续混入脏工作区。"
            : null;
        return [
          `继续研究目标：${run.title}`,
          current.blocking_reason
            ? `先怀疑并复核这个卡点：${current.blocking_reason}`
            : "先怀疑上一轮结论，再补上缺失证据并收束到最值得做的下一步。",
          latestResult ? `最新摘要：${latestResult.summary}` : null,
          checkpointResearchHint,
          "不要延续默认假设，优先找出为什么现有方向可能不成立。"
        ]
          .filter(Boolean)
          .join("\n");
      }
      case "start_execution":
      case "continue_execution":
        return [
          `执行目标的下一项具体动作：${run.title}`,
          latestResult ? `最新摘要：${latestResult.summary}` : current.summary || null,
          current.blocking_reason ? `关注点：${current.blocking_reason}` : null,
          "在工作区留下清晰的产物和验证证据。"
        ]
          .filter(Boolean)
          .join("\n");
      case "retry_attempt":
        return [
          `重试上一轮${attemptType === "execution" ? "执行" : "研究"}尝试，目标：${run.title}`,
          current.blocking_reason
            ? `先修这个问题：${current.blocking_reason}`
            : "补强结果，让证据更具体。",
          latestResult ? `上一轮摘要：${latestResult.summary}` : null
        ]
          .filter(Boolean)
          .join("\n");
      default:
        return null;
    }
  }

  private buildSteeredAttemptObjective(
    run: Run,
    current: CurrentDecision,
    attemptType: Attempt["attempt_type"],
    latestResult: WorkerWriteback | null,
    steerMessages: string[]
  ): string {
    return [
      `应用目标的最新人工指令：${run.title}`,
      latestResult ? `最新摘要：${latestResult.summary}` : current.summary || null,
      "人工指令：",
      ...steerMessages.map((message) => `- ${message}`),
      attemptType === "execution"
        ? "做最小且有价值的改动，并留下清晰的产物和验证证据。"
        : "按人工指令收束分析，并返回有证据支撑的结论。"
    ]
      .filter(Boolean)
      .join("\n");
  }

  private buildNextCurrentDecision(input: {
    run: Run;
    current: CurrentDecision | null;
    attempt: Attempt;
    attempts: Attempt[];
    evaluation: AttemptEvaluation;
    result: WorkerWriteback;
  }): CurrentDecision {
    const { run, current, attempt, attempts, evaluation, result } = input;
    const baseCurrent = current ?? createCurrentDecision({ run_id: run.id });
    const bestAttemptId =
      evaluation.recommendation === "complete" || evaluation.goal_progress >= 0.55
        ? attempt.id
        : baseCurrent.best_attempt_id;
    const nextAttemptType = evaluation.suggested_attempt_type ?? attempt.attempt_type;

    if (this.shouldPauseAfterRepeatedAttempt(attempts, attempt, evaluation)) {
      return updateCurrentDecision(baseCurrent, {
        run_status: "waiting_steer",
        best_attempt_id: bestAttemptId,
        latest_attempt_id: attempt.id,
        recommended_next_action: "wait_for_human",
        recommended_attempt_type: nextAttemptType,
        summary: result.summary,
        blocking_reason: this.buildRepeatedAttemptPauseReason(attempt, evaluation),
        waiting_for_human: true
      });
    }

    switch (evaluation.recommendation) {
      case "complete":
        return updateCurrentDecision(baseCurrent, {
          run_status: "completed",
          best_attempt_id: attempt.id,
          latest_attempt_id: attempt.id,
          recommended_next_action: null,
          recommended_attempt_type: null,
          summary: result.summary,
          blocking_reason: null,
          waiting_for_human: false
        });
      case "retry":
        return updateCurrentDecision(baseCurrent, {
          run_status: "running",
          best_attempt_id: bestAttemptId,
          latest_attempt_id: attempt.id,
          recommended_next_action: "retry_attempt",
          recommended_attempt_type: nextAttemptType,
          summary: result.summary,
          blocking_reason: evaluation.missing_evidence[0] ?? evaluation.rationale,
          waiting_for_human: false
        });
      case "continue":
        return updateCurrentDecision(baseCurrent, {
          run_status: "running",
          best_attempt_id: bestAttemptId,
          latest_attempt_id: attempt.id,
          recommended_next_action: this.getContinueAction(attempt, nextAttemptType),
          recommended_attempt_type: nextAttemptType,
          summary: result.summary,
          blocking_reason: evaluation.missing_evidence[0] ?? null,
          waiting_for_human: false
        });
      case "wait_human":
      default:
        return updateCurrentDecision(baseCurrent, {
          run_status: "waiting_steer",
          best_attempt_id: bestAttemptId,
          latest_attempt_id: attempt.id,
          recommended_next_action: "wait_for_human",
          recommended_attempt_type: nextAttemptType,
          summary: result.summary,
          blocking_reason: evaluation.missing_evidence[0] ?? evaluation.rationale,
          waiting_for_human: true
        });
    }
  }

  private buildRunReport(
    run: Run,
    attempt: Attempt,
    result: WorkerWriteback,
    evaluation: AttemptEvaluation,
    runtimeVerification: AttemptRuntimeVerificationOutcome,
    current: CurrentDecision
  ): string {
    return [
      `# 运行报告：${run.title}`,
      "",
      `- 最新尝试：${attempt.id}`,
      `- 类型：${attempt.attempt_type}`,
      `- 运行状态：${current.run_status}`,
      `- 评估建议：${evaluation.recommendation}`,
      `- 建议的下一次类型：${evaluation.suggested_attempt_type ?? "none"}`,
      `- 验证状态：${evaluation.verification_status}`,
      `- 运行时回放：${runtimeVerification.verification.status}`,
      "",
      "## 摘要",
      "",
      result.summary,
      "",
      "## 评估结论",
      "",
      evaluation.rationale,
      "",
      "## 运行时回放",
      "",
      runtimeVerification.verification.failure_reason ??
        `改动文件：${runtimeVerification.verification.changed_files.join(", ") || "none"}`,
      "",
      "## 下一动作",
      "",
      current.recommended_next_action ?? "暂无"
    ].join("\n");
  }

  private getContinueAction(
    attempt: Attempt,
    nextAttemptType: Attempt["attempt_type"]
  ): string {
    if (nextAttemptType === "execution" && attempt.attempt_type === "research") {
      return "start_execution";
    }

    return nextAttemptType === "execution" ? "continue_execution" : "continue_research";
  }

  private shouldPauseAfterRepeatedAttempt(
    attempts: Attempt[],
    attempt: Attempt,
    evaluation: AttemptEvaluation
  ): boolean {
    if (attempt.attempt_type === "execution" && evaluation.verification_status === "passed") {
      return false;
    }

    if (!["continue", "retry"].includes(evaluation.recommendation)) {
      return false;
    }

    const nextAttemptType = evaluation.suggested_attempt_type ?? attempt.attempt_type;
    if (nextAttemptType !== attempt.attempt_type) {
      return false;
    }

    return this.countTrailingCompletedAttemptsOfType(attempts, attempt.attempt_type) >= 2;
  }

  private buildRepeatedAttemptPauseReason(
    attempt: Attempt,
    evaluation: AttemptEvaluation
  ): string {
    const repeatedPauseMessage = `Loop paused after repeated ${attempt.attempt_type} attempts without fresh progress.`;

    return [evaluation.missing_evidence.join(" "), repeatedPauseMessage]
      .filter((value) => value.length > 0)
      .join(" ");
  }

  private countTrailingCompletedAttemptsOfType(
    attempts: Attempt[],
    attemptType: Attempt["attempt_type"]
  ): number {
    const orderedAttempts = [...attempts].sort((left, right) =>
      left.created_at.localeCompare(right.created_at)
    );
    let count = 0;

    for (let index = orderedAttempts.length - 1; index >= 0; index -= 1) {
      const attempt = orderedAttempts[index];
      if (attempt.status !== "completed" || attempt.attempt_type !== attemptType) {
        break;
      }
      count += 1;
    }

    return count;
  }

  private getLatestAttempt(
    current: CurrentDecision,
    attempts: Attempt[]
  ): Attempt | null {
    const latestAttempt =
      (current.latest_attempt_id
        ? attempts.find((attempt) => attempt.id === current.latest_attempt_id)
        : null) ?? attempts.at(-1);

    return latestAttempt ?? null;
  }

  private async findLatestExecutionContractDraft(
    runId: string,
    attempts: Attempt[]
  ): Promise<AttemptContractDraft | null> {
    const orderedAttempts = [...attempts].sort((left, right) =>
      right.created_at.localeCompare(left.created_at)
    );

    for (const attempt of orderedAttempts) {
      const result = await getAttemptResult(this.workspacePaths, runId, attempt.id);
      if (isExecutionContractDraftReady(result?.next_attempt_contract)) {
        return result.next_attempt_contract;
      }
    }

    return null;
  }

  private async buildAttemptContract(
    run: Run,
    attempt: Attempt,
    nextExecutionDraft: AttemptContractDraft | null,
    recommendedNextAction: string | null,
    latestAttempt: Attempt | null
  ): Promise<AttemptContract> {
    if (attempt.attempt_type === "execution") {
      const reusableExecutionContract =
        latestAttempt?.attempt_type === "execution" &&
        ["retry_attempt", "continue_execution", "apply_steer"].includes(
          recommendedNextAction ?? ""
        )
          ? await getAttemptContract(this.workspacePaths, run.id, latestAttempt.id)
          : null;
      const draft = isExecutionContractDraftReady(nextExecutionDraft)
        ? nextExecutionDraft
        : null;
      const inferredVerificationPlan =
        reusableExecutionContract?.verification_plan ??
        (await this.inferDefaultExecutionVerificationPlan(run.workspace_root));
      return createAttemptContract({
        attempt_id: attempt.id,
        run_id: run.id,
        attempt_type: attempt.attempt_type,
        objective: attempt.objective,
        success_criteria: attempt.success_criteria,
        required_evidence:
          draft?.required_evidence ??
          reusableExecutionContract?.required_evidence ?? [
            "Leave git-visible workspace changes tied to the objective.",
            "Leave artifacts that show what changed.",
            "Pass the replayable verification commands locked into this contract."
          ],
        forbidden_shortcuts:
          draft?.forbidden_shortcuts ??
          reusableExecutionContract?.forbidden_shortcuts ?? [
            "Do not claim success without replayable verification commands.",
            "Do not treat unchanged workspace state as a completed execution step."
          ],
        expected_artifacts:
          draft?.expected_artifacts ??
          reusableExecutionContract?.expected_artifacts ?? ["changed files visible in git status"],
        verification_plan: draft?.verification_plan ?? inferredVerificationPlan
      });
    }

    return createAttemptContract({
      attempt_id: attempt.id,
      run_id: run.id,
      attempt_type: attempt.attempt_type,
      objective: attempt.objective,
      success_criteria: attempt.success_criteria,
      required_evidence: [
        "Ground findings in concrete files, commands, or artifacts.",
        "If execution is recommended, leave a replayable execution contract for the next attempt."
      ],
      forbidden_shortcuts: [
        "Do not claim repository facts without evidence.",
        "Do not recommend execution without replayable verification steps."
      ],
      expected_artifacts: ["grounded findings or notes"]
    });
  }

  private async inferDefaultExecutionVerificationPlan(
    workspaceRoot: string
  ): Promise<ExecutionVerificationPlan | undefined> {
    const packageJsonPath = resolve(workspaceRoot, "package.json");
    let packageJson: {
      scripts?: Record<string, string>;
    } | null = null;

    try {
      packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
    } catch {
      return undefined;
    }

    const scripts = packageJson?.scripts ?? {};
    const commands: ExecutionVerificationPlan["commands"] = [];

    if (typeof scripts.typecheck === "string" && scripts.typecheck.length > 0) {
      commands.push({
        purpose: "typecheck the workspace after the change",
        command: "pnpm typecheck"
      });
    }

    if (typeof scripts["verify:runtime"] === "string" && scripts["verify:runtime"].length > 0) {
      commands.push({
        purpose: "replay the runtime regression suite after the change",
        command: "pnpm verify:runtime"
      });
    } else if (typeof scripts.test === "string" && scripts.test.length > 0) {
      commands.push({
        purpose: "run the workspace test suite after the change",
        command: "pnpm test"
      });
    } else if (typeof scripts.build === "string" && scripts.build.length > 0) {
      commands.push({
        purpose: "build the workspace after the change",
        command: "pnpm build"
      });
    }

    return commands.length > 0 ? { commands } : undefined;
  }

  private assertDispatchableAttemptContract(
    attempt: Attempt,
    attemptContract: AttemptContract | null
  ): asserts attemptContract is AttemptContract {
    if (!attemptContract) {
      throw new Error(
        `Attempt ${attempt.id} is missing attempt_contract.json. Dispatch is blocked until the contract is recreated.`
      );
    }

    if (attempt.attempt_type === "execution" && !isExecutionAttemptContractReady(attemptContract)) {
      throw new Error(
        `Execution attempt ${attempt.id} is missing replayable verification commands in attempt_contract.json.`
      );
    }
  }

  private getActiveAttemptKey(runId: string, attemptId: string): string {
    return `${runId}:${attemptId}`;
  }

  private async maybeAutoResumeWaitingRun(
    runId: string,
    current: CurrentDecision,
    attempts: Attempt[]
  ): Promise<void> {
    if (current.run_status !== "waiting_steer" || this.waitingHumanAutoResumeMs <= 0) {
      return;
    }

    const journal = await listRunJournal(this.workspacePaths, runId);
    const autoResumePolicy = this.getAutomaticResumePolicy({
      current,
      attempts,
      journal
    });
    const updatedAtMs = Date.parse(current.updated_at);
    if (Number.isNaN(updatedAtMs) || Date.now() - updatedAtMs < autoResumePolicy.delayMs) {
      return;
    }

    const automaticResumeCount = this.countAutomaticResumeCyclesSinceLastSteer(
      journal,
      autoResumePolicy.reasonPrefix
    );

    if (automaticResumeCount >= autoResumePolicy.maxCycles) {
      await this.persistAutomaticResumeExhausted(runId, current, journal, automaticResumeCount);
      return;
    }

    const blocker = this.detectAutomaticResumeBlocker({
      current,
      attempts,
      journal
    });

    if (blocker) {
      await this.persistAutomaticResumeBlocked(runId, current, journal, blocker);
      return;
    }

    const plan = this.buildAutomaticResumePlan({
      current,
      attempts,
      journal
    });

    if (!plan) {
      await this.persistAutomaticResumeBlocked(runId, current, journal);
      return;
    }

    await saveCurrentDecision(
      this.workspacePaths,
      updateCurrentDecision(current, {
        run_status: "running",
        recommended_next_action: plan.next_action,
        recommended_attempt_type: plan.attempt_type,
        summary: plan.summary,
        blocking_reason: plan.blocking_reason,
        waiting_for_human: false
      })
    );
    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: current.latest_attempt_id,
        type: "run.auto_resume.scheduled",
        payload: {
          cycle: automaticResumeCount + 1,
          next_action: plan.next_action,
          attempt_type: plan.attempt_type,
          reason: plan.reason
        }
      })
    );
  }

  private detectAutomaticResumeBlocker(input: {
    current: CurrentDecision;
    attempts: Attempt[];
    journal: Awaited<ReturnType<typeof listRunJournal>>;
  }): { reason: string; message: string } | null {
    const latestAttempt = this.getLatestAttempt(input.current, input.attempts);
    const workspaceScopeMessage = this.getRunWorkspaceScopeBlockedMessage(
      input.journal,
      latestAttempt?.id ?? input.current.latest_attempt_id ?? null
    );
    if (workspaceScopeMessage) {
      return {
        reason: "workspace_scope_blocked",
        message: workspaceScopeMessage
      };
    }

    if (!latestAttempt) {
      return null;
    }

    const restartRequiredEntry = this.getLatestAttemptJournalEntry(
      input.journal,
      latestAttempt.id,
      ["attempt.restart_required"]
    );
    const restartRequiredMessage = restartRequiredEntry
      ? this.getReviewPacketFailureMessage(restartRequiredEntry.payload)
      : null;
    if (
      restartRequiredMessage &&
      !this.hasRuntimeRestartedSinceJournalEntry(restartRequiredEntry?.ts)
    ) {
      return {
        reason: "runtime_source_drift",
        message: restartRequiredMessage
      };
    }

    if (latestAttempt.status !== "failed") {
      return null;
    }

    const failureMessage = this.getLatestAttemptFailureMessage({
      current: input.current,
      journal: input.journal,
      latestAttempt
    });
    const providerBlocker = this.classifyProviderBlocker(failureMessage);

    if (providerBlocker !== "provider_auth_failed" || !failureMessage) {
      return null;
    }

    return {
      reason: providerBlocker,
      message: `上一轮${latestAttempt.attempt_type === "execution" ? "execution" : "research"}命中 provider 鉴权失败，自动续跑已暂停。原始阻塞：${failureMessage}`
    };
  }

  private buildAutomaticResumePlan(input: {
    current: CurrentDecision;
    attempts: Attempt[];
    journal: Awaited<ReturnType<typeof listRunJournal>>;
  }):
    | {
        next_action: string;
        attempt_type: Attempt["attempt_type"];
        summary: string;
        blocking_reason: string | null;
        reason: string;
      }
    | null {
    const latestAttempt = this.getLatestAttempt(input.current, input.attempts);
    if (!latestAttempt) {
      return {
        next_action: "start_first_attempt",
        attempt_type: "research",
        summary: "人工窗口超时，系统自动恢复并重新启动首次研究。",
        blocking_reason: input.current.blocking_reason,
        reason: "no_attempts_yet"
      };
    }

    const restartRequiredEntry = this.getLatestAttemptJournalEntry(
      input.journal,
      latestAttempt.id,
      ["attempt.restart_required"]
    );
    if (
      restartRequiredEntry &&
      this.hasRuntimeRestartedSinceJournalEntry(restartRequiredEntry.ts) &&
      latestAttempt.attempt_type === "execution"
    ) {
      return {
        next_action: "continue_execution",
        attempt_type: "execution",
        summary: "检测到 runtime 已在 source drift 后重启，系统继续上一轮 execution。",
        blocking_reason: null,
        reason: "runtime_restarted_continue_execution"
      };
    }

    if (this.hasCheckpointBlocker(input.journal, latestAttempt.id)) {
      const checkpointMessage =
        this.getAttemptJournalMessage(input.journal, latestAttempt.id, [
          "attempt.checkpoint.blocked"
        ]) ??
        input.current.blocking_reason ??
        "Execution auto-checkpoint was blocked and needs workspace diagnosis.";

      return {
        next_action: "retry_attempt",
        attempt_type: "execution",
        summary:
          "人工窗口超时，系统直接继续执行，先把提交现场和工作区阻塞处理掉。",
        blocking_reason: checkpointMessage,
        reason: "checkpoint_blocked_retries_execution"
      };
    }

    if (latestAttempt.status === "stopped") {
      return {
        next_action: "retry_attempt",
        attempt_type: latestAttempt.attempt_type,
        summary: `人工窗口超时，系统自动恢复上一轮${latestAttempt.attempt_type === "execution" ? "执行" : "研究"}尝试。`,
        blocking_reason:
          input.current.blocking_reason ??
          "上一轮尝试中断，系统会先按原契约恢复。",
        reason: "resume_stopped_attempt"
      };
    }

    if (latestAttempt.status === "failed") {
      const failureMessage = this.getLatestAttemptFailureMessage({
        current: input.current,
        journal: input.journal,
        latestAttempt
      });
      const providerBlocker = this.classifyProviderBlocker(failureMessage);

      if (providerBlocker === "provider_rate_limited") {
        return {
          next_action: "retry_attempt",
          attempt_type: latestAttempt.attempt_type,
          summary:
            latestAttempt.attempt_type === "execution"
              ? "provider 限流，系统短退避后自动重试上一轮执行。"
              : "provider 限流，系统短退避后自动重试上一轮研究。",
          blocking_reason:
            failureMessage ??
            input.current.blocking_reason ??
            "上一轮命中 provider 限流，系统会短退避后重试。",
          reason:
            latestAttempt.attempt_type === "execution"
              ? "provider_rate_limited_retry_execution"
              : "provider_rate_limited_retry_research"
        };
      }

      if (latestAttempt.attempt_type === "execution") {
        return {
          next_action: "retry_attempt",
          attempt_type: "execution",
          summary:
            "人工窗口超时，系统自动继续执行并直接处理上一轮执行卡点。",
          blocking_reason:
            input.current.blocking_reason ??
            "上一轮执行失败，继续执行并直接修掉当前阻塞。",
          reason: "failed_execution_retries_directly"
        };
      }

      return {
        next_action: "retry_attempt",
        attempt_type: "research",
        summary: "人工窗口超时，系统自动继续研究并优先诊断阻塞点。",
        blocking_reason:
          input.current.blocking_reason ??
          "上一轮研究失败，先定位阻塞点再继续。",
        reason: "failed_research_retry"
      };
    }

    if (latestAttempt.status === "completed") {
      const nextAttemptType =
        input.current.recommended_attempt_type ?? latestAttempt.attempt_type;
      if (nextAttemptType === "execution") {
        return {
          next_action:
            latestAttempt.attempt_type === "research" ? "start_execution" : "continue_execution",
          attempt_type: "execution",
          summary:
            latestAttempt.attempt_type === "research"
              ? "人工窗口超时，系统直接进入下一轮执行，不再重复方案研究。"
              : "人工窗口超时，系统继续执行当前已收敛的下一步。",
          blocking_reason:
            input.current.blocking_reason ??
            "已有明确的下一步执行方向，直接进入 execution。",
          reason:
            latestAttempt.attempt_type === "research"
              ? "completed_research_starts_execution"
              : "completed_execution_continues_execution"
        };
      }

      return {
        next_action: "continue_research",
        attempt_type: "research",
        summary:
          "人工窗口超时，系统自动进入怀疑式研究，重新审查现有证据并收束下一步。",
        blocking_reason:
          input.current.blocking_reason ??
          "需要重新审查现有证据，避免沿着旧假设继续空转。",
        reason: "completed_attempt_needs_skeptical_review"
      };
    }

    return null;
  }

  private countAutomaticResumeCyclesSinceLastSteer(
    journal: Awaited<ReturnType<typeof listRunJournal>>,
    reasonPrefix?: string
  ): number {
    let count = 0;

    for (let index = journal.length - 1; index >= 0; index -= 1) {
      const entry = journal[index];
      if (!entry) {
        continue;
      }

      if (this.isAutoResumeResetBoundary(entry.type)) {
        break;
      }

      if (entry.type === "run.auto_resume.scheduled") {
        if (
          reasonPrefix &&
          !String(entry.payload.reason ?? "").startsWith(reasonPrefix)
        ) {
          continue;
        }
        count += 1;
      }
    }

    return count;
  }

  private getAutomaticResumePolicy(input: {
    current: CurrentDecision;
    attempts: Attempt[];
    journal: Awaited<ReturnType<typeof listRunJournal>>;
  }): {
    delayMs: number;
    maxCycles: number;
    reasonPrefix?: string;
  } {
    const latestAttempt = this.getLatestAttempt(input.current, input.attempts);
    const restartRequiredEntry =
      latestAttempt === null
        ? null
        : this.getLatestAttemptJournalEntry(input.journal, latestAttempt.id, [
            "attempt.restart_required"
          ]);
    if (
      restartRequiredEntry &&
      this.hasRuntimeRestartedSinceJournalEntry(restartRequiredEntry.ts)
    ) {
      return {
        delayMs: this.runtimeSourceDriftAutoResumeMs,
        maxCycles: this.maxAutomaticResumeCycles,
        reasonPrefix: "runtime_restarted_continue_execution"
      };
    }

    if (!latestAttempt || latestAttempt.status !== "failed") {
      return {
        delayMs: this.waitingHumanAutoResumeMs,
        maxCycles: this.maxAutomaticResumeCycles
      };
    }

    const failureMessage = this.getLatestAttemptFailureMessage({
      current: input.current,
      journal: input.journal,
      latestAttempt
    });
    const providerBlocker = this.classifyProviderBlocker(failureMessage);
    if (providerBlocker === "provider_rate_limited") {
      return {
        delayMs: this.providerRateLimitAutoResumeMs,
        maxCycles: this.maxProviderRateLimitAutoResumeCycles,
        reasonPrefix: "provider_rate_limited_retry_"
      };
    }

    return {
      delayMs: this.waitingHumanAutoResumeMs,
      maxCycles: this.maxAutomaticResumeCycles
    };
  }

  private hasCheckpointBlocker(
    journal: Awaited<ReturnType<typeof listRunJournal>>,
    attemptId: string
  ): boolean {
    return journal.some(
      (entry) => entry.attempt_id === attemptId && entry.type === "attempt.checkpoint.blocked"
    );
  }

  private getAttemptJournalMessage(
    journal: Awaited<ReturnType<typeof listRunJournal>>,
    attemptId: string,
    entryTypes: string[]
  ): string | null {
    const entry = this.getLatestAttemptJournalEntry(journal, attemptId, entryTypes);
    return entry ? this.getReviewPacketFailureMessage(entry.payload) : null;
  }

  private getLatestAttemptJournalEntry(
    journal: Awaited<ReturnType<typeof listRunJournal>>,
    attemptId: string,
    entryTypes: string[]
  ): (Awaited<ReturnType<typeof listRunJournal>>)[number] | null {
    for (let index = journal.length - 1; index >= 0; index -= 1) {
      const entry = journal[index];
      if (!entry || entry.attempt_id !== attemptId || !entryTypes.includes(entry.type)) {
        continue;
      }

      return entry;
    }

    return null;
  }

  private hasRuntimeRestartedSinceJournalEntry(ts: string | null | undefined): boolean {
    if (!ts) {
      return false;
    }

    const entryTsMs = Date.parse(ts);
    if (Number.isNaN(entryTsMs)) {
      return false;
    }

    return this.instanceStartedAtMs > entryTsMs;
  }

  private getRunWorkspaceScopeBlockedMessage(
    journal: Awaited<ReturnType<typeof listRunJournal>>,
    attemptId: string | null
  ): string | null {
    for (let index = journal.length - 1; index >= 0; index -= 1) {
      const entry = journal[index];
      if (!entry || entry.type !== "run.workspace_scope.blocked") {
        continue;
      }

      if (attemptId && entry.attempt_id !== attemptId) {
        continue;
      }

      const payload =
        entry.payload && typeof entry.payload === "object"
          ? (entry.payload as Record<string, unknown>)
          : null;
      const message = payload?.message;
      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }

    return null;
  }

  private getLatestAttemptFailureMessage(input: {
    current: CurrentDecision;
    journal: Awaited<ReturnType<typeof listRunJournal>>;
    latestAttempt: Attempt;
  }): string | null {
    return (
      this.getAttemptJournalMessage(input.journal, input.latestAttempt.id, ["attempt.failed"]) ??
      input.current.blocking_reason
    );
  }

  private classifyProviderBlocker(
    message: string | null | undefined
  ): "provider_rate_limited" | "provider_auth_failed" | null {
    if (!message) {
      return null;
    }

    const rateLimitPatterns = [
      /\b429\b/,
      /rate[\s_-]?limit/i,
      /too many requests/i,
      /insufficient[_\s-]?quota/i,
      /quota exceeded/i,
      /resource[_\s-]?exhausted/i,
      /throttl(?:e|ed|ing)/i,
      /限流/u,
      /配额/u
    ];
    if (rateLimitPatterns.some((pattern) => pattern.test(message))) {
      return "provider_rate_limited";
    }

    const authPatterns = [
      /\b401\b/,
      /\b403\b/,
      /unauthorized/i,
      /forbidden/i,
      /authentication/i,
      /authorization/i,
      /auth(?:\s+error|\s+failed)?/i,
      /invalid api key/i,
      /api key/i,
      /invalid token/i,
      /鉴权/u,
      /认证/u,
      /授权/u
    ];
    if (authPatterns.some((pattern) => pattern.test(message))) {
      return "provider_auth_failed";
    }

    return null;
  }

  private async persistAutomaticResumeBlocked(
    runId: string,
    current: CurrentDecision,
    journal: Awaited<ReturnType<typeof listRunJournal>>,
    blocker?: {
      reason: string;
      message: string;
    }
  ): Promise<void> {
    if (this.hasAutoResumeTerminalEvent(journal, "run.auto_resume.blocked")) {
      return;
    }

    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: current.latest_attempt_id,
        type: "run.auto_resume.blocked",
        payload: {
          reason: blocker?.reason ?? "manual_only_blocker",
          message:
            blocker?.message ??
            current.blocking_reason ??
            "当前阻塞涉及人工边界，系统未找到安全的自动续跑方案。"
        }
      })
    );
  }

  private async persistAutomaticResumeExhausted(
    runId: string,
    current: CurrentDecision,
    journal: Awaited<ReturnType<typeof listRunJournal>>,
    automaticResumeCount: number
  ): Promise<void> {
    if (this.hasAutoResumeTerminalEvent(journal, "run.auto_resume.exhausted")) {
      return;
    }

    const message = `自动续跑已尝试 ${automaticResumeCount} 轮，仍未形成可执行推进方案，现停下等待人工。`;
    await saveCurrentDecision(
      this.workspacePaths,
      updateCurrentDecision(current, {
        run_status: "waiting_steer",
        recommended_next_action: "wait_for_human",
        summary: message,
        blocking_reason: [current.blocking_reason, message].filter(Boolean).join(" "),
        waiting_for_human: true
      })
    );
    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: current.latest_attempt_id,
        type: "run.auto_resume.exhausted",
        payload: {
          attempted_cycles: automaticResumeCount,
          message
        }
      })
    );
  }

  private hasAutoResumeTerminalEvent(
    journal: Awaited<ReturnType<typeof listRunJournal>>,
    type: "run.auto_resume.blocked" | "run.auto_resume.exhausted"
  ): boolean {
    for (let index = journal.length - 1; index >= 0; index -= 1) {
      const entry = journal[index];
      if (!entry) {
        continue;
      }

      if (this.isAutoResumeResetBoundary(entry.type)) {
        return false;
      }

      if (entry.type === type) {
        return true;
      }
    }

    return false;
  }

  private isAutoResumeResetBoundary(type: string): boolean {
    return (
      type === "run.steer.queued" ||
      type === "run.launched" ||
      type === "run.manual_recovery" ||
      type === "attempt.checkpoint.created"
    );
  }

  private async getRunWorkspaceScopeError(
    run: Run
  ): Promise<RunWorkspaceScopeError | null> {
    try {
      await lockRunWorkspaceRoot(run.workspace_root, this.runWorkspaceScopePolicy);
      return null;
    } catch (error) {
      if (error instanceof RunWorkspaceScopeError) {
        return error;
      }

      throw error;
    }
  }

  private async assertAttemptWorkspaceScope(
    run: Run,
    attempt: Attempt
  ): Promise<void> {
    await assertAttemptWorkspaceWithinRunScope({
      runWorkspaceRoot: run.workspace_root,
      attemptWorkspaceRoot: attempt.workspace_root,
      policy: this.runWorkspaceScopePolicy
    });
  }

  private async persistRunWorkspaceScopeBlocked(
    run: Run,
    current: CurrentDecision,
    error: RunWorkspaceScopeError
  ): Promise<void> {
    const nextCurrent = updateCurrentDecision(current, {
      run_status: "waiting_steer",
      recommended_next_action: "wait_for_human",
      summary: error.message,
      blocking_reason: error.message,
      waiting_for_human: true
    });

    const currentAlreadyBlocked =
      current.run_status === nextCurrent.run_status &&
      current.recommended_next_action === nextCurrent.recommended_next_action &&
      current.summary === nextCurrent.summary &&
      current.blocking_reason === nextCurrent.blocking_reason &&
      current.waiting_for_human === nextCurrent.waiting_for_human;

    if (!currentAlreadyBlocked) {
      await saveCurrentDecision(this.workspacePaths, nextCurrent);
    }

    await this.appendRunWorkspaceScopeBlockedEntry(run.id, current.latest_attempt_id, error);
  }

  private async appendRunWorkspaceScopeBlockedEntry(
    runId: string,
    attemptId: string | null,
    error: RunWorkspaceScopeError
  ): Promise<void> {
    const journal = await listRunJournal(this.workspacePaths, runId);
    const latestEntry = journal.at(-1);
    if (
      latestEntry?.type === "run.workspace_scope.blocked" &&
      latestEntry.attempt_id === attemptId &&
      latestEntry.payload.message === error.message
    ) {
      return;
    }

    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: attemptId,
        type: "run.workspace_scope.blocked",
        payload: {
          code: error.code,
          message: error.message,
          ...error.details
        }
      })
    );
  }

  private hasActiveAttemptForRun(runId: string): boolean {
    const prefix = `${runId}:`;
    for (const activeKey of this.activeAttempts) {
      if (activeKey.startsWith(prefix)) {
        return true;
      }
    }

    return false;
  }

  private async isAttemptHeartbeatFresh(
    runId: string,
    attemptId: string
  ): Promise<boolean> {
    const heartbeat = await getAttemptHeartbeat(this.workspacePaths, runId, attemptId);
    if (!heartbeat || heartbeat.status !== "active") {
      return false;
    }

    const heartbeatAtMs = Date.parse(heartbeat.heartbeat_at);
    if (Number.isNaN(heartbeatAtMs)) {
      return false;
    }

    return Date.now() - heartbeatAtMs <= this.attemptHeartbeatStaleMs;
  }

  private async writeAttemptHeartbeat(input: {
    runId: string;
    attemptId: string;
    startedAt: string;
    status: "active" | "released";
  }): Promise<void> {
    const now = new Date().toISOString();
    await saveAttemptHeartbeat(this.workspacePaths, {
      attempt_id: input.attemptId,
      run_id: input.runId,
      owner_id: this.instanceId,
      status: input.status,
      started_at: input.startedAt,
      heartbeat_at: now,
      released_at: input.status === "released" ? now : null
    });
  }
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export {
  assertAttemptWorkspaceWithinRunScope,
  createRunWorkspaceScopePolicy,
  createDefaultRunWorkspaceScopePolicy,
  lockRunWorkspaceRoot,
  RunWorkspaceScopeError,
  type RunWorkspaceScopePolicy
} from "./workspace-scope.js";
