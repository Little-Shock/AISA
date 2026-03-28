"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import {
  activityLabel,
  attemptTypeLabel,
  localizeUiText,
  nextActionLabel,
  statusLabel,
  workerLabel
} from "./copy";

type GoalSummaryItem = {
  goal: {
    id: string;
    title: string;
    status: string;
    workspace_root: string;
  };
  branch_count: number;
  running_count: number;
  kept_count: number;
};

type GoalDetail = {
  goal: {
    id: string;
    title: string;
    description: string;
    status: string;
    workspace_root: string;
    success_criteria: string[];
    constraints: string[];
  };
  branches: Array<{
    branch: {
      id: string;
      hypothesis: string;
      objective: string;
      status: string;
      assigned_worker: string;
      score: number | null;
      confidence: number | null;
    };
    writeback: {
      summary: string;
      recommended_next_steps: string[];
    } | null;
  }>;
  steers: Array<{
    id: string;
    content: string;
    status: string;
    scope: string;
  }>;
  context: {
    shared_facts: string[];
    open_questions: string[];
    constraints: string[];
    branch_notes: Record<string, string>;
  };
  report: string;
  events: Array<{
    event_id: string;
    type: string;
    ts: string;
  }>;
};

type AttemptRuntimeState = {
  running: boolean;
  phase: string | null;
  active_since: string | null;
  last_event_at: string | null;
  progress_text: string | null;
  recent_activities: string[];
  completed_steps: string[];
  process_content: string[];
  final_output: string | null;
  error: string | null;
  session_id: string | null;
  event_count: number;
  updated_at: string;
};

type AttemptRuntimeEvent = {
  id: string;
  ts: string;
  type: string;
  summary: string;
  seq: number;
};

type AttemptHeartbeat = {
  status: string;
  started_at: string;
  heartbeat_at: string;
  released_at: string | null;
};

type RunSummaryItem = {
  run: {
    id: string;
    title: string;
    description: string;
    workspace_root: string;
    created_at: string;
  };
  current: {
    run_status: string;
    latest_attempt_id: string | null;
    recommended_next_action: string | null;
    recommended_attempt_type: string | null;
    summary: string;
    blocking_reason: string | null;
    waiting_for_human: boolean;
    updated_at: string;
  } | null;
  attempt_count: number;
  latest_attempt: {
    id: string;
    attempt_type: string;
    status: string;
    worker: string;
    objective: string;
    created_at: string;
    started_at: string | null;
    ended_at: string | null;
  } | null;
  latest_attempt_runtime_state: AttemptRuntimeState | null;
  latest_attempt_heartbeat: AttemptHeartbeat | null;
  task_focus: string;
  verification_command_count: number;
};

type RunDetail = {
  run: {
    id: string;
    title: string;
    description: string;
    workspace_root: string;
    owner_id: string;
    success_criteria: string[];
    constraints: string[];
    created_at: string;
    updated_at: string;
  };
  current: {
    run_status: string;
    best_attempt_id: string | null;
    latest_attempt_id: string | null;
    recommended_next_action: string | null;
    recommended_attempt_type: string | null;
    summary: string;
    blocking_reason: string | null;
    waiting_for_human: boolean;
    updated_at: string;
  } | null;
  attempts: Array<{
    id: string;
    attempt_type: string;
    status: string;
    worker: string;
    objective: string;
    success_criteria: string[];
    workspace_root: string;
    created_at: string;
    started_at: string | null;
    ended_at: string | null;
  }>;
  attempt_details: Array<{
    attempt: {
      id: string;
      attempt_type: string;
      status: string;
      worker: string;
      objective: string;
      success_criteria: string[];
      workspace_root: string;
      created_at: string;
      started_at: string | null;
      ended_at: string | null;
    };
    contract: {
      objective: string;
      success_criteria: string[];
      required_evidence: string[];
      forbidden_shortcuts: string[];
      expected_artifacts: string[];
      verification_plan?: {
        commands: Array<{
          purpose: string;
          command: string;
          expected_exit_code?: number;
        }>;
      };
    } | null;
    result: {
      summary: string;
      findings: Array<{
        type: string;
        content: string;
        evidence: string[];
      }>;
      recommended_next_steps: string[];
      confidence: number;
    } | null;
    evaluation: {
      verification_status: string;
      recommendation: string;
      suggested_attempt_type: string | null;
      rationale: string;
      missing_evidence: string[];
      goal_progress: number;
      evidence_quality: number;
    } | null;
    runtime_verification: {
      status: string;
      failure_code: string | null;
      failure_reason: string | null;
      changed_files: string[];
      command_results: Array<{
        purpose: string;
        command: string;
        passed: boolean;
        exit_code: number;
        expected_exit_code: number;
      }>;
    } | null;
    runtime_state: AttemptRuntimeState | null;
    runtime_events: AttemptRuntimeEvent[];
    heartbeat: AttemptHeartbeat | null;
    stdout_excerpt: string;
    stderr_excerpt: string;
    journal: Array<{
      type: string;
      ts: string;
    }>;
  }>;
  steers: Array<{
    id: string;
    content: string;
    status: string;
    attempt_id: string | null;
    created_at: string;
  }>;
  journal: Array<{
    id: string;
    type: string;
    ts: string;
    attempt_id: string | null;
  }>;
  report: string;
};

type ViewMode = "runs" | "goals";

const apiBaseUrl = "/api/control";
const controlApiDisplay = "same-origin /api/control";
const autoRefreshIntervalMs = 4_000;
const staleDataThresholdMs = 12_000;
const defaultWorkspace =
  process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE_ROOT ??
  "E:\\00.Lark_Projects\\36_team_research";

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: string };
    if (payload.message) {
      return payload.message;
    }
  } catch {}

  return fallback;
}

function formatLoadError(fallback: string, cause: unknown): string {
  return cause instanceof Error ? cause.message : fallback;
}

