import { createWriteStream, constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  realpath,
  readFile,
  readlink,
  symlink,
  writeFile
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type {
  Attempt,
  AttemptContract,
  AttemptRuntimeState,
  Branch,
  ContextSnapshot,
  Goal,
  Run,
  VerificationCommand,
  WorkerEffortLevel,
  WorkerWriteback
} from "@autoresearch/domain";
import {
  WorkerArtifactTypeValues,
  WorkerFindingTypeValues,
  createAttemptRuntimeEvent,
  createAttemptRuntimeState,
  updateAttemptRuntimeState,
  WorkerWritebackSchema
} from "@autoresearch/domain";
import type { WorkspacePaths } from "@autoresearch/state-store";
import {
  appendAttemptRuntimeEvent,
  resolveAttemptPaths,
  resolveBranchArtifactPaths,
  saveAttemptRuntimeState,
  writeJsonFile,
  writeTextFile
} from "@autoresearch/state-store";

export interface CodexCliConfig {
  command: string;
  model?: string;
  profile?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  skipGitRepoCheck: boolean;
  progressStallMs?: number;
  stallPollMs?: number;
  stallKillGraceMs?: number;
}

export interface BranchExecutionResult {
  writeback: WorkerWriteback;
  reportMarkdown: string;
  exitCode: number;
}

export class WorkerWritebackParseError extends Error {
  readonly code = "worker_output_schema_invalid";
  readonly fieldPath: string | null;
  readonly issueCode: string | null;
  readonly repairHint: string | null;

  constructor(input: {
    message: string;
    fieldPath?: string | null;
    issueCode?: string | null;
    repairHint?: string | null;
  }) {
    super(input.message);
    this.name = "WorkerWritebackParseError";
    this.fieldPath = input.fieldPath ?? null;
    this.issueCode = input.issueCode ?? null;
    this.repairHint = input.repairHint ?? null;
  }
}

export function isWorkerWritebackParseError(
  error: unknown
): error is WorkerWritebackParseError {
  return error instanceof WorkerWritebackParseError;
}

export const CODEX_CLI_EXECUTION_EFFORT_CONFIG_KEY = "model_reasoning_effort";
export const CODEX_CLI_EXECUTION_EFFORT_APPLIED_DETAIL =
  `当前 execution 入口会通过 Codex CLI 配置键 ${CODEX_CLI_EXECUTION_EFFORT_CONFIG_KEY} 原生透传 effort。`;

export type CodexCliWorkerEffortSetting = {
  requested_effort: WorkerEffortLevel;
  default_effort: "medium";
  source: string;
  status: "applied" | "unsupported";
  applied: boolean;
  detail: string;
};

const RESEARCH_ALLOWED_COMMANDS = [
  "awk",
  "basename",
  "cat",
  "cut",
  "dirname",
  "find",
  "git",
  "grep",
  "head",
  "jq",
  "ls",
  "nl",
  "readlink",
  "realpath",
  "rg",
  "sed",
  "sort",
  "stat",
  "tail",
  "uniq",
  "wc",
  "xargs"
] as const;

const RESEARCH_BLOCKED_COMMANDS = [
  "bun",
  "next",
  "node",
  "npm",
  "npx",
  "pnpm",
  "python",
  "python3",
  "tsx",
  "ts-node",
  "uv",
  "vite",
  "yarn"
] as const;

export interface ResearchShellGuard {
  binDir: string;
  zdotdir: string;
  env: NodeJS.ProcessEnv;
  allowedCommands: string[];
  blockedCommands: string[];
}

export function resolveSandboxForAttempt(
  sandbox: CodexCliConfig["sandbox"],
  attemptType: Attempt["attempt_type"]
): CodexCliConfig["sandbox"] {
  if (attemptType !== "execution") {
    return sandbox;
  }

  return sandbox === "read-only" ? "workspace-write" : sandbox;
}

export function buildAttemptModeRules(
  attemptType: Attempt["attempt_type"]
): string[] {
  if (attemptType === "execution") {
    return [
      "- You may modify files only within the provided workspace to complete the task.",
      "- Keep the change as small as possible and leave clear verification evidence.",
      "- Follow the replayable verification commands already locked into the attempt contract.",
      "- Do not claim tests or verification passed unless those contract commands would pass when the runtime replays them."
    ];
  }

  return [
    "- Work in read-only analysis mode. Do not modify files in the workspace.",
    "- Prefer file inspection and simple read-only shell commands over build or package-script execution.",
    "- Do not run package scripts, tsx, dev servers, or long-running processes during research.",
    "- The runtime exposes only a restricted read-only shell path during research, so package managers and script runners are blocked.",
    "- If you recommend execution next, include next_attempt_contract with replayable verification commands instead of vague advice."
  ];
}

export async function prepareResearchShellGuard(input: {
  artifactsDir: string;
  baseEnv: NodeJS.ProcessEnv;
}): Promise<ResearchShellGuard> {
  const guardRoot = join(input.artifactsDir, "research-shell");
  const binDir = join(guardRoot, "bin");
  const zdotdir = join(guardRoot, "zdotdir");
  const shellEnvFile = join(guardRoot, "shell-env.sh");
  const basePath = input.baseEnv.PATH ?? process.env.PATH ?? "";
  const allowedCommands: string[] = [];

  await mkdir(binDir, { recursive: true });
  await mkdir(zdotdir, { recursive: true });

  for (const command of RESEARCH_ALLOWED_COMMANDS) {
    const commandPath = await resolveCommandPath(command, basePath);
    if (!commandPath) {
      continue;
    }

    await ensureResearchShellCommandLink(join(binDir, command), commandPath);
    allowedCommands.push(command);
  }

  for (const command of RESEARCH_BLOCKED_COMMANDS) {
    const wrapperPath = join(binDir, command);
    await writeFile(
      wrapperPath,
      [
        "#!/bin/sh",
        `echo \"AISA research mode blocks ${command}. Use file inspection now and leave command execution for an execution attempt.\" >&2`,
        "exit 64"
      ].join("\n"),
      "utf8"
    );
    await chmod(wrapperPath, 0o755);
  }

  const shellEnv = [
    `export PATH="${binDir}"`,
    "export AISA_ATTEMPT_MODE=research"
  ].join("\n");

  await Promise.all([
    writeFile(shellEnvFile, `${shellEnv}\n`, "utf8"),
    writeFile(join(zdotdir, ".zshenv"), `${shellEnv}\n`, "utf8"),
    writeFile(join(zdotdir, ".zprofile"), `${shellEnv}\n`, "utf8"),
    writeFile(join(zdotdir, ".zshrc"), `${shellEnv}\n`, "utf8"),
    writeJsonFile(join(guardRoot, "policy.json"), {
      mode: "research",
      allowed_commands: allowedCommands,
      blocked_commands: [...RESEARCH_BLOCKED_COMMANDS]
    })
  ]);

  return {
    binDir,
    zdotdir,
    env: {
      ...input.baseEnv,
      ZDOTDIR: zdotdir,
      BASH_ENV: shellEnvFile,
      ENV: shellEnvFile,
      AISA_ATTEMPT_MODE: "research"
    },
    allowedCommands,
    blockedCommands: [...RESEARCH_BLOCKED_COMMANDS]
  };
}

export function buildCodexCliExecutionEffortConfigOverride(
  effort: WorkerEffortLevel
): string {
  return `${CODEX_CLI_EXECUTION_EFFORT_CONFIG_KEY}=${JSON.stringify(effort)}`;
}

async function ensureResearchShellCommandLink(
  linkPath: string,
  targetPath: string
): Promise<void> {
  try {
    await symlink(targetPath, linkPath);
    return;
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
  }

  const existingEntry = await lstat(linkPath);
  if (!existingEntry.isSymbolicLink()) {
    throw new Error(
      `Research shell guard expected ${linkPath} to stay a symlink. Remove the unexpected file before retrying.`
    );
  }

  const existingTarget = await readlink(linkPath);
  if (existingTarget !== targetPath) {
    throw new Error(
      `Research shell guard expected ${linkPath} to target ${targetPath}, found ${existingTarget}.`
    );
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

const RUNTIME_RECENT_ACTIVITIES_MAX = 8;
const RUNTIME_COMPLETED_STEPS_MAX = 8;
const RUNTIME_PROCESS_CONTENT_MAX = 6;
const RUNTIME_PREVIEW_CHARS = 240;

function normalizeWhitespace(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncatePreview(value: string, maxChars = RUNTIME_PREVIEW_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeRuntimeEventType(value: unknown): string {
  return normalizeWhitespace(value).toLowerCase().replace(/[./-]/g, "_");
}

function appendUniqueTail(list: string[], rawValue: unknown, maxItems: number): void {
  const value = truncatePreview(normalizeWhitespace(rawValue));
  if (!value) {
    return;
  }

  const key = value.toLowerCase();
  const existingIndex = list.findIndex(
    (entry) => normalizeWhitespace(entry).toLowerCase() === key
  );
  if (existingIndex >= 0) {
    list.splice(existingIndex, 1);
  }

  list.push(value);

  if (list.length > maxItems) {
    list.splice(0, list.length - maxItems);
  }
}

function collectTextParts(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    const text = normalizeWhitespace(value);
    return text ? [text] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextParts(item, depth + 1));
  }

  if (typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  return [
    ...collectTextParts(record.text, depth + 1),
    ...collectTextParts(record.message, depth + 1),
    ...collectTextParts(record.summary, depth + 1),
    ...collectTextParts(record.content, depth + 1),
    ...collectTextParts(record.output_text, depth + 1),
    ...collectTextParts(record.input_text, depth + 1),
    ...collectTextParts(record.delta, depth + 1),
    ...collectTextParts(record.reasoning_text, depth + 1)
  ];
}

function pickFirstText(value: unknown): string {
  return truncatePreview(collectTextParts(value)[0] ?? "");
}

function extractRawEventPayload(
  event: Record<string, unknown>
): Record<string, unknown> | null {
  const payload = event.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }

  const message = event.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    return message as Record<string, unknown>;
  }

  return null;
}

function unwrapRuntimeEvent(rawEvent: unknown): Record<string, unknown> | null {
  let current =
    rawEvent && typeof rawEvent === "object" && !Array.isArray(rawEvent)
      ? ({ ...(rawEvent as Record<string, unknown>) } as Record<string, unknown>)
      : null;

  for (let depth = 0; depth < 4 && current; depth += 1) {
    const eventType = normalizeRuntimeEventType(current.type);
    if (eventType === "event_msg") {
      const payload = extractRawEventPayload(current);
      if (!payload || typeof payload.type !== "string") {
        return current;
      }
      current = {
        ...payload,
        type: payload.type,
        session_id:
          normalizeWhitespace(current.session_id) ||
          normalizeWhitespace(payload.session_id) ||
          null
      };
      continue;
    }

    if (eventType === "stream_event") {
      const nested = current.event;
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
        return current;
      }
      const nestedRecord = nested as Record<string, unknown>;
      current = {
        ...nestedRecord,
        type: nestedRecord.type,
        session_id:
          normalizeWhitespace(current.session_id) ||
          normalizeWhitespace(nestedRecord.session_id) ||
          null
      };
      continue;
    }

    return current;
  }

  return current;
}

function extractSessionIdFromEvent(event: Record<string, unknown>): string | null {
  const candidates = [
    event.thread_id,
    event.session_id,
    event.sessionId,
    extractRawEventPayload(event)?.thread_id,
    extractRawEventPayload(event)?.session_id
  ];

  for (const candidate of candidates) {
    const value = normalizeWhitespace(candidate);
    if (value) {
      return value;
    }
  }

  return null;
}

function extractStopReason(event: Record<string, unknown>): string {
  const payload = extractRawEventPayload(event);
  const candidates = [
    event.stop_reason,
    event.stopReason,
    payload?.stop_reason,
    payload?.stopReason
  ];

  for (const candidate of candidates) {
    const value = normalizeRuntimeEventType(candidate);
    if (value) {
      return value;
    }
  }

  return "";
}

function extractRuntimeItem(
  event: Record<string, unknown>
): Record<string, unknown> | null {
  if (event.item && typeof event.item === "object" && !Array.isArray(event.item)) {
    return event.item as Record<string, unknown>;
  }

  const payload = extractRawEventPayload(event);
  if (payload?.item && typeof payload.item === "object" && !Array.isArray(payload.item)) {
    return payload.item as Record<string, unknown>;
  }

  return null;
}

function unwrapShellCommand(rawCommand: unknown): string {
  const command = normalizeWhitespace(rawCommand);
  if (!command) {
    return "";
  }

  const match = command.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/u);
  if (!match) {
    return command;
  }

  const wrapped = normalizeWhitespace(match[1]);
  if (
    (wrapped.startsWith("\"") && wrapped.endsWith("\"")) ||
    (wrapped.startsWith("'") && wrapped.endsWith("'"))
  ) {
    return wrapped.slice(1, -1);
  }

  return wrapped;
}

