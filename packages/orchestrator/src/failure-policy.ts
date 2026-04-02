import {
  createRunFailureSignal,
  type Attempt,
  type AttemptAdversarialVerification,
  type AttemptHandoffBundle,
  type AttemptPreflightEvaluation,
  type AttemptRuntimeVerification,
  type CurrentDecision,
  type RunFailureSignal,
  type RunWorkingContextDegradedState
} from "@autoresearch/domain";

export function deriveFailureSignalFromPreflight(input: {
  preflight: AttemptPreflightEvaluation | null;
  sourceRef?: string | null;
}): RunFailureSignal | null {
  if (!input.preflight || input.preflight.status !== "failed") {
    return null;
  }

  return createRunFailureSignal({
    failure_class: input.preflight.failure_class ?? "preflight_blocked",
    policy_mode: input.preflight.failure_policy_mode ?? "fail_closed",
    source_kind: "preflight_evaluation",
    source_ref: input.sourceRef ?? null,
    failure_code: input.preflight.failure_code ?? null,
    summary:
      input.preflight.failure_reason ??
      `Preflight blocked attempt ${input.preflight.attempt_id}.`
  });
}

export function deriveFailureSignalFromRuntimeVerification(input: {
  verification: AttemptRuntimeVerification | null;
  sourceRef?: string | null;
}): RunFailureSignal | null {
  if (!input.verification || input.verification.status !== "failed") {
    return null;
  }

  return createRunFailureSignal({
    failure_class:
      input.verification.failure_class ?? "runtime_verification_failed",
    policy_mode: input.verification.failure_policy_mode ?? "fail_closed",
    source_kind: "runtime_verification",
    source_ref: input.sourceRef ?? null,
    failure_code: input.verification.failure_code ?? null,
    summary:
      input.verification.failure_reason ??
      `Runtime verification failed for attempt ${input.verification.attempt_id}.`
  });
}

export function deriveFailureSignalFromAdversarialVerification(input: {
  verification: AttemptAdversarialVerification | null;
  sourceRef?: string | null;
}): RunFailureSignal | null {
  if (!input.verification || input.verification.status !== "failed") {
    return null;
  }

  return createRunFailureSignal({
    failure_class:
      input.verification.failure_class ?? "adversarial_verification_failed",
    policy_mode: input.verification.failure_policy_mode ?? "fail_closed",
    source_kind: "adversarial_verification",
    source_ref: input.sourceRef ?? null,
    failure_code: input.verification.failure_code ?? null,
    summary:
      input.verification.failure_reason ??
      input.verification.summary ??
      `Adversarial verification failed for attempt ${input.verification.attempt_id}.`
  });
}

export function deriveFailureSignalFromHandoffBundle(input: {
  handoff: AttemptHandoffBundle | null;
  sourceRef?: string | null;
}): RunFailureSignal | null {
  if (!input.handoff) {
    return null;
  }

  if (input.handoff.failure_signal) {
    return createRunFailureSignal({
      ...input.handoff.failure_signal,
      source_ref: input.handoff.failure_signal.source_ref ?? input.sourceRef ?? null
    });
  }

  if (!input.handoff.failure_class) {
    return null;
  }

  return createRunFailureSignal({
    failure_class: input.handoff.failure_class,
    policy_mode: input.handoff.failure_policy_mode ?? "fail_closed",
    source_kind: "handoff_bundle",
    source_ref: input.sourceRef ?? null,
    failure_code:
      input.handoff.adversarial_failure_code ??
      input.handoff.failure_code ??
      null,
    summary:
      input.handoff.summary ??
      `Handoff bundle for attempt ${input.handoff.attempt_id} is incomplete.`
  });
}

export function deriveFailureSignalFromHandoffGap(input: {
  latestAttempt: Attempt | null;
  current: CurrentDecision | null;
  handoff: AttemptHandoffBundle | null;
  sourceRef?: string | null;
}): RunFailureSignal | null {
  if (input.handoff || !input.latestAttempt) {
    return null;
  }

  const attemptSettled =
    input.latestAttempt.status === "completed" ||
    input.latestAttempt.status === "failed" ||
    input.current?.waiting_for_human === true;
  if (!attemptSettled) {
    return null;
  }

  return createRunFailureSignal({
    failure_class: "handoff_incomplete",
    policy_mode: "fail_closed",
    source_kind: "handoff_bundle",
    source_ref: input.sourceRef ?? null,
    summary: `Attempt ${input.latestAttempt.id} settled without a handoff bundle.`
  });
}

export function deriveFailureSignalFromWorkingContext(input: {
  degraded: RunWorkingContextDegradedState;
  sourceRef?: string | null;
}): RunFailureSignal | null {
  if (!input.degraded.is_degraded) {
    return null;
  }

  return createRunFailureSignal({
    failure_class: "working_context_degraded",
    policy_mode: "soft_degrade",
    source_kind: "working_context",
    source_ref: input.sourceRef ?? null,
    failure_code: input.degraded.reason_code ?? null,
    summary:
      input.degraded.summary ?? "working context 已降级，当前现场不可信。"
  });
}

export function annotateRuntimeVerificationFailure(
  verification: AttemptRuntimeVerification
): AttemptRuntimeVerification {
  const signal = deriveFailureSignalFromRuntimeVerification({
    verification
  });

  return {
    ...verification,
    failure_class: signal?.failure_class ?? null,
    failure_policy_mode: signal?.policy_mode ?? null
  };
}

export function pickPrimaryFailureSignal(
  ...signals: Array<RunFailureSignal | null | undefined>
): RunFailureSignal | null {
  for (const signal of signals) {
    if (signal) {
      return signal;
    }
  }

  return null;
}
