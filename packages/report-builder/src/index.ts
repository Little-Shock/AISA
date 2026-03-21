import type { Branch, ContextBoard, EvalResult, Goal, WorkerWriteback } from "@autoresearch/domain";

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
    `# Goal Report: ${input.goal.title}`,
    "",
    `- Goal ID: ${input.goal.id}`,
    `- Status: ${input.goal.status}`,
    `- Workspace: ${input.goal.workspace_root}`,
    "",
    "## Executive Summary",
    "",
    bestWriteback?.summary ?? "No branch has produced a summary yet.",
    "",
    "## Current Best Answer",
    "",
    bestBranch
      ? `Best branch is ${bestBranch.id} with score ${(
          bestBranch.score ?? 0
        ).toFixed(2)}. Hypothesis: ${bestBranch.hypothesis}`
      : "No branch result yet.",
    "",
    "## Evidence Table",
    "",
    ...ranked.flatMap((branch) => {
      const writeback = input.writebacks[branch.id];
      if (!writeback) {
        return [`- ${branch.id}: no writeback yet`];
      }

      return writeback.findings.length > 0
        ? writeback.findings.map(
            (finding) =>
              `- ${branch.id}: ${finding.content}${
                finding.evidence.length > 0 ? ` [${finding.evidence.join(", ")}]` : ""
              }`
          )
        : [`- ${branch.id}: no findings recorded`];
    }),
    "",
    "## Competing Branches",
    "",
    ...ranked.map((branch) => {
      const evaluation = input.evaluations[branch.id];
      return `- ${branch.id}: status=${branch.status}, score=${(
        branch.score ?? 0
      ).toFixed(2)}, recommendation=${evaluation?.recommendation ?? "pending"}`;
    }),
    "",
    "## Open Questions",
    "",
    ...(input.contextBoard.open_questions.length > 0
      ? input.contextBoard.open_questions.map((question) => `- ${question}`)
      : ["- None."]),
    "",
    "## Recommended Next Steps",
    "",
    ...(bestWriteback?.recommended_next_steps.length
      ? bestWriteback.recommended_next_steps.map((step) => `- ${step}`)
      : ["- Wait for more branch results or add steer."])
  ].join("\n");
}
