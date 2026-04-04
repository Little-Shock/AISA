import { randomUUID } from "node:crypto";
import { z } from "../../../scripts/local-zod.mjs";

export const GoalStatusSchema = z.enum([
  "draft",
  "planned",
  "running",
  "waiting_steer",
  "reviewing",
  "completed",
  "failed",
  "cancelled"
]);

export const RunStatusSchema = z.enum([
  "draft",
  "running",
  "waiting_steer",
  "completed",
  "failed",
  "cancelled"
]);

export const BranchStatusSchema = z.enum([
  "created",
  "queued",
  "running",
  "writing_back",
  "judging",
  "kept",
  "discarded",
  "respawned",
  "failed",
  "stopped"
]);

export const AttemptTypeSchema = z.enum(["research", "execution"]);

export const AttemptStatusSchema = z.enum([
  "created",
  "queued",
  "running",
  "completed",
  "failed",
  "stopped"
]);

export const WorkerRunStateSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "stopped"
]);

export const SteerScopeSchema = z.enum(["goal", "branch", "worker"]);
export const SteerApplyModeSchema = z.enum([
  "immediate_boundary",
  "next_pickup",
  "manual"
]);
export const SteerStatusSchema = z.enum(["queued", "applied", "expired"]);

export const BudgetSchema = z.object({
  tokens: z.number().int().nonnegative(),
  time_minutes: z.number().int().nonnegative(),
  max_concurrency: z.number().int().positive()
});

export const WorkerEffortLevelValues = ["low", "medium", "high"] as const;
export const WorkerEffortLevelSchema = z.enum(WorkerEffortLevelValues);
export const ExecutionVerifierKitValues = ["repo", "web", "api", "cli"] as const;
export const ExecutionVerifierKitSchema = z.enum(ExecutionVerifierKitValues);
export const ExecutionVerifierKitCommandPolicyValues = [
  "workspace_script_inference",
  "contract_locked_commands"
] as const;
export const ExecutionVerifierKitCommandPolicySchema = z.enum(
  ExecutionVerifierKitCommandPolicyValues
);
export const DEFAULT_EXECUTION_VERIFIER_KIT = "repo" as const;
export const RunHarnessGateValues = [
  "preflight_review",
  "deterministic_runtime",
  "postflight_adversarial"
] as const;
export const RunHarnessGateSchema = z.enum(RunHarnessGateValues);
export const RunHarnessGateModeValues = ["required", "disabled"] as const;
export const RunHarnessGateModeSchema = z.enum(RunHarnessGateModeValues);
export const RunHarnessSlotValues = [
  "research_or_planning",
  "execution",
  "preflight_review",
  "postflight_review",
  "final_synthesis"
] as const;
export const RunHarnessSlotSchema = z.enum(RunHarnessSlotValues);
export const CanonicalRunHarnessSlotBindingValues = [
  "research_worker",
  "execution_worker",
  "attempt_dispatch_preflight",
  "attempt_adversarial_verification",
  "attempt_evaluation_synthesizer"
] as const;
export const CanonicalRunHarnessSlotBindingSchema = z.enum(
  CanonicalRunHarnessSlotBindingValues
);
export const RunHarnessSlotBindingValues = [
  "research_worker",
  "execution_worker",
  "codex_cli_research_worker",
  "codex_cli_execution_worker",
  "attempt_dispatch_preflight",
  "attempt_adversarial_verification",
  "attempt_evaluation_synthesizer"
] as const;
export const RunHarnessSlotBindingSchema = z.enum(RunHarnessSlotBindingValues);
const RUN_HARNESS_SLOT_BINDING_CANONICAL_MAP: Record<
  RunHarnessSlotBinding,
  CanonicalRunHarnessSlotBinding
> = {
  research_worker: "research_worker",
  codex_cli_research_worker: "research_worker",
  execution_worker: "execution_worker",
  codex_cli_execution_worker: "execution_worker",
  attempt_dispatch_preflight: "attempt_dispatch_preflight",
  attempt_adversarial_verification: "attempt_adversarial_verification",
  attempt_evaluation_synthesizer: "attempt_evaluation_synthesizer"
} as const;

export const RunHarnessEffortPreferenceSchema = z.object({
  effort: WorkerEffortLevelSchema.default("medium")
});
export const RunHarnessExecutionPreferenceSchema = RunHarnessEffortPreferenceSchema.extend({
  default_verifier_kit: ExecutionVerifierKitSchema.default(
    DEFAULT_EXECUTION_VERIFIER_KIT
  )
});
export const RunHarnessRequiredGateConfigSchema = z.object({
  mode: z.literal("required").default("required")
});
export const RunHarnessPostflightAdversarialGateConfigSchema = z.object({
  mode: RunHarnessGateModeSchema.default("required")
});
export const RunHarnessSlotConfigSchema = z.object({
  binding: RunHarnessSlotBindingSchema
});

const DEFAULT_RUN_HARNESS_GATES = {
  preflight_review: {
    mode: "required" as const
  },
  deterministic_runtime: {
    mode: "required" as const
  },
  postflight_adversarial: {
    mode: "required" as const
  }
};
const DEFAULT_RUN_HARNESS_SLOTS = {
  research_or_planning: {
    binding: "research_worker" as const
  },
  execution: {
    binding: "execution_worker" as const
  },
  preflight_review: {
    binding: "attempt_dispatch_preflight" as const
  },
  postflight_review: {
    binding: "attempt_adversarial_verification" as const
  },
  final_synthesis: {
    binding: "attempt_evaluation_synthesizer" as const
  }
};
export const RunHarnessSlotsSchema = z.object({
  research_or_planning: RunHarnessSlotConfigSchema.default(
    DEFAULT_RUN_HARNESS_SLOTS.research_or_planning
  ),
  execution: RunHarnessSlotConfigSchema.default(DEFAULT_RUN_HARNESS_SLOTS.execution),
  preflight_review: RunHarnessSlotConfigSchema.default(
    DEFAULT_RUN_HARNESS_SLOTS.preflight_review
  ),
  postflight_review: RunHarnessSlotConfigSchema.default(
    DEFAULT_RUN_HARNESS_SLOTS.postflight_review
  ),
  final_synthesis: RunHarnessSlotConfigSchema.default(
    DEFAULT_RUN_HARNESS_SLOTS.final_synthesis
  )
});
export const RunHarnessGatesSchema = z.object({
  preflight_review: RunHarnessRequiredGateConfigSchema.default(
    DEFAULT_RUN_HARNESS_GATES.preflight_review
  ),
  deterministic_runtime: RunHarnessRequiredGateConfigSchema.default(
    DEFAULT_RUN_HARNESS_GATES.deterministic_runtime
  ),
  postflight_adversarial: RunHarnessPostflightAdversarialGateConfigSchema.default(
    DEFAULT_RUN_HARNESS_GATES.postflight_adversarial
  )
});

const DEFAULT_RUN_HARNESS_PROFILE = {
  version: 3 as const,
  execution: {
    effort: "medium" as const,
    default_verifier_kit: DEFAULT_EXECUTION_VERIFIER_KIT
  },
  reviewer: {
    effort: "medium" as const
  },
  synthesizer: {
    effort: "medium" as const
  },
  gates: DEFAULT_RUN_HARNESS_GATES,
  slots: DEFAULT_RUN_HARNESS_SLOTS
};

export const RunHarnessProfileSchema = z.object({
  version: z.number().int().min(1).max(3).default(3),
  execution: RunHarnessExecutionPreferenceSchema.default(
    DEFAULT_RUN_HARNESS_PROFILE.execution
  ),
  reviewer: RunHarnessEffortPreferenceSchema.default(
    DEFAULT_RUN_HARNESS_PROFILE.reviewer
  ),
  synthesizer: RunHarnessEffortPreferenceSchema.default(
    DEFAULT_RUN_HARNESS_PROFILE.synthesizer
  ),
  gates: RunHarnessGatesSchema.default(DEFAULT_RUN_HARNESS_PROFILE.gates),
  slots: RunHarnessSlotsSchema.default(DEFAULT_RUN_HARNESS_PROFILE.slots)
});

export const GoalSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().min(1),
  success_criteria: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string().min(1)).default([]),
  owner_id: z.string(),
  workspace_root: z.string().min(1),
  status: GoalStatusSchema,
  budget: BudgetSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export const RunSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().min(1),
  success_criteria: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string().min(1)).default([]),
  owner_id: z.string(),
  workspace_root: z.string().min(1),
  managed_workspace_root: z.string().min(1).nullable().default(null),
  harness_profile: RunHarnessProfileSchema.default(DEFAULT_RUN_HARNESS_PROFILE),
  budget: BudgetSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export const CreateGoalInputSchema = GoalSchema.omit({
  id: true,
  status: true,
  created_at: true,
  updated_at: true
}).extend({
  workspace_root: z.string().min(1).optional(),
  budget: BudgetSchema.optional()
});

export const CreateRunInputSchema = RunSchema.omit({
  id: true,
  managed_workspace_root: true,
  created_at: true,
  updated_at: true
}).extend({
  workspace_root: z.string().min(1).optional(),
  budget: BudgetSchema.optional()
});

export const AttachedProjectTypeSchema = z.enum([
  "node_repo",
  "python_repo",
  "go_repo",
  "generic_git_repo"
]);

export const AttachedProjectPrimaryLanguageSchema = z.enum([
  "javascript",
  "typescript",
  "python",
  "go",
  "generic"
]);

export const AttachedProjectDefaultCommandsSchema = z.object({
  install: z.string().nullable().default(null),
  build: z.string().nullable().default(null),
  test: z.string().nullable().default(null),
  lint: z.string().nullable().default(null),
  start: z.string().nullable().default(null)
});

const DEFAULT_ATTACHED_PROJECT_COMMANDS = {
  install: null,
  build: null,
  test: null,
  lint: null,
  start: null
};

export const AttachedProjectProfileSchema = z.object({
  id: z.string(),
  slug: z.string().min(1),
  title: z.string().min(1),
  workspace_root: z.string().min(1),
  repo_root: z.string().min(1),
  repo_name: z.string().min(1),
  project_type: AttachedProjectTypeSchema,
  primary_language: AttachedProjectPrimaryLanguageSchema,
  package_manager: z.string().nullable().default(null),
  manifest_files: z.array(z.string().min(1)).default([]),
  detection_reasons: z.array(z.string().min(1)).default([]),
  default_commands: AttachedProjectDefaultCommandsSchema.default(
    DEFAULT_ATTACHED_PROJECT_COMMANDS
  ),
  supported: z.boolean().default(true),
  unsupported_reason: z.string().nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export const AttachedProjectWorkspaceScopeSchema = z.object({
  requested_root: z.string().min(1),
  resolved_root: z.string().min(1),
  matched_scope_root: z.string().min(1)
});

export const AttachedProjectGitBaselineSchema = z.object({
  repo_root: z.string().min(1),
  branch: z.string().nullable().default(null),
  head_sha: z.string().nullable().default(null),
  dirty: z.boolean(),
  staged_file_count: z.number().int().nonnegative(),
  modified_file_count: z.number().int().nonnegative(),
  untracked_file_count: z.number().int().nonnegative(),
  status_lines: z.array(z.string()).default([])
});

export const AttachedProjectToolchainSnapshotSchema = z.object({
  git: z.string().nullable().default(null),
  node: z.string().nullable().default(null),
  pnpm: z.string().nullable().default(null),
  npm: z.string().nullable().default(null),
  python: z.string().nullable().default(null),
  pip: z.string().nullable().default(null),
  poetry: z.string().nullable().default(null),
  uv: z.string().nullable().default(null),
  go: z.string().nullable().default(null)
});

export const AttachedProjectRepoHealthSchema = z.object({
  has_tests: z.boolean(),
  has_build_command: z.boolean(),
  default_verifier_hint: z.string().nullable().default(null),
  suggested_workspace_scope: z.array(z.string().min(1)).default([]),
  supported: z.boolean().default(true),
  unsupported_reason: z.string().nullable().default(null)
});

export const AttachedProjectBaselineSnapshotSchema = z.object({
  project_id: z.string(),
  workspace_root: z.string().min(1),
  captured_at: z.string().datetime(),
  workspace_scope: AttachedProjectWorkspaceScopeSchema,
  git: AttachedProjectGitBaselineSchema,
  toolchain: AttachedProjectToolchainSnapshotSchema,
  repo_health: AttachedProjectRepoHealthSchema
});

export const AttachProjectInputSchema = z.object({
  workspace_root: z.string().min(1),
  owner_id: z.string().min(1).optional(),
  title: z.string().min(1).optional()
});

export const BranchSchema = z.object({
  id: z.string(),
  goal_id: z.string(),
  parent_branch_id: z.string().nullable(),
  hypothesis: z.string().min(1),
  objective: z.string().min(1),
  success_criteria: z.array(z.string().min(1)).min(1),
  assigned_worker: z.string().min(1),
  status: BranchStatusSchema,
  score: z.number().nullable(),
  confidence: z.number().nullable(),
  context_snapshot_id: z.string(),
  latest_run_id: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export const WorkerRunSchema = z.object({
  id: z.string(),
  goal_id: z.string(),
  branch_id: z.string(),
  adapter_type: z.string(),
  prompt_spec: z.record(z.unknown()),
  state: WorkerRunStateSchema,
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().nullable(),
  token_usage: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    total: z.number().int().nonnegative()
  }),
  artifact_dir: z.string(),
  writeback_file: z.string().nullable()
});

export const AttemptSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  attempt_type: AttemptTypeSchema,
  status: AttemptStatusSchema,
  worker: z.string().min(1),
  objective: z.string().min(1),
  success_criteria: z.array(z.string().min(1)).min(1),
  workspace_root: z.string().min(1),
  input_context_ref: z.string().nullable(),
  result_ref: z.string().nullable(),
  evaluation_ref: z.string().nullable(),
  created_at: z.string().datetime(),
  started_at: z.string().datetime().nullable(),
  ended_at: z.string().datetime().nullable(),
  updated_at: z.string().datetime()
});

