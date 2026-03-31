import { spawn } from "node:child_process";
import {
  AttemptContractDraftSchema,
  AttemptEvaluationSchema,
  AttemptEvaluationSynthesisRecordSchema,
  AttemptReviewerJudgmentSchema,
  AttemptReviewerOpinionSchema,
  EvalResultSchema,
  createEntityId,
  isExecutionContractDraftReady,
  type AttemptContractDraft,
  type AttemptEvaluation,
  type AttemptEvaluationSynthesisRecord,
  type AttemptReviewInputPacket,
  type AttemptReviewInputRef,
  type AttemptRuntimeVerification,
  type AttemptReviewPacket,
  type AttemptReviewerIdentity,
  type AttemptReviewerJudgment,
  type AttemptReviewerOpinion,
  type AttemptSynthesizerIdentity,
  type Branch,
  type EvalResult,
  type EvalSpec,
  type Goal,
  type WorkerWriteback
} from "@autoresearch/domain";

type ReviewableAttemptPacket = AttemptReviewInputPacket | AttemptReviewPacket;
const REVIEWER_CONFIG_ENV = "AISA_REVIEWERS_JSON";
const SYNTHESIZER_CONFIG_ENV = "AISA_REVIEW_SYNTHESIZER_JSON";
const DEFAULT_CLI_REVIEWER_TIMEOUT_MS = 60_000;
const DEFAULT_CLI_SYNTHESIZER_TIMEOUT_MS = 90_000;

export interface AttemptReviewerAdapter {
  readonly reviewer: AttemptReviewerIdentity;
  reviewAttempt(input: {
    reviewInputPacket: AttemptReviewInputPacket;
  }): Promise<{
    raw_output: string;
    structured_judgment: AttemptReviewerJudgment;
    proposed_next_contract?: AttemptContractDraft | null;
  }>;
}

export type HeuristicAttemptReviewerConfig = {
  kind: "heuristic";
  reviewer_id?: string;
  role?: string;
  adapter?: string;
  provider?: string | null;
  model?: string | null;
};

export type CliAttemptReviewerConfig = {
  kind: "cli";
  reviewer_id: string;
  role: string;
  adapter?: string;
  provider?: string | null;
  model?: string | null;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  timeout_ms?: number;
};

export type AttemptReviewerConfig =
  | HeuristicAttemptReviewerConfig
  | CliAttemptReviewerConfig;

export interface AttemptEvaluationSynthesizerAdapter {
  readonly kind: "deterministic" | "cli";
  readonly synthesizer: AttemptSynthesizerIdentity | null;
  synthesizeEvaluation(input: {
    reviewInputPacket: AttemptReviewInputPacket;
    reviewInputPacketRef: string;
    opinions: AttemptReviewerOpinion[];
    opinionRefs: string[];
    deterministicBaseEvaluation: AttemptEvaluation;
  }): Promise<{
    raw_output: string;
    structured_judgment: AttemptReviewerJudgment;
  }>;
}

export type DeterministicAttemptEvaluationSynthesizerConfig = {
  kind: "deterministic";
};

export type CliAttemptEvaluationSynthesizerConfig = {
  kind: "cli";
  synthesizer_id: string;
  role: string;
  adapter?: string;
  provider?: string | null;
  model?: string | null;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  timeout_ms?: number;
};

export type AttemptEvaluationSynthesizerConfig =
  | DeterministicAttemptEvaluationSynthesizerConfig
  | CliAttemptEvaluationSynthesizerConfig;

export type AttemptEvaluationSynthesisOutcome = {
  evaluation: AttemptEvaluation;
  synthesisRecord: AttemptEvaluationSynthesisRecord | null;
};

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
      : input.writeback.findings.filter(
          (finding: WorkerWriteback["findings"][number]) => finding.evidence.length > 0
        ).length / input.writeback.findings.length;
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
  reviewPacket: AttemptReviewPacket;
}): AttemptEvaluation {
  return buildAttemptEvaluationBase({
    reviewPacket: input.reviewPacket
  });
}

