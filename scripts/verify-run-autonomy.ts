import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAttempt,
  createAttemptAdversarialVerification,
  createAttemptContract,
  createAttemptHandoffBundle,
  createAttemptPreflightEvaluation,
  createRunAutomationControl,
  createCurrentDecision,
  createRun,
  createRunJournalEntry,
  updateCurrentDecision,
  updateAttempt,
  updateRunPolicyRuntime,
  type Attempt,
  type Run,
  type WorkerWriteback
} from "../packages/domain/src/index.js";
import {
  Orchestrator,
  deriveRunRecoveryGuidance,
  resolveRuntimeLayout,
  type RuntimeLayout,
  type RuntimeRestartRequest
} from "../packages/orchestrator/src/index.js";
import {
  appendRunJournal,
  ensureWorkspace,
  saveAttemptAdversarialVerification,
  getAttemptHandoffBundle,
  getAttemptReviewPacket,
  getRunAutomationControl,
  getCurrentDecision,
  getRunPolicyRuntime,
  listAttempts,
  listRunJournal,
  resolveAttemptPaths,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptContract,
  saveAttemptHandoffBundle,
  saveAttemptPreflightEvaluation,
  saveAttemptResult,
  saveAttemptRuntimeVerification,
  saveCurrentDecision,
  saveRun,
  saveRunAutomationControl,
  saveRunPolicyRuntime
} from "../packages/state-store/src/index.js";
import {
  cleanupTrackedVerifyTempDirs,
  createTrackedVerifyTempDir
} from "./verify-temp.ts";

type CaseResult = {
  id: string;
  status: "pass" | "fail";
  error?: string;
};

const REVIEWER_CONFIG_ENV = "AISA_REVIEWERS_JSON";
const SYNTHESIZER_CONFIG_ENV = "AISA_REVIEW_SYNTHESIZER_JSON";
const CLOSED_BASELINE_REVIEWERS_JSON = JSON.stringify([
  {
    kind: "heuristic",
    reviewer_id: "autonomy-baseline-reviewer",
    role: "runtime_reviewer",
    adapter: "deterministic-heuristic",
    provider: "local",
    model: "baseline"
  }
]);
const CLOSED_BASELINE_SYNTHESIZER_JSON = JSON.stringify({
  kind: "deterministic"
});

class AutoResumeExecutionAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (input.attempt.attempt_type !== "execution") {
      throw new Error("Failed execution should auto-resume through execution.");
    }
    const artifacts = await writeExecutionCompletionArtifacts(
      input.attempt.workspace_root,
      input.attempt.id
    );

    return {
      writeback: {
        summary: "Execution retry fixed the blocker and left replayable verification evidence.",
        findings: [
          {
            type: "fact",
            content: "The execution retry wrote the intended workspace artifact.",
            evidence: ["execution-change.md"]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.88,
        artifacts
      },
      reportMarkdown: "# fake",
      exitCode: 0
    };
  }
}

class LowSignalResearchAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: { attempt: Attempt }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (input.attempt.attempt_type !== "research") {
      throw new Error("Expected an automatic research retry.");
    }

    return {
      writeback: {
        summary: "Still missing grounded proof for the next move.",
        findings: [
          {
            type: "hypothesis",
            content: "The answer might be elsewhere.",
            evidence: []
          }
        ],
        questions: ["Need stronger repository evidence."],
        recommended_next_steps: [],
        confidence: 0.25,
        artifacts: []
      },
      reportMarkdown: "# fake",
      exitCode: 0
    };
  }
}

class CheckpointExecutionAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (input.attempt.attempt_type !== "execution") {
      throw new Error("Checkpoint auto-resume should keep going through execution.");
    }

    assert.match(
      input.attempt.objective,
      /clean git workspace|提交现场|checkpoint/u
    );
    const artifacts = await writeExecutionCompletionArtifacts(
      input.attempt.workspace_root,
      input.attempt.id
    );

    return {
      writeback: {
        summary: "Checkpoint blocker was handled inside execution and the run can keep moving.",
        findings: [
          {
            type: "fact",
            content: "The resumed execution left a replayable workspace change.",
            evidence: ["attempt.checkpoint.blocked", "execution-change.md"]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.8,
        artifacts
      },
      reportMarkdown: "# fake",
      exitCode: 0
    };
  }
}

class RecoveryExecutionAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (input.attempt.attempt_type !== "execution") {
      throw new Error("Recovery case should only dispatch execution.");
    }
    const artifacts = await writeExecutionCompletionArtifacts(
      input.attempt.workspace_root,
      input.attempt.id
    );

    return {
      writeback: {
        summary: "Recovered execution completed and left verification evidence.",
        findings: [
          {
            type: "fact",
            content: "Patched the intended target after recovery.",
            evidence: ["execution-change.md"]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.9,
        artifacts
      },
      reportMarkdown: "# fake",
      exitCode: 0
    };
  }
}

class ContinuingExecutionAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (input.attempt.attempt_type !== "execution") {
      throw new Error("Continued execution case should stay in execution.");
    }
    const artifacts = await writeExecutionCompletionArtifacts(
      input.attempt.workspace_root,
      input.attempt.id
    );

    return {
      writeback: {
        summary: "Execution made a verified change and left a concrete next step for the next pass.",
        findings: [
          {
            type: "fact",
            content: "The execution step changed the workspace and kept the mainline moving.",
            evidence: ["execution-change.md"]
          }
        ],
        questions: [],
        recommended_next_steps: ["Continue the verified execution mainline."],
        confidence: 0.9,
        artifacts
      },
      reportMarkdown: "# fake",
      exitCode: 0
    };
  }
}

class FastRetryExecutionAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (input.attempt.attempt_type !== "execution") {
      throw new Error("Rate-limited execution retry should stay in execution.");
    }
    const artifacts = await writeExecutionCompletionArtifacts(
      input.attempt.workspace_root,
      input.attempt.id
    );

    return {
      writeback: {
        summary: "Provider recovered and the execution retry completed.",
        findings: [
          {
            type: "fact",
            content: "Execution retried after the transient provider limit.",
            evidence: ["execution-change.md"]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.86,
        artifacts
      },
      reportMarkdown: "# fake",
      exitCode: 0
    };
  }
}

class NeverDispatchAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    throw new Error("Superseded self-bootstrap run should not auto resume or dispatch.");
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(
  orchestrator: Orchestrator,
  input: {
    workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
    runId: string;
    iterations: number;
    delayMs?: number;
  }
): Promise<void> {
  const delayMs = input.delayMs ?? 40;

  for (let index = 0; index < input.iterations; index += 1) {
    await orchestrator.tick();
    if (
      await maybeApprovePendingExecutionPolicyFromAutonomyLoop({
        workspacePaths: input.workspacePaths,
        runId: input.runId,
        delayMs
      })
    ) {
      continue;
    }
    await wait(delayMs);
  }
}

async function settleUntil(
  orchestrator: Orchestrator,
  input: {
    workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
    runId: string;
    predicate: (runStatus: string | null, waitingForHuman: boolean) => boolean;
    timeoutMs?: number;
    delayMs?: number;
  }
): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  const delayMs = input.delayMs ?? 80;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await orchestrator.tick();
    if (
      await maybeApprovePendingExecutionPolicyFromAutonomyLoop({
        workspacePaths: input.workspacePaths,
        runId: input.runId,
        delayMs
      })
    ) {
      continue;
    }
    const current = await getCurrentDecision(input.workspacePaths, input.runId);
    if (input.predicate(current?.run_status ?? null, current?.waiting_for_human ?? false)) {
      return;
    }
    await wait(delayMs);
  }

  throw new Error(`Timed out while waiting for run ${input.runId} to reach the expected state.`);
}

async function settleUntilSnapshot(
  orchestrator: Orchestrator,
  input: {
    workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
    runId: string;
    predicate: (snapshot: {
      runStatus: string | null;
      waitingForHuman: boolean;
      attempts: Awaited<ReturnType<typeof listAttempts>>;
    }) => boolean;
    timeoutMs?: number;
    delayMs?: number;
  }
): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  const delayMs = input.delayMs ?? 80;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await orchestrator.tick();
    if (
      await maybeApprovePendingExecutionPolicyFromAutonomyLoop({
        workspacePaths: input.workspacePaths,
        runId: input.runId,
        delayMs
      })
    ) {
      continue;
    }
    const [current, attempts] = await Promise.all([
      getCurrentDecision(input.workspacePaths, input.runId),
      listAttempts(input.workspacePaths, input.runId)
    ]);
    if (
      input.predicate({
        runStatus: current?.run_status ?? null,
        waitingForHuman: current?.waiting_for_human ?? false,
        attempts
      })
    ) {
      return;
    }
    await wait(delayMs);
  }

  throw new Error(`Timed out while waiting for run ${input.runId} to reach the expected snapshot.`);
}

async function maybeApprovePendingExecutionPolicyFromAutonomyLoop(
  input: {
    workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
    runId: string;
    delayMs: number;
  }
): Promise<boolean> {
  const approved = await maybeApprovePendingExecutionPolicy(
    input.workspacePaths,
    input.runId
  );
  if (approved) {
    await wait(input.delayMs);
  }
  return approved;
}