export const CurrentDecisionSchema = z.object({
  run_id: z.string(),
  run_status: RunStatusSchema,
  best_attempt_id: z.string().nullable(),
  latest_attempt_id: z.string().nullable(),
  recommended_next_action: z.string().nullable(),
  recommended_attempt_type: AttemptTypeSchema.nullable(),
  summary: z.string(),
  blocking_reason: z.string().nullable(),
  waiting_for_human: z.boolean(),
  updated_at: z.string().datetime()
});

export const RunAutomationModeSchema = z.enum(["active", "manual_only"]);

export const RunAutomationReasonCodeSchema = z.enum([
  "superseded_self_bootstrap_run",
  "automatic_resume_blocked",
  "automatic_resume_exhausted",
  "manual_recovery"
]);

export const RunAutomationControlSchema = z.object({
  run_id: z.string(),
  mode: RunAutomationModeSchema,
  reason_code: RunAutomationReasonCodeSchema.nullable().default(null),
  reason: z.string().nullable().default(null),
  imposed_by: z.string().nullable().default(null),
  active_run_id: z.string().nullable().default(null),
  failure_code: z.string().nullable().default(null),
  updated_at: z.string().datetime()
});

export const RunPolicyStageSchema = z.enum([
  "planning",
  "approval",
  "execution"
]);

export const RunPolicyApprovalStatusSchema = z.enum([
  "not_required",
  "pending",
  "approved",
  "rejected"
]);

export const RunPolicyPermissionProfileSchema = z.enum([
  "read_only",
  "workspace_write"
]);

export const RunPolicyHookPolicySchema = z.enum([
  "not_required",
  "enforce_runtime_contract"
]);

export const RunPolicyDangerModeSchema = z.enum([
  "forbid",
  "manual_only"
]);

export const RunPolicyRuntimeSchema = z.object({
  run_id: z.string(),
  stage: RunPolicyStageSchema,
  approval_status: RunPolicyApprovalStatusSchema,
  approval_required: z.boolean().default(false),
  proposed_signature: z.string().nullable().default(null),
  proposed_attempt_type: AttemptTypeSchema.nullable().default(null),
  proposed_objective: z.string().nullable().default(null),
  proposed_success_criteria: z.array(z.string().min(1)).default([]),
  permission_profile: RunPolicyPermissionProfileSchema.default("read_only"),
  hook_policy: RunPolicyHookPolicySchema.default("not_required"),
  danger_mode: RunPolicyDangerModeSchema.default("forbid"),
  killswitch_active: z.boolean().default(false),
  killswitch_reason: z.string().nullable().default(null),
  blocking_reason: z.string().nullable().default(null),
  last_decision: z.string().nullable().default(null),
  approval_requested_at: z.string().datetime().nullable().default(null),
  approval_decided_at: z.string().datetime().nullable().default(null),
  approval_actor: z.string().nullable().default(null),
  approval_note: z.string().nullable().default(null),
  source_attempt_id: z.string().nullable().default(null),
  source_ref: z.string().nullable().default(null),
  updated_at: z.string().datetime()
});

export const RunMailboxMessageTypeSchema = z.enum([
  "approval_request",
  "approval_resolution",
  "dispatch_blocked",
  "handoff_ready"
]);

export const RunMailboxMessageStatusSchema = z.enum(["open", "resolved"]);

export const RunMailboxEntrySchema = z.object({
  id: z.string(),
  run_id: z.string(),
  thread_id: z.string().min(1),
  message_type: RunMailboxMessageTypeSchema,
  from_slot: RunHarnessSlotSchema.nullable().default(null),
  to_slot_or_actor: z.string().min(1),
  status: RunMailboxMessageStatusSchema,
  required_action: z.string().min(1).nullable().default(null),
  summary: z.string().min(1),
  source_ref: z.string().min(1).nullable().default(null),
  source_attempt_id: z.string().nullable().default(null),
  created_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable().default(null)
});

export const RunMailboxSchema = z.object({
  version: z.literal(1),
  run_id: z.string(),
  entries: z.array(RunMailboxEntrySchema).default([]),
  updated_at: z.string().datetime()
});

export const RunWorkingContextTaskRefSchema = z.object({
  task_id: z.string().min(1),
  title: z.string().min(1),
  source_ref: z.string().min(1)
});

export const RunWorkingContextEvidenceRefSchema = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1),
  note: z.string().nullable().default(null)
});

export const RunWorkingContextBlockerSchema = z.object({
  code: z.string().nullable().default(null),
  summary: z.string().min(1),
  ref: z.string().nullable().default(null)
});

export const RunWorkingContextDegradedReasonCodeSchema = z.enum([
  "context_missing",
  "context_stale",
  "context_write_failed"
]);

export const RunWorkingContextDegradedStateSchema = z.object({
  is_degraded: z.boolean(),
  reason_code: RunWorkingContextDegradedReasonCodeSchema.nullable().default(null),
  summary: z.string().nullable().default(null)
});

export const RunFailureClassSchema = z.enum([
  "preflight_blocked",
  "runtime_verification_failed",
  "adversarial_verification_failed",
  "handoff_incomplete",
  "working_context_degraded",
  "run_brief_degraded"
]);

export const RunFailurePolicyModeSchema = z.enum([
  "fail_closed",
  "soft_degrade"
]);

export const RunFailureSourceKindSchema = z.enum([
  "preflight_evaluation",
  "runtime_verification",
  "adversarial_verification",
  "handoff_bundle",
  "working_context",
  "run_brief"
]);

export const RunFailureSignalSchema = z.object({
  failure_class: RunFailureClassSchema,
  policy_mode: RunFailurePolicyModeSchema,
  source_kind: RunFailureSourceKindSchema,
  source_ref: z.string().min(1).nullable().default(null),
  failure_code: z.string().min(1).nullable().default(null),
  summary: z.string().min(1)
});

export const RunWorkingContextAutomationSchema = z.object({
  mode: RunAutomationModeSchema,
  reason_code: RunAutomationReasonCodeSchema.nullable().default(null)
});

export const RUN_WORKING_CONTEXT_VERSION = 1 as const;

export const RunWorkingContextSourceSnapshotEntrySchema = z.object({
  ref: z.string().min(1).nullable().default(null),
  updated_at: z.string().datetime().nullable().default(null)
});

export const RunWorkingContextSourceSnapshotAttemptEntrySchema =
  RunWorkingContextSourceSnapshotEntrySchema.extend({
    attempt_id: z.string().nullable().default(null)
  });

export const RunWorkingContextSourceSnapshotSteerEntrySchema =
  RunWorkingContextSourceSnapshotEntrySchema.extend({
    steer_id: z.string().nullable().default(null)
  });

const DEFAULT_RUN_WORKING_CONTEXT_SOURCE_SNAPSHOT = {
  current: {
    ref: null,
    updated_at: null
  },
  automation: {
    ref: null,
    updated_at: null
  },
  governance: {
    ref: null,
    updated_at: null
  },
  latest_attempt: {
    ref: null,
    updated_at: null,
    attempt_id: null
  },
  latest_steer: {
    ref: null,
    updated_at: null,
    steer_id: null
  }
} as const;

export const RunWorkingContextSourceSnapshotSchema = z.object({
  current: RunWorkingContextSourceSnapshotEntrySchema.default(
    DEFAULT_RUN_WORKING_CONTEXT_SOURCE_SNAPSHOT.current
  ),
  automation: RunWorkingContextSourceSnapshotEntrySchema.default(
    DEFAULT_RUN_WORKING_CONTEXT_SOURCE_SNAPSHOT.automation
  ),
  governance: RunWorkingContextSourceSnapshotEntrySchema.default(
    DEFAULT_RUN_WORKING_CONTEXT_SOURCE_SNAPSHOT.governance
  ),
  latest_attempt: RunWorkingContextSourceSnapshotAttemptEntrySchema.default(
    DEFAULT_RUN_WORKING_CONTEXT_SOURCE_SNAPSHOT.latest_attempt
  ),
  latest_steer: RunWorkingContextSourceSnapshotSteerEntrySchema.default(
    DEFAULT_RUN_WORKING_CONTEXT_SOURCE_SNAPSHOT.latest_steer
  )
});

export const RunWorkingContextSchema = z.object({
  version: z.literal(RUN_WORKING_CONTEXT_VERSION).default(RUN_WORKING_CONTEXT_VERSION),
  run_id: z.string(),
  plan_ref: z.string().nullable().default(null),
  active_task_refs: z.array(RunWorkingContextTaskRefSchema).default([]),
  recent_evidence_refs: z.array(RunWorkingContextEvidenceRefSchema).default([]),
  current_focus: z.string().nullable().default(null),
  current_blocker: RunWorkingContextBlockerSchema.nullable().default(null),
  next_operator_attention: z.string().nullable().default(null),
  automation: RunWorkingContextAutomationSchema,
  degraded: RunWorkingContextDegradedStateSchema,
  source_snapshot: RunWorkingContextSourceSnapshotSchema.default(
    DEFAULT_RUN_WORKING_CONTEXT_SOURCE_SNAPSHOT
  ),
  source_attempt_id: z.string().nullable().default(null),
  updated_at: z.string().datetime()
});

export const RunBriefEvidenceRefSchema = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1),
  label: z.string().min(1),
  summary: z.string().nullable().default(null)
});

export const RunBriefSchema = z.object({
  run_id: z.string(),
  status: RunStatusSchema,
  headline: z.string().min(1),
  summary: z.string().min(1),
  failure_signal: RunFailureSignalSchema.nullable().default(null),
  blocker_summary: z.string().nullable().default(null),
  recommended_next_action: z.string().min(1).nullable().default(null),
  recommended_attempt_type: AttemptTypeSchema.nullable().default(null),
  waiting_for_human: z.boolean().default(false),
  automation_mode: RunAutomationModeSchema,
  latest_attempt_id: z.string().nullable().default(null),
  primary_focus: z.string().nullable().default(null),
  evidence_refs: z.array(RunBriefEvidenceRefSchema).default([]),
  updated_at: z.string().datetime()
});

export const RunHealthStatusSchema = z.enum([
  "healthy",
  "stale_running_attempt",
  "waiting_steer",
  "draft",
  "settled",
  "unknown"
]);

export const RunHealthAssessmentSchema = z.object({
  status: RunHealthStatusSchema,
  summary: z.string().min(1),
  likely_zombie: z.boolean(),
  stale_after_ms: z.number().int().nonnegative(),
  latest_attempt_id: z.string().nullable().default(null),
  latest_attempt_status: AttemptStatusSchema.nullable().default(null),
  latest_activity_at: z.string().datetime().nullable().default(null),
  latest_activity_age_ms: z.number().int().nullable().default(null),
  heartbeat_at: z.string().datetime().nullable().default(null),
  heartbeat_age_ms: z.number().int().nullable().default(null)
});

export const RunSurfacePlaneSchema = z.enum(["mainline", "maintenance"]);

export const RunMaintenanceOutputStatusSchema = z.enum([
  "ready",
  "attention",
  "degraded",
  "not_available"
]);

export const RunMaintenanceSourceSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  plane: RunSurfacePlaneSchema,
  ref: z.string().min(1).nullable().default(null),
  summary: z.string().nullable().default(null)
});

export const RunMaintenanceOutputSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  plane: RunSurfacePlaneSchema.default("maintenance"),
  status: RunMaintenanceOutputStatusSchema,
  ref: z.string().min(1).nullable().default(null),
  summary: z.string().nullable().default(null)
});

export const RunBlockedDiagnosisStatusSchema = z.enum([
  "clear",
  "attention",
  "not_applicable"
]);

export const RunBlockedDiagnosisSchema = z.object({
  status: RunBlockedDiagnosisStatusSchema,
  summary: z.string().nullable().default(null),
  recommended_next_action: z.string().min(1).nullable().default(null),
  source_ref: z.string().min(1).nullable().default(null),
  evidence_refs: z.array(z.string().min(1)).default([]),
  updated_at: z.string().datetime()
});

export const RunMaintenancePlaneSchema = z.object({
  run_id: z.string(),
  run_health: RunHealthAssessmentSchema,
  outputs: z.array(RunMaintenanceOutputSchema).default([]),
  signal_sources: z.array(RunMaintenanceSourceSchema).default([]),
  blocked_diagnosis: RunBlockedDiagnosisSchema,
  updated_at: z.string().datetime()
});

export const RunGovernanceStatusSchema = z.enum([
  "active",
  "blocked",
  "ready_to_commit",
  "resolved"
]);

export const RunGovernanceExcludedPlanSchema = z.object({
  plan_signature: z.string().min(1),
  objective: z.string().min(1),
  reason: z.string().min(1),
  source_attempt_id: z.string().nullable().default(null),
  source_attempt_status: AttemptStatusSchema.nullable().default(null),
  evidence_refs: z.array(z.string().min(1)).default([]),
  excluded_at: z.string().datetime()
});