export function createHeuristicAttemptReviewer(input: {
  reviewer_id?: string;
  role?: string;
  adapter?: string;
  provider?: string | null;
  model?: string | null;
} = {}): AttemptReviewerAdapter {
  const reviewer: AttemptReviewerIdentity = {
    reviewer_id: input.reviewer_id ?? "heuristic-reviewer",
    role: input.role ?? "runtime_reviewer",
    adapter: input.adapter ?? "deterministic-heuristic",
    provider: input.provider ?? null,
    model: input.model ?? null
  };

  return {
    reviewer,
    async reviewAttempt({ reviewInputPacket }) {
      const structuredJudgment = buildHeuristicReviewerJudgment(reviewInputPacket);
      const proposedNextContract = reviewInputPacket.result?.next_attempt_contract ?? null;

      return {
        raw_output: JSON.stringify(
          {
            reviewer,
            structured_judgment: structuredJudgment,
            proposed_next_contract: proposedNextContract
          },
          null,
          2
        ),
        structured_judgment: structuredJudgment,
        proposed_next_contract: proposedNextContract
      };
    }
  };
}

export function createCliAttemptReviewer(
  input: CliAttemptReviewerConfig
): AttemptReviewerAdapter {
  const reviewer: AttemptReviewerIdentity = {
    reviewer_id: input.reviewer_id,
    role: input.role,
    adapter: input.adapter ?? "cli-json-stdio",
    provider: input.provider ?? null,
    model: input.model ?? null
  };

  return {
    reviewer,
    async reviewAttempt({ reviewInputPacket }) {
      const commandResult = await runCliJsonCommand({
        command: input.command,
        args: input.args ?? [],
        cwd: input.cwd ?? process.cwd(),
        env: {
          ...buildCliReviewerEnv(input),
          ...(input.env ?? {})
        },
        timeoutMs: input.timeout_ms ?? DEFAULT_CLI_REVIEWER_TIMEOUT_MS,
        stdin: JSON.stringify(reviewInputPacket, null, 2)
      });
      const parsedOutput = parseCliReviewerOutput(commandResult.stdout, reviewer.reviewer_id);

      return {
        raw_output: commandResult.stdout,
        structured_judgment: parsedOutput.structured_judgment,
        proposed_next_contract: parsedOutput.proposed_next_contract
      };
    }
  };
}

export function createDeterministicAttemptEvaluationSynthesizer(): AttemptEvaluationSynthesizerAdapter {
  return {
    kind: "deterministic",
    synthesizer: null,
    async synthesizeEvaluation({
      opinions,
      deterministicBaseEvaluation
    }) {
      const structuredJudgment = buildDeterministicSynthesisJudgment({
        baseEvaluation: deterministicBaseEvaluation,
        opinions
      });

      return {
        raw_output: JSON.stringify(
          {
            strategy: buildDeterministicSynthesisStrategy(opinions.length),
            structured_judgment: structuredJudgment
          },
          null,
          2
        ),
        structured_judgment: structuredJudgment
      };
    }
  };
}

export function createCliAttemptEvaluationSynthesizer(
  input: CliAttemptEvaluationSynthesizerConfig
): AttemptEvaluationSynthesizerAdapter {
  const synthesizer: AttemptSynthesizerIdentity = {
    synthesizer_id: input.synthesizer_id,
    role: input.role,
    adapter: input.adapter ?? "cli-json-stdio",
    provider: input.provider ?? null,
    model: input.model ?? null
  };

  return {
    kind: "cli",
    synthesizer,
    async synthesizeEvaluation({
      reviewInputPacket,
      reviewInputPacketRef,
      opinions,
      opinionRefs,
      deterministicBaseEvaluation
    }) {
      const commandResult = await runCliJsonCommand({
        command: input.command,
        args: input.args ?? [],
        cwd: input.cwd ?? process.cwd(),
        env: {
          ...buildCliSynthesizerEnv(input),
          ...(input.env ?? {})
        },
        timeoutMs: input.timeout_ms ?? DEFAULT_CLI_SYNTHESIZER_TIMEOUT_MS,
        stdin: JSON.stringify(
          {
            review_input_packet: reviewInputPacket,
            review_input_packet_ref: reviewInputPacketRef,
            reviewer_opinions: opinions,
            opinion_refs: opinionRefs,
            deterministic_base_evaluation: deterministicBaseEvaluation
          },
          null,
          2
        )
      });
      const parsedOutput = parseCliSynthesizerOutput(
        commandResult.stdout,
        synthesizer.synthesizer_id
      );

      return {
        raw_output: commandResult.stdout,
        structured_judgment: parsedOutput.structured_judgment
      };
    }
  };
}

