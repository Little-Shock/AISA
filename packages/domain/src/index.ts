import { randomUUID } from "node:crypto";
import { z } from "zod";

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

export const AttemptContractDraftSchema = z.object({
  attempt_type: AttemptTypeSchema,
  objective: z.string().min(1).optional(),
  success_criteria: z.array(z.string().min(1)).min(1).optional(),
  required_evidence: z.array(z.string().min(1)).min(1),
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
  forbidden_shortcuts: z.array(z.string().min(1)).default([]),
  expected_artifacts: z.array(z.string().min(1)).default([]),
  verification_plan: ExecutionVerificationPlanSchema.optional(),
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
  repo_root: z.string().nullable(),
  git_head: z.string().nullable(),
  git_status: z.array(z.string().min(1)).default([]),
  preexisting_git_status: z.array(z.string().min(1)).default([]),
  new_git_status: z.array(z.string().min(1)).default([]),
  changed_files: z.array(z.string().min(1)).default([]),
  failure_code: RuntimeVerificationFailureCodeSchema.nullable(),
  failure_reason: z.string().nullable(),
  command_results: z.array(VerificationCommandResultSchema).default([]),
  synced_self_bootstrap_artifacts:
    SyncedSelfBootstrapArtifactsSchema.nullable().default(null),
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
  failure_context: z
    .object({
      message: z.string().min(1),
      journal_event_id: z.string().nullable(),
      journal_event_ts: z.string().datetime().nullable()
    })
    .nullable(),
  result: WorkerWritebackSchema.nullable(),
  runtime_verification: AttemptRuntimeVerificationSchema.nullable(),
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
  failure_context: z
    .object({
      message: z.string().min(1),
      journal_event_id: z.string().nullable(),
      journal_event_ts: z.string().datetime().nullable()
    })
    .nullable(),
  result: WorkerWritebackSchema.nullable(),
  evaluation: AttemptEvaluationSchema.nullable(),
  runtime_verification: AttemptRuntimeVerificationSchema.nullable(),
  artifact_manifest: z.array(ReviewPacketArtifactSchema).default([]),
  review_input_packet_ref: z.string().min(1).nullable().default(null),
  review_opinion_refs: z.array(z.string().min(1)).default([]),
  synthesized_evaluation_ref: z.string().min(1).nullable().default(null),
  evaluation_synthesis_ref: z.string().min(1).nullable().default(null),
  generated_at: z.string().datetime()
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
export type Branch = z.infer<typeof BranchSchema>;
export type WorkerRun = z.infer<typeof WorkerRunSchema>;
export type Attempt = z.infer<typeof AttemptSchema>;
export type CurrentDecision = z.infer<typeof CurrentDecisionSchema>;
export type AttemptEvaluation = z.infer<typeof AttemptEvaluationSchema>;
export type RunSteer = z.infer<typeof RunSteerSchema>;
export type RunJournalEntry = z.infer<typeof RunJournalEntrySchema>;
export type Steer = z.infer<typeof SteerSchema>;
export type Event = z.infer<typeof EventSchema>;
export type BranchSpec = z.infer<typeof BranchSpecSchema>;
export type EvalSpec = z.infer<typeof EvalSpecSchema>;
export type VerificationCommand = z.infer<typeof VerificationCommandSchema>;
export type ExecutionVerificationPlan = z.infer<typeof ExecutionVerificationPlanSchema>;
export type AttemptContractDraft = z.infer<typeof AttemptContractDraftSchema>;
export type AttemptContract = z.infer<typeof AttemptContractSchema>;
export type RuntimeVerificationFailureCode = z.infer<
  typeof RuntimeVerificationFailureCodeSchema
>;
export type VerificationCommandResult = z.infer<typeof VerificationCommandResultSchema>;
export type AttemptRuntimeVerification = z.infer<typeof AttemptRuntimeVerificationSchema>;
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
export type AttemptReviewInputRef = z.infer<typeof AttemptReviewInputRefSchema>;
export type AttemptReviewerIdentity = z.infer<typeof AttemptReviewerIdentitySchema>;
export type AttemptSynthesizerIdentity = z.infer<typeof AttemptSynthesizerIdentitySchema>;
export type AttemptReviewerJudgment = z.infer<typeof AttemptReviewerJudgmentSchema>;
export type AttemptReviewInputPacket = z.infer<typeof AttemptReviewInputPacketSchema>;
export type AttemptReviewerOpinion = z.infer<typeof AttemptReviewerOpinionSchema>;
export type AttemptReviewPacket = z.infer<typeof AttemptReviewPacketSchema>;
export type AttemptEvaluationSynthesisRecord = z.infer<
  typeof AttemptEvaluationSynthesisRecordSchema
>;
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;
export type EvalResult = z.infer<typeof EvalResultSchema>;
export type ContextBoard = z.infer<typeof ContextBoardSchema>;

export function createEntityId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
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
  forbidden_shortcuts?: string[];
  expected_artifacts?: string[];
  verification_plan?: ExecutionVerificationPlan;
}): AttemptContract {
  return AttemptContractSchema.parse({
    attempt_id: input.attempt_id,
    run_id: input.run_id,
    attempt_type: input.attempt_type,
    objective: input.objective,
    success_criteria: input.success_criteria,
    required_evidence: input.required_evidence,
    forbidden_shortcuts: input.forbidden_shortcuts ?? [],
    expected_artifacts: input.expected_artifacts ?? [],
    verification_plan: input.verification_plan,
    created_at: new Date().toISOString()
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

export function isExecutionContractDraftReady(
  contract: AttemptContractDraft | null | undefined
): contract is AttemptContractDraft {
  return (
    contract?.attempt_type === "execution" &&
    (contract.verification_plan?.commands.length ?? 0) > 0 &&
    contract.required_evidence.length > 0
  );
}

export function isExecutionAttemptContractReady(
  contract: AttemptContract | null | undefined
): contract is AttemptContract {
  return (
    contract?.attempt_type === "execution" &&
    (contract.verification_plan?.commands.length ?? 0) > 0 &&
    contract.required_evidence.length > 0
  );
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
