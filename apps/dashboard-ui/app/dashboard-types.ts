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

export type RunGovernanceState = {
  status: string;
  active_problem_signature: string | null;
  active_problem_summary: string | null;
  blocker_repeat_count: number;
  mainline_signature: string | null;
  mainline_summary: string | null;
  mainline_attempt_type: string | null;
  mainline_attempt_id: string | null;
  excluded_plans: Array<{
    plan_signature: string;
    objective: string;
    reason: string;
    source_attempt_id: string | null;
    source_attempt_status: string | null;
    evidence_refs: string[];
    excluded_at: string;
  }>;
  next_allowed_actions: string[];
  last_meaningful_progress_at: string | null;
  last_meaningful_progress_attempt_id: string | null;
  context_summary: {
    headline: string;
    progress_summary: string | null;
    blocker_summary: string | null;
    avoid_summary: string[];
    generated_at: string;
  };
  updated_at: string;
} | null;

export type RunHealthAssessment = {
  status: string;
  summary: string;
  likely_zombie: boolean;
  stale_after_ms: number;
  latest_attempt_id: string | null;
  latest_attempt_status: string | null;
  latest_activity_at: string | null;
  latest_activity_age_ms: number | null;
  heartbeat_at: string | null;
  heartbeat_age_ms: number | null;
} | null;

export type RunAutomationControlView = {
  mode: string;
  reason_code: string | null;
  reason: string | null;
  imposed_by: string | null;
  active_run_id: string | null;
  failure_code: string | null;
  updated_at: string;
} | null;

export type RunPolicyRuntime = {
  run_id: string;
  stage: string;
  approval_status: string;
  approval_required: boolean;
  proposed_signature: string | null;
  proposed_attempt_type: string | null;
  proposed_objective: string | null;
  proposed_success_criteria: string[];
  permission_profile: string;
  hook_policy: string;
  danger_mode: string;
  killswitch_active: boolean;
  killswitch_reason: string | null;
  blocking_reason: string | null;
  last_decision: string | null;
  approval_requested_at: string | null;
  approval_decided_at: string | null;
  approval_actor: string | null;
  approval_note: string | null;
  source_attempt_id: string | null;
  source_ref: string | null;
  updated_at: string;
} | null;

export type RunPolicyActivityItem = {
  id: string;
  ts: string;
  kind: "decision" | "hook";
  status:
    | "pending"
    | "approved"
    | "rejected"
    | "blocked"
    | "active"
    | "cleared"
    | "passed"
    | "failed";
  headline: string;
  summary: string | null;
  actor: string | null;
  note: string | null;
  proposed_signature: string | null;
  attempt_type: string | null;
  objective: string | null;
  permission_profile: string | null;
  hook_policy: string | null;
  danger_mode: string | null;
  verifier_kit: string | null;
  verification_commands: string[];
  source_attempt_id: string | null;
  source_ref: string | null;
  evidence_ref: string | null;
  hook_key: string | null;
};

export type RunHarnessProfileView = {
  version: number;
  execution: {
    effort: string;
    default_verifier_kit: string;
  };
  reviewer: {
    effort: string;
  };
  synthesizer: {
    effort: string;
  };
  gates: {
    preflight_review: {
      mode: string;
    };
    deterministic_runtime: {
      mode: string;
    };
    postflight_adversarial: {
      mode: string;
    };
  };
  slots: {
    research_or_planning: {
      binding: string;
    };
    execution: {
      binding: string;
    };
    preflight_review: {
      binding: string;
    };
    postflight_review: {
      binding: string;
    };
    final_synthesis: {
      binding: string;
    };
  };
};

export type RunHarnessSlotBindingStatus = "aligned" | "binding_mismatch";

export type RunHarnessSlotPermissionBoundary =
  | "read_only"
  | "workspace_write"
  | "control_plane_only";

export type RunHarnessSlotFailureSemantics = "fail_closed" | "fail_open";

export type RunHarnessGatePhase = "dispatch" | "runtime" | "postflight";

