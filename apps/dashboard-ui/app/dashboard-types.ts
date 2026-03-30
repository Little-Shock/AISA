export type GoalSummaryItem = {
  goal: {
    id: string;
    title: string;
    status: string;
    workspace_root: string;
  };
  branch_count: number;
  running_count: number;
  kept_count: number;
};

export type GoalDetail = {
  goal: {
    id: string;
    title: string;
    description: string;
    status: string;
    workspace_root: string;
    success_criteria: string[];
    constraints: string[];
  };
  branches: Array<{
    branch: {
      id: string;
      hypothesis: string;
      objective: string;
      status: string;
      assigned_worker: string;
      score: number | null;
      confidence: number | null;
    };
    writeback: {
      summary: string;
      recommended_next_steps: string[];
    } | null;
  }>;
  steers: Array<{
    id: string;
    content: string;
    status: string;
    scope: string;
  }>;
  context: {
    shared_facts: string[];
    open_questions: string[];
    constraints: string[];
    branch_notes: Record<string, string>;
  };
  report: string;
  events: Array<{
    event_id: string;
    type: string;
    ts: string;
  }>;
};

export type AttemptRuntimeState = {
  running: boolean;
  phase: string | null;
  active_since: string | null;
  last_event_at: string | null;
  progress_text: string | null;
  recent_activities: string[];
  completed_steps: string[];
  process_content: string[];
  final_output: string | null;
  error: string | null;
  session_id: string | null;
  event_count: number;
  updated_at: string;
};

export type AttemptRuntimeEvent = {
  id: string;
  ts: string;
  type: string;
  summary: string;
  seq: number;
};

export type AttemptHeartbeat = {
  status: string;
  started_at: string;
  heartbeat_at: string;
  released_at: string | null;
};

export type RunSummaryItem = {
  run: {
    id: string;
    title: string;
    description: string;
    workspace_root: string;
    created_at: string;
  };
  current: {
    run_status: string;
    latest_attempt_id: string | null;
    recommended_next_action: string | null;
    recommended_attempt_type: string | null;
    summary: string;
    blocking_reason: string | null;
    waiting_for_human: boolean;
    updated_at: string;
  } | null;
  attempt_count: number;
  latest_attempt: {
    id: string;
    attempt_type: string;
    status: string;
    worker: string;
    objective: string;
    created_at: string;
    started_at: string | null;
    ended_at: string | null;
  } | null;
  latest_attempt_runtime_state: AttemptRuntimeState | null;
  latest_attempt_heartbeat: AttemptHeartbeat | null;
  task_focus: string;
  verification_command_count: number;
};

export type RunDetail = {
  run: {
    id: string;
    title: string;
    description: string;
    workspace_root: string;
    owner_id: string;
    success_criteria: string[];
    constraints: string[];
    created_at: string;
    updated_at: string;
  };
  current: {
    run_status: string;
    best_attempt_id: string | null;
    latest_attempt_id: string | null;
    recommended_next_action: string | null;
    recommended_attempt_type: string | null;
    summary: string;
    blocking_reason: string | null;
    waiting_for_human: boolean;
    updated_at: string;
  } | null;
  attempts: Array<{
    id: string;
    attempt_type: string;
    status: string;
    worker: string;
    objective: string;
    success_criteria: string[];
    workspace_root: string;
    created_at: string;
    started_at: string | null;
    ended_at: string | null;
  }>;
  attempt_details: Array<{
    attempt: {
      id: string;
      attempt_type: string;
      status: string;
      worker: string;
      objective: string;
      success_criteria: string[];
      workspace_root: string;
      created_at: string;
      started_at: string | null;
      ended_at: string | null;
    };
    contract: {
      objective: string;
      success_criteria: string[];
      required_evidence: string[];
      forbidden_shortcuts: string[];
      expected_artifacts: string[];
      verification_plan?: {
        commands: Array<{
          purpose: string;
          command: string;
          expected_exit_code?: number;
        }>;
      };
    } | null;
    result: {
      summary: string;
      findings: Array<{
        type: string;
        content: string;
        evidence: string[];
      }>;
      recommended_next_steps: string[];
      confidence: number;
    } | null;
    evaluation: {
      verification_status: string;
      recommendation: string;
      suggested_attempt_type: string | null;
      rationale: string;
      missing_evidence: string[];
      goal_progress: number;
      evidence_quality: number;
    } | null;
    runtime_verification: {
      status: string;
      failure_code: string | null;
      failure_reason: string | null;
      changed_files: string[];
      command_results: Array<{
        purpose: string;
        command: string;
        passed: boolean;
        exit_code: number;
        expected_exit_code: number;
      }>;
    } | null;
    runtime_state: AttemptRuntimeState | null;
    runtime_events: AttemptRuntimeEvent[];
    heartbeat: AttemptHeartbeat | null;
    stdout_excerpt: string;
    stderr_excerpt: string;
    journal: Array<{
      type: string;
      ts: string;
    }>;
  }>;
  steers: Array<{
    id: string;
    content: string;
    status: string;
    attempt_id: string | null;
    created_at: string;
  }>;
  journal: Array<{
    id: string;
    type: string;
    ts: string;
    attempt_id: string | null;
  }>;
  report: string;
};

export type ViewMode = "runs" | "goals";

export type RunInboxFilter = "all" | "needs_action" | "active" | "watch";

export type RunFocusLens =
  | "all"
  | "waiting_human"
  | "replay_gap"
  | "runtime_fault"
  | "unstarted";

export type RunOperatorState = {
  kind: "needs_action" | "at_risk" | "active" | "watch";
  label: string;
  tone: "rose" | "amber" | "emerald";
  reason: string;
  recovery_hint: string;
  sort_order: number;
};

export type RunSignalBadge = {
  key: string;
  label: string;
  tone: "rose" | "amber" | "emerald";
};

export type RunPriorityInfo = {
  score: number;
  label: string;
  reason: string;
  tone: "rose" | "amber" | "emerald";
};
