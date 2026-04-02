import {
  localizeUiText,
  nextActionLabel,
  statusLabel,
  workerLabel
} from "./copy";
import {
  abbreviateWorkspace,
  countRunsByFocusLens,
  countRunsByInboxFilter,
  deriveRunInboxReasons,
  deriveRunOperatorState,
  deriveRunPriorityInfo,
  deriveRunSignalBadges,
  filterRunsByFocusLens,
  filterRunsByInboxState,
  formatDateTime,
  formatElapsed,
  formatRelativeTime,
  listInterventionRuns,
  runtimePhaseLabel,
  sortRunsForInbox,
  truncateText
} from "./dashboard-helpers";
import { EmptyState, InlineTag, Panel, StatusPill } from "./dashboard-primitives";
import { MeasuredText } from "./measured-text";
import type { RunFocusLens, RunInboxFilter, RunSummaryItem } from "./dashboard-types";

const FILTER_OPTIONS: Array<{
  filter: RunInboxFilter;
  label: string;
}> = [
  { filter: "all", label: "全部" },
  { filter: "needs_action", label: "需介入" },
  { filter: "active", label: "推进中" },
  { filter: "watch", label: "待观察" }
];

const FOCUS_LENS_OPTIONS: Array<{
  lens: RunFocusLens;
  label: string;
}> = [
  { lens: "all", label: "全部信号" },
  { lens: "waiting_human", label: "等待人工" },
  { lens: "replay_gap", label: "缺回放契约" },
  { lens: "runtime_fault", label: "runtime 风险" },
  { lens: "unstarted", label: "未启动" }
];

const PRESET_OPTIONS: Array<{
  key: string;
  label: string;
  description: string;
  filter: RunInboxFilter;
  lens: RunFocusLens;
}> = [
  {
    key: "human-handoff",
    label: "待人工接球",
    description: "明确等待人工、blocking reason 已出现的 run。",
    filter: "needs_action",
    lens: "waiting_human"
  },
  {
    key: "runtime-risk",
    label: "Runtime 风险",
    description: "当前更像会卡死、报错或信号异常的问题。",
    filter: "needs_action",
    lens: "runtime_fault"
  },
  {
    key: "replay-gap",
    label: "缺回放契约",
    description: "execution 已开始，但 operator 还不能放心让 runtime 自证。",
    filter: "all",
    lens: "replay_gap"
  },
  {
    key: "cold-start",
    label: "冷启动池",
    description: "还没真正开始的 run，适合补首次 attempt 或 steer。",
    filter: "watch",
    lens: "unstarted"
  }
];

function runHealthLabel(status: string | null | undefined): string {
  return status ? statusLabel(status) : "未知";
}

function selectionTone(
  activeFilter: RunInboxFilter,
  focusLens: RunFocusLens
): "rose" | "amber" | "emerald" {
  if (focusLens === "waiting_human") {
    return "rose";
  }

  if (
    activeFilter === "needs_action" ||
    focusLens === "runtime_fault" ||
    focusLens === "replay_gap" ||
    focusLens === "unstarted"
  ) {
    return "amber";
  }

  return "emerald";
}

function describeInboxSelection(
  activeFilter: RunInboxFilter,
  focusLens: RunFocusLens,
  activePreset: (typeof PRESET_OPTIONS)[number] | null,
  filteredCount: number
) {
  if (activePreset) {
    return {
      eyebrow: "Operator Preset",
      title: activePreset.label,
      description: activePreset.description,
      countLabel: filteredCount === 1 ? "1 条 run 命中" : `${filteredCount} 条 run 命中`,
      tone: selectionTone(activeFilter, focusLens)
    };
  }

  const filterLabel = FILTER_OPTIONS.find((option) => option.filter === activeFilter)?.label ?? "全部";
  const lensLabel =
    FOCUS_LENS_OPTIONS.find((option) => option.lens === focusLens)?.label ?? "全部信号";
  const descriptionParts: string[] = [];

  if (activeFilter === "all") {
    descriptionParts.push("当前先看整个运行池。");
  } else if (activeFilter === "needs_action") {
    descriptionParts.push("当前优先扫明确需介入或风险偏高的运行。");
  } else if (activeFilter === "active") {
    descriptionParts.push("当前只看仍在持续推进的运行。");
  } else {
    descriptionParts.push("当前只看没有进行中尝试、但仍值得保留的运行。");
  }

  if (focusLens === "waiting_human") {
    descriptionParts.push("列表进一步收窄到等待人工或已有 blocking reason 的 run。");
  } else if (focusLens === "replay_gap") {
    descriptionParts.push("列表进一步强调已经执行、但缺少回放契约的 run。");
  } else if (focusLens === "runtime_fault") {
    descriptionParts.push("列表进一步强调 runtime 报错或心跳陈旧的 run。");
  } else if (focusLens === "unstarted") {
    descriptionParts.push("列表进一步强调还没跑出首个 attempt 的 run。");
  }

  return {
    eyebrow: "Current Slice",
    title:
      activeFilter === "all" && focusLens === "all"
        ? "全部运行"
        : `${filterLabel} / ${lensLabel}`,
    description: descriptionParts.join(" "),
    countLabel: filteredCount === 1 ? "1 条 run 命中" : `${filteredCount} 条 run 命中`,
    tone: selectionTone(activeFilter, focusLens)
  };
}

