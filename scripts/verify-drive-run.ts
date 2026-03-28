import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAttempt,
  createCurrentDecision,
  createRun,
  createRunJournalEntry,
  createRunSteer,
  type Attempt,
  type Run,
  type WorkerWriteback
} from "../packages/domain/src/index.ts";
import {
  appendRunJournal,
  ensureWorkspace,
  getAttemptContract,
  getAttemptResult,
  getCurrentDecision,
  getAttemptRuntimeVerification,
  listAttempts,
  listRunJournal,
  resolveAttemptPaths,
  resolveWorkspacePaths,
  saveAttempt,
  saveCurrentDecision,
  saveRun,
  saveRunSteer
} from "../packages/state-store/src/index.ts";
import { Orchestrator } from "../packages/orchestrator/src/index.ts";
import {
  captureAttemptCheckpointPreflight,
  maybeCreateVerifiedExecutionCheckpoint
} from "../packages/orchestrator/src/git-checkpoint.ts";
import { ensureRunManagedWorkspace } from "../packages/orchestrator/src/run-workspace.ts";
import { createDefaultRunWorkspaceScopePolicy } from "../packages/orchestrator/src/workspace-scope.ts";
import {
  assertDriveRunReachedStableStop,
  driveRun,
  resolveSandboxForAttempt
} from "./drive-run.ts";
import {
  buildAttemptModeRules,
  prepareResearchShellGuard
} from "../packages/worker-adapters/src/index.ts";

class ProgressingAdapter {
  readonly type = "fake-codex";
  private researchPassCount = 0;

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (input.attempt.attempt_type === "research") {
      this.researchPassCount += 1;

      if (this.researchPassCount === 1) {
        return {
          writeback: {
            summary:
              "Research found the next concrete backend step but is still missing a replayable execution contract.",
            findings: [
              {
                type: "fact",
                content: "Runtime loop can now be driven locally.",
                evidence: ["scripts/drive-run.ts"]
              }
            ],
            questions: [],
            recommended_next_steps: ["Implement the smallest execution change next."],
            confidence: 0.8,
            artifacts: []
          },
          reportMarkdown: "# research",
          exitCode: 0
        };
      }

      if (this.researchPassCount === 2) {
        return {
          writeback: {
            summary:
              "Research locked the next execution step behind a replayable execution contract.",
            findings: [
              {
                type: "fact",
                content: "The next execution step is grounded and replayable.",
                evidence: ["scripts/verify-drive-run.ts", "execution-note.md"]
              }
            ],
            questions: [],
            recommended_next_steps: ["Implement the smallest execution change next."],
            confidence: 0.84,
            next_attempt_contract: {
              attempt_type: "execution",
              objective: "Implement the smallest execution change next.",
              success_criteria: [
                "Write execution-note.md and leave replayable verification evidence."
              ],
              required_evidence: [
                "Leave git-visible workspace changes tied to the objective.",
                "Pass a replayable verification command that proves execution-note.md was written."
              ],
              forbidden_shortcuts: [
                "Do not claim execution success without replaying the locked verification command."
              ],
              expected_artifacts: ["execution-note.md"],
              verification_plan: {
                commands: [
                  {
                    purpose: "confirm the execution note was written",
                    command: 'test -f execution-note.md && rg -n "^checkpointed by att_" execution-note.md'
                  }
                ]
              }
            },
            artifacts: []
          },
          reportMarkdown: "# research",
          exitCode: 0
        };
      }

      throw new Error("Unexpected extra research pass in verify-drive-run.");
    }

    assert.equal(
      this.researchPassCount,
      2,
      "execution should only start after research leaves a replayable contract"
    );

    await writeFile(
      join(input.attempt.workspace_root, "execution-note.md"),
      `checkpointed by ${input.attempt.id}\n`,
      "utf8"
    );

    return {
      writeback: {
        summary: "Execution finished with a verification artifact.",
        findings: [
          {
            type: "fact",
            content: "Execution completed and left traceable evidence.",
            evidence: ["execution-note.md"]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.86,
        artifacts: [
          {
            type: "patch",
            path: "artifacts/demo.patch"
          }
        ]
      },
      reportMarkdown: "# execution",
      exitCode: 0
    };
  }
}

async function main(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-drive-run-"));
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);
  await initializeGitRepo(rootDir);
  await verifyManagedWorkspaceCheckpointCatchesUpDirtyBaseline();

