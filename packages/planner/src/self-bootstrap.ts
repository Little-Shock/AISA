import type {
  CreateRunInput,
  RuntimeHealthHistoryContractDrift,
  RuntimeHealthSnapshot
} from "@autoresearch/domain";

export interface SelfBootstrapTemplateOptions {
  workspaceRoot?: string;
  ownerId?: string;
  focus?: string;
  extraConstraints?: string[];
  extraSuccessCriteria?: string[];
  runtimeHealthSnapshot?: {
    path: string;
    snapshot: RuntimeHealthSnapshot;
  };
}

export interface SelfBootstrapTemplate {
  runInput: CreateRunInput;
  initialSteer: string;
}

export function buildSelfBootstrapRunTemplate(
  options: SelfBootstrapTemplateOptions = {}
): SelfBootstrapTemplate {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const ownerId = options.ownerId ?? "atou";
  const focus =
    options.focus ??
    "选出能推动 AISA 继续自举开发的下一项最小后端或运行时改进。";

  const successCriteria = [
    "确定下一项该做的具体后端或运行时任务。",
    "建议必须建立在本地仓库证据和当前运行时回归之上。",
    "不要给模糊路线图，要留下可直接执行、可回放验证的下一步尝试约定。",
    "任何运行时改动都要保留或补上自动回归覆盖。"
  ];
  const constraints = [
    "优先关注以运行任务为中心的后端与运行时链路，不先做界面润色。",
    "先看本地仓库证据、handoff 说明和评估资产，再下结论。",
    "不要掩盖故障，也不要只为了过眼前 smoke 用例去迎合实现。",
    "任何执行尝试都必须留下运行时自己可回放的验证计划。",
    "优先选择能提升 AISA 自举能力的最小改动。"
  ];

  if (options.extraSuccessCriteria) {
    successCriteria.push(...options.extraSuccessCriteria);
  }

  if (options.extraConstraints) {
    constraints.push(...options.extraConstraints);
  }

  const initialSteer = [
    "先读 Codex/2026-03-25-development-handoff.md。",
    "先读 evals/runtime-run-loop/，从后端和运行时缺口开始，不先做 GUI。",
    "用当前回归用例选出下一项最小的自举改进。",
    "只有运行时能亲自回放验证命令时，执行才算通过。",
    "如果建议下一步执行，就把运行时该强制执行的可回放尝试约定一并给出。",
    buildRuntimeHealthSnapshotHint(options.runtimeHealthSnapshot),
    focus,
    "如果改了运行时行为，就在同一轮补上或更新回归用例。"
  ]
    .filter(Boolean)
    .join("\n");

  return {
    runInput: {
      title: "AISA 自举下一步规划",
      description: [
        "检查当前 AISA 仓库，找出下一项最小且值得优先推进的后端或运行时任务，",
        "让系统能继续安全地自举开发。"
      ].join(" "),
      success_criteria: successCriteria,
      constraints,
      owner_id: ownerId,
      workspace_root: workspaceRoot
    },
    initialSteer
  };
}

function buildRuntimeHealthSnapshotHint(
  runtimeHealthSnapshot: SelfBootstrapTemplateOptions["runtimeHealthSnapshot"]
): string | null {
  if (!runtimeHealthSnapshot) {
    return null;
  }

  const driftRefs = runtimeHealthSnapshot.snapshot.history_contract_drift.drifts
    .slice(0, 4)
    .map(
      (drift: RuntimeHealthHistoryContractDrift) => `${drift.run_id}/${drift.attempt_id}`
    );

  return [
    "先看 context 里的 runtime_health_snapshot 结构化摘要。",
    `快照来源锚点：${runtimeHealthSnapshot.path}。`,
    `当前 runtime 结论：${runtimeHealthSnapshot.snapshot.verify_runtime.summary}`,
    `历史 contract 漂移状态：${runtimeHealthSnapshot.snapshot.history_contract_drift.status}，数量 ${runtimeHealthSnapshot.snapshot.history_contract_drift.drift_count}。`,
    driftRefs.length > 0 ? `当前旧漂移现场：${driftRefs.join("，")}` : null
  ]
    .filter(Boolean)
    .join("\n");
}