function emptyStateText(
  activeFilter: RunInboxFilter,
  focusLens: RunFocusLens,
  activePreset: (typeof PRESET_OPTIONS)[number] | null
): string {
  if (activePreset) {
    return `当前“${activePreset.label}”预设下没有运行任务，可以切到其他预设继续巡检。`;
  }

  if (focusLens === "waiting_human") {
    return "当前没有等待人工或明确 blocking reason 的运行。";
  }

  if (focusLens === "replay_gap") {
    return "当前没有命中“缺回放契约”的运行。";
  }

  if (focusLens === "runtime_fault") {
    return "当前没有 runtime 错误或心跳陈旧的运行。";
  }

  if (focusLens === "unstarted") {
    return "当前没有尚未启动的运行。";
  }

  if (activeFilter === "needs_action") {
    return "当前没有需要人工介入或优先排查的运行。";
  }

  if (activeFilter === "active") {
    return "当前没有处于推进中的运行。";
  }

  if (activeFilter === "watch") {
    return "当前没有处于观察池的运行。";
  }

  return "当前筛选下没有运行任务。";
}

export function InterventionQueuePanel({
  runs,
  nowTs,
  selectedRunId,
  onSelectRun
}: {
  runs: RunSummaryItem[];
  nowTs: number;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}) {
  const queuedRuns = listInterventionRuns(runs, nowTs).slice(0, 6);

  return (
    <Panel
      title={`人工介入队列 · ${queuedRuns.length}`}
      subtitle="先处理明确卡住、等待人工或实时信号异常的运行。"
    >
      <div className="intervention-queue">
        {queuedRuns.length === 0 ? (
          <EmptyState text="当前没有需要立刻人工接管的运行。" />
        ) : (
          queuedRuns.map(({ run, state }) => {
            const selected = run.run.id === selectedRunId;
            const signalBadges = deriveRunSignalBadges(run, nowTs).slice(0, 3);
            return (
              <button
                key={run.run.id}
                type="button"
                className={`queue-card queue-card-${state.tone}${selected ? " is-selected" : ""}`}
                onClick={() => onSelectRun(run.run.id)}
              >
                <div className="queue-card-head">
                  <strong>{localizeUiText(run.run.title)}</strong>
                  <span className={`queue-chip queue-chip-${state.tone}`}>{state.label}</span>
                </div>
                <div className="signal-badge-row signal-badge-row-compact">
                  {signalBadges.map((badge) => (
                    <span key={badge.key} className={`signal-badge signal-badge-${badge.tone}`}>
                      {badge.label}
                    </span>
                  ))}
                </div>
                <MeasuredText
                  className="queue-card-summary"
                  lines={2}
                  text={truncateText(localizeUiText(run.run_brief?.headline ?? state.reason), 180)}
                />
                <MeasuredText
                  className="queue-card-summary"
                  lines={2}
                  text={truncateText(localizeUiText(run.run_brief?.summary ?? state.recovery_hint), 180)}
                />
                <div className="queue-card-meta">
                  {run.current?.recommended_next_action
                    ? `下一动作 ${nextActionLabel(run.current.recommended_next_action)}`
                    : "先看详情"}
                  {run.current?.updated_at
                    ? ` · 最近判断 ${formatRelativeTime(run.current.updated_at, nowTs)}`
                    : ""}
                </div>
              </button>
            );
          })
        )}
      </div>
    </Panel>
  );
}