  const run = createRun({
    title: "Drive a self-bootstrap run locally",
    description: "Verify the local driver can advance a run to the next stable decision.",
    success_criteria: ["Advance from research to execution-ready state."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: rootDir
  });
  const current = createCurrentDecision({
    run_id: run.id,
    run_status: "running",
    recommended_next_action: "start_first_attempt",
    recommended_attempt_type: "research",
    summary: "Bootstrapped for local driver verification."
  });
  const steer = createRunSteer({
    run_id: run.id,
    content: "Stay on backend/runtime work and stop once the next step is clear."
  });

  await saveRun(workspacePaths, run);
  await saveCurrentDecision(workspacePaths, current);
  await saveRunSteer(workspacePaths, steer);
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

  const adapter = new ProgressingAdapter();
  const firstStableStop = await settleFirstResearchAttempt({
    workspacePaths,
    runId: run.id,
    adapter
  });

  assert.equal(
    firstStableStop.current?.run_status,
    "running"
  );
  assert.equal(
    firstStableStop.current?.recommended_next_action,
    "continue_research",
    "research without a replayable contract must keep the loop in research"
  );
  assert.equal(
    firstStableStop.current?.recommended_attempt_type,
    "research",
    "missing execution contract should block execution dispatch"
  );
  assert.match(
    firstStableStop.current?.blocking_reason ?? "",
    /Need a replayable execution contract before the loop can start an execution attempt\./,
    "first stop should explain that execution is blocked on a replayable contract"
  );
  assert.deepEqual(
    firstStableStop.attempts.map((attempt) => attempt.attempt_type),
    ["research"],
    "local drive-run should not create an execution attempt before the contract is ready"
  );

  const secondStop = await driveRun({
    workspaceRoot: rootDir,
    runId: run.id,
    adapter: adapter as never,
    pollIntervalMs: 50,
    maxPolls: 200
  });

  const checkpointEntry = await waitForCheckpointEntry(workspacePaths, run.id);
  const persistedCurrent = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const orderedAttempts = [...attempts].sort((left, right) =>
    left.created_at.localeCompare(right.created_at)
  );
  const executionAttempts = attempts.filter((attempt) => attempt.attempt_type === "execution");
  const researchAttempts = orderedAttempts.filter((attempt) => attempt.attempt_type === "research");
  const [firstResearchAttempt, secondResearchAttempt] = researchAttempts;
  assert.ok(firstResearchAttempt, "first research attempt should be persisted");
  assert.ok(secondResearchAttempt, "second research attempt should persist the execution contract");
  const executionAttempt = attempts.find((attempt) => attempt.id === checkpointEntry.attempt_id);
  assert.ok(executionAttempt, "checkpoint entry should point to a persisted attempt");
  assert.equal(executionAttempt.attempt_type, "execution");
  const [firstResearchResult, secondResearchResult, executionAttemptContract] = await Promise.all([
    getAttemptResult(workspacePaths, run.id, firstResearchAttempt.id),
    getAttemptResult(workspacePaths, run.id, secondResearchAttempt.id),
    getAttemptContract(workspacePaths, run.id, executionAttempt.id)
  ]);
  const runtimeVerification = await getAttemptRuntimeVerification(
    workspacePaths,
    run.id,
    executionAttempt.id
  );
  assert.ok(runtimeVerification, "execution attempt should persist runtime verification evidence");
  assert.equal(
    firstResearchResult?.next_attempt_contract,
    undefined,
    "first research attempt should not leave an execution contract"
  );
  assert.ok(
    secondResearchResult?.next_attempt_contract,
    "second research attempt should leave a replayable execution contract"
  );
  assert.equal(secondResearchResult?.next_attempt_contract?.attempt_type, "execution");
  assert.ok(executionAttemptContract, "execution attempt should persist the promoted contract");
  assert.equal(
    executionAttempt.objective,
    secondResearchResult?.next_attempt_contract?.objective,
    "execution should consume the research-provided contract objective"
  );
  assert.deepEqual(
    executionAttemptContract?.verification_plan,
    secondResearchResult?.next_attempt_contract?.verification_plan,
    "execution should keep the replayable verification plan from research"
  );
  const checkpointArtifact = String(checkpointEntry.payload.artifact_path);
  await waitForFile(checkpointArtifact);
  const checkpoint = JSON.parse(await readFile(checkpointArtifact, "utf8")) as {
    status: string;
    commit: {
      sha: string;
      message: string;
      changed_files: string[];
    };
  };
  const executionWorkspaceRoot = executionAttempt.workspace_root;
  const latestCommitSubject = (
    await runCommand(executionWorkspaceRoot, [
      "git",
      "-C",
      executionWorkspaceRoot,
      "log",
      "-1",
      "--format=%s"
    ])
  ).stdout.trim();
  const gitStatusAfterCheckpoint = (
    await runCommand(executionWorkspaceRoot, [
      "git",
      "-C",
      executionWorkspaceRoot,
      "status",
      "--porcelain=v1"
    ])
  ).stdout.trim();
  assert.equal(secondStop.stopReason, "run_settled");
  assert.doesNotThrow(() => assertDriveRunReachedStableStop(secondStop));
  assert.equal(persistedCurrent?.run_status, "completed");
  assert.equal(executionAttempts.length, 1);
  assert.equal(researchAttempts.length, 2);
  assert.ok(
    attempts.every((attempt) => attempt.status === "completed"),
    "all recorded attempts should be completed by the settled stop"
  );
  assert.equal(runtimeVerification.status, "passed");
  assert.equal(runtimeVerification.command_results.length, 1);
  assert.deepEqual(runtimeVerification.changed_files, ["execution-note.md"]);
  assert.equal(checkpointEntry.attempt_id, executionAttempt.id);
  assert.equal(checkpoint.status, "created");
  assert.equal(latestCommitSubject, checkpoint.commit.message);
  assert.equal(gitStatusAfterCheckpoint, "");
  assert.match(checkpoint.commit.message, new RegExp(run.id));
  assert.match(checkpoint.commit.message, new RegExp(executionAttempt.id));
  assert.deepEqual(checkpoint.commit.changed_files, ["execution-note.md"]);

  assert.equal(resolveSandboxForAttempt("read-only", "research"), "read-only");
  assert.equal(resolveSandboxForAttempt("read-only", "execution"), "workspace-write");
  assert.equal(
    resolveSandboxForAttempt("danger-full-access", "execution"),
    "danger-full-access"
  );
  assert.throws(
    () =>
      assertDriveRunReachedStableStop({
        run,
        stopReason: "max_polls_exhausted"
      }),
    /did not reach a stable stop/
  );

  const researchRules = buildAttemptModeRules("research");
  const executionRules = buildAttemptModeRules("execution");
  assert.ok(
    researchRules.some((line) => line.includes("Do not run package scripts, tsx")),
    "research mode should forbid heavy script execution"
  );
  assert.ok(
    researchRules.some((line) =>
      line.includes("next_attempt_contract with replayable verification commands")
    ),
    "research mode should require a replayable contract before execution"
  );
  assert.ok(
    executionRules.some((line) => line.includes("You may modify files")),
    "execution mode should allow workspace changes"
  );

  const shellGuard = await prepareResearchShellGuard({
    artifactsDir: join(rootDir, "guard-check"),
    baseEnv: process.env
  });
  assert.ok(shellGuard.allowedCommands.includes("rg"));
  assert.ok(shellGuard.blockedCommands.includes("pnpm"));

  const blockedShell = await runShell(shellGuard.env, "pnpm --version");
  assert.equal(blockedShell.exitCode, 64);
  assert.match(blockedShell.stderr, /AISA research mode blocks pnpm/);

  const allowedShell = await runShell(
    shellGuard.env,
    "command -v rg >/dev/null && rg --version >/dev/null"
  );
  assert.equal(allowedShell.exitCode, 0);

  console.log(
    JSON.stringify(
      {
        run_id: run.id,
        first_stop_next_action: firstStableStop.current?.recommended_next_action ?? null,
        first_stop_blocking_reason: firstStableStop.current?.blocking_reason ?? null,
        stop_reason: secondStop.stopReason,
        attempt_types: attempts.map((attempt) => attempt.attempt_type),
        research_attempt_count: researchAttempts.length,
        execution_attempt_count: executionAttempts.length,
        run_status: persistedCurrent?.run_status ?? null
      },
      null,
      2
    )
  );
}

async function verifyManagedWorkspaceCheckpointCatchesUpDirtyBaseline(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-managed-checkpoint-"));
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);
  await initializeGitRepo(rootDir);

