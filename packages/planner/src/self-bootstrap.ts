import type { CreateRunInput } from "@autoresearch/domain";

export interface SelfBootstrapTemplateOptions {
  workspaceRoot?: string;
  ownerId?: string;
  focus?: string;
  extraConstraints?: string[];
  extraSuccessCriteria?: string[];
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
    "Pick the smallest next backend/runtime improvement that moves AISA toward self-bootstrap development.";

  const successCriteria = [
    "Identify one concrete backend/runtime task that should be done next.",
    "Ground the recommendation in local repository evidence and current runtime regressions.",
    "Leave an execution-ready next step with a replayable attempt contract instead of a vague roadmap.",
    "Preserve or extend automated regression coverage for any runtime change."
  ];
  const constraints = [
    "Focus on the run-centered backend/runtime path, not GUI polish.",
    "Use local repository evidence, handoff notes, and eval assets before making claims.",
    "Do not mask failures or adapt implementation only to the current smoke cases.",
    "Any execution attempt must leave a verification plan the runtime can replay itself.",
    "Prefer the smallest change that improves AISA's ability to use itself for the next step."
  ];

  if (options.extraSuccessCriteria) {
    successCriteria.push(...options.extraSuccessCriteria);
  }

  if (options.extraConstraints) {
    constraints.push(...options.extraConstraints);
  }

  const initialSteer = [
    "Read Codex/2026-03-25-development-handoff.md first.",
    "Read evals/runtime-run-loop/ and start from backend/runtime gaps, not GUI work.",
    "Use the current regression suite to choose the next smallest self-bootstrap improvement.",
    "Treat execution as passed only when the runtime can replay the verification commands itself.",
    "If you recommend execution next, include the replayable attempt contract the runtime should enforce.",
    focus,
    "If you change runtime behavior, update or add a regression case in the same pass."
  ].join("\n");

  return {
    runInput: {
      title: "AISA self-bootstrap next-step planning",
      description: [
        "Inspect the current AISA repository and determine the next smallest backend/runtime task",
        "that should be developed so the system can keep improving itself safely."
      ].join(" "),
      success_criteria: successCriteria,
      constraints,
      owner_id: ownerId,
      workspace_root: workspaceRoot
    },
    initialSteer
  };
}
