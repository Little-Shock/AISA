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

async function createFakeCodexScript(input: {
  rootDir: string;
  fileName: string;
  exitCode?: number;
  stderrMessage?: string;
  jsonPayload?: string;
}): Promise<string> {
  const scriptPath = join(input.rootDir, input.fileName);
  const lines =
    input.jsonPayload !== undefined
      ? [
          "#!/bin/sh",
          "OUTPUT=\"\"",
          "while [ \"$#\" -gt 0 ]; do",
          "  if [ \"$1\" = \"--output-last-message\" ]; then",
          "    OUTPUT=\"$2\"",
          "    shift 2",
          "    continue",
          "  fi",
          "  shift",
          "done",
          "cat >/dev/null",
          "if [ -z \"$OUTPUT\" ]; then",
          "  echo \"missing --output-last-message\" >&2",
          "  exit 2",
          "fi",
          "cat <<'EOF' > \"$OUTPUT\"",
          input.jsonPayload,
          "EOF",
          `exit ${input.exitCode ?? 0}`
        ]
      : [
          "#!/bin/sh",
          "cat >/dev/null",
          `echo ${JSON.stringify(
            input.stderrMessage ?? "unexpected status 401 Unauthorized: invalid token"
          )} >&2`,
          `exit ${input.exitCode ?? 1}`
        ];

  await writeFile(scriptPath, lines.join("\n"), "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

function createExecutionAttemptFixture(input: {
  runId: string;
  workspaceRoot: string;
  objective: string;
}): {
  attempt: ReturnType<typeof createAttempt>;
  attemptContract: ReturnType<typeof createAttemptContract>;
} {
  const attempt = createAttempt({
    run_id: input.runId,
    attempt_type: "execution",
    worker: "codex",
    objective: input.objective,
    success_criteria: ["留下回放验证证据"],
    workspace_root: input.workspaceRoot
  });

  return {
    attempt,
    attemptContract: createAttemptContract({
      attempt_id: attempt.id,
      run_id: input.runId,
      attempt_type: attempt.attempt_type,
      objective: attempt.objective,
      success_criteria: attempt.success_criteria,
      required_evidence: [
        "git-visible workspace changes",
        "a replayable verification command that checks the changed behavior"
      ],
      forbidden_shortcuts: ["不要把坏写回伪装成成功"],
      expected_artifacts: ["changed files visible in git"],
      verification_plan: {
        commands: [
          {
            purpose: "verify the changed behavior",
            command: "test -n malformed-writeback-guard"
          }
        ]
      }
    })
  };
}

async function runZshProbe(input: {
  env: NodeJS.ProcessEnv;
  script: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/zsh", ["-lc", input.script], {
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

  const fakeCodex = await createFakeCodexScript({
    rootDir,
    fileName: "fake-codex-stderr.sh"
  });

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
    baseEnv: {
      ...process.env,
      PATH: firstGuard.binDir
    }
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

  const invalidFindingPayload = JSON.stringify(
    {
      summary: "坏 finding 类型不该被吞掉。",
      findings: [
        {
          type: "gap",
          content: "返回了未定义的 finding type。",
          evidence: ["git status --short"]
        }
      ],
      questions: [],
      recommended_next_steps: [],
      confidence: 0.31,
      verification_plan: {
        commands: [
          {
            purpose: "verify the changed behavior",
            command: "test -n malformed-writeback-guard"
          }
        ]
      },
      artifacts: [
        {
          type: "patch",
          path: "runs/<run_id>/attempts/<attempt_id>/artifacts/diff.patch"
        }
      ]
    },
    null,
    2
  );
  const invalidArtifactsPayload = JSON.stringify(
    {
      summary: "字符串 artifacts 不该被吞掉。",
      findings: [
        {
          type: "fact",
          content: "已经拿到了一个路径。",
          evidence: ["git diff --stat"]
        }
      ],
      questions: [],
      recommended_next_steps: [],
      confidence: 0.34,
      verification_plan: {
        commands: [
          {
            purpose: "verify the changed behavior",
            command: "test -n malformed-writeback-guard"
          }
        ]
      },
      artifacts: ["runs/<run_id>/attempts/<attempt_id>/artifacts/diff.patch"]
    },
    null,
    2
  );

  const invalidFindingCodex = await createFakeCodexScript({
    rootDir,
    fileName: "fake-codex-invalid-finding.sh",
    jsonPayload: invalidFindingPayload
  });
  const invalidArtifactsCodex = await createFakeCodexScript({
    rootDir,
    fileName: "fake-codex-invalid-artifacts.sh",
    jsonPayload: invalidArtifactsPayload
  });

  const invalidFindingFixture = createExecutionAttemptFixture({
    runId: run.id,
    workspaceRoot: rootDir,
    objective: "验证不合法 findings.type 会被拒绝。"
  });
  const invalidArtifactsFixture = createExecutionAttemptFixture({
    runId: run.id,
    workspaceRoot: rootDir,
    objective: "验证字符串 artifacts 会被拒绝。"
  });

  const invalidFindingAdapter = new CodexCliWorkerAdapter({
    command: invalidFindingCodex,
    sandbox: "workspace-write",
    skipGitRepoCheck: true
  });
  await assert.rejects(
    () =>
      invalidFindingAdapter.runAttemptTask({
        run,
        attempt: invalidFindingFixture.attempt,
        attemptContract: invalidFindingFixture.attemptContract,
        context: {},
        workspacePaths
      }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(
        message,
        /Invalid enum value\. Expected 'fact' \| 'hypothesis' \| 'risk', received 'gap'/
      );
      return true;
    }
  );

  const invalidArtifactsAdapter = new CodexCliWorkerAdapter({
    command: invalidArtifactsCodex,
    sandbox: "workspace-write",
    skipGitRepoCheck: true
  });
  await assert.rejects(
    () =>
      invalidArtifactsAdapter.runAttemptTask({
        run,
        attempt: invalidArtifactsFixture.attempt,
        attemptContract: invalidArtifactsFixture.attemptContract,
        context: {},
        workspacePaths
      }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /Expected object, received string/);
      return true;
    }
  );

  const executionPrompt = await readFile(
    join(
      resolveAttemptPaths(workspacePaths, run.id, invalidArtifactsFixture.attempt.id).attemptDir,
      "worker-prompt.md"
    ),
    "utf8"
  );
  assert.match(
    executionPrompt,
    /Allowed findings\.type values: "fact", "hypothesis", "risk"\. Do not invent values like "gap"\./
  );
  assert.match(
    executionPrompt,
    /artifacts must be an array of objects with stable keys\. Allowed artifacts\[\]\.type values: "patch", "command_result", "test_result", "report", "log", "screenshot"\./
  );
  assert.match(
    executionPrompt,
    /Copy this artifacts object shape when you have one: \{"type":"patch","path":"runs\/<run_id>\/attempts\/<attempt_id>\/artifacts\/diff\.patch"\}/
  );
  assert.match(
    executionPrompt,
    /Do not return artifacts as plain strings like "artifacts\/diff\.patch"\./
  );

  console.log(
    JSON.stringify(
      {
        run_id: run.id,
        attempt_id: attempt.id,
        research_shell_reentry: "passed",
        blocked_command_exit_code: blockedProbe.exitCode,
        malformed_findings_guard: "passed",
        malformed_artifacts_guard: "passed",
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