export const RunGovernanceContextSummarySchema = z.object({
  headline: z.string().min(1),
  progress_summary: z.string().nullable().default(null),
  blocker_summary: z.string().nullable().default(null),
  avoid_summary: z.array(z.string().min(1)).default([]),
  generated_at: z.string().datetime()
});

export const RunGovernanceStateSchema = z.object({
  run_id: z.string(),
  status: RunGovernanceStatusSchema,
  active_problem_signature: z.string().nullable().default(null),
  active_problem_summary: z.string().nullable().default(null),
  blocker_repeat_count: z.number().int().nonnegative().default(0),
  mainline_signature: z.string().nullable().default(null),
  mainline_summary: z.string().nullable().default(null),
  mainline_attempt_type: AttemptTypeSchema.nullable().default(null),
  mainline_attempt_id: z.string().nullable().default(null),
  excluded_plans: z.array(RunGovernanceExcludedPlanSchema).default([]),
  next_allowed_actions: z.array(z.string().min(1)).default([]),
  last_meaningful_progress_at: z.string().datetime().nullable().default(null),
  last_meaningful_progress_attempt_id: z.string().nullable().default(null),
  context_summary: RunGovernanceContextSummarySchema,
  updated_at: z.string().datetime()
});

export const AttemptSynthesizerIdentitySchema = z.object({
  synthesizer_id: z.string().min(1),
  role: z.string().min(1),
  adapter: z.string().min(1),
  provider: z.string().min(1).nullable(),
  model: z.string().min(1).nullable()
});

export const AttemptEvaluationSchema = z.object({
  attempt_id: z.string(),
  run_id: z.string(),
  goal_progress: z.number().min(0).max(1),
  evidence_quality: z.number().min(0).max(1),
  verification_status: z.enum(["passed", "failed", "not_applicable"]),
  adversarial_verification_status: z
    .enum(["passed", "failed", "not_applicable"])
    .default("not_applicable"),
  recommendation: z.enum(["continue", "wait_human", "complete", "retry"]),
  suggested_attempt_type: AttemptTypeSchema.nullable(),
  rationale: z.string().min(1),
  missing_evidence: z.array(z.string().min(1)).default([]),
  review_input_packet_ref: z.string().min(1).nullable().default(null),
  opinion_refs: z.array(z.string().min(1)).default([]),
  evaluation_synthesis_ref: z.string().min(1).nullable().default(null),
  synthesis_strategy: z.string().min(1).default("legacy_single_judge"),
  synthesizer: AttemptSynthesizerIdentitySchema.nullable().default(null),
  reviewer_count: z.number().int().nonnegative().default(0),
  created_at: z.string().datetime()
});

export const RunSteerSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  attempt_id: z.string().nullable(),
  content: z.string().min(1),
  status: SteerStatusSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export const RunJournalEntrySchema = z.object({
  id: z.string(),
  run_id: z.string(),
  attempt_id: z.string().nullable(),
  ts: z.string().datetime(),
  type: z.string().min(1),
  payload: z.record(z.unknown())
});

export const SteerSchema = z.object({
  id: z.string(),
  goal_id: z.string(),
  branch_id: z.string().nullable(),
  scope: SteerScopeSchema,
  content: z.string().min(1),
  apply_mode: SteerApplyModeSchema,
  status: SteerStatusSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
});

export const EventSchema = z.object({
  event_id: z.string(),
  ts: z.string().datetime(),
  goal_id: z.string(),
  branch_id: z.string().nullable().optional(),
  run_id: z.string().nullable().optional(),
  type: z.string().min(1),
  payload: z.record(z.unknown())
});

export const BranchSpecSchema = z.object({
  id: z.string(),
  hypothesis: z.string().min(1),
  objective: z.string().min(1),
  assigned_worker: z.string().min(1),
  success_criteria: z.array(z.string().min(1)).min(1)
});

export const EvalSpecSchema = z.object({
  dimensions: z.array(z.string().min(1)).min(1),
  keep_threshold: z.number().min(0).max(1),
  rerun_threshold: z.number().min(0).max(1)
});

export const WorkerFindingTypeValues = ["fact", "hypothesis", "risk"] as const;
export const WorkerArtifactTypeValues = [
  "patch",
  "command_result",
  "test_result",
  "report",
  "log",
  "screenshot"
] as const;

export const WorkerFindingSchema = z.object({
  type: z.enum(WorkerFindingTypeValues),
  content: z.string().min(1),
  evidence: z.array(z.string().min(1)).default([])
});

export const WorkerArtifactSchema = z.object({
  type: z.enum(WorkerArtifactTypeValues),
  path: z.string().min(1)
});

export const VerificationCommandSchema = z.object({
  purpose: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  expected_exit_code: z.number().int().nonnegative().optional()
});

export const ExecutionVerificationPlanSchema = z.object({
  commands: z.array(VerificationCommandSchema).min(1)
});

export const AttemptDoneRubricItemSchema = z.object({
  code: z.string().min(1),
  description: z.string().min(1)
});

export const AttemptFailureModeSchema = z.object({
  code: z.string().min(1),
  description: z.string().min(1)
});

export const AttemptContractDraftSchema = z.object({
  attempt_type: AttemptTypeSchema,
  objective: z.string().min(1).optional(),
  success_criteria: z.array(z.string().min(1)).min(1).optional(),
  required_evidence: z.array(z.string().min(1)).min(1),
  adversarial_verification_required: z.boolean().optional(),
  verifier_kit: ExecutionVerifierKitSchema.nullable().default(null),
  done_rubric: z.array(AttemptDoneRubricItemSchema).default([]),
  failure_modes: z.array(AttemptFailureModeSchema).default([]),
  forbidden_shortcuts: z.array(z.string().min(1)).default([]),
  expected_artifacts: z.array(z.string().min(1)).default([]),
  verification_plan: ExecutionVerificationPlanSchema.optional()
});

export const AttemptContractSchema = z.object({
  attempt_id: z.string(),
  run_id: z.string(),
  attempt_type: AttemptTypeSchema,
  objective: z.string().min(1),
  success_criteria: z.array(z.string().min(1)).min(1),
  required_evidence: z.array(z.string().min(1)).min(1),
  adversarial_verification_required: z.boolean().default(false),
  verifier_kit: ExecutionVerifierKitSchema.nullable().default(null),
  done_rubric: z.array(AttemptDoneRubricItemSchema).default([]),
  failure_modes: z.array(AttemptFailureModeSchema).default([]),
  forbidden_shortcuts: z.array(z.string().min(1)).default([]),
  expected_artifacts: z.array(z.string().min(1)).default([]),
  verification_plan: ExecutionVerificationPlanSchema.optional(),
  created_at: z.string().datetime()
});

export const AttemptCheckpointPreflightSchema = z.object({
  status: z.enum(["ready", "not_git_repo"]),
  repo_root: z.string().nullable(),
  head_before: z.string().nullable(),
  status_before: z.array(z.string().min(1)).default([]),
  created_at: z.string().datetime()
});

export const ExecutionVerificationToolchainAssessmentSchema = z.object({
  verifier_kit: ExecutionVerifierKitSchema.nullable().default(null),
  command_policy: ExecutionVerifierKitCommandPolicySchema.nullable().default(null),
  has_package_json: z.boolean(),
  has_local_node_modules: z.boolean(),
  inferred_pnpm_commands: z.array(z.string().min(1)).default([]),
  blocked_pnpm_commands: z.array(z.string().min(1)).default([]),
  unrunnable_verification_commands: z
    .array(
      z.object({
        purpose: z.string().min(1),
        command: z.string().min(1),
        cwd: z.string().min(1).nullable().default(null),
        reason: z.string().min(1)
      })
    )
    .default([])
});

export const AttemptContractPreflightSummarySchema = z.object({
  has_required_evidence: z.boolean(),
  requires_adversarial_verification: z.boolean().default(false),
  verifier_kit: ExecutionVerifierKitSchema.nullable().default(null),
  has_done_rubric: z.boolean(),
  has_failure_modes: z.boolean(),
  has_verification_plan: z.boolean(),
  done_rubric_codes: z.array(z.string().min(1)).default([]),
  failure_mode_codes: z.array(z.string().min(1)).default([]),
  verification_commands: z.array(z.string().min(1)).default([])
});

export const AttemptPreflightCheckStatusSchema = z.enum([
  "passed",
  "failed",
  "not_applicable"
]);

export const AttemptPreflightCheckSchema = z.object({
  code: z.string().min(1),
  status: AttemptPreflightCheckStatusSchema,
  message: z.string().min(1)
});

export const AttemptPreflightFailureCodeSchema = z.enum([
  "missing_attempt_contract",
  "slot_binding_mismatch",
  "missing_adversarial_verification_requirement",
  "adversarial_gate_profile_mismatch",
  "missing_done_rubric",
  "missing_failure_modes",
  "missing_contract_verification_plan",
  "blocked_pnpm_verification_plan",
  "workspace_not_git_repo",
  "verification_command_not_runnable"
]);

export const AttemptPreflightEvaluationSchema = z.object({
  run_id: z.string(),
  attempt_id: z.string(),
  attempt_type: AttemptTypeSchema,
  status: z.enum(["passed", "failed", "not_applicable"]),
  failure_class: RunFailureClassSchema.nullable().default(null),
  failure_policy_mode: RunFailurePolicyModeSchema.nullable().default(null),
  failure_code: AttemptPreflightFailureCodeSchema.nullable().default(null),
  failure_reason: z.string().min(1).nullable().default(null),
  contract: AttemptContractPreflightSummarySchema.nullable().default(null),
  toolchain_assessment: ExecutionVerificationToolchainAssessmentSchema.nullable().default(null),
  checkpoint_preflight: AttemptCheckpointPreflightSchema.nullable().default(null),
  checks: z.array(AttemptPreflightCheckSchema).default([]),
  created_at: z.string().datetime()
});

export const RuntimeVerificationFailureCodeSchema = z.enum([
  "missing_attempt_contract",
  "missing_contract_verification_plan",
  "missing_verification_plan",
  "invalid_verification_plan",
  "workspace_not_git_repo",
  "missing_preflight_baseline",
  "no_git_changes",
  "missing_verifier_kit_evidence",
  "verification_command_failed"
]);

export const VerificationCommandResultSchema = z.object({
  purpose: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1),
  expected_exit_code: z.number().int(),
  exit_code: z.number().int(),
  passed: z.boolean(),
  stdout_file: z.string().min(1),
  stderr_file: z.string().min(1)
});

export const SyncedSelfBootstrapArtifactsSchema = z.object({
  publication_artifact: z.string().min(1),
  source_asset_snapshot: z.string().min(1),
  published_active_entry: z.string().min(1)
});

export const AttemptRuntimeVerificationSchema = z.object({
  attempt_id: z.string(),
  run_id: z.string(),
  attempt_type: AttemptTypeSchema,
  status: z.enum(["passed", "failed", "not_applicable"]),
  verifier_kit: ExecutionVerifierKitSchema.nullable().default(null),
  failure_class: RunFailureClassSchema.nullable().default(null),
  failure_policy_mode: RunFailurePolicyModeSchema.nullable().default(null),
  repo_root: z.string().nullable(),
  git_head: z.string().nullable(),
  git_status: z.array(z.string().min(1)).default([]),
  preexisting_git_status: z.array(z.string().min(1)).default([]),
  new_git_status: z.array(z.string().min(1)).default([]),
  changed_files: z.array(z.string().min(1)).default([]),
  failure_code: RuntimeVerificationFailureCodeSchema.nullable(),
  failure_reason: z.string().nullable(),
  checks: z.array(AttemptPreflightCheckSchema).default([]),
  command_results: z.array(VerificationCommandResultSchema).default([]),
  synced_self_bootstrap_artifacts:
    SyncedSelfBootstrapArtifactsSchema.nullable().default(null),
  created_at: z.string().datetime()
});

export const AttemptAdversarialVerificationVerdictSchema = z.enum([
  "pass",
  "fail",
  "partial"
]);

export const AttemptAdversarialVerificationFailureCodeSchema = z.enum([
  "missing_requirement",
  "gate_profile_mismatch",
  "slot_binding_mismatch",
  "missing_artifact",
  "invalid_artifact",
  "missing_checks",
  "missing_kit_focus",
  "missing_commands",
  "missing_outputs",
  "verdict_fail",
  "verdict_partial"
]);

export const AttemptAdversarialVerificationCheckSchema = z.object({
  code: z.string().min(1),
  status: AttemptPreflightCheckStatusSchema,
  message: z.string().min(1)
});

export const AttemptAdversarialVerificationCommandSchema = z.object({
  purpose: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1).nullable().default(null),
  exit_code: z.number().int(),
  status: z.enum(["passed", "failed"]),
  output_ref: z.string().min(1).nullable().default(null)
});

export const AttemptAdversarialVerificationSchema = z.object({
  attempt_id: z.string(),
  run_id: z.string(),
  attempt_type: AttemptTypeSchema,
  status: z.enum(["passed", "failed", "not_applicable"]),
  verifier_kit: ExecutionVerifierKitSchema.nullable().default(null),
  failure_class: RunFailureClassSchema.nullable().default(null),
  failure_policy_mode: RunFailurePolicyModeSchema.nullable().default(null),
  verdict: AttemptAdversarialVerificationVerdictSchema.nullable().default(null),
  summary: z.string().min(1).nullable().default(null),
  failure_code: AttemptAdversarialVerificationFailureCodeSchema.nullable().default(null),
  failure_reason: z.string().min(1).nullable().default(null),
  checks: z.array(AttemptAdversarialVerificationCheckSchema).default([]),
  commands: z.array(AttemptAdversarialVerificationCommandSchema).default([]),
  output_refs: z.array(z.string().min(1)).default([]),
  source_artifact_path: z.string().min(1).nullable().default(null),
  created_at: z.string().datetime()
});

