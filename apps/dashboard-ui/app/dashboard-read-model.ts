import type { RunDetail, RunSummaryItem } from "./dashboard-types";

type RunBriefReadModel = {
  headline: string;
  summary: string | null;
  recommended_next_action: string | null;
  recommended_attempt_type: string | null;
  blocking_reason: string | null;
  waiting_for_human: boolean;
  updated_at: string | null;
};

type PolicyRuntimeReadModel = {
  status: string;
  summary: string | null;
  recommended_next_action: string | null;
  recommended_attempt_type: string | null;
  blocking_reason: string | null;
  waiting_for_human: boolean;
  updated_at: string | null;
};

type PreflightReadModel = {
  status: string | null;
  summary: string | null;
  failure_reason: string | null;
  failure_code: string | null;
  verifier_kit: string | null;
  verification_command_count: number | null;
  source_ref: string | null;
  updated_at: string | null;
};

type HandoffReadModel = {
  summary: string | null;
  recommended_next_action: string | null;
  recommended_attempt_type: string | null;
  failure_code: string | null;
  adversarial_failure_code: string | null;
  source_ref: string | null;
  updated_at: string | null;
};

type WorkingContextSignalReadModel = {
  artifact_ref: string | null;
  plan_ref: string | null;
  summary: string | null;
  degraded_summary: string | null;
  degraded_reason_code: string | null;
  is_degraded: boolean;
  current_blocker_summary: string | null;
  current_blocker_ref: string | null;
  active_task_count: number;
  recent_evidence_count: number;
  current_snapshot_ref: string | null;
  automation_snapshot_ref: string | null;
  governance_snapshot_ref: string | null;
  latest_attempt_snapshot_ref: string | null;
  latest_steer_snapshot_ref: string | null;
  updated_at: string | null;
};

type WorkingContextReadModel = {
  active_attempt_id: string | null;
  active_phase: string | null;
  progress_text: string | null;
  current_focus: string | null;
  next_operator_attention: string | null;
  last_event_at: string | null;
  updated_at: string | null;
};

type MaintenancePlaneReadModel = {
  status: string;
  summary: string | null;
  likely_degraded: boolean;
  stale_after_ms: number | null;
  latest_activity_at: string | null;
  heartbeat_at: string | null;
  updated_at: string | null;
};

type FailureSurfaceReadModel = {
  code: string | null;
  summary: string | null;
  source: "policy_runtime" | "runtime" | "maintenance" | "review" | "unknown";
  blocking: boolean;
};

type SurfaceCarrier = Pick<
  RunSummaryItem,
  | "run"
  | "current"
  | "policy_runtime"
  | "failure_signal"
  | "latest_preflight_evaluation"
  | "latest_preflight_evaluation_ref"
  | "preflight_evaluation_summary"
  | "run_brief"
  | "maintenance_plane"
  | "working_context"
  | "working_context_ref"
  | "working_context_degraded"
  | "run_health"
  | "latest_handoff_bundle"
  | "latest_handoff_bundle_ref"
  | "handoff_summary"
>;

type LatestAttemptCarrier = Partial<
  Pick<
    RunSummaryItem,
    "latest_attempt" | "latest_attempt_runtime_state" | "latest_attempt_heartbeat"
  >
>;

type SummaryLike = (SurfaceCarrier | Pick<RunDetail, keyof SurfaceCarrier>) &
  LatestAttemptCarrier;

export function readRunBrief(item: SummaryLike): RunBriefReadModel {
  return {
    headline: item.run_brief?.headline ?? item.run.title,
    summary:
      item.run_brief?.summary ??
      item.latest_handoff_bundle?.summary ??
      item.failure_signal?.summary ??
      item.current?.summary ??
      item.run.description,
    recommended_next_action:
      item.latest_handoff_bundle?.recommended_next_action ??
      item.run_brief?.recommended_next_action ??
      item.current?.recommended_next_action ??
      null,
    recommended_attempt_type:
      item.latest_handoff_bundle?.recommended_attempt_type ??
      item.run_brief?.recommended_attempt_type ??
      item.current?.recommended_attempt_type ??
      null,
    blocking_reason:
      item.run_brief?.blocker_summary ??
      item.policy_runtime?.blocking_reason ??
      item.current?.blocking_reason ??
      null,
    waiting_for_human:
      item.run_brief?.waiting_for_human ?? item.current?.waiting_for_human ?? false,
    updated_at:
      item.run_brief?.updated_at ??
      item.current?.updated_at ??
      item.policy_runtime?.updated_at ??
      item.run.created_at
  };
}