async function maybeApprovePendingExecutionPolicy(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string
): Promise<boolean> {
  const [current, policyRuntime, journal] = await Promise.all([
    getCurrentDecision(workspacePaths, runId),
    getRunPolicyRuntime(workspacePaths, runId),
    listRunJournal(workspacePaths, runId)
  ]);

  if (!current || !policyRuntime) {
    return false;
  }

  if (
    policyRuntime.approval_required !== true ||
    policyRuntime.approval_status !== "pending" ||
    policyRuntime.proposed_attempt_type !== "execution"
  ) {
    return false;
  }

  const latestAutoResumeEntry = [...journal]
    .reverse()
    .find((entry) => entry.type === "run.auto_resume.scheduled");
  const nextAction =
    latestAutoResumeEntry?.payload.next_action === "retry_attempt" ||
    latestAutoResumeEntry?.payload.next_action === "continue_execution" ||
    latestAutoResumeEntry?.payload.next_action === "start_execution"
      ? latestAutoResumeEntry.payload.next_action
      : "continue_execution";

  const approvedPolicy = updateRunPolicyRuntime(policyRuntime, {
    stage: "execution",
    approval_status: "approved",
    blocking_reason: null,
    last_decision: "approved",
    approval_decided_at: new Date().toISOString(),
    approval_actor: "verify-run-autonomy",
    approval_note:
      "Auto-approved by verify-run-autonomy so execution auto-resume checks can continue."
  });
  const resumedCurrent = updateCurrentDecision(current, {
    run_status: "running",
    waiting_for_human: false,
    blocking_reason: null,
    recommended_next_action: nextAction,
    recommended_attempt_type: "execution",
    summary: current.summary
  });

  await Promise.all([
    saveRunPolicyRuntime(workspacePaths, approvedPolicy),
    saveCurrentDecision(workspacePaths, resumedCurrent)
  ]);
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: runId,
      attempt_id: approvedPolicy.source_attempt_id,
      type: "run.policy.approved",
      payload: {
        actor: approvedPolicy.approval_actor,
        note: approvedPolicy.approval_note,
        proposed_signature: approvedPolicy.proposed_signature
      }
    })
  );

  return true;
}

async function bootstrapRun(
  title: string,
  runTitle?: string,
  runOverrides?: {
    harness_profile?: Parameters<typeof createRun>[0]["harness_profile"];
  }
): Promise<{
  run: Run;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  rootDir: string;
  detachedRuntimeLayout: RuntimeLayout;
}> {
  const rootDir = await createTrackedVerifyTempDir(`aisa-autonomy-${title}-`);
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);
  const detachedRuntimeLayout = await createDetachedRuntimeLayout(title, rootDir);

  const run = createRun({
    title: runTitle ?? title,
    description: "Verify autonomous resume behavior",
    success_criteria: ["Produce the next valid move without defaulting to human wait."],
    constraints: [],
    owner_id: "test",
    workspace_root: rootDir,
    harness_profile: runOverrides?.harness_profile
  });

  await saveRun(workspacePaths, run);
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

  return {
    run,
    workspacePaths,
    rootDir,
    detachedRuntimeLayout
  };
}

async function createDetachedRuntimeLayout(
  title: string,
  runtimeDataRoot: string
): Promise<RuntimeLayout> {
  const laneRepoRoot = await createTrackedVerifyTempDir(
    `aisa-autonomy-runtime-lane-${title}-`
  );
  await initializeGitRepo(laneRepoRoot);
  return resolveRuntimeLayout({
    repositoryRoot: laneRepoRoot,
    devRepoRoot: laneRepoRoot,
    runtimeRepoRoot: laneRepoRoot,
    runtimeDataRoot
  });
}

async function createPromotableRuntimeLayout(
  title: string,
  devRepoRoot: string,
  runtimeDataRoot: string
): Promise<RuntimeLayout> {
  const runtimeRepoRoot = await createTrackedVerifyTempDir(
    `aisa-autonomy-runtime-promote-${title}-`
  );
  await runCommand(runtimeDataRoot, [
    "git",
    "clone",
    "--quiet",
    devRepoRoot,
    runtimeRepoRoot
  ]);
  return resolveRuntimeLayout({
    repositoryRoot: runtimeRepoRoot,
    devRepoRoot,
    runtimeRepoRoot,
    runtimeDataRoot
  });
}

async function initializeGitRepo(rootDir: string): Promise<void> {
  await writeFile(
    join(rootDir, ".gitignore"),
    ["runs/", "state/", "events/", "artifacts/", "reports/", "plans/"].join("\n") + "\n",
    "utf8"
  );
  await writeFile(join(rootDir, "README.md"), "# autonomy verify\n", "utf8");
  await runCommand(rootDir, ["git", "-C", rootDir, "init"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "config", "user.name", "AISA Verify"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "config", "user.email", "aisa-verify@example.com"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "add", "."]);
  await runCommand(rootDir, ["git", "-C", rootDir, "commit", "-m", "test: seed autonomy repo"]);
}

