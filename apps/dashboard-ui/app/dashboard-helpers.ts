import { nextActionLabel } from "./copy";
import {
  readFailureSurface,
  readMaintenancePlane,
  readPolicyRuntime,
  readRunBrief,
  readWorkingContext
} from "./dashboard-read-model";
import type {
  RunFocusLens,
  RunInboxFilter,
  RunOperatorState,
  RunPriorityInfo,
  RunSignalBadge,
  RunSummaryItem
} from "./dashboard-types";

const WORKER_HEARTBEAT_STALE_MS = 20_000;

export function pickSelectedId<T>(
  items: T[],
  currentId: string | null,
  readId: (item: T) => string
): string | null {
  if (currentId && items.some((item) => readId(item) === currentId)) {
    return currentId;
  }

  return items[0] ? readId(items[0]) : null;
}

export function splitLines(value: string): string[] {
  return value
    .split("\n")
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength).trimEnd()}...`;
}

export function abbreviateWorkspace(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 4) {
    return value;
  }

  return `.../${segments.slice(-3).join("/")}`;
}

export function runtimePhaseLabel(value: string | null | undefined): string {
  switch (value) {
    case "starting":
      return "启动中";
    case "running":
      return "运行中";
    case "reasoning":
      return "思考中";
    case "planning":
      return "规划中";
    case "tool":
      return "调用工具";
    case "verifying":
      return "验证中";
    case "reviewing":
      return "评审中";
    case "synthesizing":
      return "汇总结论";
    case "writing":
      return "写入改动";
    case "message":
      return "生成内容";
    case "finalizing":
      return "整理输出";
    case "completed":
      return "已完成";
    case "failed":
      return "已失败";
    default:
      return value ?? "暂无";
  }
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "未记录";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "未记录";
  }

  return parsed.toLocaleString("zh-CN");
}

export function toTimestamp(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const timestamp = typeof value === "number" ? value : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function formatClockTime(value: number | null): string {
  if (value === null) {
    return "未同步";
  }

  return new Date(value).toLocaleTimeString("zh-CN", {
    hour12: false
  });
}

export function formatTimeOrFallback(value: number | null): string {
  return value === null ? "未同步" : formatClockTime(value);
}

export function formatDuration(durationMs: number): string {
  const safeDuration = Math.max(0, durationMs);
  const totalSeconds = Math.floor(safeDuration / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days} 天 ${hours} 小时`;
  }

  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分`;
  }

  if (minutes > 0) {
    return `${minutes} 分 ${seconds} 秒`;
  }

  return `${seconds} 秒`;
}

export function formatElapsed(
  value: string | number | null | undefined,
  nowTs: number
): string {
  const timestamp = toTimestamp(value);
  if (timestamp === null) {
    return "未开始";
  }

  return formatDuration(nowTs - timestamp);
}

export function formatRelativeTime(
  value: string | number | null | undefined,
  nowTs: number
): string {
  const timestamp = toTimestamp(value);
  if (timestamp === null) {
    return "未记录";
  }

  const elapsed = Math.max(0, nowTs - timestamp);
  if (elapsed < 3000) {
    return "刚刚";
  }

  return `${formatDuration(elapsed)}前`;
}

export function formatAttemptElapsed(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined
): string {
  const start = toTimestamp(startedAt);
  if (start === null) {
    return "未开始";
  }

  const end = toTimestamp(endedAt) ?? Date.now();
  return formatDuration(end - start);
}

export function deriveRunOperatorState(
  item: RunSummaryItem,
  nowTs: number
): RunOperatorState {
  const failureSignal = item.failure_signal ?? item.run_brief?.failure_signal ?? null;
  const runBrief = readRunBrief(item);
  const failureSurface = readFailureSurface(item);
  const maintenancePlane = readMaintenancePlane(item);
  const workingContext = readWorkingContext(item);
  const heartbeatAt = toTimestamp(maintenancePlane.heartbeat_at);
  const attemptStartedAt = toTimestamp(item.latest_attempt?.started_at);
  const waitingForHuman = runBrief.waiting_for_human;
  const hasBlockingReason =
    failureSurface?.source === "policy_runtime" && Boolean(failureSurface.summary);
  const hasRuntimeError =
    failureSurface?.source === "runtime" && Boolean(failureSurface.summary);
  const hasWorkingContextDegraded = item.working_context_degraded?.is_degraded === true;
  const isRunning =
    readPolicyRuntime(item).status === "running" ||
    item.latest_attempt?.status === "running";
  const staleHeartbeat =
    isRunning &&
    ((heartbeatAt !== null &&
      nowTs - heartbeatAt >
        (maintenancePlane.stale_after_ms ?? WORKER_HEARTBEAT_STALE_MS)) ||
      (heartbeatAt === null &&
        attemptStartedAt !== null &&
        nowTs - attemptStartedAt >
          (maintenancePlane.stale_after_ms ?? WORKER_HEARTBEAT_STALE_MS)));

  if (
    waitingForHuman ||
    hasBlockingReason ||
    failureSignal?.policy_mode === "fail_closed"
  ) {
    return {
      kind: "needs_action",
      label: "待处理",
      tone: "rose",
      reason:
        failureSignal?.summary ||
        failureSurface?.summary ||
        "当前运行明确在等待人工决策或恢复动作。",
      recovery_hint: inferRecoveryHint(item, staleHeartbeat),
      sort_order: 0
    };
  }

  if (
    hasRuntimeError ||
    staleHeartbeat ||
    hasWorkingContextDegraded ||
    failureSignal?.policy_mode === "soft_degrade"
  ) {
    return {
      kind: "at_risk",
      label: "有风险",
      tone: "amber",
      reason:
        failureSignal?.summary ??
        failureSurface?.summary ??
        item.working_context_degraded?.summary ??
        "运行还在继续，但心跳或实时信号已经偏陈旧，需要先确认 worker 是否卡住。",
      recovery_hint: inferRecoveryHint(item, staleHeartbeat),
      sort_order: 1
    };
  }

  if (isRunning) {
    return {
      kind: "active",
      label: "推进中",
      tone: "emerald",
      reason:
        workingContext.progress_text?.trim() ||
        runBrief.summary ||
        "运行正在沿当前判断持续推进。",
      recovery_hint:
        "继续观察当前尝试与回放证据；只有在出现卡点或错误时再人工接管。",
      sort_order: 2
    };
  }

  return {
    kind: "watch",
    label: "待观察",
    tone: "amber",
    reason:
      runBrief.summary || "当前没有进行中的尝试，保留在运行池中供后续继续推进。",
    recovery_hint:
      runBrief.recommended_next_action &&
      runBrief.recommended_next_action !== "wait_for_human"
        ? `当前建议动作：${nextActionLabel(runBrief.recommended_next_action)}。`
        : "先打开运行详情，确认下一轮是否该继续研究、执行，或补一条 steer。",
    sort_order: 3
  };
}

export function runMatchesFocusLens(
  item: RunSummaryItem,
  lens: RunFocusLens,
  nowTs: number
): boolean {
  if (lens === "all") {
    return true;
  }

  const staleHeartbeat = hasStaleRunHeartbeat(item, nowTs);
  const runBrief = readRunBrief(item);
  const failureSurface = readFailureSurface(item);

  if (lens === "waiting_human") {
    return runBrief.waiting_for_human || Boolean(runBrief.blocking_reason);
  }

  if (lens === "replay_gap") {
    return (
      item.latest_attempt?.attempt_type === "execution" &&
      item.verification_command_count === 0
    );
  }

  if (lens === "runtime_fault") {
    return (
      (failureSurface?.source === "runtime" && Boolean(failureSurface.summary)) ||
      staleHeartbeat
    );
  }

  return !item.latest_attempt;
}

export function deriveRunSignalBadges(
  item: RunSummaryItem,
  nowTs: number
): RunSignalBadge[] {
  const badges: RunSignalBadge[] = [];
  const failureSignal = item.failure_signal ?? item.run_brief?.failure_signal ?? null;
  const runBrief = readRunBrief(item);
  const failureSurface = readFailureSurface(item);
  const maintenancePlane = readMaintenancePlane(item);
  const detail = [
    failureSurface?.summary,
    item.working_context_degraded?.summary,
    runBrief.summary
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const heartbeatAt = toTimestamp(maintenancePlane.heartbeat_at);
  const attemptStartedAt = toTimestamp(item.latest_attempt?.started_at);
  const isRunning =
    readPolicyRuntime(item).status === "running" ||
    item.latest_attempt?.status === "running";
  const staleHeartbeat =
    isRunning &&
    ((heartbeatAt !== null &&
      nowTs - heartbeatAt >
        (maintenancePlane.stale_after_ms ?? WORKER_HEARTBEAT_STALE_MS)) ||
      (heartbeatAt === null &&
        attemptStartedAt !== null &&
        nowTs - attemptStartedAt >
          (maintenancePlane.stale_after_ms ?? WORKER_HEARTBEAT_STALE_MS)));

  if (runBrief.waiting_for_human) {
    badges.push({ key: "waiting-human", label: "需要处理", tone: "rose" });
  }

  if (failureSignal) {
    badges.push({
      key: `failure-signal-${failureSignal.failure_class}`,
      label: failureSignal.failure_code ?? failureSignal.failure_class,
      tone: failureSignal.policy_mode === "fail_closed" ? "rose" : "amber"
    });
  }

  if (detail.includes("restart") || detail.includes("source drift")) {
    badges.push({ key: "restart-required", label: "需重启 runtime", tone: "rose" });
  }

  if (
    detail.includes("toolchain") ||
    detail.includes("node_modules") ||
    detail.includes("pnpm") ||
    detail.includes("tsx")
  ) {
    badges.push({ key: "toolchain", label: "缺工具链", tone: "amber" });
  }

  if (detail.includes("rate limit") || detail.includes("429")) {
    badges.push({ key: "provider-limit", label: "provider 限流", tone: "amber" });
  }

  if (failureSurface?.source === "runtime" && failureSurface.summary) {
    badges.push({ key: "runtime-error", label: "runtime 错误", tone: "rose" });
  }

  if (item.working_context_degraded?.is_degraded) {
    badges.push({
      key: "working-context-degraded",
      label: "现场降级",
      tone: "amber"
    });
  }

  if (staleHeartbeat) {
    badges.push({ key: "stale-heartbeat", label: "心跳陈旧", tone: "amber" });
  }

  if (!item.latest_attempt) {
    badges.push({ key: "not-started", label: "未启动", tone: "amber" });
  }

  if (
    item.verification_command_count === 0 &&
    item.latest_attempt?.attempt_type === "execution"
  ) {
    badges.push({ key: "no-replay-contract", label: "无回放约定", tone: "amber" });
  }

  if (badges.length === 0) {
    badges.push({ key: "healthy", label: "正常推进", tone: "emerald" });
  }

  return badges;
}

export function deriveRunInboxReasons(
  item: RunSummaryItem,
  filter: RunInboxFilter,
  lens: RunFocusLens,
  nowTs: number
): string[] {
  const reasons: string[] = [];
  const operatorState = deriveRunOperatorState(item, nowTs);
  const staleHeartbeat = hasStaleRunHeartbeat(item, nowTs);
  const runBrief = readRunBrief(item);
  const failureSurface = readFailureSurface(item);

  if (lens === "waiting_human") {
    if (runBrief.waiting_for_human) {
      reasons.push("这条运行已经明确需要你处理。");
    } else if (runBrief.blocking_reason) {
      reasons.push("已经出现卡点原因，适合先人工判断。");
    }
  }

  if (lens === "replay_gap") {
    if (
      item.latest_attempt?.attempt_type === "execution" &&
      item.verification_command_count === 0
    ) {
      reasons.push("执行已开始，但验证记录还没补齐。");
    }
  }

  if (lens === "runtime_fault") {
    if (failureSurface?.source === "runtime" && failureSurface.summary) {
      reasons.push("运行已经报错。");
    }
    if (staleHeartbeat) {
      reasons.push("worker 心跳已陈旧，先确认是否假活。");
    }
  }

  if (lens === "unstarted" && !item.latest_attempt) {
    reasons.push("还没有第一次尝试，可以优先启动。");
  }

  if (filter === "needs_action") {
    if (operatorState.kind === "needs_action") {
      reasons.push("当前属于明确需介入队列。");
    } else if (operatorState.kind === "at_risk") {
      reasons.push("当前属于风险排查队列。");
    }
  }

  if (filter === "active" && operatorState.kind === "active") {
    reasons.push("当前正在推进，适合持续观察。");
  }

  if (filter === "watch" && operatorState.kind === "watch") {
    reasons.push("当前没有进行中尝试，放在观察池等待下一步。");
  }

  if (reasons.length === 0 && lens === "all" && filter === "all") {
    reasons.push("当前在总运行池中，按最新信号持续巡检。");
  }

  return Array.from(new Set(reasons)).slice(0, 2);
}

export function deriveRunPriorityInfo(
  item: RunSummaryItem,
  focusLens: RunFocusLens,
  nowTs: number
): RunPriorityInfo {
  const operatorState = deriveRunOperatorState(item, nowTs);
  const failureSignal = item.failure_signal ?? item.run_brief?.failure_signal ?? null;
  const staleHeartbeat = hasStaleRunHeartbeat(item, nowTs);
  const failureSurface = readFailureSurface(item);
  const runBrief = readRunBrief(item);
  const hasRuntimeError =
    failureSurface?.source === "runtime" && Boolean(failureSurface.summary);
  const hasWorkingContextDegraded = item.working_context_degraded?.is_degraded === true;
  const waitingForHuman = runBrief.waiting_for_human;
  const hasBlockingReason =
    failureSurface?.source === "policy_runtime" && Boolean(failureSurface.summary);
  const replayGap =
    item.latest_attempt?.attempt_type === "execution" &&
    item.verification_command_count === 0;
  const coldStart = !item.latest_attempt;

  let score = 20;
  let label = "P3 观察";
  let reason = "当前没有明显急迫信号，保持巡检即可。";
  let tone: RunPriorityInfo["tone"] = "emerald";

  if (operatorState.kind === "active") {
    score = 48;
    label = "P2 跟进";
    reason = "运行仍在推进，适合持续观察而不是立刻打断。";
  }

  if (coldStart) {
    score = 64;
    label = "P2 冷启动";
    reason = "这条 run 还没有首个 attempt，适合补第一次推进。";
    tone = "amber";
  }

  if (replayGap) {
    score = 78;
    label = "P1 验证记录不完整";
    reason = "已经开始执行，但验证记录还不完整。";
    tone = "amber";
  }

  if (staleHeartbeat) {
    score = 90;
    label = "P1 心跳异常";
    reason = "worker 心跳偏陈旧，需要优先确认运行是否假活。";
    tone = "amber";
  }

  if (hasWorkingContextDegraded) {
    score = 94;
    label = "P1 现场降级";
    reason =
      item.working_context_degraded?.summary ??
      "active run 的 working context 已缺失或过期，需要先修现场。";
    tone = "amber";
  }

  if (failureSignal?.policy_mode === "soft_degrade") {
    score = Math.max(score, 96);
    label = "P1 信号降级";
    reason = failureSignal.summary;
    tone = "amber";
  }

  if (hasBlockingReason) {
    score = 98;
    label = "P0 阻塞待决";
    reason = "当前已有 blocking reason，继续放着通常不会自己恢复。";
    tone = "rose";
  }

  if (hasRuntimeError) {
    score = 106;
    label = "P0 运行出错";
    reason = "运行已经明确报错，优先级高于普通等待和观察。";
    tone = "rose";
  }

  if (waitingForHuman) {
    score = 114;
    label = "P0 需要你处理";
    reason = "运行已经明确需要你处理，应该最先处理。";
    tone = "rose";
  }

  if (failureSignal?.policy_mode === "fail_closed") {
    score = Math.max(score, 112);
    label = "P0 闭环失败";
    reason = failureSignal.summary;
    tone = "rose";
  }

  if (focusLens === "waiting_human" && (waitingForHuman || hasBlockingReason)) {
    score += 6;
  }

  if (focusLens === "runtime_fault" && (hasRuntimeError || staleHeartbeat)) {
    score += 6;
  }

  if (focusLens === "replay_gap" && replayGap) {
    score += 6;
  }

  if (focusLens === "unstarted" && coldStart) {
    score += 6;
  }

  return {
    score,
    label,
    reason,
    tone
  };
}

export function deriveRunOperatorChecklist(
  item: RunSummaryItem,
  nowTs: number
): string[] {
  const checklist: string[] = [];
  const runBrief = readRunBrief(item);
  const failureSurface = readFailureSurface(item);
  const maintenancePlane = readMaintenancePlane(item);
  const detail = [
    failureSurface?.summary,
    item.working_context_degraded?.summary,
    runBrief.summary
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const heartbeatAt = toTimestamp(maintenancePlane.heartbeat_at);
  const attemptStartedAt = toTimestamp(item.latest_attempt?.started_at);
  const isRunning =
    readPolicyRuntime(item).status === "running" ||
    item.latest_attempt?.status === "running";
  const staleHeartbeat =
    isRunning &&
    ((heartbeatAt !== null &&
      nowTs - heartbeatAt >
        (maintenancePlane.stale_after_ms ?? WORKER_HEARTBEAT_STALE_MS)) ||
      (heartbeatAt === null &&
        attemptStartedAt !== null &&
        nowTs - attemptStartedAt >
          (maintenancePlane.stale_after_ms ?? WORKER_HEARTBEAT_STALE_MS)));

  if (runBrief.waiting_for_human) {
    checklist.push("先处理这条需要你拍板的事：确认是补 steer、继续下一次尝试，还是暂时挂起。");
  }

  if (runBrief.blocking_reason) {
    checklist.push("先看卡点原因与当前建议，确认问题是环境、策略，还是缺人工输入。");
  }

  if (failureSurface?.source === "runtime" && failureSurface.summary) {
    checklist.push("打开当前错误、stderr 和 process content，先判断失败是否来自 runtime 或工具链。");
  }

  if (item.working_context_degraded?.is_degraded) {
    checklist.push("先读 run detail 顶部的现场记录区块，确认现场是缺失、过期，还是写入失败。");
  }

  if (staleHeartbeat) {
    checklist.push("检查 worker 心跳、会话和最近事件，确认这条 run 是否已经假活或卡死。");
  }

  if (
    item.verification_command_count === 0 &&
    item.latest_attempt?.attempt_type === "execution"
  ) {
    checklist.push("补上回放命令和验证约定，避免 execution attempt 变成不可复盘黑盒。");
  }

  if (!item.latest_attempt) {
    checklist.push("这条 run 还没有真实尝试，先启动第一次 attempt 再谈后续介入。");
  }

  if (detail.includes("rate limit") || detail.includes("429")) {
    checklist.push("当前更像 provider 窗口问题，先等待恢复，不要急着手动重复同一尝试。");
  }

  if (
    runBrief.recommended_next_action &&
    runBrief.recommended_next_action !== "wait_for_human"
  ) {
    checklist.push(`若当前尝试结束，优先执行建议动作：${nextActionLabel(runBrief.recommended_next_action)}。`);
  }

  if (checklist.length === 0) {
    checklist.push("当前没有明显风险信号，继续观察最近活动、回放结果和最终输出。");
  }

  return checklist;
}

function inferRecoveryHint(item: RunSummaryItem, staleHeartbeat: boolean): string {
  const failureSignal = item.failure_signal ?? item.run_brief?.failure_signal ?? null;
  const runBrief = readRunBrief(item);
  const failureSurface = readFailureSurface(item);
  const detail = [
    failureSurface?.summary,
    item.working_context_degraded?.summary,
    runBrief.summary
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (failureSignal?.failure_class === "preflight_blocked") {
    return "先读发车前结果和对应约定，再补齐硬门、验证计划或工具链。";
  }

  if (failureSignal?.failure_class === "runtime_verification_failed") {
    return "先读运行时回放结果，再决定是修代码、补验证命令，还是放弃这轮 execution。";
  }

  if (failureSignal?.failure_class === "adversarial_verification_failed") {
    return "先读对抗验证输出，复现那个坏路径，再决定下一轮 execution 怎么修。";
  }

  if (failureSignal?.failure_class === "handoff_incomplete") {
    return "先补出交接说明，再继续自动续跑或人工接手。";
  }

  if (detail.includes("restart") || detail.includes("source drift")) {
    return "先重启 control-api 或相关 runtime 进程，再确认这条 run 是否已经恢复到可继续状态。";
  }

  if (
    detail.includes("toolchain") ||
    detail.includes("node_modules") ||
    detail.includes("pnpm") ||
    detail.includes("tsx")
  ) {
    return "先补齐本地 toolchain 和依赖，再恢复运行；这类问题通常不会靠自动重试自己消失。";
  }

  if (detail.includes("rate limit") || detail.includes("429")) {
    return "先等待 provider 窗口恢复，再观察自动续跑；不要急着手动重放相同尝试。";
  }

  if (staleHeartbeat) {
    return "优先检查 worker 会话、stderr 和 heartbeat；如果尝试已经僵住，再决定是否手动恢复。";
  }

  if (item.working_context_degraded?.is_degraded) {
    return "先修现场记录，再决定要不要继续长任务；不要在现场失真的情况下硬推下一轮。";
  }

  if (runBrief.waiting_for_human) {
    return "先看处理建议、最近尝试和回放结果，再决定是补 steer、重试，还是继续下一次尝试。";
  }

  if (!item.latest_attempt) {
    return "这条 run 还没有真正开始，先启动首次尝试，再看后续信号。";
  }

  if (
    runBrief.recommended_next_action &&
    runBrief.recommended_next_action !== "wait_for_human"
  ) {
    return `当前运行已经给出下一动作：${nextActionLabel(runBrief.recommended_next_action)}。`;
  }

  return "先打开运行详情，确认当前卡点和下一步建议，再决定是否手动介入。";
}

export function filterRunsByInboxState(
  runs: RunSummaryItem[],
  filter: RunInboxFilter,
  nowTs: number
): RunSummaryItem[] {
  if (filter === "all") {
    return runs;
  }

  return runs.filter((item) => {
    const state = deriveRunOperatorState(item, nowTs);
    if (filter === "needs_action") {
      return state.kind === "needs_action" || state.kind === "at_risk";
    }
    if (filter === "active") {
      return state.kind === "active";
    }
    return state.kind === "watch";
  });
}

export function countRunsByInboxFilter(
  runs: RunSummaryItem[],
  filter: RunInboxFilter,
  nowTs: number
): number {
  return filterRunsByInboxState(runs, filter, nowTs).length;
}

export function filterRunsByFocusLens(
  runs: RunSummaryItem[],
  lens: RunFocusLens,
  nowTs: number
): RunSummaryItem[] {
  return runs.filter((item) => runMatchesFocusLens(item, lens, nowTs));
}

export function countRunsByFocusLens(
  runs: RunSummaryItem[],
  lens: RunFocusLens,
  nowTs: number
): number {
  return filterRunsByFocusLens(runs, lens, nowTs).length;
}

export function sortRunsForInbox(
  runs: RunSummaryItem[],
  focusLens: RunFocusLens,
  nowTs: number
): RunSummaryItem[] {
  return [...runs].sort((left, right) => {
    const leftPriority = deriveRunPriorityInfo(left, focusLens, nowTs);
    const rightPriority = deriveRunPriorityInfo(right, focusLens, nowTs);
    const priorityDelta = rightPriority.score - leftPriority.score;
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    const leftUpdated =
      toTimestamp(
        readRunBrief(left).updated_at ??
          readMaintenancePlane(left).heartbeat_at ??
          left.latest_attempt?.started_at ??
          left.run.created_at
      ) ?? 0;
    const rightUpdated =
      toTimestamp(
        readRunBrief(right).updated_at ??
          readMaintenancePlane(right).heartbeat_at ??
          right.latest_attempt?.started_at ??
          right.run.created_at
      ) ?? 0;

    return rightUpdated - leftUpdated;
  });
}

export function listInterventionRuns(
  runs: RunSummaryItem[],
  nowTs: number
): Array<{
  run: RunSummaryItem;
  state: RunOperatorState;
}> {
  return runs
    .map((run) => ({
      run,
      state: deriveRunOperatorState(run, nowTs)
    }))
    .filter(({ state }) => state.kind === "needs_action" || state.kind === "at_risk")
    .sort((left, right) => {
      const orderDelta = left.state.sort_order - right.state.sort_order;
      if (orderDelta !== 0) {
        return orderDelta;
      }

      const leftUpdated =
        toTimestamp(readRunBrief(left.run).updated_at ?? left.run.run.created_at) ?? 0;
      const rightUpdated =
        toTimestamp(readRunBrief(right.run).updated_at ?? right.run.run.created_at) ?? 0;
      return rightUpdated - leftUpdated;
    });
}

function hasStaleRunHeartbeat(item: RunSummaryItem, nowTs: number): boolean {
  const maintenancePlane = readMaintenancePlane(item);
  const heartbeatAt = toTimestamp(maintenancePlane.heartbeat_at);
  const attemptStartedAt = toTimestamp(item.latest_attempt?.started_at);
  const isRunning =
    readPolicyRuntime(item).status === "running" ||
    item.latest_attempt?.status === "running";

  return (
    isRunning &&
    ((heartbeatAt !== null &&
      nowTs - heartbeatAt >
        (maintenancePlane.stale_after_ms ?? WORKER_HEARTBEAT_STALE_MS)) ||
      (heartbeatAt === null &&
        attemptStartedAt !== null &&
        nowTs - attemptStartedAt >
          (maintenancePlane.stale_after_ms ?? WORKER_HEARTBEAT_STALE_MS)))
  );
}