  const seededRun = createRun({
    title: "Managed workspace checkpoint catch-up",
    description:
      "Verify a managed run workspace can checkpoint verified progress even when it starts dirty.",
    success_criteria: ["Create a checkpoint that absorbs preexisting managed-workspace changes."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: rootDir
  });
  const managedRun = await ensureRunManagedWorkspace({
    run: seededRun,
    policy: createDefaultRunWorkspaceScopePolicy(rootDir)
  });
  assert.ok(
    managedRun.managed_workspace_root,
    "managed workspace checkpoint test should provision an isolated worktree"
  );
  await saveRun(workspacePaths, managedRun);

  const attempt = createAttempt({
    run_id: managedRun.id,
    attempt_type: "execution",
    worker: "fake-codex",
    objective: "Checkpoint the managed workspace after verification passes.",
    success_criteria: ["Create a checkpoint commit that leaves the worktree clean."],
    workspace_root: managedRun.managed_workspace_root
  });
  await saveAttempt(workspacePaths, attempt);

  const attemptPaths = resolveAttemptPaths(workspacePaths, managedRun.id, attempt.id);
  await writeFile(
    join(managedRun.managed_workspace_root, "preexisting-note.md"),
    "left dirty from a prior verified attempt\n",
    "utf8"
  );

  const preflight = await captureAttemptCheckpointPreflight({
    attempt,
    attemptPaths
  });
  assert.equal(preflight?.status, "ready");
  assert.ok(
    preflight?.status_before.some((line) => line.includes("preexisting-note.md")),
    "managed workspace preflight should capture the preexisting dirty file"
  );

  await writeFile(
    join(managedRun.managed_workspace_root, "execution-note.md"),
    `checkpointed by ${attempt.id}\n`,
    "utf8"
  );

  const checkpointOutcome = await maybeCreateVerifiedExecutionCheckpoint({
    run: managedRun,
    attempt,
    evaluation: {
      attempt_id: attempt.id,
      run_id: managedRun.id,
      goal_progress: 0.9,
      evidence_quality: 0.9,
      verification_status: "passed",
      recommendation: "continue",
      suggested_attempt_type: "execution",
      rationale: "Verification passed and should create a checkpoint.",
      missing_evidence: [],
      review_input_packet_ref: null,
      opinion_refs: [],
      evaluation_synthesis_ref: null,
      synthesis_strategy: "legacy_single_judge",
      synthesizer: null,
      reviewer_count: 0,
      created_at: new Date().toISOString()
    },
    attemptPaths,
    preflight
  });

  assert.equal(
    checkpointOutcome.status,
    "created",
    "managed workspaces should checkpoint verified progress instead of staying blocked forever"
  );

  const checkpoint = JSON.parse(await readFile(checkpointOutcome.artifact_path, "utf8")) as {
    status: string;
    message: string;
    includes_preexisting_changes?: boolean;
    preexisting_status_before?: string[];
    commit: {
      changed_files: string[];
    };
  };
  const gitStatusAfterCheckpoint = (
    await runCommand(managedRun.managed_workspace_root, [
      "git",
      "-C",
      managedRun.managed_workspace_root,
      "status",
      "--porcelain=v1"
    ])
  ).stdout.trim();

  assert.equal(checkpoint.status, "created");
  assert.equal(gitStatusAfterCheckpoint, "");
  assert.equal(
    checkpoint.includes_preexisting_changes,
    true,
    "checkpoint artifact should record that it absorbed preexisting managed-workspace changes"
  );
  assert.ok(
    checkpoint.preexisting_status_before?.some((line) => line.includes("preexisting-note.md")),
    "checkpoint artifact should preserve the preflight dirty status"
  );
  assert.deepEqual(
    [...checkpoint.commit.changed_files].sort(),
    ["execution-note.md", "preexisting-note.md"],
    "catch-up checkpoint should commit both the carried-over dirty file and the new execution delta"
  );
}

async function settleFirstResearchAttempt(input: {
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  runId: string;
  adapter: ProgressingAdapter;
}): Promise<{
  current: Awaited<ReturnType<typeof getCurrentDecision>>;
  attempts: Awaited<ReturnType<typeof listAttempts>>;
}> {
  const orchestrator = new Orchestrator(
    input.workspacePaths,
    input.adapter as never,
    undefined,
    10
  );

  await orchestrator.tick();
  const [createdAttempt] = await listAttempts(input.workspacePaths, input.runId);
  assert.ok(createdAttempt, "first research attempt should be created on the first tick");
  assert.equal(createdAttempt.attempt_type, "research");

  await orchestrator.tick();
  await waitForAttemptCompletion(input.workspacePaths, input.runId, createdAttempt.id);
  const current = await waitForStableDecisionForAttempt(
    input.workspacePaths,
    input.runId,
    createdAttempt.id
  );
  const attempts = await listAttempts(input.workspacePaths, input.runId);

  return {
    current,
    attempts
  };
}

async function runShell(
  env: NodeJS.ProcessEnv,
  command: string
): Promise<{
  exitCode: number;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/zsh", ["-lc", command], {
      env,
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
      resolve({
        exitCode: code ?? 1,
        stderr
      });
    });
  });
}

