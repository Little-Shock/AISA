import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAttempt,
  createAttemptContract,
  createCurrentDecision,
  createRun,
  createRunJournalEntry,
  type Attempt,
  type Run,
  type WorkerWriteback
} from "../packages/domain/src/index.ts";
import {
  Orchestrator,
  refreshRunOperatorSurface,
  readRunWorkingContextView,
  resolveRuntimeLayout,
  type RuntimeLayout
} from "../packages/orchestrator/src/index.ts";
import {
  appendRunJournal,
  ensureWorkspace,
  getCurrentDecision,
  getRunAutomationControl,
  getRunWorkingContext,
  listAttempts,
  listRunJournal,
  resolveRunPaths,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptContract,
  saveCurrentDecision,
  saveRun
} from "../packages/state-store/src/index.ts";

const REVIEWER_CONFIG_ENV = "AISA_REVIEWERS_JSON";
const SYNTHESIZER_CONFIG_ENV = "AISA_REVIEW_SYNTHESIZER_JSON";
const CLOSED_BASELINE_REVIEWERS_JSON = JSON.stringify([
  {
    kind: "heuristic",
    reviewer_id: "working-context-reviewer",
    role: "runtime_reviewer",
    adapter: "deterministic-heuristic",
    provider: "local",
    model: "baseline"
  }
]);
const CLOSED_BASELINE_SYNTHESIZER_JSON = JSON.stringify({
  kind: "deterministic"
});

class SlowSuccessfulResearchAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    await wait(150);

    return {
      writeback: {
        summary: "Research attempt produced a stable next-step snapshot.",
        findings: [
          {
            type: "fact",
            content: "Working context should survive a long-running attempt.",
            evidence: ["scripts/verify-working-context.ts"]
          }
        ],
        questions: [],
        recommended_next_steps: ["Keep the run detail page reading the run-level snapshot."],
        confidence: 0.88
      },
      reportMarkdown: "working context verification report",
      exitCode: 0
    };
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCommand(
  cwd: string,
  command: string,
  args: string[]
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "pipe"
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim()}`));
    });
  });
}

async function initializeGitRepo(rootDir: string): Promise<void> {
  await runCommand(rootDir, "git", ["init", "-b", "main"]);
  await runCommand(rootDir, "git", ["config", "user.email", "aisa@example.com"]);
  await runCommand(rootDir, "git", ["config", "user.name", "AISA"]);
  await writeFile(join(rootDir, "README.md"), "# working context fixture\n", "utf8");
  await runCommand(rootDir, "git", ["add", "README.md"]);
  await runCommand(rootDir, "git", ["commit", "-m", "initial fixture"]);
}

async function createDetachedRuntimeLayout(
  rootDir: string
): Promise<RuntimeLayout> {
  return resolveRuntimeLayout({
    repositoryRoot: rootDir,
    devRepoRoot: rootDir,
    runtimeRepoRoot: rootDir,
    runtimeDataRoot: rootDir
  });
}

async function main(): Promise<void> {
  const previousReviewers = process.env[REVIEWER_CONFIG_ENV];
  const previousSynthesizer = process.env[SYNTHESIZER_CONFIG_ENV];
  process.env[REVIEWER_CONFIG_ENV] = CLOSED_BASELINE_REVIEWERS_JSON;
  process.env[SYNTHESIZER_CONFIG_ENV] = CLOSED_BASELINE_SYNTHESIZER_JSON;

  try {
    const rootDir = await mkdtemp(join(tmpdir(), "aisa-working-context-"));
    await initializeGitRepo(rootDir);
    const workspacePaths = resolveWorkspacePaths(rootDir);
    await ensureWorkspace(workspacePaths);
    const runtimeLayout = await createDetachedRuntimeLayout(rootDir);

    const run = createRun({
      title: "Working context lifecycle verification",
      description: "Prove run-level working context survives start, settle, and stale detection.",
      success_criteria: ["Persist a run-level working context snapshot."],
      constraints: [],
      owner_id: "test-owner",
      workspace_root: rootDir
    });
    const attempt = createAttempt({
      run_id: run.id,
      attempt_type: "research",
      worker: "fake-codex",
      objective: "Produce and refresh working context during one research attempt.",
      success_criteria: run.success_criteria,
      workspace_root: rootDir
    });

    await saveRun(workspacePaths, run);
    await saveAttempt(workspacePaths, attempt);
    await saveAttemptContract(
      workspacePaths,
      createAttemptContract({
        attempt_id: attempt.id,
        run_id: run.id,
        attempt_type: "research",
        objective: attempt.objective,
        success_criteria: attempt.success_criteria,
        required_evidence: ["Leave a run-level working context snapshot."],
        expected_artifacts: ["runs/<run_id>/working-context.json"]
      })
    );
    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: run.id,
        run_status: "running",
        latest_attempt_id: attempt.id,
        recommended_next_action: "attempt_running",
        recommended_attempt_type: "research",
        summary: "Run is dispatching the first research attempt."
      })
    );
    await appendRunJournal(
      workspacePaths,
      createRunJournalEntry({
        run_id: run.id,
        type: "run.created",
        payload: {
          title: run.title
        }
      })
    );
    await appendRunJournal(
      workspacePaths,
      createRunJournalEntry({
        run_id: run.id,
        attempt_id: attempt.id,
        type: "attempt.created",
        payload: {
          attempt_type: attempt.attempt_type,
          objective: attempt.objective
        }
      })
    );

    const orchestrator = new Orchestrator(
      workspacePaths,
      new SlowSuccessfulResearchAdapter() as never,
      undefined,
      60_000,
      {
        runtimeLayout
      }
    );

    await orchestrator.tick();
    let activeWorkingContext = null;
    for (let index = 0; index < 10; index += 1) {
      activeWorkingContext = await getRunWorkingContext(workspacePaths, run.id);
      if (activeWorkingContext?.source_attempt_id === attempt.id) {
        break;
      }
      await orchestrator.tick();
      await wait(30);
    }
    assert.ok(activeWorkingContext, "working context should exist while the attempt is running");
    assert.equal(activeWorkingContext.source_attempt_id, attempt.id);
    assert.equal(activeWorkingContext.current_focus, attempt.objective);
    assert.ok(
      activeWorkingContext.active_task_refs.some((task) => task.task_id === attempt.id),
      "running working context should point at the active attempt"
    );

    let settledWorkingContext = null;
    for (let index = 0; index < 40; index += 1) {
      await orchestrator.tick();
      settledWorkingContext = await getRunWorkingContext(workspacePaths, run.id);
      if (
        settledWorkingContext?.recent_evidence_refs.some(
          (item) => item.kind === "review_packet"
        ) &&
        settledWorkingContext?.recent_evidence_refs.some(
          (item) => item.kind === "handoff_bundle"
        )
      ) {
        break;
      }
      await wait(40);
    }
    assert.ok(settledWorkingContext, "working context should still exist after settle");
    assert.ok(
      settledWorkingContext.recent_evidence_refs.some(
        (item) => item.kind === "review_packet"
      ),
      "settled working context should point at the review packet"
    );
    assert.ok(
      settledWorkingContext.recent_evidence_refs.some(
        (item) => item.kind === "handoff_bundle"
      ),
      "settled working context should point at the handoff bundle"
    );

    const healthyView = await readRunWorkingContextView(workspacePaths, run.id);
    assert.equal(healthyView.working_context_degraded.is_degraded, false);
    assert.ok(healthyView.working_context_ref?.endsWith("working-context.json"));

    const creationRefreshRun = createRun({
      title: "Attempt created should refresh working context",
      description:
        "Planning the next attempt should publish the active working context before dispatch starts.",
      success_criteria: ["Expose the newly created attempt in working context immediately."],
      constraints: [],
      owner_id: "test-owner",
      workspace_root: rootDir
    });
    await saveRun(workspacePaths, creationRefreshRun);
    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: creationRefreshRun.id,
        run_status: "running",
        summary: "Run is ready to plan its first attempt."
      })
    );
    await orchestrator.tick();
    const createdAttempts = await listAttempts(workspacePaths, creationRefreshRun.id);
    assert.equal(createdAttempts.length, 1, "tick should create the first attempt");
    const creationRefreshContext = await getRunWorkingContext(
      workspacePaths,
      creationRefreshRun.id
    );
    assert.ok(
      creationRefreshContext,
      "working context should refresh as soon as attempt.created is persisted"
    );
    assert.equal(creationRefreshContext.source_attempt_id, createdAttempts[0]?.id ?? null);
    assert.ok(
      creationRefreshContext.active_task_refs.some(
        (task) => task.task_id === createdAttempts[0]?.id
      ),
      "working context should point at the just-created attempt before dispatch starts"
    );

    const missingRun = createRun({
      title: "Missing working context verification",
      description: "Read path should expose a missing run-level snapshot.",
      success_criteria: ["Return context_missing instead of guessing."],
      constraints: [],
      owner_id: "test-owner",
      workspace_root: rootDir
    });
    await saveRun(workspacePaths, missingRun);
    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: missingRun.id,
        run_status: "running",
        summary: "No working context has been written yet."
      })
    );
    const missingView = await readRunWorkingContextView(workspacePaths, missingRun.id);
    assert.equal(missingView.working_context, null);
    assert.equal(missingView.working_context_degraded.is_degraded, true);
    assert.equal(missingView.working_context_degraded.reason_code, "context_missing");

    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: run.id,
        run_status: "waiting_steer",
        latest_attempt_id: attempt.id,
        recommended_next_action: "wait_for_human",
        recommended_attempt_type: "research",
        summary: "Current decision changed after the last working context write.",
        blocking_reason: "Current decision changed after the last working context write.",
        waiting_for_human: true
      })
    );
    const staleView = await readRunWorkingContextView(workspacePaths, run.id);
    assert.equal(staleView.working_context_degraded.is_degraded, true);
    assert.equal(staleView.working_context_degraded.reason_code, "context_stale");

    const writeFailedRun = createRun({
      title: "Write failed working context verification",
      description: "Read path should expose a failed working context refresh explicitly.",
      success_criteria: ["Return context_write_failed instead of pretending the snapshot is usable."],
      constraints: [],
      owner_id: "test-owner",
      workspace_root: rootDir
    });
    await saveRun(workspacePaths, writeFailedRun);
    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: writeFailedRun.id,
        run_status: "running",
        summary: "Write a first working context snapshot."
      })
    );
    await refreshRunOperatorSurface(workspacePaths, writeFailedRun.id);

    const brokenWorkingContextPath = resolveRunPaths(
      workspacePaths,
      writeFailedRun.id
    ).workingContextFile;
    await rm(brokenWorkingContextPath, { force: true });
    await mkdir(brokenWorkingContextPath, { recursive: true });
    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: writeFailedRun.id,
        run_status: "waiting_steer",
        summary: "Broken working context path should surface an explicit degraded state.",
        blocking_reason: "Broken working context path should surface an explicit degraded state.",
        waiting_for_human: true
      })
    );
    await refreshRunOperatorSurface(workspacePaths, writeFailedRun.id);

    const writeFailedView = await readRunWorkingContextView(
      workspacePaths,
      writeFailedRun.id
    );
    assert.equal(writeFailedView.working_context, null);
    assert.equal(writeFailedView.working_context_degraded.is_degraded, true);
    assert.equal(
      writeFailedView.working_context_degraded.reason_code,
      "context_write_failed"
    );
    assert.ok(
      writeFailedView.working_context_degraded.summary?.includes("写入失败")
    );
    const writeFailedJournal = await listRunJournal(workspacePaths, writeFailedRun.id);
    assert.ok(
      writeFailedJournal.some(
        (entry) => entry.type === "run.working_context.refresh_failed"
      )
    );

    await rm(brokenWorkingContextPath, { recursive: true, force: true });
    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: writeFailedRun.id,
        run_status: "running",
        summary: "Restore the working context path and refresh again."
      })
    );
    await refreshRunOperatorSurface(workspacePaths, writeFailedRun.id);
    const recoveredWriteFailedView = await readRunWorkingContextView(
      workspacePaths,
      writeFailedRun.id
    );
    assert.equal(recoveredWriteFailedView.working_context_degraded.is_degraded, false);

    const autoResumeBlockedRun = createRun({
      title: "Auto-resume must stop on degraded working context",
      description: "A waiting run must not auto-resume when the active working context is degraded.",
      success_criteria: ["Block auto-resume when working context is missing for an active attempt."],
      constraints: [],
      owner_id: "test-owner",
      workspace_root: rootDir
    });
    const autoResumeBlockedAttempt = {
      ...createAttempt({
        run_id: autoResumeBlockedRun.id,
        attempt_type: "research",
        worker: "fake-codex",
        objective: "Leave a stopped research attempt without a working context refresh.",
        success_criteria: autoResumeBlockedRun.success_criteria,
        workspace_root: rootDir
      }),
      status: "stopped" as const,
      started_at: new Date(Date.now() - 10_000).toISOString(),
      ended_at: new Date(Date.now() - 9_000).toISOString(),
      updated_at: new Date(Date.now() - 8_000).toISOString()
    };
    await saveRun(workspacePaths, autoResumeBlockedRun);
    await saveAttempt(workspacePaths, autoResumeBlockedAttempt);
    await saveAttemptContract(
      workspacePaths,
      createAttemptContract({
        attempt_id: autoResumeBlockedAttempt.id,
        run_id: autoResumeBlockedRun.id,
        attempt_type: autoResumeBlockedAttempt.attempt_type,
        objective: autoResumeBlockedAttempt.objective,
        success_criteria: autoResumeBlockedAttempt.success_criteria,
        required_evidence: ["Keep the working context trustworthy before auto-resume."],
        expected_artifacts: ["runs/<run_id>/working-context.json"]
      })
    );
    await appendRunJournal(
      workspacePaths,
      createRunJournalEntry({
        run_id: autoResumeBlockedRun.id,
        attempt_id: autoResumeBlockedAttempt.id,
        type: "attempt.created",
        payload: {
          attempt_type: autoResumeBlockedAttempt.attempt_type,
          objective: autoResumeBlockedAttempt.objective
        }
      })
    );
    await appendRunJournal(
      workspacePaths,
      createRunJournalEntry({
        run_id: autoResumeBlockedRun.id,
        attempt_id: autoResumeBlockedAttempt.id,
        type: "attempt.started",
        payload: {
          attempt_type: autoResumeBlockedAttempt.attempt_type
        }
      })
    );
    await appendRunJournal(
      workspacePaths,
      createRunJournalEntry({
        run_id: autoResumeBlockedRun.id,
        attempt_id: autoResumeBlockedAttempt.id,
        type: "attempt.stopped",
        payload: {
          reason: "operator paused the active scene before working context refreshed"
        }
      })
    );
    await saveCurrentDecision(workspacePaths, {
      ...createCurrentDecision({
        run_id: autoResumeBlockedRun.id,
        run_status: "waiting_steer",
        latest_attempt_id: autoResumeBlockedAttempt.id,
        recommended_next_action: "wait_for_human",
        recommended_attempt_type: "research",
        summary: "Auto-resume is pending for a stopped attempt, but the working context is still missing.",
        blocking_reason:
          "Auto-resume is pending for a stopped attempt, but the working context is still missing.",
        waiting_for_human: true
      }),
      updated_at: new Date(Date.now() - 5_000).toISOString()
    });
    const degradedBeforeAutoResume = await readRunWorkingContextView(
      workspacePaths,
      autoResumeBlockedRun.id
    );
    assert.equal(
      degradedBeforeAutoResume.working_context_degraded.reason_code,
      "context_missing"
    );
    const autoResumeOrchestrator = new Orchestrator(
      workspacePaths,
      new SlowSuccessfulResearchAdapter() as never,
      undefined,
      60_000,
      {
        runtimeLayout,
        waitingHumanAutoResumeMs: 1
      }
    );
    await autoResumeOrchestrator.tick();
    const blockedAutoResumeCurrent = await getCurrentDecision(
      workspacePaths,
      autoResumeBlockedRun.id
    );
    assert.equal(
      blockedAutoResumeCurrent?.run_status,
      "waiting_steer",
      "auto-resume should stay blocked when working context is degraded"
    );
    const blockedAutoResumeAutomation = await getRunAutomationControl(
      workspacePaths,
      autoResumeBlockedRun.id
    );
    assert.equal(blockedAutoResumeAutomation?.mode, "manual_only");
    assert.equal(
      blockedAutoResumeAutomation?.reason_code,
      "automatic_resume_blocked"
    );
    assert.equal(blockedAutoResumeAutomation?.failure_code, "context_missing");
    const blockedAutoResumeJournal = await listRunJournal(
      workspacePaths,
      autoResumeBlockedRun.id
    );
    assert.ok(
      blockedAutoResumeJournal.some(
        (entry) =>
          entry.type === "run.auto_resume.blocked" &&
          entry.payload.reason === "working_context_degraded" &&
          entry.payload.failure_code === "context_missing"
      ),
      "run.auto_resume.blocked should record the degraded working context reason"
    );
    assert.ok(
      blockedAutoResumeJournal.every((entry) => entry.type !== "run.auto_resume.scheduled"),
      "degraded working context should stop auto-resume before it schedules a new cycle"
    );

    console.log(
      JSON.stringify(
        {
          run_id: run.id,
          attempt_id: attempt.id,
          active_focus: activeWorkingContext.current_focus,
          settled_evidence_kinds: settledWorkingContext.recent_evidence_refs.map(
            (item) => item.kind
          ),
          creation_refresh_attempt_id: createdAttempts[0]?.id ?? null,
          missing_reason_code: missingView.working_context_degraded.reason_code,
          stale_reason_code: staleView.working_context_degraded.reason_code,
          write_failed_reason_code: writeFailedView.working_context_degraded.reason_code,
          auto_resume_blocked_reason_code:
            blockedAutoResumeAutomation?.failure_code ?? null
        },
        null,
        2
      )
    );
  } finally {
    if (previousReviewers === undefined) {
      delete process.env[REVIEWER_CONFIG_ENV];
    } else {
      process.env[REVIEWER_CONFIG_ENV] = previousReviewers;
    }

    if (previousSynthesizer === undefined) {
      delete process.env[SYNTHESIZER_CONFIG_ENV];
    } else {
      process.env[SYNTHESIZER_CONFIG_ENV] = previousSynthesizer;
    }
  }
}

await main();
