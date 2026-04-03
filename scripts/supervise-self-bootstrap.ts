import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRunAutomationControl,
  createRunJournalEntry,
  updateAttempt,
  updateAttemptRuntimeState,
  updateCurrentDecision,
  type Attempt,
  type CurrentDecision,
  type Run,
  type RunJournalEntry
} from "../packages/domain/src/index.js";
import {
  assessRunHealth,
  refreshRunOperatorSurface,
  resolveRuntimeLayout,
  syncRuntimeLayoutHint
} from "../packages/orchestrator/src/index.ts";
import {
  appendRunJournal,
  ensureWorkspace,
  getAttemptHeartbeat,
  getAttemptRuntimeState,
  getCurrentDecision,
  getRun,
  getRunAutomationControl,
  listAttempts,
  listRunJournal,
  listRuns,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptHeartbeat,
  saveAttemptRuntimeState,
  saveCurrentDecision,
  saveRunAutomationControl
} from "../packages/state-store/src/index.js";

type CliOptions = {
  apiBaseUrl: string;
  focus?: string;
  once: boolean;
  ownerId: string;
  pollMs: number;
  runId?: string;
  staleAttemptMs: number;
  stateFile?: string;
  targetCompletedAttempts: number;
  waitingRelaunchMs: number;
};

type ControlApiState = {
  base_url: string;
  status: "unknown" | "reachable" | "recovering" | "unreachable";
  last_ok_at: string | null;
  last_error: string | null;
  last_launch_requested_at: string | null;
  last_launch_pid: number | null;
};

type SupervisorState = {
  version: 1;
  started_at: string;
  updated_at: string;
  active_run_id: string | null;
  supervised_run_ids: string[];
  completed_attempt_keys: string[];
  control_api: ControlApiState;
  repair_log: Array<{
    ts: string;
    run_id: string;
    action: string;
    detail: string;
  }>;
};

type RunSnapshot = {
  run: Run;
  current: CurrentDecision | null;
  automation: Awaited<ReturnType<typeof getRunAutomationControl>>;
  attempts: Attempt[];
  journal: RunJournalEntry[];
  latestAttempt: Attempt | null;
  latestHeartbeat: Awaited<ReturnType<typeof getAttemptHeartbeat>>;
  latestRuntimeState: Awaited<ReturnType<typeof getAttemptRuntimeState>>;
};

type WorkerOutputSchemaBlocker = {
  attemptId: string | null;
  message: string;
  fieldPath: string | null;
  repairHint: string | null;
  rawOutputFile: string | null;
  signature: string;
};

type JsonResponse<T> = T & {
  message?: string;
};

type ControlApiHealthResponse = {
  status: string;
  degraded_run_count?: number;
};

const DEFAULT_OWNER_ID = "atou";
const DEFAULT_TARGET_COMPLETED_ATTEMPTS = 40;
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_STALE_ATTEMPT_MS = 180_000;
const DEFAULT_WAITING_RELAUNCH_MS = 45_000;
const CONTROL_API_READY_TIMEOUT_MS = 15_000;
const CONTROL_API_POLL_MS = 400;
const MAX_REPAIR_LOG_ENTRIES = 200;
const SELF_BOOTSTRAP_RUN_TITLE = "AISA 自举下一步规划";