async function writeExecutionWorkspacePackage(rootDir: string): Promise<void> {
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify(
      {
        name: "aisa-autonomy-temp",
        private: true,
        packageManager: "pnpm@10.27.0",
        scripts: {
          typecheck: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)"'
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  await mkdir(join(rootDir, "node_modules"), { recursive: true });
  await writeFile(join(rootDir, "node_modules", ".placeholder"), "toolchain\n", "utf8");
}

async function writeExecutionWorkspacePackageWithoutNodeModules(
  rootDir: string
): Promise<void> {
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify(
      {
        name: "aisa-autonomy-temp",
        private: true,
        packageManager: "pnpm@10.27.0",
        scripts: {
          typecheck: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)"',
          "verify:runtime": 'node -e "process.exit(0)"'
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

async function writeAdversarialVerificationFixture(
  workspaceRoot: string,
  attemptId: string
): Promise<void> {
  const outputDir = join(workspaceRoot, "artifacts", "adversarial");
  await mkdir(outputDir, { recursive: true });
  const outputRef = join(outputDir, `${attemptId}.txt`);
  await writeFile(outputRef, `adversarial probe passed for ${attemptId}\n`, "utf8");
  await writeFile(
    join(workspaceRoot, "artifacts", "adversarial-verification.json"),
    JSON.stringify(
      {
        summary: "Adversarial verification passed after deterministic replay.",
        verdict: "pass",
        checks: [
          {
            code: "non_happy_path",
            status: "passed",
            message: "A non-happy-path probe stayed green."
          }
        ],
        commands: [
          {
            purpose: "probe repeated execution output",
            command: `test -f execution-change.md && rg -n "^execution change from ${attemptId}$" execution-change.md`,
            exit_code: 0,
            status: "passed",
            output_ref: "artifacts/adversarial/" + `${attemptId}.txt`
          }
        ],
        output_refs: ["artifacts/adversarial/" + `${attemptId}.txt`]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

async function writeExecutionCompletionArtifacts(
  workspaceRoot: string,
  attemptId: string
): Promise<WorkerWriteback["artifacts"]> {
  await writeFile(join(workspaceRoot, "execution-change.md"), `execution change from ${attemptId}\n`, "utf8");
  await mkdir(join(workspaceRoot, "artifacts"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "artifacts", "diff.patch"),
    [
      "diff --git a/execution-change.md b/execution-change.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/execution-change.md",
      "@@ -0,0 +1 @@",
      `+execution change from ${attemptId}`
    ].join("\n") + "\n",
    "utf8"
  );
  await writeAdversarialVerificationFixture(workspaceRoot, attemptId);

  return [
    { type: "patch", path: "artifacts/diff.patch" },
    { type: "test_result", path: "artifacts/adversarial-verification.json" }
  ];
}

async function runCommand(rootDir: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const [command, ...commandArgs] = args;
    const child = spawn(command!, commandArgs, {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if ((code ?? 1) !== 0) {
        reject(new Error(stderr || `Command failed: ${args.join(" ")}`));
        return;
      }

      resolve();
    });
  });
}

async function verifyFailedExecutionAutoResumes(): Promise<void> {
  const failureReason =
    "Execution check failed because the target behavior is still missing in app.ts.";
  const { run, workspacePaths, rootDir, detachedRuntimeLayout } = await bootstrapRun(
    "failed-execution-auto-resume"
  );
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);
  const failedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Apply the planned execution step.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  await saveAttempt(workspacePaths, failedExecution);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: failedExecution.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: "Execution failed and is waiting for steer.",
      blocking_reason: failureReason,
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedExecution.id,
      type: "attempt.failed",
      payload: {
        message: failureReason
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new AutoResumeExecutionAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await wait(40);
  await settleUntil(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: (runStatus) => runStatus === "completed",
    timeoutMs: 180_000,
    delayMs: 120
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, false, "run should auto resume");
  assert.equal(current.run_status, "completed", "run should finish after the resumed execution");
  assert.equal(current.recommended_next_action, null);
  assert.deepEqual(
    attempts.map((attempt) => attempt.attempt_type),
    ["execution", "execution"]
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["failed", "completed"]
  );
  assert.ok(
    journal.some((entry) => entry.type === "run.auto_resume.scheduled"),
    "expected an automatic resume event"
  );
  assert.ok(
    journal.some((entry) => entry.type === "attempt.verification.passed"),
    "resumed execution should pass runtime verification with the inferred contract"
  );
}

async function verifyRunLaunchResetsAutoResumeBudget(): Promise<void> {
  const failureReason =
    "Execution check failed because the target behavior is still missing in app.ts.";
  const { run, workspacePaths, rootDir, detachedRuntimeLayout } = await bootstrapRun(
    "run-launch-resets-auto-resume-budget"
  );
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);

  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.auto_resume.scheduled",
      payload: {
        cycle: 1,
        next_action: "retry_attempt",
        attempt_type: "research",
        reason: "failed_research_retry"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.auto_resume.exhausted",
      payload: {
        attempted_cycles: 1,
        message: "old exhaustion marker"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.launched",
      payload: {}
    })
  );

  const failedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Resume execution after a fresh launch.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  await saveAttempt(workspacePaths, failedExecution);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: failedExecution.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: "Execution failed after relaunch.",
      blocking_reason: failureReason,
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedExecution.id,
      type: "attempt.failed",
      payload: {
        message: failureReason
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new AutoResumeExecutionAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 30,
      maxAutomaticResumeCycles: 1
    }
  );

  await wait(40);
  await settleUntil(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: (runStatus) => runStatus === "completed",
    timeoutMs: 45_000,
    delayMs: 120
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);
  const autoResumeScheduled = journal.filter(
    (entry) => entry.type === "run.auto_resume.scheduled"
  ).length;
  const autoResumeExhausted = journal.filter(
    (entry) => entry.type === "run.auto_resume.exhausted"
  ).length;

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, false, "fresh launch should reset exhausted budget");
  assert.equal(current.run_status, "completed");
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["failed", "completed"]
  );
  assert.equal(
    autoResumeScheduled,
    2,
    "expected the fresh launch to allow one new automatic resume on top of the old history"
  );
  assert.equal(autoResumeExhausted, 1, "old exhaustion marker should not be duplicated");
}

async function verifyRepeatedAutoResumeExhausts(): Promise<void> {
  const { run, workspacePaths } = await bootstrapRun("auto-resume-exhaustion");
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "running",
      recommended_next_action: "start_first_attempt",
      recommended_attempt_type: "research",
      summary: "Bootstrapped for repeated autonomy verification."
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new LowSignalResearchAdapter() as never,
    undefined,
    60_000,
    {
      waitingHumanAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await settle(orchestrator, {
    workspacePaths,
    runId: run.id,
    iterations: 24
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);
  const autoResumeScheduled = journal.filter(
    (entry) => entry.type === "run.auto_resume.scheduled"
  ).length;
  const autoResumeBlocked = journal.filter(
    (entry) => entry.type === "run.auto_resume.blocked"
  ).length;

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, true, "run should eventually stop for human steer");
  assert.equal(current.run_status, "waiting_steer");
  assert.equal(current.recommended_next_action, "wait_for_human");
  assert.equal(autoResumeScheduled, 1, "governance should allow only one skeptical auto-resume round");
  assert.equal(autoResumeBlocked, 1, "governance should hard-block the repeated blocker");
  assert.ok(
    current.blocking_reason?.includes("Loop paused after repeated research attempts without fresh progress"),
    "current decision should explain that governance blocked the repeated blocker"
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.auto_resume.blocked" &&
        entry.payload.reason === "governance_repeated_blocker"
    ),
    "the repeated blocker should be blocked by governance before budget exhaustion"
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.attempt_type),
    ["research", "research", "research"]
  );
  assert.ok(
    attempts.every((attempt) => attempt.status === "completed"),
    "all repeated research attempts should settle before governance blocks further retries"
  );
}

async function verifyCheckpointBlockerAutoResumesIntoExecution(): Promise<void> {
  const { run, workspacePaths, rootDir, detachedRuntimeLayout } = await bootstrapRun(
    "checkpoint-blocker-auto-resume"
  );
  await initializeGitRepo(rootDir);
  const completedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Leave a verified execution step.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  await saveAttempt(workspacePaths, completedExecution);
  await saveAttemptContract(
    workspacePaths,
    createAttemptContract({
      attempt_id: completedExecution.id,
      run_id: run.id,
      attempt_type: "execution",
      objective: completedExecution.objective,
      success_criteria: completedExecution.success_criteria,
      required_evidence: [
        "git-visible workspace changes",
        "a replayable verification command that checks the execution change"
      ],
      expected_artifacts: ["execution-change.md"],
      verification_plan: {
        commands: [
          {
            purpose: "confirm the execution change was written",
            command:
              "test -f execution-change.md && rg -n '^execution change from' execution-change.md"
          }
        ]
      }
    })
  );
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: completedExecution.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: "Checkpoint creation is blocked.",
      blocking_reason:
        "Execution auto-checkpoint requires a clean git workspace before the attempt starts.",
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.checkpoint.blocked",
      payload: {
        reason: "workspace_not_clean_before_execution",
        message:
          "Execution auto-checkpoint requires a clean git workspace before the attempt starts."
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new CheckpointExecutionAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await wait(40);
  await settleUntilSnapshot(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: ({ waitingForHuman, attempts }) =>
      waitingForHuman === false &&
      attempts.filter((attempt) => attempt.status === "completed").length >= 2,
    timeoutMs: 75_000,
    delayMs: 80
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);
  const resumedExecution = [...attempts]
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .find((attempt) => attempt.id !== completedExecution.id && attempt.status === "completed");

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, false, "checkpoint blocker should auto-resume into execution");
  assert.notEqual(current.run_status, "waiting_steer");
  assert.notEqual(current.recommended_next_action, "wait_for_human");
  assert.ok(resumedExecution, "checkpoint blocker should lead to at least one resumed execution");
  assert.deepEqual(
    attempts.slice(0, 2).map((attempt) => attempt.attempt_type),
    ["execution", "execution"]
  );
  assert.ok(
    journal.some((entry) => entry.type === "run.auto_resume.scheduled"),
    "expected the checkpoint blocker to schedule automatic resume"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.blocked"),
    "checkpoint blocker should no longer hard-stop automatic resume"
  );
}

async function verifyNoGitChangesBlocksAutoResume(): Promise<void> {
  const { run, workspacePaths, rootDir, detachedRuntimeLayout } = await bootstrapRun(
    "no-git-changes-blocks-auto-resume"
  );
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);

  const completedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Apply a minimal execution step.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );
  const failureReason =
    "Execution attempt finished without any new git-visible workspace changes beyond the preflight baseline, so the runtime cannot treat it as a verified implementation step.";

  await saveAttempt(workspacePaths, completedExecution);
  await saveAttemptRuntimeVerification(workspacePaths, {
    attempt_id: completedExecution.id,
    run_id: run.id,
    attempt_type: "execution",
    status: "failed",
    repo_root: rootDir,
    git_head: null,
    git_status: [],
    preexisting_git_status: [],
    new_git_status: [],
    changed_files: [],
    failure_class: "runtime_verification_failed",
    failure_policy_mode: "fail_closed",
    failure_code: "no_git_changes",
    failure_reason: failureReason,
    command_results: [],
    synced_self_bootstrap_artifacts: null,
    created_at: new Date().toISOString()
  });
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      latest_attempt_id: completedExecution.id,
      run_status: "waiting_steer",
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: "Execution 没有留下新的 git 改动。",
      blocking_reason: failureReason,
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.completed",
      payload: {
        recommendation: "wait_human",
        goal_progress: 0.2,
        suggested_attempt_type: "execution"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.verification.failed",
      payload: {
        status: "failed",
        failure_code: "no_git_changes",
        failure_reason: failureReason,
        changed_files: [],
        command_count: 0,
        artifact_path: "artifacts/runtime-verification.json"
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new AutoResumeExecutionAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await wait(40);
  await settle(orchestrator, {
    workspacePaths,
    runId: run.id,
    iterations: 8,
    delayMs: 80
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);
  const handoffBundle = await getAttemptHandoffBundle(
    workspacePaths,
    run.id,
    completedExecution.id
  );
  const blockedEntry = journal.find((entry) => entry.type === "run.auto_resume.blocked");

  assert.ok(current, "current decision must exist");
  assert.equal(current.run_status, "waiting_steer");
  assert.equal(current.waiting_for_human, true);
  assert.equal(current.recommended_next_action, "wait_for_human");
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["completed"],
    "no_git_changes should fail closed instead of spawning another execution"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.scheduled"),
    "no_git_changes should not schedule automatic resume"
  );
  assert.ok(handoffBundle, "expected a machine-readable handoff bundle");
  assert.equal(
    handoffBundle?.failure_code,
    "no_git_changes",
    "handoff bundle should carry the runtime failure code"
  );
  assert.equal(
    handoffBundle?.recommended_next_action,
    "wait_for_human",
    "handoff bundle should preserve the blocked next action"
  );
  assert.equal(
    handoffBundle?.source_refs.review_packet,
    `runs/${run.id}/attempts/${completedExecution.id}/review_packet.json`,
    "handoff bundle should point at the review packet"
  );
  assert.equal(
    handoffBundle?.source_refs.runtime_verification,
    `runs/${run.id}/attempts/${completedExecution.id}/artifacts/runtime-verification.json`,
    "handoff bundle should point at runtime verification"
  );
  assert.ok(blockedEntry, "expected a machine-readable auto-resume blocker");
  assert.equal(blockedEntry?.payload.reason, "runtime_verification_failed");
  assert.equal(blockedEntry?.payload.failure_code, "no_git_changes");
  assert.equal(
    blockedEntry?.payload.handoff_bundle_ref,
    `runs/${run.id}/attempts/${completedExecution.id}/artifacts/handoff_bundle.json`,
    "blocked auto-resume should point at the consumed handoff bundle"
  );
}

async function verifyPreflightBlockedExecutionBlocksAutoResume(): Promise<void> {
  const { run, workspacePaths, rootDir, detachedRuntimeLayout } = await bootstrapRun(
    "preflight-blocked-execution-blocks-auto-resume"
  );
  await writeExecutionWorkspacePackageWithoutNodeModules(rootDir);
  await initializeGitRepo(rootDir);

  const failedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective:
        "Stop automatic resume when preflight already proved the verifier plan is not runnable here.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      ended_at: new Date().toISOString()
    }
  );
  const failureReason = [
    `Execution attempt ${failedExecution.id} is blocked before dispatch because attempt_contract.json asks runtime to replay pnpm typecheck, pnpm verify:runtime.`,
    `${rootDir} has no local node_modules, so those pnpm commands are not replayable here.`,
    "Add the local verifier toolchain or replace the pnpm commands with direct replay commands."
  ].join(" ");
  const attemptContract = createAttemptContract({
    run_id: run.id,
    attempt_id: failedExecution.id,
    attempt_type: "execution",
    objective: failedExecution.objective,
    success_criteria: failedExecution.success_criteria,
    required_evidence: [
      "git-visible workspace changes",
      "replayable verification output"
    ],
    adversarial_verification_required: true,
    verification_plan: {
      commands: [
        {
          purpose: "typecheck the workspace after the change",
          command: "pnpm typecheck"
        },
        {
          purpose: "replay the runtime regression suite after the change",
          command: "pnpm verify:runtime"
        }
      ]
    }
  });
  const preflightEvaluation = createAttemptPreflightEvaluation({
    run_id: run.id,
    attempt_id: failedExecution.id,
    attempt_type: "execution",
    status: "failed",
    failure_code: "blocked_pnpm_verification_plan",
    failure_reason: failureReason
  });
  const currentSnapshot = createCurrentDecision({
    run_id: run.id,
    latest_attempt_id: failedExecution.id,
    run_status: "waiting_steer",
    recommended_next_action: "wait_for_human",
    recommended_attempt_type: "execution",
    summary: "显式 pnpm 回放被 preflight 挡住了。",
    blocking_reason: failureReason,
    waiting_for_human: true
  });

  await saveAttempt(workspacePaths, failedExecution);
  await saveAttemptContract(workspacePaths, attemptContract);
  await saveAttemptPreflightEvaluation(workspacePaths, preflightEvaluation);
  await saveCurrentDecision(workspacePaths, currentSnapshot);
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedExecution.id,
      type: "attempt.preflight.failed",
      payload: {
        status: "failed",
        failure_code: preflightEvaluation.failure_code,
        failure_reason: failureReason,
        artifact_path: "artifacts/preflight-evaluation.json"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedExecution.id,
      type: "attempt.failed",
      payload: {
        message: failureReason
      }
    })
  );
  await saveAttemptHandoffBundle(
    workspacePaths,
    createAttemptHandoffBundle({
      attempt: failedExecution,
      approved_attempt_contract: attemptContract,
      preflight_evaluation: preflightEvaluation,
      current_decision_snapshot: currentSnapshot,
      source_refs: {
        run_contract: `runs/${run.id}/contract.json`,
        attempt_meta: `runs/${run.id}/attempts/${failedExecution.id}/meta.json`,
        attempt_contract: `runs/${run.id}/attempts/${failedExecution.id}/attempt_contract.json`,
        preflight_evaluation: `runs/${run.id}/attempts/${failedExecution.id}/artifacts/preflight-evaluation.json`,
        current_decision: `runs/${run.id}/current.json`,
        review_packet: null,
        runtime_verification: null,
        adversarial_verification: null
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new AutoResumeExecutionAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await wait(40);
  await settle(orchestrator, {
    workspacePaths,
    runId: run.id,
    iterations: 8,
    delayMs: 80
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);
  const handoffBundle = await getAttemptHandoffBundle(
    workspacePaths,
    run.id,
    failedExecution.id
  );
  const blockedEntry = journal.find((entry) => entry.type === "run.auto_resume.blocked");

  assert.ok(current, "current decision must exist");
  assert.equal(current.run_status, "waiting_steer");
  assert.equal(current.waiting_for_human, true);
  assert.equal(current.recommended_next_action, "wait_for_human");
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["failed"],
    "preflight-blocked execution should fail closed instead of spawning another execution"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.scheduled"),
    "preflight-blocked execution should not schedule automatic resume"
  );
  assert.ok(handoffBundle, "expected a machine-readable handoff bundle");
  assert.equal(
    handoffBundle?.failure_signal?.source_kind,
    "preflight_evaluation",
    "handoff bundle should preserve the preflight failure source"
  );
  assert.equal(
    handoffBundle?.failure_signal?.failure_code,
    "blocked_pnpm_verification_plan",
    "handoff bundle should preserve the preflight failure code"
  );
  assert.equal(
    handoffBundle?.failure_code,
    "blocked_pnpm_verification_plan",
    "handoff bundle should expose the unified top-level preflight failure code"
  );
  assert.equal(
    handoffBundle?.source_refs.preflight_evaluation,
    `runs/${run.id}/attempts/${failedExecution.id}/artifacts/preflight-evaluation.json`,
    "handoff bundle should point at preflight evaluation"
  );
  assert.ok(blockedEntry, "expected a machine-readable auto-resume blocker");
  assert.equal(blockedEntry?.payload.reason, "preflight_blocked");
  assert.equal(blockedEntry?.payload.failure_code, "blocked_pnpm_verification_plan");
  assert.equal(
    blockedEntry?.payload.handoff_bundle_ref,
    `runs/${run.id}/attempts/${failedExecution.id}/artifacts/handoff_bundle.json`,
    "blocked auto-resume should point at the consumed handoff bundle"
  );
  assert.ok(
    String(blockedEntry?.payload.message).includes("no local node_modules"),
    "blocked auto-resume should surface the original preflight failure"
  );
}

async function verifyRecoveryAutoResumesExecution(): Promise<void> {
  const { run, workspacePaths, rootDir, detachedRuntimeLayout } = await bootstrapRun(
    "recovery-auto-resume"
  );
  await initializeGitRepo(rootDir);

  const researchAttempt = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "research",
      worker: "fake-codex",
      objective: "Find the next execution move.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );
  const executionDraft = {
    attempt_type: "execution" as const,
    objective: "Apply the recovered execution step.",
    success_criteria: ["Leave a verified execution artifact in the workspace."],
    required_evidence: [
      "git-visible workspace changes",
      "a replayable verification command that checks the execution change"
    ],
    adversarial_verification_required: true,
    forbidden_shortcuts: ["do not claim success without replayable verification"],
    expected_artifacts: ["execution-change.md"],
    verification_plan: {
      commands: [
        {
          purpose: "confirm the execution change was written",
          command:
            "test -f execution-change.md && rg -n '^execution change from' execution-change.md"
        }
      ]
    }
  };
  const researchWriteback: WorkerWriteback = {
    summary: "Repository understanding is strong enough to resume execution.",
    findings: [
      {
        type: "fact",
        content: "Found the right file to patch",
        evidence: ["execution-change.md"]
      }
    ],
    questions: [],
    recommended_next_steps: ["Resume the execution step with the locked contract."],
    confidence: 0.84,
    next_attempt_contract: executionDraft,
    artifacts: []
  };

  await saveAttempt(workspacePaths, researchAttempt);
  await saveAttemptContract(
    workspacePaths,
    createAttemptContract({
      attempt_id: researchAttempt.id,
      run_id: run.id,
      attempt_type: "research",
      objective: researchAttempt.objective,
      success_criteria: researchAttempt.success_criteria,
      required_evidence: [
        "Ground findings in concrete files, commands, or artifacts.",
        "If execution is recommended, leave a replayable execution contract for the next attempt."
      ]
    })
  );
  await saveAttemptResult(workspacePaths, run.id, researchAttempt.id, researchWriteback);
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: researchAttempt.id,
      type: "attempt.created",
      payload: {
        attempt_type: researchAttempt.attempt_type,
        objective: researchAttempt.objective
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: researchAttempt.id,
      type: "attempt.started",
      payload: {
        attempt_type: researchAttempt.attempt_type
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: researchAttempt.id,
      type: "attempt.completed",
      payload: {
        recommendation: "continue",
        goal_progress: 0.62,
        suggested_attempt_type: "execution"
      }
    })
  );

  const orphanedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: executionDraft.objective,
      success_criteria: executionDraft.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "running",
      started_at: new Date().toISOString()
    }
  );

  await saveAttempt(workspacePaths, orphanedExecution);
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: orphanedExecution.id,
      type: "attempt.created",
      payload: {
        attempt_type: orphanedExecution.attempt_type,
        objective: orphanedExecution.objective
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: orphanedExecution.id,
      type: "attempt.started",
      payload: {
        attempt_type: orphanedExecution.attempt_type
      }
    })
  );
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "running",
      latest_attempt_id: orphanedExecution.id,
      recommended_next_action: "attempt_running",
      recommended_attempt_type: "execution",
      summary: "Execution was in flight before restart.",
      waiting_for_human: false
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new RecoveryExecutionAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await orchestrator.tick();
  await wait(60);
  await settleUntilSnapshot(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: ({ runStatus, attempts }) =>
      runStatus === "completed" &&
      attempts.length >= 3 &&
      attempts.filter((attempt) => attempt.status === "completed").length >= 2,
    timeoutMs: 180_000,
    delayMs: 80
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);
  const stoppedExecutionHandoff = await getAttemptHandoffBundle(
    workspacePaths,
    run.id,
    orphanedExecution.id
  );
  const scheduledEntry = journal.find((entry) => entry.type === "run.auto_resume.scheduled");

  assert.ok(current, "current decision must exist");
  assert.equal(current.run_status, "completed", "recovered execution should finish the run");
  assert.equal(current.waiting_for_human, false);
  assert.deepEqual(
    attempts.map((attempt) => attempt.attempt_type),
    ["research", "execution", "execution"]
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["completed", "stopped", "completed"]
  );
  assert.ok(
    journal.some((entry) => entry.type === "attempt.recovery_required"),
    "expected recovery journal entry"
  );
  assert.ok(
    scheduledEntry,
    "expected automatic resume after recovery wait"
  );
  assert.ok(stoppedExecutionHandoff, "expected a handoff bundle for the stopped execution");
  assert.equal(
    stoppedExecutionHandoff?.recommended_next_action,
    "wait_for_human",
    "stopped execution handoff should preserve the blocked recovery boundary"
  );
  assert.equal(
    scheduledEntry?.payload.handoff_bundle_ref,
    `runs/${run.id}/attempts/${orphanedExecution.id}/artifacts/handoff_bundle.json`,
    "scheduled auto-resume should point at the consumed handoff bundle"
  );
}

