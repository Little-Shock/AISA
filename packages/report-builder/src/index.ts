import type {
  Branch,
  ContextBoard,
  EvalResult,
  Goal,
  WorkerWriteback
} from "@autoresearch/domain";

export function buildGoalReport(input: {
  goal: Goal;
  branches: Branch[];
  contextBoard: ContextBoard;
  writebacks: Record<string, WorkerWriteback | null>;
  evaluations: Record<string, EvalResult | null>;
}): string {
  const ranked = [...input.branches].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  const bestBranch = ranked[0];
  const bestWriteback = bestBranch ? input.writebacks[bestBranch.id] : null;

  return [
    `# 目标报告：${input.goal.title}`,
    "",
    `- 目标 ID：${input.goal.id}`,
    `- 状态：${input.goal.status}`,
    `- 工作区：${input.goal.workspace_root}`,
    "",
    "## 执行摘要",
    "",
    bestWriteback?.summary ?? "还没有分支产出摘要。",
    "",
    "## 当前最优结论",
    "",
    bestBranch
      ? `当前最佳分支是 ${bestBranch.id}，分数 ${(
          bestBranch.score ?? 0
        ).toFixed(2)}。假设：${bestBranch.hypothesis}`
      : "还没有分支结果。",
    "",
    "## 证据表",
    "",
    ...ranked.flatMap((branch) => {
      const writeback = input.writebacks[branch.id];
      if (!writeback) {
        return [`- ${branch.id}：还没有回写结果`];
      }

      return writeback.findings.length > 0
        ? writeback.findings.map(
            (finding: WorkerWriteback["findings"][number]) =>
              `- ${branch.id}：${finding.content}${
                finding.evidence.length > 0 ? ` [${finding.evidence.join(", ")}]` : ""
              }`
          )
        : [`- ${branch.id}：还没有记录发现`];
    }),
    "",
    "## 候选分支",
    "",
    ...ranked.map((branch) => {
      const evaluation = input.evaluations[branch.id];
      return `- ${branch.id}：状态=${branch.status}，分数=${(
        branch.score ?? 0
      ).toFixed(2)}，建议=${evaluation?.recommendation ?? "pending"}`;
    }),
    "",
    "## 待确认问题",
    "",
    ...(input.contextBoard.open_questions.length > 0
      ? input.contextBoard.open_questions.map(
          (question: ContextBoard["open_questions"][number]) => `- ${question}`
        )
      : ["- 暂无。"]),
    "",
    "## 建议的下一步",
    "",
    ...(bestWriteback?.recommended_next_steps.length
      ? bestWriteback.recommended_next_steps.map(
          (step: WorkerWriteback["recommended_next_steps"][number]) => `- ${step}`
        )
      : ["- 等待更多分支结果，或补充人工指令。"])
  ].join("\n");
}