export function RunInboxPanel({
  runs,
  nowTs,
  selectedRunId,
  activeFilter,
  focusLens,
  onFilterChange,
  onFocusLensChange,
  onSelectRun
}: {
  runs: RunSummaryItem[];
  nowTs: number;
  selectedRunId: string | null;
  activeFilter: RunInboxFilter;
  focusLens: RunFocusLens;
  onFilterChange: (filter: RunInboxFilter) => void;
  onFocusLensChange: (lens: RunFocusLens) => void;
  onSelectRun: (runId: string) => void;
}) {
  const filteredRuns = sortRunsForInbox(
    filterRunsByFocusLens(filterRunsByInboxState(runs, activeFilter, nowTs), focusLens, nowTs),
    focusLens,
    nowTs
  );
  const activePreset =
    PRESET_OPTIONS.find(
      (option) => option.filter === activeFilter && option.lens === focusLens
    ) ?? null;
  const selection = describeInboxSelection(activeFilter, focusLens, activePreset, filteredRuns.length);

  return (
    <Panel
      title={`运行池 · ${runs.length}`}
      subtitle="先用运行状态分组，再用 operator focus lens 缩小真正要优先看的 run。"
    >
      <div className="preset-grid" aria-label="operator presets">
        {PRESET_OPTIONS.map((option) => {
          const presetCount = filterRunsByFocusLens(
            filterRunsByInboxState(runs, option.filter, nowTs),
            option.lens,
            nowTs
          ).length;

          return (
            <button
              key={option.key}
              type="button"
              className={`preset-card${activePreset?.key === option.key ? " is-active" : ""}`}
              onClick={() => {
                onFilterChange(option.filter);
                onFocusLensChange(option.lens);
              }}
            >
              <div className="preset-card-head">
                <strong>{option.label}</strong>
                <span>{String(presetCount).padStart(2, "0")}</span>
              </div>
              <p>{option.description}</p>
            </button>
          );
        })}
      </div>

      <div className={`inbox-selection inbox-selection-${selection.tone}`}>
        <div className="inbox-selection-copy">
          <span className="inbox-selection-eyebrow">{selection.eyebrow}</span>
          <strong>{selection.title}</strong>
          <p>{selection.description}</p>
          <div className="inbox-selection-tags">
            <InlineTag label={`状态池 · ${
              FILTER_OPTIONS.find((option) => option.filter === activeFilter)?.label ?? "全部"
            }`} />
            {focusLens !== "all" ? (
              <InlineTag
                label={`Focus · ${
                  FOCUS_LENS_OPTIONS.find((option) => option.lens === focusLens)?.label ?? "全部信号"
                }`}
                tone="amber"
              />
            ) : null}
          </div>
        </div>
        <div className="inbox-selection-count">
          <strong>{String(filteredRuns.length).padStart(2, "0")}</strong>
          <span>{selection.countLabel}</span>
        </div>
      </div>

      <div className="filter-row" aria-label="运行池筛选">
        {FILTER_OPTIONS.map((option) => (
          <button
            key={option.filter}
            type="button"
            className={`filter-chip${activeFilter === option.filter ? " is-active" : ""}`}
            onClick={() => onFilterChange(option.filter)}
          >
            {option.label} · {countRunsByInboxFilter(runs, option.filter, nowTs)}
          </button>
        ))}
      </div>

      <div className="filter-row filter-row-secondary" aria-label="operator focus lens">
        {FOCUS_LENS_OPTIONS.map((option) => (
          <button
            key={option.lens}
            type="button"
            className={`filter-chip filter-chip-secondary${focusLens === option.lens ? " is-active" : ""}`}
            onClick={() => onFocusLensChange(option.lens)}
          >
            {option.label} · {countRunsByFocusLens(runs, option.lens, nowTs)}
          </button>
        ))}
      </div>

      <div className="run-list">
        {filteredRuns.length === 0 ? (
          <EmptyState text={emptyStateText(activeFilter, focusLens, activePreset)} />
        ) : (
          filteredRuns.map((item) => {
            const selected = item.run.id === selectedRunId;
            const runtimeState = item.latest_attempt_runtime_state;
            const operatorState = deriveRunOperatorState(item, nowTs);
            const priority = deriveRunPriorityInfo(item, focusLens, nowTs);
            const signalBadges = deriveRunSignalBadges(item, nowTs).slice(0, 4);
            const inboxReasons = deriveRunInboxReasons(item, activeFilter, focusLens, nowTs);
            const taskFocus = truncateText(
              localizeUiText(
                item.run_brief?.primary_focus ?? item.task_focus ?? item.run.description
              ),
              120
            );
            const taskSummary = truncateText(
              localizeUiText(
                item.run_brief?.headline ??
                  item.latest_handoff_bundle?.summary ??
                  item.latest_adversarial_verification?.failure_reason ??
                  item.latest_runtime_verification?.failure_reason ??
                  item.current?.blocking_reason ??
                  item.current?.summary ??
                  item.run.description
              ),
              110
            );
            const governanceHeadline = truncateText(
              localizeUiText(
                item.latest_preflight_evaluation?.failure_reason ??
                  item.latest_adversarial_verification?.failure_reason ??
                  item.latest_runtime_verification?.failure_reason ??
                  item.governance?.context_summary.headline ??
                  ""
              ),
              110
            );
            const workspaceLabel = abbreviateWorkspace(item.run.workspace_root);
            const latestRunSignalAt =
              item.current?.updated_at ??
              item.latest_attempt_heartbeat?.heartbeat_at ??
              item.latest_attempt?.ended_at ??
              item.latest_attempt?.started_at ??
              item.run.created_at;
            const runningSince =
              item.latest_attempt?.status === "running" ? item.latest_attempt.started_at : null;
            const liveProgress = truncateText(
              localizeUiText(
                runtimeState?.progress_text ?? runtimeState?.recent_activities.at(-1) ?? ""
              ),
              110
            );
            const governanceStatus = item.governance ? statusLabel(item.governance.status) : "未建";
            const healthStatus = runHealthLabel(item.run_health?.status);

            return (
              <button
                key={item.run.id}
                type="button"
                className={`goal-card run-card${selected ? " is-selected" : ""}`}
                onClick={() => onSelectRun(item.run.id)}
              >
                <div className="goal-card-head">
                  <strong>{localizeUiText(item.run.title)}</strong>
                  <StatusPill value={item.current?.run_status ?? "draft"} />
                </div>
                <div className="run-card-topline">
                  <span className={`queue-chip queue-chip-${operatorState.tone}`}>
                    {operatorState.label}
                  </span>
                  <span className={`priority-chip priority-chip-${priority.tone}`}>
                    {priority.label}
                  </span>
                  <span className="run-card-id">{item.run.id}</span>
                  {item.latest_attempt ? (
                    <span className="run-card-id">
                      {workerLabel(item.latest_attempt.worker)} ·{" "}
                      {statusLabel(item.latest_attempt.status)}
                    </span>
                  ) : null}
                </div>
                <MeasuredText className="run-card-focus" lines={2} text={taskFocus} />
                <div className="signal-badge-row signal-badge-row-compact">
                  {signalBadges.map((badge) => (
                    <span key={badge.key} className={`signal-badge signal-badge-${badge.tone}`}>
                      {badge.label}
                    </span>
                  ))}
                </div>
                {inboxReasons.length > 0 ? (
                  <div className="triage-hit-row">
                    {inboxReasons.map((reason) => (
                      <span key={`${item.run.id}-${reason}`} className="triage-hit">
                        {reason}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="run-card-chips">
                  <span className="run-card-chip">尝试 {item.attempt_count}</span>
                  <span className="run-card-chip">
                    约定 {item.verification_command_count}
                  </span>
                  <span className="run-card-chip">
                    阶段 {runtimePhaseLabel(runtimeState?.phase)}
                  </span>
                  <span className="run-card-chip run-card-chip-system">治理 {governanceStatus}</span>
                  <span
                    className={`run-card-chip ${
                      item.run_health?.status === "stale_running_attempt"
                        ? "run-card-chip-rose"
                        : item.run_health?.status === "waiting_steer" ||
                            item.run_health?.status === "unknown"
                          ? "run-card-chip-amber"
                          : "run-card-chip-emerald"
                    }`}
                  >
                    健康 {healthStatus}
                  </span>
                  {runningSince ? (
                    <span className="run-card-chip run-card-chip-live">
                      已跑 {formatElapsed(runningSince, nowTs)}
                    </span>
                  ) : null}
                  {item.current?.waiting_for_human ? (
                    <span className="run-card-chip run-card-chip-alert">等待人工</span>
                  ) : null}
                </div>
                <MeasuredText className="run-card-summary" lines={3} text={taskSummary} />
                {item.run_brief?.summary ? (
                  <MeasuredText
                    className="run-card-summary"
                    lines={2}
                    text={truncateText(localizeUiText(item.run_brief.summary), 120)}
                  />
                ) : null}
                {liveProgress ? (
                  <MeasuredText className="run-card-summary" lines={2} text={liveProgress} />
                ) : null}
                {governanceHeadline ? (
                  <MeasuredText
                    className="run-card-summary run-card-summary-terminal"
                    lines={2}
                    text={governanceHeadline}
                  />
                ) : null}
                <MeasuredText
                  className="run-card-summary"
                  lines={2}
                  text={truncateText(priority.reason, 180)}
                />
                <MeasuredText
                  className="run-card-summary"
                  lines={2}
                  text={truncateText(operatorState.recovery_hint, 180)}
                />
                <div className="goal-card-meta">
                  {workspaceLabel} · 最近变化 {formatRelativeTime(latestRunSignalAt, nowTs)}
                  {item.latest_attempt?.started_at
                    ? ` · 开始 ${formatDateTime(item.latest_attempt.started_at)}`
                    : ""}
                </div>
              </button>
            );
          })
        )}
      </div>
    </Panel>
  );
}
