import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  activityLabel,
  attemptTypeLabel,
  localizeUiText,
  nextActionLabel,
  statusLabel,
  workerLabel
} from "./copy";
import {
  deriveRunOperatorChecklist,
  deriveRunSignalBadges,
  formatDateTime,
  formatRelativeTime,
  runtimePhaseLabel
} from "./dashboard-helpers";
import {
  Callout,
  CodeBlock,
  InfoCard,
  Panel,
  SelectField,
  SectionList,
  SubPanel
} from "./dashboard-primitives";
import type { RunDetail, RunOperatorState, RunSummaryItem } from "./dashboard-types";
import { createRunSteerTargetOptions } from "./run-steer";

function runHealthLabel(status: string | null | undefined): string {
  return status ? statusLabel(status) : "未知";
}

function automationModeLabel(mode: string | null | undefined): string {
  switch (mode) {
    case "manual_only":
      return "仅人工";
    case "active":
      return "自动推进";
    default:
      return "未知";
  }
}

function policyStageLabel(stage: string | null | undefined): string {
  switch (stage) {
    case "planning":
      return "规划中";
    case "approval":
      return "等待审批";
    case "execution":
      return "执行边界";
    default:
      return "未建立";
  }
}

function policyApprovalStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "not_required":
      return "无需审批";
    case "pending":
      return "待批准";
    case "approved":
      return "已批准";
    case "rejected":
      return "已拒绝";
    default:
      return "未建立";
  }
}

function workingContextDegradedReasonLabel(reasonCode: string | null | undefined): string {
  switch (reasonCode) {
    case "context_missing":
      return "现场缺失";
    case "context_stale":
      return "现场过期";
    case "context_write_failed":
      return "现场写入失败";
    default:
      return "现场正常";
  }
}

function verifierKitCommandPolicyLabel(
  commandPolicy: string | null | undefined
): string {
  switch (commandPolicy) {
    case "workspace_script_inference":
      return "Workspace Script Inference";
    case "contract_locked_commands":
      return "Contract Locked Commands";
    default:
      return "未知";
  }
}

function harnessGateModeLabel(mode: string | null | undefined): string {
  switch (mode) {
    case "required":
      return "硬门";
    case "disabled":
      return "已关闭";
    default:
      return "未知";
  }
}

function formatWorkingContextSource(input: {
  label: string;
  ref: string | null | undefined;
  updatedAt: string | null | undefined;
  sourceId?: string | null | undefined;
}): string {
  const sourceBits = [input.ref ?? "未记录", formatDateTime(input.updatedAt)];
  if (input.sourceId) {
    sourceBits.push(input.sourceId);
  }

  return `${input.label}：${sourceBits.join(" · ")}`;
}

