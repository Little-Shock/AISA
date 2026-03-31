import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Attempt,
  type Run,
  type WorkerWriteback
} from "../packages/domain/src/index.ts";
import {
  Orchestrator,
  SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH,
  SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME
} from "../packages/orchestrator/src/index.ts";
import {
  ensureWorkspace,
  getAttemptContract,
  getAttemptContext,
  getCurrentDecision,
  getRun,
  getRunRuntimeHealthSnapshot,
  listAttempts,
  listRunJournal,
  listRunSteers,
  resolveWorkspacePaths,
} from "../packages/state-store/src/index.ts";

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

async function main(): Promise<void> {
  await assertRootEntrypointsUseNodeImportTsx();

  const sourceRoot = resolveSourceRoot();
  const publishedActiveTask = await loadPublishedActiveTaskFixture(sourceRoot);
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-self-bootstrap-"));
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

  const missingActiveTaskRoot = await mkdtemp(
    join(tmpdir(), "aisa-self-bootstrap-missing-")
  );
  const missingActiveTaskResult = await runTsxScript({
    cwd: missingActiveTaskRoot,
    sourceRoot,
    scriptPath: join(sourceRoot, "scripts", "bootstrap-self-run.ts"),
    args: ["--owner", "test-owner", "--focus", "Use runtime evidence to choose the next backend step."],
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

  const invalidActiveTaskRoot = await mkdtemp(
    join(tmpdir(), "aisa-self-bootstrap-invalid-")
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
    args: ["--owner", "test-owner", "--focus", "Use runtime evidence to choose the next backend step."],
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
        invalid_active_next_task_exit_code: invalidActiveTaskResult.exitCode
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