function parseArgs(argv: string[]): CliOptions {
  const defaultPort = process.env.CONTROL_API_PORT ?? process.env.PORT ?? "8787";
  const defaultHost = process.env.CONTROL_API_HOST ?? process.env.HOST ?? "127.0.0.1";
  const options: CliOptions = {
    apiBaseUrl: process.env.AISA_CONTROL_API_URL ?? `http://${defaultHost}:${defaultPort}`,
    once: false,
    ownerId: DEFAULT_OWNER_ID,
    pollMs: DEFAULT_POLL_MS,
    staleAttemptMs: DEFAULT_STALE_ATTEMPT_MS,
    targetCompletedAttempts: DEFAULT_TARGET_COMPLETED_ATTEMPTS,
    waitingRelaunchMs: DEFAULT_WAITING_RELAUNCH_MS
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      continue;
    }

    if (token === "--api-base-url" && argv[index + 1]) {
      options.apiBaseUrl = argv[index + 1]!;
      index += 1;
      continue;
    }

    if (token === "--focus" && argv[index + 1]) {
      options.focus = argv[index + 1]!;
      index += 1;
      continue;
    }

    if (token === "--once") {
      options.once = true;
      continue;
    }

    if (token === "--owner" && argv[index + 1]) {
      options.ownerId = argv[index + 1]!;
      index += 1;
      continue;
    }

    if (token === "--poll-ms" && argv[index + 1]) {
      options.pollMs = parsePositiveInt(argv[index + 1]!, "--poll-ms");
      index += 1;
      continue;
    }

    if (token === "--run-id" && argv[index + 1]) {
      options.runId = argv[index + 1]!;
      index += 1;
      continue;
    }

    if (token === "--stale-attempt-ms" && argv[index + 1]) {
      options.staleAttemptMs = parsePositiveInt(argv[index + 1]!, "--stale-attempt-ms");
      index += 1;
      continue;
    }

    if (token === "--state-file" && argv[index + 1]) {
      options.stateFile = argv[index + 1]!;
      index += 1;
      continue;
    }

    if (token === "--target-completed-attempts" && argv[index + 1]) {
      options.targetCompletedAttempts = parsePositiveInt(
        argv[index + 1]!,
        "--target-completed-attempts"
      );
      index += 1;
      continue;
    }

    if (token === "--waiting-relaunch-ms" && argv[index + 1]) {
      options.waitingRelaunchMs = parsePositiveInt(
        argv[index + 1]!,
        "--waiting-relaunch-ms"
      );
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function parsePositiveInt(raw: string, flag: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} expects a positive integer, got: ${raw}`);
  }
  return value;
}

function resolveRepositoryRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function isSelfBootstrapRun(run: Run): boolean {
  return run.title === SELF_BOOTSTRAP_RUN_TITLE;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logLine(message: string): void {
  console.log(`[${nowIso()}] ${message}`);
}

function createInitialControlApiState(baseUrl: string): ControlApiState {
  return {
    base_url: baseUrl,
    status: "unknown",
    last_ok_at: null,
    last_error: null,
    last_launch_requested_at: null,
    last_launch_pid: null
  };
}

async function loadSupervisorState(stateFile: string): Promise<SupervisorState | null> {
  try {
    const raw = await readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<SupervisorState>;
    if (parsed.version !== 1) {
      throw new Error(`Unsupported supervisor state version: ${String(parsed.version)}`);
    }
    if (!Array.isArray(parsed.supervised_run_ids) || !Array.isArray(parsed.completed_attempt_keys)) {
      throw new Error("Supervisor state is missing array fields.");
    }
    if (!Array.isArray(parsed.repair_log)) {
      throw new Error("Supervisor state is missing repair_log.");
    }
    return {
      version: 1,
      started_at: String(parsed.started_at),
      updated_at: String(parsed.updated_at),
      active_run_id:
        typeof parsed.active_run_id === "string" ? parsed.active_run_id : null,
      supervised_run_ids: parsed.supervised_run_ids.map((entry) => String(entry)),
      completed_attempt_keys: parsed.completed_attempt_keys.map((entry) => String(entry)),
      control_api:
        parsed.control_api &&
        typeof parsed.control_api === "object" &&
        !Array.isArray(parsed.control_api)
          ? {
              base_url:
                typeof parsed.control_api.base_url === "string"
                  ? parsed.control_api.base_url
                  : "",
              status:
                parsed.control_api.status === "reachable" ||
                parsed.control_api.status === "recovering" ||
                parsed.control_api.status === "unreachable" ||
                parsed.control_api.status === "unknown"
                  ? parsed.control_api.status
                  : "unknown",
              last_ok_at:
                typeof parsed.control_api.last_ok_at === "string"
                  ? parsed.control_api.last_ok_at
                  : null,
              last_error:
                typeof parsed.control_api.last_error === "string"
                  ? parsed.control_api.last_error
                  : null,
              last_launch_requested_at:
                typeof parsed.control_api.last_launch_requested_at === "string"
                  ? parsed.control_api.last_launch_requested_at
                  : null,
              last_launch_pid:
                typeof parsed.control_api.last_launch_pid === "number"
                  ? parsed.control_api.last_launch_pid
                  : null
            }
          : createInitialControlApiState(""),
      repair_log: parsed.repair_log.map((entry) => ({
        ts: String(entry.ts),
        run_id: String(entry.run_id),
        action: String(entry.action),
        detail: String(entry.detail)
      }))
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function saveSupervisorState(stateFile: string, state: SupervisorState): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function createInitialSupervisorState(apiBaseUrl: string): SupervisorState {
  const ts = nowIso();
  return {
    version: 1,
    started_at: ts,
    updated_at: ts,
    active_run_id: null,
    supervised_run_ids: [],
    completed_attempt_keys: [],
    control_api: createInitialControlApiState(apiBaseUrl),
    repair_log: []
  };
}

function recordRepair(
  state: SupervisorState,
  runId: string,
  action: string,
  detail: string
): void {
  state.repair_log.push({
    ts: nowIso(),
    run_id: runId,
    action,
    detail
  });
  if (state.repair_log.length > MAX_REPAIR_LOG_ENTRIES) {
    state.repair_log.splice(0, state.repair_log.length - MAX_REPAIR_LOG_ENTRIES);
  }
}

function trackRun(state: SupervisorState, runId: string): void {
  if (!state.supervised_run_ids.includes(runId)) {
    state.supervised_run_ids.push(runId);
  }
  state.active_run_id = runId;
}

function trackCompletedAttempts(state: SupervisorState, snapshot: RunSnapshot): number {
  for (const attempt of snapshot.attempts) {
    if (attempt.status !== "completed") {
      continue;
    }
    const key = `${snapshot.run.id}:${attempt.id}`;
    if (!state.completed_attempt_keys.includes(key)) {
      state.completed_attempt_keys.push(key);
    }
  }

  return state.completed_attempt_keys.length;
}

async function postJson<TResponse>(
  apiBaseUrl: string,
  path: string,
  body?: unknown
): Promise<JsonResponse<TResponse>> {
  const response = await fetch(new URL(path, apiBaseUrl), {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const payload = text.length > 0 ? (JSON.parse(text) as JsonResponse<TResponse>) : ({} as JsonResponse<TResponse>);

  if (!response.ok) {
    const message =
      typeof payload.message === "string" && payload.message.length > 0
        ? payload.message
        : `HTTP ${response.status} ${response.statusText}`;
    throw new Error(`${path} failed: ${message}`);
  }

  return payload;
}

async function getJson<TResponse>(
  apiBaseUrl: string,
  path: string
): Promise<JsonResponse<TResponse>> {
  const response = await fetch(new URL(path, apiBaseUrl));
  const text = await response.text();
  const payload = text.length > 0 ? (JSON.parse(text) as JsonResponse<TResponse>) : ({} as JsonResponse<TResponse>);

  if (!response.ok) {
    const message =
      typeof payload.message === "string" && payload.message.length > 0
        ? payload.message
        : `HTTP ${response.status} ${response.statusText}`;
    throw new Error(`${path} failed: ${message}`);
  }

  return payload;
}

function normalizeControlApiState(
  state: SupervisorState,
  apiBaseUrl: string
): ControlApiState {
  if (!state.control_api || state.control_api.base_url !== apiBaseUrl) {
    state.control_api = createInitialControlApiState(apiBaseUrl);
  }

  return state.control_api;
}

async function fetchControlApiHealth(apiBaseUrl: string): Promise<ControlApiHealthResponse> {
  return await getJson<ControlApiHealthResponse>(apiBaseUrl, "/health");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildControlApiLogPath(runtimeDataRoot: string): string {
  return join(runtimeDataRoot, "artifacts", "control-api-supervisor.log");
}

async function startControlApiSupervisor(input: {
  runtimeRepoRoot: string;
  runtimeDataRoot: string;
}): Promise<number | null> {
  await mkdir(join(input.runtimeDataRoot, "artifacts"), { recursive: true });
  const logPath = buildControlApiLogPath(input.runtimeDataRoot);
  const logFd = openSync(logPath, "a");

  try {
    const child = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--loader",
        "./scripts/ts-runtime-loader.mjs",
        "apps/control-api/src/supervisor.ts"
      ],
      {
        cwd: input.runtimeRepoRoot,
        env: process.env,
        detached: true,
        stdio: ["ignore", logFd, logFd]
      }
    );
    child.unref();
    return child.pid ?? null;
  } finally {
    closeSync(logFd);
  }
}

async function waitForControlApiHealth(
  apiBaseUrl: string,
  timeoutMs: number,
  pollMs: number
): Promise<ControlApiHealthResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      return await fetchControlApiHealth(apiBaseUrl);
    } catch (error) {
      lastError = error;
      await sleep(pollMs);
    }
  }

  throw new Error(
    `control-api did not become reachable at ${apiBaseUrl} within ${timeoutMs}ms: ${describeError(lastError)}`
  );
}

async function ensureControlApiAvailable(input: {
  runtimeRepoRoot: string;
  runtimeDataRoot: string;
  apiBaseUrl: string;
  state: SupervisorState;
}): Promise<ControlApiHealthResponse> {
  const controlApiState = normalizeControlApiState(input.state, input.apiBaseUrl);

  try {
    const health = await fetchControlApiHealth(input.apiBaseUrl);
    controlApiState.status = "reachable";
    controlApiState.last_ok_at = nowIso();
    controlApiState.last_error = null;
    return health;
  } catch (error) {
    controlApiState.status = "unreachable";
    controlApiState.last_error = describeError(error);
  }

  const lastLaunchAgeMs = ageMs(controlApiState.last_launch_requested_at);
  if (lastLaunchAgeMs === null || lastLaunchAgeMs > CONTROL_API_READY_TIMEOUT_MS) {
    const pid = await startControlApiSupervisor({
      runtimeRepoRoot: input.runtimeRepoRoot,
      runtimeDataRoot: input.runtimeDataRoot
    });
    controlApiState.status = "recovering";
    controlApiState.last_launch_requested_at = nowIso();
    controlApiState.last_launch_pid = pid;
    recordRepair(
      input.state,
      input.state.active_run_id ?? "control-api",
      "start_control_api",
      `control-api unreachable at ${input.apiBaseUrl}; requested restart pid=${pid ?? "unknown"}`
    );
    logLine(`control-api 不可用，已请求重启 pid=${pid ?? "unknown"}`);
  }

  const health = await waitForControlApiHealth(
    input.apiBaseUrl,
    CONTROL_API_READY_TIMEOUT_MS,
    CONTROL_API_POLL_MS
  );
  controlApiState.status = "reachable";
  controlApiState.last_ok_at = nowIso();
  controlApiState.last_error = null;
  return health;
}

async function createSelfBootstrapRun(
  apiBaseUrl: string,
  options: Pick<CliOptions, "focus" | "ownerId">
): Promise<string> {
  const payload = await postJson<{
    run: Run;
  }>(apiBaseUrl, "/runs/self-bootstrap", {
    owner_id: options.ownerId,
    focus: options.focus,
    launch: true,
    seed_steer: true
  });

  return payload.run.id;
}

async function launchRun(apiBaseUrl: string, runId: string): Promise<void> {
  await postJson(apiBaseUrl, `/runs/${runId}/launch`);
}

async function queueRunSteer(input: {
  apiBaseUrl: string;
  runId: string;
  attemptId?: string | null;
  content: string;
}): Promise<void> {
  await postJson(input.apiBaseUrl, `/runs/${input.runId}/steers`, {
    content: input.content,
    attempt_id: input.attemptId ?? null
  });
}

async function resolveGitRepoRoot(workspaceRoot: string): Promise<string | null> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", workspaceRoot, "rev-parse", "--show-toplevel"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
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
      if (exitCode === 0) {
        resolve(stdout.trim());
        return;
      }

      if (stderr.includes("not a git repository")) {
        resolve(null);
        return;
      }

      reject(new Error(`git rev-parse failed for ${workspaceRoot}: ${stderr.trim()}`));
    });
  });
}

async function repairManagedWorkspaceNodeModules(run: Run): Promise<{
  status: "repaired" | "skipped";
  detail: string;
}> {
  if (!run.managed_workspace_root) {
    return {
      status: "skipped",
      detail: "run 还没有 managed workspace"
    };
  }

  const sourceRepoRoot = await resolveGitRepoRoot(run.workspace_root);
  const managedRepoRoot = await resolveGitRepoRoot(run.managed_workspace_root);
  if (!sourceRepoRoot || !managedRepoRoot) {
    throw new Error(`无法解析 run ${run.id} 的 git worktree 根目录`);
  }

  const sourceNodeModulesPath = join(sourceRepoRoot, "node_modules");
  const sourceNodeModulesStat = await stat(sourceNodeModulesPath).catch(() => null);
  if (!sourceNodeModulesStat?.isDirectory()) {
    throw new Error(`源仓库 ${sourceRepoRoot} 没有可复用的 node_modules`);
  }

  const managedNodeModulesPath = join(managedRepoRoot, "node_modules");
  const managedNodeModulesStat = await lstat(managedNodeModulesPath).catch(() => null);
  if (managedNodeModulesStat) {
    return {
      status: "skipped",
      detail: `${managedNodeModulesPath} 已存在`
    };
  }

  await symlink(sourceNodeModulesPath, managedNodeModulesPath, "dir");
  return {
    status: "repaired",
    detail: `已把 ${managedNodeModulesPath} 链接到 ${sourceNodeModulesPath}`
  };
}

async function loadRunSnapshot(
  runtimeDataRoot: string,
  runId: string
): Promise<RunSnapshot> {
  const workspacePaths = resolveWorkspacePaths(runtimeDataRoot);
  const run = await getRun(workspacePaths, runId);
  const [current, automation, attempts, journal] = await Promise.all([
    getCurrentDecision(workspacePaths, runId),
    getRunAutomationControl(workspacePaths, runId),
    listAttempts(workspacePaths, runId),
    listRunJournal(workspacePaths, runId)
  ]);
  const latestAttempt = attempts.at(-1) ?? null;
  const latestHeartbeat = latestAttempt
    ? await getAttemptHeartbeat(workspacePaths, runId, latestAttempt.id)
    : null;
  const latestRuntimeState = latestAttempt
    ? await getAttemptRuntimeState(workspacePaths, runId, latestAttempt.id)
    : null;

  return {
    run,
    current,
    automation,
    attempts,
    journal,
    latestAttempt,
    latestHeartbeat,
    latestRuntimeState
  };
}

async function findLatestSelfBootstrapRunId(workspaceRoot: string): Promise<string | null> {
  const workspacePaths = resolveWorkspacePaths(workspaceRoot);
  const runs = await listRuns(workspacePaths);
  const latest = runs.find((run) => isSelfBootstrapRun(run)) ?? null;
  return latest?.id ?? null;
}

function lastJournalEvent(snapshot: RunSnapshot, type: string): RunJournalEntry | null {
  for (let index = snapshot.journal.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.journal[index]!;
    if (entry.type === type) {
      return entry;
    }
  }
  return null;
}

function isAutoResumeResetBoundary(type: string): boolean {
  return (
    type === "run.steer.queued" ||
    type === "run.launched" ||
    type === "run.manual_recovery" ||
    type === "attempt.checkpoint.created"
  );
}

function hasRecentJournalEventSinceReset(
  snapshot: RunSnapshot,
  type: string
): boolean {
  for (let index = snapshot.journal.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.journal[index];
    if (!entry) {
      continue;
    }

    if (isAutoResumeResetBoundary(entry.type)) {
      return false;
    }

    if (entry.type === type) {
      return true;
    }
  }

  return false;
}

function getMostRecentActivityTs(snapshot: RunSnapshot): string | null {
  return (
    snapshot.latestHeartbeat?.heartbeat_at ??
    snapshot.latestRuntimeState?.updated_at ??
    snapshot.latestRuntimeState?.last_event_at ??
    snapshot.current?.updated_at ??
    snapshot.latestAttempt?.started_at ??
    snapshot.run.updated_at
  );
}

function ageMs(ts: string | null): number | null {
  if (!ts) {
    return null;
  }
  const time = Date.parse(ts);
  if (Number.isNaN(time)) {
    return null;
  }
  return Date.now() - time;
}

function hasMissingNodeModulesBlocker(snapshot: RunSnapshot): boolean {
  const blockingReason = snapshot.current?.blocking_reason ?? "";
  return /local node_modules/i.test(blockingReason);
}

function hasTransientBlocker(snapshot: RunSnapshot): boolean {
  const blockingReason = snapshot.current?.blocking_reason ?? "";
  return /(429|rate limit|timed out|timeout|temporarily unavailable|service unavailable|econnreset|connection reset)/i.test(
    blockingReason
  );
}

function hasHardBoundaryBlocker(snapshot: RunSnapshot): boolean {
  const blockingReason = snapshot.current?.blocking_reason ?? "";
  return /超出当前 run 的工作区范围|workspace scope|not a git worktree|记录的隔离工作区不是 git worktree|restart before the next dispatch/i.test(
    blockingReason
  );
}

function hasGovernanceDeadEndBlocker(snapshot: RunSnapshot): boolean {
  const blockingReason = snapshot.current?.blocking_reason ?? "";
  return /治理层拦下了|已证伪方案|缺失工件|missing artifact|Objective referenced missing artifacts|excluded plan|dispatch blocked/i.test(
    blockingReason
  );
}

function hasSelfBootstrapSnapshotBlocker(snapshot: RunSnapshot): boolean {
  const blockingReason = snapshot.current?.blocking_reason ?? "";
  return /active next task snapshot is missing or invalid/i.test(blockingReason);
}

function hasSupervisorPauseBoundary(snapshot: RunSnapshot): boolean {
  if (hasRecentJournalEventSinceReset(snapshot, "run.auto_resume.blocked")) {
    return true;
  }

  const reasonCode = snapshot.automation?.reason_code ?? null;
  if (
    snapshot.automation?.mode === "manual_only" &&
    (reasonCode === "automatic_resume_blocked" ||
      reasonCode === "manual_recovery" ||
      reasonCode === "superseded_self_bootstrap_run")
  ) {
    return true;
  }

  return hasSelfBootstrapSnapshotBlocker(snapshot);
}

function getLatestAttemptFailureEntry(snapshot: RunSnapshot): RunJournalEntry | null {
  const attemptId = snapshot.latestAttempt?.id ?? snapshot.current?.latest_attempt_id ?? null;
  if (!attemptId) {
    return null;
  }

  for (let index = snapshot.journal.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.journal[index];
    if (!entry || entry.attempt_id !== attemptId || entry.type !== "attempt.failed") {
      continue;
    }

    return entry;
  }

  return null;
}

function getJournalPayloadRecord(
  entry: RunJournalEntry | null
): Record<string, unknown> | null {
  if (!entry?.payload || typeof entry.payload !== "object" || Array.isArray(entry.payload)) {
    return null;
  }

  return entry.payload as Record<string, unknown>;
}

function buildSchemaRepairSignature(
  code: string,
  fieldPath: string | null,
  message: string
): string {
  const normalizedMessage = message.replace(/\s+/g, " ").trim().toLowerCase();
  return `${code}:${fieldPath ?? normalizedMessage}`;
}

function getWorkerOutputSchemaBlocker(snapshot: RunSnapshot): WorkerOutputSchemaBlocker | null {
  if (snapshot.current?.run_status !== "waiting_steer") {
    return null;
  }

  const failureEntry = getLatestAttemptFailureEntry(snapshot);
  const payload = getJournalPayloadRecord(failureEntry);
  const attemptId = snapshot.latestAttempt?.id ?? snapshot.current?.latest_attempt_id ?? null;
  const message =
    (typeof payload?.message === "string" && payload.message.length > 0
      ? payload.message
      : snapshot.current?.blocking_reason) ?? "";
  const code =
    typeof payload?.code === "string" && payload.code.length > 0
      ? payload.code
      : /Worker writeback schema invalid|Expected object, received string/i.test(message)
        ? "worker_output_schema_invalid"
        : null;

  if (code !== "worker_output_schema_invalid") {
    return null;
  }

  const fieldPath =
    typeof payload?.field_path === "string" && payload.field_path.length > 0
      ? payload.field_path
      : message.match(/at\s+([A-Za-z0-9_.[\]]+)/)?.[1] ?? null;
  const repairHint =
    typeof payload?.repair_hint === "string" && payload.repair_hint.length > 0
      ? payload.repair_hint
      : 'artifacts 必须是对象数组，元素形如 {"type":"report","path":"relative/path"}；如果只是引用文件路径，就不要放进 artifacts。';
  const rawOutputFile =
    typeof payload?.raw_output_file === "string" && payload.raw_output_file.length > 0
      ? payload.raw_output_file
      : attemptId
        ? `runs/${snapshot.run.id}/attempts/${attemptId}/worker-output.json`
        : null;

  return {
    attemptId,
    message,
    fieldPath,
    repairHint,
    rawOutputFile,
    signature: buildSchemaRepairSignature(code, fieldPath, message)
  };
}

function hasRecordedRepair(
  state: SupervisorState,
  runId: string,
  action: string,
  detail: string
): boolean {
  return state.repair_log.some(
    (entry) => entry.run_id === runId && entry.action === action && entry.detail === detail
  );
}

function buildWorkerOutputSchemaRepairSteer(
  blocker: WorkerOutputSchemaBlocker
): string {
  return [
    "先修 worker 输出契约，再继续当前自举研究。",
    blocker.attemptId ? `失败 attempt：${blocker.attemptId}` : null,
    blocker.rawOutputFile ? `先读这份 raw output：${blocker.rawOutputFile}` : null,
    blocker.message ? `机器报错：${blocker.message}` : null,
    blocker.fieldPath ? `重点修这个字段：${blocker.fieldPath}` : null,
    `修复要求：${blocker.repairHint}`,
    "尽量保留 raw output 里已经成立的分析和 next_attempt_contract，不要从头换题。",
    "如果只是引用文件路径或脚本名，把它们写进 findings.evidence、recommended_next_steps 或 next_attempt_contract.expected_artifacts，不要再返回字符串 artifacts。",
    "最终只返回符合 WorkerWritebackSchema 的完整 JSON，不要只解释错误。"
  ]
    .filter(Boolean)
    .join("\n");
}

function shouldRelaunchWaitingRun(
  snapshot: RunSnapshot,
  options: Pick<CliOptions, "waitingRelaunchMs">
): boolean {
  if (snapshot.current?.run_status !== "waiting_steer") {
    return false;
  }

  if (hasSupervisorPauseBoundary(snapshot)) {
    return false;
  }

  if (hasHardBoundaryBlocker(snapshot)) {
    return false;
  }

  if (hasGovernanceDeadEndBlocker(snapshot)) {
    return false;
  }

  if (hasMissingNodeModulesBlocker(snapshot) || hasTransientBlocker(snapshot)) {
    return true;
  }

  if (lastJournalEvent(snapshot, "run.auto_resume.exhausted")) {
    return true;
  }

  const waitingAgeMs = ageMs(snapshot.current.updated_at);
  return waitingAgeMs !== null && waitingAgeMs >= options.waitingRelaunchMs;
}

function shouldRotateRun(snapshot: RunSnapshot): boolean {
  if (
    snapshot.current?.run_status === "completed" ||
    snapshot.current?.run_status === "failed" ||
    snapshot.current?.run_status === "cancelled"
  ) {
    return true;
  }

  if (snapshot.current?.run_status !== "waiting_steer") {
    return false;
  }

  if (hasSupervisorPauseBoundary(snapshot)) {
    return false;
  }

  if (hasMissingNodeModulesBlocker(snapshot) || hasTransientBlocker(snapshot)) {
    return false;
  }

  if (hasHardBoundaryBlocker(snapshot)) {
    return false;
  }

  return lastJournalEvent(snapshot, "run.auto_resume.exhausted") !== null;
}

function shouldRelaunchStaleAttempt(
  snapshot: RunSnapshot,
  options: Pick<CliOptions, "staleAttemptMs">
): boolean {
  return (
    assessRunHealth({
      current: snapshot.current,
      latestAttempt: snapshot.latestAttempt,
      latestHeartbeat: snapshot.latestHeartbeat,
      latestRuntimeState: snapshot.latestRuntimeState,
      staleAfterMs: options.staleAttemptMs
    }).status === "stale_running_attempt"
  );
}

function renderSnapshotLine(snapshot: RunSnapshot, completedAttempts: number, target: number): string {
  const latestAttempt = snapshot.latestAttempt;
  const current = snapshot.current;
  return [
    `run=${snapshot.run.id}`,
    `status=${current?.run_status ?? "unknown"}`,
    `latest=${latestAttempt ? `${latestAttempt.attempt_type}/${latestAttempt.status}` : "none"}`,
    `completed=${completedAttempts}/${target}`,
    current?.blocking_reason ? `blocker=${current.blocking_reason}` : null
  ]
    .filter(Boolean)
    .join(" | ");
}

async function ensureActiveRunId(
  runtimeDataRoot: string,
  apiBaseUrl: string,
  state: SupervisorState,
  options: Pick<CliOptions, "focus" | "ownerId" | "runId">
): Promise<string> {
  const candidates = [state.active_run_id, options.runId].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );

  for (const runId of candidates) {
    try {
      await getRun(resolveWorkspacePaths(runtimeDataRoot), runId);
      trackRun(state, runId);
      return runId;
    } catch {
      continue;
    }
  }

  const latestRunId = await findLatestSelfBootstrapRunId(runtimeDataRoot);
  if (latestRunId) {
    trackRun(state, latestRunId);
    return latestRunId;
  }

  const newRunId = await createSelfBootstrapRun(apiBaseUrl, options);
  trackRun(state, newRunId);
  recordRepair(state, newRunId, "create_run", "创建新的 self-bootstrap run");
  logLine(`已创建新的 self-bootstrap run ${newRunId}`);
  return newRunId;
}

async function suspendSupersededSelfBootstrapRuns(input: {
  runtimeDataRoot: string;
  activeRunId: string;
  state: SupervisorState;
}): Promise<void> {
  const workspacePaths = resolveWorkspacePaths(input.runtimeDataRoot);
  const runs = await listRuns(workspacePaths);
  const suspendedAt = nowIso();

  for (const run of runs) {
    if (!isSelfBootstrapRun(run) || run.id === input.activeRunId) {
      continue;
    }

    const current = await getCurrentDecision(workspacePaths, run.id);
    if (!current || current.run_status !== "running") {
      continue;
    }

    const attempts = await listAttempts(workspacePaths, run.id);
    const runningAttempts = attempts.filter((attempt) => attempt.status === "running");
    const pendingAttemptIds = attempts
      .filter((attempt) => attempt.status === "created" || attempt.status === "queued")
      .map((attempt) => attempt.id);
    const stoppedAttemptIds: string[] = [];

    for (const attempt of runningAttempts) {
      await saveAttempt(
        workspacePaths,
        updateAttempt(attempt, {
          status: "stopped",
          ended_at: suspendedAt
        })
      );
      const [heartbeat, runtimeState] = await Promise.all([
        getAttemptHeartbeat(workspacePaths, run.id, attempt.id),
        getAttemptRuntimeState(workspacePaths, run.id, attempt.id)
      ]);

      if (heartbeat) {
        await saveAttemptHeartbeat(workspacePaths, {
          ...heartbeat,
          status: "released",
          heartbeat_at: suspendedAt,
          released_at: suspendedAt
        });
      }

      if (runtimeState) {
        await saveAttemptRuntimeState(
          workspacePaths,
          updateAttemptRuntimeState(runtimeState, {
            running: false,
            phase: "stopped",
            last_event_at: suspendedAt,
            progress_text: `Suspended because active self-bootstrap run is ${input.activeRunId}.`,
            error: `Superseded by active self-bootstrap run ${input.activeRunId}.`
          })
        );
      }

      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: run.id,
          attempt_id: attempt.id,
          type: "attempt.stopped",
          payload: {
            reason: "superseded_by_active_self_bootstrap_run",
            active_run_id: input.activeRunId
          },
          ts: suspendedAt
        })
      );
      stoppedAttemptIds.push(attempt.id);
    }

    const summary =
      `当前 run 已被新的 active self-bootstrap run ${input.activeRunId} 接管，` +
      "旧 run 已暂停，避免继续占用调度槽位。";
    await saveCurrentDecision(
      workspacePaths,
      updateCurrentDecision(current, {
        run_status: "waiting_steer",
        recommended_next_action: "wait_for_human",
        summary,
        blocking_reason: summary,
        waiting_for_human: true
      })
    );
    await saveRunAutomationControl(
      workspacePaths,
      createRunAutomationControl({
        run_id: run.id,
        mode: "manual_only",
        reason_code: "superseded_self_bootstrap_run",
        reason: summary,
        imposed_by: "self-bootstrap-supervisor",
        active_run_id: input.activeRunId
      })
    );
    await appendRunJournal(
      workspacePaths,
      createRunJournalEntry({
        run_id: run.id,
        type: "run.self_bootstrap.superseded",
        payload: {
          active_run_id: input.activeRunId,
          stopped_attempt_ids: stoppedAttemptIds,
          pending_attempt_ids: pendingAttemptIds
        },
        ts: suspendedAt
      })
    );
    await refreshRunOperatorSurface(workspacePaths, run.id);
    recordRepair(
      input.state,
      run.id,
      "suspend_superseded_self_bootstrap_run",
      `active=${input.activeRunId}`
    );
    logLine(`${run.id} 已暂停，active self-bootstrap run 为 ${input.activeRunId}`);
  }
}

async function runSupervisorCycle(input: {
  runtimeRepoRoot: string;
  runtimeDataRoot: string;
  apiBaseUrl: string;
  state: SupervisorState;
  options: Pick<
    CliOptions,
    "focus" | "ownerId" | "runId" | "staleAttemptMs" | "targetCompletedAttempts" | "waitingRelaunchMs"
  >;
}): Promise<{
  snapshot: RunSnapshot;
  completedAttempts: number;
  reachedTarget: boolean;
}> {
  await ensureControlApiAvailable({
    runtimeRepoRoot: input.runtimeRepoRoot,
    runtimeDataRoot: input.runtimeDataRoot,
    apiBaseUrl: input.apiBaseUrl,
    state: input.state
  });
  const runId = await ensureActiveRunId(
    input.runtimeDataRoot,
    input.apiBaseUrl,
    input.state,
    input.options
  );
  await suspendSupersededSelfBootstrapRuns({
    runtimeDataRoot: input.runtimeDataRoot,
    activeRunId: runId,
    state: input.state
  });
  const snapshot = await loadRunSnapshot(input.runtimeDataRoot, runId);
  trackRun(input.state, runId);
  const completedAttempts = trackCompletedAttempts(input.state, snapshot);
  logLine(renderSnapshotLine(snapshot, completedAttempts, input.options.targetCompletedAttempts));

  if (completedAttempts >= input.options.targetCompletedAttempts) {
    return {
      snapshot,
      completedAttempts,
      reachedTarget: true
    };
  }

  const workerOutputSchemaBlocker = getWorkerOutputSchemaBlocker(snapshot);
  if (workerOutputSchemaBlocker) {
    const repairDetail = workerOutputSchemaBlocker.signature;
    if (
      !hasRecordedRepair(
        input.state,
        snapshot.run.id,
        "queue_worker_output_schema_repair",
        repairDetail
      )
    ) {
      await queueRunSteer({
        apiBaseUrl: input.apiBaseUrl,
        runId: snapshot.run.id,
        attemptId: workerOutputSchemaBlocker.attemptId,
        content: buildWorkerOutputSchemaRepairSteer(workerOutputSchemaBlocker)
      });
      recordRepair(
        input.state,
        snapshot.run.id,
        "queue_worker_output_schema_repair",
        repairDetail
      );
      logLine(`${snapshot.run.id} 已注入 worker 输出契约修复 steer`);
    }

    return {
      snapshot,
      completedAttempts,
      reachedTarget: false
    };
  }

  if (hasMissingNodeModulesBlocker(snapshot)) {
    const repair = await repairManagedWorkspaceNodeModules(snapshot.run);
    recordRepair(input.state, snapshot.run.id, "repair_node_modules", repair.detail);
    logLine(`${snapshot.run.id} 修复 toolchain 卡点 ${repair.detail}`);
    await launchRun(input.apiBaseUrl, snapshot.run.id);
    recordRepair(input.state, snapshot.run.id, "launch_run", "node_modules 修复后重新启动");
    logLine(`${snapshot.run.id} 已重新启动`);
    return {
      snapshot,
      completedAttempts,
      reachedTarget: false
    };
  }

  if (shouldRelaunchStaleAttempt(snapshot, input.options)) {
    await launchRun(input.apiBaseUrl, snapshot.run.id);
    recordRepair(input.state, snapshot.run.id, "launch_run", "检测到 stale running attempt，已重新启动 run");
    logLine(`${snapshot.run.id} 检测到 stale attempt，已重新启动`);
    return {
      snapshot,
      completedAttempts,
      reachedTarget: false
    };
  }

  if (shouldRelaunchWaitingRun(snapshot, input.options)) {
    await launchRun(input.apiBaseUrl, snapshot.run.id);
    recordRepair(input.state, snapshot.run.id, "launch_run", "waiting_steer 可恢复，已重新启动 run");
    logLine(`${snapshot.run.id} waiting_steer 可恢复，已重新启动`);
    return {
      snapshot,
      completedAttempts,
      reachedTarget: false
    };
  }

  if (shouldRotateRun(snapshot)) {
    const newRunId = await createSelfBootstrapRun(input.apiBaseUrl, input.options);
    trackRun(input.state, newRunId);
    recordRepair(
      input.state,
      snapshot.run.id,
      "rotate_run",
      `当前 run 不再值得续跑，已切到 ${newRunId}`
    );
    logLine(`${snapshot.run.id} 已轮换到新的 self-bootstrap run ${newRunId}`);
  }

  return {
    snapshot,
    completedAttempts,
    reachedTarget: false
  };
}

async function main(): Promise<void> {
  const repositoryRoot = resolveRepositoryRoot();
  const runtimeLayout = resolveRuntimeLayout({
    repositoryRoot,
    env: process.env
  });
  syncRuntimeLayoutHint(runtimeLayout);
  const options = parseArgs(process.argv.slice(2));
  const stateFile =
    options.stateFile ??
    join(runtimeLayout.runtimeDataRoot, "artifacts", "self-bootstrap-supervisor-state.json");
  const workspacePaths = resolveWorkspacePaths(runtimeLayout.runtimeDataRoot);
  await ensureWorkspace(workspacePaths);

  const state = (await loadSupervisorState(stateFile)) ?? createInitialSupervisorState(options.apiBaseUrl);
  normalizeControlApiState(state, options.apiBaseUrl);

  while (true) {
    const { completedAttempts, reachedTarget } = await runSupervisorCycle({
      runtimeRepoRoot: runtimeLayout.runtimeRepoRoot,
      runtimeDataRoot: runtimeLayout.runtimeDataRoot,
      apiBaseUrl: options.apiBaseUrl,
      state,
      options
    });

    state.updated_at = nowIso();
    await saveSupervisorState(stateFile, state);

    if (reachedTarget) {
      logLine(`已达到目标，累计完成 ${completedAttempts} 次 attempt`);
      return;
    }

    if (options.once) {
      return;
    }

    await sleep(options.pollMs);
  }
}

await main();