export function RunOverviewPanel({
  runDetail,
  selectedRun,
  selectedRunOperatorState,
  selectedRunRuntimeState,
  selectedRunHeartbeat,
  selectedRunAttemptDetail,
  selectedRunCurrentUpdatedAt,
  nowTs,
  dataState,
  liveStatusText,
  liveAttemptText,
  refreshLabel,
  onRefresh,
  lastSuccessAtLabel
}: {
  runDetail: RunDetail;
  selectedRun: RunSummaryItem;
  selectedRunOperatorState: RunOperatorState | null;
  selectedRunRuntimeState: RunDetail["attempt_details"][number]["runtime_state"] | null;
  selectedRunHeartbeat: RunDetail["attempt_details"][number]["heartbeat"] | null;
  selectedRunAttemptDetail: RunDetail["attempt_details"][number] | null;
  selectedRunCurrentUpdatedAt: string | null;
  nowTs: number;
  dataState: string;
  liveStatusText: string;
  liveAttemptText: string;
  refreshLabel: string;
  onRefresh: () => void;
  lastSuccessAtLabel: string;
}) {
  const signalBadges = deriveRunSignalBadges(selectedRun, nowTs);
  const operatorChecklist = deriveRunOperatorChecklist(selectedRun, nowTs);
  const governance = runDetail.governance;
  const policyRuntime = runDetail.policy_runtime;
  const runHealth = runDetail.run_health;
  const automation = runDetail.automation;
  const runBrief = runDetail.run_brief;
  const maintenancePlane = runDetail.maintenance_plane;
  const failureSignal = runDetail.failure_signal ?? runBrief?.failure_signal ?? null;
  const latestPreflight = runDetail.latest_preflight_evaluation;
  const latestRuntimeVerification = runDetail.latest_runtime_verification;
  const latestAdversarialVerification = runDetail.latest_adversarial_verification;
  const latestHandoff = runDetail.latest_handoff_bundle;
  const workingContext = runDetail.working_context;
  const workingContextDegraded = runDetail.working_context_degraded;
  const runBriefDegraded = runDetail.run_brief_degraded;
  const runBriefHeadlineText =
    runBriefDegraded.is_degraded
      ? runBriefDegraded.summary ??
        runDetail.run_brief_invalid_reason ??
        "run brief 已降级"
      : runBrief?.headline ?? "暂无";
  const runBriefRefText =
    runBriefDegraded.source_ref ??
    runDetail.run_brief_ref ??
    "未落盘";
  const runBriefBlockerText =
    runBrief?.blocker_summary ??
    runBriefDegraded.summary ??
    runDetail.run_brief_invalid_reason ??
    "暂无";
  const governanceStatus = governance ? statusLabel(governance.status) : "未建立";
  const healthStatus = runHealthLabel(runHealth?.status);
  const latestActivityLabel = runHealth?.latest_activity_at
    ? formatRelativeTime(runHealth.latest_activity_at, nowTs)
    : "暂无";
  const heartbeatLabel = selectedRunHeartbeat?.heartbeat_at
    ? formatRelativeTime(selectedRunHeartbeat.heartbeat_at, nowTs)
    : "暂无";

  return (
    <Panel
      title={runDetail.run.title}
      subtitle="围绕 operator 决策来读这条 run：先看介入等级、信号标签和恢复建议，再看尝试契约、结果和回放证据。"
      actions={
        <div className="action-row">
          <Button
            type="button"
            variant="outline"
            className="h-10 px-5 font-pixel text-[10px] tracking-[0.16em] text-[var(--emerald)]"
            onClick={onRefresh}
          >
            {refreshLabel}
          </Button>
        </div>
      }
    >
      <div className={`run-live-banner run-live-banner-${dataState}`}>
        <div className="run-live-banner-main">
          <strong>{liveStatusText}</strong>
          <p>
            最近同步 {lastSuccessAtLabel}
            {selectedRunCurrentUpdatedAt
              ? ` · 当前状态更新于 ${formatDateTime(selectedRunCurrentUpdatedAt)}`
              : ""}
          </p>
        </div>
        <div className="run-live-banner-side">
          <span>{liveAttemptText}</span>
          <span>最近变化 {formatRelativeTime(selectedRunCurrentUpdatedAt, nowTs)}</span>
        </div>
      </div>

      <div className="signal-badge-row">
        {signalBadges.map((badge) => (
          <span key={badge.key} className={`signal-badge signal-badge-${badge.tone}`}>
            {badge.label}
          </span>
        ))}
      </div>

      <div className="summary-grid">
        <InfoCard
          label="运行状态"
          value={statusLabel(runDetail.current?.run_status ?? "draft")}
        />
        <InfoCard label="介入等级" value={selectedRunOperatorState?.label ?? "暂无"} />
        <InfoCard
          label="下一动作"
          value={nextActionLabel(runDetail.current?.recommended_next_action)}
        />
        <InfoCard label="策略阶段" value={policyStageLabel(policyRuntime?.stage)} />
        <InfoCard
          label="审批状态"
          value={policyApprovalStatusLabel(policyRuntime?.approval_status)}
        />
        <InfoCard label="治理状态" value={governanceStatus} />
        <InfoCard label="运行健康" value={healthStatus} />
        <InfoCard label="自动化模式" value={automationModeLabel(automation?.mode)} />
        <InfoCard
          label="现场状态"
          value={workingContextDegradedReasonLabel(workingContextDegraded.reason_code)}
        />
        <InfoCard label="最新尝试" value={runDetail.current?.latest_attempt_id ?? "暂无"} />
        <InfoCard label="尝试数量" value={String(runDetail.attempts.length)} />
        <InfoCard label="治理主线" value={governance?.mainline_attempt_id ?? "暂无"} />
        <InfoCard label="最新活动" value={latestActivityLabel} />
        <InfoCard label="状态更新时间" value={formatDateTime(selectedRunCurrentUpdatedAt)} />
        <InfoCard label="负责人" value={runDetail.run.owner_id} />
        <InfoCard label="工作区" value={runDetail.run.workspace_root} />
        <InfoCard
          label="实时阶段"
          value={runtimePhaseLabel(selectedRunRuntimeState?.phase)}
        />
        <InfoCard label="会话" value={selectedRunRuntimeState?.session_id ?? "暂无"} />
        <InfoCard label="事件数" value={String(selectedRunRuntimeState?.event_count ?? 0)} />
        <InfoCard
          label="心跳"
          value={
            selectedRunHeartbeat?.heartbeat_at ? `最近 ${heartbeatLabel}` : "暂无"
          }
        />
      </div>

      {selectedRunOperatorState &&
      (selectedRunOperatorState.kind === "needs_action" ||
        selectedRunOperatorState.kind === "at_risk") ? (
        <Callout
          tone={selectedRunOperatorState.kind === "needs_action" ? "rose" : "amber"}
          title={selectedRunOperatorState.kind === "needs_action" ? "当前需介入" : "当前需排查"}
        >
          {selectedRunOperatorState.recovery_hint}
        </Callout>
      ) : null}

      {governance?.status === "blocked" ? (
        <Callout tone="rose" title="治理阻塞">
          {localizeUiText(
            governance.context_summary.blocker_summary ??
              governance.active_problem_summary ??
              governance.context_summary.headline
          )}
        </Callout>
      ) : null}

      {policyRuntime?.approval_status === "pending" ? (
        <Callout tone="rose" title="执行审批待处理">
          {localizeUiText(
            policyRuntime.blocking_reason ??
              policyRuntime.proposed_objective ??
              "当前 execution 计划已生成，但还不能直接发车。"
          )}
        </Callout>
      ) : null}

      {policyRuntime?.approval_status === "rejected" ? (
        <Callout tone="amber" title="执行计划已拒绝">
          {localizeUiText(
            policyRuntime.blocking_reason ??
              "上一版 execution 计划被拒绝，先补 steer 或重开研究。"
          )}
        </Callout>
      ) : null}

      {policyRuntime?.killswitch_active ? (
        <Callout tone="rose" title="策略熔断已开启">
          {localizeUiText(
            policyRuntime.killswitch_reason ??
              "当前 execution 已被策略熔断，需要人工处理后再恢复。"
          )}
        </Callout>
      ) : null}

      {runHealth?.status === "stale_running_attempt" ? (
        <Callout tone="rose" title="疑似僵尸运行">
          {localizeUiText(runHealth.summary)}
        </Callout>
      ) : null}

      {automation?.mode === "manual_only" ? (
        <Callout tone="rose" title="自动化已停">
          {localizeUiText(
            automation.reason ??
              "当前 run 已切到 manual_only，后续只能由人工 launch 或 steer 继续。"
          )}
        </Callout>
      ) : null}

      {workingContextDegraded.is_degraded ? (
        <Callout tone="amber" title="运行中现场降级">
          {localizeUiText(
            workingContextDegraded.summary ??
              "working context 已落后或缺失，先修现场再继续长任务。"
          )}
        </Callout>
      ) : null}

      {runBriefDegraded.is_degraded ? (
        <Callout tone="amber" title="Run Brief 降级">
          {localizeUiText(
            runBriefDegraded.summary ??
              runDetail.run_brief_invalid_reason ??
              "run brief 已退化，先修控制面摘要。"
          )}
        </Callout>
      ) : null}

      {runBrief ? (
        <Callout tone={runBrief.waiting_for_human ? "rose" : "amber"} title="Run Brief">
          <strong>{localizeUiText(runBrief.headline)}</strong>
          <br />
          {localizeUiText(runBrief.summary)}
        </Callout>
      ) : null}

      {failureSignal ? (
        <Callout
          tone={failureSignal.policy_mode === "fail_closed" ? "rose" : "amber"}
          title="统一失败信号"
        >
          <strong>{failureSignal.failure_code ?? failureSignal.failure_class}</strong>
          <br />
          {localizeUiText(failureSignal.summary)}
        </Callout>
      ) : null}

      {maintenancePlane?.blocked_diagnosis.status === "attention" ? (
        <Callout tone="amber" title="维护面诊断">
          <strong>
            {localizeUiText(
              maintenancePlane.blocked_diagnosis.summary ?? "维护平面检测到当前需要排查。"
            )}
          </strong>
          <br />
          {localizeUiText(
            maintenancePlane.blocked_diagnosis.recommended_next_action
              ? `建议动作 ${maintenancePlane.blocked_diagnosis.recommended_next_action}`
              : "当前没有额外建议动作。"
          )}
        </Callout>
      ) : null}

      <div className="dual-grid">
        <SubPanel title="当前分配任务" accent="emerald">
          <p className="body-copy">
            {localizeUiText(
              workingContext?.current_focus ??
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
              `契约回放命令：${String(selectedRunAttemptDetail?.contract?.verification_plan?.commands.length ?? 0)}`,
              `working context：${runDetail.working_context_ref ?? "未落盘"}`,
              `现场更新时间：${formatDateTime(workingContext?.updated_at)}`,
              `policy ref：${runDetail.policy_runtime_ref ?? "未落盘"}`
            ]}
          />
          <SectionList
            title="运行中现场"
            items={[
              `现场版本：${workingContext ? `v${String(workingContext.version)}` : "未落盘"}`,
              `run brief：${localizeUiText(runBriefHeadlineText)}`,
              `run brief ref：${runBriefRefText}`,
              `维护平面：${runDetail.maintenance_plane_ref ?? "未落盘"}`,
              `当前焦点：${localizeUiText(workingContext?.current_focus ?? "暂无")}`,
              `计划锚点：${workingContext?.plan_ref ?? "暂无"}`,
              `来源尝试：${workingContext?.source_attempt_id ?? "暂无"}`,
              `下一注意点：${localizeUiText(workingContext?.next_operator_attention ?? "暂无")}`,
              `自动化模式：${automationModeLabel(workingContext?.automation.mode ?? automation?.mode)}`,
              `策略阶段：${policyStageLabel(policyRuntime?.stage)}`,
              `策略决议：${localizeUiText(policyRuntime?.last_decision ?? "暂无")}`,
              `待批目标：${localizeUiText(policyRuntime?.proposed_objective ?? "暂无")}`
            ]}
          />
          <SectionList
            title="现场来源水位"
            items={[
              formatWorkingContextSource({
                label: "current",
                ref: workingContext?.source_snapshot.current.ref,
                updatedAt: workingContext?.source_snapshot.current.updated_at
              }),
              formatWorkingContextSource({
                label: "automation",
                ref: workingContext?.source_snapshot.automation.ref,
                updatedAt: workingContext?.source_snapshot.automation.updated_at
              }),
              formatWorkingContextSource({
                label: "governance",
                ref: workingContext?.source_snapshot.governance.ref,
                updatedAt: workingContext?.source_snapshot.governance.updated_at
              }),
              formatWorkingContextSource({
                label: "latest attempt",
                ref: workingContext?.source_snapshot.latest_attempt.ref,
                updatedAt: workingContext?.source_snapshot.latest_attempt.updated_at,
                sourceId: workingContext?.source_snapshot.latest_attempt.attempt_id
              }),
              formatWorkingContextSource({
                label: "latest steer",
                ref: workingContext?.source_snapshot.latest_steer.ref,
                updatedAt: workingContext?.source_snapshot.latest_steer.updated_at,
                sourceId: workingContext?.source_snapshot.latest_steer.steer_id
              })
            ]}
          />
          <SectionList
            title="活跃任务引用"
            items={workingContext?.active_task_refs.map((task) => `${task.task_id} · ${task.title} · ${task.source_ref}`) ?? []}
          />
          <SectionList
            title="最近证据引用"
            items={
              workingContext?.recent_evidence_refs.map(
                (item) =>
                  `${item.kind} · ${item.ref}${item.note ? ` · ${localizeUiText(item.note)}` : ""}`
              ) ?? []
            }
          />
          <SectionList
            title="控制面真相"
            items={[
              `failure class：${failureSignal?.failure_class ?? "暂无"}`,
              `failure policy：${failureSignal?.policy_mode ?? "暂无"}`,
              `failure ref：${failureSignal?.source_ref ?? "暂无"}`,
              `preflight：${latestPreflight ? statusLabel(latestPreflight.status) : "暂无"}`,
              `preflight ref：${runDetail.latest_preflight_evaluation_ref ?? "暂无"}`,
              `runtime replay：${
                latestRuntimeVerification
                  ? statusLabel(latestRuntimeVerification.status)
                  : "暂无"
              }`,
              `runtime replay ref：${runDetail.latest_runtime_verification_ref ?? "暂无"}`,
              `adversarial gate：${
                latestAdversarialVerification
                  ? statusLabel(latestAdversarialVerification.status)
                  : "暂无"
              }`,
              `adversarial gate ref：${runDetail.latest_adversarial_verification_ref ?? "暂无"}`,
              `handoff：${localizeUiText(latestHandoff?.summary ?? "暂无")}`,
              `handoff ref：${runDetail.latest_handoff_bundle_ref ?? "暂无"}`
            ]}
          />
          <SectionList
            title="维护平面输出"
            items={
              maintenancePlane?.outputs.map(
                (item) =>
                  `${item.label} · ${item.status}${item.ref ? ` · ${item.ref}` : ""}${item.summary ? ` · ${localizeUiText(item.summary)}` : ""}`
              ) ?? []
            }
          />
          <SectionList
            title="当前成功标准"
            items={
              selectedRunAttemptDetail?.contract?.success_criteria ??
              selectedRunAttemptDetail?.attempt.success_criteria ??
              runDetail.run.success_criteria
            }
          />
          <SectionList title="最近活动" items={selectedRunRuntimeState?.recent_activities ?? []} />
          <SectionList title="已完成步骤" items={selectedRunRuntimeState?.completed_steps ?? []} />
          <SectionList
            title="治理主线"
            items={[
              `治理状态：${governanceStatus}`,
              `主线摘要：${localizeUiText(governance?.mainline_summary ?? "暂无")}`,
              `主线类型：${governance?.mainline_attempt_type ? attemptTypeLabel(governance.mainline_attempt_type) : "暂无"}`,
              `主线尝试：${governance?.mainline_attempt_id ?? "暂无"}`,
              `最近有效进展：${governance?.last_meaningful_progress_at ? formatRelativeTime(governance.last_meaningful_progress_at, nowTs) : "暂无"}`
            ]}
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
              ...runDetail.run.constraints.map((constraint) => localizeUiText(constraint))
            ]}
          />
          <SectionList title="允许动作" items={governance?.next_allowed_actions ?? []} />
          <SectionList title="避免重复" items={governance?.context_summary.avoid_summary ?? []} />
        </SubPanel>

        <SubPanel title="当前判断" accent="amber">
          <p className="body-copy">
            {localizeUiText(
              workingContext?.next_operator_attention ??
                runDetail.current?.summary ??
                "还没有当前判断。"
            )}
          </p>
          <SectionList title="Operator Checklist" items={operatorChecklist} />
          <SectionList
            title="当前状态"
            items={[
              `运行状态：${statusLabel(runDetail.current?.run_status ?? "draft")}`,
              `建议的尝试类型：${runDetail.current?.recommended_attempt_type ? attemptTypeLabel(runDetail.current.recommended_attempt_type) : "暂无"}`,
              `等待人工：${runDetail.current?.waiting_for_human ? "是" : "否"}`,
              `最新尝试：${runDetail.current?.latest_attempt_id ?? "暂无"}`,
              `实时阶段：${runtimePhaseLabel(selectedRunRuntimeState?.phase)}`,
              `最近事件：${selectedRunRuntimeState?.last_event_at ? formatRelativeTime(selectedRunRuntimeState.last_event_at, nowTs) : "暂无"}`,
              `事件总数：${String(selectedRunRuntimeState?.event_count ?? 0)}`,
              `介入等级：${selectedRunOperatorState?.label ?? "暂无"}`,
              `治理状态：${governanceStatus}`,
              `运行健康：${healthStatus}`,
              `现场状态：${workingContextDegradedReasonLabel(workingContextDegraded.reason_code)}`
            ]}
          />
          <SectionList
            title="现场卡点"
            items={[
              `run brief blocker：${localizeUiText(runBriefBlockerText)}`,
              `统一失败信号：${failureSignal?.failure_code ?? failureSignal?.failure_class ?? "暂无"}`,
              `当前 blocker：${localizeUiText(workingContext?.current_blocker?.summary ?? runDetail.current?.blocking_reason ?? "暂无")}`,
              `blocker 锚点：${workingContext?.current_blocker?.ref ?? "暂无"}`,
              `blocker 代码：${workingContext?.current_blocker?.code ?? automation?.reason_code ?? "暂无"}`
            ]}
          />
          <SectionList
            title="交接与发车摘要"
            items={[
              `handoff 摘要：${localizeUiText(latestHandoff?.summary ?? "暂无")}`,
              `handoff 下一动作：${nextActionLabel(latestHandoff?.recommended_next_action)}`,
              `handoff 下一类型：${
                latestHandoff?.recommended_attempt_type
                  ? attemptTypeLabel(latestHandoff.recommended_attempt_type)
                  : "暂无"
              }`,
              `preflight 结果：${latestPreflight ? statusLabel(latestPreflight.status) : "暂无"}`,
              `preflight 失败码：${latestPreflight?.failure_code ?? "暂无"}`,
              `preflight 原因：${localizeUiText(latestPreflight?.failure_reason ?? "暂无")}`
            ]}
          />
          <SectionList
            title="建议先读"
            items={
              runBrief?.evidence_refs.map(
                (item) =>
                  `${item.label} · ${item.ref}${item.summary ? ` · ${localizeUiText(item.summary)}` : ""}`
              ) ?? []
            }
          />
          <SectionList
            title="信号来源"
            items={
              maintenancePlane?.signal_sources.map(
                (item) =>
                  `${item.label} · ${item.plane}${item.ref ? ` · ${item.ref}` : ""}${item.summary ? ` · ${localizeUiText(item.summary)}` : ""}`
              ) ?? []
            }
          />
          <SectionList
            title="治理与健康快照"
            items={[
              `治理摘要：${localizeUiText(governance?.context_summary.headline ?? "暂无治理摘要")}`,
              `阻塞重复次数：${String(governance?.blocker_repeat_count ?? 0)}`,
              `排除计划数：${String(governance?.excluded_plans.length ?? 0)}`,
              `最新活动：${latestActivityLabel}`,
              `心跳：${selectedRunHeartbeat?.heartbeat_at ? heartbeatLabel : "暂无"}`,
              `疑似僵尸：${runHealth?.likely_zombie ? "是" : "否"}`,
              `阻塞诊断：${localizeUiText(maintenancePlane?.blocked_diagnosis.summary ?? "暂无")}`
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
            title="恢复提示"
            value={selectedRunOperatorState?.recovery_hint ?? "当前没有明确恢复建议。"}
          />
          <CodeBlock
            title="治理摘要"
            value={[
              `治理状态：${governanceStatus}`,
              `健康状态：${healthStatus}`,
              `更新时间：${formatDateTime(governance?.updated_at)}`,
              `摘要生成：${formatDateTime(governance?.context_summary.generated_at)}`,
              "",
              localizeUiText(governance?.context_summary.headline ?? "尚未建立治理结论。"),
              governance?.context_summary.progress_summary
                ? `\n进展：${localizeUiText(governance.context_summary.progress_summary)}`
                : "",
              governance?.context_summary.blocker_summary
                ? `\n阻塞：${localizeUiText(governance.context_summary.blocker_summary)}`
                : "",
              runHealth?.summary ? `\nHealth：${localizeUiText(runHealth.summary)}` : ""
            ].join("")}
          />
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
  );
}

