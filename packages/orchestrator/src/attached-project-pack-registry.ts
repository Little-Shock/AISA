import type {
  AttachedProjectProfile,
  AttachedProjectStackPackId,
  AttachedProjectTaskPresetId,
  AttemptContractDraft,
  AttemptDoneRubricItem,
  AttemptFailureMode,
  ExecutionVerificationPlan,
  ExecutionVerifierKit,
  VerificationCommand
} from "@autoresearch/domain";

type ProjectCommandLabel = keyof AttachedProjectProfile["default_commands"];

export type AttachedProjectStackPackRecommendation = {
  id: AttachedProjectStackPackId;
  title: string;
  summary: string;
  default_verifier_kit: ExecutionVerifierKit;
  default_task_preset_id: AttachedProjectTaskPresetId;
};

export type AttachedProjectTaskPresetRecommendation = {
  id: AttachedProjectTaskPresetId;
  title: string;
  summary: string;
  recommended: boolean;
};

type AttachedProjectStackPackEntry = AttachedProjectStackPackRecommendation & {
  command_priority: ProjectCommandLabel[];
  supported_task_preset_ids: AttachedProjectTaskPresetId[];
  required_evidence: string[];
  forbidden_shortcuts: string[];
  expected_artifacts: string[];
};

type AttachedProjectTaskPresetEntry = {
  id: AttachedProjectTaskPresetId;
  title: string;
  summary: string;
  command_priority: ProjectCommandLabel[];
  required_evidence: string[];
  forbidden_shortcuts: string[];
  expected_artifacts: string[];
  done_rubric: AttemptDoneRubricItem[];
  failure_modes: AttemptFailureMode[];
};

export type AttachedProjectExecutionDefaults = {
  stack_pack: AttachedProjectStackPackRecommendation;
  task_preset: AttachedProjectTaskPresetRecommendation;
  verifier_kit: ExecutionVerifierKit;
  required_evidence: string[];
  forbidden_shortcuts: string[];
  expected_artifacts: string[];
  done_rubric: AttemptDoneRubricItem[];
  failure_modes: AttemptFailureMode[];
  verification_plan?: ExecutionVerificationPlan;
};

const BASE_EXECUTION_DONE_RUBRIC: AttemptDoneRubricItem[] = [
  {
    code: "git_change_recorded",
    description: "Leave a git-visible workspace change tied to the execution objective."
  },
  {
    code: "artifact_recorded",
    description: "Leave machine-readable artifacts that point at what changed."
  },
  {
    code: "verification_replay_passed",
    description: "Pass the replayable verification commands locked into this contract."
  },
  {
    code: "adversarial_verification_passed",
    description:
      "Leave a machine-readable adversarial verification artifact after deterministic replay passes."
  }
];

const BASE_EXECUTION_FAILURE_MODES: AttemptFailureMode[] = [
  {
    code: "missing_replayable_verification_plan",
    description: "Do not dispatch when attempt_contract.json has no replayable verification commands."
  },
  {
    code: "missing_local_verifier_toolchain",
    description: "Do not dispatch when pnpm replay depends on local node_modules that are missing."
  },
  {
    code: "workspace_not_git_repo",
    description:
      "Do not dispatch execution when the workspace is not a git repository and no baseline can be captured."
  },
  {
    code: "verification_command_not_runnable",
    description: "Do not dispatch when replay commands point at a missing cwd or an executable that cannot be resolved."
  },
  {
    code: "unchanged_workspace_state",
    description: "Do not treat unchanged workspace state as a completed execution step."
  },
  {
    code: "missing_adversarial_verification_requirement",
    description:
      "Do not dispatch execution when attempt_contract.json does not explicitly require adversarial verification."
  },
  {
    code: "missing_adversarial_verification_artifact",
    description:
      "Do not treat execution as complete without a machine-readable adversarial verification artifact."
  }
];

const ATTACHED_PROJECT_STACK_PACKS: Record<
  AttachedProjectStackPackId,
  AttachedProjectStackPackEntry
