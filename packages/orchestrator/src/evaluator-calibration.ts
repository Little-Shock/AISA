import {
  createAttemptEvaluatorCalibrationSample,
  createEvaluatorCalibrationCase,
  type Attempt,
  type AttemptAdversarialVerification,
  type AttemptEvaluatorCalibrationFailureMode,
  type AttemptEvaluatorCalibrationSample,
  type AttemptHandoffBundle,
  type AttemptPreflightEvaluation,
  type AttemptReviewPacket,
  type AttemptRuntimeVerification,
  type EvaluatorCalibrationCase
} from "@autoresearch/domain";

export const RUNTIME_RUN_LOOP_CALIBRATION_BUNDLE_REF =
  "evals/runtime-run-loop/calibration-bundle.json";
export const RUNTIME_RUN_LOOP_REVIEWER_PROMPT_VERSION =
  "runtime-run-loop-reviewer@v1";
export const RUNTIME_RUN_LOOP_VERIFIER_PROMPT_VERSION =
  "runtime-run-loop-verifier@v1";
export const RUNTIME_RUN_LOOP_DATASET_VERSION =
  "runtime-run-loop-online-samples@v1";

function buildFailureModeId(prefix: string, code: string | null | undefined): string {
  return `${prefix}.${code ?? "failed"}`;
}

function appendFailureMode(
  modes: AttemptEvaluatorCalibrationFailureMode[],
  nextMode: AttemptEvaluatorCalibrationFailureMode
): void {
  if (
    modes.some(
      (mode: AttemptEvaluatorCalibrationFailureMode) =>
        mode.id === nextMode.id &&
        mode.source_kind === nextMode.source_kind
    )
  ) {
    return;
  }

  modes.push(nextMode);
}

export function deriveAttemptEvaluatorCalibrationFailureModes(input: {
  preflightEvaluation?: AttemptPreflightEvaluation | null;
  preflightEvaluationRef?: string | null;
  reviewPacket?: AttemptReviewPacket | null;
  reviewPacketRef?: string | null;
  runtimeVerification?: AttemptRuntimeVerification | null;
  runtimeVerificationRef?: string | null;
  adversarialVerification?: AttemptAdversarialVerification | null;
  adversarialVerificationRef?: string | null;
  handoffBundle?: AttemptHandoffBundle | null;
  handoffBundleRef?: string | null;
}): AttemptEvaluatorCalibrationFailureMode[] {
  const modes: AttemptEvaluatorCalibrationFailureMode[] = [];

  if (input.preflightEvaluation?.status === "failed") {
    appendFailureMode(modes, {
      id: buildFailureModeId("preflight", input.preflightEvaluation.failure_code),
      source_kind: "preflight_evaluation",
      source_ref: input.preflightEvaluationRef ?? null,
      observed_failure_code: input.preflightEvaluation.failure_code ?? null,
      summary:
        input.preflightEvaluation.failure_reason ??
        `Preflight blocked attempt ${input.preflightEvaluation.attempt_id}.`
    });
  }

  if (input.runtimeVerification?.status === "failed") {
    appendFailureMode(modes, {
      id: buildFailureModeId("runtime", input.runtimeVerification.failure_code),
      source_kind: "runtime_verification",
      source_ref: input.runtimeVerificationRef ?? null,
      observed_failure_code: input.runtimeVerification.failure_code ?? null,
      summary:
        input.runtimeVerification.failure_reason ??
        `Runtime verification failed for attempt ${input.runtimeVerification.attempt_id}.`
    });
  }

  if (input.adversarialVerification?.status === "failed") {
    appendFailureMode(modes, {
      id: buildFailureModeId(
        "adversarial",
        input.adversarialVerification.failure_code ??
          input.adversarialVerification.verdict
      ),
      source_kind: "adversarial_verification",
      source_ref: input.adversarialVerificationRef ?? null,
      observed_failure_code: input.adversarialVerification.failure_code ?? null,
      summary:
        input.adversarialVerification.failure_reason ??
        input.adversarialVerification.summary ??
        `Adversarial verification failed for attempt ${input.adversarialVerification.attempt_id}.`
    });
  }

  if (input.handoffBundle?.failure_code) {
    appendFailureMode(modes, {
      id: buildFailureModeId("handoff", input.handoffBundle.failure_code),
      source_kind: "handoff_bundle",
      source_ref: input.handoffBundleRef ?? null,
      observed_failure_code: input.handoffBundle.failure_code,
      summary:
        input.handoffBundle.summary ??
        `Handoff bundle preserved failure code ${input.handoffBundle.failure_code}.`
    });
  }

  if (modes.length === 0 && input.reviewPacket?.failure_context) {
    appendFailureMode(modes, {
      id: "review_packet.failure_context_present",
      source_kind: "review_packet",
      source_ref: input.reviewPacketRef ?? null,
      observed_failure_code: null,
      summary: input.reviewPacket.failure_context.message
    });
  }

  return modes;
}

