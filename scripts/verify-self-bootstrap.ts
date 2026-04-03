import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCurrentDecision,
  createAttempt,
  createAttemptRuntimeState,
  createRunGovernanceState,
  createRunJournalEntry,
  createRun,
  updateAttempt,
  type Attempt,
  type Run,
  type WorkerWriteback
} from "../packages/domain/src/index.ts";
import {
  createDefaultRunWorkspaceScopePolicy,
  Orchestrator,
  SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH,
  SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME
} from "../packages/orchestrator/src/index.ts";
import { buildServer } from "../apps/control-api/src/index.ts";
import {
  appendRunJournal,
  ensureWorkspace,
  getAttemptContract,
  getAttemptContext,
  getAttemptHeartbeat,
  getAttemptRuntimeState,
  getRunAutomationControl,
  getCurrentDecision,
  getRun,
  getRunRuntimeHealthSnapshot,
  listAttempts,
  listRuns,
  listRunJournal,
  listRunSteers,
  resolveAttemptPaths,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptHeartbeat,
  saveAttemptRuntimeState,
  saveCurrentDecision,
  saveRunGovernanceState,
  saveRun
} from "../packages/state-store/src/index.ts";
import {
  cleanupTrackedVerifyTempDirs,
  createTrackedVerifyTempDir
} from "./verify-temp.ts";

class NoopAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    return {
      writeback: {
        summary: `Captured objective for ${input.attempt.id}`,
        findings: [],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.4,
        artifacts: []
      },
      reportMarkdown: "# noop",
      exitCode: 0
    };
  }
}

const REQUIRED_ROOT_SCRIPT_COMMANDS = {
  "verify:drive-run":
    "node --experimental-transform-types --loader ./scripts/ts-runtime-loader.mjs scripts/verify-drive-run.ts",
  "verify:run-api":
    "node --experimental-transform-types --loader ./scripts/ts-runtime-loader.mjs scripts/verify-run-detail-api.ts",
  "verify:self-bootstrap":
    "node --experimental-transform-types --loader ./scripts/ts-runtime-loader.mjs scripts/verify-self-bootstrap.ts",
  "bootstrap:self":
    "node --experimental-transform-types --loader ./scripts/ts-runtime-loader.mjs scripts/bootstrap-self-run.ts",
  "drive:run":
    "node --experimental-transform-types --loader ./scripts/ts-runtime-loader.mjs scripts/drive-run.ts"
} as const;

async function assertRootEntrypointsUseNodeImportTsx(): Promise<void> {
  const packageJsonPath = join(process.cwd(), "package.json");
  const packageJson = JSON.parse(
    await readFile(packageJsonPath, "utf8")
  ) as {
    scripts?: Record<string, string>;
  };

  for (const [scriptName, expectedCommand] of Object.entries(REQUIRED_ROOT_SCRIPT_COMMANDS)) {
    const actualCommand = packageJson.scripts?.[scriptName];
    assert.equal(
      actualCommand,
      expectedCommand,
      `${scriptName} should stay on the local TypeScript loader`
    );
    assert.ok(
      !actualCommand.startsWith("tsx "),
      `${scriptName} should not regress to direct tsx`
    );
  }
}

type ScriptResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type BootstrapOutput = {
  run_id: string;
  current_status: string;
  workspace_root: string;
  steer_id: string | null;
  launched: boolean;
  template: string;
  active_next_task: string;
  active_next_task_snapshot: string;
  runtime_health_snapshot: string;
};

function resolveSourceRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function resolveRuntimeLoaderPath(sourceRoot: string): string {
  return join(sourceRoot, "scripts", "ts-runtime-loader.mjs");
}

function runTsxScript(input: {
  cwd: string;
  sourceRoot: string;
  scriptPath: string;
  args?: string[];
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--loader",
        resolveRuntimeLoaderPath(input.sourceRoot),
        input.scriptPath,
        ...(input.args ?? [])
      ],
      {
        cwd: input.cwd,
        env: {
          ...process.env,
          ...input.extraEnv
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stdout,
        stderr
      });
    });
  });
}

async function runCommand(
  cwd: string,
  command: string,
  args: string[]
): Promise<void> {
  const result = await new Promise<{
    exitCode: number | null;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stderr
      });
    });
  });

  assert.equal(
    result.exitCode,
    0,
    `${command} ${args.join(" ")} failed.\n\nstderr:\n${result.stderr.trim() || "<empty>"}`
  );
}

async function createGitWorkspace(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(join(rootDir, ".gitignore"), "node_modules/\n", "utf8");
  await writeFile(join(rootDir, "README.md"), "# self-bootstrap fixture\n", "utf8");
  await runCommand(rootDir, "git", ["init"]);
  await runCommand(rootDir, "git", ["config", "user.name", "AISA Test"]);
  await runCommand(rootDir, "git", ["config", "user.email", "aisa-test@example.com"]);
  await runCommand(rootDir, "git", ["add", "."]);
  await runCommand(rootDir, "git", ["commit", "-m", "test: seed self-bootstrap fixture"]);
}

function formatScriptFailure(label: string, result: ScriptResult): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  return [
    `${label} exit code: ${result.exitCode ?? "null"}`,
    stdout.length > 0 ? `stdout:\n${stdout}` : "stdout:\n<empty>",
    stderr.length > 0 ? `stderr:\n${stderr}` : "stderr:\n<empty>"
  ].join("\n\n");
}

