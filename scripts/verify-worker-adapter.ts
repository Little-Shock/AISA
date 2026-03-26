import assert from "node:assert/strict";
import { mkdtemp, chmod, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttempt, createRun } from "../packages/domain/src/index.ts";
import {
  ensureWorkspace,
  resolveAttemptPaths,
  resolveWorkspacePaths
} from "../packages/state-store/src/index.ts";
import {
  CodexCliWorkerAdapter,
  loadCodexCliConfig
} from "../packages/worker-adapters/src/index.ts";

async function main(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-worker-adapter-"));
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);

  const fakeCodex = join(rootDir, "fake-codex.sh");
  await writeFile(
    fakeCodex,
    [
      "#!/bin/sh",
      "echo \"unexpected status 401 Unauthorized: invalid token\" >&2",
      "exit 1"
    ].join("\n"),
    "utf8"
  );
  await chmod(fakeCodex, 0o755);

  const run = createRun({
    title: "Surface worker stderr",
    description: "Verify adapter failures preserve the worker error detail.",
    success_criteria: ["Show the worker error message in the failure."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: rootDir
  });
  const attempt = createAttempt({
    run_id: run.id,
    attempt_type: "research",
    worker: "codex",
    objective: "Inspect the repository without running blocked commands.",
    success_criteria: run.success_criteria,
    workspace_root: rootDir
  });

  const adapter = new CodexCliWorkerAdapter({
    command: fakeCodex,
    sandbox: "read-only",
    skipGitRepoCheck: true
  });

  await assert.rejects(
    () =>
      adapter.runAttemptTask({
        run,
        attempt,
        context: {},
        workspacePaths
      }),
    (error: unknown) => {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /401 Unauthorized/
      );
      assert.match(
        error instanceof Error ? error.message : String(error),
        /执行器错误输出：/
      );
      return true;
    }
  );

  const attemptPaths = resolveAttemptPaths(workspacePaths, run.id, attempt.id);
  const prompt = await readFile(join(attemptPaths.attemptDir, "worker-prompt.md"), "utf8");
  assert.match(
    prompt,
    /Write all user-facing natural language fields in concise Chinese\./
  );
  assert.match(
    prompt,
    /Keep JSON keys, enum-like machine values, file paths, shell commands, and evidence strings stable/
  );

  const loadedConfig = loadCodexCliConfig({
    CODEX_CLI_COMMAND: "codex-test",
    CODEX_SANDBOX: "workspace-write",
    CODEX_MODEL: "gpt-5.4",
    CODEX_SKIP_GIT_REPO_CHECK: "false",
    CODEX_TIMEOUT_MS: "1"
  });
  assert.deepEqual(loadedConfig, {
    command: "codex-test",
    model: "gpt-5.4",
    profile: undefined,
    sandbox: "workspace-write",
    skipGitRepoCheck: false
  });

  console.log(
    JSON.stringify(
      {
        run_id: run.id,
        attempt_id: attempt.id,
        status: "passed"
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