function summarizePathTail(rawPath: unknown): string {
  const normalized = normalizeWhitespace(rawPath).replace(/\\/g, "/");
  if (!normalized) {
    return "";
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 3) {
    return truncatePreview(normalized);
  }

  return truncatePreview(segments.slice(-3).join("/"));
}

function summarizeCommandPreview(rawCommand: unknown): string {
  return truncatePreview(unwrapShellCommand(rawCommand));
}

function inferCommandPhase(rawCommand: unknown): string {
  const command = unwrapShellCommand(rawCommand).toLowerCase();
  if (
    /\b(verify|test|typecheck|lint|pytest|jest|vitest|mocha|playwright)\b/u.test(command)
  ) {
    return "verifying";
  }

  return "tool";
}

function getTodoItems(item: Record<string, unknown>): Array<{
  text: string;
  completed: boolean;
}> {
  if (!Array.isArray(item.items)) {
    return [];
  }

  return item.items
    .filter(
      (candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)
    )
    .map((candidate) => {
      const record = candidate as Record<string, unknown>;
      return {
        text: normalizeWhitespace(record.text),
        completed: Boolean(record.completed)
      };
    })
    .filter((candidate) => candidate.text);
}

function summarizeTodoProgress(item: Record<string, unknown>): string {
  const todos = getTodoItems(item);
  if (todos.length === 0) {
    return "计划更新";
  }

  const completedCount = todos.filter((todo) => todo.completed).length;
  return `计划更新：${completedCount}/${todos.length} 已完成`;
}

function summarizeTodoProcessContent(item: Record<string, unknown>): string {
  const todos = getTodoItems(item);
  if (todos.length === 0) {
    return "";
  }

  const preview = todos
    .slice(0, 3)
    .map((todo) => `${todo.completed ? "已完成" : "待做"} ${todo.text}`)
    .join("；");

  return truncatePreview(`计划内容：${preview}`);
}

function summarizeCommandFailureOutput(item: Record<string, unknown>): string {
  const exitCode = Number(item.exit_code);
  if (!Number.isFinite(exitCode) || exitCode === 0) {
    return "";
  }

  const lines = String(item.aggregated_output ?? "")
    .split(/\r?\n/u)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  if (lines.length === 0) {
    return "";
  }

  const preferred =
    lines.find((line) =>
      /AssertionError|Error:|failed|ELIFECYCLE|unexpected status/i.test(line)
    ) ?? lines.at(-1);

  return preferred ? `命令报错：${truncatePreview(preferred)}` : "";
}

function summarizeCommandExecutionEvent(
  item: Record<string, unknown>,
  eventType: string
): string {
  const command = summarizeCommandPreview(item.command);
  const exitCode = Number(item.exit_code);
  const status = normalizeRuntimeEventType(item.status);

  if (eventType === "item_started" || status === "in_progress") {
    return command ? `执行命令：${command}` : "执行命令";
  }

  if (Number.isFinite(exitCode) && exitCode !== 0) {
    return command ? `命令失败(${exitCode})：${command}` : `命令失败(${exitCode})`;
  }

  if (eventType === "item_completed" || status === "completed") {
    return command ? `命令完成：${command}` : "命令完成";
  }

  return command ? `命令更新：${command}` : "命令更新";
}