function parseJsonStdout<T>(label: string, stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON stdout: ${reason}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedSelfBootstrapActiveTask(
  workspaceRoot: string,
  content: string
): Promise<void> {
  const publishedPath = join(
    workspaceRoot,
    SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH
  );
  await mkdir(dirname(publishedPath), { recursive: true });
  await writeFile(publishedPath, content, "utf8");
}

async function loadPublishedActiveTaskFixture(sourceRoot: string): Promise<{
  content: string;
  updatedAt: string;
  title: string;
  summary: string;
  sourceAnchor: {
    asset_path: string;
    source_attempt_id?: string | null;
    payload_sha256?: string | null;
    promoted_at?: string | null;
  };
  sourceAnchorAssetPath: string;
}> {
  const content = await readFile(
    join(sourceRoot, SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH),
    "utf8"
  );
  const parsed = JSON.parse(content) as {
    updated_at: string;
    title: string;
    summary: string;
    source_anchor: {
      asset_path: string;
      source_attempt_id?: string | null;
      payload_sha256?: string | null;
      promoted_at?: string | null;
    };
  };

  return {
    content,
    updatedAt: parsed.updated_at,
    title: parsed.title,
    summary: parsed.summary,
    sourceAnchor: parsed.source_anchor,
    sourceAnchorAssetPath: parsed.source_anchor.asset_path
  };
}

async function waitForFirstAttemptContext(input: {
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  runId: string;
  timeoutMs?: number;
}): Promise<{
  attempts: Attempt[];
  context: Record<string, unknown> | null;
}> {
  const deadline = Date.now() + (input.timeoutMs ?? 1_500);

  while (Date.now() < deadline) {
    const attempts = await listAttempts(input.workspacePaths, input.runId);
    const firstAttempt = attempts[0];

    if (!firstAttempt) {
      await sleep(50);
      continue;
    }

    const context = (await getAttemptContext(
      input.workspacePaths,
      input.runId,
      firstAttempt.id
    )) as Record<string, unknown> | null;

    if (context) {
      return {
        attempts,
        context
      };
    }

    await sleep(50);
  }

  throw new Error("first self-bootstrap attempt context did not persist in time");
}

async function assertMissingActiveSnapshotBlocksRunInsteadOfCrashing(): Promise<{
  blocked_message: string | null;
}> {
  const baseDir = await createTrackedVerifyTempDir(
    "aisa-self-bootstrap-execution-snapshot-"
  );
  const repoRoot = join(baseDir, "repo");
  const runtimeDataRoot = join(baseDir, "runtime-data");
  const managedWorkspaceRoot = join(baseDir, ".aisa-run-worktrees");
  await createGitWorkspace(repoRoot);
  await mkdir(managedWorkspaceRoot, { recursive: true });

  const workspacePaths = resolveWorkspacePaths(runtimeDataRoot);
  await ensureWorkspace(workspacePaths);
  const run = createRun({
    title: "AISA 自举下一步规划",
    description: "Block missing execution planning evidence at the run level.",
    success_criteria: ["Stop the run without crashing the orchestrator."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: repoRoot
  });
  const previousAttempt = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Previous self-bootstrap execution step.",
      success_criteria: ["Leave replayable evidence."],
      workspace_root: repoRoot
    }),
    {
      status: "completed",
      ended_at: new Date().toISOString()
    }
  );
  const current = createCurrentDecision({
    run_id: run.id,
    run_status: "running",
    best_attempt_id: previousAttempt.id,
    latest_attempt_id: previousAttempt.id,
    recommended_next_action: "continue_execution",
    recommended_attempt_type: "execution",
    summary: "Continue the published self-bootstrap execution task."
  });
  await saveRun(workspacePaths, run);
  await saveAttempt(workspacePaths, previousAttempt);
  await saveCurrentDecision(workspacePaths, current);

  const orchestrator = new Orchestrator(
    workspacePaths,
    new NoopAdapter() as never,
    undefined,
    60_000,
    {
      runWorkspaceScopePolicy: createDefaultRunWorkspaceScopePolicy(
        repoRoot,
        managedWorkspaceRoot
      )
    }
  );
  await orchestrator.tick();
  await sleep(50);
  await orchestrator.tick();

  const [blockedCurrent, attempts, journal] = await Promise.all([
    getCurrentDecision(workspacePaths, run.id),
    listAttempts(workspacePaths, run.id),
    listRunJournal(workspacePaths, run.id)
  ]);

  assert.equal(
    attempts.length,
    1,
    "missing active next task snapshot should block planning before any new attempt is created"
  );
  assert.equal(
    attempts[0]?.id,
    previousAttempt.id,
    "planning failure should leave the previous completed execution attempt untouched"
  );
  assert.equal(attempts[0]?.status, "completed");
  assert.equal(blockedCurrent?.run_status, "waiting_steer");
  assert.equal(blockedCurrent?.waiting_for_human, true);
  assert.match(
    blockedCurrent?.blocking_reason ?? "",
    /self-bootstrap blocked because active next task snapshot is missing or invalid while building execution contract/,
    "missing snapshot should stop the run with an explicit planning error"
  );
  assert.ok(
    blockedCurrent?.blocking_reason?.includes(
      SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME
    ),
    "missing snapshot failure should name the missing run artifact"
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.planning.blocked" &&
        entry.payload.message === blockedCurrent?.blocking_reason
    ),
    "planning failure should be recorded on the run instead of crashing the orchestrator"
  );

  return {
    blocked_message: blockedCurrent?.blocking_reason ?? null
  };
}

