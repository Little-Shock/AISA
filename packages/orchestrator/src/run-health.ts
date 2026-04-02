import type {
  Attempt,
  AttemptHeartbeat,
  AttemptRuntimeState,
  CurrentDecision,
  RunHealthAssessment,
  RunHealthStatus
} from "@autoresearch/domain";

export type { RunHealthAssessment, RunHealthStatus } from "@autoresearch/domain";

function ageMs(ts: string | null, nowMs: number): number | null {
  if (!ts) {
    return null;
  }

  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return nowMs - parsed;
}

export function getRunMostRecentActivityTs(input: {
  current: CurrentDecision | null;
  latestAttempt: Attempt | null;
  latestHeartbeat: AttemptHeartbeat | null;
  latestRuntimeState: AttemptRuntimeState | null;
}): string | null {
  return (
    (input.latestHeartbeat?.status === "active"
      ? input.latestHeartbeat.heartbeat_at
      : null) ??
    input.latestRuntimeState?.last_event_at ??
    input.latestRuntimeState?.updated_at ??
    input.current?.updated_at ??
    input.latestAttempt?.started_at ??
    input.latestAttempt?.created_at ??
    null
  );
}

export function assessRunHealth(input: {
  current: CurrentDecision | null;
  latestAttempt: Attempt | null;
  latestHeartbeat: AttemptHeartbeat | null;
  latestRuntimeState: AttemptRuntimeState | null;
  staleAfterMs: number;
  now?: Date;
}): RunHealthAssessment {
  const nowMs = (input.now ?? new Date()).getTime();
  const heartbeatAt =
    input.latestHeartbeat?.status === "active" ? input.latestHeartbeat.heartbeat_at : null;
  const heartbeatAgeMs = ageMs(heartbeatAt, nowMs);
  const latestActivityAt = getRunMostRecentActivityTs(input);
  const latestActivityAgeMs = ageMs(latestActivityAt, nowMs);
  const latestAttemptId = input.latestAttempt?.id ?? null;
  const latestAttemptStatus = input.latestAttempt?.status ?? null;
  const staleRunningAttempt =
    input.current?.run_status === "running" &&
    input.latestAttempt?.status === "running" &&
    latestActivityAgeMs !== null &&
    latestActivityAgeMs >= input.staleAfterMs &&
    (heartbeatAgeMs === null || heartbeatAgeMs >= input.staleAfterMs);

  if (staleRunningAttempt) {
    return {
      status: "stale_running_attempt",
      summary:
        latestAttemptId === null
          ? "Run is still marked running, but it has no fresh heartbeat or runtime activity."
          : `Run is still marked running, but attempt ${latestAttemptId} has no fresh heartbeat or runtime activity.`,
      likely_zombie: true,
      stale_after_ms: input.staleAfterMs,
      latest_attempt_id: latestAttemptId,
      latest_attempt_status: latestAttemptStatus,
      latest_activity_at: latestActivityAt,
      latest_activity_age_ms: latestActivityAgeMs,
      heartbeat_at: heartbeatAt,
      heartbeat_age_ms: heartbeatAgeMs
    };
  }

  if (!input.current) {
    return {
      status: "unknown",
      summary: "Run health is unavailable because current decision is missing.",
      likely_zombie: false,
      stale_after_ms: input.staleAfterMs,
      latest_attempt_id: latestAttemptId,
      latest_attempt_status: latestAttemptStatus,
      latest_activity_at: latestActivityAt,
      latest_activity_age_ms: latestActivityAgeMs,
      heartbeat_at: heartbeatAt,
      heartbeat_age_ms: heartbeatAgeMs
    };
  }

  if (input.current.run_status === "waiting_steer") {
    return {
      status: "waiting_steer",
      summary: input.current.blocking_reason ?? input.current.summary,
      likely_zombie: false,
      stale_after_ms: input.staleAfterMs,
      latest_attempt_id: latestAttemptId,
      latest_attempt_status: latestAttemptStatus,
      latest_activity_at: latestActivityAt,
      latest_activity_age_ms: latestActivityAgeMs,
      heartbeat_at: heartbeatAt,
      heartbeat_age_ms: heartbeatAgeMs
    };
  }

  if (input.current.run_status === "draft") {
    return {
      status: "draft",
      summary: input.current.summary,
      likely_zombie: false,
      stale_after_ms: input.staleAfterMs,
      latest_attempt_id: latestAttemptId,
      latest_attempt_status: latestAttemptStatus,
      latest_activity_at: latestActivityAt,
      latest_activity_age_ms: latestActivityAgeMs,
      heartbeat_at: heartbeatAt,
      heartbeat_age_ms: heartbeatAgeMs
    };
  }

  if (["completed", "failed", "cancelled"].includes(input.current.run_status)) {
    return {
      status: "settled",
      summary: input.current.summary,
      likely_zombie: false,
      stale_after_ms: input.staleAfterMs,
      latest_attempt_id: latestAttemptId,
      latest_attempt_status: latestAttemptStatus,
      latest_activity_at: latestActivityAt,
      latest_activity_age_ms: latestActivityAgeMs,
      heartbeat_at: heartbeatAt,
      heartbeat_age_ms: heartbeatAgeMs
    };
  }

  return {
    status: "healthy",
    summary: input.current.summary,
    likely_zombie: false,
    stale_after_ms: input.staleAfterMs,
    latest_attempt_id: latestAttemptId,
    latest_attempt_status: latestAttemptStatus,
    latest_activity_at: latestActivityAt,
    latest_activity_age_ms: latestActivityAgeMs,
    heartbeat_at: heartbeatAt,
    heartbeat_age_ms: heartbeatAgeMs
  };
}
