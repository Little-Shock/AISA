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
  const runHealth = runDetail.run_health;
  const automation = runDetail.automation;
  const runBrief = runDetail.run_brief;
  const failureSignal = runDetail.failure_signal ?? runBrief?.failure_signal ?? null;
  const latestPreflight = runDetail.latest_preflight_evaluation;
  const latestHandoff = runDetail.latest_handoff_bundle;
  const workingContext = runDetail.working_context;
  const workingContextDegraded = runDetail.working_context_degraded;
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
              `现场更新时间：${formatDateTime(workingContext?.updated_at)}`
            ]}
          />
          <SectionList
            title="运行中现场"
            items={[
              `run brief：${localizeUiText(runBrief?.headline ?? "暂无")}`,
              `run brief ref：${runDetail.run_brief_ref ?? "未落盘"}`,
              `当前焦点：${localizeUiText(workingContext?.current_focus ?? "暂无")}`,
              `计划锚点：${workingContext?.plan_ref ?? "暂无"}`,
              `来源尝试：${workingContext?.source_attempt_id ?? "暂无"}`,
              `下一注意点：${localizeUiText(workingContext?.next_operator_attention ?? "暂无")}`,
              `自动化模式：${automationModeLabel(workingContext?.automation.mode ?? automation?.mode)}`
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
              `handoff：${localizeUiText(latestHandoff?.summary ?? "暂无")}`,
              `handoff ref：${runDetail.latest_handoff_bundle_ref ?? "暂无"}`
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
              `run brief blocker：${localizeUiText(runBrief?.blocker_summary ?? "暂无")}`,
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
            title="治理与健康快照"
            items={[
              `治理摘要：${localizeUiText(governance?.context_summary.headline ?? "暂无治理摘要")}`,
              `阻塞重复次数：${String(governance?.blocker_repeat_count ?? 0)}`,
              `排除计划数：${String(governance?.excluded_plans.length ?? 0)}`,
              `最新活动：${latestActivityLabel}`,
              `心跳：${selectedRunHeartbeat?.heartbeat_at ? heartbeatLabel : "暂无"}`,
              `疑似僵尸：${runHealth?.likely_zombie ? "是" : "否"}`
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

export function RunVerificationPanel({
  selectedRunAttemptDetail
}: {
  selectedRunAttemptDetail: RunDetail["attempt_details"][number] | null;
}) {
  const verification = selectedRunAttemptDetail?.runtime_verification ?? null;
  const evaluation = selectedRunAttemptDetail?.evaluation ?? null;
  const contract = selectedRunAttemptDetail?.contract ?? null;
  const attempt = selectedRunAttemptDetail?.attempt ?? null;
  const verificationCommands = contract?.verification_plan?.commands ?? [];
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
