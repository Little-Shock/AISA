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

export const CreateGoalInputSchema = GoalSchema.omit({
  id: true,
  status: true,
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

export const WorkerFindingSchema = z.object({
  type: z.enum(["fact", "hypothesis", "risk"]),
  content: z.string().min(1),
  evidence: z.array(z.string().min(1)).default([])
});

export const WorkerWritebackSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(WorkerFindingSchema).default([]),
  questions: z.array(z.string().min(1)).default([]),
  recommended_next_steps: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1),
  artifacts: z
    .array(
      z.object({
        type: z.string().min(1),
        path: z.string().min(1)
      })
    )
    .default([])
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
export type Branch = z.infer<typeof BranchSchema>;
export type WorkerRun = z.infer<typeof WorkerRunSchema>;
export type Steer = z.infer<typeof SteerSchema>;
export type Event = z.infer<typeof EventSchema>;
export type BranchSpec = z.infer<typeof BranchSpecSchema>;
export type EvalSpec = z.infer<typeof EvalSpecSchema>;
export type WorkerWriteback = z.infer<typeof WorkerWritebackSchema>;
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
