const EXACT_TEXT_MAP: Record<string, string> = {
  "AISA self-bootstrap next-step planning": "AISA 自举下一步规划",
  "Inspect the current AISA repository and determine the next smallest backend/runtime task that should be developed so the system can keep improving itself safely.":
    "检查当前 AISA 仓库，找出下一项最小且值得优先推进的后端或运行时任务，让系统能继续安全地自举开发。",
  "Identify one concrete backend/runtime task that should be done next.":
    "确定下一项该做的具体后端或运行时任务。",
  "Ground the recommendation in local repository evidence and current runtime regressions.":
    "建议必须建立在本地仓库证据和当前运行时回归之上。",
  "Leave an execution-ready next step with a replayable attempt contract instead of a vague roadmap.":
    "不要给模糊路线图，要留下可直接执行、可回放验证的下一步尝试约定。",
  "Preserve or extend automated regression coverage for any runtime change.":
    "任何运行时改动都要保留或补上自动回归覆盖。",
  "Focus on the run-centered backend/runtime path, not GUI polish.":
    "优先关注以运行任务为中心的后端与运行时链路，不先做界面润色。",
  "Use local repository evidence, handoff notes, and eval assets before making claims.":
    "先看本地仓库证据、handoff 说明和评估资产，再下结论。",
  "Do not mask failures or adapt implementation only to the current smoke cases.":
    "不要掩盖故障，也不要只为了过眼前 smoke 用例去迎合实现。",
  "Any execution attempt must leave a verification plan the runtime can replay itself.":
    "任何执行尝试都必须留下运行时自己可回放的验证计划。",
  "Prefer the smallest change that improves AISA's ability to use itself for the next step.":
    "优先选择能提升 AISA 自举能力的最小改动。",
  "Read Codex/2026-03-25-development-handoff.md first.":
    "先读 Codex/2026-03-25-development-handoff.md。",
  "Read evals/runtime-run-loop/ and start from backend/runtime gaps, not GUI work.":
    "先读 evals/runtime-run-loop/，从后端和运行时缺口开始，不先做 GUI。",
  "Use the current regression suite to choose the next smallest self-bootstrap improvement.":
    "用当前回归用例选出下一项最小的自举改进。",
  "Treat execution as passed only when the runtime can replay the verification commands itself.":
    "只有运行时能亲自回放验证命令时，执行才算通过。",
  "If you recommend execution next, include the replayable attempt contract the runtime should enforce.":
    "如果建议下一步执行，就把运行时该强制执行的可回放尝试约定一并给出。",
  "If you change runtime behavior, update or add a regression case in the same pass.":
    "如果改了运行时行为，就在同一轮补上或更新回归用例。",
  "No branch has produced a summary yet.": "还没有分支产出摘要。",
  "No branch result yet.": "还没有分支结果。",
  "No findings recorded.": "还没有记录发现。",
  "None.": "暂无"
};

const TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/# Goal Report:/g, "# 目标报告："],
  [/# Run Report:/g, "# 运行报告："],
  [/# Attempt Report:/g, "# 尝试报告："],
  [/# Branch Report:/g, "# 分支报告："],
  [/## Executive Summary/g, "## 执行摘要"],
  [/## Current Best Answer/g, "## 当前最优结论"],
  [/## Evidence Table/g, "## 证据表"],
  [/## Competing Branches/g, "## 候选分支"],
  [/## Summary/g, "## 摘要"],
  [/## Evaluator/g, "## 评估结论"],
  [/## Runtime Verification/g, "## 运行时回放"],
  [/## Findings/g, "## 发现"],
  [/## Open Questions/g, "## 待确认问题"],
  [/## Recommended Next Steps/g, "## 建议的下一步"],
  [/## Verification Plan/g, "## 回放验证计划"],
  [/## Next Action/g, "## 下一动作"],
  [/\bGoal ID:/g, "目标 ID："],
  [/\bLatest attempt:/g, "最新尝试："],
  [/\bType:/g, "类型："],
  [/\bRun status:/g, "运行状态："],
  [/\bEvaluator recommendation:/g, "评估建议："],
  [/\bSuggested next attempt type:/g, "建议的下一次类型："],
  [/\bVerification status:/g, "验证状态："],
  [/\bRuntime verification:/g, "运行时回放："],
  [/\bStatus:/g, "状态："],
  [/\bWorkspace:/g, "工作区："],
  [/\bGoal:/g, "目标："],
  [/\bHypothesis:/g, "假设："],
  [/\bObjective:/g, "目标："],
  [/\bConfidence:/g, "置信度："],
  [/\bBest branch is /g, "当前最佳分支是 "],
  [/\bwith score /g, "，分数 "],
  [/\bHypothesis: /g, "，假设："],
  [/\bSummary:/g, "摘要："],
  [/\bLatest summary:/g, "最新摘要："],
  [/\bPrevious summary:/g, "上一轮摘要："],
  [/\bFocus gap:/g, "关注缺口："],
  [/\bFocus:/g, "关注点："],
  [/\bChanged files:/g, "改动文件："],
  [/No writeback yet/g, "还没有回写结果"],
  [/No findings recorded/g, "还没有记录发现"],
  [/Wait for more branch results or add steer\./g, "等待更多分支结果，或补充人工指令。"],
  [/Apply the latest human steer for goal:/g, "应用目标的最新人工指令："],
  [/Continue research for goal:/g, "继续研究目标："],
  [/Execute the next concrete step for goal:/g, "执行目标的下一项具体动作："],
  [/Retry the previous research attempt for goal:/g, "重试上一轮研究尝试，目标："],
  [/Retry the previous execution attempt for goal:/g, "重试上一轮执行尝试，目标："],
  [/Understand the repository and surface the best next step for goal:/g, "理解仓库现状并找出目标的最佳下一步："],
  [/Human steer:/g, "人工指令："],
  [/Use the steer to refine the analysis and return grounded findings\./g, "按人工指令收束分析，并返回有证据支撑的结论。"],
  [/Make the smallest useful change, then leave clear artifacts and verification evidence\./g, "做最小且有价值的改动，并留下清晰的产物和验证证据。"],
  [/Run resumed\. Loop will continue from the latest decision\./g, "运行已恢复，循环将从最新判断继续。"],
  [/Attempt (\S+) was still marked running when the orchestrator resumed\. Recovery requires human review before retry\./g, "尝试 $1 在编排器恢复时仍被标记为运行中。重试前需要人工确认恢复。"],
  [/Codex CLI exited with code (\d+) for attempt (\S+)/g, "Codex CLI 在尝试 $2 上以退出码 $1 结束"],
  [/Worker stderr:/g, "执行器错误输出："],
  [/\bexecution\b/g, "执行"],
  [/\bresearch\b/g, "研究"],
  [/\bwait_for_human\b/g, "需要处理"],
  [/\bcontinue_execution\b/g, "继续执行"],
  [/\bcontinue_research\b/g, "继续研究"],
  [/\bstart_execution\b/g, "开始执行"],
  [/\bstart_first_attempt\b/g, "启动首次尝试"],
  [/\bnone\b/g, "无"],
  [/\bpending\b/g, "待定"]
];

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  planned: "已规划",
  planning: "规划中",
  approval: "等待审批",
  running: "运行中",
  waiting_steer: "等待指令",
  reviewing: "评审中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  created: "已创建",
  queued: "排队中",
  writing_back: "回写中",
  judging: "评分中",
  active: "治理进行中",
  blocked: "治理阻塞",
  ready_to_commit: "可收束提交",
  resolved: "治理已收束",
  healthy: "健康",
  stale_running_attempt: "疑似僵尸",
  settled: "已稳定结束",
  unknown: "未知",
  kept: "已保留",
  discarded: "已丢弃",
  respawned: "待重启",
  stopped: "已停止",
  applied: "已应用",
  expired: "已过期",
  continue: "继续",
  retry: "重试",
  complete: "完成",
  wait_human: "需要处理",
  wait_for_human: "需要处理",
  not_required: "无需审批",
  approved: "已批准",
  rejected: "已拒绝",
  passed: "通过",
  not_applicable: "不适用",
  execution: "执行",
  research: "研究",
  start_execution: "开始执行",
  continue_execution: "继续执行",
  continue_research: "继续研究",
  start_first_attempt: "启动首次尝试",
  retry_attempt: "重试上一轮"
};

const ACTIVITY_LABELS: Record<string, string> = {
  "goal.created": "目标已创建",
  "plan.generated": "计划已生成",
  "branch.spawned": "分支已生成",
  "branch.queued": "分支已排队",
  "worker.started": "执行器已启动",
  "worker.finished": "执行器已完成",
  "worker.failed": "执行器执行失败",
  "judge.completed": "评估已完成",
  "report.updated": "报告已更新",
  "steer.queued": "指令已排队",
  "steer.applied": "指令已应用",
  "goal.completed": "目标已结束",
  "run.created": "运行任务已创建",
  "run.launched": "运行任务已启动",
  "run.steer.queued": "运行指令已排队",
  "attempt.created": "尝试已创建",
  "attempt.started": "尝试已开始",
  "attempt.completed": "尝试已完成",
  "attempt.failed": "尝试失败",
  "attempt.recovery_required": "尝试需要人工恢复",
  "attempt.preflight.passed": "发车前检查通过",
  "attempt.preflight.failed": "发车前检查失败",
  "attempt.verification.passed": "回放验证通过",
  "attempt.verification.failed": "回放验证失败",
  "attempt.adversarial_verification.passed": "对抗验证通过",
  "attempt.adversarial_verification.failed": "对抗验证失败",
  "attempt.checkpoint.created": "检查点已创建",
  "attempt.checkpoint.blocked": "检查点被阻塞",
  "attempt.checkpoint.skipped": "检查点已跳过",
  "run.working_context.refresh_failed": "运行现场写入失败",
  "run.run_brief.refresh_failed": "运行摘要写入失败",
  "run.maintenance_plane.refresh_failed": "维护平面写入失败",
  "run.auto_resume.blocked": "自动续跑已阻塞"
};

export function localizeUiText(value: string | null | undefined): string {
  if (!value) {
    return value ?? "";
  }

  let localized = EXACT_TEXT_MAP[value.trim()] ?? value;
  for (const [pattern, replacement] of TEXT_REPLACEMENTS) {
    localized = localized.replace(pattern, replacement);
  }

  return localized;
}

export function statusLabel(value: string): string {
  return STATUS_LABELS[value] ?? localizeUiText(value);
}

export function activityLabel(type: string): string {
  return ACTIVITY_LABELS[type] ?? localizeUiText(type);
}

export function attemptTypeLabel(value: string): string {
  return STATUS_LABELS[value] ?? localizeUiText(value);
}

function formatMachineLabel(value: string): string {
  const compactValue = value.trim();
  if (!compactValue) {
    return "Worker";
  }

  return compactValue
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => {
      const upper = part.toUpperCase();
      if (["API", "CLI", "UI", "JSON", "ID"].includes(upper)) {
        return upper;
      }

      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

export function workerLabel(value: string): string {
  const localized = localizeUiText(value);
  if (localized !== value) {
    return localized;
  }

  return formatMachineLabel(value);
}

export function nextActionLabel(value: string | null | undefined): string {
  return value ? statusLabel(value) : "暂无动作";
}