> = {
  node_backend: {
    id: "node_backend",
    title: "Node Backend Pack",
    summary:
      "Bias defaults toward repo-local build, test, and lint replay for Node services and workers.",
    default_verifier_kit: "repo",
    default_task_preset_id: "bugfix",
    command_priority: ["test", "build", "lint"],
    supported_task_preset_ids: [
      "bugfix",
      "feature",
      "refactor",
      "api_change",
      "flaky_test",
      "release_hardening"
    ],
    required_evidence: [
      "Keep the verification plan anchored to repository commands that replay the touched backend boundary."
    ],
    forbidden_shortcuts: [
      "Do not skip the repo-local regression commands that prove the backend still works."
    ],
    expected_artifacts: ["artifacts/backend-change-summary.md"]
  },
  python_service: {
    id: "python_service",
    title: "Python Service Pack",
    summary:
      "Bias defaults toward explicit service or CLI replay commands for Python repos.",
    default_verifier_kit: "cli",
    default_task_preset_id: "bugfix",
    command_priority: ["test", "build"],
    supported_task_preset_ids: [
      "bugfix",
      "feature",
      "refactor",
      "api_change",
      "flaky_test",
      "release_hardening"
    ],
    required_evidence: [
      "Keep the replay plan explicit so Python service behavior is proven outside a single happy path."
    ],
    forbidden_shortcuts: [
      "Do not treat implicit environment assumptions as proof that the Python service still works."
    ],
    expected_artifacts: ["artifacts/python-service-change-summary.md"]
  },
  go_service_cli: {
    id: "go_service_cli",
    title: "Go Service or CLI Pack",
    summary:
      "Bias defaults toward explicit go test and build replay for Go services and command-line tools.",
    default_verifier_kit: "cli",
    default_task_preset_id: "bugfix",
    command_priority: ["test", "build"],
    supported_task_preset_ids: [
      "bugfix",
      "feature",
      "refactor",
      "flaky_test",
      "release_hardening"
    ],
    required_evidence: [
      "Keep the replay plan explicit so the Go binary or service behavior can be re-run exactly."
    ],
    forbidden_shortcuts: [
      "Do not call a Go workflow verified unless the contract replays the target command path."
    ],
    expected_artifacts: ["artifacts/go-change-summary.md"]
  },
  repo_maintenance: {
    id: "repo_maintenance",
    title: "Repo Maintenance Pack",
    summary:
      "Bias defaults toward maintenance-safe replay for generic repositories that still need guardrails.",
    default_verifier_kit: "repo",
    default_task_preset_id: "release_hardening",
    command_priority: ["test", "lint", "build"],
    supported_task_preset_ids: ["bugfix", "refactor", "release_hardening"],
    required_evidence: [
      "Keep the replay plan focused on repository maintenance checks that prove no silent regressions slipped in."
    ],
    forbidden_shortcuts: [
      "Do not claim maintenance work is safe without replaying the repo checks the pack can see."
    ],
    expected_artifacts: ["artifacts/repo-maintenance-summary.md"]
  }
};

const ATTACHED_PROJECT_TASK_PRESETS: Record<
  AttachedProjectTaskPresetId,
  AttachedProjectTaskPresetEntry
