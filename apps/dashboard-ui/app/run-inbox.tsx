import {
  localizeUiText,
  nextActionLabel,
  statusLabel,
  workerLabel
} from "./copy";
import {
  readFailureSurface,
  readHandoffSummary,
  readMaintenancePlane,
  readPolicyRuntime,
  readPreflightSummary,
  readRunBrief,
  readWorkingContextSignal,
  readWorkingContext
} from "./dashboard-read-model";
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
  { lens: "waiting_human", label: "需要你处理" },
  { lens: "replay_gap", label: "验证记录不完整" },
  { lens: "runtime_fault", label: "运行出错" },
  { lens: "unstarted", label: "还没开始" }
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
    label: "需要你处理",
    description: "已经明确要你拍板，或已经出现卡点的 run。",
    filter: "needs_action",
    lens: "waiting_human"
  },
  {
    key: "runtime-risk",
    label: "运行出错",
    description: "当前更像会卡死、报错或信号异常的问题。",
    filter: "needs_action",
    lens: "runtime_fault"
  },
  {
    key: "replay-gap",
    label: "验证记录不完整",
    description: "已经开始执行，但验证记录还不完整的 run。",
    filter: "all",
    lens: "replay_gap"
  },
  {
    key: "cold-start",
    label: "还没开始",
    description: "还没真正开始的 run，适合补首次尝试或 steer。",
    filter: "watch",
    lens: "unstarted"
  }
];

function runHealthLabel(status: string | null | undefined): string {
  return status ? statusLabel(status) : "未知";
}