export function buildAttemptEvaluatorCalibrationSample(input: {
  attempt: Attempt;
  preflightEvaluation?: AttemptPreflightEvaluation | null;
  preflightEvaluationRef?: string | null;
  reviewPacket?: AttemptReviewPacket | null;
  reviewPacketRef?: string | null;
  runtimeVerification?: AttemptRuntimeVerification | null;
  runtimeVerificationRef?: string | null;
  adversarialVerification?: AttemptAdversarialVerification | null;
  adversarialVerificationRef?: string | null;
  handoffBundle?: AttemptHandoffBundle | null;
  handoffBundleRef?: string | null;
}): AttemptEvaluatorCalibrationSample {
  const derivedFailureModes = deriveAttemptEvaluatorCalibrationFailureModes(input);
  const recommendedNextAction =
    input.handoffBundle?.recommended_next_action ??
    input.reviewPacket?.current_decision_snapshot?.recommended_next_action ??
    null;
  const summary =
    input.handoffBundle?.summary ??
    input.reviewPacket?.failure_context?.message ??
    input.preflightEvaluation?.failure_reason ??
    input.adversarialVerification?.failure_reason ??
    input.adversarialVerification?.summary ??
    input.runtimeVerification?.failure_reason ??
    input.reviewPacket?.evaluation?.rationale ??
    `Attempt ${input.attempt.id} settled and is ready for calibration export.`;

  return createAttemptEvaluatorCalibrationSample({
    sample_id: `cal_${input.attempt.id}`,
    run_id: input.attempt.run_id,
    attempt_id: input.attempt.id,
    attempt_type: input.attempt.attempt_type,
    attempt_status: input.attempt.status,
    verifier_kit:
      input.runtimeVerification?.verifier_kit ??
      input.adversarialVerification?.verifier_kit ??
      input.handoffBundle?.runtime_verification?.verifier_kit ??
      input.handoffBundle?.adversarial_verification?.verifier_kit ??
      null,
    failure_class:
      input.handoffBundle?.failure_class ??
      input.adversarialVerification?.failure_class ??
      input.runtimeVerification?.failure_class ??
      input.preflightEvaluation?.failure_class ??
      null,
    failure_policy_mode:
      input.handoffBundle?.failure_policy_mode ??
      input.adversarialVerification?.failure_policy_mode ??
      input.runtimeVerification?.failure_policy_mode ??
      input.preflightEvaluation?.failure_policy_mode ??
      null,
    failure_code:
      input.handoffBundle?.failure_code ??
      input.adversarialVerification?.failure_code ??
      input.runtimeVerification?.failure_code ??
      input.preflightEvaluation?.failure_code ??
      null,
    adversarial_failure_code:
      input.handoffBundle?.adversarial_failure_code ??
      input.adversarialVerification?.failure_code ??
      null,
    recommended_next_action: recommendedNextAction,
    summary,
    derived_failure_modes: derivedFailureModes,
    source_refs: {
      preflight_evaluation: input.preflightEvaluationRef ?? null,
      review_packet: input.reviewPacketRef ?? null,
      runtime_verification: input.runtimeVerificationRef ?? null,
      adversarial_verification: input.adversarialVerificationRef ?? null,
      handoff_bundle: input.handoffBundleRef ?? null
    },
    calibration_bundle: {
      bundle_ref: RUNTIME_RUN_LOOP_CALIBRATION_BUNDLE_REF,
      reviewer_prompt_version: RUNTIME_RUN_LOOP_REVIEWER_PROMPT_VERSION,
      verifier_prompt_version: RUNTIME_RUN_LOOP_VERIFIER_PROMPT_VERSION,
      dataset_version: RUNTIME_RUN_LOOP_DATASET_VERSION
    }
  });
}

export function buildOnlineEvaluatorCalibrationCase(
  sample: AttemptEvaluatorCalibrationSample
): EvaluatorCalibrationCase {
  return createEvaluatorCalibrationCase({
    case_id: `online-${sample.sample_id}`,
    label: "online_failure",
    summary: sample.summary,
    sample,
    expected_failure_mode_ids: sample.derived_failure_modes.map(
      (mode: AttemptEvaluatorCalibrationFailureMode) => mode.id
    ),
    notes: [`synced from ${sample.run_id}/${sample.attempt_id}`]
  });
}