async function verifyLowReviewerProfileBlocksSettledAutoResume(): Promise<void> {
  const { run, workspacePaths, detachedRuntimeLayout } = await bootstrapRun(
    "low-reviewer-profile-blocks-settled-auto-resume",
    undefined,
    {
      harness_profile: {
        reviewer: {
          effort: "low"
        }
      }
    }
  );

  const settledExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Keep the settled handoff ready for profile-based recovery gating.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );
  const attemptContract = createAttemptContract({
    attempt_id: settledExecution.id,
    run_id: run.id,
    attempt_type: settledExecution.attempt_type,
    objective: settledExecution.objective,
    success_criteria: settledExecution.success_criteria,
    required_evidence: ["Leave a settled handoff bundle for the next pickup."]
  });
  const currentSnapshot = createCurrentDecision({
    run_id: run.id,
    latest_attempt_id: settledExecution.id,
    run_status: "waiting_steer",
    recommended_next_action: "wait_for_human",
    recommended_attempt_type: "execution",
    summary: "Settled handoff is present, but low reviewer profile should keep recovery manual.",
    blocking_reason:
      "Settled handoff is present, but low reviewer profile should keep recovery manual.",
    waiting_for_human: true
  });

  await saveAttempt(workspacePaths, settledExecution);
  await saveAttemptContract(workspacePaths, attemptContract);
  await saveCurrentDecision(workspacePaths, currentSnapshot);
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: settledExecution.id,
      type: "attempt.failed",
      payload: {
        message: currentSnapshot.blocking_reason
      }
    })
  );
  await saveAttemptHandoffBundle(
    workspacePaths,
    createAttemptHandoffBundle({
      attempt: settledExecution,
      approved_attempt_contract: attemptContract,
      current_decision_snapshot: currentSnapshot,
      source_refs: {
        run_contract: `runs/${run.id}/contract.json`,
        attempt_meta: `runs/${run.id}/attempts/${settledExecution.id}/meta.json`,
        attempt_contract: `runs/${run.id}/attempts/${settledExecution.id}/attempt_contract.json`,
        preflight_evaluation: null,
        current_decision: `runs/${run.id}/current.json`,
        review_packet: null,
        runtime_verification: null,
        adversarial_verification: null
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new RecoveryExecutionAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await wait(40);
  await settle(orchestrator, {
    workspacePaths,
    runId: run.id,
    iterations: 8,
    delayMs: 80
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);
  const blockedEntry = journal.find((entry) => entry.type === "run.auto_resume.blocked");

  assert.ok(current, "current decision must exist");
  assert.equal(current.run_status, "waiting_steer");
  assert.equal(current.waiting_for_human, true);
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["failed"],
    "low reviewer recovery policy should block auto-resume from a settled handoff"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.scheduled"),
    "low reviewer recovery policy should not schedule automatic resume"
  );
  assert.ok(blockedEntry, "expected a machine-readable auto-resume blocker");
  assert.equal(blockedEntry?.payload.reason, "profile_manual_recovery");
  assert.equal(
    blockedEntry?.payload.handoff_bundle_ref,
    `runs/${run.id}/attempts/${settledExecution.id}/artifacts/handoff_bundle.json`,
    "profile blocker should still point at the consumed handoff bundle"
  );
  assert.match(
    String(blockedEntry?.payload.message),
    /manual recovery|reviewer/i,
    "profile blocker should explain why low reviewer policy disables settled auto-resume"
  );
}

async function verifyMissingHandoffRecoveryGuidanceDegradesToResearch(): Promise<void> {
  const run = createRun({
    title: "missing-handoff-guidance",
    description: "Verify degraded recovery guidance without relying on orchestrator backfill.",
    success_criteria: ["fallback to research rebuild when no handoff bundle exists"],
    constraints: [],
    owner_id: "test",
    workspace_root: "/tmp/missing-handoff-guidance"
  });
  const failedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Recover from a settled attempt that never produced a handoff bundle.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );
  const degradedReason =
    "Execution failed before a settled handoff bundle was written, so recovery must rebuild from primary evidence.";
  const current = createCurrentDecision({
    run_id: run.id,
    latest_attempt_id: failedExecution.id,
    run_status: "waiting_steer",
    recommended_next_action: "wait_for_human",
    recommended_attempt_type: "execution",
    summary: degradedReason,
    blocking_reason: degradedReason,
    waiting_for_human: true
  });

  const guidance = deriveRunRecoveryGuidance({
    current,
    latestAttempt: failedExecution,
    latestHandoffBundle: null,
    latestHandoffBundleRef: null
  });

  assert.equal(guidance.path, "degraded_rebuild");
  assert.equal(guidance.attemptType, "research");
  assert.equal(guidance.nextAction, "continue_research");
  assert.equal(guidance.handoffBundleRef, null);
  assert.match(guidance.summary, /degraded \/ rebuild path/u);
  assert.match(guidance.blockingReason ?? "", /handoff bundle/u);
}

async function verifyRateLimitedExecutionRetriesQuickly(): Promise<void> {
  const { run, workspacePaths, rootDir, detachedRuntimeLayout } = await bootstrapRun(
    "rate-limited-execution-retry"
  );
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);

  const failedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Retry the same execution after a transient provider rate limit.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  await saveAttempt(workspacePaths, failedExecution);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: failedExecution.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: "Execution hit a transient provider limit.",
      blocking_reason: "ERROR: exceeded retry limit, last status: 429 Too Many Requests",
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedExecution.id,
      type: "attempt.failed",
      payload: {
        message: "ERROR: exceeded retry limit, last status: 429 Too Many Requests"
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new FastRetryExecutionAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 5_000,
      maxAutomaticResumeCycles: 2,
      providerRateLimitAutoResumeMs: 30,
      maxProviderRateLimitAutoResumeCycles: 4
    }
  );

  await wait(60);
  await settleUntil(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: (runStatus) => runStatus === "completed",
    timeoutMs: 60_000,
    delayMs: 120
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, false);
  assert.equal(current.run_status, "completed");
  assert.deepEqual(
    attempts.map((attempt) => attempt.attempt_type),
    ["execution", "execution"]
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["failed", "completed"]
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.auto_resume.scheduled" &&
        entry.payload.reason === "provider_rate_limited_retry_execution"
    ),
    "provider 429 should schedule a fast execution retry instead of waiting for human steer"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.blocked"),
    "provider 429 should not be treated as a manual blocker"
  );
}