export type RunHarnessGateView = {
  gate:
    | "preflight_review"
    | "deterministic_runtime"
    | "postflight_adversarial";
  title: string;
  mode: "required" | "disabled";
  default_mode: "required";
  phase: RunHarnessGatePhase;
  enforced: boolean;
  source: string;
  detail: string;
  artifact_ref: string;
};

export type RunHarnessGatesView = {
  preflight_review: RunHarnessGateView;
  deterministic_runtime: RunHarnessGateView;
  postflight_adversarial: RunHarnessGateView;
};

export type RunHarnessSlotView = {
  slot:
    | "research_or_planning"
    | "execution"
    | "preflight_review"
    | "postflight_review"
    | "final_synthesis";
  title: string;
  binding: string;
  expected_binding: string;
  binding_status: RunHarnessSlotBindingStatus;
  binding_matches_registry: boolean;
  source: string;
  detail: string;
  input_contract: string[];
  permission_boundary: RunHarnessSlotPermissionBoundary;
  output_artifacts: string[];
  failure_semantics: RunHarnessSlotFailureSemantics;
};

export type RunHarnessSlotsView = {
  research_or_planning: RunHarnessSlotView;
  execution: RunHarnessSlotView & {
    default_verifier_kit: string;
  };
  preflight_review: RunHarnessSlotView;
  postflight_review: RunHarnessSlotView;
  final_synthesis: RunHarnessSlotView;
};

export type ExecutionVerifierKitCommandPolicy =
  | "workspace_script_inference"
  | "contract_locked_commands";

export type ExecutionVerifierKitView = {
  kit: "repo" | "web" | "api" | "cli";
  title: string;
  detail: string;
  command_policy: ExecutionVerifierKitCommandPolicy;
  preflight_expectations: string[];
  runtime_expectations: string[];
  adversarial_focus: string[];
  source: string;
};

export type RunEffectivePolicyBundleView = {
  profile_version: number;
  verification_discipline: {
    level: string;
    default_verifier_kit: string;
    command_policy: string;
    summary: string;
    source_refs: string[];
  };
  operator_brief: {
    intensity: string;
    evidence_ref_budget: number;
    summary_style: string;
    source: string;
    detail: string;
  };
  maintenance_refresh: {
    strategy: string;
    refreshes_on_read: boolean;
    source: string;
    detail: string;
  };
  recovery: {
    active_run: string;
    settled_run: string;
    auto_resume_from_settled_handoff: boolean;
    source: string;
    detail: string;
  };
};

export type RunWorkingContextTaskRef = {
  task_id: string;
  title: string;
  source_ref: string;
};

export type RunWorkingContextEvidenceRef = {
  kind: string;
  ref: string;
  note: string | null;
};

export type RunWorkingContextBlocker = {
  code: string | null;
  summary: string;
  ref: string | null;
} | null;

export type RunWorkingContextDegraded = {
  is_degraded: boolean;
  reason_code: string | null;
  summary: string | null;
};

export type RunBriefDegraded = {
  is_degraded: boolean;
  reason_code: string | null;
  summary: string | null;
  source_ref: string | null;
};

export type RunWorkingContextSourceSnapshotEntry = {
  ref: string | null;
  updated_at: string | null;
};

export type RunWorkingContextSourceSnapshot = {
  current: RunWorkingContextSourceSnapshotEntry;
  automation: RunWorkingContextSourceSnapshotEntry;
  governance: RunWorkingContextSourceSnapshotEntry;
  latest_attempt: RunWorkingContextSourceSnapshotEntry & {
    attempt_id: string | null;
  };
  latest_steer: RunWorkingContextSourceSnapshotEntry & {
    steer_id: string | null;
  };
};

export type RunWorkingContext = {
  version: 1;
  run_id: string;
  plan_ref: string | null;
  active_task_refs: RunWorkingContextTaskRef[];
  baseline_refs: RunWorkingContextEvidenceRef[];
  key_file_refs: RunWorkingContextEvidenceRef[];
  recent_evidence_refs: RunWorkingContextEvidenceRef[];
  current_focus: string | null;
  current_blocker: RunWorkingContextBlocker;
  next_operator_attention: string | null;
  automation: {
    mode: string;
    reason_code: string | null;
  };
  degraded: RunWorkingContextDegraded;
  source_snapshot: RunWorkingContextSourceSnapshot;
  source_attempt_id: string | null;
  updated_at: string;
} | null;