export const RuntimeHealthHistoryContractDriftSchema = z.object({
  run_id: z.string(),
  attempt_id: z.string(),
  status: z.string().min(1),
  objective_match: z.boolean(),
  success_criteria_match: z.boolean(),
  review_packet_present: z.boolean(),
  review_packet_contract_matches_attempt: z.boolean(),
  meta_file: z.string().min(1),
  contract_file: z.string().min(1),
  review_packet_file: z.string().min(1)
});

export const RuntimeHealthSnapshotSchema = z.object({
  run_id: z.string(),
  workspace_root: z.string().min(1),
  evidence_root: z.string().min(1),
  verify_runtime: z.object({
    command: z.string().min(1),
    exit_code: z.number().int(),
    status: z.enum(["passed", "failed"]),
    summary: z.string().min(1)
  }),
  history_contract_drift: z.object({
    command: z.string().min(1),
    exit_code: z.number().int(),
    status: z.enum(["ok", "drift_detected"]),
    summary: z.string().min(1),
    scanned_run_count: z.number().int().nonnegative(),
    scanned_execution_attempt_count: z.number().int().nonnegative(),
    drift_count: z.number().int().nonnegative(),
    drifts: z.array(RuntimeHealthHistoryContractDriftSchema)
  }),
  created_at: z.string().datetime()
});

export const AttemptHeartbeatStatusSchema = z.enum(["active", "released"]);

export const AttemptHeartbeatSchema = z.object({
  attempt_id: z.string(),
  run_id: z.string(),
  owner_id: z.string().min(1),
  status: AttemptHeartbeatStatusSchema,
  started_at: z.string().datetime(),
  heartbeat_at: z.string().datetime(),
  released_at: z.string().datetime().nullable()
});

export const AttemptRuntimeStateSchema = z.object({
  attempt_id: z.string(),
  run_id: z.string(),
  running: z.boolean(),
  phase: z.string().min(1).nullable(),
  active_since: z.string().datetime().nullable(),
  last_event_at: z.string().datetime().nullable(),
  progress_text: z.string().nullable(),
  recent_activities: z.array(z.string().min(1)).default([]),
  completed_steps: z.array(z.string().min(1)).default([]),
  process_content: z.array(z.string().min(1)).default([]),
  final_output: z.string().nullable(),
  error: z.string().nullable(),
  session_id: z.string().nullable(),
  event_count: z.number().int().nonnegative().default(0),
  updated_at: z.string().datetime()
});

export const AttemptRuntimeEventSchema = z.object({
  id: z.string(),
  attempt_id: z.string(),
  run_id: z.string(),
  seq: z.number().int().nonnegative(),
  ts: z.string().datetime(),
  type: z.string().min(1),
  summary: z.string(),
  payload: z.unknown().nullable()
});

export const WorkerWritebackSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(WorkerFindingSchema).default([]),
  questions: z.array(z.string().min(1)).default([]),
  recommended_next_steps: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1),
  verification_plan: ExecutionVerificationPlanSchema.optional(),
  next_attempt_contract: AttemptContractDraftSchema.optional(),
  artifacts: z.array(WorkerArtifactSchema).default([])
});

export const ReviewPacketArtifactSchema = z.object({
  kind: z.string().min(1),
  path: z.string().min(1),
  exists: z.boolean(),
  size_bytes: z.number().int().nonnegative().nullable()
});

export const AttemptFailureContextSchema = z.object({
  message: z.string().min(1),
  journal_event_id: z.string().nullable(),
  journal_event_ts: z.string().datetime().nullable()
});

export const AttemptReviewInputRefSchema = z.object({
  kind: z.string().min(1),
  path: z.string().min(1)
});

export const AttemptReviewerIdentitySchema = z.object({
  reviewer_id: z.string().min(1),
  role: z.string().min(1),
  adapter: z.string().min(1),
  provider: z.string().min(1).nullable(),
  model: z.string().min(1).nullable()
});

export const AttemptReviewerJudgmentSchema = z.object({
  goal_progress: z.number().min(0).max(1),
  evidence_quality: z.number().min(0).max(1),
  verification_status: z.enum(["passed", "failed", "not_applicable"]),
  adversarial_verification_status: z
    .enum(["passed", "failed", "not_applicable"])
    .default("not_applicable"),
  recommendation: z.enum(["continue", "wait_human", "complete", "retry"]),
  suggested_attempt_type: AttemptTypeSchema.nullable(),
  rationale: z.string().min(1),
  missing_evidence: z.array(z.string().min(1)).default([])
});

export const AttemptReviewInputPacketSchema = z.object({
  run_id: z.string(),
  attempt_id: z.string(),
  attempt: AttemptSchema,
  attempt_contract: AttemptContractSchema.nullable(),
  current_decision_snapshot: CurrentDecisionSchema.nullable(),
  context: z.unknown().nullable(),
  journal: z.array(RunJournalEntrySchema).default([]),
  failure_context: AttemptFailureContextSchema.nullable(),
  result: WorkerWritebackSchema.nullable(),
  runtime_verification: AttemptRuntimeVerificationSchema.nullable(),
  adversarial_verification: AttemptAdversarialVerificationSchema.nullable().default(null),
  artifact_manifest: z.array(ReviewPacketArtifactSchema).default([]),
  generated_at: z.string().datetime()
});

export const AttemptReviewerOpinionSchema = z.object({
  opinion_id: z.string(),
  run_id: z.string(),
  attempt_id: z.string(),
  reviewer: AttemptReviewerIdentitySchema,
  review_input_packet_ref: z.string().min(1),
  input_refs: z.array(AttemptReviewInputRefSchema).default([]),
  raw_output: z.string(),
  structured_judgment: AttemptReviewerJudgmentSchema,
  proposed_next_contract: AttemptContractDraftSchema.nullable().default(null),
  created_at: z.string().datetime()
});

export const AttemptReviewPacketSchema = z.object({
  run_id: z.string(),
  attempt_id: z.string(),
  attempt: AttemptSchema,
  attempt_contract: AttemptContractSchema.nullable(),
  current_decision_snapshot: CurrentDecisionSchema.nullable(),
  context: z.unknown().nullable(),
  journal: z.array(RunJournalEntrySchema).default([]),
  failure_context: AttemptFailureContextSchema.nullable(),
  result: WorkerWritebackSchema.nullable(),
  evaluation: AttemptEvaluationSchema.nullable(),
  runtime_verification: AttemptRuntimeVerificationSchema.nullable(),
  adversarial_verification: AttemptAdversarialVerificationSchema.nullable().default(null),
  artifact_manifest: z.array(ReviewPacketArtifactSchema).default([]),
  review_input_packet_ref: z.string().min(1).nullable().default(null),
  review_opinion_refs: z.array(z.string().min(1)).default([]),
  synthesized_evaluation_ref: z.string().min(1).nullable().default(null),
  evaluation_synthesis_ref: z.string().min(1).nullable().default(null),
  generated_at: z.string().datetime()
});

export const AttemptHandoffBundleSourceRefsSchema = z.object({
  run_contract: z.string().min(1),
  attempt_meta: z.string().min(1),
  attempt_contract: z.string().min(1).nullable().default(null),
  preflight_evaluation: z.string().min(1).nullable().default(null),
  current_decision: z.string().min(1).nullable().default(null),
  review_packet: z.string().min(1).nullable().default(null),
  runtime_verification: z.string().min(1).nullable().default(null),
  adversarial_verification: z.string().min(1).nullable().default(null)
});

export const AttemptHandoffBundleSchema = z.object({
  version: z.literal(1),
  run_id: z.string(),
  attempt_id: z.string(),
  attempt: AttemptSchema,
  approved_attempt_contract: AttemptContractSchema.nullable(),
  current_decision_snapshot: CurrentDecisionSchema.nullable(),
  failure_context: AttemptFailureContextSchema.nullable(),
  runtime_verification: AttemptRuntimeVerificationSchema.nullable(),
  adversarial_verification: AttemptAdversarialVerificationSchema.nullable().default(null),
  failure_signal: RunFailureSignalSchema.nullable().default(null),
  failure_class: RunFailureClassSchema.nullable().default(null),
  failure_policy_mode: RunFailurePolicyModeSchema.nullable().default(null),
  failure_code: z.string().min(1).nullable().default(null),
  adversarial_failure_code:
    AttemptAdversarialVerificationFailureCodeSchema.nullable().default(null),
  recommended_next_action: z.string().min(1).nullable().default(null),
  recommended_attempt_type: AttemptTypeSchema.nullable().default(null),
  summary: z.string().min(1).nullable().default(null),
  source_refs: AttemptHandoffBundleSourceRefsSchema,
  generated_at: z.string().datetime()
});

export const AttemptEvaluatorCalibrationSourceKindSchema = z.enum([
  "preflight_evaluation",
  "review_packet",
  "runtime_verification",
  "adversarial_verification",
  "handoff_bundle"
]);

export const AttemptEvaluatorCalibrationBundleSchema = z.object({
  bundle_ref: z.string().min(1),
  reviewer_prompt_version: z.string().min(1),
  verifier_prompt_version: z.string().min(1),
  dataset_version: z.string().min(1)
});

export const AttemptEvaluatorCalibrationSourceRefsSchema = z.object({
  preflight_evaluation: z.string().min(1).nullable().default(null),
  review_packet: z.string().min(1).nullable().default(null),
  runtime_verification: z.string().min(1).nullable().default(null),
  adversarial_verification: z.string().min(1).nullable().default(null),
  handoff_bundle: z.string().min(1).nullable().default(null)
});

export const AttemptEvaluatorCalibrationFailureModeSchema = z.object({
  id: z.string().min(1),
  source_kind: AttemptEvaluatorCalibrationSourceKindSchema,
  source_ref: z.string().min(1).nullable().default(null),
  observed_failure_code: z.string().min(1).nullable().default(null),
  summary: z.string().min(1)
});

export const AttemptEvaluatorCalibrationSampleSchema = z.object({
  version: z.literal(1),
  sample_id: z.string().min(1),
  run_id: z.string(),
  attempt_id: z.string(),
  attempt_type: AttemptTypeSchema,
  attempt_status: AttemptStatusSchema,
  verifier_kit: ExecutionVerifierKitSchema.nullable().default(null),
  failure_class: RunFailureClassSchema.nullable().default(null),
  failure_policy_mode: RunFailurePolicyModeSchema.nullable().default(null),
  failure_code: z.string().min(1).nullable().default(null),
  adversarial_failure_code:
    AttemptAdversarialVerificationFailureCodeSchema.nullable().default(null),
  recommended_next_action: z.string().min(1).nullable().default(null),
  summary: z.string().min(1),
  derived_failure_modes: z.array(AttemptEvaluatorCalibrationFailureModeSchema).default([]),
  source_refs: AttemptEvaluatorCalibrationSourceRefsSchema,
  calibration_bundle: AttemptEvaluatorCalibrationBundleSchema,
  created_at: z.string().datetime()
});

export const EvaluatorCalibrationCaseLabelSchema = z.enum([
  "online_failure",
  "false_positive",
  "false_negative"
]);

export const EvaluatorCalibrationCaseSchema = z.object({
  version: z.literal(1),
  case_id: z.string().min(1),
  label: EvaluatorCalibrationCaseLabelSchema,
  summary: z.string().min(1),
  sample: AttemptEvaluatorCalibrationSampleSchema,
  expected_failure_mode_ids: z.array(z.string().min(1)).default([]),
  notes: z.array(z.string().min(1)).default([])
});

export const EvaluatorCalibrationManifestEntrySchema = z.object({
  case_id: z.string().min(1),
  sample_id: z.string().min(1),
  label: EvaluatorCalibrationCaseLabelSchema,
  path: z.string().min(1),
  run_id: z.string(),
  attempt_id: z.string(),
  exported_at: z.string().datetime()
});

export const EvaluatorCalibrationManifestSchema = z.object({
  version: z.literal(1),
  bundle_ref: z.string().min(1),
  entries: z.array(EvaluatorCalibrationManifestEntrySchema).default([]),
  updated_at: z.string().datetime()
});

export const AttemptEvaluationSynthesisRecordSchema = z.object({
  run_id: z.string(),
  attempt_id: z.string(),
  synthesizer: AttemptSynthesizerIdentitySchema,
  review_input_packet_ref: z.string().min(1),
  opinion_refs: z.array(z.string().min(1)).default([]),
  deterministic_base_evaluation: AttemptEvaluationSchema,
  raw_output: z.string(),
  structured_judgment: AttemptReviewerJudgmentSchema,
  created_at: z.string().datetime()
});

export const ContextSnapshotSchema = z.object({
  id: z.string(),
  goal_id: z.string(),
  branch_id: z.string(),
  workspace_root: z.string(),
  goal: z.object({
    title: z.string(),
    description: z.string(),
    success_criteria: z.array(z.string()),
    constraints: z.array(z.string())
  }),
  branch: z.object({
    hypothesis: z.string(),
    objective: z.string(),
    success_criteria: z.array(z.string())
  }),
  steer: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      scope: SteerScopeSchema
    })
  ),
  shared_context: z.object({
    shared_facts: z.array(z.string()),
    open_questions: z.array(z.string()),
    constraints: z.array(z.string())
  }),
  created_at: z.string().datetime()
});