export function readPolicyRuntime(item: SummaryLike): PolicyRuntimeReadModel {
  const brief = readRunBrief(item);

  return {
    status: item.current?.run_status ?? item.latest_attempt?.status ?? "draft",
    summary: brief.summary,
    recommended_next_action: brief.recommended_next_action,
    recommended_attempt_type: brief.recommended_attempt_type,
    blocking_reason: item.policy_runtime?.blocking_reason ?? brief.blocking_reason,
    waiting_for_human: brief.waiting_for_human,
    updated_at:
      item.policy_runtime?.updated_at ?? brief.updated_at ?? item.run.created_at
  };
}

export function readPreflightSummary(item: SummaryLike): PreflightReadModel {
  return {
    status:
      item.preflight_evaluation_summary?.status ??
      item.latest_preflight_evaluation?.status ??
      null,
    summary:
      item.preflight_evaluation_summary?.summary ??
      item.latest_preflight_evaluation?.failure_reason ??
      null,
    failure_reason:
      item.preflight_evaluation_summary?.failure_reason ??
      item.latest_preflight_evaluation?.failure_reason ??
      null,
    failure_code:
      item.preflight_evaluation_summary?.failure_code ??
      item.latest_preflight_evaluation?.failure_code ??
      null,
    verifier_kit: item.preflight_evaluation_summary?.verifier_kit ?? null,
    verification_command_count:
      item.preflight_evaluation_summary?.verification_command_count ?? null,
    source_ref:
      item.preflight_evaluation_summary?.source_ref ??
      item.latest_preflight_evaluation_ref ??
      null,
    updated_at: item.latest_preflight_evaluation?.created_at ?? null
  };
}

export function readHandoffSummary(item: SummaryLike): HandoffReadModel {
  return {
    summary: item.handoff_summary?.summary ?? item.latest_handoff_bundle?.summary ?? null,
    recommended_next_action:
      item.handoff_summary?.recommended_next_action ??
      item.latest_handoff_bundle?.recommended_next_action ??
      null,
    recommended_attempt_type:
      item.handoff_summary?.recommended_attempt_type ??
      item.latest_handoff_bundle?.recommended_attempt_type ??
      null,
    failure_code:
      item.handoff_summary?.failure_code ?? item.latest_handoff_bundle?.failure_code ?? null,
    adversarial_failure_code:
      item.handoff_summary?.adversarial_failure_code ??
      item.latest_handoff_bundle?.adversarial_failure_code ??
      null,
    source_ref:
      item.handoff_summary?.source_ref ??
      item.latest_handoff_bundle_ref ??
      null,
    updated_at: item.latest_handoff_bundle?.generated_at ?? null
  };
}

export function readWorkingContext(item: SummaryLike): WorkingContextReadModel {
  return {
    active_attempt_id:
      item.working_context?.source_attempt_id ??
      item.current?.latest_attempt_id ??
      item.latest_attempt?.id ??
      null,
    active_phase: item.latest_attempt_runtime_state?.phase ?? null,
    progress_text:
      item.latest_attempt_runtime_state?.progress_text ??
      item.working_context?.next_operator_attention ??
      item.working_context?.current_focus ??
      null,
    current_focus: item.working_context?.current_focus ?? null,
    next_operator_attention: item.working_context?.next_operator_attention ?? null,
    last_event_at:
      item.latest_attempt_runtime_state?.last_event_at ??
      item.latest_attempt_heartbeat?.heartbeat_at ??
      null,
    updated_at:
      item.working_context?.updated_at ??
      item.latest_attempt_runtime_state?.updated_at ??
      item.current?.updated_at ??
      item.run.created_at
  };
}