function summarizeFileChangeEvent(item: Record<string, unknown>): string {
  const changes = Array.isArray(item.changes)
    ? item.changes.filter(
        (candidate) =>
          candidate && typeof candidate === "object" && !Array.isArray(candidate)
      )
    : [];

  if (changes.length === 0) {
    return "修改文件";
  }

  const firstChange = changes[0] as Record<string, unknown>;
  const firstPath = summarizePathTail(firstChange.path ?? firstChange.file_path);
  if (changes.length === 1) {
    return firstPath ? `修改文件：${firstPath}` : "修改文件";
  }

  return firstPath
    ? `修改文件：${firstPath} 等 ${changes.length} 个`
    : `修改文件：${changes.length} 个`;
}

function summarizeAgentMessageEvent(item: Record<string, unknown>): string {
  const text = pickFirstText(item);
  return text ? `进展：${text}` : "进展更新";
}

function summarizeRuntimeItemEvent(
  item: Record<string, unknown>,
  eventType: string
): string {
  const itemType = normalizeRuntimeEventType(item.type);
  if (itemType === "command_execution") {
    return summarizeCommandExecutionEvent(item, eventType);
  }

  if (itemType === "todo_list") {
    return summarizeTodoProgress(item);
  }

  if (itemType === "agent_message") {
    return summarizeAgentMessageEvent(item);
  }

  if (itemType === "file_change") {
    return summarizeFileChangeEvent(item);
  }

  return "";
}

function extractRuntimeItemCompletedStep(
  item: Record<string, unknown>,
  eventType: string
): string {
  const itemType = normalizeRuntimeEventType(item.type);
  if (itemType === "command_execution") {
    const exitCode = Number(item.exit_code);
    if (Number.isFinite(exitCode) && exitCode !== 0) {
      return "";
    }
    return eventType === "item_completed"
      ? summarizeCommandExecutionEvent(item, eventType)
      : "";
  }

  if (itemType === "file_change" && eventType === "item_completed") {
    return summarizeFileChangeEvent(item);
  }

  if (itemType === "todo_list") {
    const todos = getTodoItems(item);
    if (todos.length > 0 && todos.every((todo) => todo.completed)) {
      return `计划完成：${todos.length}/${todos.length} 已完成`;
    }
  }

  return "";
}

function extractRuntimeItemProcessContent(
  item: Record<string, unknown>,
  eventType: string
): string {
  const itemType = normalizeRuntimeEventType(item.type);
  if (itemType === "agent_message") {
    return pickFirstText(item);
  }

  if (itemType === "todo_list") {
    return summarizeTodoProcessContent(item);
  }

  if (itemType === "command_execution" && eventType === "item_completed") {
    return summarizeCommandFailureOutput(item);
  }

  return "";
}

function summarizeWebSearchCall(action: Record<string, unknown>): string {
  const query = normalizeWhitespace(action.query ?? action.q);
  const url = normalizeWhitespace(action.url);
  const pattern = normalizeWhitespace(action.pattern);
  const actionType = normalizeRuntimeEventType(action.type);

  if (actionType === "search" || query) {
    return query ? `搜索：${truncatePreview(query)}` : "搜索";
  }

  if (actionType === "open_page" || url) {
    return url ? `打开页面：${truncatePreview(url)}` : "打开页面";
  }

  if (actionType === "find" || pattern) {
    return pattern ? `查找：${truncatePreview(pattern)}` : "页面查找";
  }

  return "网页工具";
}

function summarizeToolArgs(args: Record<string, unknown> | null): string {
  if (!args) {
    return "";
  }

  const command = normalizeWhitespace(args.command ?? args.cmd);
  if (command) {
    return `命令：${truncatePreview(command)}`;
  }

  const query = normalizeWhitespace(args.query ?? args.q);
  if (query) {
    return `查询：${truncatePreview(query)}`;
  }

  const path = normalizeWhitespace(args.path ?? args.file_path);
  if (path) {
    return `路径：${truncatePreview(path)}`;
  }

  return "";
}

function summarizeResponsePayload(payload: Record<string, unknown>): string {
  const payloadType = normalizeRuntimeEventType(payload.type);
  if (payloadType === "web_search_call") {
    const action =
      payload.action && typeof payload.action === "object" && !Array.isArray(payload.action)
        ? (payload.action as Record<string, unknown>)
        : payload;
    return summarizeWebSearchCall(action);
  }

  if (payloadType === "local_shell_call") {
    const command = normalizeWhitespace(payload.command ?? payload.cmd);
    return command ? `命令：${truncatePreview(command)}` : "执行命令";
  }

  if (payloadType === "function_call" || payloadType === "custom_tool_call") {
    const toolName = normalizeWhitespace(
      payload.tool_name ?? payload.name ?? (payload.call as Record<string, unknown> | undefined)?.name
    );
    const detail = summarizeToolArgs(
      payload.call &&
        typeof payload.call === "object" &&
        !Array.isArray(payload.call) &&
        (payload.call as Record<string, unknown>).arguments &&
        typeof (payload.call as Record<string, unknown>).arguments === "object" &&
        !Array.isArray((payload.call as Record<string, unknown>).arguments)
        ? ((payload.call as Record<string, unknown>).arguments as Record<string, unknown>)
        : null
    );
    if (toolName && detail) {
      return `工具 ${toolName} · ${detail}`;
    }
    if (toolName) {
      return `工具 ${toolName}`;
    }
  }

  if (payloadType === "reasoning" || payloadType === "agent_reasoning") {
    const text = pickFirstText(payload.summary ?? payload);
    return text ? `思考：${text}` : "思考中";
  }

  if (payloadType === "message" || payloadType === "agent_message") {
    const text = pickFirstText(payload);
    return text ? `输出：${text}` : "输出内容";
  }

  return "";
}

function summarizeRuntimeEvent(rawEvent: Record<string, unknown>): string {
  const event = unwrapRuntimeEvent(rawEvent) ?? rawEvent;
  const eventType = normalizeRuntimeEventType(event.type);

  if (
    eventType === "thread_started" ||
    eventType === "thread_created" ||
    eventType === "thread_resumed"
  ) {
    const sessionId = extractSessionIdFromEvent(event);
    return sessionId ? `会话已建立：${sessionId}` : "会话已建立";
  }

  if (eventType === "turn_started") {
    return "本轮开始";
  }

  const runtimeItem = extractRuntimeItem(event);
  if (runtimeItem) {
    const itemSummary = summarizeRuntimeItemEvent(runtimeItem, eventType);
    if (itemSummary) {
      return itemSummary;
    }
  }

  if (eventType === "response_item") {
    const payload = extractRawEventPayload(event);
    if (payload) {
      const summary = summarizeResponsePayload(payload);
      if (summary) {
        return summary;
      }
    }
  }

  if (eventType === "reasoning" || eventType === "agent_reasoning") {
    const text = pickFirstText(event.summary ?? event);
    return text ? `思考：${text}` : "思考中";
  }

  if (
    eventType === "assistant_message" ||
    eventType === "assistant" ||
    eventType === "message" ||
    eventType === "agent_message"
  ) {
    const text = pickFirstText(event);
    return text ? `输出：${text}` : "输出内容";
  }

  if (eventType === "turn_completed") {
    return "本轮完成";
  }

  const fallbackText = pickFirstText(event);
  if (fallbackText) {
    return fallbackText;
  }

  return normalizeWhitespace(
    String(event.type ?? "收到运行事件").replace(/[._-]+/g, " ")
  );
}

