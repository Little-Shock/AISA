import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createRunGovernanceState,
  updateRunGovernanceState,
  type Attempt,
  type AttemptContractDraft,
  type AttemptEvaluation,
  type AttemptRuntimeVerification,
  type CurrentDecision,
  type RunGovernanceExcludedPlan,
  type RunGovernanceState,
  type WorkerWriteback
} from "@autoresearch/domain";

type GovernedAttemptCandidate = {
  attemptType: Attempt["attempt_type"];
  objective: string;
  nextAction: string | null;
  nextExecutionDraft: AttemptContractDraft | null;
};

export type GovernedAttemptCandidateDecision =
  | {
      status: "ok";
      candidate: GovernedAttemptCandidate;
      message: null;
      invalidRefs: string[];
    }
  | {
      status: "redirect";
      candidate: GovernedAttemptCandidate;
      message: string;
      invalidRefs: string[];
    }
  | {
      status: "blocked";
      reason: "excluded_plan_reused" | "missing_artifact_reference";
      message: string;
      invalidRefs: string[];
      excludedPlan: RunGovernanceExcludedPlan | null;
    };

const REPO_ARTIFACT_REF_PATTERN =
  /\b(?:runs|artifacts|reports|plans|state)\/[^\s"'`)<>\]}]+/gu;

function cleanText(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function normalizeText(value: string | null | undefined): string {
  let normalized = value ?? "";
  normalized = normalized.normalize("NFKC");
  normalized = normalized.toLowerCase();
  normalized = normalized.replace(/[`"'“”‘’]/gu, "");
  normalized = normalized.replace(/[^\p{L}\p{N}\/._-]+/gu, " ");
  normalized = normalized.replace(/\s+/gu, " ");
  return normalized.trim();
}

export function buildGovernanceSignature(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized.slice(0, 180) : null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const output: string[] = [];

  for (const value of values) {
    const text = cleanText(value);
    if (!text || output.includes(text)) {
      continue;
    }
    output.push(text);
  }

  return output;
}

function isMeaningfulProgress(input: {
  attempt: Attempt;
  evaluation: AttemptEvaluation | null;
  result: WorkerWriteback | null;
}): boolean {
  const { attempt, evaluation, result } = input;
  if (!evaluation) {
    return false;
  }

  if (evaluation.recommendation === "complete") {
    return true;
  }

  if (attempt.attempt_type === "execution") {
    return evaluation.verification_status === "passed";
  }

  return (
    evaluation.recommendation === "continue" &&
    (evaluation.goal_progress >= 0.55 ||
      (result?.recommended_next_steps.length ?? 0) > 0 ||
      result?.next_attempt_contract?.attempt_type === "execution")
  );
}

function buildProblemSummary(input: {
  currentSnapshot: CurrentDecision | null;
  evaluation: AttemptEvaluation | null;
  result: WorkerWriteback | null;
  runtimeVerification: AttemptRuntimeVerification | null;
  attempt: Attempt;
}): string | null {
  return (
    cleanText(input.currentSnapshot?.blocking_reason) ??
    cleanText(input.runtimeVerification?.failure_reason) ??
    cleanText(input.evaluation?.missing_evidence[0]) ??
    cleanText(input.result?.questions[0]) ??
    cleanText(input.attempt.objective)
  );
}

function buildMainline(input: {
  attempt: Attempt;
  evaluation: AttemptEvaluation | null;
  result: WorkerWriteback | null;
}): {
  summary: string | null;
  signature: string | null;
  attemptType: Attempt["attempt_type"] | null;
} {
  if (!isMeaningfulProgress(input)) {
    return {
      summary: null,
      signature: null,
      attemptType: null
    };
  }

  const summary =
    cleanText(input.result?.next_attempt_contract?.objective) ??
    cleanText(input.result?.recommended_next_steps[0]) ??
    cleanText(input.attempt.objective);
  const attemptType =
    input.evaluation?.suggested_attempt_type ??
    input.result?.next_attempt_contract?.attempt_type ??
    input.attempt.attempt_type;

  return {
    summary,
    signature: buildGovernanceSignature(summary),
    attemptType
  };
}

function buildContextHeadline(input: {
  status: RunGovernanceState["status"];
  attempt: Attempt;
  meaningfulProgress: boolean;
}): string {
  if (input.status === "resolved") {
    return `当前主问题已完成，最新结论来自 ${input.attempt.id}。`;
  }

  if (input.status === "ready_to_commit") {
    return `当前主线已收敛到可继续提交的执行路径，最新结论来自 ${input.attempt.id}。`;
  }

  if (input.status === "blocked") {
    return `当前 run 卡在重复问题或硬阻塞上，最新证据来自 ${input.attempt.id}。`;
  }

  return input.meaningfulProgress
    ? `当前主线已更新，最新结论来自 ${input.attempt.id}。`
    : `当前主线未刷新，最新结论来自 ${input.attempt.id}。`;
}

function dedupeExcludedPlans(
  input: RunGovernanceExcludedPlan[]
): RunGovernanceExcludedPlan[] {
  const seen = new Set<string>();
  const output: RunGovernanceExcludedPlan[] = [];

  for (const plan of [...input].sort((left, right) =>
    right.excluded_at.localeCompare(left.excluded_at)
  )) {
    if (seen.has(plan.plan_signature)) {
      continue;
    }
    seen.add(plan.plan_signature);
    output.push(plan);
  }

  return output.slice(0, 12);
}

function shouldExcludeAttemptObjective(input: {
  attempt: Attempt;
  currentSnapshot: CurrentDecision | null;
  evaluation: AttemptEvaluation | null;
  meaningfulProgress: boolean;
}): boolean {
  if (
    input.attempt.status === "stopped" &&
    input.currentSnapshot?.blocking_reason?.includes("编排器恢复时仍被标记为运行中")
  ) {
    return false;
  }

  return (
    !input.meaningfulProgress ||
    input.attempt.status === "failed" ||
    input.attempt.status === "stopped" ||
    input.evaluation?.recommendation === "retry"
  );
}

export function deriveRunGovernanceState(input: {
  previous: RunGovernanceState | null;
  attempt: Attempt;
  currentSnapshot: CurrentDecision | null;
  evaluation: AttemptEvaluation | null;
  result: WorkerWriteback | null;
  runtimeVerification: AttemptRuntimeVerification | null;
}): RunGovernanceState {
  const base =
    input.previous ??
    createRunGovernanceState({
      run_id: input.attempt.run_id
    });
  const meaningfulProgress = isMeaningfulProgress(input);
  const problemSummary = buildProblemSummary(input);
  const problemSignature = buildGovernanceSignature(problemSummary);
  const mainline = buildMainline(input);
  const repeatCount =
    !meaningfulProgress && problemSignature && problemSignature === base.active_problem_signature
      ? base.blocker_repeat_count + 1
      : !meaningfulProgress && problemSignature
        ? 1
        : 0;
  const excludedPlans = [...base.excluded_plans];
  const objectiveSignature = buildGovernanceSignature(input.attempt.objective);

  if (
    objectiveSignature &&
    shouldExcludeAttemptObjective({
      attempt: input.attempt,
      currentSnapshot: input.currentSnapshot,
      evaluation: input.evaluation,
      meaningfulProgress
    })
  ) {
    excludedPlans.unshift({
      plan_signature: objectiveSignature,
      objective: input.attempt.objective,
      reason:
        problemSummary ??
        input.evaluation?.rationale ??
        `Attempt ${input.attempt.id} did not produce a reusable next step.`,
      source_attempt_id: input.attempt.id,
      source_attempt_status: input.attempt.status,
      evidence_refs: uniqueStrings([
        input.attempt.result_ref,
        input.attempt.evaluation_ref,
        input.runtimeVerification
          ? `runs/${input.attempt.run_id}/attempts/${input.attempt.id}/artifacts/runtime-verification.json`
          : null
      ]),
      excluded_at: new Date().toISOString()
    });
  }

  const nextStatus: RunGovernanceState["status"] =
    input.evaluation?.recommendation === "complete"
      ? "resolved"
      : meaningfulProgress && input.attempt.attempt_type === "execution"
        ? "ready_to_commit"
        : repeatCount >= 2 || input.currentSnapshot?.waiting_for_human
          ? "blocked"
          : "active";
  const progressSummary = meaningfulProgress ? cleanText(input.result?.summary) : null;
  const blockerSummary =
    nextStatus === "blocked" ? problemSummary : cleanText(input.currentSnapshot?.blocking_reason);
  const avoidSummary = dedupeExcludedPlans(excludedPlans)
    .slice(0, 3)
    .map((plan) => `不要再按这个目标继续：${plan.objective}`);

  return updateRunGovernanceState(base, {
    status: nextStatus,
    active_problem_signature:
      nextStatus === "resolved"
        ? null
        : problemSignature ?? base.active_problem_signature,
    active_problem_summary:
      nextStatus === "resolved" ? null : problemSummary ?? base.active_problem_summary,
    blocker_repeat_count: repeatCount,
    mainline_signature:
      mainline.signature ??
      (nextStatus === "resolved" ? base.mainline_signature : base.mainline_signature),
    mainline_summary:
      mainline.summary ??
      (nextStatus === "resolved" ? base.mainline_summary : base.mainline_summary),
    mainline_attempt_type:
      mainline.attemptType ??
      (nextStatus === "resolved" ? base.mainline_attempt_type : base.mainline_attempt_type),
    mainline_attempt_id:
      mainline.signature ? input.attempt.id : base.mainline_attempt_id,
    excluded_plans: dedupeExcludedPlans(excludedPlans),
    next_allowed_actions:
      nextStatus === "resolved"
        ? ["wait_for_human", "apply_steer"]
        : nextStatus === "ready_to_commit"
          ? ["continue_execution", "wait_for_human", "apply_steer"]
          : nextStatus === "blocked"
            ? ["wait_for_human", "apply_steer"]
            : mainline.attemptType === "execution" || base.mainline_attempt_type === "execution"
              ? ["continue_execution", "start_execution", "wait_for_human", "apply_steer"]
              : ["continue_research", "retry_attempt", "wait_for_human", "apply_steer"],
    last_meaningful_progress_at: meaningfulProgress
      ? input.attempt.ended_at ?? input.attempt.updated_at
      : base.last_meaningful_progress_at,
    last_meaningful_progress_attempt_id: meaningfulProgress
      ? input.attempt.id
      : base.last_meaningful_progress_attempt_id,
    context_summary: {
      headline: buildContextHeadline({
        status: nextStatus,
        attempt: input.attempt,
        meaningfulProgress
      }),
      progress_summary: progressSummary,
      blocker_summary: blockerSummary,
      avoid_summary: avoidSummary,
      generated_at: new Date().toISOString()
    }
  });
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.;:\]}>"'`，。；：！？、）】》」』〕〉］｝｣｡．]+$/gu, "");
}

export function extractRepoArtifactReferences(input: {
  text: string;
  rootDir: string;
}): string[] {
  const refs = new Set<string>();

  for (const match of input.text.matchAll(REPO_ARTIFACT_REF_PATTERN)) {
    const ref = stripTrailingPunctuation(match[0] ?? "");
    if (ref.length > 0) {
      refs.add(ref);
    }
  }

  const absoluteRootPrefix = `${resolve(input.rootDir)}/`;
  for (const token of input.text.split(/\s+/u)) {
    const ref = stripTrailingPunctuation(token);
    if (ref.startsWith(absoluteRootPrefix)) {
      refs.add(ref);
    }
  }

  return [...refs];
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue);
    return true;
  } catch {
    return false;
  }
}