async function assertSupervisorRepairsWorkerOutputSchemaBlocker(sourceRoot: string): Promise<{
  repair_steer_id: string | null;
  repair_state_action: string | null;
}> {
  const baseDir = await createTrackedVerifyTempDir(
    "aisa-self-bootstrap-supervisor-"
  );
  const repoRoot = join(baseDir, "repo");
  const runtimeDataRoot = join(baseDir, "runtime-data");
  const managedWorkspaceRoot = join(baseDir, ".aisa-run-worktrees");
  await createGitWorkspace(repoRoot);
  await mkdir(managedWorkspaceRoot, { recursive: true });

  const workspacePaths = resolveWorkspacePaths(runtimeDataRoot);
  await ensureWorkspace(workspacePaths);
  const run = createRun({
    title: "AISA 自举下一步规划",
    description: "Repair malformed worker output before asking for human help.",
    success_criteria: ["Queue a repair steer for worker output schema blockers."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: repoRoot
  });
  const failedAttempt = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "research",
      worker: "fake-codex",
      objective: "Study the next runtime task.",
      success_criteria: run.success_criteria,
      workspace_root: repoRoot
    }),
    {
      status: "failed",
      ended_at: new Date().toISOString()
    }
  );
  const rawOutputFile = `runs/${run.id}/attempts/${failedAttempt.id}/codex-output.json`;
  const attemptPaths = resolveAttemptPaths(workspacePaths, run.id, failedAttempt.id);
  await mkdir(attemptPaths.attemptDir, { recursive: true });
  await writeFile(
    join(attemptPaths.attemptDir, "codex-output.json"),
    JSON.stringify(
      {
        summary: "Keep the existing handoff-first conclusion.",
        findings: [],
        questions: [],
        recommended_next_steps: ["Implement the handoff-first run detail path."],
        confidence: 0.8,
        artifacts: [
          "scripts/verify-run-detail-api.ts",
          "apps/control-api/src/index.ts"
        ]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  await saveRun(workspacePaths, run);
  await saveAttempt(workspacePaths, failedAttempt);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: failedAttempt.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "research",
      summary: "治理层拦下了下一轮派发。",
      blocking_reason:
        "治理层拦下了下一轮派发。 原始原因：Expected object, received string at artifacts[0]",
      waiting_for_human: true
    })
  );
  await saveRunGovernanceState(
    workspacePaths,
    createRunGovernanceState({
      run_id: run.id,
      status: "blocked",
      blocker_repeat_count: 2,
      active_problem_signature: "worker_output_schema_invalid:artifacts[0]",
      active_problem_summary: "治理层拦下了下一轮派发。 原始原因：Expected object, received string at artifacts[0]",
      next_allowed_actions: ["wait_for_human", "apply_steer"],
      context_summary: {
        headline: "治理层拦下了下一轮派发。",
        blocker_summary:
          "治理层拦下了下一轮派发。 原始原因：Expected object, received string at artifacts[0]"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedAttempt.id,
      type: "attempt.failed",
      payload: {
        message:
          'Worker writeback schema invalid at artifacts[0]: Expected object, received string artifacts 必须是对象数组，元素形如 {"type":"report","path":"relative/path"}；如果只是引用文件路径，就不要放进 artifacts。',
        code: "worker_output_schema_invalid",
        field_path: "artifacts[0]",
        repair_hint:
          'artifacts 必须是对象数组，元素形如 {"type":"report","path":"relative/path"}；如果只是引用文件路径，就不要放进 artifacts。',
        raw_output_file: rawOutputFile
      }
    })
  );

  const app = await buildServer({
    runtimeRepoRoot: sourceRoot,
    devRepoRoot: repoRoot,
    runtimeDataRoot,
    managedWorkspaceRoot,
    startOrchestrator: false
  });
  const apiBaseUrl = await app.listen({
    host: "127.0.0.1",
    port: 0
  });
  const supervisorStateFile = join(runtimeDataRoot, "artifacts", "self-bootstrap-supervisor-state.json");

  try {
    const supervisorResult = await runTsxScript({
      cwd: sourceRoot,
      sourceRoot,
      scriptPath: join(sourceRoot, "scripts", "supervise-self-bootstrap.ts"),
      args: [
        "--once",
        "--api-base-url",
        apiBaseUrl,
        "--run-id",
        run.id,
        "--state-file",
        supervisorStateFile
      ],
      extraEnv: {
        AISA_RUNTIME_REPO_ROOT: sourceRoot,
        AISA_DEV_REPO_ROOT: repoRoot,
        AISA_RUNTIME_DATA_ROOT: runtimeDataRoot,
        AISA_MANAGED_WORKSPACE_ROOT: managedWorkspaceRoot
      }
    });
    assert.equal(
      supervisorResult.exitCode,
      0,
      formatScriptFailure("scripts/supervise-self-bootstrap.ts", supervisorResult)
    );
  } finally {
    await app.close();
  }

  const [current, steers, state] = await Promise.all([
    getCurrentDecision(workspacePaths, run.id),
    listRunSteers(workspacePaths, run.id),
    readFile(supervisorStateFile, "utf8").then((content) =>
      JSON.parse(content) as {
        repair_log?: Array<{
          action?: string;
          detail?: string;
        }>;
      }
    )
  ]);

  assert.equal(steers.length, 1, "schema repair should queue exactly one steer");
  assert.equal(current?.run_status, "running");
  assert.equal(current?.recommended_next_action, "apply_steer");
  assert.equal(current?.waiting_for_human, false);
  assert.ok(
    steers[0]?.content.includes(rawOutputFile),
    "repair steer should point the next attempt to the raw invalid worker output"
  );
  assert.ok(
    steers[0]?.content.includes("artifacts[0]"),
    "repair steer should name the broken field path"
  );
  assert.ok(
    steers[0]?.content.includes("不要再返回字符串 artifacts"),
    "repair steer should explicitly forbid string artifacts"
  );
  assert.ok(
    state.repair_log?.some(
      (entry) =>
        entry.action === "queue_worker_output_schema_repair" &&
        entry.detail === "worker_output_schema_invalid:artifacts[0]"
    ),
    "supervisor state should record the schema repair action"
  );

  return {
    repair_steer_id: steers[0]?.id ?? null,
    repair_state_action:
      state.repair_log?.find(
        (entry) => entry.action === "queue_worker_output_schema_repair"
      )?.action ?? null
  };
}