export function RunReportPanel({ report }: { report: string }) {
  return (
    <Panel title="运行报告" subtitle="如果循环已经生成运行级报告，这里会直接显示。">
      <pre className="report-block">{localizeUiText(report || "还没有运行报告。")}</pre>
    </Panel>
  );
}

export function RunJournalPanel({
  journal,
  nowTs
}: {
  journal: RunDetail["journal"];
  nowTs: number;
}) {
  return (
    <Panel
      title="运行日志"
      subtitle="这里只看以运行任务为中心的事实时间线，帮助 operator 快速判断这条 run 最近发生了什么。"
    >
      <div className="event-list">
        {[...journal].reverse().slice(0, 24).map((entry) => (
          <article key={entry.id} className="event-row">
            <strong>{activityLabel(entry.type)}</strong>
            <span>
              {formatDateTime(entry.ts)}
              {entry.attempt_id ? ` · ${entry.attempt_id}` : ""}
              {` · ${formatRelativeTime(entry.ts, nowTs)}`}
            </span>
          </article>
        ))}
      </div>
    </Panel>
  );
}

export function RunSteerPanel({
  runDetail,
  selectedRunAttemptDetail,
  steerText,
  steerAttemptId,
  onSteerTextChange,
  onSteerAttemptChange,
  onSubmit,
  busy
}: {
  runDetail: RunDetail;
  selectedRunAttemptDetail: RunDetail["attempt_details"][number] | null;
  steerText: string;
  steerAttemptId: string;
  onSteerTextChange: (value: string) => void;
  onSteerAttemptChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  const steerTargetOptions = createRunSteerTargetOptions(runDetail.attempts);

  return (
    <Panel
      title="Run Steer"
      subtitle="这块只针对当前 run 注入人工指令，不影响其他运行。默认写给下一次 attempt pickup，也可以绑定到具体 attempt。"
    >
      <div className="form-stack">
        <SelectField
          label="Steer 目标"
          value={steerAttemptId}
          onChange={onSteerAttemptChange}
          options={steerTargetOptions}
        />
        <TextAreaForSteer
          value={steerText}
          onChange={onSteerTextChange}
        />
        <div className="steer-panel-note">
          {selectedRunAttemptDetail
            ? `当前默认参考尝试：${selectedRunAttemptDetail.attempt.id} · ${attemptTypeLabel(selectedRunAttemptDetail.attempt.attempt_type)}`
            : "这条 run 还没有 attempt，可直接把 steer 留给下一次 pickup。"}
        </div>
        <Button
          type="button"
          className="mt-2 h-11 w-full font-pixel text-[10px] tracking-[0.16em]"
          onClick={onSubmit}
          disabled={busy || !steerText.trim()}
        >
          {busy ? "提交中..." : "加入 Run Steer 队列"}
        </Button>
      </div>

      <SectionList
        title="最近 steer"
        items={runDetail.steers
          .slice()
          .reverse()
          .slice(0, 6)
          .map((steer) => {
            const attemptPart = steer.attempt_id ? ` · ${steer.attempt_id}` : " · 下次 pickup";
            return `[${statusLabel(steer.status)}]${attemptPart} ${steer.content}`;
          })}
      />
    </Panel>
  );
}

export function RunPolicyPanel({
  runDetail,
  note,
  onNoteChange,
  onApprove,
  onReject,
  onEnableKillswitch,
  onClearKillswitch,
  approveBusy,
  rejectBusy,
  killswitchEnableBusy,
  killswitchClearBusy
}: {
  runDetail: RunDetail;
  note: string;
  onNoteChange: (value: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onEnableKillswitch: () => void;
  onClearKillswitch: () => void;
  approveBusy: boolean;
  rejectBusy: boolean;
  killswitchEnableBusy: boolean;
  killswitchClearBusy: boolean;
}) {
  const policyRuntime = runDetail.policy_runtime;
  const policyActivity = runDetail.policy_activity ?? [];
  const defaultVerifierKitProfile = runDetail.default_verifier_kit_profile;
  const effectivePolicyBundle = runDetail.effective_policy_bundle;
  const harnessProfile = runDetail.run.harness_profile;
  const harnessGates = [
    runDetail.harness_gates.preflight_review,
    runDetail.harness_gates.deterministic_runtime,
    runDetail.harness_gates.postflight_adversarial
  ];
  const harnessSlots = [
    runDetail.harness_slots.research_or_planning,
    runDetail.harness_slots.execution,
    runDetail.harness_slots.preflight_review,
    runDetail.harness_slots.postflight_review,
    runDetail.harness_slots.final_synthesis
  ];
  const slotMismatches = harnessSlots.filter(
    (slotView) => slotView.binding_status === "binding_mismatch"
  );
  const canApprove = policyRuntime?.approval_status === "pending";
  const canReject = policyRuntime?.approval_status === "pending";
  const canEnableKillswitch = policyRuntime?.killswitch_active !== true;
  const canClearKillswitch = policyRuntime?.killswitch_active === true;

  return (
    <Panel
      title="Policy Lane"
      subtitle="这里单独处理 planning、approval、execution 的边界。execution 进入待批以后，只能在这块放行或打回。"
    >
      <div className="summary-grid">
        <InfoCard label="策略阶段" value={policyStageLabel(policyRuntime?.stage)} />
        <InfoCard
          label="审批状态"
          value={policyApprovalStatusLabel(policyRuntime?.approval_status)}
        />
        <InfoCard label="权限档位" value={policyRuntime?.permission_profile ?? "暂无"} />
        <InfoCard label="Hook 策略" value={policyRuntime?.hook_policy ?? "暂无"} />
        <InfoCard label="危险模式" value={policyRuntime?.danger_mode ?? "暂无"} />
        <InfoCard
          label="批准人"
          value={policyRuntime?.approval_actor ?? "暂无"}
        />
      </div>

      {runDetail.policy_runtime_invalid_reason ? (
        <Callout tone="rose" title="Policy Runtime 已损坏">
          {localizeUiText(runDetail.policy_runtime_invalid_reason)}
        </Callout>
      ) : null}

      <SectionList
        title="当前策略判断"
        items={[
          `目标：${localizeUiText(policyRuntime?.proposed_objective ?? "暂无")}`,
          `待批类型：${attemptTypeLabel(policyRuntime?.proposed_attempt_type ?? "暂无")}`,
          `签名：${policyRuntime?.proposed_signature ?? "暂无"}`,
          `来源尝试：${policyRuntime?.source_attempt_id ?? "暂无"}`,
          `来源工件：${policyRuntime?.source_ref ?? "暂无"}`,
          `阻塞原因：${localizeUiText(policyRuntime?.blocking_reason ?? "暂无")}`,
          `最后决议：${localizeUiText(policyRuntime?.last_decision ?? "暂无")}`,
          `发起时间：${formatDateTime(policyRuntime?.approval_requested_at)}`,
          `决议时间：${formatDateTime(policyRuntime?.approval_decided_at)}`,
          `审批备注：${localizeUiText(policyRuntime?.approval_note ?? "暂无")}`,
          `更新时间：${formatDateTime(policyRuntime?.updated_at)}`
        ]}
      />

      <SectionList
        title="待批执行契约"
        items={[
          `signature：${policyRuntime?.proposed_signature ?? "暂无"}`,
          `objective：${localizeUiText(policyRuntime?.proposed_objective ?? "暂无")}`,
          `source ref：${policyRuntime?.source_ref ?? "暂无"}`,
          `policy ref：${runDetail.policy_runtime_ref ?? "未落盘"}`,
          `policy activity ref：${runDetail.policy_activity_ref ?? "暂无"}`
        ]}
      />

      <SectionList
        title="Success Criteria"
        items={
          policyRuntime?.proposed_success_criteria?.length
            ? policyRuntime.proposed_success_criteria.map((item) => localizeUiText(item))
            : ["暂无"]
        }
      />

      <SectionList
        title="最近策略活动"
        items={
          policyActivity.length > 0
            ? policyActivity.map((item) => {
                const parts = [
                  `${formatDateTime(item.ts)} · ${item.kind} · ${item.status}`,
                  item.headline,
                  item.hook_key ? `hook=${item.hook_key}` : null,
                  item.proposed_signature ? `signature=${item.proposed_signature}` : null,
                  item.actor ? `actor=${item.actor}` : null,
                  item.summary ? localizeUiText(item.summary) : null
                ].filter((value): value is string => Boolean(value));
                return parts.join(" | ");
              })
            : ["暂无策略活动"]
        }
      />

      <SectionList
        title="Harness Profile"
        items={[
          `profile 版本：${String(harnessProfile.version)}`,
          `execution effort：${harnessProfile.execution.effort}`,
          `reviewer effort：${harnessProfile.reviewer.effort}`,
          `synthesizer effort：${harnessProfile.synthesizer.effort}`,
          `preflight gate：${harnessGateModeLabel(harnessProfile.gates.preflight_review.mode)}`,
          `runtime gate：${harnessGateModeLabel(harnessProfile.gates.deterministic_runtime.mode)}`,
          `postflight adversarial gate：${harnessGateModeLabel(
            harnessProfile.gates.postflight_adversarial.mode
          )}`
        ]}
      />

      <SectionList
        title="Effective Policy Bundle"
        items={[
          `verification discipline: ${effectivePolicyBundle.verification_discipline.level}`,
          `default verifier kit: ${effectivePolicyBundle.verification_discipline.default_verifier_kit}`,
          `command policy: ${effectivePolicyBundle.verification_discipline.command_policy}`,
          `operator brief intensity: ${effectivePolicyBundle.operator_brief.intensity}`,
          `operator brief evidence refs: ${String(
            effectivePolicyBundle.operator_brief.evidence_ref_budget
          )}`,
          `maintenance refresh: ${effectivePolicyBundle.maintenance_refresh.strategy}`,
          `settled recovery: ${effectivePolicyBundle.recovery.settled_run}`
        ]}
      />

      {!runDetail.harness_gates.postflight_adversarial.enforced ? (
        <Callout tone="amber" title="Postflight Gate 已关闭">
          {localizeUiText(
            "这条 run 的 postflight adversarial gate 已在 harness profile 里关闭。deterministic runtime gate 仍然是硬门。"
          )}
        </Callout>
      ) : null}

      <div className="mt-4 grid gap-3">
        {harnessGates.map((gateView) => (
          <SubPanel
            key={gateView.gate}
            title={gateView.title}
            accent={gateView.enforced ? "emerald" : "amber"}
          >
            <SectionList
              title="Gate Contract"
              items={[
                `mode: ${gateView.mode}`,
                `mode label: ${harnessGateModeLabel(gateView.mode)}`,
                `phase: ${gateView.phase}`,
                `enforced: ${gateView.enforced ? "yes" : "no"}`,
                `default mode: ${gateView.default_mode}`,
                `source: ${gateView.source}`,
                `artifact: ${gateView.artifact_ref}`,
                `detail: ${gateView.detail}`
              ]}
            />
          </SubPanel>
        ))}
      </div>

      {slotMismatches.length > 0 ? (
        <Callout tone="amber" title="Slot Registry 漂移">
          {slotMismatches
            .map(
              (slotView) =>
                `${slotView.slot} expected ${slotView.expected_binding} but got ${slotView.binding}`
            )
            .join(" | ")}
        </Callout>
      ) : null}

      <div className="mt-4 grid gap-3">
        {harnessSlots.map((slotView) => (
          <SubPanel
            key={slotView.slot}
            title={slotView.title}
            accent={slotView.binding_status === "aligned" ? "emerald" : "amber"}
          >
            <SectionList
              title="Registry Contract"
              items={[
                `binding: ${slotView.binding}`,
                `expected binding: ${slotView.expected_binding}`,
                `binding status: ${slotView.binding_status}`,
                `permission boundary: ${slotView.permission_boundary}`,
                `failure semantics: ${slotView.failure_semantics}`,
                `source: ${slotView.source}`,
                `detail: ${slotView.detail}`,
                slotView.slot === "execution"
                  ? `default verifier kit: ${runDetail.harness_slots.execution.default_verifier_kit}`
                  : null
              ].filter((item): item is string => item !== null)}
            />
            <SectionList title="Input Contract" items={slotView.input_contract} />
            <SectionList title="Output Artifacts" items={slotView.output_artifacts} />
          </SubPanel>
        ))}
      </div>

      <SubPanel title="Default Verifier Kit" accent="emerald">
        <SectionList
          title="Kit Contract"
          items={[
            `kit: ${defaultVerifierKitProfile.kit}`,
            `title: ${defaultVerifierKitProfile.title}`,
            `command policy: ${verifierKitCommandPolicyLabel(defaultVerifierKitProfile.command_policy)}`,
            `source: ${defaultVerifierKitProfile.source}`,
            `detail: ${defaultVerifierKitProfile.detail}`
          ]}
        />
        <SectionList
          title="Preflight Expectations"
          items={defaultVerifierKitProfile.preflight_expectations}
        />
        <SectionList
          title="Runtime Expectations"
          items={defaultVerifierKitProfile.runtime_expectations}
        />
        <SectionList
          title="Adversarial Focus"
          items={defaultVerifierKitProfile.adversarial_focus}
        />
      </SubPanel>

      <Textarea
        value={note}
        onChange={(event) => onNoteChange(event.target.value)}
        placeholder="可选。留下批准理由，或写清楚为什么这版 execution 需要打回。"
        className="mt-3 min-h-[110px] border-emerald-900/12 bg-emerald-900/6 text-sm text-[var(--text-primary)]"
      />

      <div className="action-row mt-3">
        <Button
          type="button"
          className="h-10 flex-1 font-pixel text-[10px] tracking-[0.16em]"
          onClick={onApprove}
          disabled={!canApprove || approveBusy}
        >
          {approveBusy ? "批准中..." : "批准 Execution"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-10 flex-1 border-amber-900/16 bg-amber-900/8 font-pixel text-[10px] tracking-[0.16em] text-[var(--amber)]"
          onClick={onReject}
          disabled={!canReject || rejectBusy}
        >
          {rejectBusy ? "打回中..." : "打回重规划"}
        </Button>
      </div>

      <div className="action-row mt-3">
        <Button
          type="button"
          variant="outline"
          className="h-10 flex-1 border-rose-900/18 bg-rose-900/8 font-pixel text-[10px] tracking-[0.16em] text-[var(--rose)]"
          onClick={onEnableKillswitch}
          disabled={!canEnableKillswitch || killswitchEnableBusy}
        >
          {killswitchEnableBusy ? "开启中..." : "开启 Killswitch"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-10 flex-1 border-emerald-900/16 bg-emerald-900/8 font-pixel text-[10px] tracking-[0.16em] text-[var(--emerald)]"
          onClick={onClearKillswitch}
          disabled={!canClearKillswitch || killswitchClearBusy}
        >
          {killswitchClearBusy ? "清除中..." : "清除 Killswitch"}
        </Button>
      </div>
    </Panel>
  );
}

export function RunVerificationPanel({
  selectedRunAttemptDetail
}: {
  selectedRunAttemptDetail: RunDetail["attempt_details"][number] | null;
}) {
  const verification = selectedRunAttemptDetail?.runtime_verification ?? null;
  const adversarialVerification =
    selectedRunAttemptDetail?.adversarial_verification ?? null;
  const evaluation = selectedRunAttemptDetail?.evaluation ?? null;
  const verifierKitProfile =
    selectedRunAttemptDetail?.effective_verifier_kit_profile ?? null;
  const contract = selectedRunAttemptDetail?.contract ?? null;
  const attempt = selectedRunAttemptDetail?.attempt ?? null;
  const verificationCommands = contract?.verification_plan?.commands ?? [];
  const verifierKit =
    verifierKitProfile?.kit ??
    contract?.verifier_kit ??
    verification?.verifier_kit ??
    adversarialVerification?.verifier_kit ??
    "暂无";
  const passedCommands =
    verification?.command_results.filter((command) => command.passed).length ?? 0;
  const isExecutionAttempt = attempt?.attempt_type === "execution";
  const verificationStatusLabel =
    verification?.status
      ? statusLabel(verification.status)
      : isExecutionAttempt
        ? "未运行"
        : "不适用";

  return (
    <Panel
      title="Verification Lane"
      subtitle="把当前 attempt 的 replay readiness、运行时回放和证据缺口直接抬到 operator 面前。"
    >
      <div className="summary-grid">
        <InfoCard label="验证套件" value={verifierKit} />
        <InfoCard label="回放状态" value={verificationStatusLabel} />
        <InfoCard label="契约命令" value={String(verificationCommands.length)} />
        <InfoCard
          label="命令通过"
          value={
            verification
              ? `${passedCommands}/${verification.command_results.length}`
              : "0/0"
          }
        />
        <InfoCard
          label="改动文件"
          value={String(verification?.changed_files.length ?? 0)}
        />
        <InfoCard
          label="评估验证"
          value={evaluation ? statusLabel(evaluation.verification_status) : "暂无"}
        />
        <InfoCard
          label="缺口数量"
          value={String(evaluation?.missing_evidence.length ?? 0)}
        />
      </div>

      {!isExecutionAttempt ? (
        <Callout tone="amber" title="当前不是 execution attempt">
          运行时回放只对 execution attempt 生效；研究型尝试默认显示为不适用。
        </Callout>
      ) : null}

      {isExecutionAttempt && !contract ? (
        <Callout tone="amber" title="缺少 attempt contract">
          当前 execution attempt 没有 contract，runtime 无法把它当成可回放实现步骤来验证。
        </Callout>
      ) : null}

      {isExecutionAttempt && contract && verificationCommands.length === 0 ? (
        <Callout tone="amber" title="缺少回放命令">
          当前 contract 还没有锁定 replayable verification commands，operator 应优先补这块。
        </Callout>
      ) : null}

      {verification?.failure_reason ? (
        <Callout tone="rose" title="当前回放失败原因">
          {localizeUiText(verification.failure_reason)}
        </Callout>
      ) : null}

      <div className="dual-grid">
        <SubPanel title="回放状态" accent="amber">
          <SectionList
            title="当前快照"
            items={[
              `尝试：${attempt?.id ?? "暂无"}`,
              `类型：${attempt ? attemptTypeLabel(attempt.attempt_type) : "暂无"}`,
              `验证套件：${verifierKitProfile?.title ?? verifierKit}`,
              `回放状态：${verificationStatusLabel}`,
              `失败码：${verification?.failure_code ?? "暂无"}`,
              `改动文件：${String(verification?.changed_files.length ?? 0)}`,
              `评估验证：${evaluation ? statusLabel(evaluation.verification_status) : "暂无"}`
            ]}
          />
          <SectionList
            title="回放命令"
            items={verificationCommands.map((command) => {
              const exitCode =
                typeof command.expected_exit_code === "number"
                  ? ` · exit ${command.expected_exit_code}`
                  : "";
              return `${command.purpose} · ${command.command}${exitCode}`;
            })}
          />
          <SectionList
            title="运行时结果"
            items={
              verification?.command_results.map((command) => {
                const verdict = command.passed ? "通过" : "失败";
                return `${verdict} · ${command.purpose} · ${command.command} · ${command.exit_code}/${command.expected_exit_code}`;
              }) ?? []
            }
          />
        </SubPanel>

        <SubPanel title="Verifier Kit Contract" accent="emerald">
          <SectionList
            title="Kit Contract"
            items={[
              `kit: ${verifierKit}`,
              `title: ${verifierKitProfile?.title ?? "暂无"}`,
              `command policy: ${verifierKitCommandPolicyLabel(verifierKitProfile?.command_policy)}`,
              `source: ${verifierKitProfile?.source ?? "暂无"}`,
              `detail: ${verifierKitProfile?.detail ?? "暂无"}`
            ]}
          />
          <SectionList
            title="Preflight Expectations"
            items={verifierKitProfile?.preflight_expectations ?? []}
          />
          <SectionList
            title="Runtime Expectations"
            items={verifierKitProfile?.runtime_expectations ?? []}
          />
          <SectionList
            title="Adversarial Focus"
            items={verifierKitProfile?.adversarial_focus ?? []}
          />
        </SubPanel>

        <SubPanel title="证据缺口" accent="emerald">
          <SectionList title="缺失证据" items={evaluation?.missing_evidence ?? []} />
          <SectionList title="改动文件" items={verification?.changed_files ?? []} />
          <CodeBlock
            title="当前判断依据"
            value={
              evaluation
                ? [
                    `推荐动作：${statusLabel(evaluation.recommendation)}`,
                    `验证状态：${statusLabel(evaluation.verification_status)}`,
                    `目标进度：${evaluation.goal_progress.toFixed(2)}`,
                    `证据质量：${evaluation.evidence_quality.toFixed(2)}`,
                    "",
                    localizeUiText(evaluation.rationale)
                  ].join("\n")
                : "还没有 evaluation。"
            }
          />
        </SubPanel>
      </div>
    </Panel>
  );
}

function TextAreaForSteer({
  value,
  onChange
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-2">
      <span className="text-[13px] text-[var(--muted)]">{localizeUiText("Steer 内容")}</span>
      <Textarea
        value={value}
        placeholder={localizeUiText(
          "例如：下一轮先验证回放约定是否成立，再决定是否继续 execution；不要直接重试相同步骤。"
        )}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-[132px] border-2 border-amber-400/60 bg-[rgba(7,14,27,0.94)] px-4 py-3 font-mono leading-7 text-[var(--ink)] shadow-[4px_4px_0_0_rgba(251,191,36,0.24)]"
        rows={5}
      />
    </label>
  );
}
