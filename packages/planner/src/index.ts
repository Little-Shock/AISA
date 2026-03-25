import type { BranchSpec, EvalSpec, Goal } from "@autoresearch/domain";
import { BranchSpecSchema, EvalSpecSchema } from "@autoresearch/domain";
export {
  buildSelfBootstrapRunTemplate,
  type SelfBootstrapTemplate,
  type SelfBootstrapTemplateOptions
} from "./self-bootstrap.js";

export interface PlannerOutput {
  planMarkdown: string;
  branchSpecs: BranchSpec[];
  evalSpec: EvalSpec;
}

export function generateInitialPlan(goal: Goal): PlannerOutput {
  const branchSpecs = [
    {
      id: "branch_001",
      hypothesis: "先从系统边界和主流程切入，能最快发现可行实现路径",
      objective: `围绕目标《${goal.title}》梳理最短的端到端 MVP 路径`,
      assigned_worker: "codex",
      success_criteria: [
        "给出清晰主流程",
        "指出关键模块边界",
        "说明首批实现顺序"
      ]
    },
    {
      id: "branch_002",
      hypothesis: "优先固定上下文、状态和事件协议，可以减少后续返工",
      objective: `为目标《${goal.title}》沉淀共享上下文、状态对象和事件流约定`,
      assigned_worker: "codex",
      success_criteria: [
        "关键状态文件格式清晰",
        "事件日志可追加可回放",
        "共享上下文目录职责明确"
      ]
    },
    {
      id: "branch_003",
      hypothesis: "先识别风险、验证点和判分维度，可以提升后续收敛效率",
      objective: `为目标《${goal.title}》识别风险、证据缺口和后续下一步`,
      assigned_worker: "codex",
      success_criteria: [
        "列出主要风险",
        "给出最小验证步骤",
        "输出初始评估维度"
      ]
    }
  ].map((branch) => BranchSpecSchema.parse(branch));

  const evalSpec = EvalSpecSchema.parse({
    dimensions: [
      "relevance",
      "evidence_quality",
      "actionability",
      "cost_efficiency"
    ],
    keep_threshold: 0.75,
    rerun_threshold: 0.45
  });

  const planMarkdown = [
    `# Plan For ${goal.title}`,
    "",
    "## Goal Summary",
    "",
    `- Goal ID: ${goal.id}`,
    `- Description: ${goal.description}`,
    `- Owner: ${goal.owner_id}`,
    "",
    "## Success Criteria",
    "",
    ...goal.success_criteria.map((criterion) => `- ${criterion}`),
    "",
    "## Constraints",
    "",
    ...(goal.constraints.length > 0
      ? goal.constraints.map((constraint) => `- ${constraint}`)
      : ["- None recorded"]),
    "",
    "## Initial Branches",
    "",
    ...branchSpecs.flatMap((branch) => [
      `### ${branch.id}`,
      `- Hypothesis: ${branch.hypothesis}`,
      `- Objective: ${branch.objective}`,
      `- Worker: ${branch.assigned_worker}`,
      "- Success Criteria:",
      ...branch.success_criteria.map((criterion) => `  - ${criterion}`),
      ""
    ]),
    "## Evaluation",
    "",
    `- Dimensions: ${evalSpec.dimensions.join(", ")}`,
    `- Keep Threshold: ${evalSpec.keep_threshold}`,
    `- Rerun Threshold: ${evalSpec.rerun_threshold}`
  ].join("\n");

  return {
    planMarkdown,
    branchSpecs,
    evalSpec
  };
}