function extractCompletedStep(rawEvent: Record<string, unknown>): string {
  const event = unwrapRuntimeEvent(rawEvent) ?? rawEvent;
  const eventType = normalizeRuntimeEventType(event.type);
  const runtimeItem = extractRuntimeItem(event);

  if (runtimeItem) {
    const itemStep = extractRuntimeItemCompletedStep(runtimeItem, eventType);
    if (itemStep) {
      return itemStep;
    }
  }

  if (eventType === "response_item") {
    const payload = extractRawEventPayload(event);
    const status = normalizeRuntimeEventType(payload?.status);
    if (payload && (status === "completed" || !status)) {
      const payloadType = normalizeRuntimeEventType(payload.type);
      if (
        payloadType === "web_search_call" ||
        payloadType === "local_shell_call" ||
        payloadType === "function_call" ||
        payloadType === "custom_tool_call"
      ) {
        return summarizeResponsePayload(payload);
      }
    }
  }

  if (eventType === "item_completed") {
    const item =
      event.item && typeof event.item === "object" && !Array.isArray(event.item)
        ? (event.item as Record<string, unknown>)
        : null;
    if (!item) {
      return "";
    }

    const itemType = normalizeRuntimeEventType(item.type);
    if (
      itemType === "web_search_call" ||
      itemType === "local_shell_call" ||
      itemType === "function_call" ||
      itemType === "custom_tool_call"
    ) {
      return summarizeResponsePayload(item);
    }
  }

  return "";
}

function extractProcessContent(rawEvent: Record<string, unknown>): string {
  const event = unwrapRuntimeEvent(rawEvent) ?? rawEvent;
  const eventType = normalizeRuntimeEventType(event.type);
  const stopReason = extractStopReason(event);
  const phase = normalizeRuntimeEventType(event.phase);
  const role = normalizeRuntimeEventType(
    event.role ?? extractRawEventPayload(event)?.role
  );

  if (phase === "final_answer" || stopReason === "end_turn") {
    return "";
  }

  if (eventType === "reasoning" || eventType === "agent_reasoning") {
    return pickFirstText(event.summary ?? event);
  }

  if (
    eventType === "assistant_message" ||
    eventType === "assistant" ||
    eventType === "agent_message" ||
    (eventType === "message" && (!role || role === "assistant"))
  ) {
    return pickFirstText(event);
  }

  const runtimeItem = extractRuntimeItem(event);
  if (runtimeItem) {
    return extractRuntimeItemProcessContent(runtimeItem, eventType);
  }

  if (eventType === "response_item") {
    const payload = extractRawEventPayload(event);
    if (!payload) {
      return "";
    }

    const payloadType = normalizeRuntimeEventType(payload.type);
    if (payloadType === "reasoning" || payloadType === "agent_reasoning") {
      return pickFirstText(payload.summary ?? payload);
    }
    if (
      payloadType === "message" ||
      payloadType === "assistant_message" ||
      payloadType === "agent_message"
    ) {
      const payloadRole = normalizeRuntimeEventType(payload.role);
      if (payloadRole && payloadRole !== "assistant") {
        return "";
      }
      return pickFirstText(payload);
    }
  }

  return "";
}

function inferRuntimePhase(
  rawEvent: Record<string, unknown>,
  currentPhase: string | null
): string {
  const event = unwrapRuntimeEvent(rawEvent) ?? rawEvent;
  const eventType = normalizeRuntimeEventType(event.type);

  if (
    eventType === "thread_started" ||
    eventType === "thread_created" ||
    eventType === "thread_resumed"
  ) {
    return "starting";
  }

  if (eventType === "turn_started") {
    return "running";
  }

  if (eventType === "turn_completed") {
    return "completed";
  }

  const runtimeItem = extractRuntimeItem(event);
  if (runtimeItem) {
    const itemType = normalizeRuntimeEventType(runtimeItem.type);
    if (itemType === "command_execution") {
      return inferCommandPhase(runtimeItem.command);
    }
    if (itemType === "todo_list") {
      return "planning";
    }
    if (itemType === "agent_message") {
      return "message";
    }
    if (itemType === "file_change") {
      return "writing";
    }
  }

  if (eventType === "reasoning" || eventType === "agent_reasoning") {
    return "reasoning";
  }

  if (eventType === "response_item") {
    const payload = extractRawEventPayload(event);
    const payloadType = normalizeRuntimeEventType(payload?.type);
    if (payloadType === "reasoning" || payloadType === "agent_reasoning") {
      return "reasoning";
    }
    if (
      payloadType === "web_search_call" ||
      payloadType === "local_shell_call" ||
      payloadType === "function_call" ||
      payloadType === "custom_tool_call"
    ) {
      return "tool";
    }
    if (
      payloadType === "message" ||
      payloadType === "assistant_message" ||
      payloadType === "agent_message"
    ) {
      return "message";
    }
  }

  if (
    eventType === "assistant_message" ||
    eventType === "assistant" ||
    eventType === "message" ||
    eventType === "agent_message"
  ) {
    return "message";
  }

  if (eventType === "item_completed") {
    return currentPhase ?? "running";
  }

  return currentPhase ?? "running";
}

function createAttemptRuntimeTracker(input: {
  workspacePaths: WorkspacePaths;
  runId: string;
  attemptId: string;
}) {
  let state = createAttemptRuntimeState({
    run_id: input.runId,
    attempt_id: input.attemptId,
    running: true,
    phase: "starting",
    active_since: new Date().toISOString(),
    progress_text: "已启动 Codex"
  });
  let stdoutBuffer = "";
  const activeCommandExecutionKeys = new Set<string>();
  let persistQueue = saveAttemptRuntimeState(input.workspacePaths, state);

  const enqueue = (task: () => Promise<void>): void => {
    persistQueue = persistQueue.then(task);
  };

  const appendEvent = (rawEvent: unknown, fallbackType = "stdout.json"): void => {
    enqueue(async () => {
      const normalizedEvent =
        rawEvent && typeof rawEvent === "object" && !Array.isArray(rawEvent)
          ? (rawEvent as Record<string, unknown>)
          : {
              type: fallbackType,
              payload: rawEvent
            };
      const unwrappedEvent = unwrapRuntimeEvent(normalizedEvent) ?? normalizedEvent;
      const runtimeItem = extractRuntimeItem(unwrappedEvent);
      if (runtimeItem && normalizeRuntimeEventType(runtimeItem.type) === "command_execution") {
        const eventType = normalizeRuntimeEventType(unwrappedEvent.type);
        const status = normalizeRuntimeEventType(runtimeItem.status);
        const itemKey =
          normalizeWhitespace(runtimeItem.id) ||
          normalizeWhitespace(runtimeItem.command);

        if (itemKey) {
          if (eventType === "item_started" || status === "in_progress") {
            activeCommandExecutionKeys.add(itemKey);
          } else if (
            eventType === "item_completed" ||
            status === "completed" ||
            status === "failed" ||
            status === "cancelled"
          ) {
            activeCommandExecutionKeys.delete(itemKey);
          }
        }
      }
      const ts =
        normalizeWhitespace((normalizedEvent as Record<string, unknown>).timestamp) ||
        normalizeWhitespace((normalizedEvent as Record<string, unknown>).ts) ||
        new Date().toISOString();
      const summary = summarizeRuntimeEvent(normalizedEvent);
      const completedStep = extractCompletedStep(normalizedEvent);
      const processContent = extractProcessContent(normalizedEvent);
      const recentActivities = [...state.recent_activities];
      const completedSteps = [...state.completed_steps];
      const processLines = [...state.process_content];
      if (summary) {
        appendUniqueTail(recentActivities, summary, RUNTIME_RECENT_ACTIVITIES_MAX);
      }
      if (completedStep) {
        appendUniqueTail(completedSteps, completedStep, RUNTIME_COMPLETED_STEPS_MAX);
      }
      if (processContent) {
        appendUniqueTail(processLines, processContent, RUNTIME_PROCESS_CONTENT_MAX);
      }

      const runtimeEvent = createAttemptRuntimeEvent({
        run_id: input.runId,
        attempt_id: input.attemptId,
        seq: state.event_count + 1,
        type:
          normalizeWhitespace((normalizedEvent as Record<string, unknown>).type) ||
          fallbackType,
        summary,
        payload: rawEvent,
        ts
      });

      state = updateAttemptRuntimeState(state, {
        phase: inferRuntimePhase(normalizedEvent, state.phase),
        last_event_at: runtimeEvent.ts,
        progress_text: summary || state.progress_text,
        recent_activities: recentActivities,
        completed_steps: completedSteps,
        process_content: processLines,
        session_id: extractSessionIdFromEvent(normalizedEvent) ?? state.session_id,
        event_count: runtimeEvent.seq
      });

      await Promise.all([
        appendAttemptRuntimeEvent(input.workspacePaths, runtimeEvent),
        saveAttemptRuntimeState(input.workspacePaths, state)
      ]);
    });
  };

  const appendUnparsedStdoutLine = (line: string): void => {
    appendEvent(
      {
        type: "stdout.unparsed",
        text: truncatePreview(line)
      },
      "stdout.unparsed"
    );
  };

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      appendEvent(JSON.parse(trimmed), "stdout.json");
    } catch {
      appendUnparsedStdoutLine(trimmed);
    }
  };

  const ingestStdoutChunk = (chunk: Buffer | string): void => {
    stdoutBuffer += chunk.toString();

    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      processLine(line);
    }
  };

  const flushStdoutRemainder = (): void => {
    const remainder = stdoutBuffer.trim();
    stdoutBuffer = "";
    if (remainder) {
      processLine(remainder);
    }
  };

  const saveStatePatch = (patch: Partial<AttemptRuntimeState>): void => {
    enqueue(async () => {
      state = updateAttemptRuntimeState(state, patch);
      await saveAttemptRuntimeState(input.workspacePaths, state);
    });
  };

  const finalizeSuccess = (finalOutput: string): void => {
    saveStatePatch({
      running: false,
      phase: "completed",
      progress_text: "执行完成",
      final_output: finalOutput.trim() || null,
      error: null
    });
  };

  const finalizeFailure = (errorMessage: string, finalOutput?: string | null): void => {
    saveStatePatch({
      running: false,
      phase: "failed",
      progress_text: "执行失败",
      final_output: finalOutput ?? state.final_output,
      error: errorMessage
    });
  };

  const waitForIdle = async (): Promise<void> => {
    await persistQueue;
  };

  return {
    ingestStdoutChunk,
    flushStdoutRemainder,
    saveStatePatch,
    finalizeSuccess,
    finalizeFailure,
    hasActiveCommandExecution: (): boolean => activeCommandExecutionKeys.size > 0,
    waitForIdle
  };
}

