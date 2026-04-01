import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
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
  readRunWorkingContextView,
  resolveRuntimeLayout,
  type RuntimeLayout
} from "../packages/orchestrator/src/index.ts";
import {
  appendRunJournal,
  ensureWorkspace,
  getRunWorkingContext,
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

    console.log(
      JSON.stringify(
        {
          run_id: run.id,
          attempt_id: attempt.id,
          active_focus: activeWorkingContext.current_focus,
          settled_evidence_kinds: settledWorkingContext.recent_evidence_refs.map(
            (item) => item.kind
          ),
          missing_reason_code: missingView.working_context_degraded.reason_code,
          stale_reason_code: staleView.working_context_degraded.reason_code
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
