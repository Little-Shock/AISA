import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAttempt,
  createAttemptContract,
  createRun
} from "../packages/domain/src/index.ts";
import {
  ensureWorkspace,
  resolveAttemptPaths,
  resolveWorkspacePaths
} from "../packages/state-store/src/index.ts";
import {
  CodexCliWorkerAdapter,
  loadCodexCliConfig,
  prepareResearchShellGuard
} from "../packages/worker-adapters/src/index.ts";

async function runZshProbe(input: {
  env: NodeJS.ProcessEnv;
  script: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("zsh", ["-lc", input.script], {
      env: {
        ...process.env,
        ...input.env
      },
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
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

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
  const attemptContract = createAttemptContract({
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: "research",
    objective: attempt.objective,
    success_criteria: attempt.success_criteria,
    required_evidence: [
      "同目录重复初始化 research-shell 不报错",
      "pnpm 继续被 research-shell 阻断"
    ],
    forbidden_shortcuts: ["不要绕过 research-shell guard"],
    expected_artifacts: [
      "artifacts/runs/<run_id>/attempts/<attempt_id>/artifacts/research-shell/policy.json"
    ]
  });
  const attemptPaths = resolveAttemptPaths(workspacePaths, run.id, attempt.id);
  const firstGuard = await prepareResearchShellGuard({
    artifactsDir: attemptPaths.artifactsDir,
    baseEnv: process.env
  });
  const secondGuard = await prepareResearchShellGuard({
    artifactsDir: attemptPaths.artifactsDir,
    baseEnv: process.env
  });

  assert.equal(secondGuard.binDir, firstGuard.binDir);
  assert.deepEqual(secondGuard.allowedCommands, firstGuard.allowedCommands);
  assert.ok(secondGuard.allowedCommands.length > 0);
  assert.deepEqual(
    (await readdir(secondGuard.binDir)).sort(),
    [...new Set([...secondGuard.allowedCommands, ...secondGuard.blockedCommands])].sort()
  );

  const allowedProbe = await runZshProbe({
    env: secondGuard.env,
    script: "command -v ls"
  });
  assert.equal(allowedProbe.exitCode, 0);
  assert.equal(allowedProbe.stdout.trim(), join(secondGuard.binDir, "ls"));

  const unexpectedProbe = await runZshProbe({
    env: secondGuard.env,
    script: "command -v uname"
  });
  assert.notEqual(unexpectedProbe.exitCode, 0);
  assert.equal(unexpectedProbe.stdout.trim(), "");

  const blockedProbe = await runZshProbe({
    env: secondGuard.env,
    script: "pnpm"
  });
  assert.equal(blockedProbe.exitCode, 64);
  assert.match(blockedProbe.stderr, /AISA research mode blocks pnpm/);

  const adapter = new CodexCliWorkerAdapter({
    command: fakeCodex,
    sandbox: "read-only",
    skipGitRepoCheck: true
  });

  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(
      () =>
        adapter.runAttemptTask({
          run,
          attempt,
          attemptContract,
          context: {},
          workspacePaths
        }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /401 Unauthorized/);
        assert.match(message, /执行器错误输出：/);
        assert.doesNotMatch(message, /EEXIST/);
        return true;
      }
    );
  }

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
        research_shell_reentry: "passed",
        blocked_command_exit_code: blockedProbe.exitCode,
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