async function initializeGitRepo(rootDir: string): Promise<void> {
  await writeFile(
    join(rootDir, ".gitignore"),
    ["runs/", "state/", "events/", "artifacts/", "reports/", "plans/"].join("\n") + "\n",
    "utf8"
  );
  await writeFile(join(rootDir, "README.md"), "# temp repo\n", "utf8");

  await runCommand(rootDir, ["git", "-C", rootDir, "init"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "config", "user.name", "AISA Test"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "config", "user.email", "aisa-test@example.com"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "add", "."]);
  await runCommand(rootDir, ["git", "-C", rootDir, "commit", "-m", "test: seed repo"]);
}

async function runCommand(
  cwd: string,
  args: string[]
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const [command, ...commandArgs] = args;
    const child = spawn(command!, commandArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        reject(new Error(stderr || `Command failed: ${args.join(" ")}`));
        return;
      }

      resolve({
        exitCode,
        stdout,
        stderr
      });
    });
  });
}

async function waitForCheckpointEntry(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string
) {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const journal = await listRunJournal(workspacePaths, runId);
    const checkpointEntry = journal.find((entry) => entry.type === "attempt.checkpoint.created");

    if (checkpointEntry) {
      return checkpointEntry;
    }

    await sleep(10);
  }

  throw new Error(`Timed out waiting for checkpoint journal entry for run ${runId}`);
}

async function waitForAttemptCompletion(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string,
  attemptId: string
): Promise<void> {
  const deadline = Date.now() + 1_500;

  while (Date.now() < deadline) {
    const attempts = await listAttempts(workspacePaths, runId);
    const attempt = attempts.find((candidate) => candidate.id === attemptId);

    if (attempt?.status === "completed") {
      return;
    }

    if (attempt && ["failed", "stopped"].includes(attempt.status)) {
      throw new Error(`Attempt ${attemptId} settled unexpectedly with status ${attempt.status}`);
    }

    await sleep(10);
  }

  throw new Error(`Timed out waiting for attempt ${attemptId} to complete`);
}

async function waitForStableDecisionForAttempt(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string,
  attemptId: string
) {
  const deadline = Date.now() + 1_500;

  while (Date.now() < deadline) {
    const current = await getCurrentDecision(workspacePaths, runId);
    if (
      current?.latest_attempt_id === attemptId &&
      current.recommended_next_action !== "attempt_running"
    ) {
      return current;
    }

    await sleep(10);
  }

  throw new Error(`Timed out waiting for stable decision after attempt ${attemptId}`);
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 1500;

  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await sleep(10);
    }
  }

  throw new Error(`Timed out waiting for file ${filePath}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
