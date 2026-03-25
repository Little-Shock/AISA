import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
  getCurrentDecision,
  listAttempts,
  listRunJournal,
  resolveWorkspacePaths,
  saveCurrentDecision,
  saveRun,
  saveRunSteer
} from "../packages/state-store/src/index.ts";
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

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (input.attempt.attempt_type === "research") {
      return {
        writeback: {
          summary: "Research found the next concrete backend step.",
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

    await writeFile(
      join(input.run.workspace_root, "execution-note.md"),
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
            evidence: ["runs/demo/result.json"]
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

  const firstStop = await driveRun({
    workspaceRoot: rootDir,
    runId: run.id,
    adapter: new ProgressingAdapter() as never,
    pollIntervalMs: 10,
    maxPolls: 200,
    stopAfterCompletedAttempts: 1
  });

  assert.equal(firstStop.stopReason, "completed_attempt_limit");
  assert.equal(firstStop.completedAttemptCount, 1);
  assert.equal(firstStop.current?.run_status, "running");
  assert.ok(
    ["start_execution", "attempt_running"].includes(
      firstStop.current?.recommended_next_action ?? ""
    ),
    "first stop should either be ready to start execution or already running it"
  );
  assert.doesNotThrow(() => assertDriveRunReachedStableStop(firstStop));

  const secondStop = await driveRun({
    workspaceRoot: rootDir,
    runId: run.id,
    adapter: new ProgressingAdapter() as never,
    pollIntervalMs: 10,
    maxPolls: 200
  });

  const checkpointEntry = await waitForCheckpointEntry(workspacePaths, run.id);
  const persistedCurrent = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const executionAttempts = attempts.filter((attempt) => attempt.attempt_type === "execution");
  const researchAttempts = attempts.filter((attempt) => attempt.attempt_type === "research");
  const executionAttempt = attempts.find((attempt) => attempt.id === checkpointEntry.attempt_id);
  assert.ok(executionAttempt, "checkpoint entry should point to a persisted attempt");
  assert.equal(executionAttempt.attempt_type, "execution");
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
  const latestCommitSubject = (
    await runCommand(rootDir, [
      "git",
      "-C",
      rootDir,
      "log",
      "-1",
      "--format=%s"
    ])
  ).stdout.trim();
  const gitStatusAfterCheckpoint = (
    await runCommand(rootDir, ["git", "-C", rootDir, "status", "--porcelain=v1"])
  ).stdout.trim();
  assert.equal(secondStop.stopReason, "run_settled");
  assert.doesNotThrow(() => assertDriveRunReachedStableStop(secondStop));
  assert.equal(persistedCurrent?.run_status, "completed");
  assert.equal(executionAttempts.length, 1);
  assert.ok(
    researchAttempts.length >= 1,
    "drive-run should complete at least one research attempt before execution"
  );
  assert.ok(
    attempts.every((attempt) => attempt.status === "completed"),
    "all recorded attempts should be completed by the settled stop"
  );
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
    researchRules.some((line) => line.includes("recommend it as the next execution attempt")),
    "research mode should hand command-based verification to execution"
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
        stop_reason: secondStop.stopReason,
        attempt_types: attempts.map((attempt) => attempt.attempt_type),
        run_status: persistedCurrent?.run_status ?? null
      },
      null,
      2
    )
  );
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
  const deadline = Date.now() + 1500;

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
