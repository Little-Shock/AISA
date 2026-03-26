import {
  ContextBoardSchema,
  ContextSnapshotSchema,
  createEntityId,
  type Branch,
  type ContextBoard,
  type ContextSnapshot,
  type Goal,
  type Steer,
  type WorkerWriteback
} from "@autoresearch/domain";
import type { WorkspacePaths } from "@autoresearch/state-store";
import {
  getContextBoard,
  saveContextBoard,
  saveContextSnapshot
} from "@autoresearch/state-store";

export class ContextManager {
  async initializeGoal(
    workspacePaths: WorkspacePaths,
    goal: Goal
  ): Promise<ContextBoard> {
    const board = ContextBoardSchema.parse({
      shared_facts: [],
      open_questions: [],
      constraints: goal.constraints,
      branch_notes: {}
    });

    await saveContextBoard(workspacePaths, goal.id, board);
    return board;
  }

  async buildSnapshot(input: {
    workspacePaths: WorkspacePaths;
    goal: Goal;
    branch: Branch;
    steers: Steer[];
  }): Promise<ContextSnapshot> {
    const board = await getContextBoard(input.workspacePaths, input.goal.id);
    const snapshot = ContextSnapshotSchema.parse({
      id: createEntityId("ctx"),
      goal_id: input.goal.id,
      branch_id: input.branch.id,
      workspace_root: input.goal.workspace_root,
      goal: {
        title: input.goal.title,
        description: input.goal.description,
        success_criteria: input.goal.success_criteria,
        constraints: input.goal.constraints
      },
      branch: {
        hypothesis: input.branch.hypothesis,
        objective: input.branch.objective,
        success_criteria: input.branch.success_criteria
      },
      steer: input.steers.map((steer) => ({
        id: steer.id,
        content: steer.content,
        scope: steer.scope
      })),
      shared_context: {
        shared_facts: board.shared_facts,
        open_questions: board.open_questions,
        constraints: board.constraints
      },
      created_at: new Date().toISOString()
    });

    await saveContextSnapshot(input.workspacePaths, snapshot);
    return snapshot;
  }

  async applyWriteback(input: {
    workspacePaths: WorkspacePaths;
    goal: Goal;
    branch: Branch;
    writeback: WorkerWriteback;
  }): Promise<ContextBoard> {
    const board = await getContextBoard(input.workspacePaths, input.goal.id);

    const sharedFacts = [
      ...board.shared_facts,
      ...input.writeback.findings.map((finding) => `[${input.branch.id}] ${finding.content}`)
    ];
    const openQuestions = [...board.open_questions, ...input.writeback.questions];
    const branchNotes = {
      ...board.branch_notes,
      [input.branch.id]: [
        `# ${input.branch.id}`,
        "",
        `摘要：${input.writeback.summary}`,
        "",
        "## 发现",
        ...(input.writeback.findings.length > 0
          ? input.writeback.findings.map(
              (finding) =>
                `- [${finding.type}] ${finding.content}${
                  finding.evidence.length > 0
                    ? `（证据：${finding.evidence.join(", ")}）`
                    : ""
                }`
            )
          : ["- 暂无"]),
        "",
        "## 下一步",
        ...(input.writeback.recommended_next_steps.length > 0
          ? input.writeback.recommended_next_steps.map((step) => `- ${step}`)
          : ["- 暂无"])
      ].join("\n")
    };

    const nextBoard = ContextBoardSchema.parse({
      shared_facts: uniqueLines(sharedFacts),
      open_questions: uniqueLines(openQuestions),
      constraints: board.constraints,
      branch_notes: branchNotes
    });

    await saveContextBoard(input.workspacePaths, input.goal.id, nextBoard);
    return nextBoard;
  }
}

function uniqueLines(lines: string[]): string[] {
  return Array.from(new Set(lines.map((line) => line.trim()).filter(Boolean)));
}