async function verifyExecutionRateLimitBudgetDoesNotInheritResearchCycles(): Promise<void> {
  const { run, workspacePaths, rootDir, detachedRuntimeLayout } = await bootstrapRun(
    "execution-rate-limit-budget-does-not-inherit-research-cycles"
  );
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);

  const priorResearch = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "research",
      worker: "fake-codex",
      objective: "Seed earlier provider-limited research cycles.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );
  const failedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Retry execution after the provider recovers.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  await saveAttempt(workspacePaths, priorResearch);
  await saveAttempt(workspacePaths, failedExecution);
  for (let cycle = 1; cycle <= 4; cycle += 1) {
    await appendRunJournal(
      workspacePaths,
      createRunJournalEntry({
        run_id: run.id,
        attempt_id: priorResearch.id,
        type: "run.auto_resume.scheduled",
        payload: {
          cycle,
          next_action: "retry_attempt",
          attempt_type: "research",
          reason: "provider_rate_limited_retry_research"
        }
      })
    );
  }
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: failedExecution.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: "Execution hit a transient provider limit after prior research retries.",
      blocking_reason: "ERROR: exceeded retry limit, last status: 429 Too Many Requests",
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedExecution.id,
      type: "attempt.failed",
      payload: {
        message: "ERROR: exceeded retry limit, last status: 429 Too Many Requests"
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new FastRetryExecutionAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 5_000,
      maxAutomaticResumeCycles: 2,
      providerRateLimitAutoResumeMs: 30,
      maxProviderRateLimitAutoResumeCycles: 4
    }
  );

  await wait(60);
  await settleUntil(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: (runStatus) => runStatus === "completed",
    timeoutMs: 60_000,
    delayMs: 120
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);
  const executionSchedules = journal.filter(
    (entry) =>
      entry.type === "run.auto_resume.scheduled" &&
      entry.payload.reason === "provider_rate_limited_retry_execution"
  );

  assert.ok(current, "current decision must exist");
  assert.equal(current.run_status, "completed");
  assert.equal(
    executionSchedules.at(0)?.payload.cycle,
    1,
    "execution provider retry budget should start fresh instead of inheriting research cycles"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.exhausted"),
    "execution should not exhaust its retry budget just because research already consumed provider retries"
  );
}

async function verifyWorkerStalledExecutionRetriesQuickly(): Promise<void> {
  const { run, workspacePaths, rootDir, detachedRuntimeLayout } = await bootstrapRun(
    "worker-stalled-execution-retry"
  );
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);

  const failedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Retry the same execution after a stalled worker is terminated.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  const stallMessage = [
    "Codex CLI stalled for worker pid 4242.",
    "No runtime stdout activity arrived for 190000ms (stall window 180000ms).",
    "No live child command remained and no final output was written."
  ].join(" ");

  await saveAttempt(workspacePaths, failedExecution);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: failedExecution.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: "Execution worker stalled after verification finished.",
      blocking_reason: stallMessage,
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedExecution.id,
      type: "attempt.failed",
      payload: {
        message: stallMessage
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new FastRetryExecutionAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 5_000,
      workerStallAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await wait(60);
  await settleUntil(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: (runStatus) => runStatus === "completed",
    timeoutMs: 60_000,
    delayMs: 120
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, false);
  assert.equal(current.run_status, "completed");
  assert.deepEqual(
    attempts.map((attempt) => attempt.attempt_type),
    ["execution", "execution"]
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["failed", "completed"]
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.auto_resume.scheduled" &&
        entry.payload.reason === "worker_stalled_retry_execution"
    ),
    "stalled worker should schedule a fast execution retry instead of waiting for human steer"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.blocked"),
    "stalled worker should not be treated as a manual blocker"
  );
}

