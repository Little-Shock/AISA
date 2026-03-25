import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
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
    pollIntervalMs: 5,
    maxPolls: 20,
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
    pollIntervalMs: 5,
    maxPolls: 20
  });

  const persistedCurrent = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);

  assert.equal(secondStop.stopReason, "run_settled");
  assert.doesNotThrow(() => assertDriveRunReachedStableStop(secondStop));
  assert.equal(persistedCurrent?.run_status, "completed");
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map((attempt) => attempt.attempt_type),
    ["research", "execution"]
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["completed", "completed"]
  );

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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
