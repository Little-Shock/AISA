import { EvalResultSchema, type Branch, type EvalResult, type EvalSpec, type Goal, type WorkerWriteback } from "@autoresearch/domain";

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