function workingContextStateLabel(hasRef: boolean, isDegraded: boolean): string {
  if (isDegraded) {
    return "降级";
  }

  return hasRef ? "已落盘" : "未落盘";
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
      eyebrow: "快捷筛选",
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
    descriptionParts.push("当前优先看明确需要你处理或风险偏高的运行。");
  } else if (activeFilter === "active") {
    descriptionParts.push("当前只看仍在持续推进的运行。");
  } else {
    descriptionParts.push("当前只看没有进行中尝试、但仍值得保留的运行。");
  }

  if (focusLens === "waiting_human") {
    descriptionParts.push("列表进一步收窄到已经明确需要你处理或已有卡点的 run。");
  } else if (focusLens === "replay_gap") {
    descriptionParts.push("列表进一步强调已经执行、但验证记录还不完整的 run。");
  } else if (focusLens === "runtime_fault") {
    descriptionParts.push("列表进一步强调运行报错或心跳陈旧的 run。");
  } else if (focusLens === "unstarted") {
    descriptionParts.push("列表进一步强调还没跑出第一次尝试的 run。");
  }

  return {
    eyebrow: "当前视图",
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
    return `当前“${activePreset.label}”下没有运行任务，可以切到其他筛选继续巡检。`;
  }

  if (focusLens === "waiting_human") {
    return "当前没有明确需要你处理或已经出现卡点的运行。";
  }

  if (focusLens === "replay_gap") {
    return "当前没有命中“验证记录不完整”的运行。";
  }

  if (focusLens === "runtime_fault") {
    return "当前没有运行报错或心跳陈旧的运行。";
  }

  if (focusLens === "unstarted") {
    return "当前没有还没开始的运行。";
  }

  if (activeFilter === "needs_action") {
    return "当前没有需要你处理或优先排查的运行。";
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
      title={`优先处理队列 · ${queuedRuns.length}`}
      subtitle="先处理明确卡住、需要你处理或实时信号异常的运行。"
    >
      <div className="intervention-queue">
        {queuedRuns.length === 0 ? (
          <EmptyState text="当前没有需要立刻处理的运行。" />
        ) : (
          queuedRuns.map(({ run, state }) => {
            const selected = run.run.id === selectedRunId;
            const signalBadges = deriveRunSignalBadges(run, nowTs).slice(0, 3);
            const runBrief = readRunBrief(run);
            const handoffSummary = readHandoffSummary(run);
            const preflightSummary = readPreflightSummary(run);
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
                  text={truncateText(
                    localizeUiText(
                      handoffSummary.summary ??
                        preflightSummary.summary ??
                        runBrief.headline ??
                        state.reason
                    ),
                    180
                  )}
                />
                <MeasuredText
                  className="queue-card-summary"
                  lines={2}
                  text={truncateText(
                    localizeUiText(
                      preflightSummary.failure_reason ??
                        preflightSummary.summary ??
                        runBrief.summary ??
                        state.recovery_hint
                    ),
                    180
                  )}
                />
                <div className="queue-card-meta">
                  {handoffSummary.recommended_next_action
                    ? `交接建议 ${nextActionLabel(handoffSummary.recommended_next_action)}`
                    : preflightSummary.status
                      ? `发车前 ${statusLabel(preflightSummary.status)}`
                      : runBrief.recommended_next_action
                        ? `下一动作 ${nextActionLabel(runBrief.recommended_next_action)}`
                        : "先看详情"}
                  {runBrief.updated_at
                    ? ` · 最近判断 ${formatRelativeTime(runBrief.updated_at, nowTs)}`
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
      subtitle="先按运行状态分组，再按你最关心的问题缩小真正要优先看的 run。"
    >
      <div className="preset-grid" aria-label="快捷筛选">
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
                label={`聚焦 · ${
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

      <div className="filter-row filter-row-secondary" aria-label="优先视角">
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
            const runBrief = readRunBrief(item);
            const policyRuntime = readPolicyRuntime(item);
            const workingContext = readWorkingContext(item);
            const workingContextSignal = readWorkingContextSignal(item);
            const maintenancePlane = readMaintenancePlane(item);
            const failureSurface = readFailureSurface(item);
            const handoffSummary = readHandoffSummary(item);
            const preflightSummary = readPreflightSummary(item);
            const operatorState = deriveRunOperatorState(item, nowTs);
            const priority = deriveRunPriorityInfo(item, focusLens, nowTs);
            const signalBadges = deriveRunSignalBadges(item, nowTs).slice(0, 4);
            const inboxReasons = deriveRunInboxReasons(item, activeFilter, focusLens, nowTs);
            const taskFocus = truncateText(
              localizeUiText(
                handoffSummary.summary ??
                  preflightSummary.summary ??
                  workingContext.current_focus ??
                  item.task_focus ??
                  item.run.description
              ),
              120
            );
            const taskSummary = truncateText(
              localizeUiText(
                preflightSummary.failure_reason ??
                  preflightSummary.summary ??
                  handoffSummary.summary ??
                  failureSurface?.summary ??
                  runBrief.summary ??
                  item.latest_adversarial_verification?.failure_reason ??
                  item.latest_runtime_verification?.failure_reason ??
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
              runBrief.updated_at ??
              maintenancePlane.heartbeat_at ??
              workingContext.last_event_at ??
              item.latest_attempt?.ended_at ??
              item.latest_attempt?.started_at ??
              item.run.created_at;
            const runningSince =
              policyRuntime.status === "running" && item.latest_attempt?.started_at
                ? item.latest_attempt.started_at
                : null;
            const liveProgress = truncateText(
              localizeUiText(
                workingContext.progress_text ??
                  item.latest_attempt_runtime_state?.recent_activities.at(-1) ??
                  ""
              ),
              110
            );
            const governanceStatus = item.governance ? statusLabel(item.governance.status) : "未建";
            const healthStatus = runHealthLabel(maintenancePlane.status);

            return (
              <button
                key={item.run.id}
                type="button"
                className={`goal-card run-card${selected ? " is-selected" : ""}`}
                onClick={() => onSelectRun(item.run.id)}
              >
                <div className="goal-card-head">
                  <strong>{localizeUiText(item.run.title)}</strong>
                  <StatusPill value={policyRuntime.status} />
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
                {handoffSummary.summary || preflightSummary.status ? (
                  <div className="triage-hit-row">
                    {handoffSummary.summary ? (
                      <span className="triage-hit">
                        {`交接 · ${truncateText(localizeUiText(handoffSummary.summary), 72)}`}
                      </span>
                    ) : null}
                    {preflightSummary.status ? (
                      <span className="triage-hit">
                        {`发车前 · ${statusLabel(preflightSummary.status)}`}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {workingContextSignal.artifact_ref || workingContextSignal.is_degraded ? (
                  <div className="triage-hit-row">
                    <span className="triage-hit">
                      {`现场记录 · ${workingContextStateLabel(
                        Boolean(workingContextSignal.artifact_ref),
                        workingContextSignal.is_degraded
                      )}`}
                    </span>
                    {workingContextSignal.current_snapshot_ref ? (
                      <span className="triage-hit">
                        {`快照 · ${truncateText(
                          workingContextSignal.current_snapshot_ref,
                          56
                        )}`}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <div className="run-card-chips">
                  <span className="run-card-chip">尝试 {item.attempt_count}</span>
                  <span className="run-card-chip">
                    约定 {item.verification_command_count}
                  </span>
                  <span className="run-card-chip">
                    阶段 {runtimePhaseLabel(workingContext.active_phase)}
                  </span>
                  <span className="run-card-chip run-card-chip-system">治理 {governanceStatus}</span>
                  <span
                    className={`run-card-chip ${
                      maintenancePlane.status === "stale_running_attempt"
                        ? "run-card-chip-rose"
                        : maintenancePlane.status === "waiting_steer" ||
                            maintenancePlane.status === "unknown"
                          ? "run-card-chip-amber"
                          : "run-card-chip-emerald"
                    }`}
                  >
                    健康 {healthStatus}
                  </span>
                  <span
                    className={`run-card-chip ${
                      workingContextSignal.is_degraded
                        ? "run-card-chip-rose"
                        : workingContextSignal.artifact_ref
                          ? "run-card-chip-emerald"
                          : "run-card-chip-amber"
                    }`}
                  >
                    {`现场 ${workingContextStateLabel(
                      Boolean(workingContextSignal.artifact_ref),
                      workingContextSignal.is_degraded
                    )}`}
                  </span>
                  {runningSince ? (
                    <span className="run-card-chip run-card-chip-live">
                      已跑 {formatElapsed(runningSince, nowTs)}
                    </span>
                  ) : null}
                  {runBrief.waiting_for_human ? (
                    <span className="run-card-chip run-card-chip-alert">需要处理</span>
                  ) : null}
                </div>
                <MeasuredText className="run-card-summary" lines={3} text={taskSummary} />
                {handoffSummary.summary ? (
                  <MeasuredText
                    className="run-card-summary"
                    lines={2}
                    text={truncateText(localizeUiText(handoffSummary.summary), 120)}
                  />
                ) : null}
                {preflightSummary.summary &&
                preflightSummary.summary !== handoffSummary.summary ? (
                  <MeasuredText
                    className="run-card-summary"
                    lines={2}
                    text={truncateText(localizeUiText(preflightSummary.summary), 120)}
                  />
                ) : null}
                {runBrief.summary &&
                runBrief.summary !== handoffSummary.summary &&
                runBrief.summary !== preflightSummary.summary ? (
                  <MeasuredText
                    className="run-card-summary"
                    lines={2}
                    text={truncateText(localizeUiText(runBrief.summary), 120)}
                  />
                ) : null}
                {liveProgress ? (
                  <MeasuredText className="run-card-summary" lines={2} text={liveProgress} />
                ) : null}
                {workingContextSignal.degraded_summary ? (
                  <MeasuredText
                    className="run-card-summary"
                    lines={2}
                    text={truncateText(
                      localizeUiText(workingContextSignal.degraded_summary),
                      120
                    )}
                  />
                ) : null}
                {workingContextSignal.artifact_ref ? (
                  <MeasuredText
                    className="run-card-summary run-card-summary-terminal"
                    lines={2}
                    text={truncateText(
                      `现场记录快照：${workingContextSignal.artifact_ref}`,
                      120
                    )}
                  />
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
                  text={truncateText(
                    handoffSummary.recommended_next_action
                      ? `交接建议：${nextActionLabel(handoffSummary.recommended_next_action)}`
                      : preflightSummary.status
                        ? `发车前状态：${statusLabel(preflightSummary.status)}`
                        : priority.reason,
                    180
                  )}
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