export default function Page() {
  const [viewMode, setViewMode] = useState<ViewMode>("runs");
  const [goals, setGoals] = useState<GoalSummaryItem[]>([]);
  const [runs, setRuns] = useState<RunSummaryItem[]>([]);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GoalDetail | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshState, setRefreshState] = useState({
    isRefreshing: false,
    lastSuccessAt: null as number | null,
    lastErrorAt: null as number | null,
    lastErrorMessage: null as string | null
  });
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [goalForm, setGoalForm] = useState({
    title: "把当前仓库收敛成下一步实施计划",
    description:
      "让多个 Codex CLI 分支围绕同一目标并行分析仓库、共享上下文，并产出当前最优报告。",
    success_criteria:
      "明确推荐路径\n指出关键风险\n给出下一步实施动作",
    constraints:
      "只读分析\n文件系统优先\n不要脱离当前 PRD\n不要给出无证据结论",
    owner_id: "owner_001",
    workspace_root: defaultWorkspace
  });
  const [steerText, setSteerText] = useState("");
  const refreshInFlightRef = useRef(false);

  useEffect(() => {
    void refreshDashboard();
  }, []);

  useEffect(() => {
    const clock = window.setInterval(() => {
      setNowTs(Date.now());
    }, 1000);

    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshDashboard();
    }, autoRefreshIntervalMs);

    return () => window.clearInterval(timer);
  }, [selectedGoalId, selectedRunId]);

  const selectedGoal = useMemo(
    () => goals.find((item) => item.goal.id === selectedGoalId) ?? null,
    [goals, selectedGoalId]
  );
  const selectedRun = useMemo(
    () => runs.find((item) => item.run.id === selectedRunId) ?? null,
    [runs, selectedRunId]
  );
  const selectedRunAttemptDetail = useMemo(() => {
    if (!runDetail) {
      return null;
    }

    return (
      runDetail.attempt_details.find(
        (item) => item.attempt.id === runDetail.current?.latest_attempt_id
      ) ??
      runDetail.attempt_details.at(-1) ??
      null
    );
  }, [runDetail]);
  const selectedRunRuntimeState = selectedRunAttemptDetail?.runtime_state ?? null;
  const selectedRunHeartbeat = selectedRunAttemptDetail?.heartbeat ?? null;

  const overviewStats = useMemo(() => {
    const runningGoals = goals.filter((item) => item.goal.status === "running").length;
    const runningRuns = runs.filter(
      (item) => item.current?.run_status === "running"
    ).length;
    const runAttempts = runs.reduce((sum, item) => sum + item.attempt_count, 0);
    const waitingRuns = runs.filter((item) => item.current?.waiting_for_human).length;

    return [
      { label: "运行任务数", value: String(runs.length).padStart(2, "0") },
      { label: "运行中任务", value: String(runningRuns).padStart(2, "0") },
      { label: "尝试数", value: String(runAttempts).padStart(2, "0") },
      { label: "等待人工", value: String(waitingRuns).padStart(2, "0") },
      { label: "目标数", value: String(goals.length).padStart(2, "0") },
      { label: "运行中目标", value: String(runningGoals).padStart(2, "0") }
    ];
  }, [goals, runs]);

  const latestSyncAgeMs =
    refreshState.lastSuccessAt !== null ? Math.max(nowTs - refreshState.lastSuccessAt, 0) : null;
  const dataState =
    refreshState.lastErrorAt !== null &&
    (refreshState.lastSuccessAt === null ||
      refreshState.lastErrorAt >= refreshState.lastSuccessAt)
      ? "offline"
      : latestSyncAgeMs !== null && latestSyncAgeMs > staleDataThresholdMs
        ? "stale"
        : "live";
  const selectedRunCurrentUpdatedAt =
    runDetail?.current?.updated_at ??
    selectedRun?.current?.updated_at ??
    selectedRun?.latest_attempt?.ended_at ??
    selectedRun?.latest_attempt?.started_at ??
    selectedRun?.run.created_at ??
    null;
  const currentAttemptStartedAt =
    selectedRunAttemptDetail?.attempt.status === "running"
      ? selectedRunAttemptDetail.attempt.started_at
      : selectedRun?.latest_attempt?.status === "running"
        ? selectedRun.latest_attempt.started_at
        : null;
  const liveStatusText =
    dataState === "offline"
      ? "数据已失联"
      : refreshState.isRefreshing
        ? "正在自动刷新"
        : dataState === "stale"
          ? "数据偏陈旧"
          : "自动刷新正常";
  const liveStatusDetail =
    dataState === "offline"
      ? refreshState.lastErrorAt
        ? `失联 ${formatElapsed(refreshState.lastErrorAt, nowTs)}`
        : "控制 API 当前不可用"
      : refreshState.lastSuccessAt
        ? `上次同步 ${formatClockTime(refreshState.lastSuccessAt)}`
        : "正在建立首轮同步";
  const liveAttemptText = currentAttemptStartedAt
    ? `当前尝试已运行 ${formatElapsed(currentAttemptStartedAt, nowTs)}`
    : "当前没有进行中的尝试";

  async function fetchControlJson<T>(path: string, fallback: string): Promise<T> {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      cache: "no-store"
    });
    if (!response.ok) {
      throw new Error(await readErrorMessage(response, fallback));
    }

    return (await response.json()) as T;
  }

  async function selectGoal(goalId: string) {
    setSelectedGoalId(goalId);

    try {
      const payload = await fetchControlJson<GoalDetail>(
        `/goals/${goalId}`,
        "加载目标详情失败"
      );
      setDetail(payload);
      setError(null);
    } catch (cause) {
      setError(formatLoadError("加载目标详情失败", cause));
    }
  }

  async function selectRun(runId: string) {
    setSelectedRunId(runId);

    try {
      const payload = await fetchControlJson<RunDetail>(
        `/runs/${runId}`,
        "加载运行详情失败"
      );
      setRunDetail(payload);
      syncRunSummaryFromDetail(payload);
      setError(null);
    } catch (cause) {
      setError(formatLoadError("加载运行详情失败", cause));
    }
  }

  function syncRunSummaryFromDetail(nextDetail: RunDetail) {
    const latestDetail =
      nextDetail.attempt_details.find(
        (detailItem) => detailItem.attempt.id === nextDetail.current?.latest_attempt_id
      ) ??
      nextDetail.attempt_details.at(-1) ??
      null;

    setRuns((currentRuns) =>
      currentRuns.map((item) =>
        item.run.id === nextDetail.run.id
          ? {
              ...item,
              current: nextDetail.current
                ? {
                    run_status: nextDetail.current.run_status,
                    latest_attempt_id: nextDetail.current.latest_attempt_id,
                    recommended_next_action: nextDetail.current.recommended_next_action,
                    recommended_attempt_type: nextDetail.current.recommended_attempt_type,
                    summary: nextDetail.current.summary,
                    blocking_reason: nextDetail.current.blocking_reason,
                    waiting_for_human: nextDetail.current.waiting_for_human,
                    updated_at: nextDetail.current.updated_at
                  }
                : null,
              attempt_count: nextDetail.attempts.length,
              latest_attempt: latestDetail?.attempt ?? null,
              latest_attempt_runtime_state: latestDetail?.runtime_state ?? null,
              latest_attempt_heartbeat: latestDetail?.heartbeat ?? null,
              task_focus:
                latestDetail?.contract?.objective ??
                latestDetail?.attempt.objective ??
                item.task_focus,
              verification_command_count:
                latestDetail?.contract?.verification_plan?.commands.length ??
                item.verification_command_count
            }
          : item
      )
    );
  }

  async function refreshDashboard(options?: {
    goalId?: string | null;
    runId?: string | null;
  }) {
    if (refreshInFlightRef.current) {
      return;
    }

    refreshInFlightRef.current = true;
    setRefreshState((current) => ({
      ...current,
      isRefreshing: true
    }));

    try {
      const [goalPayload, runPayload] = await Promise.all([
        fetchControlJson<{ goals: GoalSummaryItem[] }>("/goals", "加载目标失败"),
        fetchControlJson<{ runs: RunSummaryItem[] }>("/runs", "加载运行任务失败")
      ]);

      const nextGoalId = pickSelectedId(
        goalPayload.goals,
        options?.goalId ?? selectedGoalId,
        (item) => item.goal.id
      );
      const nextRunId = pickSelectedId(
        runPayload.runs,
        options?.runId ?? selectedRunId,
        (item) => item.run.id
      );

      startTransition(() => {
        setGoals(goalPayload.goals);
        setRuns(runPayload.runs);
        setSelectedGoalId(nextGoalId);
        setSelectedRunId(nextRunId);
      });

      const [goalDetailPayload, runDetailPayload] = await Promise.all([
        nextGoalId
          ? fetchControlJson<GoalDetail>(`/goals/${nextGoalId}`, "加载目标详情失败")
          : Promise.resolve(null),
        nextRunId
          ? fetchControlJson<RunDetail>(`/runs/${nextRunId}`, "加载运行详情失败")
          : Promise.resolve(null)
      ]);

      startTransition(() => {
        setDetail(goalDetailPayload);
        setRunDetail(runDetailPayload);
      });

      setError(null);
      setRefreshState({
        isRefreshing: false,
        lastSuccessAt: Date.now(),
        lastErrorAt: null,
        lastErrorMessage: null
      });
    } catch (cause) {
      const message = formatLoadError("加载运行台失败", cause);
      setError(message);
      setRefreshState((current) => ({
        ...current,
        isRefreshing: false,
        lastErrorAt: Date.now(),
        lastErrorMessage: message
      }));
    } finally {
      refreshInFlightRef.current = false;
    }
  }

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }

    const eventSource = new EventSource(`${apiBaseUrl}/runs/${selectedRunId}/stream`);

    const handleSnapshot = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as RunDetail;
        startTransition(() => {
          setRunDetail(payload);
          syncRunSummaryFromDetail(payload);
        });
        setError(null);
        setRefreshState((current) => ({
          ...current,
          isRefreshing: false,
          lastSuccessAt: Date.now(),
          lastErrorAt: null,
          lastErrorMessage: null
        }));
      } catch (cause) {
        const message = formatLoadError("解析运行实时流失败", cause);
        setRefreshState((current) => ({
          ...current,
          lastErrorAt: Date.now(),
          lastErrorMessage: message
        }));
      }
    };

    const handleError = () => {
      setRefreshState((current) => ({
        ...current,
        lastErrorAt: Date.now(),
        lastErrorMessage: "运行实时流暂时断开，正在等待自动重连。"
      }));
    };

    eventSource.addEventListener("snapshot", handleSnapshot as EventListener);
    eventSource.onerror = handleError;

    return () => {
      eventSource.removeEventListener("snapshot", handleSnapshot as EventListener);
      eventSource.close();
    };
  }, [selectedRunId]);

  async function createGoal() {
    setBusy("create");
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: goalForm.title,
          description: goalForm.description,
          success_criteria: splitLines(goalForm.success_criteria),
          constraints: splitLines(goalForm.constraints),
          owner_id: goalForm.owner_id,
          workspace_root: goalForm.workspace_root
        })
      });

      if (!response.ok) {
        throw new Error("创建目标失败");
      }

      const payload = (await response.json()) as { goal: { id: string } };
      await refreshDashboard({
        goalId: payload.goal.id,
        runId: selectedRunId
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function launchGoal(goalId: string) {
    setBusy(`launch:${goalId}`);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/goals/${goalId}/launch`, {
        method: "POST"
      });

      if (!response.ok) {
        throw new Error("启动目标失败");
      }

      await refreshDashboard({
        goalId,
        runId: selectedRunId
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function rerunBranch(goalId: string, branchId: string) {
    setBusy(`rerun:${branchId}`);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/goals/${goalId}/branches/${branchId}/rerun`, {
        method: "POST"
      });

      if (!response.ok) {
        throw new Error("重跑分支失败");
      }

      await refreshDashboard({
        goalId,
        runId: selectedRunId
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function queueSteer(goalId: string) {
    if (!steerText.trim()) {
      return;
    }

    setBusy(`steer:${goalId}`);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/goals/${goalId}/steers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "goal",
          content: steerText.trim()
        })
      });

      if (!response.ok) {
        throw new Error("提交 steer 失败");
      }

      setSteerText("");
      await refreshDashboard({
        goalId,
        runId: selectedRunId
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="dashboard-shell">
      <div className="dashboard-frame">
        <section className="hero-panel">
          <div className="hero-copy">
            <div className="hero-eyebrow">AISA / 运行台</div>
            <h1 className="hero-title">
              运行台与研究台
              <span>先看运行任务的真实状态，再回头看旧的目标和分支面板。</span>
            </h1>
            <p className="hero-description">
              这里把运行任务的真实事实拉到前台。能直接看到当前判断、尝试约定、写回结果、
              回放验证、人工指令和日志尾部，方便盯住自举任务的真实状态。
            </p>
          </div>

          <div className="hero-meta">
            <div className="meta-card">
              <span className="meta-label">控制 API</span>
              <strong>{controlApiDisplay}</strong>
            </div>
            <div className="meta-card">
              <span className="meta-label">默认工作区</span>
              <strong>{defaultWorkspace}</strong>
            </div>
          </div>

          <div className="stats-row">
            {overviewStats.map((stat) => (
              <article key={stat.label} className="stat-card">
                <span className="stat-label">{stat.label}</span>
                <strong className="stat-value">{stat.value}</strong>
              </article>
            ))}
          </div>

          <div className="mode-switch" aria-label="控制台模式">
            <button
              type="button"
              className={`mode-switch-button${viewMode === "runs" ? " is-active" : ""}`}
              onClick={() => setViewMode("runs")}
            >
              运行台
            </button>
            <button
              type="button"
              className={`mode-switch-button${viewMode === "goals" ? " is-active" : ""}`}
              onClick={() => setViewMode("goals")}
            >
              目标台
            </button>
          </div>
        </section>

        {error ? <section className="error-banner">{error}</section> : null}

        <section className={`live-strip live-strip-${dataState}`}>
          <div className="live-strip-status">
            <span
              className={`live-dot${refreshState.isRefreshing ? " is-refreshing" : ""}`}
              aria-hidden="true"
            />
            <div>
              <strong>{liveStatusText}</strong>
              <p>
                {liveStatusDetail}
                {refreshState.lastErrorMessage && dataState === "offline"
                  ? ` · ${refreshState.lastErrorMessage}`
                  : ""}
              </p>
            </div>
          </div>

          <div className="live-strip-metrics">
            <div className="live-strip-metric">
              <span>刷新节奏</span>
              <strong>总览 4 秒 / 详情实时</strong>
            </div>
            <div className="live-strip-metric">
              <span>数据年龄</span>
              <strong>
                {latestSyncAgeMs !== null ? formatDuration(latestSyncAgeMs) : "未同步"}
              </strong>
            </div>
            <div className="live-strip-metric">
              <span>当前运行</span>
              <strong>{liveAttemptText}</strong>
            </div>
          </div>
        </section>

        <div className={`content-grid content-grid-${dataState}`}>
          <aside className="left-rail">
            {viewMode === "runs" ? (
              <Panel
                title={`运行池 · ${runs.length}`}
                subtitle="这里展示所有运行任务，包括当前自举任务。卡片会显示最近同步和尝试活性。"
              >
                <div className="run-list">
                  {runs.length === 0 ? (
                    <EmptyState text="还没有运行任务。先用自举模板或接口新建一条。" />
                  ) : (
                    runs.map((item) => {
                      const selected = item.run.id === selectedRunId;
                      const runtimeState = item.latest_attempt_runtime_state;
                      const taskFocus = truncateText(
                        localizeUiText(item.task_focus || item.run.description),
                        120
                      );
                      const taskSummary = truncateText(
                        localizeUiText(
                          item.current?.blocking_reason ??
                            item.current?.summary ??
                            item.run.description
                        ),
                        110
                      );
                      const workspaceLabel = abbreviateWorkspace(item.run.workspace_root);
                      const latestRunSignalAt =
                        item.current?.updated_at ??
                        item.latest_attempt?.ended_at ??
                        item.latest_attempt?.started_at ??
                        item.run.created_at;
                      const runningSince =
                        item.latest_attempt?.status === "running"
                          ? item.latest_attempt.started_at
                          : null;
                      const liveProgress = truncateText(
                        localizeUiText(
                          runtimeState?.progress_text ??
                            runtimeState?.recent_activities.at(-1) ??
                            ""
                        ),
                        110
                      );
                      return (
                        <button
                          key={item.run.id}
                          type="button"
                          className={`goal-card run-card${selected ? " is-selected" : ""}`}
                          onClick={() => {
                            void selectRun(item.run.id);
                          }}
                        >
                          <div className="goal-card-head">
                            <strong>{localizeUiText(item.run.title)}</strong>
                            <StatusPill value={item.current?.run_status ?? "draft"} />
                          </div>
                          <div className="run-card-topline">
                            <span className="run-card-id">{item.run.id}</span>
                            {item.latest_attempt ? (
                              <span className="run-card-id">
                                {attemptTypeLabel(item.latest_attempt.attempt_type)} ·{" "}
                                {workerLabel(item.latest_attempt.worker)}
                              </span>
                            ) : null}
                          </div>
                          <p className="run-card-focus">{taskFocus}</p>
                          <div className="run-card-chips">
                            <span className="run-card-chip">
                              尝试 {item.attempt_count}
                            </span>
                            <span className="run-card-chip">
                              {nextActionLabel(item.current?.recommended_next_action)}
                            </span>
                            {item.latest_attempt ? (
                              <span className="run-card-chip">
                                {item.latest_attempt.id}
                              </span>
                            ) : null}
                            {runtimeState?.phase ? (
                              <span className="run-card-chip">
                                阶段 {runtimePhaseLabel(runtimeState.phase)}
                              </span>
                            ) : null}
                            {runningSince ? (
                              <span className="run-card-chip run-card-chip-live">
                                已运行 {formatElapsed(runningSince, nowTs)}
                              </span>
                            ) : null}
                            {item.verification_command_count > 0 ? (
                              <span className="run-card-chip">
                                回放 {item.verification_command_count}
                              </span>
                            ) : null}
                            {item.current?.waiting_for_human ? (
                              <span className="run-card-chip run-card-chip-alert">
                                等待人工
                              </span>
                            ) : null}
                          </div>
                          <p className="run-card-summary">{taskSummary}</p>
                          {liveProgress ? (
                            <p className="run-card-summary">{liveProgress}</p>
                          ) : null}
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
            ) : (
              <>
                <Panel
                  title="发起新目标"
                  subtitle="把一个高层问题收束成可并行探索的研究任务。"
                >
                  <div className="form-stack">
                    <Field
                      label="目标标题"
                      value={goalForm.title}
                      onChange={(value) => setGoalForm((current) => ({ ...current, title: value }))}
                    />
                    <TextAreaField
                      label="问题描述"
                      value={goalForm.description}
                      onChange={(value) =>
                        setGoalForm((current) => ({ ...current, description: value }))
                      }
                    />
                    <TextAreaField
                      label="成功标准"
                      value={goalForm.success_criteria}
                      onChange={(value) =>
                        setGoalForm((current) => ({ ...current, success_criteria: value }))
                      }
                    />
                    <TextAreaField
                      label="约束条件"
                      value={goalForm.constraints}
                      onChange={(value) =>
                        setGoalForm((current) => ({ ...current, constraints: value }))
                      }
                    />
                    <Field
                      label="负责人"
                      value={goalForm.owner_id}
                      onChange={(value) =>
                        setGoalForm((current) => ({ ...current, owner_id: value }))
                      }
                    />
                    <Field
                      label="工作区路径"
                      value={goalForm.workspace_root}
                      onChange={(value) =>
                        setGoalForm((current) => ({ ...current, workspace_root: value }))
                      }
                    />
                    <button
                      type="button"
                      className="button button-primary"
                      onClick={() => void createGoal()}
                      disabled={busy === "create"}
                    >
                      {busy === "create" ? "创建中..." : "创建目标"}
                    </button>
                  </div>
                </Panel>

                <Panel
                  title={`目标池 · ${goals.length}`}
                  subtitle="这里展示所有目标的整体推进状态。"
                >
                  <div className="goal-list">
                    {goals.length === 0 ? (
                      <EmptyState text="还没有目标。先在上方创建一个，然后启动第一轮分支。" />
                    ) : (
                      goals.map((item) => {
                        const selected = item.goal.id === selectedGoalId;
                        return (
                          <button
                            key={item.goal.id}
                            type="button"
                            className={`goal-card${selected ? " is-selected" : ""}`}
                            onClick={() => {
                              void selectGoal(item.goal.id);
                            }}
                          >
                            <div className="goal-card-head">
                              <strong>{localizeUiText(item.goal.title)}</strong>
                              <StatusPill value={item.goal.status} />
                            </div>
                            <div className="goal-card-body">{item.goal.workspace_root}</div>
                            <div className="goal-card-meta">
                              分支 {item.branch_count} · 运行中 {item.running_count} · 已保留{" "}
                              {item.kept_count}
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </Panel>
              </>
            )}
          </aside>

          <section className="main-stage">
            {viewMode === "runs" ? (
              runDetail && selectedRun ? (
                <>
                  <Panel
                    title={runDetail.run.title}
                    subtitle="只读运行台。看当前判断、尝试约定、写回、回放验证和日志，不在这里介入。"
                    actions={
                      <div className="action-row">
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={refreshState.isRefreshing}
                          onClick={() => {
                            void refreshDashboard({
                              goalId: selectedGoalId,
                              runId: runDetail.run.id
                            });
                          }}
                        >
                          {refreshState.isRefreshing ? "同步中..." : "刷新"}
                        </button>
                      </div>
                    }
                  >
                    <div className={`run-live-banner run-live-banner-${dataState}`}>
                      <div className="run-live-banner-main">
                        <strong>{liveStatusText}</strong>
                        <p>
                          最近同步 {formatTimeOrFallback(refreshState.lastSuccessAt)}
                          {selectedRunCurrentUpdatedAt
                            ? ` · 当前状态更新于 ${formatDateTime(selectedRunCurrentUpdatedAt)}`
                            : ""}
                        </p>
                      </div>
                      <div className="run-live-banner-side">
                        <span>{liveAttemptText}</span>
                        <span>
                          最近变化{" "}
                          {formatRelativeTime(selectedRunCurrentUpdatedAt, nowTs)}
                        </span>
                      </div>
                    </div>

                    <div className="summary-grid">
                      <InfoCard
                        label="运行状态"
                        value={statusLabel(runDetail.current?.run_status ?? "draft")}
                      />
                      <InfoCard
                        label="下一动作"
                        value={nextActionLabel(runDetail.current?.recommended_next_action)}
                      />
                      <InfoCard
                        label="最新尝试"
                        value={runDetail.current?.latest_attempt_id ?? "暂无"}
                      />
                      <InfoCard
                        label="尝试数量"
                        value={String(runDetail.attempts.length)}
                      />
                      <InfoCard
                        label="状态更新时间"
                        value={formatDateTime(selectedRunCurrentUpdatedAt)}
                      />
                      <InfoCard label="负责人" value={runDetail.run.owner_id} />
                      <InfoCard label="工作区" value={runDetail.run.workspace_root} />
                      <InfoCard
                        label="实时阶段"
                        value={runtimePhaseLabel(selectedRunRuntimeState?.phase)}
                      />
                      <InfoCard
                        label="会话"
                        value={selectedRunRuntimeState?.session_id ?? "暂无"}
                      />
                      <InfoCard
                        label="事件数"
                        value={String(selectedRunRuntimeState?.event_count ?? 0)}
                      />
                      <InfoCard
                        label="心跳"
                        value={
                          selectedRunHeartbeat?.heartbeat_at
                            ? `最近 ${formatRelativeTime(selectedRunHeartbeat.heartbeat_at, nowTs)}`
                            : "暂无"
                        }
                      />
                    </div>

                    <div className="dual-grid">
                      <SubPanel title="当前分配任务" accent="emerald">
                        <p className="body-copy">
                          {localizeUiText(
                            selectedRunAttemptDetail?.contract?.objective ??
                              selectedRunAttemptDetail?.attempt.objective ??
                              runDetail.run.description
                          )}
                        </p>
                        <SectionList
                          title="任务上下文"
                          items={[
                            `最新尝试：${selectedRunAttemptDetail?.attempt.id ?? runDetail.current?.latest_attempt_id ?? "暂无"}`,
                            `尝试类型：${selectedRunAttemptDetail ? attemptTypeLabel(selectedRunAttemptDetail.attempt.attempt_type) : "暂无"}`,
                            `执行器：${selectedRunAttemptDetail ? workerLabel(selectedRunAttemptDetail.attempt.worker) : "暂无"}`,
                            `创建时间：${formatDateTime(selectedRunAttemptDetail?.attempt.created_at)}`,
                            `契约回放命令：${String(selectedRunAttemptDetail?.contract?.verification_plan?.commands.length ?? 0)}`
                          ]}
                        />
                        <SectionList
                          title="当前成功标准"
                          items={
                            selectedRunAttemptDetail?.contract?.success_criteria ??
                            selectedRunAttemptDetail?.attempt.success_criteria ??
                            runDetail.run.success_criteria
                          }
                        />
                        <SectionList
                          title="最近活动"
                          items={selectedRunRuntimeState?.recent_activities ?? []}
                        />
                        <SectionList
                          title="已完成步骤"
                          items={selectedRunRuntimeState?.completed_steps ?? []}
                        />
                        <CodeBlock
                          title="过程内容"
                          value={
                            selectedRunRuntimeState?.process_content.length
                              ? selectedRunRuntimeState.process_content.join("\n")
                              : "还没有过程内容。"
                          }
                        />
                        <SectionList
                          title="运行层约定"
                          items={[
                            localizeUiText(runDetail.run.description),
                            ...runDetail.run.constraints.map((constraint) =>
                              localizeUiText(constraint)
                            )
                          ]}
                        />
                      </SubPanel>

                      <SubPanel title="当前判断" accent="amber">
                        <p className="body-copy">
                          {localizeUiText(runDetail.current?.summary ?? "还没有当前判断。")}
                        </p>
                        <SectionList
                          title="当前状态"
                          items={[
                            `运行状态：${statusLabel(runDetail.current?.run_status ?? "draft")}`,
                            `建议的尝试类型：${runDetail.current?.recommended_attempt_type ? attemptTypeLabel(runDetail.current.recommended_attempt_type) : "暂无"}`,
                            `等待人工：${runDetail.current?.waiting_for_human ? "是" : "否"}`,
                            `最新尝试：${runDetail.current?.latest_attempt_id ?? "暂无"}`,
                            `实时阶段：${runtimePhaseLabel(selectedRunRuntimeState?.phase)}`,
                            `最近事件：${selectedRunRuntimeState?.last_event_at ? formatRelativeTime(selectedRunRuntimeState.last_event_at, nowTs) : "暂无"}`,
                            `事件总数：${String(selectedRunRuntimeState?.event_count ?? 0)}`
                          ]}
                        />
                        <SectionList
                          title="排队中 / 已应用的人工指令"
                          items={runDetail.steers.map((steer) => {
                            const attemptPart = steer.attempt_id ? ` · ${steer.attempt_id}` : "";
                            return `[${statusLabel(steer.status)}]${attemptPart} ${steer.content}`;
                          })}
                        />
                        {runDetail.current?.blocking_reason ? (
                          <Callout tone="rose" title="当前卡点">
                            {localizeUiText(runDetail.current.blocking_reason)}
                          </Callout>
                        ) : null}
                        <CodeBlock
                          title="最终输出"
                          value={selectedRunRuntimeState?.final_output || "还没有最终输出。"}
                        />
                        {selectedRunRuntimeState?.error ? (
                          <Callout tone="rose" title="当前错误">
                            {localizeUiText(selectedRunRuntimeState.error)}
                          </Callout>
                        ) : null}
                      </SubPanel>
                    </div>
                  </Panel>

                  <Panel
                    title="尝试时间线"
                    subtitle="每条尝试都展示约定、结果、判断、回放验证和日志尾部。"
                  >
                    <div className="attempt-list">
                      {runDetail.attempt_details.length === 0 ? (
                        <EmptyState text="还没有尝试细节。" />
                      ) : (
                        [...runDetail.attempt_details].reverse().map((detailItem) => (
                          <AttemptCard key={detailItem.attempt.id} detail={detailItem} />
                        ))
                      )}
                    </div>
                  </Panel>

                  <div className="dual-grid">
                    <Panel
                      title="运行报告"
                      subtitle="如果循环已经生成运行级报告，这里会直接显示。"
                    >
                      <pre className="report-block">
                        {localizeUiText(runDetail.report || "还没有运行报告。")}
                      </pre>
                    </Panel>

                    <Panel
                      title="运行日志"
                      subtitle="这里只看以运行任务为中心的事实时间线。"
                    >
                      <div className="event-list">
                        {[...runDetail.journal].reverse().slice(0, 24).map((entry) => (
                          <article key={entry.id} className="event-row">
                            <strong>{activityLabel(entry.type)}</strong>
                            <span>
                              {formatDateTime(entry.ts)}
                              {entry.attempt_id ? ` · ${entry.attempt_id}` : ""}
                            </span>
                          </article>
                        ))}
                      </div>
                    </Panel>
                  </div>
                </>
              ) : (
                <Panel
                  title="还没有选中运行任务"
                  subtitle="先从左侧运行池里选一条运行任务。"
                >
                  <EmptyState text="这块区域会展示运行约定、当前判断、尝试证据、运行日志和最终报告。" />
                </Panel>
              )
            ) : detail && selectedGoal ? (
              <>
                <Panel
                  title={detail.goal.title}
                  subtitle="目标简报、状态总览、人工 steer 都集中在这一屏。"
                  actions={
                    <div className="action-row">
                      <button
                        type="button"
                        className="button button-primary"
                        onClick={() => void launchGoal(detail.goal.id)}
                        disabled={busy === `launch:${detail.goal.id}`}
                      >
                        {busy === `launch:${detail.goal.id}` ? "启动中..." : "启动编排"}
                      </button>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={refreshState.isRefreshing}
                        onClick={() => {
                          void refreshDashboard({
                            goalId: detail.goal.id,
                            runId: selectedRunId
                          });
                        }}
                      >
                        {refreshState.isRefreshing ? "同步中..." : "刷新"}
                      </button>
                    </div>
                  }
                >
                  <div className="summary-grid">
                    <InfoCard label="目标状态" value={statusLabel(detail.goal.status)} />
                    <InfoCard label="工作区" value={detail.goal.workspace_root} />
                    <InfoCard label="分支数量" value={String(detail.branches.length)} />
                    <InfoCard label="事件条数" value={String(detail.events.length)} />
                  </div>

                  <div className="dual-grid">
                    <SubPanel title="任务简报" accent="emerald">
                      <p className="body-copy">{detail.goal.description}</p>
                      <SectionList title="成功标准" items={detail.goal.success_criteria} />
                      <SectionList title="约束条件" items={detail.goal.constraints} />
                    </SubPanel>

                    <SubPanel title="人工 Steer" accent="amber">
                      <TextAreaField
                        label="新的 steer 指令"
                        value={steerText}
                        onChange={setSteerText}
                        placeholder="例如：下一轮优先比较状态模型和事件模型，不要继续讨论 UI。"
                      />
                      <button
                        type="button"
                        className="button button-secondary wide"
                        onClick={() => void queueSteer(detail.goal.id)}
                        disabled={busy === `steer:${detail.goal.id}`}
                      >
                        {busy === `steer:${detail.goal.id}` ? "提交中..." : "加入 Steer 队列"}
                      </button>
                      <SectionList
                        title="队列 / 已应用"
                        items={detail.steers.map(
                          (steer) => `[${statusLabel(steer.status)}] ${steer.content}`
                        )}
                      />
                    </SubPanel>
                  </div>
                </Panel>

                <div className="dual-grid">
                  <Panel
                    title="分支看板"
                    subtitle="每个分支都是一个独立的研究假设与工作线程。"
                  >
                    <div className="branch-list">
                      {detail.branches.map(({ branch, writeback }) => (
                        <article key={branch.id} className="branch-card">
                          <div className="branch-head">
                            <div>
                              <div className="branch-id">{branch.id}</div>
                              <div className="branch-meta">
                                执行器 {workerLabel(branch.assigned_worker)} · 分数{" "}
                                {branch.score !== null ? branch.score.toFixed(2) : "--"}
                              </div>
                            </div>
                            <StatusPill value={branch.status} />
                          </div>
                          <p className="branch-hypothesis">{localizeUiText(branch.hypothesis)}</p>
                          <p className="branch-summary">
                            {localizeUiText(writeback?.summary ?? branch.objective)}
                          </p>
                          <div className="action-row">
                            <button
                              type="button"
                              className="button button-ghost"
                              onClick={() => void rerunBranch(detail.goal.id, branch.id)}
                              disabled={busy === `rerun:${branch.id}`}
                            >
                              {busy === `rerun:${branch.id}` ? "排队中..." : "重跑分支"}
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </Panel>

                  <Panel
                    title="当前最优报告"
                    subtitle="系统会把分支结果压缩成一份持续更新的当前版本。"
                  >
                    <pre className="report-block">
                      {localizeUiText(
                        detail.report || "还没有报告。请先启动目标，让 Codex 分支开始执行。"
                      )}
                    </pre>
                  </Panel>
                </div>

                <div className="dual-grid">
                  <Panel
                    title="共享上下文板"
                    subtitle="把事实、问题、约束从各分支回写到共享面板。"
                  >
                    <SectionList title="共享事实" items={detail.context.shared_facts} />
                    <SectionList title="开放问题" items={detail.context.open_questions} />
                  </Panel>

                  <Panel
                    title="事件时间线"
                    subtitle="所有关键动作都记录为可追踪的运行事实。"
                  >
                    <div className="event-list">
                      {detail.events.slice(-16).reverse().map((event) => (
                        <article key={event.event_id} className="event-row">
                          <strong>{activityLabel(event.type)}</strong>
                          <span>{formatDateTime(event.ts)}</span>
                        </article>
                      ))}
                    </div>
                  </Panel>
                </div>
              </>
            ) : (
              <Panel
                title="还没有选中目标"
                subtitle="先从左侧目标池里选一个，或者直接创建新目标。"
              >
                <EmptyState text="这块区域会展示目标概览、分支看板、共享上下文、实时报告和事件时间线。" />
              </Panel>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function AttemptCard({
  detail
}: {
  detail: RunDetail["attempt_details"][number];
}) {
  const contractCommands =
    detail.contract?.verification_plan?.commands.map((command) => {
      const exitCode =
        typeof command.expected_exit_code === "number"
          ? ` · exit ${command.expected_exit_code}`
          : "";
      return `${command.purpose} · ${command.command}${exitCode}`;
    }) ?? [];
  const replayCommands =
    detail.runtime_verification?.command_results.map((command) => {
      const verdict = command.passed ? "通过" : "失败";
      return `${verdict} · ${command.purpose} · ${command.command} · ${command.exit_code}/${command.expected_exit_code}`;
    }) ?? [];

  return (
    <article className="attempt-card">
      <div className="attempt-card-head">
        <div>
          <div className="attempt-id">{detail.attempt.id}</div>
          <div className="attempt-meta-line">
            {attemptTypeLabel(detail.attempt.attempt_type)} · 执行器{" "}
            {workerLabel(detail.attempt.worker)} · 创建{" "}
            {formatDateTime(detail.attempt.created_at)}
          </div>
        </div>
        <StatusPill value={detail.attempt.status} />
      </div>

      <p className="attempt-objective">{localizeUiText(detail.attempt.objective)}</p>

      <div className="attempt-stats">
        <MiniMetric label="开始" value={formatDateTime(detail.attempt.started_at)} />
        <MiniMetric label="结束" value={formatDateTime(detail.attempt.ended_at)} />
        <MiniMetric
          label="耗时"
          value={formatAttemptElapsed(detail.attempt.started_at, detail.attempt.ended_at)}
        />
        <MiniMetric
          label="阶段"
          value={runtimePhaseLabel(detail.runtime_state?.phase)}
        />
        <MiniMetric
          label="判断"
          value={statusLabel(detail.evaluation?.recommendation ?? "未判断")}
        />
        <MiniMetric
          label="回放"
          value={statusLabel(detail.runtime_verification?.status ?? "未运行")}
        />
      </div>

      <div className="attempt-grid">
        <div className="attempt-section">
          <div className="attempt-section-title">尝试约定</div>
          <SectionList
            title="成功标准"
            items={detail.contract?.success_criteria ?? detail.attempt.success_criteria}
          />
          <SectionList
            title="必留证据"
            items={detail.contract?.required_evidence ?? []}
          />
          <SectionList
            title="禁止取巧"
            items={detail.contract?.forbidden_shortcuts ?? []}
          />
          <SectionList title="期望产物" items={detail.contract?.expected_artifacts ?? []} />
          <SectionList title="契约回放命令" items={contractCommands} />
          <SectionList
            title="最近活动"
            items={detail.runtime_state?.recent_activities ?? []}
          />
          <SectionList
            title="已完成步骤"
            items={detail.runtime_state?.completed_steps ?? []}
          />
        </div>

        <div className="attempt-section">
          <div className="attempt-section-title">结果与判断</div>
          <p className="body-copy">
            {localizeUiText(detail.result?.summary ?? "还没有写回结果。")}
          </p>
          <SectionList
            title="下一步"
            items={detail.result?.recommended_next_steps ?? []}
          />
          <SectionList
            title="判断缺口"
            items={detail.evaluation?.missing_evidence ?? []}
          />
          <SectionList
            title="运行时回放"
            items={replayCommands}
          />
          <SectionList
            title="实时运行态"
            items={[
              `阶段：${runtimePhaseLabel(detail.runtime_state?.phase)}`,
              `会话：${detail.runtime_state?.session_id ?? "暂无"}`,
              `事件总数：${String(detail.runtime_state?.event_count ?? 0)}`,
              `最近事件：${detail.runtime_state?.last_event_at ? formatDateTime(detail.runtime_state.last_event_at) : "暂无"}`,
              `心跳：${detail.heartbeat?.heartbeat_at ? formatDateTime(detail.heartbeat.heartbeat_at) : "暂无"}`
            ]}
          />
          {detail.runtime_verification?.failure_reason ? (
            <Callout tone="rose" title="回放失败原因">
              {localizeUiText(detail.runtime_verification.failure_reason)}
            </Callout>
          ) : null}
          {detail.runtime_state?.error ? (
            <Callout tone="rose" title="运行错误">
              {localizeUiText(detail.runtime_state.error)}
            </Callout>
          ) : null}
          <SectionList
            title="改动文件"
            items={detail.runtime_verification?.changed_files ?? []}
          />
          {detail.evaluation ? (
            <CodeBlock
              title="判断摘要"
              value={[
                `推荐动作：${statusLabel(detail.evaluation.recommendation)}`,
                `建议类型：${detail.evaluation.suggested_attempt_type ? attemptTypeLabel(detail.evaluation.suggested_attempt_type) : "无"}`,
                `目标进度：${detail.evaluation.goal_progress.toFixed(2)}`,
                `证据质量：${detail.evaluation.evidence_quality.toFixed(2)}`,
                `验证状态：${statusLabel(detail.evaluation.verification_status)}`,
                "",
                localizeUiText(detail.evaluation.rationale)
              ].join("\n")}
            />
          ) : null}
        </div>
      </div>

      <div className="attempt-grid">
        <div className="attempt-section">
          <div className="attempt-section-title">日志尾部</div>
          <CodeBlock
            title="错误输出"
            value={detail.stderr_excerpt || "暂无错误输出。"}
          />
        </div>

        <div className="attempt-section">
          <div className="attempt-section-title">辅助输出</div>
          <CodeBlock
            title="过程内容"
            value={
              detail.runtime_state?.process_content.length
                ? detail.runtime_state.process_content.join("\n")
                : "暂无过程内容。"
            }
          />
          <CodeBlock
            title="最终输出"
            value={detail.runtime_state?.final_output || "暂无最终输出。"}
          />
          <CodeBlock
            title="标准输出"
            value={detail.stdout_excerpt || "暂无标准输出。"}
          />
          <SectionList
            title="事件流"
            items={detail.runtime_events.map(
              (event) => `${formatDateTime(event.ts)} · ${event.summary || event.type}`
            )}
          />
          <SectionList
            title="尝试时间线"
            items={detail.journal.map(
              (entry) => `${formatDateTime(entry.ts)} · ${activityLabel(entry.type)}`
            )}
          />
        </div>
      </div>
    </article>
  );
}

function pickSelectedId<T>(
  items: T[],
  currentId: string | null,
  readId: (item: T) => string
): string | null {
  if (currentId && items.some((item) => readId(item) === currentId)) {
    return currentId;
  }

  return items[0] ? readId(items[0]) : null;
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength).trimEnd()}...`;
}

function abbreviateWorkspace(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 4) {
    return value;
  }

  return `.../${segments.slice(-3).join("/")}`;
}

function runtimePhaseLabel(value: string | null | undefined): string {
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
      return value ? localizeUiText(value) : "暂无";
  }
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "未记录";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "未记录";
  }

  return parsed.toLocaleString("zh-CN");
}

function toTimestamp(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const timestamp = typeof value === "number" ? value : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatClockTime(value: number | null): string {
  if (value === null) {
    return "未同步";
  }

  return new Date(value).toLocaleTimeString("zh-CN", {
    hour12: false
  });
}

function formatTimeOrFallback(value: number | null): string {
  return value === null ? "未同步" : formatClockTime(value);
}

function formatDuration(durationMs: number): string {
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

function formatElapsed(
  value: string | number | null | undefined,
  nowTs: number
): string {
  const timestamp = toTimestamp(value);
  if (timestamp === null) {
    return "未开始";
  }

  return formatDuration(nowTs - timestamp);
}

function formatRelativeTime(
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

function formatAttemptElapsed(
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

function Panel({
  title,
  subtitle,
  children,
  actions
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">{localizeUiText(title)}</h2>
          {subtitle ? <p className="panel-subtitle">{localizeUiText(subtitle)}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function SubPanel({
  title,
  accent,
  children
}: {
  title: string;
  accent: "emerald" | "amber";
  children: React.ReactNode;
}) {
  return (
    <div className={`sub-panel sub-panel-${accent}`}>
      <h3 className="sub-panel-title">{localizeUiText(title)}</h3>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{localizeUiText(label)}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="field-input"
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{localizeUiText(label)}</span>
      <textarea
        value={value}
        placeholder={placeholder ? localizeUiText(placeholder) : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="field-textarea"
        rows={4}
      />
    </label>
  );
}

function StatusPill({ value }: { value: string }) {
  return <span className={`status-pill status-${value}`}>{statusLabel(value)}</span>;
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="info-card">
      <span className="info-label">{localizeUiText(label)}</span>
      <strong className="info-value">{value}</strong>
    </article>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="mini-metric">
      <span>{localizeUiText(label)}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SectionList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="section-list">
      <div className="section-list-title">{localizeUiText(title)}</div>
      <ul>
        {(items.length > 0 ? items : ["暂无内容"]).map((item, index) => (
          <li key={`${title}-${index}-${item}`}>{localizeUiText(item)}</li>
        ))}
      </ul>
    </section>
  );
}

function CodeBlock({
  title,
  value
}: {
  title: string;
  value: string;
}) {
  return (
    <section className="section-list">
      <div className="section-list-title">{localizeUiText(title)}</div>
      <pre className="mono-block">{value}</pre>
    </section>
  );
}

function Callout({
  title,
  tone,
  children
}: {
  title: string;
  tone: "rose";
  children: React.ReactNode;
}) {
  return (
    <div className={`callout callout-${tone}`}>
      <strong>{localizeUiText(title)}</strong>
      <p>{children}</p>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="empty-state">{localizeUiText(text)}</p>;
}