export function createAttemptReviewerAdapters(input: {
  configs?: AttemptReviewerConfig[] | null;
  env?: NodeJS.ProcessEnv;
} = {}): AttemptReviewerAdapter[] {
  if (input.configs) {
    if (input.configs.length === 0) {
      throw new Error("Reviewer config list cannot be empty.");
    }

    return input.configs.map((config) => createAttemptReviewerAdapter(config));
  }

  const envConfigs = loadAttemptReviewerConfigs(input.env ?? process.env);
  if (!envConfigs) {
    return [createHeuristicAttemptReviewer()];
  }

  return envConfigs.map((config) => createAttemptReviewerAdapter(config));
}

export function loadAttemptReviewerConfigs(
  env: NodeJS.ProcessEnv
): AttemptReviewerConfig[] | null {
  const raw = env[REVIEWER_CONFIG_ENV];
  if (!raw || raw.trim().length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${REVIEWER_CONFIG_ENV} must be valid JSON: ${reason}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${REVIEWER_CONFIG_ENV} must be a JSON array.`);
  }

  if (parsed.length === 0) {
    throw new Error(`${REVIEWER_CONFIG_ENV} must contain at least one reviewer config.`);
  }

  return parsed.map((entry, index) => parseAttemptReviewerConfig(entry, index));
}

export function createAttemptEvaluationSynthesizer(input: {
  config?: AttemptEvaluationSynthesizerConfig | null;
  env?: NodeJS.ProcessEnv;
} = {}): AttemptEvaluationSynthesizerAdapter {
  const config =
    input.config ?? loadAttemptEvaluationSynthesizerConfig(input.env ?? process.env);

  if (!config || config.kind === "deterministic") {
    return createDeterministicAttemptEvaluationSynthesizer();
  }

  return createCliAttemptEvaluationSynthesizer(config);
}

export function loadAttemptEvaluationSynthesizerConfig(
  env: NodeJS.ProcessEnv
): AttemptEvaluationSynthesizerConfig | null {
  const raw = env[SYNTHESIZER_CONFIG_ENV];
  if (!raw || raw.trim().length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${SYNTHESIZER_CONFIG_ENV} must be valid JSON: ${reason}`);
  }

  return parseAttemptEvaluationSynthesizerConfig(parsed);
}

export async function runAttemptReviewerPipeline(input: {
  reviewInputPacket: AttemptReviewInputPacket;
  reviewers: AttemptReviewerAdapter[];
  reviewInputPacketRef: string;
  inputRefs: AttemptReviewInputRef[];
}): Promise<AttemptReviewerOpinion[]> {
  return await Promise.all(
    input.reviewers.map(async (reviewerAdapter) => {
      const opinion = await reviewerAdapter.reviewAttempt({
        reviewInputPacket: input.reviewInputPacket
      });

      return AttemptReviewerOpinionSchema.parse({
        opinion_id: createEntityId("opinion"),
        run_id: input.reviewInputPacket.run_id,
        attempt_id: input.reviewInputPacket.attempt_id,
        reviewer: reviewerAdapter.reviewer,
        review_input_packet_ref: input.reviewInputPacketRef,
        input_refs: input.inputRefs,
        raw_output: opinion.raw_output,
        structured_judgment: opinion.structured_judgment,
        proposed_next_contract: opinion.proposed_next_contract ?? null,
        created_at: new Date().toISOString()
      });
    })
  );
}

