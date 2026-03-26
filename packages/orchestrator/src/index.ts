import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
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
  type Branch,
  type CurrentDecision,
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
  runAttemptRuntimeVerification,
  type AttemptRuntimeVerificationOutcome
} from "./runtime-verification.js";

export interface OrchestratorOptions {
  attemptHeartbeatIntervalMs?: number;
  attemptHeartbeatStaleMs?: number;
}

export class Orchestrator {
  private timer: NodeJS.Timeout | null = null;
  private readonly activeBranches = new Set<string>();
  private readonly activeAttempts = new Set<string>();
  private readonly instanceId = `orch_${randomUUID().slice(0, 8)}`;
  private readonly attemptHeartbeatIntervalMs: number;
  private readonly attemptHeartbeatStaleMs: number;

  constructor(
    private readonly workspacePaths: WorkspacePaths,
    private readonly adapter: CodexCliWorkerAdapter,
    private readonly contextManager = new ContextManager(),
    private readonly pollIntervalMs = 1500,
    options: OrchestratorOptions = {}
  ) {
    this.attemptHeartbeatIntervalMs = options.attemptHeartbeatIntervalMs ?? 1000;
    this.attemptHeartbeatStaleMs = options.attemptHeartbeatStaleMs ?? 5000;
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

      if (!current || current.run_status !== "running" || current.waiting_for_human) {
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
      "重试前需要人工确认恢复。";
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

    await saveAttempt(this.workspacePaths, stoppedAttempt);
    await saveCurrentDecision(this.workspacePaths, nextCurrent);
    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: attempt.id,
        type: "attempt.recovery_required",
        payload: {
          previous_status: attempt.status,
          recovery_policy: "pause_for_human_review"
        }
      })
    );
    await this.persistAttemptReviewPacket(runId, attempt.id, nextCurrent);
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
          contract: this.buildAttemptContract(run, attempt, null)
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
        contract: this.buildAttemptContract(run, attempt, null)
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
      contract: this.buildAttemptContract(run, attempt, nextExecutionDraft)
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
    let finalCurrentDecision = current;

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
      previous_attempts: previousAttempts
    };

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
    await this.writeAttemptHeartbeat({
      runId,
      attemptId: attempt.id,
      startedAt: attempt.started_at ?? new Date().toISOString(),
      status: "active"
    });
    const heartbeatTimer = setInterval(() => {
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

    try {
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
      const evaluation = evaluateAttempt({
        run,
        attempt,
        result: execution.writeback,
        runtimeVerification: runtimeVerification.verification
      });
      await saveAttemptEvaluation(this.workspacePaths, evaluation);

      attempt = updateAttempt(attempt, {
        status: "completed",
        ended_at: new Date().toISOString(),
        result_ref: `runs/${runId}/attempts/${attempt.id}/result.json`,
        evaluation_ref: `runs/${runId}/attempts/${attempt.id}/evaluation.json`
      });
      await saveAttempt(this.workspacePaths, attempt);

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
      finalCurrentDecision = nextCurrent;
      await saveCurrentDecision(this.workspacePaths, nextCurrent);
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
    } catch (error) {
      attempt = updateAttempt(attempt, {
        status: "failed",
        ended_at: new Date().toISOString()
      });
      await saveAttempt(this.workspacePaths, attempt);
      await saveCurrentDecision(
        this.workspacePaths,
        updateCurrentDecision(current ?? createCurrentDecision({ run_id: runId }), {
          run_status: "waiting_steer",
          latest_attempt_id: attempt.id,
          recommended_next_action: "wait_for_human",
          recommended_attempt_type: attempt.attempt_type,
          summary: error instanceof Error ? error.message : String(error),
          blocking_reason: error instanceof Error ? error.message : String(error),
          waiting_for_human: true
        })
      );
      finalCurrentDecision = await getCurrentDecision(this.workspacePaths, runId);
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
    } finally {
      clearInterval(heartbeatTimer);
      await this.writeAttemptHeartbeat({
        runId,
        attemptId: attempt.id,
        startedAt: attempt.started_at ?? new Date().toISOString(),
        status: "released"
      });
      if (["completed", "failed", "stopped"].includes(attempt.status)) {
        await this.persistAttemptReviewPacket(runId, attempt.id, finalCurrentDecision);
      }
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
    const attemptPaths = resolveAttemptPaths(this.workspacePaths, runId, attemptId);
    const attemptJournal = journal.filter((entry) => entry.attempt_id === attemptId);
    const failureEntry = [...attemptJournal].reverse().find((entry) =>
      ["attempt.failed", "attempt.recovery_required"].includes(entry.type)
    );
    const failureMessage =
      this.getReviewPacketFailureMessage(failureEntry?.payload) ??
      runtimeVerification?.failure_reason ??
      (["failed", "stopped"].includes(attempt.status)
        ? currentSnapshot?.blocking_reason ?? `Attempt ${attempt.id} ended as ${attempt.status}.`
        : null);

    const reviewPacket: AttemptReviewPacket = {
      run_id: runId,
      attempt_id: attemptId,
      attempt,
      attempt_contract: attemptContract,
      current_decision_snapshot: currentSnapshot,
      context,
      journal: attemptJournal,
      failure_context: failureMessage
        ? {
            message: failureMessage,
            journal_event_id: failureEntry?.id ?? null,
            journal_event_ts: failureEntry?.ts ?? null
          }
        : null,
      result,
      evaluation,
      runtime_verification: runtimeVerification,
      artifact_manifest: await this.buildAttemptArtifactManifest({
        attemptPaths,
        result,
        runtimeVerification,
        journal: attemptJournal
      }),
      generated_at: new Date().toISOString()
    };

    await saveAttemptReviewPacket(this.workspacePaths, reviewPacket);
  }

  private async buildAttemptArtifactManifest(input: {
    attemptPaths: ReturnType<typeof resolveAttemptPaths>;
    result: WorkerWriteback | null;
    runtimeVerification: AttemptRuntimeVerificationOutcome["verification"] | null;
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

  private buildPlannedAttemptObjective(
    run: Run,
    current: CurrentDecision,
    attemptType: Attempt["attempt_type"],
    latestResult: WorkerWriteback | null
  ): string | null {
    switch (current.recommended_next_action) {
      case "start_first_attempt":
        return `理解仓库现状并找出目标的最佳下一步：${run.title}`;
      case "continue_research":
        return [
          `继续研究目标：${run.title}`,
          latestResult ? `最新摘要：${latestResult.summary}` : null,
          current.blocking_reason
            ? `关注缺口：${current.blocking_reason}`
            : "优先补上缺失证据，并收束到最值得做的下一步。"
        ]
          .filter(Boolean)
          .join("\n");
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
        blocking_reason:
          evaluation.missing_evidence[0] ??
          `Loop paused after repeated ${attempt.attempt_type} attempts without fresh progress.`,
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
    if (!["continue", "retry"].includes(evaluation.recommendation)) {
      return false;
    }

    const nextAttemptType = evaluation.suggested_attempt_type ?? attempt.attempt_type;
    if (nextAttemptType !== attempt.attempt_type) {
      return false;
    }

    return this.countTrailingCompletedAttemptsOfType(attempts, attempt.attempt_type) >= 2;
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

  private buildAttemptContract(
    run: Run,
    attempt: Attempt,
    nextExecutionDraft: AttemptContractDraft | null
  ): AttemptContract {
    if (attempt.attempt_type === "execution") {
      const draft = isExecutionContractDraftReady(nextExecutionDraft)
        ? nextExecutionDraft
        : null;
      return createAttemptContract({
        attempt_id: attempt.id,
        run_id: run.id,
        attempt_type: attempt.attempt_type,
        objective: draft?.objective ?? attempt.objective,
        success_criteria: draft?.success_criteria ?? attempt.success_criteria,
        required_evidence:
          draft?.required_evidence ?? [
            "Leave git-visible workspace changes tied to the objective.",
            "Leave artifacts that show what changed.",
            "Pass the replayable verification commands locked into this contract."
          ],
        forbidden_shortcuts:
          draft?.forbidden_shortcuts ?? [
            "Do not claim success without replayable verification commands.",
            "Do not treat unchanged workspace state as a completed execution step."
          ],
        expected_artifacts:
          draft?.expected_artifacts ?? ["changed files visible in git status"],
        verification_plan: draft?.verification_plan
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