async function findMissingArtifactReferences(input: {
  objective: string;
  rootDir: string;
}): Promise<string[]> {
  const refs = extractRepoArtifactReferences({
    text: input.objective,
    rootDir: input.rootDir
  });
  const missing: string[] = [];

  for (const ref of refs) {
    const resolvedPath = ref.startsWith("/")
      ? resolve(ref)
      : resolve(input.rootDir, ref);
    if (!(await pathExists(resolvedPath))) {
      missing.push(ref);
    }
  }

  return missing;
}

export async function validateGovernedAttemptCandidate(input: {
  governance: RunGovernanceState | null;
  candidate: GovernedAttemptCandidate;
  rootDir: string;
}): Promise<GovernedAttemptCandidateDecision> {
  const governance = input.governance;
  let candidate = input.candidate;
  let redirectMessage: string | null = null;

  if (
    governance &&
    governance.status !== "resolved" &&
    governance.status !== "blocked" &&
    governance.mainline_attempt_type === "execution" &&
    governance.mainline_summary &&
    candidate.nextAction !== "apply_steer" &&
    candidate.attemptType === "research"
  ) {
    candidate = {
      ...candidate,
      attemptType: "execution",
      objective: governance.mainline_summary,
      nextAction: "continue_execution",
      nextExecutionDraft:
        candidate.nextExecutionDraft?.attempt_type === "execution"
          ? {
              ...candidate.nextExecutionDraft,
              objective: governance.mainline_summary
            }
          : candidate.nextExecutionDraft
    };
    redirectMessage =
      "治理状态要求沿着已经验证过的 execution 主线继续，不再重新打开同题研究分叉。";
  }

  const objectiveSignature = buildGovernanceSignature(candidate.objective);
  const excludedPlan =
    objectiveSignature && governance
      ? governance.excluded_plans.find(
          (plan: RunGovernanceExcludedPlan) => plan.plan_signature === objectiveSignature
        ) ?? null
      : null;
  if (excludedPlan) {
    return {
      status: "blocked",
      reason: "excluded_plan_reused",
      message: [
        "下一轮派发被治理层拦下了。",
        `目标命中了已证伪方案：${excludedPlan.objective}`,
        `原始原因：${excludedPlan.reason}`
      ].join(" "),
      invalidRefs: [],
      excludedPlan
    };
  }

  const invalidRefs = await findMissingArtifactReferences({
    objective: candidate.objective,
    rootDir: input.rootDir
  });
  if (invalidRefs.length > 0) {
    return {
      status: "blocked",
      reason: "missing_artifact_reference",
      message: [
        "下一轮派发被治理层拦下了。",
        `目标引用了不存在的工件：${invalidRefs.join(", ")}`,
        "先修正上下文引用，再继续。"
      ].join(" "),
      invalidRefs,
      excludedPlan: objectiveSignature
        ? {
            plan_signature: objectiveSignature,
            objective: candidate.objective,
            reason: `Objective referenced missing artifacts: ${invalidRefs.join(", ")}`,
            source_attempt_id: governance?.mainline_attempt_id ?? null,
            source_attempt_status: null,
            evidence_refs: invalidRefs,
            excluded_at: new Date().toISOString()
          }
        : null
    };
  }

  if (redirectMessage) {
    return {
      status: "redirect",
      candidate,
      message: redirectMessage,
      invalidRefs: []
    };
  }

  return {
    status: "ok",
    candidate,
    message: null,
    invalidRefs: []
  };
}

export function buildGovernanceCheckpointContext(
  governance: RunGovernanceState | null
): string[] {
  if (!governance) {
    return [];
  }

  return uniqueStrings([
    governance.context_summary.headline,
    governance.mainline_summary ? `Mainline: ${governance.mainline_summary}` : null,
    governance.active_problem_summary ? `Problem: ${governance.active_problem_summary}` : null,
    governance.context_summary.avoid_summary[0] ?? null
  ]);
}