export class CodexCliWorkerAdapter {
  readonly type = "codex";

  private readonly config: CodexCliConfig & {
    progressStallMs: number;
    stallPollMs: number;
    stallKillGraceMs: number;
  };

  constructor(config: CodexCliConfig) {
    this.config = {
      ...config,
      progressStallMs: config.progressStallMs ?? 180_000,
      stallPollMs: config.stallPollMs ?? 5_000,
      stallKillGraceMs: config.stallKillGraceMs ?? 5_000
    };
  }

  async runBranchTask(input: {
    goal: Goal;
    branch: Branch;
    contextSnapshot: ContextSnapshot;
    workspacePaths: WorkspacePaths;
  }): Promise<BranchExecutionResult> {
    const { goal, branch, contextSnapshot, workspacePaths } = input;
    const branchPaths = resolveBranchArtifactPaths(workspacePaths, goal.id, branch.id);
    const outputFile = join(branchPaths.branchDir, "codex-output.json");
    const promptFile = join(branchPaths.branchDir, "worker-prompt.md");

    await mkdir(branchPaths.outputDir, { recursive: true });

    const prompt = buildCodexWorkerPrompt(goal, branch, contextSnapshot, branchPaths.reportFile);
    await Promise.all([
      writeJsonFile(branchPaths.taskSpecFile, {
        goal_id: goal.id,
        branch_id: branch.id,
        workspace_root: goal.workspace_root,
        hypothesis: branch.hypothesis,
        objective: branch.objective,
        success_criteria: branch.success_criteria,
        context_snapshot_id: contextSnapshot.id
      }),
      writeTextFile(promptFile, prompt)
    ]);

    const args = [
      "exec",
      "-C",
      goal.workspace_root,
      "-s",
      this.config.sandbox,
      "--output-last-message",
      outputFile
    ];

    if (this.config.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }

    if (this.config.profile) {
      args.push("-p", this.config.profile);
    }

    if (this.config.model) {
      args.push("-m", this.config.model);
    }

    args.push("-");

    const stdoutStream = createWriteStream(branchPaths.stdoutFile, { flags: "a" });
    const stderrStream = createWriteStream(branchPaths.stderrFile, { flags: "a" });

    const env = {
      ...process.env
    };

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(this.config.command, args, {
        cwd: workspacePaths.rootDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false
      });

      child.stdout.on("data", (chunk) => {
        stdoutStream.write(chunk);
      });

      child.stderr.on("data", (chunk) => {
        stderrStream.write(chunk);
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        resolve(code ?? 1);
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });

    await Promise.all([closeStream(stdoutStream), closeStream(stderrStream)]);

    if (exitCode !== 0) {
      throw new Error(
        await buildCodexFailureMessage({
          stderrFile: branchPaths.stderrFile,
          defaultMessage: `Codex CLI exited with code ${exitCode} for branch ${branch.id}`
        })
      );
    }

    const rawOutput = await readFile(outputFile, "utf8");
    const parsed = parseWritebackFromText(rawOutput);
    const reportMarkdown = buildBranchReportMarkdown(goal, branch, parsed);

    await Promise.all([
      writeJsonFile(branchPaths.writebackFile, parsed),
      writeTextFile(branchPaths.reportFile, reportMarkdown)
    ]);

    return {
      writeback: parsed,
      reportMarkdown,
      exitCode
    };
  }

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
    attemptContract: AttemptContract;
    context: unknown;
    worker_effort?: CodexCliWorkerEffortSetting;
    workspacePaths: WorkspacePaths;
  }): Promise<BranchExecutionResult> {
    const { run, attempt, attemptContract, context, workspacePaths } = input;
    const attemptPaths = resolveAttemptPaths(workspacePaths, run.id, attempt.id);
    const outputFile = join(attemptPaths.attemptDir, "codex-output.json");
    const promptFile = join(attemptPaths.attemptDir, "worker-prompt.md");
    const sandbox = resolveSandboxForAttempt(
      this.config.sandbox,
      attempt.attempt_type
    );
    const workerEffort =
      input.worker_effort ??
      resolveCodexCliWorkerEffort({
        source: "run.harness_profile.execution.effort"
      });

    await mkdir(attemptPaths.artifactsDir, { recursive: true });

    const prompt = buildCodexAttemptPrompt(run, attempt, attemptContract, context);
    await Promise.all([
      writeJsonFile(attemptPaths.contextFile, context),
      writeJsonFile(join(attemptPaths.attemptDir, "task-spec.json"), {
        run_id: run.id,
        attempt_id: attempt.id,
        attempt_type: attempt.attempt_type,
        workspace_root: attempt.workspace_root,
        objective: attempt.objective,
        success_criteria: attempt.success_criteria,
        attempt_contract: attemptContract,
        worker_effort: workerEffort
      }),
      writeTextFile(promptFile, prompt)
    ]);

    const args = [
      "exec",
      "-C",
      attempt.workspace_root,
      "-s",
      sandbox,
      "--json",
      "--output-last-message",
      outputFile
    ];

    if (this.config.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }

    if (this.config.profile) {
      args.push("-p", this.config.profile);
    }

    if (this.config.model) {
      args.push("-m", this.config.model);
    }

    if (workerEffort.applied && workerEffort.status === "applied") {
      args.push(
        "-c",
        buildCodexCliExecutionEffortConfigOverride(workerEffort.requested_effort)
      );
    }

    args.push("-");

    const stdoutStream = createWriteStream(attemptPaths.stdoutFile, { flags: "a" });
    const stderrStream = createWriteStream(attemptPaths.stderrFile, { flags: "a" });
    let env: NodeJS.ProcessEnv = {
      ...process.env
    };

    if (attempt.attempt_type === "research") {
      env = (await prepareResearchShellGuard({
        artifactsDir: attemptPaths.artifactsDir,
        baseEnv: env
      })).env;
    }

    const runtimeTracker = createAttemptRuntimeTracker({
      workspacePaths,
      runId: run.id,
      attemptId: attempt.id
    });
    let lastActivityAt = Date.now();

    const markWorkerActivity = (): void => {
      lastActivityAt = Date.now();
    };

    let exitCode: number;
    try {
      exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(this.config.command, args, {
          cwd: workspacePaths.rootDir,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false
        });

        child.stdout.on("data", (chunk) => {
          markWorkerActivity();
          stdoutStream.write(chunk);
          runtimeTracker.ingestStdoutChunk(chunk);
        });

        child.stderr.on("data", (chunk) => {
          markWorkerActivity();
          stderrStream.write(chunk);
        });

        child.stdin.write(prompt);
        child.stdin.end();

        void waitForChildExitWithStallGuard({
          child,
          outputFile,
          progressStallMs: this.config.progressStallMs,
          stallPollMs: this.config.stallPollMs,
          stallKillGraceMs: this.config.stallKillGraceMs,
          getLastActivityAt: () => lastActivityAt,
          hasLiveRuntimeChild: () => runtimeTracker.hasActiveCommandExecution(),
          onStallDetected: (message) => {
            runtimeTracker.saveStatePatch({
              phase: "stalled",
              progress_text: "检测到 worker 卡住，正在终止当前尝试",
              error: message
            });
          }
        }).then(resolve, reject);
      });

      runtimeTracker.flushStdoutRemainder();
      await Promise.all([closeStream(stdoutStream), closeStream(stderrStream)]);
      await runtimeTracker.waitForIdle();

      if (exitCode !== 0) {
        const errorMessage = await buildCodexFailureMessage({
          stderrFile: attemptPaths.stderrFile,
          defaultMessage: `Codex CLI exited with code ${exitCode} for attempt ${attempt.id}`
        });
        runtimeTracker.finalizeFailure(errorMessage);
        await runtimeTracker.waitForIdle();
        throw new Error(errorMessage);
      }

      const rawOutput = await readFile(outputFile, "utf8");
      runtimeTracker.saveStatePatch({
        phase: "finalizing",
        progress_text: "正在整理最终输出",
        final_output: rawOutput.trim() || null
      });
      await runtimeTracker.waitForIdle();

      const parsed = parseWritebackFromText(rawOutput);
      const reportMarkdown = buildAttemptReportMarkdown(run, attempt, parsed);

      await Promise.all([
        writeJsonFile(attemptPaths.resultFile, parsed),
        writeTextFile(join(attemptPaths.attemptDir, "report.md"), reportMarkdown)
      ]);

      runtimeTracker.finalizeSuccess(rawOutput);
      await runtimeTracker.waitForIdle();

      return {
        writeback: parsed,
        reportMarkdown,
        exitCode
      };
    } catch (error) {
      runtimeTracker.flushStdoutRemainder();
      await Promise.allSettled([closeStream(stdoutStream), closeStream(stderrStream)]);
      const message = error instanceof Error ? error.message : String(error);
      runtimeTracker.finalizeFailure(message);
      await runtimeTracker.waitForIdle();
      throw error;
    }
  }
}