async function verifyWorkerStalledResearchRetriesQuickly(): Promise<void> {
  const { run, workspacePaths, detachedRuntimeLayout } = await bootstrapRun(
    "worker-stalled-research-retry"
  );

  const failedResearch = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "research",
      worker: "fake-codex",
      objective: "Retry the same research after a stalled worker is terminated.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  const stallMessage = [
    "Codex CLI stalled for worker pid 4343.",
    "No runtime stdout activity arrived for 190000ms (stall window 180000ms).",
    "No live child command remained and no final output was written."
  ].join(" ");

  await saveAttempt(workspacePaths, failedResearch);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: failedResearch.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "research",
      summary: "Research worker stalled before it could finish collecting evidence.",
      blocking_reason: stallMessage,
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedResearch.id,
      type: "attempt.failed",
      payload: {
        message: stallMessage
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new LowSignalResearchAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 5_000,
      workerStallAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await wait(60);
  await settleUntilSnapshot(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: ({ attempts, waitingForHuman }) =>
      attempts[1]?.status === "completed" && waitingForHuman === false,
    timeoutMs: 12_000,
    delayMs: 80
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, false);
  assert.deepEqual(
    attempts.slice(0, 2).map((attempt) => attempt.attempt_type),
    ["research", "research"]
  );
  assert.deepEqual(
    attempts.slice(0, 2).map((attempt) => attempt.status),
    ["failed", "completed"]
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.auto_resume.scheduled" &&
        entry.payload.reason === "worker_stalled_retry_research"
    ),
    "stalled research worker should schedule a fast retry instead of waiting for human steer"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.blocked"),
    "stalled research worker should not be treated as a manual blocker"
  );
}

async function verifySupersededSelfBootstrapRunDoesNotAutoResume(): Promise<void> {
  const { run, workspacePaths, detachedRuntimeLayout } = await bootstrapRun(
    "superseded-self-bootstrap-does-not-auto-resume",
    "AISA 自举下一步规划"
  );

  const failedResearch = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "research",
      worker: "fake-codex",
      objective: "Do not revive superseded self-bootstrap runs.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  const stallMessage = [
    "Codex CLI stalled for worker pid 5454.",
    "No runtime stdout activity arrived for 190000ms (stall window 180000ms).",
    "No live child command remained and no final output was written."
  ].join(" ");

  await saveAttempt(workspacePaths, failedResearch);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "running",
      latest_attempt_id: failedResearch.id,
      recommended_next_action: "retry_attempt",
      recommended_attempt_type: "research",
      summary: "Superseded self-bootstrap run was accidentally revived.",
      blocking_reason: `Current run was superseded by active self-bootstrap run run_active123. ${stallMessage}`,
      waiting_for_human: false
    })
  );
  await saveRunAutomationControl(
    workspacePaths,
    createRunAutomationControl({
      run_id: run.id,
      mode: "manual_only",
      reason_code: "superseded_self_bootstrap_run",
      reason: `Current run was superseded by active self-bootstrap run run_active123. ${stallMessage}`,
      imposed_by: "self-bootstrap-supervisor",
      active_run_id: "run_active123"
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedResearch.id,
      type: "attempt.failed",
      payload: {
        message: stallMessage
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.self_bootstrap.superseded",
      payload: {
        active_run_id: "run_active123",
        stopped_attempt_ids: [],
        pending_attempt_ids: []
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new NeverDispatchAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 30,
      workerStallAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await settle(orchestrator, {
    workspacePaths,
    runId: run.id,
    iterations: 6,
    delayMs: 40
  });

  const [current, attempts, journal, automation] = await Promise.all([
    getCurrentDecision(workspacePaths, run.id),
    listAttempts(workspacePaths, run.id),
    listRunJournal(workspacePaths, run.id),
    getRunAutomationControl(workspacePaths, run.id)
  ]);

  assert.ok(current, "current decision must exist");
  assert.equal(current.run_status, "waiting_steer");
  assert.equal(current.recommended_next_action, "wait_for_human");
  assert.equal(current.waiting_for_human, true);
  assert.equal(
    automation?.mode,
    "manual_only",
    "superseded self-bootstrap run should persist a manual-only automation gate"
  );
  assert.equal(attempts.length, 1, "superseded run should not create a retry attempt");
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.scheduled"),
    "superseded self-bootstrap run should not auto resume"
  );
}

async function verifyRateLimitedResearchRetriesQuickly(): Promise<void> {
  const { run, workspacePaths, detachedRuntimeLayout } = await bootstrapRun(
    "rate-limited-research-retry"
  );

  const failedResearch = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "research",
      worker: "fake-codex",
      objective: "Retry the same research after a transient provider rate limit.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  await saveAttempt(workspacePaths, failedResearch);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: failedResearch.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "research",
      summary: "Research hit a transient provider limit.",
      blocking_reason: "ERROR: exceeded retry limit, last status: 429 Too Many Requests",
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedResearch.id,
      type: "attempt.failed",
      payload: {
        message: "ERROR: exceeded retry limit, last status: 429 Too Many Requests"
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new LowSignalResearchAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 5_000,
      maxAutomaticResumeCycles: 2,
      providerRateLimitAutoResumeMs: 30,
      maxProviderRateLimitAutoResumeCycles: 4
    }
  );

  await wait(60);
  await settleUntilSnapshot(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: ({ attempts }) => attempts[1]?.status === "completed",
    timeoutMs: 12_000,
    delayMs: 80
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);

  assert.ok(current, "current decision must exist");
  assert.deepEqual(
    attempts.slice(0, 2).map((attempt) => attempt.attempt_type),
    ["research", "research"]
  );
  assert.deepEqual(
    attempts.slice(0, 2).map((attempt) => attempt.status),
    ["failed", "completed"]
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.auto_resume.scheduled" &&
        entry.payload.reason === "provider_rate_limited_retry_research"
    ),
    "provider 429 should schedule a fast research retry instead of blocking on human steer"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.blocked"),
    "provider 429 should not be treated as a manual blocker"
  );
}

async function verifyRateLimitedResearchRetriesUsingStdoutSignal(): Promise<void> {
  const { run, workspacePaths, detachedRuntimeLayout } = await bootstrapRun(
    "rate-limited-research-stdout-signal"
  );

  const failedResearch = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "research",
      worker: "fake-codex",
      objective: "Retry research after a provider rate limit hidden inside worker stdout.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  await saveAttempt(workspacePaths, failedResearch);
  await writeFile(
    resolveAttemptPaths(workspacePaths, run.id, failedResearch.id).stdoutFile,
    [
      '{"type":"turn.started"}',
      '{"type":"error","message":"exceeded retry limit, last status: 429 Too Many Requests"}',
      '{"type":"turn.failed","error":{"message":"exceeded retry limit, last status: 429 Too Many Requests"}}'
    ].join("\n"),
    "utf8"
  );
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: failedResearch.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "research",
      summary: "Research process exited unexpectedly.",
      blocking_reason:
        "Codex CLI exited with code 1 for attempt generic-failure auto resume exhausted.",
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedResearch.id,
      type: "attempt.failed",
      payload: {
        message: "Codex CLI exited with code 1 for attempt generic-failure"
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new LowSignalResearchAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 5_000,
      maxAutomaticResumeCycles: 2,
      providerRateLimitAutoResumeMs: 30,
      maxProviderRateLimitAutoResumeCycles: 4
    }
  );

  await wait(60);
  await settleUntilSnapshot(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: ({ attempts }) => attempts[1]?.status === "completed",
    timeoutMs: 12_000,
    delayMs: 80
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, false);
  assert.deepEqual(
    attempts.slice(0, 2).map((attempt) => attempt.status),
    ["failed", "completed"]
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.auto_resume.scheduled" &&
        entry.payload.reason === "provider_rate_limited_retry_research"
    ),
    "stdout 429 signal should schedule a fast research retry instead of generic human wait"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.exhausted"),
    "stdout 429 signal should not burn the generic auto-resume budget into exhaustion"
  );
}

async function verifyRuntimeSourceDriftBlocksAutoResume(): Promise<void> {
  const { run, workspacePaths, rootDir } = await bootstrapRun(
    "runtime-source-drift-blocks-auto-resume"
  );
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);
  const promotableRuntimeLayout = await createPromotableRuntimeLayout(
    "runtime-source-drift-blocks-auto-resume",
    rootDir,
    rootDir
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new RecoveryExecutionAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: promotableRuntimeLayout,
      waitingHumanAutoResumeMs: 30,
      runtimeSourceDriftAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  const completedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Resume the next execution step after restart.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  const restartMessage = [
    "Execution changed live runtime source files already loaded by the in-process control-api/orchestrator.",
    "Restart before the next dispatch. Affected files: packages/orchestrator/src/index.ts"
  ].join(" ");

  await saveAttempt(workspacePaths, completedExecution);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: completedExecution.id,
      recommended_next_action: "continue_execution",
      recommended_attempt_type: "execution",
      summary: restartMessage,
      blocking_reason: restartMessage,
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.completed",
      payload: {
        recommendation: "continue",
        goal_progress: 0.75,
        suggested_attempt_type: "execution"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.restart_required",
      payload: {
        reason: "runtime_source_drift",
        message: restartMessage,
        affected_files: ["packages/orchestrator/src/index.ts"]
      }
    })
  );

  await wait(40);
  await settle(orchestrator, {
    workspacePaths,
    runId: run.id,
    iterations: 6,
    delayMs: 80
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, true);
  assert.equal(current.run_status, "waiting_steer");
  assert.equal(current.recommended_next_action, "continue_execution");
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["completed"]
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.scheduled"),
    "runtime source drift should not auto-schedule the next attempt"
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.auto_resume.blocked" &&
        entry.payload.reason === "runtime_source_drift"
    ),
    "runtime source drift should leave an explicit automatic-resume blocker"
  );
}

