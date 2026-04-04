import {
  createRunFailureSignal,
  type RunFailureClass,
  type RunFailurePolicyMode,
  type RunFailureSourceKind,
  type Attempt,
  type AttemptAdversarialVerification,
  type AttemptHandoffBundle,
  type AttemptPreflightEvaluation,
  type AttemptRuntimeVerification,
  type CurrentDecision,
  type RunBrief,
  type RunFailureSignal,
  type RunWorkingContextDegradedState
} from "@autoresearch/domain";

type RunBriefDegradedSurface = {
  is_degraded: boolean;
  reason_code: string | null;
  summary: string | null;
  source_ref: string | null;
};

export type RunFailurePolicyEntry = {
  failure_class: RunFailureClass;
  policy_mode: RunFailurePolicyMode;
  priority: number;
  summary: string;
};

const RUN_FAILURE_POLICY_MATRIX: ReadonlyArray<RunFailurePolicyEntry> = [
  {
    failure_class: "handoff_incomplete",
    policy_mode: "fail_closed",
    priority: 10,
    summary: "Settled attempts without a handoff bundle must stop the run."
  },
  {
    failure_class: "adversarial_verification_failed",
    policy_mode: "fail_closed",
    priority: 20,
    summary: "Failed postflight adversarial verification must stop automatic progress."
  },
  {
    failure_class: "runtime_verification_failed",
    policy_mode: "fail_closed",
    priority: 30,
    summary: "Failed deterministic replay must stop automatic progress."
  },
  {
    failure_class: "preflight_blocked",
    policy_mode: "fail_closed",
    priority: 40,
    summary: "Preflight blockers must fail closed before dispatch."
  },
  {
    failure_class: "working_context_degraded",
    policy_mode: "soft_degrade",
    priority: 50,
    summary: "Working context degradation can warn without rewriting mainline truth."
  },
  {
    failure_class: "run_brief_degraded",
    policy_mode: "soft_degrade",
    priority: 60,
    summary: "Run brief degradation can warn without rewriting mainline truth."
  }
];

const RUN_FAILURE_SOURCE_PRIORITY: Record<RunFailureSourceKind, number> = {
  preflight_evaluation: 10,
  runtime_verification: 20,
  adversarial_verification: 30,
  handoff_bundle: 40,
  working_context: 50,
  run_brief: 60
};

function getFailurePolicyEntry(failureClass: RunFailureClass): RunFailurePolicyEntry {
  const entry = RUN_FAILURE_POLICY_MATRIX.find(
    (candidate) => candidate.failure_class === failureClass
  );
  if (!entry) {
    throw new Error(`Unknown failure class in policy matrix: ${failureClass}`);
  }

  return entry;
}

export function getFailurePolicyMatrix(): ReadonlyArray<RunFailurePolicyEntry> {
  return RUN_FAILURE_POLICY_MATRIX;
}

function normalizePolicyMode(failureClass: RunFailureClass): RunFailurePolicyMode {
  return getFailurePolicyEntry(failureClass).policy_mode;
}

function normalizeFailureSignal(signal: RunFailureSignal): RunFailureSignal {
  return createRunFailureSignal({
    ...signal,
    policy_mode: normalizePolicyMode(signal.failure_class)
  });
}