> = {
  bugfix: {
    id: "bugfix",
    title: "Bugfix",
    summary: "Lock the failing boundary before calling the fix complete.",
    command_priority: ["test", "build", "lint"],
    required_evidence: [
      "Capture the failing boundary and the fixed boundary in replayable form."
    ],
    forbidden_shortcuts: [
      "Do not call the bug fixed without replaying the failing or nearby regression path."
    ],
    expected_artifacts: ["artifacts/bugfix-boundary-notes.md"],
    done_rubric: [
      {
        code: "bugfix_boundary_replayed",
        description: "Replay the boundary that proves the bugfix holds."
      }
    ],
    failure_modes: [
      {
        code: "bugfix_regression_unchecked",
        description: "Do not dispatch a bugfix without replaying the broken or nearby regression boundary."
      }
    ]
  },
  feature: {
    id: "feature",
    title: "Feature",
    summary: "Lock the new acceptance path before calling the feature shipped.",
    command_priority: ["build", "test", "lint"],
    required_evidence: [
      "Capture the newly introduced behavior with a replayable acceptance path."
    ],
    forbidden_shortcuts: [
      "Do not claim a new feature works without a replayable acceptance path."
    ],
    expected_artifacts: ["artifacts/feature-acceptance-notes.md"],
    done_rubric: [
      {
        code: "feature_acceptance_replayed",
        description: "Replay the acceptance path that proves the feature works."
      }
    ],
    failure_modes: [
      {
        code: "feature_acceptance_missing",
        description: "Do not dispatch a feature without replaying the new acceptance boundary."
      }
    ]
  },
  refactor: {
    id: "refactor",
    title: "Refactor",
    summary: "Lock the behavior-preserving checks before calling the refactor safe.",
    command_priority: ["test", "lint", "build"],
    required_evidence: [
      "Capture the behavior-preserving replay that proves the refactor did not silently drift."
    ],
    forbidden_shortcuts: [
      "Do not call a refactor safe without replaying the preserved behavior."
    ],
    expected_artifacts: ["artifacts/refactor-safety-notes.md"],
    done_rubric: [
      {
        code: "refactor_behavior_replayed",
        description: "Replay the preserved behavior that proves the refactor stayed aligned."
      }
    ],
    failure_modes: [
      {
        code: "refactor_behavior_drift_unchecked",
        description: "Do not dispatch a refactor without replaying the behavior that must stay unchanged."
      }
    ]
  },
  api_change: {
    id: "api_change",
    title: "API Change",
    summary: "Lock the API boundary before calling the interface change safe.",
    command_priority: ["test", "build", "start"],
    required_evidence: [
      "Capture the API boundary that proves callers still see the intended contract."
    ],
    forbidden_shortcuts: [
      "Do not claim an API change is safe without replaying the changed interface boundary."
    ],
    expected_artifacts: ["artifacts/api-contract-notes.md"],
    done_rubric: [
      {
        code: "api_boundary_replayed",
        description: "Replay the API boundary that proves the interface change holds."
      }
    ],
    failure_modes: [
      {
        code: "api_boundary_unchecked",
        description: "Do not dispatch an API change without replaying the changed interface boundary."
      }
    ]
  },
  flaky_test: {
    id: "flaky_test",
    title: "Flaky Test",
    summary: "Lock the unstable test path before claiming the flake is contained.",
    command_priority: ["test"],
    required_evidence: [
      "Capture the flaky boundary and the replay that shows the test path is now stable."
    ],
    forbidden_shortcuts: [
      "Do not call a flaky test fixed without replaying the unstable test path."
    ],
    expected_artifacts: ["artifacts/flaky-test-notes.md"],
    done_rubric: [
      {
        code: "flaky_path_replayed",
        description: "Replay the flaky path or stabilization boundary that proves the flake is contained."
      }
    ],
    failure_modes: [
      {
        code: "flaky_path_unchecked",
        description: "Do not dispatch a flaky-test fix without replaying the unstable test path."
      }
    ]
  },
  release_hardening: {
    id: "release_hardening",
    title: "Release Hardening",
    summary: "Lock the release gate replay before calling the repository ready to ship.",
    command_priority: ["build", "test", "lint"],
    required_evidence: [
      "Capture the release gate replay that proves the repository is ready to ship."
    ],
    forbidden_shortcuts: [
      "Do not call a release hardening pass complete without replaying the release gates."
    ],
    expected_artifacts: ["artifacts/release-hardening-notes.md"],
    done_rubric: [
      {
        code: "release_gate_replayed",
        description: "Replay the release gates that prove the repository is ready to ship."
      }
    ],
    failure_modes: [
      {
        code: "release_gate_unchecked",
        description: "Do not dispatch release hardening without replaying the release gates."
      }
    ]
  }
};

export function recommendAttachedProjectStackPack(
  project: AttachedProjectProfile
): AttachedProjectStackPackRecommendation {
  switch (project.project_type) {
    case "node_repo":
      return ATTACHED_PROJECT_STACK_PACKS.node_backend;
    case "python_repo":
      return ATTACHED_PROJECT_STACK_PACKS.python_service;
    case "go_repo":
      return ATTACHED_PROJECT_STACK_PACKS.go_service_cli;
    case "generic_git_repo":
    default:
      return ATTACHED_PROJECT_STACK_PACKS.repo_maintenance;
  }
}

