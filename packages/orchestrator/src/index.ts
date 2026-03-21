import {
  createEvent,
  createWorkerRun,
  finishWorkerRun,
  updateBranch,
  updateGoal,
  updateSteer,
  type Branch,
  type EvalSpec,
  type Goal
} from "@autoresearch/domain";
import { appendEvent } from "@autoresearch/event-log";
import { evaluateBranch } from "@autoresearch/judge";
import { buildGoalReport } from "@autoresearch/report-builder";
import {
  getBranch,
  getContextBoard,
  getEvalResult,
  getGoal,
  getPlanArtifacts,
  getReport,
  getWriteback,
  listBranches,
  listGoals,
  listSteers,
  listWorkerRuns,
  resolveBranchArtifactPaths,
  saveBranch,
  saveEvalResult,
  saveGoal,
  saveReport,
  saveSteer,
  saveWorkerRun,
  type WorkspacePaths
} from "@autoresearch/state-store";
import { ContextManager } from "@autoresearch/context-manager";
import { CodexCliWorkerAdapter } from "@autoresearch/worker-adapters";

export class Orchestrator {
  private timer: NodeJS.Timeout | null = null;
  private readonly activeBranches = new Set<string>();

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
}