export const EvalResultSchema = z.object({
  goal_id: z.string(),
  branch_id: z.string(),
  score: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  dimension_scores: z.record(z.number().min(0).max(1)),
  recommendation: z.enum(["keep", "discard", "rerun", "request_human_review"]),
  rationale: z.string().min(1),
  created_at: z.string().datetime()
});

export const ContextBoardSchema = z.object({
  shared_facts: z.array(z.string()),
  open_questions: z.array(z.string()),
  constraints: z.array(z.string()),
  branch_notes: z.record(z.string())
});

export type GoalStatus = z.infer<typeof GoalStatusSchema>;
export type BranchStatus = z.infer<typeof BranchStatusSchema>;
export type WorkerRunState = z.infer<typeof WorkerRunStateSchema>;
export type Goal = z.infer<typeof GoalSchema>;
export type CreateGoalInput = z.infer<typeof CreateGoalInputSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type AttemptType = z.infer<typeof AttemptTypeSchema>;
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;
export type Run = z.infer<typeof RunSchema>;
export type CreateRunInput = z.infer<typeof CreateRunInputSchema>;
export type AttachedProjectType = z.infer<typeof AttachedProjectTypeSchema>;
export type AttachedProjectPrimaryLanguage = z.infer<
  typeof AttachedProjectPrimaryLanguageSchema
>;
export type AttachedProjectDefaultCommands = z.infer<
  typeof AttachedProjectDefaultCommandsSchema
>;
export type AttachedProjectProfile = z.infer<typeof AttachedProjectProfileSchema>;
export type AttachedProjectWorkspaceScope = z.infer<
  typeof AttachedProjectWorkspaceScopeSchema
>;
export type AttachedProjectGitBaseline = z.infer<
  typeof AttachedProjectGitBaselineSchema
>;
export type AttachedProjectToolchainSnapshot = z.infer<
  typeof AttachedProjectToolchainSnapshotSchema
>;
export type AttachedProjectRepoHealth = z.infer<
  typeof AttachedProjectRepoHealthSchema
>;
export type AttachedProjectBaselineSnapshot = z.infer<
  typeof AttachedProjectBaselineSnapshotSchema
>;
export type AttachProjectInput = z.infer<typeof AttachProjectInputSchema>;
export type Branch = z.infer<typeof BranchSchema>;
export type WorkerRun = z.infer<typeof WorkerRunSchema>;
export type Attempt = z.infer<typeof AttemptSchema>;
export type CurrentDecision = z.infer<typeof CurrentDecisionSchema>;
export type RunAutomationMode = z.infer<typeof RunAutomationModeSchema>;
export type RunAutomationReasonCode = z.infer<typeof RunAutomationReasonCodeSchema>;
export type RunAutomationControl = z.infer<typeof RunAutomationControlSchema>;
export type RunPolicyStage = z.infer<typeof RunPolicyStageSchema>;
export type RunPolicyApprovalStatus = z.infer<typeof RunPolicyApprovalStatusSchema>;
export type RunPolicyPermissionProfile = z.infer<
  typeof RunPolicyPermissionProfileSchema
>;
export type RunPolicyHookPolicy = z.infer<typeof RunPolicyHookPolicySchema>;
export type RunPolicyDangerMode = z.infer<typeof RunPolicyDangerModeSchema>;
export type RunPolicyRuntime = z.infer<typeof RunPolicyRuntimeSchema>;
export type RunMailboxMessageType = z.infer<typeof RunMailboxMessageTypeSchema>;
export type RunMailboxMessageStatus = z.infer<typeof RunMailboxMessageStatusSchema>;
export type RunMailboxEntry = z.infer<typeof RunMailboxEntrySchema>;
export type RunMailbox = z.infer<typeof RunMailboxSchema>;
export type RunWorkingContextTaskRef = z.infer<typeof RunWorkingContextTaskRefSchema>;
export type RunWorkingContextEvidenceRef = z.infer<
  typeof RunWorkingContextEvidenceRefSchema
>;
export type RunWorkingContextBlocker = z.infer<
  typeof RunWorkingContextBlockerSchema
>;
export type RunWorkingContextDegradedReasonCode = z.infer<
  typeof RunWorkingContextDegradedReasonCodeSchema
>;
export type RunWorkingContextDegradedState = z.infer<
  typeof RunWorkingContextDegradedStateSchema
>;
export type RunWorkingContextAutomation = z.infer<
  typeof RunWorkingContextAutomationSchema
>;
export type RunWorkingContextSourceSnapshotEntry = z.infer<
  typeof RunWorkingContextSourceSnapshotEntrySchema
>;
export type RunWorkingContextSourceSnapshotAttemptEntry = z.infer<
  typeof RunWorkingContextSourceSnapshotAttemptEntrySchema
>;
export type RunWorkingContextSourceSnapshotSteerEntry = z.infer<
  typeof RunWorkingContextSourceSnapshotSteerEntrySchema
>;
export type RunWorkingContextSourceSnapshot = z.infer<
  typeof RunWorkingContextSourceSnapshotSchema
>;
export type RunWorkingContext = z.infer<typeof RunWorkingContextSchema>;
export type RunHealthStatus = z.infer<typeof RunHealthStatusSchema>;
export type RunHealthAssessment = z.infer<typeof RunHealthAssessmentSchema>;
export type RunFailureClass = z.infer<typeof RunFailureClassSchema>;
export type RunFailurePolicyMode = z.infer<typeof RunFailurePolicyModeSchema>;
export type RunFailureSourceKind = z.infer<typeof RunFailureSourceKindSchema>;
export type RunFailureSignal = z.infer<typeof RunFailureSignalSchema>;
export type RunBriefEvidenceRef = z.infer<typeof RunBriefEvidenceRefSchema>;
export type RunBrief = z.infer<typeof RunBriefSchema>;
export type RunSurfacePlane = z.infer<typeof RunSurfacePlaneSchema>;
export type RunMaintenanceOutputStatus = z.infer<typeof RunMaintenanceOutputStatusSchema>;
export type RunMaintenanceSource = z.infer<typeof RunMaintenanceSourceSchema>;
export type RunMaintenanceOutput = z.infer<typeof RunMaintenanceOutputSchema>;
export type RunBlockedDiagnosisStatus = z.infer<typeof RunBlockedDiagnosisStatusSchema>;
export type RunBlockedDiagnosis = z.infer<typeof RunBlockedDiagnosisSchema>;
export type RunMaintenancePlane = z.infer<typeof RunMaintenancePlaneSchema>;
export type RunGovernanceStatus = z.infer<typeof RunGovernanceStatusSchema>;
export type RunGovernanceExcludedPlan = z.infer<typeof RunGovernanceExcludedPlanSchema>;
export type RunGovernanceContextSummary = z.infer<typeof RunGovernanceContextSummarySchema>;
export type RunGovernanceState = z.infer<typeof RunGovernanceStateSchema>;
export type AttemptEvaluation = z.infer<typeof AttemptEvaluationSchema>;
export type RunSteer = z.infer<typeof RunSteerSchema>;
export type RunJournalEntry = z.infer<typeof RunJournalEntrySchema>;
export type Steer = z.infer<typeof SteerSchema>;
export type Event = z.infer<typeof EventSchema>;
export type BranchSpec = z.infer<typeof BranchSpecSchema>;
export type EvalSpec = z.infer<typeof EvalSpecSchema>;
export type VerificationCommand = z.infer<typeof VerificationCommandSchema>;
export type ExecutionVerificationPlan = z.infer<typeof ExecutionVerificationPlanSchema>;
export type WorkerEffortLevel = z.infer<typeof WorkerEffortLevelSchema>;
export type ExecutionVerifierKit = z.infer<typeof ExecutionVerifierKitSchema>;
export type ExecutionVerifierKitCommandPolicy = z.infer<
  typeof ExecutionVerifierKitCommandPolicySchema
>;
export type RunHarnessGate = z.infer<typeof RunHarnessGateSchema>;
export type RunHarnessGateMode = z.infer<typeof RunHarnessGateModeSchema>;
export type RunHarnessSlot = z.infer<typeof RunHarnessSlotSchema>;
export type CanonicalRunHarnessSlotBinding = z.infer<
  typeof CanonicalRunHarnessSlotBindingSchema
>;
export type RunHarnessSlotBinding = z.infer<typeof RunHarnessSlotBindingSchema>;
export type RunHarnessEffortPreference = z.infer<
  typeof RunHarnessEffortPreferenceSchema
>;
export type RunHarnessExecutionPreference = z.infer<
  typeof RunHarnessExecutionPreferenceSchema
>;
export type RunHarnessRequiredGateConfig = z.infer<
  typeof RunHarnessRequiredGateConfigSchema
>;
export type RunHarnessPostflightAdversarialGateConfig = z.infer<
  typeof RunHarnessPostflightAdversarialGateConfigSchema
>;
export type RunHarnessSlotConfig = z.infer<typeof RunHarnessSlotConfigSchema>;
export type RunHarnessGates = z.infer<typeof RunHarnessGatesSchema>;
export type RunHarnessSlots = z.infer<typeof RunHarnessSlotsSchema>;
export type RunHarnessProfile = z.infer<typeof RunHarnessProfileSchema>;
export type AttemptDoneRubricItem = z.infer<typeof AttemptDoneRubricItemSchema>;
export type AttemptFailureMode = z.infer<typeof AttemptFailureModeSchema>;
export type AttemptContractDraft = z.infer<typeof AttemptContractDraftSchema>;
export type AttemptContract = z.infer<typeof AttemptContractSchema>;
export type AttemptCheckpointPreflight = z.infer<typeof AttemptCheckpointPreflightSchema>;
export type ExecutionVerificationToolchainAssessment = z.infer<
  typeof ExecutionVerificationToolchainAssessmentSchema
>;
export type AttemptContractPreflightSummary = z.infer<
  typeof AttemptContractPreflightSummarySchema
>;
export type AttemptPreflightCheckStatus = z.infer<typeof AttemptPreflightCheckStatusSchema>;
export type AttemptPreflightCheck = z.infer<typeof AttemptPreflightCheckSchema>;
export type AttemptPreflightFailureCode = z.infer<
  typeof AttemptPreflightFailureCodeSchema
>;
export type AttemptPreflightEvaluation = z.infer<typeof AttemptPreflightEvaluationSchema>;
export type RuntimeVerificationFailureCode = z.infer<
  typeof RuntimeVerificationFailureCodeSchema
>;
export type VerificationCommandResult = z.infer<typeof VerificationCommandResultSchema>;
export type AttemptRuntimeVerification = z.infer<typeof AttemptRuntimeVerificationSchema>;
export type AttemptAdversarialVerificationVerdict = z.infer<
  typeof AttemptAdversarialVerificationVerdictSchema
>;
export type AttemptAdversarialVerificationFailureCode = z.infer<
  typeof AttemptAdversarialVerificationFailureCodeSchema
>;
export type AttemptAdversarialVerificationCheck = z.infer<
  typeof AttemptAdversarialVerificationCheckSchema
>;
export type AttemptAdversarialVerificationCommand = z.infer<
  typeof AttemptAdversarialVerificationCommandSchema
>;
export type AttemptAdversarialVerification = z.infer<
  typeof AttemptAdversarialVerificationSchema
>;
export type RuntimeHealthHistoryContractDrift = z.infer<
  typeof RuntimeHealthHistoryContractDriftSchema
>;
export type RuntimeHealthSnapshot = z.infer<typeof RuntimeHealthSnapshotSchema>;
export type AttemptHeartbeatStatus = z.infer<typeof AttemptHeartbeatStatusSchema>;
export type AttemptHeartbeat = z.infer<typeof AttemptHeartbeatSchema>;
export type AttemptRuntimeState = z.infer<typeof AttemptRuntimeStateSchema>;
export type AttemptRuntimeEvent = z.infer<typeof AttemptRuntimeEventSchema>;
export type WorkerWriteback = z.infer<typeof WorkerWritebackSchema>;
export type WorkerArtifact = z.infer<typeof WorkerArtifactSchema>;
export type ReviewPacketArtifact = z.infer<typeof ReviewPacketArtifactSchema>;
export type AttemptFailureContext = z.infer<typeof AttemptFailureContextSchema>;
export type AttemptReviewInputRef = z.infer<typeof AttemptReviewInputRefSchema>;
export type AttemptReviewerIdentity = z.infer<typeof AttemptReviewerIdentitySchema>;
export type AttemptSynthesizerIdentity = z.infer<typeof AttemptSynthesizerIdentitySchema>;
export type AttemptReviewerJudgment = z.infer<typeof AttemptReviewerJudgmentSchema>;
export type AttemptReviewInputPacket = z.infer<typeof AttemptReviewInputPacketSchema>;
export type AttemptReviewerOpinion = z.infer<typeof AttemptReviewerOpinionSchema>;
export type AttemptReviewPacket = z.infer<typeof AttemptReviewPacketSchema>;
export type AttemptHandoffBundleSourceRefs = z.infer<
  typeof AttemptHandoffBundleSourceRefsSchema