export function listAttachedProjectTaskPresetRecommendations(input: {
  stack_pack_id: AttachedProjectStackPackId;
}): AttachedProjectTaskPresetRecommendation[] {
  const pack = ATTACHED_PROJECT_STACK_PACKS[input.stack_pack_id];

  return pack.supported_task_preset_ids.map((presetId) => {
    const preset = ATTACHED_PROJECT_TASK_PRESETS[presetId];
    return {
      id: preset.id,
      title: preset.title,
      summary: preset.summary,
      recommended: preset.id === pack.default_task_preset_id
    };
  });
}

export function getAttachedProjectTaskPresetRecommendation(
  taskPresetId: AttachedProjectTaskPresetId
): AttachedProjectTaskPresetRecommendation {
  const preset = ATTACHED_PROJECT_TASK_PRESETS[taskPresetId];

  return {
    id: preset.id,
    title: preset.title,
    summary: preset.summary,
    recommended: false
  };
}

export function buildAttachedProjectExecutionDefaults(input: {
  project: AttachedProjectProfile;
  stack_pack_id?: AttachedProjectStackPackId | null;
  task_preset_id?: AttachedProjectTaskPresetId | null;
}): AttachedProjectExecutionDefaults {
  const stackPack = resolveAttachedProjectStackPack(input.project, input.stack_pack_id);
  const taskPreset = resolveAttachedProjectTaskPreset(stackPack, input.task_preset_id);

  return {
    stack_pack: stackPack,
    task_preset: {
      ...getAttachedProjectTaskPresetRecommendation(taskPreset.id),
      recommended: taskPreset.id === stackPack.default_task_preset_id
    },
    verifier_kit: stackPack.default_verifier_kit,
    required_evidence: dedupeStrings(
      ...BASE_EXECUTION_REQUIRED_EVIDENCE,
      ...stackPack.required_evidence,
      ...taskPreset.required_evidence
    ),
    forbidden_shortcuts: dedupeStrings(
      ...BASE_EXECUTION_FORBIDDEN_SHORTCUTS,
      ...stackPack.forbidden_shortcuts,
      ...taskPreset.forbidden_shortcuts
    ),
    expected_artifacts: dedupeStrings(
      ...BASE_EXECUTION_EXPECTED_ARTIFACTS,
      ...stackPack.expected_artifacts,
      ...taskPreset.expected_artifacts
    ),
    done_rubric: dedupeItemsByCode(
      BASE_EXECUTION_DONE_RUBRIC,
      taskPreset.done_rubric
    ),
    failure_modes: dedupeItemsByCode(
      BASE_EXECUTION_FAILURE_MODES,
      taskPreset.failure_modes
    ),
    verification_plan: buildAttachedProjectVerificationPlan({
      project: input.project,
      stackPack,
      taskPreset
    })
  };
}

export function buildAttachedProjectExecutionContractPreview(input: {
  project: AttachedProjectProfile;
  stack_pack_id?: AttachedProjectStackPackId | null;
  task_preset_id?: AttachedProjectTaskPresetId | null;
}): AttemptContractDraft {
  const defaults = buildAttachedProjectExecutionDefaults(input);

  return {
    attempt_type: "execution",
    stack_pack_id: defaults.stack_pack.id,
    task_preset_id: defaults.task_preset.id,
    objective: buildPreviewObjective(input.project, defaults.task_preset.id),
    success_criteria: buildPreviewSuccessCriteria(input.project, defaults.task_preset.id),
    required_evidence: defaults.required_evidence,
    adversarial_verification_required: true,
    verifier_kit: defaults.verifier_kit,
    done_rubric: defaults.done_rubric,
    failure_modes: defaults.failure_modes,
    forbidden_shortcuts: defaults.forbidden_shortcuts,
    expected_artifacts: defaults.expected_artifacts,
    verification_plan: defaults.verification_plan
  };
}

function resolveAttachedProjectStackPack(
  project: AttachedProjectProfile,
  stackPackId?: AttachedProjectStackPackId | null
): AttachedProjectStackPackEntry {
  if (!stackPackId) {
    return ATTACHED_PROJECT_STACK_PACKS[recommendAttachedProjectStackPack(project).id];
  }

  const stackPack = ATTACHED_PROJECT_STACK_PACKS[stackPackId];
  if (!stackPack) {
    throw new Error(`Unknown attached project stack pack: ${stackPackId}`);
  }

  return stackPack;
}