export function deriveFailureSignalFromPreflight(input: {
  preflight: AttemptPreflightEvaluation | null;
  sourceRef?: string | null;
}): RunFailureSignal | null {
  if (!input.preflight || input.preflight.status !== "failed") {
    return null;
  }

  return createRunFailureSignal({
    failure_class: input.preflight.failure_class ?? "preflight_blocked",
    policy_mode: normalizePolicyMode(input.preflight.failure_class ?? "preflight_blocked"),
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
    policy_mode: normalizePolicyMode(
      input.verification.failure_class ?? "runtime_verification_failed"
    ),
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
    policy_mode: normalizePolicyMode(
      input.verification.failure_class ?? "adversarial_verification_failed"
    ),
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
    return normalizeFailureSignal(
      createRunFailureSignal({
        ...input.handoff.failure_signal,
        source_ref: input.handoff.failure_signal.source_ref ?? input.sourceRef ?? null
      })
    );
  }

  if (!input.handoff.failure_class) {
    return null;
  }

  return createRunFailureSignal({
    failure_class: input.handoff.failure_class,
    policy_mode: normalizePolicyMode(input.handoff.failure_class),
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
    policy_mode: normalizePolicyMode("handoff_incomplete"),
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
    policy_mode: normalizePolicyMode("working_context_degraded"),
    source_kind: "working_context",
    source_ref: input.sourceRef ?? null,
    failure_code: input.degraded.reason_code ?? null,
    summary:
      input.degraded.summary ?? "working context 已降级，当前现场不可信。"
  });
}

export function deriveFailureSignalFromRunBrief(input: {
  runBrief: RunBrief | null;
  sourceRef?: string | null;
}): RunFailureSignal | null {
  if (!input.runBrief?.failure_signal) {
    return null;
  }

  return normalizeFailureSignal(
    createRunFailureSignal({
      ...input.runBrief.failure_signal,
      source_ref: input.runBrief.failure_signal.source_ref ?? input.sourceRef ?? null
    })
  );
}

export function deriveFailureSignalFromRunBriefDegraded(input: {
  degraded?: RunBriefDegradedSurface | null;
  sourceRef?: string | null;
}): RunFailureSignal | null {
  if (!input.degraded?.is_degraded) {
    return null;
  }

  return createRunFailureSignal({
    failure_class: "run_brief_degraded",
    policy_mode: normalizePolicyMode("run_brief_degraded"),
    source_kind: "run_brief",
    source_ref: input.degraded.source_ref ?? input.sourceRef ?? null,
    failure_code: input.degraded.reason_code ?? null,
    summary: input.degraded.summary ?? "run brief 已降级。"
  });
}

export function deriveRunSurfaceFailureSignal(input: {
  latestAttempt: Attempt | null;
  current: CurrentDecision | null;
  runBrief?: RunBrief | null;
  runBriefRef?: string | null;
  runBriefDegraded?: RunBriefDegradedSurface | null;
  preflight: AttemptPreflightEvaluation | null;
  preflightRef?: string | null;
  runtimeVerification: AttemptRuntimeVerification | null;
  runtimeVerificationRef?: string | null;
  adversarialVerification: AttemptAdversarialVerification | null;
  adversarialVerificationRef?: string | null;
  handoff: AttemptHandoffBundle | null;
  handoffRef?: string | null;
  workingContextDegraded: RunWorkingContextDegradedState;
  workingContextRef?: string | null;
}): RunFailureSignal | null {
  const runBriefSignal =
    input.runBriefDegraded?.is_degraded
      ? null
      : deriveFailureSignalFromRunBrief({
          runBrief: input.runBrief ?? null,
          sourceRef: input.runBriefRef ?? null
        });

  return pickPrimaryFailureSignal(
    runBriefSignal,
    deriveFailureSignalFromHandoffBundle({
      handoff: input.handoff,
      sourceRef: input.handoffRef ?? null
    }),
    deriveFailureSignalFromAdversarialVerification({
      verification: input.adversarialVerification,
      sourceRef: input.adversarialVerificationRef ?? null
    }),
    deriveFailureSignalFromRuntimeVerification({
      verification: input.runtimeVerification,
      sourceRef: input.runtimeVerificationRef ?? null
    }),
    deriveFailureSignalFromPreflight({
      preflight: input.preflight,
      sourceRef: input.preflightRef ?? null
    }),
    deriveFailureSignalFromHandoffGap({
      latestAttempt: input.latestAttempt,
      current: input.current,
      handoff: input.handoff,
      sourceRef: input.latestAttempt ? input.handoffRef ?? null : null
    }),
    deriveFailureSignalFromWorkingContext({
      degraded: input.workingContextDegraded,
      sourceRef: input.workingContextRef ?? null
    }),
    deriveFailureSignalFromRunBriefDegraded({
      degraded: input.runBriefDegraded ?? null,
      sourceRef: input.runBriefRef ?? null
    })
  );
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
  const normalizedSignals = signals
    .filter((signal): signal is RunFailureSignal => signal !== null && signal !== undefined)
    .map((signal) => normalizeFailureSignal(signal))
    .sort((left, right) => {
      const failurePriorityDelta =
        getFailurePolicyEntry(left.failure_class).priority -
        getFailurePolicyEntry(right.failure_class).priority;

      if (failurePriorityDelta !== 0) {
        return failurePriorityDelta;
      }

      return (
        RUN_FAILURE_SOURCE_PRIORITY[left.source_kind] -
        RUN_FAILURE_SOURCE_PRIORITY[right.source_kind]
      );
    });

  return normalizedSignals[0] ?? null;
}