export function loadCodexCliConfig(env: NodeJS.ProcessEnv): CodexCliConfig {
  return {
    command: env.CODEX_CLI_COMMAND ?? "codex",
    model: env.CODEX_MODEL,
    profile: env.CODEX_PROFILE,
    sandbox:
      (env.CODEX_SANDBOX as CodexCliConfig["sandbox"] | undefined) ?? "read-only",
    skipGitRepoCheck: env.CODEX_SKIP_GIT_REPO_CHECK !== "false",
    progressStallMs: readPositiveInteger(
      env.AISA_CODEX_PROGRESS_STALL_MS ?? env.CODEX_PROGRESS_STALL_MS,
      180_000
    ),
    stallPollMs: readPositiveInteger(
      env.AISA_CODEX_STALL_POLL_MS ?? env.CODEX_STALL_POLL_MS,
      5_000
    ),
    stallKillGraceMs: readPositiveInteger(
      env.AISA_CODEX_STALL_KILL_GRACE_MS ?? env.CODEX_STALL_KILL_GRACE_MS,
      5_000
    )
  };
}

export function resolveCodexCliWorkerEffort(input: {
  requestedEffort?: WorkerEffortLevel | null;
  source?: string;
} = {}): CodexCliWorkerEffortSetting {
  return {
    requested_effort: input.requestedEffort ?? "medium",
    default_effort: "medium",
    source: input.source ?? "run.harness_profile.execution.effort",
    status: "applied",
    applied: true,
    detail: CODEX_CLI_EXECUTION_EFFORT_APPLIED_DETAIL
  };
}

function buildCodexWorkerPrompt(
  goal: Goal,
  branch: Branch,
  snapshot: ContextSnapshot,
  reportFile: string
): string {
  return [
    "You are a Codex CLI worker inside AutoResearch Swarm Dashboard.",
    "",
    "Rules:",
    "- Work in read-only analysis mode. Do not modify files in the workspace.",
    "- Use local repository evidence whenever possible.",
    "- If Current Context already carries structured runtime evidence, trust that object first and do not guess relative file paths to re-read it.",
    "- If evidence is weak or missing, say so explicitly.",
    "- Write all user-facing natural language fields in concise Chinese.",
    "- Keep JSON keys, enum-like machine values, file paths, shell commands, and evidence strings stable when they must stay machine-readable.",
    "- Return only valid JSON with no markdown fences and no extra commentary.",
    "",
    "Goal:",
    `- Title: ${goal.title}`,
    `- Description: ${goal.description}`,
    `- Workspace Root: ${goal.workspace_root}`,
    "",
    "Branch:",
    `- Branch ID: ${branch.id}`,
    `- Hypothesis: ${branch.hypothesis}`,
    `- Objective: ${branch.objective}`,
    "",
    "Success Criteria:",
    ...branch.success_criteria.map(
      (criterion: Branch["success_criteria"][number]) => `- ${criterion}`
    ),
    "",
    "Current Context Snapshot:",
    JSON.stringify(snapshot, null, 2),
    "",
    "Deliverables:",
    `- A branch report will be generated by the control plane at ${reportFile}.`,
    "- You only need to return structured JSON in this shape:",
    JSON.stringify(
      {
        summary: "简短摘要",
        findings: [
          {
            type: "fact",
            content: "你确认的事实",
            evidence: ["relative/path/or/command"]
          }
        ],
        questions: ["仍待确认的问题"],
        recommended_next_steps: ["最值得做的下一步"],
        confidence: 0.72,
        artifacts: []
      },
      null,
      2
    )
  ].join("\n");
}