function resolveAttachedProjectTaskPreset(
  stackPack: AttachedProjectStackPackEntry,
  taskPresetId?: AttachedProjectTaskPresetId | null
): AttachedProjectTaskPresetEntry {
  const presetId = taskPresetId ?? stackPack.default_task_preset_id;
  if (!stackPack.supported_task_preset_ids.includes(presetId)) {
    throw new Error(
      `Task preset ${presetId} is not supported by attached project stack pack ${stackPack.id}.`
    );
  }

  return ATTACHED_PROJECT_TASK_PRESETS[presetId];
}

function buildAttachedProjectVerificationPlan(input: {
  project: AttachedProjectProfile;
  stackPack: AttachedProjectStackPackEntry;
  taskPreset: AttachedProjectTaskPresetEntry;
}): ExecutionVerificationPlan | undefined {
  const commandPriority = dedupeCommandLabels(
    ...input.taskPreset.command_priority,
    ...input.stackPack.command_priority
  );
  const commands = commandPriority
    .map((label) => buildVerificationCommand(input.project, input.taskPreset, label))
    .filter((command): command is VerificationCommand => command !== null);

  return commands.length > 0 ? { commands } : undefined;
}

function buildVerificationCommand(
  project: AttachedProjectProfile,
  taskPreset: AttachedProjectTaskPresetEntry,
  label: ProjectCommandLabel
): VerificationCommand | null {
  const command = project.default_commands[label];
  if (!command) {
    return null;
  }

  return {
    purpose: buildVerificationPurpose(taskPreset.id, label, project.repo_name),
    command
  };
}

function buildVerificationPurpose(
  taskPresetId: AttachedProjectTaskPresetId,
  label: ProjectCommandLabel,
  repoName: string
): string {
  const action =
    label === "test"
      ? "replay the target regression boundary"
      : label === "build"
        ? "confirm the repository still builds"
        : label === "lint"
          ? "confirm static checks stay aligned"
          : label === "start"
            ? "replay the runnable service entrypoint"
            : "replay the workspace command";

  return `${taskPresetId} preset: ${action} for ${repoName}`;
}

function buildPreviewObjective(
  project: AttachedProjectProfile,
  taskPresetId: AttachedProjectTaskPresetId
): string {
  return `${ATTACHED_PROJECT_TASK_PRESETS[taskPresetId].title} pass for ${project.repo_name}.`;
}

function buildPreviewSuccessCriteria(
  project: AttachedProjectProfile,
  taskPresetId: AttachedProjectTaskPresetId
): string[] {
  return [
    `Leave a verified ${ATTACHED_PROJECT_TASK_PRESETS[taskPresetId].title.toLowerCase()} step in ${project.repo_name}.`,
    "Keep the replay plan machine-readable and fail closed."
  ];
}

const BASE_EXECUTION_REQUIRED_EVIDENCE = [
  "Leave git-visible workspace changes tied to the execution objective.",
  "Keep replay commands machine-readable so runtime can verify the change.",
  "Leave a machine-readable adversarial verification artifact after deterministic replay passes."
] as const;

const BASE_EXECUTION_FORBIDDEN_SHORTCUTS = [
  "Do not claim success without replayable verification.",
  "Do not skip adversarial verification for non-trivial execution."
] as const;

const BASE_EXECUTION_EXPECTED_ARTIFACTS = [
  "artifacts/adversarial-verification.json"
] as const;

function dedupeStrings(...values: string[]): string[] {
  return [...new Set(values)];
}

function dedupeItemsByCode<T extends { code: string }>(
  baseItems: T[],
  extraItems: T[]
): T[] {
  const merged = [...baseItems];
  const seen = new Set(baseItems.map((item) => item.code));

  for (const item of extraItems) {
    if (seen.has(item.code)) {
      continue;
    }
    merged.push(item);
    seen.add(item.code);
  }

  return merged;
}

function dedupeCommandLabels(...values: ProjectCommandLabel[]): ProjectCommandLabel[] {
  return [...new Set(values)];
}