>;
export type AttemptHandoffBundle = z.infer<typeof AttemptHandoffBundleSchema>;
export type AttemptEvaluatorCalibrationSourceKind = z.infer<
  typeof AttemptEvaluatorCalibrationSourceKindSchema
>;
export type AttemptEvaluatorCalibrationBundle = z.infer<
  typeof AttemptEvaluatorCalibrationBundleSchema
>;
export type AttemptEvaluatorCalibrationSourceRefs = z.infer<
  typeof AttemptEvaluatorCalibrationSourceRefsSchema
>;
export type AttemptEvaluatorCalibrationFailureMode = z.infer<
  typeof AttemptEvaluatorCalibrationFailureModeSchema
>;
export type AttemptEvaluatorCalibrationSample = z.infer<
  typeof AttemptEvaluatorCalibrationSampleSchema
>;
export type EvaluatorCalibrationCaseLabel = z.infer<
  typeof EvaluatorCalibrationCaseLabelSchema
>;
export type EvaluatorCalibrationCase = z.infer<typeof EvaluatorCalibrationCaseSchema>;
export type EvaluatorCalibrationManifestEntry = z.infer<
  typeof EvaluatorCalibrationManifestEntrySchema
>;
export type EvaluatorCalibrationManifest = z.infer<
  typeof EvaluatorCalibrationManifestSchema
>;
export type AttemptEvaluationSynthesisRecord = z.infer<
  typeof AttemptEvaluationSynthesisRecordSchema
>;
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;
export type EvalResult = z.infer<typeof EvalResultSchema>;
export type ContextBoard = z.infer<typeof ContextBoardSchema>;

