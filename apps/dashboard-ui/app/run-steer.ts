import { attemptTypeLabel, statusLabel } from "./copy";
import type { RunDetail } from "./dashboard-types";

export const RUN_STEER_NEXT_PICKUP_VALUE = "__next_pickup__";

export function createRunSteerTargetOptions(
  attempts: RunDetail["attempts"]
): Array<{
  value: string;
  label: string;
}> {
  return [
    {
      value: RUN_STEER_NEXT_PICKUP_VALUE,
      label: "应用到下一次 pickup"
    },
    ...attempts
      .slice()
      .reverse()
      .map((attempt) => ({
        value: attempt.id,
        label: `${attempt.id} · ${attemptTypeLabel(attempt.attempt_type)} · ${statusLabel(attempt.status)}`
      }))
  ];
}

export function defaultRunSteerAttemptId(latestAttemptId: string | null | undefined): string {
  return latestAttemptId ?? RUN_STEER_NEXT_PICKUP_VALUE;
}

export function normalizeRunSteerAttemptId(value: string | null | undefined): string | null {
  if (!value || value === RUN_STEER_NEXT_PICKUP_VALUE) {
    return null;
  }

  return value;
}