async function assertSupervisorDoesNotKeepRotatingPinnedRun(sourceRoot: string): Promise<{
  first_rotated_run_id: string | null;
  second_cycle_active_run_id: string | null;
}> {
  const baseDir = await createTrackedVerifyTempDir(
    "aisa-self-bootstrap-rotate-pin-"
  );
  const repoRoot = join(baseDir, "repo");
  const runtimeDataRoot = join(baseDir, "runtime-data");
  const managedWorkspaceRoot = join(baseDir, ".aisa-run-worktrees");
  await createGitWorkspace(repoRoot);
  await mkdir(managedWorkspaceRoot, { recursive: true });

  const publishedActiveTask = await loadPublishedActiveTaskFixture(sourceRoot);
  await seedSelfBootstrapActiveTask(repoRoot, publishedActiveTask.content);

  const workspacePaths = resolveWorkspacePaths(runtimeDataRoot);
  await ensureWorkspace(workspacePaths);
  const blockedRun = createRun({
    title: "AISA 自举下一步规划",
    description: "Rotate once, then stay on the new active run.",
    success_criteria: ["Do not keep rotating the same pinned run forever."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: repoRoot
  });
  await saveRun(workspacePaths, blockedRun);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: blockedRun.id,
      run_status: "waiting_steer",
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "research",
      summary: "Old run is exhausted.",
      blocking_reason: "治理层拦下了下一轮派发。",
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: blockedRun.id,
      type: "run.auto_resume.exhausted",
      payload: {
        reason: "verification fixture exhausted the old run"
      }
    })
  );

  const app = await buildServer({
    runtimeRepoRoot: sourceRoot,
    devRepoRoot: repoRoot,
    runtimeDataRoot,
    managedWorkspaceRoot,
    startOrchestrator: false
  });
  const apiBaseUrl = await app.listen({
    host: "127.0.0.1",
    port: 0
  });
  const supervisorStateFile = join(runtimeDataRoot, "artifacts", "self-bootstrap-supervisor-state.json");

  try {
    const runSupervisorOnce = async (): Promise<void> => {
      const supervisorResult = await runTsxScript({
        cwd: sourceRoot,
        sourceRoot,
        scriptPath: join(sourceRoot, "scripts", "supervise-self-bootstrap.ts"),
        args: [
          "--once",
          "--api-base-url",
          apiBaseUrl,
          "--run-id",
          blockedRun.id,
          "--state-file",
          supervisorStateFile
        ],
        extraEnv: {
          AISA_RUNTIME_REPO_ROOT: sourceRoot,
          AISA_DEV_REPO_ROOT: repoRoot,
          AISA_RUNTIME_DATA_ROOT: runtimeDataRoot,
          AISA_MANAGED_WORKSPACE_ROOT: managedWorkspaceRoot
        }
      });
      assert.equal(
        supervisorResult.exitCode,
        0,
        formatScriptFailure("scripts/supervise-self-bootstrap.ts", supervisorResult)
      );
    };

    await runSupervisorOnce();
    const firstState = JSON.parse(
      await readFile(supervisorStateFile, "utf8")
    ) as {
      active_run_id?: string | null;
    };
    const firstRotatedRunId = firstState.active_run_id ?? null;
    assert.ok(
      firstRotatedRunId && firstRotatedRunId !== blockedRun.id,
      "first cycle should rotate to a replacement self-bootstrap run"
    );
    assert.equal(
      (await listRuns(workspacePaths)).length,
      2,
      "first cycle should create exactly one replacement run"
    );

    await runSupervisorOnce();
    const secondState = JSON.parse(
      await readFile(supervisorStateFile, "utf8")
    ) as {
      active_run_id?: string | null;
    };
    const runsAfterSecondCycle = await listRuns(workspacePaths);

    assert.equal(
      runsAfterSecondCycle.length,
      2,
      "second cycle should keep supervising the rotated run instead of creating another one"
    );
    assert.equal(
      secondState.active_run_id,
      firstRotatedRunId,
      "second cycle should stay on the already-rotated run"
    );

    return {
      first_rotated_run_id: firstRotatedRunId,
      second_cycle_active_run_id: secondState.active_run_id ?? null
    };
  } finally {
    await app.close();
  }
}