export function createEntityId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function buildDefaultExecutionDoneRubric(): AttemptDoneRubricItem[] {
  return [
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
}

function buildDefaultExecutionFailureModes(): AttemptFailureMode[] {
  return [
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
      description: "Do not dispatch execution when the workspace is not a git repository and no baseline can be captured."
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
}

export function createGoal(input: CreateGoalInput): Goal {
  const budget = input.budget ?? {
    tokens: 2_000_000,
    time_minutes: 180,
    max_concurrency: 3
  };
  const now = new Date().toISOString();

  return GoalSchema.parse({
    ...input,
    id: createEntityId("goal"),
    status: "draft",
    workspace_root: input.workspace_root ?? process.cwd(),
    budget,
    created_at: now,
    updated_at: now
  });
}

export function updateGoal(goal: Goal, patch: Partial<Goal>): Goal {
  return GoalSchema.parse({
    ...goal,
    ...patch,
    updated_at: new Date().toISOString()
  });
}

export function createRun(input: CreateRunInput): Run {
  const budget = input.budget ?? {
    tokens: 2_000_000,
    time_minutes: 180,
    max_concurrency: 3
  };
  const now = new Date().toISOString();

  return RunSchema.parse({
    ...input,
    id: createEntityId("run"),
    workspace_root: input.workspace_root ?? process.cwd(),
    managed_workspace_root: null,
    budget,
    created_at: now,
    updated_at: now
  });
}

export function createAttachedProjectProfile(input: {
  id: string;
  slug: string;
  title: string;
  workspace_root: string;
  repo_root: string;
  repo_name: string;
  project_type: AttachedProjectType;
  primary_language: AttachedProjectPrimaryLanguage;
  package_manager?: string | null;
  manifest_files?: string[];
  detection_reasons?: string[];
  default_commands?: Partial<AttachedProjectDefaultCommands>;
  supported?: boolean;
  unsupported_reason?: string | null;
  created_at?: string;
}): AttachedProjectProfile {
  const now = new Date().toISOString();
  return AttachedProjectProfileSchema.parse({
    ...input,
    package_manager: input.package_manager ?? null,
    manifest_files: input.manifest_files ?? [],
    detection_reasons: input.detection_reasons ?? [],
    default_commands:
      input.default_commands ?? DEFAULT_ATTACHED_PROJECT_COMMANDS,
    supported: input.supported ?? true,
    unsupported_reason: input.unsupported_reason ?? null,
    created_at: input.created_at ?? now,
    updated_at: now
  });
}

export function createAttachedProjectBaselineSnapshot(input: {
  project_id: string;
  workspace_root: string;
  workspace_scope: AttachedProjectWorkspaceScope;
  git: AttachedProjectGitBaseline;
  toolchain: Partial<AttachedProjectToolchainSnapshot>;
  repo_health: Partial<AttachedProjectRepoHealth>;
}): AttachedProjectBaselineSnapshot {
  return AttachedProjectBaselineSnapshotSchema.parse({
    ...input,
    captured_at: new Date().toISOString(),
    toolchain: input.toolchain,
    repo_health: input.repo_health
  });
}

export function createDefaultRunHarnessProfile(): RunHarnessProfile {
  return RunHarnessProfileSchema.parse(DEFAULT_RUN_HARNESS_PROFILE);
}

export function resolveRunHarnessProfile(
  input?:
    | {
        harness_profile?: RunHarnessProfile | null;
      }
    | null
): RunHarnessProfile {
  return RunHarnessProfileSchema.parse(input?.harness_profile ?? undefined);
}

export function canonicalizeRunHarnessSlotBinding(
  binding: RunHarnessSlotBinding
): CanonicalRunHarnessSlotBinding {
  return RUN_HARNESS_SLOT_BINDING_CANONICAL_MAP[binding];
}

export function updateRun(run: Run, patch: Partial<Run>): Run {
  return RunSchema.parse({
    ...run,
    ...patch,
    updated_at: new Date().toISOString()
  });
}

export function createBranch(
  goalId: string,
  spec: BranchSpec,
  contextSnapshotId: string
): Branch {
  const now = new Date().toISOString();

  return BranchSchema.parse({
    id: spec.id,
    goal_id: goalId,
    parent_branch_id: null,
    hypothesis: spec.hypothesis,
    objective: spec.objective,
    success_criteria: spec.success_criteria,
    assigned_worker: spec.assigned_worker,
    status: "created",
    score: null,
    confidence: null,
    context_snapshot_id: contextSnapshotId,
    latest_run_id: null,
    created_at: now,
    updated_at: now
  });
}

export function updateBranch(branch: Branch, patch: Partial<Branch>): Branch {
  return BranchSchema.parse({
    ...branch,
    ...patch,
    updated_at: new Date().toISOString()
  });
}

export function createWorkerRun(
  goalId: string,
  branchId: string,
  adapterType: string,
  promptSpec: Record<string, unknown>,
  artifactDir: string
): WorkerRun {
  return WorkerRunSchema.parse({
    id: createEntityId("run"),
    goal_id: goalId,
    branch_id: branchId,
    adapter_type: adapterType,
    prompt_spec: promptSpec,
    state: "running",
    started_at: new Date().toISOString(),
    ended_at: null,
    token_usage: {
      input: 0,
      output: 0,
      total: 0
    },
    artifact_dir: artifactDir,
    writeback_file: null
  });
}

export function createAttempt(input: {
  run_id: string;
  attempt_type: AttemptType;
  worker: string;
  objective: string;
  success_criteria: string[];
  workspace_root: string;
  input_context_ref?: string | null;
}): Attempt {
  const now = new Date().toISOString();

  return AttemptSchema.parse({
    id: createEntityId("att"),
    run_id: input.run_id,
    attempt_type: input.attempt_type,
    status: "created",
    worker: input.worker,
    objective: input.objective,
    success_criteria: input.success_criteria,
    workspace_root: input.workspace_root,
    input_context_ref: input.input_context_ref ?? null,
    result_ref: null,
    evaluation_ref: null,
    created_at: now,
    started_at: null,
    ended_at: null,
    updated_at: now
  });
}

export function createAttemptContract(input: {
  attempt_id: string;
  run_id: string;
  attempt_type: AttemptType;
  objective: string;
  success_criteria: string[];
  required_evidence: string[];
  adversarial_verification_required?: boolean;
  verifier_kit?: ExecutionVerifierKit | null;
  done_rubric?: AttemptDoneRubricItem[];
  failure_modes?: AttemptFailureMode[];
  forbidden_shortcuts?: string[];
  expected_artifacts?: string[];
  verification_plan?: ExecutionVerificationPlan;
}): AttemptContract {
  const defaultDoneRubric =
    input.attempt_type === "execution" ? buildDefaultExecutionDoneRubric() : [];
  const defaultFailureModes =
    input.attempt_type === "execution" ? buildDefaultExecutionFailureModes() : [];

  return AttemptContractSchema.parse({
    attempt_id: input.attempt_id,
    run_id: input.run_id,
    attempt_type: input.attempt_type,
    objective: input.objective,
    success_criteria: input.success_criteria,
    required_evidence: input.required_evidence,
    adversarial_verification_required:
      input.adversarial_verification_required ?? input.attempt_type === "execution",
    verifier_kit:
      input.attempt_type === "execution"
        ? input.verifier_kit ?? DEFAULT_EXECUTION_VERIFIER_KIT
        : null,
    done_rubric: input.done_rubric ?? defaultDoneRubric,
    failure_modes: input.failure_modes ?? defaultFailureModes,
    forbidden_shortcuts: input.forbidden_shortcuts ?? [],
    expected_artifacts: input.expected_artifacts ?? [],
    verification_plan: input.verification_plan,
    created_at: new Date().toISOString()
  });
}

export function createAttemptPreflightEvaluation(input: {
  run_id: string;
  attempt_id: string;
  attempt_type: AttemptType;
  status: "passed" | "failed" | "not_applicable";
  failure_code?: AttemptPreflightFailureCode | null;
  failure_reason?: string | null;
  contract?: AttemptContractPreflightSummary | null;
  toolchain_assessment?: ExecutionVerificationToolchainAssessment | null;
  checkpoint_preflight?: AttemptCheckpointPreflight | null;
  checks?: AttemptPreflightCheck[];
}): AttemptPreflightEvaluation {
  const failureSignal =
    input.status === "failed"
      ? createRunFailureSignal({
          failure_class: "preflight_blocked",
          policy_mode: "fail_closed",
          source_kind: "preflight_evaluation",
          failure_code: input.failure_code ?? null,
          summary:
            input.failure_reason ??
            `Preflight blocked attempt ${input.attempt_id}.`
        })
      : null;
  return AttemptPreflightEvaluationSchema.parse({
    run_id: input.run_id,
    attempt_id: input.attempt_id,
    attempt_type: input.attempt_type,
    status: input.status,
    failure_class: failureSignal?.failure_class ?? null,
    failure_policy_mode: failureSignal?.policy_mode ?? null,
    failure_code: input.failure_code ?? null,
    failure_reason: input.failure_reason ?? null,
    contract: input.contract ?? null,
    toolchain_assessment: input.toolchain_assessment ?? null,
    checkpoint_preflight: input.checkpoint_preflight ?? null,
    checks: input.checks ?? [],
    created_at: new Date().toISOString()
  });
}

export function createAttemptAdversarialVerification(input: {
  run_id: string;
  attempt_id: string;
  attempt_type: AttemptType;
  status: "passed" | "failed" | "not_applicable";
  verifier_kit?: ExecutionVerifierKit | null;
  verdict?: AttemptAdversarialVerificationVerdict | null;
  summary?: string | null;
  failure_code?: AttemptAdversarialVerificationFailureCode | null;
  failure_reason?: string | null;
  checks?: AttemptAdversarialVerificationCheck[];
  commands?: AttemptAdversarialVerificationCommand[];
  output_refs?: string[];
  source_artifact_path?: string | null;
}): AttemptAdversarialVerification {
  const failureSignal =
    input.status === "failed"
      ? createRunFailureSignal({
          failure_class: "adversarial_verification_failed",
          policy_mode: "fail_closed",
          source_kind: "adversarial_verification",
          failure_code: input.failure_code ?? null,
          summary:
            input.failure_reason ??
            input.summary ??
            `Adversarial verification failed for attempt ${input.attempt_id}.`
        })
      : null;
  return AttemptAdversarialVerificationSchema.parse({
    run_id: input.run_id,
    attempt_id: input.attempt_id,
    attempt_type: input.attempt_type,
    status: input.status,
    verifier_kit:
      input.attempt_type === "execution"
        ? input.verifier_kit ?? DEFAULT_EXECUTION_VERIFIER_KIT
        : null,
    failure_class: failureSignal?.failure_class ?? null,
    failure_policy_mode: failureSignal?.policy_mode ?? null,
    verdict: input.verdict ?? null,
    summary: input.summary ?? null,
    failure_code: input.failure_code ?? null,
    failure_reason: input.failure_reason ?? null,
    checks: input.checks ?? [],
    commands: input.commands ?? [],
    output_refs: input.output_refs ?? [],
    source_artifact_path: input.source_artifact_path ?? null,
    created_at: new Date().toISOString()
  });
}

export function createRunMailbox(input: {
  run_id: string;
  entries?: RunMailboxEntry[];
}): RunMailbox {
  return RunMailboxSchema.parse({
    version: 1,
    run_id: input.run_id,
    entries: input.entries ?? [],
    updated_at: new Date().toISOString()
  });
}

export function createRunMailboxEntry(input: {
  run_id: string;
  thread_id: string;
  message_type: RunMailboxMessageType;
  from_slot?: RunHarnessSlot | null;
  to_slot_or_actor: string;
  status: RunMailboxMessageStatus;
  required_action?: string | null;
  summary: string;
  source_ref?: string | null;
  source_attempt_id?: string | null;
  created_at?: string;
  resolved_at?: string | null;
}): RunMailboxEntry {
  return RunMailboxEntrySchema.parse({
    id: createEntityId("mailbox"),
    run_id: input.run_id,
    thread_id: input.thread_id,
    message_type: input.message_type,
    from_slot: input.from_slot ?? null,
    to_slot_or_actor: input.to_slot_or_actor,
    status: input.status,
    required_action: input.required_action ?? null,
    summary: input.summary,
    source_ref: input.source_ref ?? null,
    source_attempt_id: input.source_attempt_id ?? null,
    created_at: input.created_at ?? new Date().toISOString(),
    resolved_at: input.resolved_at ?? null
  });
}

export function updateRunMailbox(mailbox: RunMailbox, patch: Partial<RunMailbox>): RunMailbox {
  return RunMailboxSchema.parse({
    ...mailbox,
    ...patch,
    updated_at: new Date().toISOString()
  });
}

export function updateRunMailboxEntry(
  entry: RunMailboxEntry,
  patch: Partial<RunMailboxEntry>
): RunMailboxEntry {
  return RunMailboxEntrySchema.parse({
    ...entry,
    ...patch
  });
}

export function createAttemptRuntimeState(input: {
  attempt_id: string;
  run_id: string;
  running?: boolean;
  phase?: string | null;
  active_since?: string | null;
  last_event_at?: string | null;
  progress_text?: string | null;
  recent_activities?: string[];
  completed_steps?: string[];
  process_content?: string[];
  final_output?: string | null;
  error?: string | null;
  session_id?: string | null;
  event_count?: number;
}): AttemptRuntimeState {
  return AttemptRuntimeStateSchema.parse({
    attempt_id: input.attempt_id,
    run_id: input.run_id,
    running: input.running ?? false,
    phase: input.phase ?? null,
    active_since: input.active_since ?? null,
    last_event_at: input.last_event_at ?? null,
    progress_text: input.progress_text ?? null,
    recent_activities: input.recent_activities ?? [],
    completed_steps: input.completed_steps ?? [],
    process_content: input.process_content ?? [],
    final_output: input.final_output ?? null,
    error: input.error ?? null,
    session_id: input.session_id ?? null,
    event_count: input.event_count ?? 0,
    updated_at: new Date().toISOString()
  });
}

export function updateAttemptRuntimeState(
  state: AttemptRuntimeState,
  patch: Partial<AttemptRuntimeState>
): AttemptRuntimeState {
  return AttemptRuntimeStateSchema.parse({
    ...state,
    ...patch,
    updated_at: new Date().toISOString()
  });
}

export function createAttemptRuntimeEvent(input: {
  attempt_id: string;
  run_id: string;
  seq: number;
  type: string;
  summary?: string;
  payload?: unknown;
  ts?: string;
}): AttemptRuntimeEvent {
  return AttemptRuntimeEventSchema.parse({
    id: createEntityId("arte"),
    attempt_id: input.attempt_id,
    run_id: input.run_id,
    seq: input.seq,
    ts: input.ts ?? new Date().toISOString(),
    type: input.type,
    summary: input.summary ?? "",
    payload: input.payload ?? null
  });
}

export function createAttemptHandoffBundle(input: {
  attempt: Attempt;
  approved_attempt_contract?: AttemptContract | null;
  preflight_evaluation?: AttemptPreflightEvaluation | null;
  current_decision_snapshot?: CurrentDecision | null;
  failure_context?: AttemptFailureContext | null;
  runtime_verification?: AttemptRuntimeVerification | null;
  adversarial_verification?: AttemptAdversarialVerification | null;
  failure_signal?: RunFailureSignal | null;
  source_refs: AttemptHandoffBundleSourceRefs;
}): AttemptHandoffBundle {
  const failureSignal =
    input.failure_signal ??
    (input.adversarial_verification?.failure_class
      ? createRunFailureSignal({
          failure_class: input.adversarial_verification.failure_class,
          policy_mode:
            input.adversarial_verification.failure_policy_mode ?? "fail_closed",
          source_kind: "adversarial_verification",
          source_ref: input.source_refs.adversarial_verification,
          failure_code: input.adversarial_verification.failure_code ?? null,
          summary:
            input.adversarial_verification.failure_reason ??
            input.adversarial_verification.summary ??
            `Adversarial verification failed for attempt ${input.attempt.id}.`
        })
      : null) ??
    (input.runtime_verification?.failure_class
      ? createRunFailureSignal({
          failure_class: input.runtime_verification.failure_class,
          policy_mode: input.runtime_verification.failure_policy_mode ?? "fail_closed",
          source_kind: "runtime_verification",
          source_ref: input.source_refs.runtime_verification,
          failure_code: input.runtime_verification.failure_code ?? null,
          summary:
            input.runtime_verification.failure_reason ??
            `Runtime verification failed for attempt ${input.attempt.id}.`
        })
      : null) ??
    (input.preflight_evaluation?.failure_class
      ? createRunFailureSignal({
          failure_class: input.preflight_evaluation.failure_class,
          policy_mode: input.preflight_evaluation.failure_policy_mode ?? "fail_closed",
          source_kind: "preflight_evaluation",
          source_ref: input.source_refs.preflight_evaluation,
          failure_code: input.preflight_evaluation.failure_code ?? null,
          summary:
            input.preflight_evaluation.failure_reason ??
            `Preflight blocked attempt ${input.attempt.id}.`
        })
      : null);
  return AttemptHandoffBundleSchema.parse({
    version: 1,
    run_id: input.attempt.run_id,
    attempt_id: input.attempt.id,
    attempt: input.attempt,
    approved_attempt_contract: input.approved_attempt_contract ?? null,
    current_decision_snapshot: input.current_decision_snapshot ?? null,
    failure_context: input.failure_context ?? null,
    runtime_verification: input.runtime_verification ?? null,
    adversarial_verification: input.adversarial_verification ?? null,
    failure_signal: failureSignal ?? null,
    failure_class: failureSignal?.failure_class ?? null,
    failure_policy_mode: failureSignal?.policy_mode ?? null,
    failure_code: failureSignal?.failure_code ?? null,
    adversarial_failure_code: input.adversarial_verification?.failure_code ?? null,
    recommended_next_action:
      input.current_decision_snapshot?.recommended_next_action ?? null,
    recommended_attempt_type:
      input.current_decision_snapshot?.recommended_attempt_type ?? null,
    summary:
      failureSignal?.summary ??
      input.failure_context?.message ??
      input.current_decision_snapshot?.summary ??
      input.preflight_evaluation?.failure_reason ??
      input.adversarial_verification?.failure_reason ??
      input.runtime_verification?.failure_reason ??
      null,
    source_refs: input.source_refs,
    generated_at: new Date().toISOString()
  });
}

export function createAttemptEvaluatorCalibrationSample(input: {
  sample_id: string;
  run_id: string;
  attempt_id: string;
  attempt_type: AttemptType;
  attempt_status: AttemptStatus;
  verifier_kit?: ExecutionVerifierKit | null;
  failure_class?: RunFailureClass | null;
  failure_policy_mode?: RunFailurePolicyMode | null;
  failure_code?: string | null;
  adversarial_failure_code?: AttemptAdversarialVerificationFailureCode | null;
  recommended_next_action?: string | null;
  summary: string;
  derived_failure_modes?: AttemptEvaluatorCalibrationFailureMode[];
  source_refs?: Partial<AttemptEvaluatorCalibrationSourceRefs>;
  calibration_bundle: AttemptEvaluatorCalibrationBundle;
}): AttemptEvaluatorCalibrationSample {
  return AttemptEvaluatorCalibrationSampleSchema.parse({
    version: 1,
    sample_id: input.sample_id,
    run_id: input.run_id,
    attempt_id: input.attempt_id,
    attempt_type: input.attempt_type,
    attempt_status: input.attempt_status,
    verifier_kit: input.verifier_kit ?? null,
    failure_class: input.failure_class ?? null,
    failure_policy_mode: input.failure_policy_mode ?? null,
    failure_code: input.failure_code ?? null,
    adversarial_failure_code: input.adversarial_failure_code ?? null,
    recommended_next_action: input.recommended_next_action ?? null,
    summary: input.summary,
    derived_failure_modes: input.derived_failure_modes ?? [],
    source_refs: input.source_refs ?? {},
    calibration_bundle: input.calibration_bundle,
    created_at: new Date().toISOString()
  });
}

export function createEvaluatorCalibrationCase(input: {
  case_id: string;
  label: EvaluatorCalibrationCaseLabel;
  summary: string;
  sample: AttemptEvaluatorCalibrationSample;
  expected_failure_mode_ids?: string[];
  notes?: string[];
}): EvaluatorCalibrationCase {
  return EvaluatorCalibrationCaseSchema.parse({
    version: 1,
    case_id: input.case_id,
    label: input.label,
    summary: input.summary,
    sample: input.sample,
    expected_failure_mode_ids: input.expected_failure_mode_ids ?? [],
    notes: input.notes ?? []
  });
}

export function createEvaluatorCalibrationManifest(input: {
  bundle_ref: string;
  entries?: EvaluatorCalibrationManifestEntry[];
}): EvaluatorCalibrationManifest {
  return EvaluatorCalibrationManifestSchema.parse({
    version: 1,
    bundle_ref: input.bundle_ref,
    entries: input.entries ?? [],
    updated_at: new Date().toISOString()
  });
}

export function updateAttempt(attempt: Attempt, patch: Partial<Attempt>): Attempt {
  return AttemptSchema.parse({
    ...attempt,
    ...patch,
    updated_at: new Date().toISOString()
  });
}

export function createCurrentDecision(input: {
  run_id: string;
  run_status?: RunStatus;
  best_attempt_id?: string | null;
  latest_attempt_id?: string | null;
  recommended_next_action?: string | null;
  recommended_attempt_type?: AttemptType | null;
  summary?: string;
  blocking_reason?: string | null;
  waiting_for_human?: boolean;
}): CurrentDecision {
  return CurrentDecisionSchema.parse({
    run_id: input.run_id,
    run_status: input.run_status ?? "draft",
    best_attempt_id: input.best_attempt_id ?? null,
    latest_attempt_id: input.latest_attempt_id ?? null,
    recommended_next_action: input.recommended_next_action ?? null,
    recommended_attempt_type: input.recommended_attempt_type ?? null,
    summary: input.summary ?? "",
    blocking_reason: input.blocking_reason ?? null,
    waiting_for_human: input.waiting_for_human ?? false,
    updated_at: new Date().toISOString()
  });
}

export function createRunAutomationControl(input: {
  run_id: string;
  mode?: RunAutomationMode;
  reason_code?: RunAutomationReasonCode | null;
  reason?: string | null;
  imposed_by?: string | null;
  active_run_id?: string | null;
  failure_code?: string | null;
}): RunAutomationControl {
  return RunAutomationControlSchema.parse({
    run_id: input.run_id,
    mode: input.mode ?? "active",
    reason_code: input.reason_code ?? null,
    reason: input.reason ?? null,
    imposed_by: input.imposed_by ?? null,
    active_run_id: input.active_run_id ?? null,
    failure_code: input.failure_code ?? null,
    updated_at: new Date().toISOString()
  });
}

export function createRunWorkingContextDegradedState(input?: {
  is_degraded?: boolean;
  reason_code?: RunWorkingContextDegradedReasonCode | null;
  summary?: string | null;
}): RunWorkingContextDegradedState {
  return RunWorkingContextDegradedStateSchema.parse({
    is_degraded: input?.is_degraded ?? false,
    reason_code: input?.reason_code ?? null,
    summary: input?.summary ?? null
  });
}

export function createRunWorkingContextSourceSnapshot(input?: {
  current?: Partial<RunWorkingContextSourceSnapshotEntry>;
  automation?: Partial<RunWorkingContextSourceSnapshotEntry>;
  governance?: Partial<RunWorkingContextSourceSnapshotEntry>;
  latest_attempt?: Partial<RunWorkingContextSourceSnapshotAttemptEntry>;
  latest_steer?: Partial<RunWorkingContextSourceSnapshotSteerEntry>;
}): RunWorkingContextSourceSnapshot {
  return RunWorkingContextSourceSnapshotSchema.parse({
    current: {
      ref: input?.current?.ref ?? null,
      updated_at: input?.current?.updated_at ?? null
    },
    automation: {
      ref: input?.automation?.ref ?? null,
      updated_at: input?.automation?.updated_at ?? null
    },
    governance: {
      ref: input?.governance?.ref ?? null,
      updated_at: input?.governance?.updated_at ?? null
    },
    latest_attempt: {
      ref: input?.latest_attempt?.ref ?? null,
      updated_at: input?.latest_attempt?.updated_at ?? null,
      attempt_id: input?.latest_attempt?.attempt_id ?? null
    },
    latest_steer: {
      ref: input?.latest_steer?.ref ?? null,
      updated_at: input?.latest_steer?.updated_at ?? null,
      steer_id: input?.latest_steer?.steer_id ?? null
    }
  });
}

export function createRunWorkingContext(input: {
  run_id: string;
  plan_ref?: string | null;
  active_task_refs?: RunWorkingContextTaskRef[];
  recent_evidence_refs?: RunWorkingContextEvidenceRef[];
  current_focus?: string | null;
  current_blocker?: RunWorkingContextBlocker | null;
  next_operator_attention?: string | null;
  automation?: Partial<RunWorkingContextAutomation>;
  degraded?: Partial<RunWorkingContextDegradedState>;
  source_snapshot?: {
    current?: Partial<RunWorkingContextSourceSnapshotEntry>;
    automation?: Partial<RunWorkingContextSourceSnapshotEntry>;
    governance?: Partial<RunWorkingContextSourceSnapshotEntry>;
    latest_attempt?: Partial<RunWorkingContextSourceSnapshotAttemptEntry>;
    latest_steer?: Partial<RunWorkingContextSourceSnapshotSteerEntry>;
  };
  source_attempt_id?: string | null;
}): RunWorkingContext {
  return RunWorkingContextSchema.parse({
    version: RUN_WORKING_CONTEXT_VERSION,
    run_id: input.run_id,
    plan_ref: input.plan_ref ?? null,
    active_task_refs: input.active_task_refs ?? [],
    recent_evidence_refs: input.recent_evidence_refs ?? [],
    current_focus: input.current_focus ?? null,
    current_blocker: input.current_blocker ?? null,
    next_operator_attention: input.next_operator_attention ?? null,
    automation: {
      mode: input.automation?.mode ?? "active",
      reason_code: input.automation?.reason_code ?? null
    },
    degraded: createRunWorkingContextDegradedState(input.degraded),
    source_snapshot: createRunWorkingContextSourceSnapshot(input.source_snapshot),
    source_attempt_id: input.source_attempt_id ?? null,
    updated_at: new Date().toISOString()
  });
}

export function createRunBrief(input: {
  run_id: string;
  status: RunStatus;
  headline: string;
  summary: string;
  failure_signal?: RunFailureSignal | null;
  blocker_summary?: string | null;
  recommended_next_action?: string | null;
  recommended_attempt_type?: AttemptType | null;
  waiting_for_human?: boolean;
  automation_mode?: RunAutomationMode;
  latest_attempt_id?: string | null;
  primary_focus?: string | null;
  evidence_refs?: RunBriefEvidenceRef[];
}): RunBrief {
  return RunBriefSchema.parse({
    run_id: input.run_id,
    status: input.status,
    headline: input.headline,
    summary: input.summary,
    failure_signal: input.failure_signal ?? null,
    blocker_summary: input.blocker_summary ?? null,
    recommended_next_action: input.recommended_next_action ?? null,
    recommended_attempt_type: input.recommended_attempt_type ?? null,
    waiting_for_human: input.waiting_for_human ?? false,
    automation_mode: input.automation_mode ?? "active",
    latest_attempt_id: input.latest_attempt_id ?? null,
    primary_focus: input.primary_focus ?? null,
    evidence_refs: input.evidence_refs ?? [],
    updated_at: new Date().toISOString()
  });
}

export function createRunFailureSignal(input: {
  failure_class: RunFailureClass;
  policy_mode: RunFailurePolicyMode;
  source_kind: RunFailureSourceKind;
  source_ref?: string | null;
  failure_code?: string | null;
  summary: string;
}): RunFailureSignal {
  return RunFailureSignalSchema.parse({
    failure_class: input.failure_class,
    policy_mode: input.policy_mode,
    source_kind: input.source_kind,
    source_ref: input.source_ref ?? null,
    failure_code: input.failure_code ?? null,
    summary: input.summary
  });
}

export function createRunBlockedDiagnosis(input: {
  status?: RunBlockedDiagnosisStatus;
  summary?: string | null;
  recommended_next_action?: string | null;
  source_ref?: string | null;
  evidence_refs?: string[];
}): RunBlockedDiagnosis {
  return RunBlockedDiagnosisSchema.parse({
    status: input.status ?? "not_applicable",
    summary: input.summary ?? null,
    recommended_next_action: input.recommended_next_action ?? null,
    source_ref: input.source_ref ?? null,
    evidence_refs: input.evidence_refs ?? [],
    updated_at: new Date().toISOString()
  });
}

export function createRunMaintenancePlane(input: {
  run_id: string;
  run_health: RunHealthAssessment;
  outputs?: RunMaintenanceOutput[];
  signal_sources?: RunMaintenanceSource[];
  blocked_diagnosis?: RunBlockedDiagnosis;
}): RunMaintenancePlane {
  return RunMaintenancePlaneSchema.parse({
    run_id: input.run_id,
    run_health: input.run_health,
    outputs: input.outputs ?? [],
    signal_sources: input.signal_sources ?? [],
    blocked_diagnosis: input.blocked_diagnosis ?? createRunBlockedDiagnosis({}),
    updated_at: new Date().toISOString()
  });
}

export function createRunGovernanceState(input: {
  run_id: string;
  status?: RunGovernanceStatus;
  active_problem_signature?: string | null;
  active_problem_summary?: string | null;
  blocker_repeat_count?: number;
  mainline_signature?: string | null;
  mainline_summary?: string | null;
  mainline_attempt_type?: AttemptType | null;
  mainline_attempt_id?: string | null;
  excluded_plans?: RunGovernanceExcludedPlan[];
  next_allowed_actions?: string[];
  last_meaningful_progress_at?: string | null;
  last_meaningful_progress_attempt_id?: string | null;
  context_summary?: Partial<RunGovernanceContextSummary>;
}): RunGovernanceState {
  const now = new Date().toISOString();

  return RunGovernanceStateSchema.parse({
    run_id: input.run_id,
    status: input.status ?? "active",
    active_problem_signature: input.active_problem_signature ?? null,
    active_problem_summary: input.active_problem_summary ?? null,
    blocker_repeat_count: input.blocker_repeat_count ?? 0,
    mainline_signature: input.mainline_signature ?? null,
    mainline_summary: input.mainline_summary ?? null,
    mainline_attempt_type: input.mainline_attempt_type ?? null,
    mainline_attempt_id: input.mainline_attempt_id ?? null,
    excluded_plans: input.excluded_plans ?? [],
    next_allowed_actions: input.next_allowed_actions ?? [],
    last_meaningful_progress_at: input.last_meaningful_progress_at ?? null,
    last_meaningful_progress_attempt_id: input.last_meaningful_progress_attempt_id ?? null,
    context_summary: {
      headline: input.context_summary?.headline ?? "尚未建立治理结论。",
      progress_summary: input.context_summary?.progress_summary ?? null,
      blocker_summary: input.context_summary?.blocker_summary ?? null,
      avoid_summary: input.context_summary?.avoid_summary ?? [],
      generated_at: input.context_summary?.generated_at ?? now
    },
    updated_at: now
  });
}

export function createRunPolicyRuntime(input: {
  run_id: string;
  stage?: RunPolicyStage;
  approval_status?: RunPolicyApprovalStatus;
  approval_required?: boolean;
  proposed_signature?: string | null;
  proposed_attempt_type?: AttemptType | null;
  proposed_objective?: string | null;
  proposed_success_criteria?: string[];
  permission_profile?: RunPolicyPermissionProfile;
  hook_policy?: RunPolicyHookPolicy;
  danger_mode?: RunPolicyDangerMode;
  killswitch_active?: boolean;
  killswitch_reason?: string | null;
  blocking_reason?: string | null;
  last_decision?: string | null;
  approval_requested_at?: string | null;
  approval_decided_at?: string | null;
  approval_actor?: string | null;
  approval_note?: string | null;
  source_attempt_id?: string | null;
  source_ref?: string | null;
}): RunPolicyRuntime {
  const now = new Date().toISOString();

  return RunPolicyRuntimeSchema.parse({
    run_id: input.run_id,
    stage: input.stage ?? "planning",
    approval_status: input.approval_status ?? "not_required",
    approval_required: input.approval_required ?? false,
    proposed_signature: input.proposed_signature ?? null,
    proposed_attempt_type: input.proposed_attempt_type ?? null,
    proposed_objective: input.proposed_objective ?? null,
    proposed_success_criteria: input.proposed_success_criteria ?? [],
    permission_profile: input.permission_profile ?? "read_only",
    hook_policy: input.hook_policy ?? "not_required",
    danger_mode: input.danger_mode ?? "forbid",
    killswitch_active: input.killswitch_active ?? false,
    killswitch_reason: input.killswitch_reason ?? null,
    blocking_reason: input.blocking_reason ?? null,
    last_decision: input.last_decision ?? null,
    approval_requested_at: input.approval_requested_at ?? null,
    approval_decided_at: input.approval_decided_at ?? null,
    approval_actor: input.approval_actor ?? null,
    approval_note: input.approval_note ?? null,
    source_attempt_id: input.source_attempt_id ?? null,
    source_ref: input.source_ref ?? null,
    updated_at: now
  });
}

export function isExecutionContractDraftReady(
  contract: AttemptContractDraft | null | undefined
): contract is AttemptContractDraft {
  return (
    contract?.attempt_type === "execution" &&
    (contract.verification_plan?.commands.length ?? 0) > 0 &&
    contract.required_evidence.length > 0 &&
    contract.done_rubric.length > 0 &&
    contract.failure_modes.length > 0
  );
}

export function isExecutionAttemptContractReady(
  contract: AttemptContract | null | undefined
): contract is AttemptContract {
  return (
    contract?.attempt_type === "execution" &&
    (contract.verification_plan?.commands.length ?? 0) > 0 &&
    contract.required_evidence.length > 0 &&
    contract.done_rubric.length > 0 &&
    contract.failure_modes.length > 0
  );
}

export function resolveExecutionVerifierKit(
  contract:
    | Pick<AttemptContract, "attempt_type" | "verifier_kit">
    | Pick<AttemptContractDraft, "attempt_type" | "verifier_kit">
    | null
    | undefined
): ExecutionVerifierKit | null {
  if (contract?.attempt_type !== "execution") {
    return null;
  }

  return contract.verifier_kit ?? DEFAULT_EXECUTION_VERIFIER_KIT;
}

export function updateCurrentDecision(
  currentDecision: CurrentDecision,
  patch: Partial<CurrentDecision>
): CurrentDecision {
  return CurrentDecisionSchema.parse({
    ...currentDecision,
    ...patch,
    updated_at: new Date().toISOString()
  });
}

export function updateRunAutomationControl(
  automationControl: RunAutomationControl,
  patch: Partial<RunAutomationControl>
): RunAutomationControl {
  return RunAutomationControlSchema.parse({
    ...automationControl,
    ...patch,
    updated_at: new Date().toISOString()
  });
}

export function updateRunPolicyRuntime(
  policyRuntime: RunPolicyRuntime,
  patch: Partial<RunPolicyRuntime>
): RunPolicyRuntime {
  return RunPolicyRuntimeSchema.parse({
    ...policyRuntime,
    ...patch,
    updated_at: new Date().toISOString()
  });
}

export function updateRunGovernanceState(
  governanceState: RunGovernanceState,
  patch: Partial<RunGovernanceState>
): RunGovernanceState {
  return RunGovernanceStateSchema.parse({
    ...governanceState,
    ...patch,
    context_summary: {
      ...governanceState.context_summary,
      ...(patch.context_summary ?? {}),
      generated_at: patch.context_summary?.generated_at ?? new Date().toISOString()
    },
    updated_at: new Date().toISOString()
  });
}

export function createRunSteer(input: {
  run_id: string;
  attempt_id?: string | null;
  content: string;
}): RunSteer {
  const now = new Date().toISOString();

  return RunSteerSchema.parse({
    id: createEntityId("rsteer"),
    run_id: input.run_id,
    attempt_id: input.attempt_id ?? null,
    content: input.content,
    status: "queued",
    created_at: now,
    updated_at: now
  });
}

export function updateRunSteer(
  runSteer: RunSteer,
  patch: Partial<RunSteer>
): RunSteer {
  return RunSteerSchema.parse({
    ...runSteer,
    ...patch,
    updated_at: new Date().toISOString()
  });
}

export function createRunJournalEntry(input: {
  run_id: string;
  attempt_id?: string | null;
  type: string;
  payload?: Record<string, unknown>;
  ts?: string;
}): RunJournalEntry {
  return RunJournalEntrySchema.parse({
    id: createEntityId("rje"),
    run_id: input.run_id,
    attempt_id: input.attempt_id ?? null,
    type: input.type,
    payload: input.payload ?? {},
    ts: input.ts ?? new Date().toISOString()
  });
}

export function finishWorkerRun(
  run: WorkerRun,
  patch: Partial<WorkerRun>
): WorkerRun {
  return WorkerRunSchema.parse({
    ...run,
    ...patch,
    ended_at: patch.ended_at ?? new Date().toISOString()
  });
}

export function createSteer(input: {
  goal_id: string;
  branch_id?: string | null;
  scope: "goal" | "branch" | "worker";
  content: string;
  apply_mode?: "immediate_boundary" | "next_pickup" | "manual";
}): Steer {
  const now = new Date().toISOString();

  return SteerSchema.parse({
    id: createEntityId("steer"),
    goal_id: input.goal_id,
    branch_id: input.branch_id ?? null,
    scope: input.scope,
    content: input.content,
    apply_mode: input.apply_mode ?? "next_pickup",
    status: "queued",
    created_at: now,
    updated_at: now
  });
}

export function updateSteer(steer: Steer, patch: Partial<Steer>): Steer {
  return SteerSchema.parse({
    ...steer,
    ...patch,
    updated_at: new Date().toISOString()
  });
}

export function createEvent(
  event: Omit<Event, "event_id" | "ts"> & { ts?: string }
): Event {
  return EventSchema.parse({
    ...event,
    event_id: createEntityId("evt"),
    ts: event.ts ?? new Date().toISOString()
  });
}