export async function synthesizeAttemptEvaluation(input: {
  reviewInputPacket: AttemptReviewInputPacket;
  opinions: AttemptReviewerOpinion[];
  reviewInputPacketRef: string;
  opinionRefs: string[];
  synthesizer?: AttemptEvaluationSynthesizerAdapter | null;
  synthesizerConfig?: AttemptEvaluationSynthesizerConfig | null;
  synthesizerEnv?: NodeJS.ProcessEnv;
}): Promise<AttemptEvaluationSynthesisOutcome> {
  const baseEvaluation = buildAttemptEvaluationBase({
    reviewPacket: input.reviewInputPacket
  });
  const synthesizer =
    input.synthesizer ??
    createAttemptEvaluationSynthesizer({
      config: input.synthesizerConfig,
      env: input.synthesizerEnv ?? process.env
    });
  const synthesis = await synthesizer.synthesizeEvaluation({
    reviewInputPacket: input.reviewInputPacket,
    reviewInputPacketRef: input.reviewInputPacketRef,
    opinions: input.opinions,
    opinionRefs: input.opinionRefs,
    deterministicBaseEvaluation: baseEvaluation
  });
  const evaluationSynthesisRef =
    synthesizer.kind === "cli"
      ? buildAttemptEvaluationSynthesisRef(
          input.reviewInputPacket.run_id,
          input.reviewInputPacket.attempt_id
        )
      : null;

  return {
    evaluation: buildSynthesizedAttemptEvaluation({
      baseEvaluation,
      structuredJudgment: synthesis.structured_judgment,
      reviewInputPacketRef: input.reviewInputPacketRef,
      opinionRefs: input.opinionRefs,
      opinionCount: input.opinions.length,
      evaluationSynthesisRef,
      synthesisStrategy:
        synthesizer.kind === "cli"
          ? "cli_synthesizer_v1"
          : buildDeterministicSynthesisStrategy(input.opinions.length),
      synthesizerIdentity: synthesizer.synthesizer
    }),
    synthesisRecord:
      synthesizer.kind === "cli" && synthesizer.synthesizer
        ? AttemptEvaluationSynthesisRecordSchema.parse({
            run_id: input.reviewInputPacket.run_id,
            attempt_id: input.reviewInputPacket.attempt_id,
            synthesizer: synthesizer.synthesizer,
            review_input_packet_ref: input.reviewInputPacketRef,
            opinion_refs: input.opinionRefs,
            deterministic_base_evaluation: baseEvaluation,
            raw_output: synthesis.raw_output,
            structured_judgment: synthesis.structured_judgment,
            created_at: new Date().toISOString()
          })
        : null
  };
}

function buildHeuristicReviewerJudgment(
  reviewInputPacket: AttemptReviewInputPacket
): AttemptReviewerJudgment {
  const evaluation = buildAttemptEvaluationBase({
    reviewPacket: reviewInputPacket
  });

  return AttemptReviewerJudgmentSchema.parse({
    goal_progress: evaluation.goal_progress,
    evidence_quality: evaluation.evidence_quality,
    verification_status: evaluation.verification_status,
    recommendation: evaluation.recommendation,
    suggested_attempt_type: evaluation.suggested_attempt_type,
    rationale: evaluation.rationale,
    missing_evidence: evaluation.missing_evidence
  });
}

function buildDeterministicSynthesisJudgment(input: {
  baseEvaluation: AttemptEvaluation;
  opinions: AttemptReviewerOpinion[];
}): AttemptReviewerJudgment {
  const judgments = input.opinions.map((opinion) => opinion.structured_judgment);
  const verificationLocked = input.baseEvaluation.verification_status === "failed";
  const goalProgress =
    judgments.length > 0
      ? clampUnit(average(judgments.map((judgment) => judgment.goal_progress)))
      : input.baseEvaluation.goal_progress;
  const evidenceQuality =
    judgments.length > 0
      ? clampUnit(average(judgments.map((judgment) => judgment.evidence_quality)))
      : input.baseEvaluation.evidence_quality;

  return AttemptReviewerJudgmentSchema.parse({
    goal_progress: verificationLocked
      ? Math.min(input.baseEvaluation.goal_progress, goalProgress, 0.34)
      : goalProgress,
    evidence_quality: evidenceQuality,
    verification_status: input.baseEvaluation.verification_status,
    recommendation: verificationLocked
      ? input.baseEvaluation.recommendation
      : pickMajorityValue(
          judgments.map((judgment) => judgment.recommendation),
          input.baseEvaluation.recommendation
        ),
    suggested_attempt_type: verificationLocked
      ? input.baseEvaluation.suggested_attempt_type
      : pickMajorityValue(
          judgments.map((judgment) => judgment.suggested_attempt_type),
          input.baseEvaluation.suggested_attempt_type
        ),
    rationale: [
      input.baseEvaluation.rationale,
      `reviewers=${input.opinions.length}`,
      input.opinions.length > 0
        ? `reviewer_recommendations=${buildRecommendationSummary(judgments)}`
        : null
    ]
      .filter(Boolean)
      .join(", "),
    missing_evidence: uniqueStrings([
      ...input.baseEvaluation.missing_evidence,
      ...judgments.flatMap((judgment) => judgment.missing_evidence)
    ])
  });
}