async function assertSupervisorSuspendsSupersededSelfBootstrapRuns(sourceRoot: string): Promise<{
  suspended_run_id: string;
  active_run_id: string;
  stopped_attempt_id: string;
}> {
  const baseDir = await createTrackedVerifyTempDir(
    "aisa-self-bootstrap-suspend-stale-"
  );
  const repoRoot = join(baseDir, "repo");
  const runtimeDataRoot = join(baseDir, "runtime-data");
  const managedWorkspaceRoot = join(baseDir, ".aisa-run-worktrees");
  await createGitWorkspace(repoRoot);
  await mkdir(managedWorkspaceRoot, { recursive: true });

  const publishedActiveTask = await loadPublishedActiveTaskFixture(sourceRoot);
  await seedSelfBootstrapActiveTask(repoRoot, publishedActiveTask.content);

  const workspacePaths = resolveWorkspacePaths(runtimeDataRoot);
  await ensureWorkspace(workspacePaths);

  const activeRun = createRun({
    title: "AISA 自举下一步规划",
    description: "Keep this self-bootstrap run active.",
    success_criteria: ["Stay active."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: repoRoot
  });
  const staleRun = createRun({
    title: "AISA 自举下一步规划",
    description: "This stale self-bootstrap run should be suspended.",
    success_criteria: ["Stop consuming scheduler slots."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: repoRoot
  });
  const staleAttempt = createAttempt({
    run_id: staleRun.id,
    attempt_type: "research",
    worker: "fake-codex",
    objective: "Old self-bootstrap research should stop.",
    success_criteria: staleRun.success_criteria,
    workspace_root: repoRoot
  });

  await saveRun(workspacePaths, activeRun);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: activeRun.id,
      run_status: "running",
      recommended_next_action: "start_first_attempt",
      recommended_attempt_type: "research",
      summary: "Active self-bootstrap run."
    })
  );

  await saveRun(workspacePaths, staleRun);
  await saveAttempt(
    workspacePaths,
    updateAttempt(staleAttempt, {
      status: "running",
      started_at: "2026-04-01T10:00:00.000Z"
    })
  );
  await saveAttemptHeartbeat(workspacePaths, {
    run_id: staleRun.id,
    attempt_id: staleAttempt.id,
    owner_id: "orch_test",
    status: "active",
    started_at: "2026-04-01T10:00:00.000Z",
    heartbeat_at: "2026-04-01T10:00:05.000Z",
    released_at: null
  });
  await saveAttemptRuntimeState(
    workspacePaths,
    createAttemptRuntimeState({
      run_id: staleRun.id,
      attempt_id: staleAttempt.id,
      running: true,
      phase: "tool",
      active_since: "2026-04-01T10:00:00.000Z",
      last_event_at: "2026-04-01T10:00:05.000Z",
      progress_text: "Still running old work."
    })
  );
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: staleRun.id,
      run_status: "running",
      latest_attempt_id: staleAttempt.id,
      recommended_next_action: "continue_research",
      recommended_attempt_type: "research",
      summary: "Old self-bootstrap run is still marked running."
    })
  );

  const app = await buildServer({
    runtimeRepoRoot: sourceRoot,
    devRepoRoot: repoRoot,
    runtimeDataRoot,
    managedWorkspaceRoot,
    startOrchestrator: false
  });
  const apiBaseUrl = await app.listen({
    host: "127.0.0.1",
    port: 0
  });
  const supervisorStateFile = join(runtimeDataRoot, "artifacts", "self-bootstrap-supervisor-state.json");

  try {
    const statePayload = {
      version: 1,
      started_at: "2026-04-01T10:00:00.000Z",
      updated_at: "2026-04-01T10:00:00.000Z",
      active_run_id: activeRun.id,
      supervised_run_ids: [activeRun.id, staleRun.id],
      completed_attempt_keys: [],
      control_api: {
        base_url: apiBaseUrl,
        status: "reachable",
        last_ok_at: "2026-04-01T10:00:00.000Z",
        last_error: null,
        last_launch_requested_at: null,
        last_launch_pid: null
      },
      repair_log: []
    };
    await writeFile(supervisorStateFile, `${JSON.stringify(statePayload, null, 2)}\n`, "utf8");

    const supervisorResult = await runTsxScript({
      cwd: sourceRoot,
      sourceRoot,
      scriptPath: join(sourceRoot, "scripts", "supervise-self-bootstrap.ts"),
      args: [
        "--once",
        "--api-base-url",
        apiBaseUrl,
        "--run-id",
        activeRun.id,
        "--state-file",
        supervisorStateFile
      ],
      extraEnv: {
        AISA_RUNTIME_REPO_ROOT: sourceRoot,
        AISA_DEV_REPO_ROOT: repoRoot,
        AISA_RUNTIME_DATA_ROOT: runtimeDataRoot,
        AISA_MANAGED_WORKSPACE_ROOT: managedWorkspaceRoot
      }
    });
    assert.equal(
      supervisorResult.exitCode,
      0,
      formatScriptFailure("scripts/supervise-self-bootstrap.ts", supervisorResult)
    );
  } finally {
    await app.close();
  }

  const [staleCurrent, staleAttempts, staleJournal, staleHeartbeat, staleRuntimeState, automation, state] =
    await Promise.all([
      getCurrentDecision(workspacePaths, staleRun.id),
      listAttempts(workspacePaths, staleRun.id),
      listRunJournal(workspacePaths, staleRun.id),
      getAttemptHeartbeat(workspacePaths, staleRun.id, staleAttempt.id),
      getAttemptRuntimeState(workspacePaths, staleRun.id, staleAttempt.id),
      getRunAutomationControl(workspacePaths, staleRun.id),
      readFile(supervisorStateFile, "utf8").then((content) => JSON.parse(content) as {
        active_run_id?: string | null;
        repair_log?: Array<{ action?: string; detail?: string }>;
      })
    ]);

  assert.equal(staleCurrent?.run_status, "waiting_steer");
  assert.equal(staleCurrent?.waiting_for_human, true);
  assert.match(
    staleCurrent?.blocking_reason ?? "",
    new RegExp(activeRun.id),
    "stale run should explain which active self-bootstrap run superseded it"
  );
  assert.equal(staleAttempts[0]?.status, "stopped");
  assert.equal(staleHeartbeat?.status, "released");
  assert.equal(staleRuntimeState?.running, false);
  assert.equal(staleRuntimeState?.phase, "stopped");
  assert.equal(
    automation?.mode,
    "manual_only",
    "superseded self-bootstrap run should persist a manual-only automation gate"
  );
  assert.equal(
    automation?.reason_code,
    "superseded_self_bootstrap_run",
    "superseded self-bootstrap run should record why automation was disabled"
  );
  assert.ok(
    staleJournal.some((entry) => entry.type === "attempt.stopped"),
    "stale running attempt should be explicitly stopped"
  );
  assert.ok(
    staleJournal.some((entry) => entry.type === "run.self_bootstrap.superseded"),
    "stale run should record the superseded transition"
  );
  assert.equal(state.active_run_id, activeRun.id);
  assert.ok(
    state.repair_log?.some(
      (entry) =>
        entry.action === "suspend_superseded_self_bootstrap_run" &&
        entry.detail === `active=${activeRun.id}`
    ),
    "supervisor state should record the superseded-run cleanup"
  );

  return {
    suspended_run_id: staleRun.id,
    active_run_id: activeRun.id,
    stopped_attempt_id: staleAttempt.id
  };
}

