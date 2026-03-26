import {
  AttemptEvaluationSchema,
  EvalResultSchema,
  isExecutionContractDraftReady,
  type Attempt,
  type AttemptEvaluation,
  type AttemptRuntimeVerification,
  type Branch,
  type EvalResult,
  type EvalSpec,
  type Goal,
  type Run,
  type WorkerWriteback
} from "@autoresearch/domain";

export function evaluateBranch(input: {
  goal: Goal;
  branch: Branch;
  writeback: WorkerWriteback;
  evalSpec: EvalSpec;
}): EvalResult {
  const findingsScore = Math.min(input.writeback.findings.length / 4, 1);
  const evidenceScore =
    input.writeback.findings.length === 0
      ? 0
      : input.writeback.findings.filter((finding) => finding.evidence.length > 0).length /
        input.writeback.findings.length;
  const nextStepScore = input.writeback.recommended_next_steps.length > 0 ? 1 : 0.2;
  const confidenceScore = input.writeback.confidence;
  const questionPenalty = input.writeback.questions.length > 3 ? 0.1 : 0;

  const totalScore = Math.max(
    0,
    Math.min(
      1,
      findingsScore * 0.35 +
        evidenceScore * 0.3 +
        nextStepScore * 0.15 +
        confidenceScore * 0.2 -
        questionPenalty
    )
  );

  const recommendation =
    totalScore >= input.evalSpec.keep_threshold
      ? "keep"
      : totalScore <= input.evalSpec.rerun_threshold
        ? "rerun"
        : "request_human_review";

  return EvalResultSchema.parse({
    goal_id: input.goal.id,
    branch_id: input.branch.id,
    score: totalScore,
    confidence: Math.min(1, (confidenceScore + evidenceScore) / 2),
    dimension_scores: {
      relevance: findingsScore,
      evidence_quality: evidenceScore,
      actionability: nextStepScore,
      cost_efficiency: confidenceScore
    },
    recommendation,
    rationale: `findings=${input.writeback.findings.length}, evidence_ratio=${evidenceScore.toFixed(
      2
    )}, confidence=${confidenceScore.toFixed(2)}`,
    created_at: new Date().toISOString()
  });
}

