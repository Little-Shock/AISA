import { activityLabel, attemptTypeLabel, localizeUiText, statusLabel, workerLabel } from "./copy";
import {
  formatAttemptElapsed,
  formatDateTime,
  runtimePhaseLabel
} from "./dashboard-helpers";
import { CodeBlock, Callout, MiniMetric, SectionList, StatusPill } from "./dashboard-primitives";
import type { RunDetail } from "./dashboard-types";

export function AttemptCard({
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
  const resultFindings =
    detail.result?.findings.map((finding) => {
      const evidence =
        finding.evidence.length > 0 ? ` · 证据 ${finding.evidence.join(" / ")}` : "";
      return `${localizeUiText(finding.type)} · ${localizeUiText(finding.content)}${evidence}`;
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
        <MiniMetric
          label="对抗"
          value={statusLabel(detail.adversarial_verification?.status ?? "未运行")}
        />
        <MiniMetric label="发现" value={String(detail.result?.findings.length ?? 0)} />
      </div>

      <div className="attempt-grid">
        <div className="attempt-section">
          <div className="attempt-section-title">尝试约定</div>
          <SectionList
            title="成功标准"
            items={detail.contract?.success_criteria ?? detail.attempt.success_criteria}
          />
          <SectionList title="必留证据" items={detail.contract?.required_evidence ?? []} />
          <SectionList title="禁止取巧" items={detail.contract?.forbidden_shortcuts ?? []} />
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
          <SectionList title="关键发现" items={resultFindings} />
          <SectionList title="下一步" items={detail.result?.recommended_next_steps ?? []} />
          <SectionList title="判断缺口" items={detail.evaluation?.missing_evidence ?? []} />
          <SectionList title="运行时回放" items={replayCommands} />
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
          {detail.adversarial_verification?.failure_reason ? (
            <Callout tone="rose" title="对抗验证失败原因">
              {localizeUiText(detail.adversarial_verification.failure_reason)}
            </Callout>
          ) : null}
          {detail.runtime_state?.error ? (
            <Callout tone="rose" title="运行错误">
              {localizeUiText(detail.runtime_state.error)}
            </Callout>
          ) : null}
          <SectionList title="改动文件" items={detail.runtime_verification?.changed_files ?? []} />
          {detail.evaluation ? (
            <CodeBlock
              title="判断摘要"
              value={[
                `推荐动作：${statusLabel(detail.evaluation.recommendation)}`,
                `建议类型：${detail.evaluation.suggested_attempt_type ? attemptTypeLabel(detail.evaluation.suggested_attempt_type) : "无"}`,
                `目标进度：${detail.evaluation.goal_progress.toFixed(2)}`,
                `证据质量：${detail.evaluation.evidence_quality.toFixed(2)}`,
                `验证状态：${statusLabel(detail.evaluation.verification_status)}`,
                `对抗验证：${statusLabel(detail.evaluation.adversarial_verification_status)}`,
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
          <CodeBlock title="错误输出" value={detail.stderr_excerpt || "暂无错误输出。"} />
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
          <CodeBlock title="标准输出" value={detail.stdout_excerpt || "暂无标准输出。"} />
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
