import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAttempt,
  createAttemptContract,
  createRun
} from "../packages/domain/src/index.ts";
import {
  ensureWorkspace,
  getAttemptRuntimeState,
  listAttemptRuntimeEvents,
  resolveAttemptPaths,
  resolveWorkspacePaths
} from "../packages/state-store/src/index.ts";
import {
  CodexCliWorkerAdapter,
  CodexCliAdversarialVerifierAdapter,
  createAdversarialVerifierAdapter,
  createExecutionWorkerAdapter,
  isWorkerWritebackParseError,
  loadAdversarialVerifierAdapterConfig,
  loadExecutionWorkerAdapterConfig,
  loadCodexCliConfig,
  prepareResearchShellGuard,
  supportsRunHarnessSlotWorkerAdapterType
} from "../packages/worker-adapters/src/index.ts";
import {
  cleanupTrackedVerifyTempDirs,
  createTrackedVerifyTempDir
} from "./verify-temp.ts";

async function createFakeCodexScript(input: {
  rootDir: string;
  fileName: string;
  exitCode?: number;
  stderrMessage?: string;
  jsonPayload?: string;
  jsonEvents?: string[];
}): Promise<string> {
  const scriptPath = join(input.rootDir, input.fileName);
  const lines =
    input.jsonPayload !== undefined
      ? [
          "#!/bin/sh",
          "OUTPUT=\"\"",
          "SAW_JSON=0",
          "while [ \"$#\" -gt 0 ]; do",
          "  if [ \"$1\" = \"--json\" ]; then",
          "    SAW_JSON=1",
          "    shift",
          "    continue",
          "  fi",
          "  if [ \"$1\" = \"--output-last-message\" ]; then",
          "    OUTPUT=\"$2\"",
          "    shift 2",
            "    continue",
          "  fi",
          "  shift",
          "done",
          "cat >/dev/null",
          "if [ \"$SAW_JSON\" -ne 1 ]; then",
          "  echo \"missing --json\" >&2",
          "  exit 3",
          "fi",
          "if [ -z \"$OUTPUT\" ]; then",
          "  echo \"missing --output-last-message\" >&2",
          "  exit 2",
          "fi",
          ...(input.jsonEvents && input.jsonEvents.length > 0
            ? ["cat <<'EOF'", ...input.jsonEvents, "EOF"]
            : []),
          "cat <<'EOF' > \"$OUTPUT\"",
          input.jsonPayload,
          "EOF",
          `exit ${input.exitCode ?? 0}`
        ]
      : [
          "#!/bin/sh",
          "SAW_JSON=0",
          "while [ \"$#\" -gt 0 ]; do",
          "  if [ \"$1\" = \"--json\" ]; then",
          "    SAW_JSON=1",
          "    shift",
          "    continue",
          "  fi",
          "  shift",
          "done",
          "cat >/dev/null",
          "if [ \"$SAW_JSON\" -ne 1 ]; then",
          "  echo \"missing --json\" >&2",
          "  exit 3",
          "fi",
          `echo ${JSON.stringify(
            input.stderrMessage ?? "unexpected status 401 Unauthorized: invalid token"
          )} >&2`,
          `exit ${input.exitCode ?? 1}`
        ];

  await writeFile(scriptPath, lines.join("\n"), "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function createStalledCodexScript(input: {
  rootDir: string;
  fileName: string;
  jsonEvents: string[];
}): Promise<string> {
  const scriptPath = join(input.rootDir, input.fileName);
  const lines = [
    "#!/usr/bin/env node",
    "let sawJson = false;",
    "for (let index = 2; index < process.argv.length; index += 1) {",
    "  if (process.argv[index] === '--json') {",
    "    sawJson = true;",
    "  }",
    "}",
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  if (!sawJson) {",
    "    console.error('missing --json');",
    "    process.exit(3);",
    "  }",
    ...input.jsonEvents.map((event) => `  process.stdout.write(${JSON.stringify(`${event}\n`)});`),
    "  setInterval(() => {}, 60_000);",
    "});"
  ];

  await writeFile(scriptPath, lines.join('\n'), "utf8");
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
  const shell = await resolveProbeShell();

  return await new Promise((resolve, reject) => {
    const child = spawn(shell, ["-lc", input.script], {
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

let cachedProbeShell: string | null = null;

async function resolveProbeShell(): Promise<string> {
  if (cachedProbeShell) {
    return cachedProbeShell;
  }

  const candidates = [
    process.env.SHELL?.trim(),
    "/bin/bash",
    "/bin/sh"
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      cachedProbeShell = candidate;
      return candidate;
    } catch {
      continue;
    }
  }

  cachedProbeShell = "sh";
  return cachedProbeShell;
}

async function main(): Promise<void> {
  try {
    const rootDir = await createTrackedVerifyTempDir("aisa-worker-adapter-");
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

  const prompt = await readFile(attemptPaths.promptFile, "utf8");
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
    AISA_CODEX_PROGRESS_STALL_MS: "9",
    AISA_CODEX_STALL_POLL_MS: "7",
    AISA_CODEX_STALL_KILL_GRACE_MS: "5"
  });
  assert.deepEqual(loadedConfig, {
    command: "codex-test",
    model: "gpt-5.4",
    profile: undefined,
    sandbox: "workspace-write",
    skipGitRepoCheck: false,
    progressStallMs: 9,
    stallPollMs: 7,
    stallKillGraceMs: 5
  });
  const genericLoadedConfig = loadExecutionWorkerAdapterConfig({
    AISA_EXECUTION_ADAPTER: "codex_cli",
    AISA_EXECUTION_COMMAND: "aisa-exec",
    AISA_EXECUTION_SANDBOX: "danger-full-access",
    AISA_EXECUTION_MODEL: "gpt-5.5",
    AISA_EXECUTION_PROFILE: "runtime-dev",
    AISA_EXECUTION_SKIP_GIT_REPO_CHECK: "false",
    AISA_EXECUTION_PROGRESS_STALL_MS: "11",
    AISA_EXECUTION_STALL_POLL_MS: "13",
    AISA_EXECUTION_STALL_KILL_GRACE_MS: "17"
  });
  assert.deepEqual(genericLoadedConfig, {
    provider: "codex_cli",
    command: "aisa-exec",
    model: "gpt-5.5",
    profile: "runtime-dev",
    sandbox: "danger-full-access",
    skipGitRepoCheck: false,
    progressStallMs: 11,
    stallPollMs: 13,
    stallKillGraceMs: 17
  });
  assert.equal(createExecutionWorkerAdapter(genericLoadedConfig).type, "codex");

  const adversarialVerifierConfig = loadAdversarialVerifierAdapterConfig({
    AISA_EXECUTION_COMMAND: "aisa-exec",
    AISA_EXECUTION_SANDBOX: "danger-full-access",
    AISA_ADVERSARIAL_VERIFIER_COMMAND: "aisa-clean-verifier",
    AISA_ADVERSARIAL_VERIFIER_MODEL: "gpt-5.4",
    AISA_ADVERSARIAL_VERIFIER_PROFILE: "clean-postflight",
    AISA_ADVERSARIAL_VERIFIER_PROGRESS_STALL_MS: "19",
    AISA_ADVERSARIAL_VERIFIER_STALL_POLL_MS: "23",
    AISA_ADVERSARIAL_VERIFIER_STALL_KILL_GRACE_MS: "29"
  });
  assert.deepEqual(adversarialVerifierConfig, {
    provider: "codex_cli",
    command: "aisa-clean-verifier",
    model: "gpt-5.4",
    profile: "clean-postflight",
    sandbox: "read-only",
    skipGitRepoCheck: true,
    progressStallMs: 19,
    stallPollMs: 23,
    stallKillGraceMs: 29
  });
  assert.equal(
    createAdversarialVerifierAdapter(adversarialVerifierConfig).type,
    "codex-clean-adversarial-verifier"
  );
  assert.equal(
    supportsRunHarnessSlotWorkerAdapterType({
      slot: "execution",
      workerAdapterType: "fake-codex"
    }),
    true
  );
  assert.equal(
    supportsRunHarnessSlotWorkerAdapterType({
      slot: "execution",
      workerAdapterType: "missing-adapter"
    }),
    false
  );
  assert.equal(
    supportsRunHarnessSlotWorkerAdapterType({
      slot: "postflight_review",
      workerAdapterType: null
    }),
    true
  );

  const runtimeFixture = createExecutionAttemptFixture({
    runId: run.id,
    workspaceRoot: rootDir,
    objective: "验证运行时事件流会被落盘并归一化。"
  });
  const changedRuntimeFile = join(rootDir, "scripts", "verify-runtime.ts");
  const runtimeEventsPayload = JSON.stringify(
    {
      summary: "事件流已落盘。",
      findings: [
        {
          type: "fact",
          content: "运行时状态文件已写入。",
          evidence: ["artifacts/runtime-state.json"]
        }
      ],
      questions: [],
      recommended_next_steps: ["继续用回放验证保护运行时链路。"],
      confidence: 0.88,
      verification_plan: {
        commands: [
          {
            purpose: "replay runtime suite",
            command: "pnpm verify:runtime"
          }
        ]
      },
      artifacts: [
        {
          type: "log",
          path: "runs/<run_id>/attempts/<attempt_id>/artifacts/runtime-events.ndjson"
        }
      ]
    },
    null,
    2
  );
  const runtimeCodex = await createFakeCodexScript({
    rootDir,
    fileName: "fake-codex-runtime-events.sh",
    jsonPayload: runtimeEventsPayload,
    jsonEvents: [
      JSON.stringify({
        type: "thread.started",
        thread_id: "sess_runtime_test"
      }),
      JSON.stringify({
        type: "turn.started"
      }),
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item_plan",
          type: "todo_list",
          items: [
            {
              text: "先跑验证",
              completed: true
            },
            {
              text: "整理结果",
              completed: false
            }
          ]
        }
      }),
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item_command",
          type: "command_execution",
          command: "/bin/zsh -lc 'pnpm verify:runtime'",
          aggregated_output: "",
          exit_code: null,
          status: "in_progress"
        }
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_command",
          type: "command_execution",
          command: "/bin/zsh -lc 'pnpm verify:runtime'",
          aggregated_output: "runtime ok",
          exit_code: 0,
          status: "completed"
        }
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_message",
          type: "agent_message",
          text: "先检查运行时链路，再整理验证结果。"
        }
      }),
      JSON.stringify({
        type: "item.updated",
        item: {
          id: "item_plan",
          type: "todo_list",
          items: [
            {
              text: "先跑验证",
              completed: true
            },
            {
              text: "整理结果",
              completed: true
            }
          ]
        }
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_file",
          type: "file_change",
          changes: [
            {
              path: changedRuntimeFile,
              kind: "update"
            }
          ],
          status: "completed"
        }
      }),
      JSON.stringify({
        type: "turn.completed"
      })
    ]
  });
  const runtimeAdapter = new CodexCliWorkerAdapter({
    command: runtimeCodex,
    sandbox: "workspace-write",
    skipGitRepoCheck: true
  });
  const runtimeResult = await runtimeAdapter.runAttemptTask({
    run,
    attempt: runtimeFixture.attempt,
    attemptContract: runtimeFixture.attemptContract,
    context: {},
    workspacePaths
  });
  assert.equal(runtimeResult.writeback.summary, "事件流已落盘。");

  const runtimeState = await getAttemptRuntimeState(
    workspacePaths,
    run.id,
    runtimeFixture.attempt.id
  );
  const runtimeEvents = await listAttemptRuntimeEvents(
    workspacePaths,
    run.id,
    runtimeFixture.attempt.id
  );
  assert.ok(runtimeState, "runtime state should be persisted");
  assert.equal(runtimeState?.running, false);
  assert.equal(runtimeState?.phase, "completed");
  assert.equal(runtimeState?.session_id, "sess_runtime_test");
  assert.equal(runtimeState?.event_count, 9);
  assert.match(runtimeState?.progress_text ?? "", /执行完成/);
  assert.ok(
    runtimeState?.recent_activities.some((item) => item.includes("执行命令：pnpm verify:runtime"))
  );
  assert.ok(
    runtimeState?.completed_steps.some((item) =>
      item.includes("命令完成：pnpm verify:runtime")
    )
  );
  assert.ok(
    runtimeState?.completed_steps.some((item) =>
      item.includes("修改文件：") && item.includes("verify-runtime.ts")
    )
  );
  assert.ok(
    runtimeState?.recent_activities.some((item) =>
      item.includes("计划更新：2/2 已完成")
    )
  );
  assert.ok(
    runtimeState?.process_content.some((item) =>
      item.includes("先检查运行时链路")
    )
  );
  assert.ok(
    runtimeState?.process_content.some((item) => item.includes("整理结果"))
  );
  assert.match(runtimeState?.final_output ?? "", /事件流已落盘/);
  assert.equal(runtimeEvents.length, 9);
  assert.equal(runtimeEvents[0]?.type, "thread.started");
  assert.equal(runtimeEvents[2]?.summary, "计划更新：1/2 已完成");
  assert.equal(runtimeEvents[3]?.summary, "执行命令：pnpm verify:runtime");
  assert.equal(runtimeEvents[4]?.summary, "命令完成：pnpm verify:runtime");

  const cleanVerifierFixture = createExecutionAttemptFixture({
    runId: run.id,
    workspaceRoot: rootDir,
    objective: "验证 postflight adversarial verifier 使用干净上下文。"
  });
  const cleanVerifierPaths = resolveAttemptPaths(
    workspacePaths,
    run.id,
    cleanVerifierFixture.attempt.id
  );
  const cleanVerifierCodex = await createFakeCodexScript({
    rootDir,
    fileName: "fake-codex-clean-verifier.sh",
    jsonPayload: JSON.stringify(
      {
        target_surface: "repo",
        summary: "干净 verifier 独立完成验证。",
        verdict: "pass",
        checks: [
          {
            code: "clean_context_probe",
            status: "passed",
            message: "没有复用 execution worker 的 adversarial 结论。"
          }
        ],
        commands: [
          {
            purpose: "clean postflight adversarial probe",
            command: "test -n clean-verifier",
            cwd: rootDir,
            exit_code: 0,
            status: "passed",
            output_ref: join(cleanVerifierPaths.artifactsDir, "adversarial-verifier", "stdout.ndjson")
          }
        ],
        output_refs: [
          join(cleanVerifierPaths.artifactsDir, "adversarial-verifier", "stdout.ndjson")
        ]
      },
      null,
      2
    ),
    jsonEvents: [
      JSON.stringify({
        type: "thread.started",
        thread_id: "sess_clean_verifier_test"
      })
    ]
  });
  const cleanVerifier = new CodexCliAdversarialVerifierAdapter({
    command: cleanVerifierCodex,
    sandbox: "read-only",
    skipGitRepoCheck: true
  });
  const cleanVerifierResult = await cleanVerifier.runAttemptAdversarialVerification({
    run,
    attempt: cleanVerifierFixture.attempt,
    attemptContract: cleanVerifierFixture.attemptContract,
    result: runtimeResult.writeback,
    runtimeVerification: {
      attempt_id: cleanVerifierFixture.attempt.id,
      run_id: run.id,
      attempt_type: "execution",
      status: "passed",
      verifier_kit: "repo",
      failure_class: null,
      failure_policy_mode: null,
      repo_root: rootDir,
      git_head: "abc123",
      git_status: [" M execution-change.md"],
      preexisting_git_status: [],
      new_git_status: [" M execution-change.md"],
      changed_files: ["execution-change.md"],
      failure_code: null,
      failure_reason: null,
      checks: [],
      command_results: [],
      synced_self_bootstrap_artifacts: null,
      created_at: new Date().toISOString()
    },
    attemptPaths: cleanVerifierPaths,
    workspacePaths
  });
  assert.equal(
    cleanVerifierResult.artifact.summary,
    "干净 verifier 独立完成验证。"
  );
  assert.ok(
    cleanVerifierResult.sourceArtifactPath.endsWith("adversarial-verifier/artifact.json")
  );
  const runtimeAttemptPrompt = await readFile(
    resolveAttemptPaths(workspacePaths, run.id, runtimeFixture.attempt.id).promptFile,
    "utf8"
  );
  assert.match(
    runtimeAttemptPrompt,
    /Do not create or cite artifacts\/adversarial-verification\.json as execution-worker proof/
  );
  const cleanPostflightPrompt = await readFile(cleanVerifierResult.promptFile, "utf8");
  assert.match(cleanPostflightPrompt, /fresh verifier context/);
  assert.match(cleanPostflightPrompt, /Do not trust an execution-worker-written artifacts\/adversarial-verification\.json as proof/);

  const stalledFixture = createExecutionAttemptFixture({
    runId: run.id,
    workspaceRoot: rootDir,
    objective: "验证卡住的 Codex worker 会被自动终止并暴露失败。"
  });
  const stalledCodex = await createStalledCodexScript({
    rootDir,
    fileName: "fake-codex-stalled.mjs",
    jsonEvents: [
      JSON.stringify({
        type: "thread.started",
        thread_id: "sess_stalled_test"
      }),
      JSON.stringify({
        type: "turn.started"
      }),
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item_verify",
          type: "command_execution",
          command: "/bin/zsh -lc 'pnpm verify:run-loop'",
          aggregated_output: "",
          exit_code: null,
          status: "in_progress"
        }
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_verify",
          type: "command_execution",
          command: "/bin/zsh -lc 'pnpm verify:run-loop'",
          aggregated_output: "verify run loop ok",
          exit_code: 0,
          status: "completed"
        }
      })
    ]
  });
  const stalledAdapter = new CodexCliWorkerAdapter({
    command: stalledCodex,
    sandbox: "workspace-write",
    skipGitRepoCheck: true,
    progressStallMs: 80,
    stallPollMs: 20,
    stallKillGraceMs: 20
  });
  await assert.rejects(
    () =>
      stalledAdapter.runAttemptTask({
        run,
        attempt: stalledFixture.attempt,
        attemptContract: stalledFixture.attemptContract,
        context: {},
        workspacePaths
      }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /Codex CLI stalled/);
      assert.match(message, /No runtime stdout activity arrived/);
      assert.match(message, /No live child command remained and no final output was written/);
      return true;
    }
  );

  const stalledRuntimeState = await getAttemptRuntimeState(
    workspacePaths,
    run.id,
    stalledFixture.attempt.id
  );
  assert.ok(stalledRuntimeState, "stalled runtime state should be persisted");
  assert.equal(stalledRuntimeState?.running, false);
  assert.equal(stalledRuntimeState?.phase, "failed");
  assert.match(stalledRuntimeState?.error ?? "", /Codex CLI stalled/);

  const blockedOutputFixture = createExecutionAttemptFixture({
    runId: run.id,
    workspaceRoot: rootDir,
    objective: "验证输出文件不可访问时不会被伪装成普通 stall。"
  });
  const blockedOutputCodex = await createStalledCodexScript({
    rootDir,
    fileName: "fake-codex-blocked-output.mjs",
    jsonEvents: [
      JSON.stringify({
        type: "thread.started",
        thread_id: "sess_blocked_output_test"
      })
    ]
  });
  const blockedOutputAdapter = new CodexCliWorkerAdapter({
    command: blockedOutputCodex,
    sandbox: "workspace-write",
    skipGitRepoCheck: true,
    progressStallMs: 80,
    stallPollMs: 20,
    stallKillGraceMs: 20
  });
  const blockedOutputPaths = resolveAttemptPaths(
    workspacePaths,
    run.id,
    blockedOutputFixture.attempt.id
  );
  const blockedOutputTargetParent = join(rootDir, "blocked-output-target");
  const blockedOutputTarget = join(blockedOutputTargetParent, "writeback.json");
  await mkdir(blockedOutputTargetParent, { recursive: true });
  await mkdir(blockedOutputPaths.attemptDir, { recursive: true });
  await symlink(blockedOutputTarget, blockedOutputPaths.rawOutputFile);
  await chmod(blockedOutputTargetParent, 0o000);

  try {
    await assert.rejects(
      () =>
        blockedOutputAdapter.runAttemptTask({
          run,
          attempt: blockedOutputFixture.attempt,
          attemptContract: blockedOutputFixture.attemptContract,
          context: {},
          workspacePaths
        }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /stall watchdog failed/i);
        assert.match(message, /EACCES|permission denied/i);
        return true;
      }
    );
  } finally {
    await chmod(blockedOutputTargetParent, 0o755);
  }

  const blockedOutputRuntimeState = await getAttemptRuntimeState(
    workspacePaths,
    run.id,
    blockedOutputFixture.attempt.id
  );
  assert.ok(
    blockedOutputRuntimeState,
    "blocked-output runtime state should be persisted"
  );
  assert.equal(blockedOutputRuntimeState?.running, false);
  assert.equal(blockedOutputRuntimeState?.phase, "failed");
  assert.match(blockedOutputRuntimeState?.error ?? "", /stall watchdog failed/i);
  assert.match(blockedOutputRuntimeState?.error ?? "", /EACCES|permission denied/i);

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
        /Invalid enum value\. Expected 'fact' \| 'hypothesis' \| 'risk', received 'gap'|Expected one of fact, hypothesis, risk/
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
      assert.match(message, /Worker writeback schema invalid at artifacts\[0\]/);
      assert.match(message, /Expected object, received string/);
      assert.match(message, /artifacts 必须是对象数组/);
      if (!isWorkerWritebackParseError(error)) {
        return false;
      }
      assert.equal(
        error.rawOutputFile,
        `runs/${run.id}/attempts/${invalidArtifactsFixture.attempt.id}/worker-output.json`
      );
      return true;
    }
  );

  const executionPrompt = await readFile(
    resolveAttemptPaths(workspacePaths, run.id, invalidArtifactsFixture.attempt.id).promptFile,
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
    /Do not return artifacts as plain strings like "scripts\/verify-run-detail-api\.ts"\./
  );
  assert.match(
    executionPrompt,
    /If you only want to cite files or commands as evidence, put them in findings\[\]\.evidence, recommended_next_steps, or next_attempt_contract\.expected_artifacts instead of artifacts\[\]\./
  );

    console.log(
      JSON.stringify(
        {
          run_id: run.id,
          attempt_id: attempt.id,
          research_shell_reentry: "passed",
          blocked_command_exit_code: blockedProbe.exitCode,
          runtime_event_stream: "passed",
          stalled_worker_guard: "passed",
          malformed_findings_guard: "passed",
          malformed_artifacts_guard: "passed",
          status: "passed"
        },
        null,
        2
      )
    );
  } finally {
    await cleanupTrackedVerifyTempDirs();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