export function evaluateAttempt(input: {
  run: Run;
  attempt: Attempt;
  result: WorkerWriteback;
  runtimeVerification?: AttemptRuntimeVerification | null;
}): AttemptEvaluation {
  const findingsScore = Math.min(input.result.findings.length / 3, 1);
  const nextStepScore = input.result.recommended_next_steps.length > 0 ? 1 : 0;
  const evidenceQuality =
    input.result.findings.length === 0
      ? 0
      : input.result.findings.filter((finding) => finding.evidence.length > 0).length /
        input.result.findings.length;
  const confidenceScore = input.result.confidence;
  const artifactScore = Math.min(input.result.artifacts.length, 1);
  const openQuestionPenalty =
    input.result.questions.length >= 3 ? 0.15 : input.result.questions.length > 0 ? 0.05 : 0;
  const runtimeVerification = input.runtimeVerification ?? null;

  if (input.attempt.attempt_type === "research") {
    const hasExecutionContract = isExecutionContractDraftReady(
      input.result.next_attempt_contract
    );
    const goalProgress = Math.max(
      0,
      Math.min(
        1,
        findingsScore * 0.35 +
          evidenceQuality * 0.3 +
          confidenceScore * 0.2 +
          nextStepScore * 0.15 -
          openQuestionPenalty
      )
    );

    const hasExecutionLead =
      nextStepScore > 0 &&
      evidenceQuality >= 0.45 &&
      confidenceScore >= 0.45 &&
      hasExecutionContract;
    const recommendation = goalProgress < 0.35 ? "retry" : "continue";

    return AttemptEvaluationSchema.parse({
      attempt_id: input.attempt.id,
      run_id: input.run.id,
      goal_progress: goalProgress,
      evidence_quality: evidenceQuality,
      verification_status: "not_applicable",
      recommendation,
      suggested_attempt_type:
        recommendation === "retry"
          ? "research"
          : hasExecutionLead
            ? "execution"
            : "research",
      rationale: `goal_progress=${goalProgress.toFixed(2)}, evidence_quality=${evidenceQuality.toFixed(
        2
      )}, confidence=${confidenceScore.toFixed(2)}, next_steps=${input.result.recommended_next_steps.length}, execution_contract=${hasExecutionContract ? "ready" : "missing"}`,
      missing_evidence: buildMissingEvidence({
        attemptType: "research",
        evidenceQuality,
        nextStepScore,
        artifactScore,
        hasExecutionContract
      }),
      created_at: new Date().toISOString()
    });
  }

  const verificationStatus = runtimeVerification?.status === "passed" ? "passed" : "failed";
  const verifiedCommandScore =
    runtimeVerification?.status === "passed" && runtimeVerification.command_results.length > 0
      ? 1
      : 0;
  const workspaceChangeScore =
    runtimeVerification && runtimeVerification.changed_files.length > 0 ? 1 : 0;
  const rawGoalProgress = Math.max(
    0,
    Math.min(
      1,
      confidenceScore * 0.25 +
        evidenceQuality * 0.25 +
        verifiedCommandScore * 0.35 +
        workspaceChangeScore * 0.15 -
        openQuestionPenalty
    )
  );
  const goalProgress =
    verificationStatus === "passed" ? rawGoalProgress : Math.min(rawGoalProgress, 0.34);
  const recommendation =
    verificationStatus === "passed"
      ? goalProgress >= 0.75 && input.result.questions.length === 0
        ? "complete"
        : goalProgress >= 0.45
          ? "wait_human"
          : "retry"
      : runtimeVerification?.failure_code === "verification_command_failed"
        ? "continue"
        : "wait_human";
  const suggestedAttemptType =
    verificationStatus === "passed"
      ? recommendation === "complete"
        ? null
        : "execution"
      : runtimeVerification?.failure_code === "verification_command_failed"
        ? "research"
        : "execution";
  const missingEvidence = buildMissingEvidence({
    attemptType: "execution",
    evidenceQuality,
    nextStepScore,
    artifactScore,
    runtimeVerification
  });

  return AttemptEvaluationSchema.parse({
    attempt_id: input.attempt.id,
    run_id: input.run.id,
    goal_progress: goalProgress,
    evidence_quality: evidenceQuality,
    verification_status: verificationStatus,
    recommendation,
    suggested_attempt_type: suggestedAttemptType,
    rationale: [
      `goal_progress=${goalProgress.toFixed(2)}`,
      `evidence_quality=${evidenceQuality.toFixed(2)}`,
      `confidence=${confidenceScore.toFixed(2)}`,
      `artifacts=${input.result.artifacts.length}`,
      `runtime_verification=${runtimeVerification?.status ?? "missing"}`,
      runtimeVerification?.failure_code ? `failure_code=${runtimeVerification.failure_code}` : null
    ]
      .filter(Boolean)
      .join(", "),
    missing_evidence: missingEvidence,
    created_at: new Date().toISOString()
  });
}

function buildMissingEvidence(input: {
  attemptType: Attempt["attempt_type"];
  evidenceQuality: number;
  nextStepScore: number;
  artifactScore: number;
  hasExecutionContract?: boolean;
  runtimeVerification?: AttemptRuntimeVerification | null;
}): string[] {
  const missing: string[] = [];

  if (input.evidenceQuality < 0.45) {
    missing.push("Need stronger grounded evidence tied to files, commands, or artifacts.");
  }

  if (input.attemptType === "research" && input.nextStepScore === 0) {
    missing.push("Need a clearer next step that the loop can act on.");
  }

  if (
    input.attemptType === "research" &&
    input.nextStepScore > 0 &&
    input.hasExecutionContract === false
  ) {
    missing.push(
      "Need a replayable execution contract before the loop can start an execution attempt."
    );
  }

  if (
    input.attemptType === "execution" &&
    input.artifactScore === 0 &&
    input.runtimeVerification?.status !== "passed"
  ) {
    missing.push("Need execution artifacts from the workspace, not just a textual claim.");
  }

  if (input.attemptType === "execution" && input.runtimeVerification?.status !== "passed") {
    if (input.runtimeVerification?.failure_reason) {
      missing.push(input.runtimeVerification.failure_reason);
    } else {
      missing.push("Need runtime-replayed verification before execution can pass.");
    }
  }

  return missing;
}