export type RunFailureSignal = {
  failure_class: string;
  policy_mode: string;
  source_kind: string;
  source_ref: string | null;
  failure_code: string | null;
  summary: string;
} | null;

export type RunBriefEvidenceRef = {
  kind: string;
  ref: string;
  label: string;
  summary: string | null;
};

export type RunBrief = {
  run_id: string;
  status: string;
  headline: string;
  summary: string;
  failure_signal: RunFailureSignal;
  blocker_summary: string | null;
  recommended_next_action: string | null;
  recommended_attempt_type: string | null;
  waiting_for_human: boolean;
  automation_mode: string;
  latest_attempt_id: string | null;
  primary_focus: string | null;
  evidence_refs: RunBriefEvidenceRef[];
  updated_at: string;
} | null;

export type RunMaintenanceSource = {
  key: string;
  label: string;
  plane: string;
  ref: string | null;
  summary: string | null;
};

export type RunMaintenanceOutput = {
  key: string;
  label: string;
  plane: string;
  status: string;
  ref: string | null;
  summary: string | null;
};

export type RunBlockedDiagnosis = {
  status: string;
  summary: string | null;
  recommended_next_action: string | null;
  source_ref: string | null;
  evidence_refs: string[];
  updated_at: string;
};

export type RunMaintenancePlane = {
  run_id: string;
  run_health: RunHealthAssessment;
  outputs: RunMaintenanceOutput[];
  signal_sources: RunMaintenanceSource[];
  blocked_diagnosis: RunBlockedDiagnosis;
  updated_at: string;
} | null;

export type RunLatestPreflightEvaluation = {
  run_id: string;
  attempt_id: string;
  attempt_type: string;
  status: string;
  failure_class: string | null;
  failure_policy_mode: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  contract: {
    verifier_kit: string | null;
  } | null;
  checks: Array<{
    code: string;
    status: string;
    message: string;
  }>;
  created_at: string;
} | null;

export type RunLatestRuntimeVerification = {
  run_id: string;
  attempt_id: string;
  attempt_type: string;
  status: string;
  verifier_kit: string | null;
  failure_class: string | null;
  failure_policy_mode: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  changed_files: string[];
  created_at: string;
} | null;

export type RunLatestAdversarialVerification = {
  run_id: string;
  attempt_id: string;
  attempt_type: string;
  status: string;
  verifier_kit: string | null;
  failure_class: string | null;
  failure_policy_mode: string | null;
  verdict: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  output_refs: string[];
  created_at: string;
} | null;

export type RunLatestHandoffBundle = {
  run_id: string;
  attempt_id: string;
  failure_signal: RunFailureSignal;
  failure_class: string | null;
  failure_policy_mode: string | null;
  failure_code: string | null;
  adversarial_failure_code: string | null;
  recommended_next_action: string | null;
  recommended_attempt_type: string | null;
  summary: string | null;
  adversarial_verification: {
    status: string;
    verdict: string | null;
    failure_code: string | null;
    failure_reason: string | null;
    output_refs: string[];
  } | null;
  source_refs: {
    preflight_evaluation: string | null;
    review_packet: string | null;
    runtime_verification: string | null;
    adversarial_verification: string | null;
  };
  generated_at: string;
} | null;

export type RunPreflightEvaluationSummary = {
  status: string;
  summary: string;
  failure_class: string | null;
  failure_policy_mode: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  requires_adversarial_verification: boolean;
  verifier_kit: string | null;
  verification_command_count: number;
  source_ref: string | null;
} | null;

export type RunHandoffSummary = {
  summary: string | null;
  recommended_next_action: string | null;
  recommended_attempt_type: string | null;
  failure_class: string | null;
  failure_policy_mode: string | null;
  failure_code: string | null;
  adversarial_failure_code: string | null;
  source_ref: string | null;
} | null;