function buildSynthesizedAttemptEvaluation(input: {
  baseEvaluation: AttemptEvaluation;
  structuredJudgment: AttemptReviewerJudgment;
  reviewInputPacketRef: string;
  opinionRefs: string[];
  opinionCount: number;
  evaluationSynthesisRef: string | null;
  synthesisStrategy: string;
  synthesizerIdentity: AttemptSynthesizerIdentity | null;
}): AttemptEvaluation {
  const verificationLocked = input.baseEvaluation.verification_status === "failed";

  return AttemptEvaluationSchema.parse({
    ...input.baseEvaluation,
    goal_progress: verificationLocked
      ? Math.min(
          input.baseEvaluation.goal_progress,
          clampUnit(input.structuredJudgment.goal_progress),
          0.34
        )
      : clampUnit(input.structuredJudgment.goal_progress),
    evidence_quality: clampUnit(input.structuredJudgment.evidence_quality),
    verification_status: input.baseEvaluation.verification_status,
    recommendation: verificationLocked
      ? input.baseEvaluation.recommendation
      : input.structuredJudgment.recommendation,
    suggested_attempt_type: verificationLocked
      ? input.baseEvaluation.suggested_attempt_type
      : input.structuredJudgment.suggested_attempt_type,
    rationale: buildSynthesizedEvaluationRationale({
      baseRationale: input.baseEvaluation.rationale,
      synthesisRationale: input.structuredJudgment.rationale,
      opinionCount: input.opinionCount,
      synthesisStrategy: input.synthesisStrategy,
      synthesizerIdentity: input.synthesizerIdentity
    }),
    missing_evidence: uniqueStrings([
      ...input.baseEvaluation.missing_evidence,
      ...input.structuredJudgment.missing_evidence
    ]),
    review_input_packet_ref: input.reviewInputPacketRef,
    opinion_refs: input.opinionRefs,
    evaluation_synthesis_ref: input.evaluationSynthesisRef,
    synthesis_strategy: input.synthesisStrategy,
    synthesizer: input.synthesizerIdentity,
    reviewer_count: input.opinionCount,
    created_at: new Date().toISOString()
  });
}

function buildSynthesizedEvaluationRationale(input: {
  baseRationale: string;
  synthesisRationale: string;
  opinionCount: number;
  synthesisStrategy: string;
  synthesizerIdentity: AttemptSynthesizerIdentity | null;
}): string {
  return [
    input.baseRationale,
    `reviewers=${input.opinionCount}`,
    input.synthesizerIdentity
      ? `synthesizer=${input.synthesizerIdentity.synthesizer_id}/${input.synthesisStrategy}`
      : `synthesizer=${input.synthesisStrategy}`,
    input.synthesisRationale
  ]
    .filter(Boolean)
    .join(", ");
}

function buildDeterministicSynthesisStrategy(opinionCount: number): string {
  return opinionCount > 1
    ? "deterministic_consensus_v1"
    : opinionCount === 1
      ? "deterministic_single_reviewer_v1"
      : "deterministic_fallback_v1";
}

function buildAttemptEvaluationSynthesisRef(runId: string, attemptId: string): string {
  return `runs/${runId}/attempts/${attemptId}/evaluation_synthesis.json`;
}