async function main(): Promise<void> {
  try {
    await assertRootEntrypointsUseNodeImportTsx();

    const sourceRoot = resolveSourceRoot();
    const publishedActiveTask = await loadPublishedActiveTaskFixture(sourceRoot);
    const rootDir = await createTrackedVerifyTempDir("aisa-self-bootstrap-", {
      useSystemTempRoot: true
    });
    const workspacePaths = resolveWorkspacePaths(rootDir);
    await ensureWorkspace(workspacePaths);
    await seedSelfBootstrapActiveTask(rootDir, publishedActiveTask.content);
    const bootstrapResult = await runTsxScript({
      cwd: rootDir,
      sourceRoot,
      scriptPath: join(sourceRoot, "scripts", "bootstrap-self-run.ts"),
      args: [
        "--owner",
        "test-owner",
        "--focus",
        "Use runtime evidence to choose the next backend step."
      ],
      extraEnv: {
        AISA_DEV_REPO_ROOT: rootDir,
        AISA_RUNTIME_DATA_ROOT: rootDir,
        AISA_RUNTIME_REPO_ROOT: sourceRoot
      }
    });
    assert.equal(
      bootstrapResult.exitCode,
      0,
      formatScriptFailure("scripts/bootstrap-self-run.ts", bootstrapResult)
    );
    const bootstrapOutput = parseJsonStdout<BootstrapOutput>(
      "scripts/bootstrap-self-run.ts",
      bootstrapResult.stdout
    );
    const run = await getRun(workspacePaths, bootstrapOutput.run_id);

  const orchestrator = new Orchestrator(
    workspacePaths,
    new NoopAdapter() as never,
    undefined,
    60_000
  );
  await orchestrator.tick();
  await sleep(50);
  await orchestrator.tick();

  const persistedCurrent = await getCurrentDecision(workspacePaths, run.id);
  const firstAttemptState = await waitForFirstAttemptContext({
    workspacePaths,
    runId: run.id
  });
  const attempts = firstAttemptState.attempts;
  const steers = await listRunSteers(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);
  const runtimeHealthSnapshot = await getRunRuntimeHealthSnapshot(
    workspacePaths,
    run.id
  );
  const firstAttemptContext = firstAttemptState.context;

  assert.equal(await realpath(run.workspace_root), await realpath(rootDir));
  assert.equal(run.owner_id, "test-owner");
  assert.equal(run.title, "AISA 自举下一步规划");
  assert.match(run.description, /自举开发/);
  assert.equal(run.success_criteria[0], "确定下一项该做的具体后端或运行时任务。");
  assert.equal(run.harness_profile.version, 3);
  assert.equal(run.harness_profile.execution.effort, "high");
  assert.equal(run.harness_profile.execution.default_verifier_kit, "repo");
  assert.equal(run.harness_profile.reviewer.effort, "medium");
  assert.equal(run.harness_profile.synthesizer.effort, "medium");
  assert.equal(run.harness_profile.gates.preflight_review.mode, "required");
  assert.equal(run.harness_profile.gates.deterministic_runtime.mode, "required");
  assert.equal(run.harness_profile.gates.postflight_adversarial.mode, "required");
  assert.equal(bootstrapOutput.current_status, "running");
  assert.equal(bootstrapOutput.launched, true);
  assert.equal(bootstrapOutput.template, "self-bootstrap");
  assert.equal(
    bootstrapOutput.active_next_task,
    SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH
  );
  assert.ok(
    bootstrapOutput.active_next_task_snapshot.endsWith(
      SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME
    ),
    "bootstrap output should expose the active next task snapshot path"
  );
  assert.ok(
    bootstrapOutput.runtime_health_snapshot.endsWith("runtime-health-snapshot.json"),
    "bootstrap output should expose the runtime health snapshot path"
  );
  assert.equal(persistedCurrent?.run_status, "running");
  assert.equal(steers.length, 1);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.attempt_type, "research");
  assert.ok(runtimeHealthSnapshot, "self-bootstrap should persist runtime health snapshot");
  assert.equal(
    runtimeHealthSnapshot?.workspace_root
      ? await realpath(runtimeHealthSnapshot.workspace_root)
      : null,
    await realpath(rootDir)
  );
  assert.equal(runtimeHealthSnapshot?.evidence_root, sourceRoot);
  assert.equal(runtimeHealthSnapshot?.verify_runtime.status, "passed");
  assert.equal(
    runtimeHealthSnapshot?.history_contract_drift.status,
    "ok"
  );
  assert.equal(runtimeHealthSnapshot?.history_contract_drift.drift_count, 0);
  assert.ok(
    !steers[0]?.content.includes("Codex/2026-03-25-development-handoff.md"),
    "seeded steer should not fall back to the old handoff document as the first source"
  );
  assert.ok(
    steers[0]?.content.includes(SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH),
    "seeded steer should point to the published active next task"
  );
  assert.ok(
    steers[0]?.content.includes(publishedActiveTask.title),
    "seeded steer should carry the active next task title"
  );
  assert.ok(
    steers[0]?.content.includes(publishedActiveTask.sourceAnchorAssetPath),
    "seeded steer should carry the active next task source anchor"
  );
  assert.ok(
    steers[0]?.content.includes("先看 context 里的 runtime_health_snapshot 结构化摘要。"),
    "seeded steer should prefer the structured runtime health snapshot in context"
  );
  assert.ok(
    steers[0]?.content.includes(bootstrapOutput.runtime_health_snapshot),
    "seeded steer should point to the runtime health snapshot path"
  );
  assert.ok(
    attempts[0]?.objective.includes("先看 context 里的 runtime_health_snapshot 结构化摘要。"),
    "first attempt should prefer structured runtime evidence over guessed file paths"
  );
  assert.ok(
    !attempts[0]?.objective.includes("Codex/2026-03-25-development-handoff.md"),
    "first attempt should not regress to the old handoff document"
  );
  assert.ok(
    attempts[0]?.objective.includes(SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH),
    "first attempt should reference the published active next task"
  );
  assert.ok(
    attempts[0]?.objective.includes(publishedActiveTask.title),
    "first attempt should carry the active next task title"
  );
  assert.ok(
    attempts[0]?.objective.includes(publishedActiveTask.sourceAnchorAssetPath),
    "first attempt should carry the active next task source anchor"
  );
  assert.ok(
    steers[0]?.content.includes("ok"),
    "seeded steer should carry the history drift status"
  );
  assert.ok(
    attempts[0]?.objective.includes("人工指令："),
    "first attempt should incorporate the seeded steer in Chinese"
  );
  assert.ok(
    attempts[0]?.objective.includes("Use runtime evidence"),
    "first attempt should keep the self-bootstrap focus"
  );
  assert.ok(
    attempts[0]?.objective.includes(bootstrapOutput.runtime_health_snapshot),
    "first attempt should reference the persisted runtime health snapshot"
  );
  assert.ok(
    attempts[0]?.objective.includes("ok"),
    "first attempt should carry the runtime drift status from the snapshot"
  );
  assert.deepEqual(
    firstAttemptContext?.runtime_health_snapshot,
    {
      path: join("runs", run.id, "artifacts", "runtime-health-snapshot.json"),
      verify_runtime: {
        status: "passed",
        summary: runtimeHealthSnapshot?.verify_runtime.summary
      },
      history_contract_drift: {
        status: "ok",
        summary: runtimeHealthSnapshot?.history_contract_drift.summary,
        drift_count: 0
      },
      created_at: runtimeHealthSnapshot?.created_at
    },
    "first attempt context should carry the runtime health snapshot summary"
  );
  assert.deepEqual(
    firstAttemptContext?.active_next_task,
    {
      path: SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH,
      snapshot_path: join(
        "runs",
        run.id,
        "artifacts",
        SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME
      ),
      updated_at: publishedActiveTask.updatedAt,
      title: publishedActiveTask.title,
      summary: publishedActiveTask.summary,
      source_anchor: publishedActiveTask.sourceAnchor
    },
    "first attempt context should carry the published active next task summary"
  );
  const attemptContract = attempts[0]
    ? await getAttemptContract(workspacePaths, run.id, attempts[0].id)
    : null;
  assert.ok(attemptContract, "first attempt should persist attempt_contract.json");
  assert.deepEqual(
    attemptContract?.required_evidence ?? [],
    [
      "Ground findings in concrete files, commands, or artifacts.",
      "If execution is recommended, leave a replayable execution contract for the next attempt."
    ],
    "research attempt contract should enforce grounded evidence and execution readiness"
  );
  assert.ok(
    journal.some((entry) => entry.type === "run.steer.queued"),
    "journal should record the seeded steer"
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.self_bootstrap.active_next_task.captured" &&
        entry.payload.published_path ===
          SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH &&
        entry.payload.snapshot_path === bootstrapOutput.active_next_task_snapshot
    ),
    "journal should record the captured active next task artifact"
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.runtime_health_snapshot.captured" &&
        entry.payload.path === bootstrapOutput.runtime_health_snapshot
    ),
    "journal should record the runtime health snapshot artifact"
  );

    const missingActiveTaskRoot = await createTrackedVerifyTempDir(
      "aisa-self-bootstrap-missing-"
    );
    const missingActiveTaskResult = await runTsxScript({
      cwd: missingActiveTaskRoot,
      sourceRoot,
      scriptPath: join(sourceRoot, "scripts", "bootstrap-self-run.ts"),
      args: [
        "--owner",
        "test-owner",
        "--focus",
        "Use runtime evidence to choose the next backend step."
      ],
      extraEnv: {
        AISA_DEV_REPO_ROOT: missingActiveTaskRoot,
        AISA_RUNTIME_DATA_ROOT: missingActiveTaskRoot,
        AISA_RUNTIME_REPO_ROOT: sourceRoot
      }
    });
    assert.notEqual(
      missingActiveTaskResult.exitCode,
      0,
      "bootstrap:self should fail closed when the published active next task is missing"
    );
    assert.match(
      missingActiveTaskResult.stderr,
      /self-bootstrap-next-runtime-task-active\.json/,
      "missing active next task failure should mention the published asset"
    );

    const invalidActiveTaskRoot = await createTrackedVerifyTempDir(
      "aisa-self-bootstrap-invalid-"
    );
    await seedSelfBootstrapActiveTask(
      invalidActiveTaskRoot,
      JSON.stringify(
        {
          entry_type: "self_bootstrap_next_runtime_task_active",
          updated_at: "2026-03-31T00:00:00Z",
          source_anchor: {
            asset_path: "Codex/bad.json"
          },
          summary: "broken"
        },
        null,
        2
      ) + "\n"
    );
    const invalidActiveTaskResult = await runTsxScript({
      cwd: invalidActiveTaskRoot,
      sourceRoot,
      scriptPath: join(sourceRoot, "scripts", "bootstrap-self-run.ts"),
      args: [
        "--owner",
        "test-owner",
        "--focus",
        "Use runtime evidence to choose the next backend step."
      ],
      extraEnv: {
        AISA_DEV_REPO_ROOT: invalidActiveTaskRoot,
        AISA_RUNTIME_DATA_ROOT: invalidActiveTaskRoot,
        AISA_RUNTIME_REPO_ROOT: sourceRoot
      }
    });
    assert.notEqual(
      invalidActiveTaskResult.exitCode,
      0,
      "bootstrap:self should fail closed when the published active next task is malformed"
    );
    assert.match(
      invalidActiveTaskResult.stderr,
      /\.title/,
      "invalid active next task failure should mention the broken required field"
    );

    const missingExecutionSnapshotBlock =
      await assertMissingActiveSnapshotBlocksRunInsteadOfCrashing();
    const supervisorSchemaRepair =
      await assertSupervisorRepairsWorkerOutputSchemaBlocker(sourceRoot);
    const pinnedRunRotation =
      await assertSupervisorDoesNotKeepRotatingPinnedRun(sourceRoot);
    const supersededRunCleanup =
      await assertSupervisorSuspendsSupersededSelfBootstrapRuns(sourceRoot);

    console.log(
      JSON.stringify(
        {
          run_id: run.id,
          attempt_id: attempts[0]?.id ?? null,
          objective: attempts[0]?.objective ?? null,
          active_next_task: bootstrapOutput.active_next_task,
          active_next_task_snapshot: bootstrapOutput.active_next_task_snapshot,
          runtime_health_snapshot: bootstrapOutput.runtime_health_snapshot,
          drift_count: runtimeHealthSnapshot?.history_contract_drift.drift_count ?? null,
          missing_active_next_task_exit_code: missingActiveTaskResult.exitCode,
          invalid_active_next_task_exit_code: invalidActiveTaskResult.exitCode,
          missing_execution_snapshot_blocked_message:
            missingExecutionSnapshotBlock.blocked_message,
          repair_steer_id: supervisorSchemaRepair.repair_steer_id,
          repair_state_action: supervisorSchemaRepair.repair_state_action,
          first_rotated_run_id: pinnedRunRotation.first_rotated_run_id,
          second_cycle_active_run_id: pinnedRunRotation.second_cycle_active_run_id,
          suspended_run_id: supersededRunCleanup.suspended_run_id,
          suspended_attempt_id: supersededRunCleanup.stopped_attempt_id,
          cleanup_active_run_id: supersededRunCleanup.active_run_id
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