export type RunRecoveryEvidenceRef = {
  kind: string;
  ref: string;
  label: string;
  summary: string | null;
};

export type RunRecoveryGuidance = {
  path: string;
  recommended_next_action: string | null;
  recommended_attempt_type: string | null;
  summary: string | null;
  blocking_reason: string | null;
  handoff_bundle_ref: string | null;
  reason_code: string;
  reason: string;
  project_status: string;
  project_profile_ref: string | null;
  baseline_snapshot_ref: string | null;
  capability_snapshot_ref: string | null;
  baseline_refs: RunRecoveryEvidenceRef[];
  key_file_refs: RunRecoveryEvidenceRef[];
  latest_settled_evidence_refs: RunRecoveryEvidenceRef[];
} | null;

export type RunAttachedProjectView = {
  project: {
    id: string;
    slug: string;
    title: string;
    workspace_root: string;
    repo_root: string;
    repo_name: string;
    project_type: string;
    primary_language: string;
    package_manager: string | null;
    manifest_files: string[];
    detection_reasons: string[];
    default_commands: {
      install: string | null;
      build: string | null;
      test: string | null;
      lint: string | null;
      start: string | null;
    };
    supported: boolean;
    unsupported_reason: string | null;
    created_at: string;
    updated_at: string;
  };
  project_profile_ref: string;
  baseline_snapshot: {
    project_id: string;
    workspace_root: string;
    captured_at: string;
    git: {
      branch: string | null;
      head_sha: string | null;
      dirty: boolean;
    };
    repo_health: {
      has_tests: boolean;
      has_build_command: boolean;
      default_verifier_hint: string | null;
      supported: boolean;
      unsupported_reason: string | null;
    };
  } | null;
  baseline_snapshot_ref: string | null;
  capability_snapshot: {
    project_id: string;
    workspace_root: string;
    captured_at: string;
    overall_status: string;
    blocking_reasons: Array<{
      code: string;
      message: string;
    }>;
    workspace_scope: {
      within_allowed_scope: boolean;
      matched_scope_root: string | null;
      summary: string;
    };
    worker_adapter: {
      type: string;
      command: string;
      model: string | null;
      available: boolean;
      summary: string;
      blocking_reasons: Array<{
        code: string;
        message: string;
      }>;
    };
    verification_commands: Array<{
      label: string;
      command: string | null;
      entrypoint: string | null;
      status: string;
      summary: string;
      reason_code: string | null;
    }>;
    launch_readiness: {
      research: {
        attempt_type: string;
        status: string;
        summary: string;
      };
      execution: {
        attempt_type: string;
        status: string;
        summary: string;
      };
    };
  } | null;
  capability_snapshot_ref: string | null;
  recommended_stack_pack: {
    id: string;
    title: string;
    summary: string;
    default_task_preset_id: string;
    default_verifier_kit: string;
  };
  task_preset_recommendations: Array<{
    id: string;
    title: string;
    summary: string;
  }>;
  default_task_preset_id: string;
  execution_contract_preview: {
    attempt_type: string;
    stack_pack_id: string | null;
    task_preset_id: string | null;
    verifier_kit: string | null;
    verification_plan?: {
      commands: Array<{
        purpose: string;
        command: string;
      }>;
    };
  };
  run_template: {
    title: string;
    description: string;
    workspace_root: string;
    owner_id: string;
    success_criteria: string[];
    constraints: string[];
  };
} | null;