export function readWorkingContextSignal(
  item: SummaryLike
): WorkingContextSignalReadModel {
  return {
    artifact_ref: item.working_context_ref ?? null,
    plan_ref: item.working_context?.plan_ref ?? null,
    summary:
      item.working_context_degraded?.summary ??
      item.working_context?.next_operator_attention ??
      item.working_context?.current_focus ??
      null,
    degraded_summary: item.working_context_degraded?.summary ?? null,
    degraded_reason_code: item.working_context_degraded?.reason_code ?? null,
    is_degraded: item.working_context_degraded?.is_degraded ?? false,
    current_blocker_summary: item.working_context?.current_blocker?.summary ?? null,
    current_blocker_ref: item.working_context?.current_blocker?.ref ?? null,
    active_task_count: item.working_context?.active_task_refs.length ?? 0,
    recent_evidence_count: item.working_context?.recent_evidence_refs.length ?? 0,
    current_snapshot_ref: item.working_context?.source_snapshot.current.ref ?? null,
    automation_snapshot_ref: item.working_context?.source_snapshot.automation.ref ?? null,
    governance_snapshot_ref: item.working_context?.source_snapshot.governance.ref ?? null,
    latest_attempt_snapshot_ref:
      item.working_context?.source_snapshot.latest_attempt.ref ?? null,
    latest_steer_snapshot_ref:
      item.working_context?.source_snapshot.latest_steer.ref ?? null,
    updated_at: item.working_context?.updated_at ?? null
  };
}

export function readMaintenancePlane(
  item: SummaryLike
): MaintenancePlaneReadModel {
  const health = item.maintenance_plane?.run_health ?? item.run_health;

  return {
    status: health?.status ?? "unknown",
    summary:
      item.maintenance_plane?.blocked_diagnosis.summary ??
      health?.summary ??
      item.failure_signal?.summary ??
      null,
    likely_degraded:
      health?.likely_zombie ?? item.working_context_degraded?.is_degraded ?? false,
    stale_after_ms: health?.stale_after_ms ?? null,
    latest_activity_at:
      health?.latest_activity_at ??
      item.latest_attempt_runtime_state?.last_event_at ??
      item.latest_attempt?.ended_at ??
      item.latest_attempt?.started_at ??
      null,
    heartbeat_at:
      health?.heartbeat_at ?? item.latest_attempt_heartbeat?.heartbeat_at ?? null,
    updated_at:
      item.maintenance_plane?.updated_at ??
      health?.latest_activity_at ??
      item.current?.updated_at ??
      item.run.created_at
  };
}

export function readFailureSurface(
  item: SummaryLike
): FailureSurfaceReadModel | null {
  if (item.failure_signal?.summary) {
    return {
      code: item.failure_signal.failure_code,
      summary: item.failure_signal.summary,
      source:
        item.failure_signal.source_kind === "review_packet"
          ? "review"
          : item.failure_signal.source_kind === "maintenance_plane"
            ? "maintenance"
            : item.failure_signal.source_kind === "runtime_verification"
              ? "runtime"
              : "unknown",
      blocking: item.failure_signal.policy_mode === "fail_closed"
    };
  }

  const policyRuntime = readPolicyRuntime(item);
  if (policyRuntime.waiting_for_human && policyRuntime.blocking_reason) {
    return {
      code: null,
      summary: policyRuntime.blocking_reason,
      source: "policy_runtime",
      blocking: true
    };
  }

  if (item.latest_attempt_runtime_state?.error) {
    return {
      code: null,
      summary: item.latest_attempt_runtime_state.error,
      source: "runtime",
      blocking: true
    };
  }

  const maintenancePlane = readMaintenancePlane(item);
  if (maintenancePlane.likely_degraded && maintenancePlane.summary) {
    return {
      code: null,
      summary: maintenancePlane.summary,
      source: "maintenance",
      blocking: false
    };
  }

  return null;
}
