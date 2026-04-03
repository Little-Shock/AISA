"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  activityLabel,
  localizeUiText,
  statusLabel,
  workerLabel
} from "./copy";
import { AttemptCard } from "./attempt-card";
import {
  countRunsByFocusLens,
  deriveRunOperatorState,
  formatClockTime,
  formatDateTime,
  formatDuration,
  formatElapsed,
  formatTimeOrFallback,
  pickSelectedId,
  splitLines
} from "./dashboard-helpers";
import {
  EmptyState,
  Field,
  InfoCard,
  InlineTag,
  Panel,
  SectionList,
  StatusPill,
  SubPanel,
  TextAreaField
} from "./dashboard-primitives";
import type {
  GoalDetail,
  GoalSummaryItem,
  RunDetail,
  RunFocusLens,
  RunInboxFilter,
  RunSummaryItem,
  ViewMode
} from "./dashboard-types";
import {
  RunJournalPanel,
  RunOverviewPanel,
  RunPolicyPanel,
  RunReportPanel,
  RunSteerPanel,
  RunVerificationPanel
} from "./run-detail-panels";
import {
  AgentGridBoard,
  CommandEmptyState,
  InterferenceZone,
  MasterConsole
} from "./retro-console";
import { InterventionQueuePanel, RunInboxPanel } from "./run-inbox";
import {
  defaultRunSteerAttemptId,
  normalizeRunSteerAttemptId
} from "./run-steer";

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
  const [runInboxFilter, setRunInboxFilter] = useState<RunInboxFilter>("all");
  const [runFocusLens, setRunFocusLens] = useState<RunFocusLens>("all");
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
  const [runSteerText, setRunSteerText] = useState("");
  const [runSteerAttemptId, setRunSteerAttemptId] = useState(
    defaultRunSteerAttemptId(null)
  );
  const [runPolicyNote, setRunPolicyNote] = useState("");
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

  useEffect(() => {
    setRunSteerText("");
    setRunSteerAttemptId(defaultRunSteerAttemptId(runDetail?.current?.latest_attempt_id));
    setRunPolicyNote("");
  }, [runDetail?.run.id, runDetail?.current?.latest_attempt_id]);

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
  const selectedRunOperatorState = useMemo(
    () => (selectedRun ? deriveRunOperatorState(selectedRun, nowTs) : null),
    [nowTs, selectedRun]
  );
  const operatorSnapshot = useMemo<
    Array<{
      label: string;
      value: string;
      hint: string;
      tone: "rose" | "amber" | "emerald";
    }>
  >(
    () => [
      {
        label: "人工接球",
        value: String(countRunsByFocusLens(runs, "waiting_human", nowTs)).padStart(2, "0"),
        hint: "等待人工 / blocking reason",
        tone: "rose"
      },
      {
        label: "Runtime 风险",
        value: String(countRunsByFocusLens(runs, "runtime_fault", nowTs)).padStart(2, "0"),
        hint: "报错 / 心跳陈旧",
        tone: "rose"
      },
      {
        label: "回放债务",
        value: String(countRunsByFocusLens(runs, "replay_gap", nowTs)).padStart(2, "0"),
        hint: "execution 无验证契约",
        tone: "amber"
      },
      {
        label: "冷启动池",
        value: String(countRunsByFocusLens(runs, "unstarted", nowTs)).padStart(2, "0"),
        hint: "还没首个 attempt",
        tone: "emerald"
      }
    ],
    [nowTs, runs]
  );

  const overviewStats = useMemo(() => {
    const runningGoals = goals.filter((item) => item.goal.status === "running").length;
    const runningRuns = runs.filter((item) => item.current?.run_status === "running").length;
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
    (refreshState.lastSuccessAt === null || refreshState.lastErrorAt >= refreshState.lastSuccessAt)
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
  const humanHandoffCount = operatorSnapshot[0]?.value ?? "00";
  const runtimeRiskCount = operatorSnapshot[1]?.value ?? "00";

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
      const payload = await fetchControlJson<GoalDetail>(`/goals/${goalId}`, "加载目标详情失败");
      setDetail(payload);
      setError(null);
    } catch (cause) {
      setError(formatLoadError("加载目标详情失败", cause));
    }
  }

  async function selectRun(runId: string) {
    setSelectedRunId(runId);

    try {
      const payload = await fetchControlJson<RunDetail>(`/runs/${runId}`, "加载运行详情失败");
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
              automation: nextDetail.automation,
              governance: nextDetail.governance,
              policy_runtime: nextDetail.policy_runtime,
              policy_runtime_ref: nextDetail.policy_runtime_ref,
              policy_runtime_invalid_reason: nextDetail.policy_runtime_invalid_reason,
              latest_preflight_evaluation: nextDetail.latest_preflight_evaluation,
              latest_preflight_evaluation_ref: nextDetail.latest_preflight_evaluation_ref,
              latest_runtime_verification: nextDetail.latest_runtime_verification,
              latest_runtime_verification_ref: nextDetail.latest_runtime_verification_ref,
              latest_adversarial_verification: nextDetail.latest_adversarial_verification,
              latest_adversarial_verification_ref:
                nextDetail.latest_adversarial_verification_ref,
              latest_handoff_bundle: nextDetail.latest_handoff_bundle,
              latest_handoff_bundle_ref: nextDetail.latest_handoff_bundle_ref,
              run_brief: nextDetail.run_brief,
              run_brief_ref: nextDetail.run_brief_ref,
              maintenance_plane: nextDetail.maintenance_plane,
              maintenance_plane_ref: nextDetail.maintenance_plane_ref,
              working_context: nextDetail.working_context,
              working_context_ref: nextDetail.working_context_ref,
              working_context_degraded: nextDetail.working_context_degraded,
              run_health: nextDetail.run_health,
              attempt_count: nextDetail.attempts.length,
              latest_attempt: latestDetail?.attempt ?? null,
              latest_attempt_runtime_state: latestDetail?.runtime_state ?? null,
              latest_attempt_heartbeat: latestDetail?.heartbeat ?? null,
              task_focus:
                nextDetail.run_brief?.primary_focus ??
                nextDetail.working_context?.current_focus ??
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

  async function queueRunSteer(runId: string) {
    if (!runSteerText.trim()) {
      return;
    }

    setBusy(`run-steer:${runId}`);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/runs/${runId}/steers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: runSteerText.trim(),
          attempt_id: normalizeRunSteerAttemptId(runSteerAttemptId)
        })
      });

      if (!response.ok) {
        throw new Error("提交 run steer 失败");
      }

      setRunSteerText("");
      await refreshDashboard({
        goalId: selectedGoalId,
        runId
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function approveRunPolicy(runId: string) {
    setBusy(`policy-approve:${runId}`);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/runs/${runId}/policy/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor: "dashboard-ui",
          note: runPolicyNote.trim() || undefined
        })
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "批准执行计划失败"));
      }

      setRunPolicyNote("");
      await refreshDashboard({
        goalId: selectedGoalId,
        runId
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function rejectRunPolicy(runId: string) {
    setBusy(`policy-reject:${runId}`);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/runs/${runId}/policy/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor: "dashboard-ui",
          note: runPolicyNote.trim() || undefined
        })
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "拒绝执行计划失败"));
      }

      setRunPolicyNote("");
      await refreshDashboard({
        goalId: selectedGoalId,
        runId
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function enableRunPolicyKillswitch(runId: string) {
    setBusy(`policy-killswitch-enable:${runId}`);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/runs/${runId}/policy/killswitch/enable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor: "dashboard-ui",
          reason: runPolicyNote.trim() || undefined,
          note: runPolicyNote.trim() || undefined
        })
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "开启 killswitch 失败"));
      }

      setRunPolicyNote("");
      await refreshDashboard({
        goalId: selectedGoalId,
        runId
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function clearRunPolicyKillswitch(runId: string) {
    setBusy(`policy-killswitch-clear:${runId}`);
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/runs/${runId}/policy/killswitch/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor: "dashboard-ui",
          note: runPolicyNote.trim() || undefined
        })
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "清除 killswitch 失败"));
      }

      setRunPolicyNote("");
      await refreshDashboard({
        goalId: selectedGoalId,
        runId
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="dashboard-shell">
      <div className="dashboard-frame space-y-6">
        <MasterConsole
          overviewStats={overviewStats}
          operatorSnapshot={operatorSnapshot}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          controlApiDisplay={controlApiDisplay}
          defaultWorkspace={defaultWorkspace}
          liveStatusText={liveStatusText}
          liveStatusDetail={liveStatusDetail}
        />

        <InterferenceZone
          dataState={dataState}
          error={error}
          liveAttemptText={liveAttemptText}
          latestSyncAgeMs={latestSyncAgeMs}
          humanHandoffCount={humanHandoffCount}
          runtimeRiskCount={runtimeRiskCount}
        />

        {viewMode === "runs" ? (
          runs.length === 0 ? (
            <CommandEmptyState
              onSwitchGoals={() => setViewMode("goals")}
              operatorSnapshot={operatorSnapshot}
            />
          ) : (
            <>
              <div className="grid gap-6 xl:grid-cols-[260px_minmax(0,1.2fr)_480px]">
                <aside className="space-y-6 min-w-0">
                  <InterventionQueuePanel
                    runs={runs}
                    nowTs={nowTs}
                    selectedRunId={selectedRunId}
                    onSelectRun={(runId) => {
                      void selectRun(runId);
                    }}
                  />
                </aside>

                <div className="space-y-6 min-w-0 xl:col-span-1">
                  <AgentGridBoard
                    runs={runs}
                    nowTs={nowTs}
                    selectedRunId={selectedRunId}
                    onSelectRun={(runId) => {
                      void selectRun(runId);
                    }}
                  />

                  {runDetail && selectedRun ? (
                    <RunOverviewPanel
                      runDetail={runDetail}
                      selectedRun={selectedRun}
                      selectedRunOperatorState={selectedRunOperatorState}
                      selectedRunRuntimeState={selectedRunRuntimeState}
                      selectedRunHeartbeat={selectedRunHeartbeat}
                      selectedRunAttemptDetail={selectedRunAttemptDetail}
                      selectedRunCurrentUpdatedAt={selectedRunCurrentUpdatedAt}
                      nowTs={nowTs}
                      dataState={dataState}
                      liveStatusText={liveStatusText}
                      liveAttemptText={liveAttemptText}
                      refreshLabel={refreshState.isRefreshing ? "同步中..." : "刷新"}
                      lastSuccessAtLabel={formatTimeOrFallback(refreshState.lastSuccessAt)}
                      onRefresh={() => {
                        void refreshDashboard({
                          goalId: selectedGoalId,
                          runId: runDetail.run.id
                        });
                      }}
                    />
                  ) : (
                    <Panel
                      title="等待选择 Agent"
                      subtitle="从上方 Agent Grid 中选择一张卡片，右侧控制台和下方详情区会切到对应运行任务。"
                    >
                      <EmptyState text="当前还没有选中的运行任务。" />
                    </Panel>
                  )}
                </div>

                <aside className="space-y-6 min-w-0 xl:sticky xl:top-4 xl:self-start">
                  <RunInboxPanel
                    runs={runs}
                    nowTs={nowTs}
                    selectedRunId={selectedRunId}
                    activeFilter={runInboxFilter}
                    focusLens={runFocusLens}
                    onFilterChange={setRunInboxFilter}
                    onFocusLensChange={setRunFocusLens}
                    onSelectRun={(runId) => {
                      void selectRun(runId);
                    }}
                  />

                  {runDetail ? (
                    <>
                      <RunPolicyPanel
                        runDetail={runDetail}
                        note={runPolicyNote}
                        onNoteChange={setRunPolicyNote}
                        onApprove={() => {
                          void approveRunPolicy(runDetail.run.id);
                        }}
                        onReject={() => {
                          void rejectRunPolicy(runDetail.run.id);
                        }}
                        onEnableKillswitch={() => {
                          void enableRunPolicyKillswitch(runDetail.run.id);
                        }}
                        onClearKillswitch={() => {
                          void clearRunPolicyKillswitch(runDetail.run.id);
                        }}
                        approveBusy={busy === `policy-approve:${runDetail.run.id}`}
                        rejectBusy={busy === `policy-reject:${runDetail.run.id}`}
                        killswitchEnableBusy={
                          busy === `policy-killswitch-enable:${runDetail.run.id}`
                        }
                        killswitchClearBusy={
                          busy === `policy-killswitch-clear:${runDetail.run.id}`
                        }
                      />
                      <RunVerificationPanel selectedRunAttemptDetail={selectedRunAttemptDetail} />
                      <RunSteerPanel
                        runDetail={runDetail}
                        selectedRunAttemptDetail={selectedRunAttemptDetail}
                        steerText={runSteerText}
                        steerAttemptId={runSteerAttemptId}
                        onSteerTextChange={setRunSteerText}
                        onSteerAttemptChange={setRunSteerAttemptId}
                        onSubmit={() => {
                          void queueRunSteer(runDetail.run.id);
                        }}
                        busy={busy === `run-steer:${runDetail.run.id}`}
                      />
                    </>
                  ) : null}
                </aside>
              </div>

              {runDetail && selectedRun ? (
                <>
                  <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_480px]">
                    <div className="space-y-6 min-w-0">
                      <RunReportPanel report={runDetail.report} />

                      <Panel title="尝试时间线" subtitle="每条尝试都展示约定、结果、判断、回放验证和日志尾部。">
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
                    </div>

                    <div className="min-w-0">
                      <RunJournalPanel journal={runDetail.journal} nowTs={nowTs} />
                    </div>
                  </div>
                </>
              ) : null}
            </>
          )
        ) : detail && selectedGoal ? (
          <section className="space-y-6">
              <>
                <Panel
                  title={detail.goal.title}
                  subtitle="目标简报、状态总览、人工 steer 都集中在这一屏。"
                  actions={
                    <div className="action-row">
                      <Button
                        type="button"
                        className="h-10 rounded-full px-5"
                        onClick={() => void launchGoal(detail.goal.id)}
                        disabled={busy === `launch:${detail.goal.id}`}
                      >
                        {busy === `launch:${detail.goal.id}` ? "启动中..." : "启动编排"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-10 rounded-full border-emerald-900/12 bg-emerald-900/6 px-5 text-[var(--emerald)]"
                        disabled={refreshState.isRefreshing}
                        onClick={() => {
                          void refreshDashboard({
                            goalId: detail.goal.id,
                            runId: selectedRunId
                          });
                        }}
                      >
                        {refreshState.isRefreshing ? "同步中..." : "刷新"}
                      </Button>
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
                      <Button
                        type="button"
                        variant="outline"
                        className="mt-2 h-11 w-full rounded-full border-emerald-900/12 bg-emerald-900/6 text-[var(--emerald)]"
                        onClick={() => void queueSteer(detail.goal.id)}
                        disabled={busy === `steer:${detail.goal.id}`}
                      >
                        {busy === `steer:${detail.goal.id}` ? "提交中..." : "加入 Steer 队列"}
                      </Button>
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
                  <Panel title="分支看板" subtitle="每个分支都是一个独立的研究假设与工作线程。">
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
                            <Button
                              type="button"
                              variant="outline"
                              className="h-9 rounded-full border-amber-900/12 bg-amber-900/8 px-4 text-[var(--amber)]"
                              onClick={() => void rerunBranch(detail.goal.id, branch.id)}
                              disabled={busy === `rerun:${branch.id}`}
                            >
                              {busy === `rerun:${branch.id}` ? "排队中..." : "重跑分支"}
                            </Button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </Panel>

                  <Panel title="当前最优报告" subtitle="系统会把分支结果压缩成一份持续更新的当前版本。">
                    <pre className="report-block">
                      {localizeUiText(
                        detail.report || "还没有报告。请先启动目标，让 Codex 分支开始执行。"
                      )}
                    </pre>
                  </Panel>
                </div>

                <div className="dual-grid">
                  <Panel title="共享上下文板" subtitle="把事实、问题、约束从各分支回写到共享面板。">
                    <SectionList title="共享事实" items={detail.context.shared_facts} />
                    <SectionList title="开放问题" items={detail.context.open_questions} />
                  </Panel>

                  <Panel title="事件时间线" subtitle="所有关键动作都记录为可追踪的运行事实。">
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
          </section>
        ) : (
          <section className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
            <div className="space-y-6">
              <Panel
                title="发起新目标"
                subtitle="战略目标视图仍保留，用于创建新的 swarm 目标并观察历史目标树。"
                actions={<InlineTag label="Legacy Strategy View" tone="amber" />}
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
                  <Button type="button" onClick={() => void createGoal()} disabled={busy === "create"}>
                    {busy === "create" ? "创建中..." : "创建目标"}
                  </Button>
                </div>
              </Panel>

              <Panel
                title={`目标池 · ${goals.length}`}
                subtitle="兼容保留的目标池，战略视角仍从这里进入。"
                actions={<InlineTag label="Legacy View" tone="amber" />}
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
                            分支 {item.branch_count} · 运行中 {item.running_count} · 已保留 {item.kept_count}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </Panel>
            </div>

            <Panel title="还没有选中目标" subtitle="先从左侧目标池里选一个，或者直接创建新目标。">
              <EmptyState text="这块区域会展示目标概览、分支看板、共享上下文、实时报告和事件时间线。" />
            </Panel>
          </section>
        )}
      </div>
    </main>
  );
}