function buildAttemptEvaluationBase(input: {
  reviewPacket: ReviewableAttemptPacket;
}): AttemptEvaluation {
  const attempt = input.reviewPacket.attempt;
  const result = input.reviewPacket.result;
  const runtimeVerification = input.reviewPacket.runtime_verification ?? null;

  if (attempt.status !== "completed") {
    throw new Error(
      `Attempt ${attempt.id} must be completed before judge evaluation can read its review packet.`
    );
  }

  if (!result) {
    throw new Error(`Attempt ${attempt.id} review packet is missing result payload.`);
  }

  if (!runtimeVerification) {
    throw new Error(
      `Attempt ${attempt.id} review packet is missing runtime verification evidence.`
    );
  }

  const findingsScore = Math.min(result.findings.length / 3, 1);
  const nextStepScore = result.recommended_next_steps.length > 0 ? 1 : 0;
  const evidenceQuality =
    result.findings.length === 0
      ? 0
      : result.findings.filter(
          (finding: WorkerWriteback["findings"][number]) => finding.evidence.length > 0
        ).length / result.findings.length;
  const confidenceScore = result.confidence;
  const artifactScore = Math.min(result.artifacts.length, 1);
  const openQuestionPenalty =
    result.questions.length >= 3 ? 0.15 : result.questions.length > 0 ? 0.05 : 0;

  if (attempt.attempt_type === "research") {
    const requestedExecutionAttempt =
      result.next_attempt_contract?.attempt_type === "execution";
    const hasExecutionContract = isExecutionContractDraftReady(result.next_attempt_contract);
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
      requestedExecutionAttempt;
    const recommendation = goalProgress < 0.35 ? "retry" : "continue";

    return AttemptEvaluationSchema.parse({
      attempt_id: attempt.id,
      run_id: input.reviewPacket.run_id,
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
      )}, confidence=${confidenceScore.toFixed(2)}, next_steps=${result.recommended_next_steps.length}, execution_contract=${hasExecutionContract ? "ready" : requestedExecutionAttempt ? "incomplete" : "missing"}`,
      missing_evidence: buildMissingEvidence({
        attemptType: "research",
        evidenceQuality,
        nextStepScore,
        artifactScore,
        hasExecutionContract
      }),
      review_input_packet_ref: null,
      opinion_refs: [],
      synthesis_strategy: "legacy_single_judge",
      reviewer_count: 0,
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
  const hasConcreteNextStep = result.recommended_next_steps.length > 0;
  const recommendation =
    verificationStatus === "passed"
      ? hasConcreteNextStep
        ? "continue"
        : goalProgress >= 0.75 && result.questions.length === 0
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
    attempt_id: attempt.id,
    run_id: input.reviewPacket.run_id,
    goal_progress: goalProgress,
    evidence_quality: evidenceQuality,
    verification_status: verificationStatus,
    recommendation,
    suggested_attempt_type: suggestedAttemptType,
    rationale: [
      `goal_progress=${goalProgress.toFixed(2)}`,
      `evidence_quality=${evidenceQuality.toFixed(2)}`,
      `confidence=${confidenceScore.toFixed(2)}`,
      `artifacts=${result.artifacts.length}`,
      `runtime_verification=${runtimeVerification?.status ?? "missing"}`,
      runtimeVerification?.failure_code ? `failure_code=${runtimeVerification.failure_code}` : null
    ]
      .filter(Boolean)
      .join(", "),
    missing_evidence: missingEvidence,
    review_input_packet_ref: null,
    opinion_refs: [],
    synthesis_strategy: "legacy_single_judge",
    reviewer_count: 0,
    created_at: new Date().toISOString()
  });
}

function buildMissingEvidence(input: {
  attemptType: ReviewableAttemptPacket["attempt"]["attempt_type"];
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

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function pickMajorityValue<T extends string | null>(values: T[], fallback: T): T {
  if (values.length === 0) {
    return fallback;
  }

  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  let winner = fallback;
  let winnerCount = -1;

  for (const value of values) {
    const count = counts.get(value) ?? 0;
    if (count > winnerCount) {
      winner = value;
      winnerCount = count;
    }
  }

  return winner;
}

function buildRecommendationSummary(judgments: AttemptReviewerJudgment[]): string {
  const counts = new Map<AttemptReviewerJudgment["recommendation"], number>();

  for (const judgment of judgments) {
    counts.set(judgment.recommendation, (counts.get(judgment.recommendation) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([recommendation, count]) => `${recommendation}:${count}`)
    .join("|");
}

function createAttemptReviewerAdapter(
  config: AttemptReviewerConfig
): AttemptReviewerAdapter {
  return config.kind === "cli"
    ? createCliAttemptReviewer(config)
    : createHeuristicAttemptReviewer(config);
}

function buildCliReviewerEnv(input: CliAttemptReviewerConfig): Record<string, string> {
  return {
    AISA_CLI_REVIEWER_ID: input.reviewer_id,
    AISA_CLI_REVIEWER_ROLE: input.role,
    AISA_CLI_REVIEWER_ADAPTER: input.adapter ?? "cli-json-stdio",
    ...(input.provider ? { AISA_CLI_REVIEWER_PROVIDER: input.provider } : {}),
    ...(input.model ? { AISA_CLI_REVIEWER_MODEL: input.model } : {})
  };
}

function buildCliSynthesizerEnv(
  input: CliAttemptEvaluationSynthesizerConfig
): Record<string, string> {
  return {
    AISA_CLI_SYNTHESIZER_ID: input.synthesizer_id,
    AISA_CLI_SYNTHESIZER_ROLE: input.role,
    AISA_CLI_SYNTHESIZER_ADAPTER: input.adapter ?? "cli-json-stdio",
    ...(input.provider ? { AISA_CLI_SYNTHESIZER_PROVIDER: input.provider } : {}),
    ...(input.model ? { AISA_CLI_SYNTHESIZER_MODEL: input.model } : {})
  };
}

async function runCliJsonCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  stdin: string;
}): Promise<{
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...input.env
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `CLI command timed out after ${input.timeoutMs}ms: ${formatCommandForError(input.command, input.args)}`
          )
        );
        return;
      }

      if (exitCode !== 0 || signal) {
        reject(
          new Error(
            [
              `CLI command failed: ${formatCommandForError(input.command, input.args)}`,
              `exit_code=${exitCode ?? "null"}`,
              signal ? `signal=${signal}` : null,
              stdout.trim().length > 0 ? `stdout:\n${stdout.trim()}` : null,
              stderr.trim().length > 0 ? `stderr:\n${stderr.trim()}` : null
            ]
              .filter(Boolean)
              .join("\n\n")
          )
        );
        return;
      }

      resolve({
        stdout,
        stderr
      });
    });
    child.stdin.end(input.stdin);
  });
}

function parseCliReviewerOutput(stdout: string, reviewerId: string): {
  structured_judgment: AttemptReviewerJudgment;
  proposed_next_contract: AttemptContractDraft | null;
} {
  const parsed = parseCliJsonObject(stdout, `CLI reviewer ${reviewerId}`);

  return {
    structured_judgment: AttemptReviewerJudgmentSchema.parse(parsed.structured_judgment),
    proposed_next_contract:
      parsed.proposed_next_contract == null
        ? null
        : AttemptContractDraftSchema.parse(parsed.proposed_next_contract)
  };
}

function parseCliSynthesizerOutput(
  stdout: string,
  synthesizerId: string
): {
  structured_judgment: AttemptReviewerJudgment;
} {
  const parsed = parseCliJsonObject(stdout, `CLI synthesizer ${synthesizerId}`);

  return {
    structured_judgment: AttemptReviewerJudgmentSchema.parse(parsed.structured_judgment)
  };
}

function parseCliJsonObject(stdout: string, label: string): Record<string, unknown> {
  if (stdout.trim().length === 0) {
    throw new Error(`${label} returned empty stdout.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON: ${reason}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${label} must return a JSON object.`);
  }

  return parsed;
}

function parseAttemptReviewerConfig(
  value: unknown,
  index: number
): AttemptReviewerConfig {
  if (!isRecord(value)) {
    throw new Error(`AISA_REVIEWERS_JSON[${index}] must be a JSON object.`);
  }

  const kind = readRequiredString(value, "kind", index);
  if (kind === "heuristic") {
    return {
      kind,
      reviewer_id: readOptionalString(value, "reviewer_id", index),
      role: readOptionalString(value, "role", index),
      adapter: readOptionalString(value, "adapter", index),
      provider: readNullableString(value, "provider", index),
      model: readNullableString(value, "model", index)
    };
  }

  if (kind === "cli") {
    return {
      kind,
      reviewer_id: readRequiredString(value, "reviewer_id", index),
      role: readRequiredString(value, "role", index),
      adapter: readOptionalString(value, "adapter", index),
      provider: readNullableString(value, "provider", index),
      model: readNullableString(value, "model", index),
      command: readRequiredString(value, "command", index),
      args: readOptionalStringArray(value, "args", index),
      cwd: readNullableString(value, "cwd", index),
      env: readOptionalStringRecord(value, "env", index),
      timeout_ms: readOptionalPositiveInteger(value, "timeout_ms", index)
    };
  }

  throw new Error(
    `AISA_REVIEWERS_JSON[${index}].kind must be "heuristic" or "cli".`
  );
}

function parseAttemptEvaluationSynthesizerConfig(
  value: unknown
): AttemptEvaluationSynthesizerConfig {
  if (!isRecord(value)) {
    throw new Error(`${SYNTHESIZER_CONFIG_ENV} must be a JSON object.`);
  }

  const kind = readRequiredString(value, "kind", undefined, SYNTHESIZER_CONFIG_ENV);
  if (kind === "deterministic") {
    return {
      kind
    };
  }

  if (kind === "cli") {
    return {
      kind,
      synthesizer_id: readRequiredString(
        value,
        "synthesizer_id",
        undefined,
        SYNTHESIZER_CONFIG_ENV
      ),
      role: readRequiredString(value, "role", undefined, SYNTHESIZER_CONFIG_ENV),
      adapter: readOptionalString(value, "adapter", undefined, SYNTHESIZER_CONFIG_ENV),
      provider: readNullableString(value, "provider", undefined, SYNTHESIZER_CONFIG_ENV),
      model: readNullableString(value, "model", undefined, SYNTHESIZER_CONFIG_ENV),
      command: readRequiredString(value, "command", undefined, SYNTHESIZER_CONFIG_ENV),
      args: readOptionalStringArray(value, "args", undefined, SYNTHESIZER_CONFIG_ENV),
      cwd: readNullableString(value, "cwd", undefined, SYNTHESIZER_CONFIG_ENV),
      env: readOptionalStringRecord(value, "env", undefined, SYNTHESIZER_CONFIG_ENV),
      timeout_ms: readOptionalPositiveInteger(
        value,
        "timeout_ms",
        undefined,
        SYNTHESIZER_CONFIG_ENV
      )
    };
  }

  throw new Error(
    `${SYNTHESIZER_CONFIG_ENV}.kind must be "deterministic" or "cli".`
  );
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  index?: number,
  envLabel = REVIEWER_CONFIG_ENV
): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(formatConfigFieldError(envLabel, key, "must be a non-empty string.", index));
  }

  return raw;
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
  index?: number,
  envLabel = REVIEWER_CONFIG_ENV
): string | undefined {
  const raw = value[key];
  if (raw == null) {
    return undefined;
  }

  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(formatConfigFieldError(envLabel, key, "must be a non-empty string.", index));
  }

  return raw;
}

function readNullableString(
  value: Record<string, unknown>,
  key: string,
  index?: number,
  envLabel = REVIEWER_CONFIG_ENV
): string | null | undefined {
  const raw = value[key];
  if (raw === undefined) {
    return undefined;
  }

  if (raw === null) {
    return null;
  }

  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(formatConfigFieldError(envLabel, key, "must be a string or null.", index));
  }

  return raw;
}

function readOptionalStringArray(
  value: Record<string, unknown>,
  key: string,
  index?: number,
  envLabel = REVIEWER_CONFIG_ENV
): string[] | undefined {
  const raw = value[key];
  if (raw == null) {
    return undefined;
  }

  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    throw new Error(formatConfigFieldError(envLabel, key, "must be an array of strings.", index));
  }

  return raw;
}

function readOptionalStringRecord(
  value: Record<string, unknown>,
  key: string,
  index?: number,
  envLabel = REVIEWER_CONFIG_ENV
): Record<string, string> | undefined {
  const raw = value[key];
  if (raw == null) {
    return undefined;
  }

  if (!isRecord(raw)) {
    throw new Error(formatConfigFieldError(envLabel, key, "must be an object of strings.", index));
  }

  const entries = Object.entries(raw);
  if (entries.some(([, entryValue]) => typeof entryValue !== "string")) {
    throw new Error(formatConfigFieldError(envLabel, key, "must be an object of strings.", index));
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

function readOptionalPositiveInteger(
  value: Record<string, unknown>,
  key: string,
  index?: number,
  envLabel = REVIEWER_CONFIG_ENV
): number | undefined {
  const raw = value[key];
  if (raw == null) {
    return undefined;
  }

  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(
      formatConfigFieldError(envLabel, key, "must be a positive integer.", index)
    );
  }

  return raw;
}

function formatConfigFieldError(
  envLabel: string,
  key: string,
  message: string,
  index?: number
): string {
  return index == null ? `${envLabel}.${key} ${message}` : `${envLabel}[${index}].${key} ${message}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatCommandForError(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}
