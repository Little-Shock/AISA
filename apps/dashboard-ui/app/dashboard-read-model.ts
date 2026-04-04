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
  | "run_brief"
  | "maintenance_plane"
  | "working_context"
  | "working_context_degraded"
  | "run_health"
  | "latest_handoff_bundle"
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