async function verifyRuntimeSourceDriftAutoResumesAfterRestart(): Promise<void> {
  const { run, workspacePaths, rootDir } = await bootstrapRun(
    "runtime-source-drift-auto-resumes-after-restart"
  );
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);
  const promotableRuntimeLayout = await createPromotableRuntimeLayout(
    "runtime-source-drift-auto-resumes-after-restart",
    rootDir,
    rootDir
  );

  const completedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Resume execution after the runtime restarts.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  const restartMessage = [
    "Execution changed live runtime source files already loaded by the in-process control-api/orchestrator.",
    "Restart before the next dispatch. Affected files: packages/orchestrator/src/index.ts"
  ].join(" ");

  await saveAttempt(workspacePaths, completedExecution);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: completedExecution.id,
      recommended_next_action: "continue_execution",
      recommended_attempt_type: "execution",
      summary: restartMessage,
      blocking_reason: restartMessage,
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.completed",
      payload: {
        recommendation: "continue",
        goal_progress: 0.75,
        suggested_attempt_type: "execution"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.restart_required",
      payload: {
        reason: "runtime_source_drift",
        message: restartMessage,
        affected_files: ["packages/orchestrator/src/index.ts"]
      }
    })
  );

  await wait(40);
  const restartRequests: RuntimeRestartRequest[] = [];

  const orchestrator = new Orchestrator(
    workspacePaths,
    new RecoveryExecutionAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: promotableRuntimeLayout,
      requestRuntimeRestart: (request) => {
        restartRequests.push(request);
      },
      waitingHumanAutoResumeMs: 30,
      runtimeSourceDriftAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await settleUntil(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: (runStatus) => runStatus === "completed",
    timeoutMs: 75_000,
    delayMs: 120
  });
  {
    const deadline = Date.now() + 20_000;
    while (
      Date.now() < deadline &&
      !restartRequests.some((request) => request.reason === "runtime_promotion")
    ) {
      await wait(50);
    }
  }

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, false);
  assert.equal(current.run_status, "completed");
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["completed", "completed"]
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.auto_resume.scheduled" &&
        entry.payload.reason === "runtime_restarted_continue_execution"
    ),
    "runtime source drift should auto-resume quickly after a fresh restart"
  );
  assert.ok(
    journal.some((entry) => entry.type === "attempt.verification.passed"),
    "resumed execution should still pass runtime verification after restart"
  );
  assert.ok(
    restartRequests.some((request) => request.reason === "runtime_promotion"),
    "the resumed execution should still request a runtime promotion restart under supervision"
  );
}

async function verifyFailedAdversarialVerificationBlocksAutoResume(): Promise<void> {
  const { run, workspacePaths, rootDir, detachedRuntimeLayout } = await bootstrapRun(
    "failed-adversarial-verification-blocks-auto-resume"
  );
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);

  const completedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Stop automatic resume when adversarial verification fails.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  const failureReason =
    "Adversarial verification found a repeatable failure after runtime replay passed.";
  const runtimeVerification = {
    attempt_id: completedExecution.id,
    run_id: run.id,
    attempt_type: "execution" as const,
    status: "passed" as const,
    repo_root: rootDir,
    git_head: "autonomy-fixture",
    git_status: [],
    preexisting_git_status: [],
    new_git_status: ["?? execution-change.md"],
    changed_files: ["execution-change.md"],
    failure_class: null,
    failure_policy_mode: null,
    failure_code: null,
    failure_reason: null,
    command_results: [
      {
        purpose: "confirm the execution change was written",
        command:
          "test -f execution-change.md && rg -n '^execution change from' execution-change.md",
        cwd: rootDir,
        expected_exit_code: 0,
        exit_code: 0,
        passed: true,
        stdout_file: `runs/${run.id}/attempts/${completedExecution.id}/artifacts/runtime-verification/stdout.log`,
        stderr_file: `runs/${run.id}/attempts/${completedExecution.id}/artifacts/runtime-verification/stderr.log`
      }
    ],
    created_at: new Date().toISOString()
  };
  const adversarialVerification = createAttemptAdversarialVerification({
    run_id: run.id,
    attempt_id: completedExecution.id,
    attempt_type: "execution",
    status: "failed",
    verdict: "fail",
    summary: failureReason,
    failure_code: "verdict_fail",
    failure_reason: failureReason,
    checks: [
      {
        code: "non_happy_path",
        status: "failed",
        message: "Repeated execution produced the same adversarial failure."
      }
    ],
    commands: [
      {
        purpose: "rerun the adversarial probe",
        command: "pnpm verify:run-loop",
        cwd: rootDir,
        exit_code: 1,
        status: "failed",
        output_ref: null
      }
    ],
    output_refs: [],
    source_artifact_path: "artifacts/adversarial-verification.json"
  });

  await saveAttempt(workspacePaths, completedExecution);
  await saveAttemptRuntimeVerification(workspacePaths, runtimeVerification);
  await saveAttemptAdversarialVerification(workspacePaths, adversarialVerification);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      latest_attempt_id: completedExecution.id,
      run_status: "waiting_steer",
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: failureReason,
      blocking_reason: failureReason,
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.completed",
      payload: {
        recommendation: "wait_human",
        goal_progress: 0.5,
        suggested_attempt_type: "execution"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.verification.passed",
      payload: {
        status: "passed",
        failure_code: null,
        failure_reason: null,
        changed_files: ["execution-change.md"],
        command_count: 1,
        artifact_path: "artifacts/runtime-verification.json"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.adversarial_verification.failed",
      payload: {
        status: "failed",
        failure_code: adversarialVerification.failure_code,
        failure_reason: failureReason,
        failure_class: "adversarial_verification_failed",
        failure_policy_mode: "fail_closed",
        artifact_path: "artifacts/adversarial-verification.json"
      }
    })
  );
  await saveAttemptHandoffBundle(
    workspacePaths,
    createAttemptHandoffBundle({
      attempt: completedExecution,
      current_decision_snapshot: createCurrentDecision({
        run_id: run.id,
        latest_attempt_id: completedExecution.id,
        run_status: "waiting_steer",
        recommended_next_action: "wait_for_human",
        recommended_attempt_type: "execution",
        summary: failureReason,
        blocking_reason: failureReason,
        waiting_for_human: true
      }),
      runtime_verification: runtimeVerification,
      adversarial_verification: adversarialVerification,
      source_refs: {
        run_contract: `runs/${run.id}/contract.json`,
        attempt_meta: `runs/${run.id}/attempts/${completedExecution.id}/meta.json`,
        attempt_contract: null,
        preflight_evaluation: null,
        current_decision: `runs/${run.id}/current.json`,
        review_packet: `runs/${run.id}/attempts/${completedExecution.id}/review_packet.json`,
        runtime_verification: `runs/${run.id}/attempts/${completedExecution.id}/artifacts/runtime-verification.json`,
        adversarial_verification: `runs/${run.id}/attempts/${completedExecution.id}/artifacts/adversarial-verification.json`
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new AutoResumeExecutionAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await wait(40);
  await settle(orchestrator, {
    workspacePaths,
    runId: run.id,
    iterations: 8,
    delayMs: 80
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);
  const handoffBundle = await getAttemptHandoffBundle(
    workspacePaths,
    run.id,
    completedExecution.id
  );
  const blockedEntry = journal.find((entry) => entry.type === "run.auto_resume.blocked");

  assert.ok(current, "current decision must exist");
  assert.equal(current.run_status, "waiting_steer");
  assert.equal(current.waiting_for_human, true);
  assert.equal(current.recommended_next_action, "wait_for_human");
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["completed"],
    "failed adversarial verification should fail closed instead of spawning another execution"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.scheduled"),
    "failed adversarial verification should not schedule automatic resume"
  );
  assert.ok(handoffBundle, "expected a machine-readable handoff bundle");
  assert.equal(
    handoffBundle?.adversarial_failure_code,
    "verdict_fail",
    "handoff bundle should carry the adversarial failure code"
  );
  assert.equal(
    handoffBundle?.failure_code,
    "verdict_fail",
    "handoff bundle should expose the unified top-level adversarial failure code"
  );
  assert.equal(
    handoffBundle?.failure_class,
    "adversarial_verification_failed",
    "handoff bundle should expose the unified failure class"
  );
  assert.equal(
    handoffBundle?.source_refs.adversarial_verification,
    `runs/${run.id}/attempts/${completedExecution.id}/artifacts/adversarial-verification.json`,
    "handoff bundle should point at adversarial verification"
  );
  assert.ok(blockedEntry, "expected a machine-readable auto-resume blocker");
  assert.equal(blockedEntry?.payload.reason, "adversarial_verification_failed");
  assert.equal(blockedEntry?.payload.failure_code, "verdict_fail");
  assert.equal(
    blockedEntry?.payload.handoff_bundle_ref,
    `runs/${run.id}/attempts/${completedExecution.id}/artifacts/handoff_bundle.json`,
    "blocked auto-resume should point at the consumed handoff bundle"
  );
}

async function verifySchemaInvalidExecutionBlocksAutoResume(): Promise<void> {
  const { run, workspacePaths, rootDir, detachedRuntimeLayout } = await bootstrapRun(
    "schema-invalid-execution-blocks-auto-resume"
  );
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);

  const failedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Apply the planned execution step.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );
  const failureReason =
    "Worker writeback schema invalid at artifacts[0]: Expected object, received string";

  await saveAttempt(workspacePaths, failedExecution);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: failedExecution.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: failureReason,
      blocking_reason: failureReason,
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedExecution.id,
      type: "attempt.failed",
      payload: {
        message: failureReason
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new NeverDispatchAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await wait(40);
  await settle(orchestrator, {
    workspacePaths,
    runId: run.id,
    iterations: 8,
    delayMs: 80
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);
  const blockedEntry = journal.find((entry) => entry.type === "run.auto_resume.blocked");

  assert.ok(current, "current decision must exist");
  assert.equal(current.run_status, "waiting_steer");
  assert.equal(current.waiting_for_human, true);
  assert.equal(current.recommended_next_action, "wait_for_human");
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["failed"],
    "schema-invalid execution should fail closed instead of spawning another execution"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.scheduled"),
    "schema-invalid execution should not schedule automatic resume"
  );
  assert.ok(blockedEntry, "expected a machine-readable auto-resume blocker");
  assert.equal(blockedEntry?.payload.reason, "worker_output_schema_invalid");
  assert.equal(blockedEntry?.payload.failure_code, "worker_output_schema_invalid");
  assert.match(
    blockedEntry?.payload.message ?? "",
    /worker 输出不符合结果契约/u
  );
}

async function verifyVerifiedExecutionContinueDoesNotPauseForHuman(): Promise<void> {
  const { run, workspacePaths, rootDir, detachedRuntimeLayout } = await bootstrapRun(
    "verified-execution-continue-does-not-pause-for-human"
  );
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);

  const previousExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Seed the prior verified execution step.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );
  const previousExecutionArtifacts = await writeExecutionCompletionArtifacts(
    rootDir,
    previousExecution.id
  );

  await saveAttempt(workspacePaths, previousExecution);
  await saveAttemptResult(workspacePaths, run.id, previousExecution.id, {
    summary: "Previous verified execution already produced the next concrete step.",
    findings: [
      {
        type: "fact",
        content: "The previous execution step already left a reusable direction.",
        evidence: ["execution-change.md"]
      }
    ],
    questions: [],
    recommended_next_steps: ["Continue the verified execution mainline."],
    confidence: 0.9,
    artifacts: previousExecutionArtifacts
  });
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      best_attempt_id: previousExecution.id,
      latest_attempt_id: previousExecution.id,
      run_status: "running",
      recommended_next_action: "continue_execution",
      recommended_attempt_type: "execution",
      summary: "Continue the verified execution chain.",
      waiting_for_human: false
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new ContinuingExecutionAdapter() as never,
    undefined,
    60_000,
    {
      runtimeLayout: detachedRuntimeLayout,
      waitingHumanAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await settleUntilSnapshot(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: ({ attempts }) =>
      attempts.filter(
        (attempt) => attempt.id !== previousExecution.id && attempt.status === "completed"
      ).length >= 1,
    timeoutMs: 35_000,
    delayMs: 120
  });

  const attempts = await listAttempts(workspacePaths, run.id);
  const resumedExecution = [...attempts]
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .find((attempt) => attempt.id !== previousExecution.id && attempt.status === "completed");
  assert.ok(resumedExecution, "expected a resumed execution attempt to complete");

  const reviewPacket = await getAttemptReviewPacket(workspacePaths, run.id, resumedExecution.id);
  assert.ok(reviewPacket, "completed execution should leave a review packet");
  assert.ok(
    reviewPacket.current_decision_snapshot,
    "review packet should capture the settled current decision"
  );
  assert.equal(
    reviewPacket.current_decision_snapshot?.waiting_for_human,
    false,
    "verified execution continue should not force a human pause after two consecutive execution passes"
  );
  assert.equal(reviewPacket.current_decision_snapshot?.run_status, "running");
  assert.equal(
    reviewPacket.current_decision_snapshot?.recommended_next_action,
    "continue_execution"
  );
}

