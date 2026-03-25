import {
  createAttempt,
  createCurrentDecision,
  createEvent,
  createRunJournalEntry,
  createWorkerRun,
  finishWorkerRun,
  updateAttempt,
  updateBranch,
  updateCurrentDecision,
  updateGoal,
  updateRunSteer,
  updateSteer,
  type Attempt,
  type AttemptEvaluation,
  type Branch,
  type CurrentDecision,
  type EvalSpec,
  type Goal,
  type Run,
  type WorkerWriteback
} from "@autoresearch/domain";
import { appendEvent } from "@autoresearch/event-log";
import { evaluateAttempt, evaluateBranch } from "@autoresearch/judge";
import { buildGoalReport } from "@autoresearch/report-builder";
import {
  appendRunJournal,
  getAttempt,
  getAttemptResult,
  getCurrentDecision,
  getBranch,
  getContextBoard,
  getEvalResult,
  getGoal,
  getPlanArtifacts,
  getRun,
  listAttempts,
  getWriteback,
  listBranches,
  listGoals,
  listRuns,
  listRunSteers,
  listSteers,
  resolveAttemptPaths,
  resolveBranchArtifactPaths,
  saveAttempt,
  saveAttemptContext,
  saveAttemptEvaluation,
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

export class Orchestrator {
  private timer: NodeJS.Timeout | null = null;
  private readonly activeBranches = new Set<string>();
  private readonly activeAttempts = new Set<string>();

  constructor(
    private readonly workspacePaths: WorkspacePaths,
    private readonly adapter: CodexCliWorkerAdapter,
    private readonly contextManager = new ContextManager(),
    private readonly pollIntervalMs = 1500
  ) {}

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

      if (!current || current.run_status !== "running" || current.waiting_for_human) {
        continue;
      }

      const attempts = await listAttempts(this.workspacePaths, run.id);
      const runningAttempt = attempts.find((attempt) => attempt.status === "running");

      if (runningAttempt) {
        const activeKey = this.getActiveAttemptKey(run.id, runningAttempt.id);

        if (!this.activeAttempts.has(activeKey)) {
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

      const nextAttempt = await this.planNextAttempt(run.id, current, attempts);
      if (!nextAttempt) {
        continue;
      }

      await saveAttempt(this.workspacePaths, nextAttempt);
      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: run.id,
          attempt_id: nextAttempt.id,
          type: "attempt.created",
          payload: {
            attempt_type: nextAttempt.attempt_type,
            objective: nextAttempt.objective
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
      `Attempt ${attempt.id} was still marked running when the orchestrator resumed. ` +
      "Recovery requires human review before retry.";
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
  }

  private async planNextAttempt(
    runId: string,
    current: CurrentDecision,
    attempts: Attempt[]
  ): Promise<Attempt | null> {
    const run = await getRun(this.workspacePaths, runId);
    const queuedSteers = (await listRunSteers(this.workspacePaths, runId)).filter(
      (runSteer) => runSteer.status === "queued"
    );
    const latestAttempt = this.getLatestAttempt(current, attempts);
    const latestResult = latestAttempt
      ? await getAttemptResult(this.workspacePaths, run.id, latestAttempt.id)
      : null;

    if (attempts.length === 0) {
      if (queuedSteers.length > 0) {
        return createAttempt({
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
      }

      return createAttempt({
        run_id: run.id,
        attempt_type: "research",
        worker: this.adapter.type,
        objective: `Understand the repository and surface the best next step for goal: ${run.title}`,
        success_criteria: run.success_criteria,
        workspace_root: run.workspace_root
      });
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
        : this.buildPlannedAttemptObjective(run, current, attemptType, latestResult);

    if (!objective) {
      return null;
    }

    return createAttempt({
      run_id: run.id,
      attempt_type: attemptType,
      worker: this.adapter.type,
      objective,
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    });
  }

  private async executeAttempt(runId: string, attemptId: string): Promise<void> {
    const run = await getRun(this.workspacePaths, runId);
    let attempt = await getAttempt(this.workspacePaths, runId, attemptId);
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
      const execution = await this.adapter.runAttemptTask({
        run,
        attempt,
        context,
        workspacePaths: this.workspacePaths
      });

      await saveAttemptResult(this.workspacePaths, runId, attempt.id, execution.writeback);
      const evaluation = evaluateAttempt({
        run,
        attempt,
        result: execution.writeback
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
      await saveCurrentDecision(this.workspacePaths, nextCurrent);
      await saveRunReport(
        this.workspacePaths,
        runId,
        this.buildRunReport(run, attempt, execution.writeback, evaluation, nextCurrent)
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
    }
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
        return `Understand the repository and surface the best next step for goal: ${run.title}`;
      case "continue_research":
        return [
          `Continue research for goal: ${run.title}.`,
          latestResult ? `Latest summary: ${latestResult.summary}` : null,
          current.blocking_reason
            ? `Focus gap: ${current.blocking_reason}`
            : "Focus on missing evidence and the best next action."
        ]
          .filter(Boolean)
          .join("\n");
      case "start_execution":
      case "continue_execution":
        return [
          `Execute the next concrete step for goal: ${run.title}.`,
          latestResult ? `Latest summary: ${latestResult.summary}` : current.summary || null,
          current.blocking_reason ? `Focus: ${current.blocking_reason}` : null,
          "Leave clear artifacts and verification evidence in the workspace."
        ]
          .filter(Boolean)
          .join("\n");
      case "retry_attempt":
        return [
          `Retry the previous ${attemptType} attempt for goal: ${run.title}.`,
          current.blocking_reason
            ? `Fix this issue: ${current.blocking_reason}`
            : "Strengthen the result and make the evidence more concrete.",
          latestResult ? `Previous summary: ${latestResult.summary}` : null
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
      `Apply the latest human steer for goal: ${run.title}.`,
      latestResult ? `Latest summary: ${latestResult.summary}` : current.summary || null,
      "Human steer:",
      ...steerMessages.map((message) => `- ${message}`),
      attemptType === "execution"
        ? "Make the smallest useful change, then leave clear artifacts and verification evidence."
        : "Use the steer to refine the analysis and return grounded findings."
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
    current: CurrentDecision
  ): string {
    return [
      `# Run Report: ${run.title}`,
      "",
      `- Latest attempt: ${attempt.id}`,
      `- Type: ${attempt.attempt_type}`,
      `- Run status: ${current.run_status}`,
      `- Evaluator recommendation: ${evaluation.recommendation}`,
      `- Suggested next attempt type: ${evaluation.suggested_attempt_type ?? "none"}`,
      `- Verification status: ${evaluation.verification_status}`,
      "",
      "## Summary",
      "",
      result.summary,
      "",
      "## Evaluator",
      "",
      evaluation.rationale,
      "",
      "## Next Action",
      "",
      current.recommended_next_action ?? "None."
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

  private getActiveAttemptKey(runId: string, attemptId: string): string {
    return `${runId}:${attemptId}`;
  }
}