function buildCodexAttemptPrompt(
  run: Run,
  attempt: Attempt,
  attemptContract: AttemptContract,
  context: unknown
): string {
  const workerFindingTypes = formatQuotedValues(WorkerFindingTypeValues);
  const workerArtifactTypes = formatQuotedValues(WorkerArtifactTypeValues);
  const executionArtifactExample = {
    type: "patch",
    path: "runs/<run_id>/attempts/<attempt_id>/artifacts/diff.patch"
  };
  const adversarialArtifactExample = {
    type: "test_result",
    path: "artifacts/adversarial-verification.json"
  };

  return [
    "You are a Codex CLI worker inside AISA.",
    "",
    "Rules:",
    ...buildAttemptModeRules(attempt.attempt_type),
    "- The run is locked to the workspace root shown below. Do not read or write outside that root.",
    "- Use local repository evidence whenever possible.",
    "- If evidence is weak or missing, say so explicitly.",
    "- Write all user-facing natural language fields in concise Chinese.",
    "- Keep JSON keys, enum-like machine values, file paths, shell commands, and evidence strings stable when they must stay machine-readable.",
    "- Return only valid JSON with no markdown fences and no extra commentary.",
    "",
    "Run:",
    `- Title: ${run.title}`,
    `- Description: ${run.description}`,
    `- Workspace Root: ${attempt.workspace_root}`,
    ...(run.managed_workspace_root && run.managed_workspace_root !== run.workspace_root
      ? [`- Source Workspace Root: ${run.workspace_root}`]
      : []),
    "",
    "Attempt:",
    `- Attempt ID: ${attempt.id}`,
    `- Type: ${attempt.attempt_type}`,
    `- Objective: ${attempt.objective}`,
    "",
    "Attempt Contract:",
    JSON.stringify(attemptContract, null, 2),
    "",
    "Success Criteria:",
    ...attempt.success_criteria.map(
      (criterion: Attempt["success_criteria"][number]) => `- ${criterion}`
    ),
    "",
    "Current Context:",
    JSON.stringify(context, null, 2),
    "",
    attempt.attempt_type === "execution"
      ? "The runtime will replay the commands already locked in the attempt contract and only trust those observed results."
      : null,
    attempt.attempt_type === "execution"
      ? "Do not replace the contract verification plan with a different one after execution starts."
      : null,
    attempt.attempt_type === "execution" &&
    attemptContract.adversarial_verification_required === true
      ? "After the contract replay commands pass, run a separate adversarial verification pass and save a machine-readable JSON artifact at artifacts/adversarial-verification.json in the workspace root."
      : null,
    attempt.attempt_type === "execution" &&
    attemptContract.adversarial_verification_required === true
      ? "That adversarial artifact must include checks, commands, output_refs, and a verdict of pass, fail, or partial. Deterministic replay and adversarial verification are two separate layers."
      : null,
    attempt.attempt_type === "execution" &&
    attemptContract.adversarial_verification_required === true
      ? 'Use this JSON shape for artifacts/adversarial-verification.json: {"summary":"简短结论","verdict":"pass","checks":[{"code":"non_happy_path","status":"passed","message":"实际验证结果"}],"commands":[{"purpose":"对抗性验证","command":"pnpm verify:run-api","exit_code":0,"status":"passed","output_ref":"artifacts/adversarial/run-api.txt"}],"output_refs":["artifacts/adversarial/run-api.txt"]}'
      : null,
    `Allowed findings.type values: ${workerFindingTypes}. Do not invent values like "gap".`,
    `artifacts must be an array of objects with stable keys. Allowed artifacts[].type values: ${workerArtifactTypes}.`,
    `Copy this artifacts object shape when you have one: ${JSON.stringify(executionArtifactExample)}`,
    attempt.attempt_type === "execution" &&
    attemptContract.adversarial_verification_required === true
      ? `Include this extra artifact when adversarial verification is required: ${JSON.stringify(adversarialArtifactExample)}`
      : null,
    'Do not return artifacts as plain strings like "scripts/verify-run-detail-api.ts".',
    "If you only want to cite files or commands as evidence, put them in findings[].evidence, recommended_next_steps, or next_attempt_contract.expected_artifacts instead of artifacts[].",
    attempt.attempt_type === "research"
      ? "If you recommend execution next, include next_attempt_contract with replayable verification commands."
      : null,
    "",
    "Return JSON in this shape:",
    JSON.stringify(
      {
        summary: "简短摘要",
        findings: [
          {
            type: "fact",
            content: "你确认的事实",
            evidence: ["relative/path/or/command"]
          }
        ],
        questions: ["仍待确认的问题"],
        recommended_next_steps: ["最值得做的下一步"],
        confidence: 0.72,
        next_attempt_contract:
          attempt.attempt_type === "research"
            ? {
                attempt_type: "execution",
                objective: "做出最小且有价值的改动",
                success_criteria: ["留下可以工作的实现步骤"],
                required_evidence: [
                  "git-visible workspace changes",
                  "a replayable verification command that checks the changed behavior"
                ],
                forbidden_shortcuts: [
                  "do not claim success without runnable verification"
                ],
                expected_artifacts: ["changed files visible in git"],
                verification_plan: {
                  commands: [
                    {
                      purpose: "verify the changed behavior",
                      command: "pnpm verify:runtime"
                    }
                  ]
                }
              }
            : undefined,
        verification_plan:
          attempt.attempt_type === "execution"
            ? {
                commands: [
                  {
                    purpose: "verify the changed behavior",
                    command: "pnpm verify:runtime"
                  }
                ]
              }
            : undefined,
        artifacts:
          attempt.attempt_type === "execution"
            ? attemptContract.adversarial_verification_required === true
              ? [executionArtifactExample, adversarialArtifactExample]
              : [executionArtifactExample]
            : []
      },
      null,
      2
    )
  ].join("\n");
}

function formatQuotedValues(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

function formatIssuePath(path: Array<string | number>): string | null {
  if (path.length === 0) {
    return null;
  }

  let formatted = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
      continue;
    }

    formatted += formatted.length === 0 ? segment : `.${segment}`;
  }

  return formatted || null;
}

function buildWritebackParseError(error: {
  message: string;
  issues: Array<{
    path: Array<string | number>;
    code?: string;
    message: string;
  }>;
}): WorkerWritebackParseError {
  const issue = error.issues[0];
  const fieldPath = issue ? formatIssuePath(issue.path) : null;
  const issueMessage =
    typeof issue?.message === "string" && issue.message.length > 0
      ? issue.message
      : typeof error.message === "string" && error.message.length > 0
        ? error.message
        : "Worker writeback did not match the schema.";
  const repairHint =
    fieldPath?.startsWith("artifacts[") || fieldPath === "artifacts"
      ? 'artifacts 必须是对象数组，元素形如 {"type":"report","path":"relative/path"}；如果只是引用文件路径，就把它写进 findings.evidence、recommended_next_steps 或 next_attempt_contract.expected_artifacts。'
      : "返回的 JSON 必须严格符合 WorkerWritebackSchema。";
  const baseMessage = fieldPath
    ? `Worker writeback schema invalid at ${fieldPath}: ${issueMessage}`
    : `Worker writeback schema invalid: ${issueMessage}`;

  return new WorkerWritebackParseError({
    message: `${baseMessage} ${repairHint}`.trim(),
    fieldPath,
    issueCode: issue?.code ?? null,
    repairHint
  });
}

function detectCommonWritebackContractError(
  value: unknown
): WorkerWritebackParseError | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.artifacts)) {
    const invalidArtifactIndex = record.artifacts.findIndex(
      (artifact) => !artifact || typeof artifact !== "object" || Array.isArray(artifact)
    );
    if (invalidArtifactIndex >= 0) {
      const invalidArtifact = record.artifacts[invalidArtifactIndex];
      const received =
        invalidArtifact === null
          ? "null"
          : Array.isArray(invalidArtifact)
            ? "array"
            : typeof invalidArtifact;
      const fieldPath = `artifacts[${invalidArtifactIndex}]`;
      const repairHint =
        'artifacts 必须是对象数组，元素形如 {"type":"report","path":"relative/path"}；如果只是引用文件路径，就把它写进 findings.evidence、recommended_next_steps 或 next_attempt_contract.expected_artifacts。';

      return new WorkerWritebackParseError({
        message: `Worker writeback schema invalid at ${fieldPath}: Expected object, received ${received} ${repairHint}`,
        fieldPath,
        repairHint
      });
    }
  }

  return null;
}

function parseWritebackFromText(text: string): WorkerWriteback {
  const trimmed = text.trim();
  const candidate = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  const parsedJson = JSON.parse(candidate);
  const commonContractError = detectCommonWritebackContractError(parsedJson);
  if (commonContractError) {
    throw commonContractError;
  }
  const parsed = WorkerWritebackSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw buildWritebackParseError(parsed.error);
  }

  return parsed.data;
}

async function resolveCommandPath(
  commandName: string,
  pathValue: string
): Promise<string | null> {
  for (const segment of pathValue.split(":")) {
    if (!segment) {
      continue;
    }

    const candidate = join(segment, commandName);
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      continue;
    }
  }

  return null;
}