async function verifyCheckpointedRestartResetsAutoResumeBudget(): Promise<void> {
  const { run, workspacePaths, rootDir } = await bootstrapRun(
    "checkpointed-restart-resets-auto-resume-budget"
  );
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);

  const completedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Resume execution after a checkpointed restart.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  const restartMessage = [
    "Execution changed live runtime source files already loaded by the in-process control-api/orchestrator.",
    "Restart before the next dispatch. Affected files: packages/orchestrator/src/index.ts"
  ].join(" ");

  await saveAttempt(workspacePaths, completedExecution);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      latest_attempt_id: completedExecution.id,
      run_status: "waiting_steer",
      recommended_next_action: "continue_execution",
      recommended_attempt_type: "execution",
      summary: restartMessage,
      blocking_reason: restartMessage,
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "run.auto_resume.scheduled",
      payload: {
        cycle: 1,
        next_action: "continue_execution",
        attempt_type: "execution",
        reason: "runtime_restarted_continue_execution"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.completed",
      payload: {
        recommendation: "continue",
        goal_progress: 0.9,
        suggested_attempt_type: "execution"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.verification.passed",
      payload: {
        status: "passed",
        failure_code: null,
        failure_reason: null,
        changed_files: ["packages/orchestrator/src/index.ts"],
        command_count: 1,
        artifact_path: "artifacts/runtime-verification.json"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.checkpoint.created",
      payload: {
        commit_sha: "abc123",
        commit_message: "checkpoint",
        artifact_path: "artifacts/git-checkpoint.json"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.restart_required",
      payload: {
        reason: "runtime_source_drift",
        message: restartMessage,
        affected_files: ["packages/orchestrator/src/index.ts"]
      }
    })
  );

  await wait(40);
  const restartRequests: RuntimeRestartRequest[] = [];

  const orchestrator = new Orchestrator(
    workspacePaths,
    new RecoveryExecutionAdapter() as never,
    undefined,
    60_000,
    {
      requestRuntimeRestart: (request) => {
        restartRequests.push(request);
      },
      waitingHumanAutoResumeMs: 30,
      runtimeSourceDriftAutoResumeMs: 30,
      maxAutomaticResumeCycles: 1
    }
  );

  await settleUntil(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: (runStatus) => runStatus === "completed",
    timeoutMs: 90_000,
    delayMs: 120
  });
  await wait(50);

  const current = await getCurrentDecision(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);
  const restartSchedules = journal.filter(
    (entry) =>
      entry.type === "run.auto_resume.scheduled" &&
      entry.payload.reason === "runtime_restarted_continue_execution"
  );

  assert.ok(current, "current decision must exist");
  assert.equal(current.run_status, "completed");
  assert.equal(
    journal.filter((entry) => entry.type === "run.auto_resume.exhausted").length,
    0,
    "checkpointed success should reset the restart auto-resume budget"
  );
  assert.equal(restartSchedules.length, 2);
  assert.equal(
    restartSchedules.at(-1)?.payload.cycle,
    1,
    "restart auto-resume cycle numbering should reset after a verified checkpoint"
  );
  assert.ok(
    restartRequests.some((request) => request.reason === "runtime_promotion"),
    "checkpointed resume should still ask the supervisor to restart into the promoted runtime"
  );
}

async function main(): Promise<void> {
  const previousReviewers = process.env[REVIEWER_CONFIG_ENV];
  const previousSynthesizer = process.env[SYNTHESIZER_CONFIG_ENV];
  process.env[REVIEWER_CONFIG_ENV] = CLOSED_BASELINE_REVIEWERS_JSON;
  process.env[SYNTHESIZER_CONFIG_ENV] = CLOSED_BASELINE_SYNTHESIZER_JSON;
  try {
    const checks: Array<{ id: string; run: () => Promise<void> }> = [
      {
        id: "failed_execution_auto_resumes",
        run: verifyFailedExecutionAutoResumes
      },
      {
        id: "run_launch_resets_auto_resume_budget",
        run: verifyRunLaunchResetsAutoResumeBudget
      },
      {
        id: "repeated_auto_resume_exhausts",
        run: verifyRepeatedAutoResumeExhausts
      },
      {
        id: "checkpoint_blocker_auto_resumes_execution",
        run: verifyCheckpointBlockerAutoResumesIntoExecution
      },
      {
        id: "no_git_changes_blocks_auto_resume",
        run: verifyNoGitChangesBlocksAutoResume
      },
      {
        id: "preflight_blocked_execution_blocks_auto_resume",
        run: verifyPreflightBlockedExecutionBlocksAutoResume
      },
      {
        id: "rate_limited_execution_retries_quickly",
        run: verifyRateLimitedExecutionRetriesQuickly
      },
      {
        id: "execution_rate_limit_budget_does_not_inherit_research_cycles",
        run: verifyExecutionRateLimitBudgetDoesNotInheritResearchCycles
      },
      {
        id: "worker_stalled_execution_retries_quickly",
        run: verifyWorkerStalledExecutionRetriesQuickly
      },
      {
        id: "worker_stalled_research_retries_quickly",
        run: verifyWorkerStalledResearchRetriesQuickly
      },
      {
        id: "superseded_self_bootstrap_does_not_auto_resume",
        run: verifySupersededSelfBootstrapRunDoesNotAutoResume
      },
      {
        id: "rate_limited_research_retries_quickly",
        run: verifyRateLimitedResearchRetriesQuickly
      },
      {
        id: "rate_limited_research_retries_using_stdout_signal",
        run: verifyRateLimitedResearchRetriesUsingStdoutSignal
      },
      {
        id: "runtime_source_drift_blocks_auto_resume",
        run: verifyRuntimeSourceDriftBlocksAutoResume
      },
      {
        id: "runtime_source_drift_auto_resumes_after_restart",
        run: verifyRuntimeSourceDriftAutoResumesAfterRestart
      },
      {
        id: "failed_adversarial_verification_blocks_auto_resume",
        run: verifyFailedAdversarialVerificationBlocksAutoResume
      },
      {
        id: "schema_invalid_execution_blocks_auto_resume",
        run: verifySchemaInvalidExecutionBlocksAutoResume
      },
      {
        id: "verified_execution_continue_does_not_pause_for_human",
        run: verifyVerifiedExecutionContinueDoesNotPauseForHuman
      },
      {
        id: "checkpointed_restart_resets_auto_resume_budget",
        run: verifyCheckpointedRestartResetsAutoResumeBudget
      },
      {
        id: "recovery_auto_resumes_execution",
        run: verifyRecoveryAutoResumesExecution
      },
      {
        id: "low_reviewer_profile_blocks_settled_auto_resume",
        run: verifyLowReviewerProfileBlocksSettledAutoResume
      },
      {
        id: "missing_handoff_degrades_auto_resume_into_research",
        run: verifyMissingHandoffRecoveryGuidanceDegradesToResearch
      }
    ];
    const results: CaseResult[] = [];

    for (const check of checks) {
      try {
        await check.run();
        results.push({
          id: check.id,
          status: "pass"
        });
      } catch (error) {
        results.push({
          id: check.id,
          status: "fail",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const failed = results.filter((result) => result.status === "fail");
    console.log(
      JSON.stringify(
        {
          suite: "run-autonomy",
          passed: results.length - failed.length,
          failed: failed.length,
          results
        },
        null,
        2
      )
    );

    assert.equal(failed.length, 0, "Run autonomy verification failed.");
  } finally {
    await cleanupTrackedVerifyTempDirs();
    restoreEnv(REVIEWER_CONFIG_ENV, previousReviewers);
    restoreEnv(SYNTHESIZER_CONFIG_ENV, previousSynthesizer);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

await main();
