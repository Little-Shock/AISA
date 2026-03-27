import { spawn } from "node:child_process";
import {
  AttemptContractDraftSchema,
  AttemptEvaluationSchema,
  AttemptReviewerJudgmentSchema,
  AttemptReviewerOpinionSchema,
  EvalResultSchema,
  createEntityId,
  isExecutionContractDraftReady,
  type AttemptContractDraft,
  type AttemptEvaluation,
  type AttemptReviewInputPacket,
  type AttemptReviewInputRef,
  type AttemptRuntimeVerification,
  type AttemptReviewPacket,
  type AttemptReviewerIdentity,
  type AttemptReviewerJudgment,
  type AttemptReviewerOpinion,
  type Branch,
  type EvalResult,
  type EvalSpec,
  type Goal,
  type WorkerWriteback
} from "@autoresearch/domain";

type ReviewableAttemptPacket = AttemptReviewInputPacket | AttemptReviewPacket;
const REVIEWER_CONFIG_ENV = "AISA_REVIEWERS_JSON";
const DEFAULT_CLI_REVIEWER_TIMEOUT_MS = 60_000;

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
      const commandResult = await runCliReviewerCommand({
        command: input.command,
        args: input.args ?? [],
        cwd: input.cwd ?? process.cwd(),
        env: input.env ?? {},
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

export function synthesizeAttemptEvaluation(input: {
  reviewInputPacket: AttemptReviewInputPacket;
  opinions: AttemptReviewerOpinion[];
  reviewInputPacketRef: string;
  opinionRefs: string[];
}): AttemptEvaluation {
  const baseEvaluation = buildAttemptEvaluationBase({
    reviewPacket: input.reviewInputPacket
  });
  const judgments = input.opinions.map((opinion) => opinion.structured_judgment);
  const verificationLocked = baseEvaluation.verification_status === "failed";
  const synthesizedGoalProgress =
    judgments.length > 0
      ? clampUnit(average(judgments.map((judgment) => judgment.goal_progress)))
      : baseEvaluation.goal_progress;
  const synthesizedEvidenceQuality =
    judgments.length > 0
      ? clampUnit(average(judgments.map((judgment) => judgment.evidence_quality)))
      : baseEvaluation.evidence_quality;
  const mergedMissingEvidence = uniqueStrings([
    ...baseEvaluation.missing_evidence,
    ...judgments.flatMap((judgment) => judgment.missing_evidence)
  ]);
  const recommendation = verificationLocked
    ? baseEvaluation.recommendation
    : pickMajorityValue(
        judgments.map((judgment) => judgment.recommendation),
        baseEvaluation.recommendation
      );
  const suggestedAttemptType = verificationLocked
    ? baseEvaluation.suggested_attempt_type
    : pickMajorityValue(
        judgments.map((judgment) => judgment.suggested_attempt_type),
        baseEvaluation.suggested_attempt_type
      );

  return AttemptEvaluationSchema.parse({
    ...baseEvaluation,
    goal_progress: verificationLocked
      ? Math.min(baseEvaluation.goal_progress, synthesizedGoalProgress, 0.34)
      : synthesizedGoalProgress,
    evidence_quality: synthesizedEvidenceQuality,
    recommendation,
    suggested_attempt_type: suggestedAttemptType,
    rationale: [
      baseEvaluation.rationale,
      `reviewers=${input.opinions.length}`,
      input.opinions.length > 0
        ? `reviewer_recommendations=${buildRecommendationSummary(judgments)}`
        : null
    ]
      .filter(Boolean)
      .join(", "),
    missing_evidence: mergedMissingEvidence,
    review_input_packet_ref: input.reviewInputPacketRef,
    opinion_refs: input.opinionRefs,
    synthesis_strategy:
      input.opinions.length > 1
        ? "deterministic_consensus_v1"
        : input.opinions.length === 1
          ? "deterministic_single_reviewer_v1"
          : "deterministic_fallback_v1",
    reviewer_count: input.opinions.length,
    created_at: new Date().toISOString()
  });
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
      : result.findings.filter((finding) => finding.evidence.length > 0).length /
        result.findings.length;
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

async function runCliReviewerCommand(input: {
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
            `CLI reviewer command timed out after ${input.timeoutMs}ms: ${formatCommandForError(input.command, input.args)}`
          )
        );
        return;
      }

      if (exitCode !== 0 || signal) {
        reject(
          new Error(
            [
              `CLI reviewer command failed: ${formatCommandForError(input.command, input.args)}`,
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

function parseCliReviewerOutput(
  stdout: string,
  reviewerId: string
): {
  structured_judgment: AttemptReviewerJudgment;
  proposed_next_contract: AttemptContractDraft | null;
} {
  if (stdout.trim().length === 0) {
    throw new Error(`CLI reviewer ${reviewerId} returned empty stdout.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`CLI reviewer ${reviewerId} returned invalid JSON: ${reason}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`CLI reviewer ${reviewerId} must return a JSON object.`);
  }

  return {
    structured_judgment: AttemptReviewerJudgmentSchema.parse(parsed.structured_judgment),
    proposed_next_contract:
      parsed.proposed_next_contract == null
        ? null
        : AttemptContractDraftSchema.parse(parsed.proposed_next_contract)
  };
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

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  index: number
): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`AISA_REVIEWERS_JSON[${index}].${key} must be a non-empty string.`);
  }

  return raw;
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
  index: number
): string | undefined {
  const raw = value[key];
  if (raw == null) {
    return undefined;
  }

  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`AISA_REVIEWERS_JSON[${index}].${key} must be a non-empty string.`);
  }

  return raw;
}

function readNullableString(
  value: Record<string, unknown>,
  key: string,
  index: number
): string | null | undefined {
  const raw = value[key];
  if (raw === undefined) {
    return undefined;
  }

  if (raw === null) {
    return null;
  }

  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`AISA_REVIEWERS_JSON[${index}].${key} must be a string or null.`);
  }

  return raw;
}

function readOptionalStringArray(
  value: Record<string, unknown>,
  key: string,
  index: number
): string[] | undefined {
  const raw = value[key];
  if (raw == null) {
    return undefined;
  }

  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    throw new Error(`AISA_REVIEWERS_JSON[${index}].${key} must be an array of strings.`);
  }

  return raw;
}

function readOptionalStringRecord(
  value: Record<string, unknown>,
  key: string,
  index: number
): Record<string, string> | undefined {
  const raw = value[key];
  if (raw == null) {
    return undefined;
  }

  if (!isRecord(raw)) {
    throw new Error(`AISA_REVIEWERS_JSON[${index}].${key} must be an object of strings.`);
  }

  const entries = Object.entries(raw);
  if (entries.some(([, entryValue]) => typeof entryValue !== "string")) {
    throw new Error(`AISA_REVIEWERS_JSON[${index}].${key} must be an object of strings.`);
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

function readOptionalPositiveInteger(
  value: Record<string, unknown>,
  key: string,
  index: number
): number | undefined {
  const raw = value[key];
  if (raw == null) {
    return undefined;
  }

  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`AISA_REVIEWERS_JSON[${index}].${key} must be a positive integer.`);
  }

  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatCommandForError(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}
