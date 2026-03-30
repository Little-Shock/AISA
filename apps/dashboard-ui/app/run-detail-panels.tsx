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

  return (
    <Panel
      title={runDetail.run.title}
      subtitle="围绕 operator 决策来读这条 run：先看介入等级、信号标签和恢复建议，再看尝试契约、结果和回放证据。"
      actions={
        <div className="action-row">
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-full border-emerald-900/12 bg-emerald-900/6 px-5 text-[var(--emerald)]"
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
        <InfoCard label="最新尝试" value={runDetail.current?.latest_attempt_id ?? "暂无"} />
        <InfoCard label="尝试数量" value={String(runDetail.attempts.length)} />
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
            selectedRunHeartbeat?.heartbeat_at
              ? `最近 ${formatRelativeTime(selectedRunHeartbeat.heartbeat_at, nowTs)}`
              : "暂无"
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
          <SectionList title="最近活动" items={selectedRunRuntimeState?.recent_activities ?? []} />
          <SectionList title="已完成步骤" items={selectedRunRuntimeState?.completed_steps ?? []} />
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
        </SubPanel>

        <SubPanel title="当前判断" accent="amber">
          <p className="body-copy">
            {localizeUiText(runDetail.current?.summary ?? "还没有当前判断。")}
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
              `介入等级：${selectedRunOperatorState?.label ?? "暂无"}`
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
  const steerTargetOptions = [
    {
      value: "",
      label: "应用到下一次 pickup"
    },
    ...runDetail.attempts
      .slice()
      .reverse()
      .map((attempt) => ({
        value: attempt.id,
        label: `${attempt.id} · ${attemptTypeLabel(attempt.attempt_type)} · ${statusLabel(attempt.status)}`
      }))
  ];

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
          className="mt-2 h-11 w-full rounded-full"
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
        className="min-h-[132px] rounded-[1.15rem] border-black/10 bg-[rgba(255,252,247,0.92)] px-4 py-3 leading-7 text-[var(--ink)] shadow-none"
        rows={5}
      />
    </label>
  );
}