async function closeStream(stream: {
  end: (callback?: () => void) => void;
  once: (event: string, listener: (error: Error) => void) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function listLiveDescendantPids(rootPid: number): Promise<number[]> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("ps", ["-axo", "pid=,ppid=,stat="], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
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
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr.trim() || `ps exited with code ${code ?? 1}`));
    });
  });

  const childrenByParent = new Map<number, number[]>();
  const liveStateByPid = new Map<number, boolean>();
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/u);
    if (!match) {
      continue;
    }

    const pid = Number.parseInt(match[1] ?? "", 10);
    const ppid = Number.parseInt(match[2] ?? "", 10);
    const stat = normalizeWhitespace(match[3]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) {
      continue;
    }

    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
    liveStateByPid.set(pid, !stat.startsWith("Z"));
  }

  const descendants: number[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (!pid) {
      continue;
    }

    if (liveStateByPid.get(pid) !== false) {
      descendants.push(pid);
    }

    queue.push(...(childrenByParent.get(pid) ?? []));
  }

  return descendants;
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) {
      return;
    }

    throw error;
  }
}

function buildCodexStallMessage(input: {
  progressStallMs: number;
  stalledForMs: number;
  pid: number;
}): string {
  return [
    `Codex CLI stalled for worker pid ${input.pid}.`,
    `No runtime stdout activity arrived for ${input.stalledForMs}ms (stall window ${input.progressStallMs}ms).`,
    "No live child command remained and no final output was written."
  ].join(" ");
}

async function waitForChildExitWithStallGuard(input: {
  child: ReturnType<typeof spawn>;
  outputFile: string;
  progressStallMs: number;
  stallPollMs: number;
  stallKillGraceMs: number;
  getLastActivityAt: () => number;
  hasLiveRuntimeChild?: () => boolean;
  onStallDetected?: (message: string) => void;
}): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    let settled = false;
    let checking = false;
    let stallError: Error | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    const pollMs = Math.max(250, Math.min(input.stallPollMs, input.progressStallMs));

    const cleanup = (): void => {
      clearInterval(interval);
      if (killTimer) {
        clearTimeout(killTimer);
      }
    };

    const finalizeResolve = (code: number): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      if (stallError) {
        reject(stallError);
        return;
      }

      resolve(code);
    };

    const finalizeReject = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const interval = setInterval(() => {
      void (async () => {
        if (
          settled ||
          checking ||
          stallError ||
          input.progressStallMs <= 0 ||
          !input.child.pid
        ) {
          return;
        }

        const stalledForMs = Date.now() - input.getLastActivityAt();
        if (stalledForMs < input.progressStallMs) {
          return;
        }

        checking = true;
        try {
          if (input.hasLiveRuntimeChild?.()) {
            return;
          }

          try {
            await access(input.outputFile, fsConstants.F_OK);
            return;
          } catch {
            // The current hang pattern leaves no final output file behind.
          }

          stallError = new Error(
            buildCodexStallMessage({
              progressStallMs: input.progressStallMs,
              stalledForMs,
              pid: input.child.pid
            })
          );
          input.onStallDetected?.(stallError.message);
          signalProcess(input.child.pid, "SIGTERM");
          killTimer = setTimeout(() => {
            if (!settled && input.child.pid) {
              signalProcess(input.child.pid, "SIGKILL");
            }
          }, input.stallKillGraceMs);
          killTimer.unref?.();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          stallError = new Error(
            `Codex CLI stall watchdog failed while monitoring worker pid ${input.child.pid}. ${message}`
          );
          input.onStallDetected?.(stallError.message);
          if (input.child.pid) {
            signalProcess(input.child.pid, "SIGTERM");
          }
        } finally {
          checking = false;
        }
      })().catch((error) => {
        finalizeReject(error);
      });
    }, pollMs);
    interval.unref?.();

    input.child.on("error", (error) => {
      finalizeReject(error);
    });

    input.child.on("close", (code) => {
      finalizeResolve(code ?? 1);
    });
  });
}

async function buildCodexFailureMessage(input: {
  stderrFile: string;
  defaultMessage: string;
}): Promise<string> {
  const stderr = await readFile(input.stderrFile, "utf8").catch(() => "");
  const excerpt = summarizeCodexStderr(stderr);

  return excerpt ? `${input.defaultMessage}\n${excerpt}` : input.defaultMessage;
}

function summarizeCodexStderr(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  const ignoredPatterns = [
    /^deprecated:/i,
    /^mcp startup:/i,
    /^tokens used$/i,
    /^warning: no last agent message/i,
    /^reconnecting\.\.\./i
  ];
  const preferredPatterns = [
    /^ERROR:/i,
    /^Error:/,
    /unexpected status/i,
    /unauthorized/i,
    /forbidden/i,
    /invalid token/i,
    /listen EPERM/i,
    /AISA research mode blocks/i
  ];

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (ignoredPatterns.some((pattern) => pattern.test(line))) {
      continue;
    }

    if (preferredPatterns.some((pattern) => pattern.test(line))) {
      return `执行器错误输出：${line}`;
    }
  }

  let fallback: string | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (ignoredPatterns.some((pattern) => pattern.test(line))) {
      continue;
    }

    fallback = line;
    break;
  }

  return fallback ? `执行器错误输出：${fallback}` : null;
}

function buildBranchReportMarkdown(
  goal: Goal,
  branch: Branch,
  writeback: WorkerWriteback
): string {
  return [
    `# 分支报告：${branch.id}`,
    "",
    `- 目标：${goal.title}`,
    `- 假设：${branch.hypothesis}`,
    `- 任务：${branch.objective}`,
    `- 置信度：${writeback.confidence}`,
    "",
    "## 摘要",
    "",
    writeback.summary,
    "",
    "## 发现",
    "",
    ...(writeback.findings.length > 0
      ? writeback.findings.flatMap((finding: WorkerWriteback["findings"][number]) => [
          `- [${finding.type}] ${finding.content}`,
          ...finding.evidence.map(
            (evidence: WorkerWriteback["findings"][number]["evidence"][number]) =>
              `  - 证据：${evidence}`
          )
        ])
      : ["- 还没有记录发现。"]),
    "",
    "## 待确认问题",
    "",
    ...(writeback.questions.length > 0
      ? writeback.questions.map((question: WorkerWriteback["questions"][number]) => `- ${question}`)
      : ["- 暂无。"]),
    "",
    "## 建议的下一步",
    "",
    ...(writeback.recommended_next_steps.length > 0
      ? writeback.recommended_next_steps.map(
          (step: WorkerWriteback["recommended_next_steps"][number]) => `- ${step}`
        )
      : ["- 暂无。"]),
    "",
    "## 回放验证计划",
    "",
    ...(writeback.verification_plan?.commands.length
      ? writeback.verification_plan.commands.map(
          (command: VerificationCommand) => `- ${command.purpose}：${command.command}`
        )
      : ["- 暂无。"])
  ].join("\n");
}

function buildAttemptReportMarkdown(
  run: Run,
  attempt: Attempt,
  writeback: WorkerWriteback
): string {
  return [
    `# 尝试报告：${attempt.id}`,
    "",
    `- 运行任务：${run.title}`,
    `- 类型：${attempt.attempt_type}`,
    `- 任务：${attempt.objective}`,
    `- 置信度：${writeback.confidence}`,
    "",
    "## 摘要",
    "",
    writeback.summary,
    "",
    "## 发现",
    "",
    ...(writeback.findings.length > 0
      ? writeback.findings.flatMap((finding: WorkerWriteback["findings"][number]) => [
          `- [${finding.type}] ${finding.content}`,
          ...finding.evidence.map(
            (evidence: WorkerWriteback["findings"][number]["evidence"][number]) =>
              `  - 证据：${evidence}`
          )
        ])
      : ["- 还没有记录发现。"]),
    "",
    "## 待确认问题",
    "",
    ...(writeback.questions.length > 0
      ? writeback.questions.map((question: WorkerWriteback["questions"][number]) => `- ${question}`)
      : ["- 暂无。"]),
    "",
    "## 建议的下一步",
    "",
    ...(writeback.recommended_next_steps.length > 0
      ? writeback.recommended_next_steps.map(
          (step: WorkerWriteback["recommended_next_steps"][number]) => `- ${step}`
        )
      : ["- 暂无。"])
  ].join("\n");
}