export type RunSummaryItem = {
  run: {
    id: string;
    title: string;
    description: string;
    workspace_root: string;
    attached_project_id: string | null;
    attached_project_stack_pack_id: string | null;
    attached_project_task_preset_id: string | null;
    harness_profile: RunHarnessProfileView;
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
  automation: RunAutomationControlView;
  governance: RunGovernanceState;
  policy_runtime: RunPolicyRuntime;
  policy_runtime_ref: string | null;
  policy_runtime_invalid_reason: string | null;
  failure_signal: RunFailureSignal;
  latest_preflight_evaluation: RunLatestPreflightEvaluation;
  latest_preflight_evaluation_ref: string | null;
  preflight_evaluation_summary?: RunPreflightEvaluationSummary;
  latest_runtime_verification: RunLatestRuntimeVerification;
  latest_runtime_verification_ref: string | null;
  latest_adversarial_verification: RunLatestAdversarialVerification;
  latest_adversarial_verification_ref: string | null;
  latest_handoff_bundle: RunLatestHandoffBundle;
  latest_handoff_bundle_ref: string | null;
  handoff_summary?: RunHandoffSummary;
  run_brief: RunBrief;
  run_brief_ref: string | null;
  run_brief_invalid_reason: string | null;
  run_brief_degraded: RunBriefDegraded;
  maintenance_plane: RunMaintenancePlane;
  maintenance_plane_ref: string | null;
  working_context: RunWorkingContext;
  working_context_ref: string | null;
  working_context_degraded: RunWorkingContextDegraded;
  run_health: RunHealthAssessment;
  harness_gates: RunHarnessGatesView;
  harness_slots: RunHarnessSlotsView;
  default_verifier_kit_profile: ExecutionVerifierKitView;
  effective_policy_bundle: RunEffectivePolicyBundleView;
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
    attached_project_id: string | null;
    attached_project_stack_pack_id: string | null;
    attached_project_task_preset_id: string | null;
    harness_profile: RunHarnessProfileView;
    success_criteria: string[];
    constraints: string[];
    created_at: string;
    updated_at: string;
  };
  attached_project: RunAttachedProjectView;
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
  automation: RunAutomationControlView;
  governance: RunGovernanceState;
  policy_runtime: RunPolicyRuntime;
  policy_runtime_ref: string | null;
  policy_runtime_invalid_reason: string | null;
  policy_activity: RunPolicyActivityItem[];
  policy_activity_ref: string | null;
  failure_signal: RunFailureSignal;
  latest_preflight_evaluation: RunLatestPreflightEvaluation;
  latest_preflight_evaluation_ref: string | null;
  preflight_evaluation_summary?: RunPreflightEvaluationSummary;
  latest_runtime_verification: RunLatestRuntimeVerification;
  latest_runtime_verification_ref: string | null;
  latest_adversarial_verification: RunLatestAdversarialVerification;
  latest_adversarial_verification_ref: string | null;
  latest_handoff_bundle: RunLatestHandoffBundle;
  latest_handoff_bundle_ref: string | null;
  handoff_summary?: RunHandoffSummary;
  run_brief: RunBrief;
  run_brief_ref: string | null;
  run_brief_invalid_reason: string | null;
  run_brief_degraded: RunBriefDegraded;
  maintenance_plane: RunMaintenancePlane;
  maintenance_plane_ref: string | null;
  working_context: RunWorkingContext;
  working_context_ref: string | null;
  working_context_degraded: RunWorkingContextDegraded;
  run_health: RunHealthAssessment;
  harness_gates: RunHarnessGatesView;
  harness_slots: RunHarnessSlotsView;
  default_verifier_kit_profile: ExecutionVerifierKitView;
  effective_policy_bundle: RunEffectivePolicyBundleView;
  recovery_guidance: RunRecoveryGuidance;
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
    effective_verifier_kit_profile: ExecutionVerifierKitView | null;
    contract: {
      objective: string;
      success_criteria: string[];
      required_evidence: string[];
      adversarial_verification_required: boolean;
      verifier_kit: string | null;
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
      adversarial_verification_status: string;
      recommendation: string;
      suggested_attempt_type: string | null;
      rationale: string;
      missing_evidence: string[];
      goal_progress: number;
      evidence_quality: number;
    } | null;
    runtime_verification: {
      status: string;
      verifier_kit: string | null;
      failure_class: string | null;
      failure_policy_mode: string | null;
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
    adversarial_verification: {
      status: string;
      verifier_kit: string | null;
      failure_class: string | null;
      failure_policy_mode: string | null;
      verdict: string | null;
      failure_code: string | null;
      failure_reason: string | null;
      output_refs: string[];
      commands: Array<{
        purpose: string;
        command: string;
        exit_code: number;
        status: string;
        output_ref: string | null;
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
