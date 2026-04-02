import { relative } from "node:path";
import {
  createRunJournalEntry,
  createCurrentDecision,
  createRunAutomationControl,
  createRunBrief,
  createRunGovernanceState,
  type Attempt,
  type CurrentDecision,
  type RunAutomationControl,
  type RunBrief,
  type RunGovernanceState
} from "@autoresearch/domain";
import {
  appendRunJournal,
  getAttemptAdversarialVerification,
  getAttemptHandoffBundle,
  getAttemptPreflightEvaluation,
  getAttemptRuntimeVerification,
  getCurrentDecision,
  getRun,
  getRunAutomationControl,
  getRunBrief,
  getRunGovernanceState,
  listAttempts,
  resolveAttemptPaths,
  resolveRunPaths,
  saveRunBrief,
  type WorkspacePaths
} from "@autoresearch/state-store";
import {
  readRunWorkingContextView,
  refreshRunWorkingContext,
  RunWorkingContextWriteError
} from "./working-context.js";
import {
  deriveFailureSignalFromAdversarialVerification,
  deriveFailureSignalFromHandoffBundle,
  deriveFailureSignalFromHandoffGap,
  deriveFailureSignalFromPreflight,
  deriveFailureSignalFromRuntimeVerification,
  deriveFailureSignalFromWorkingContext,
  pickPrimaryFailureSignal
} from "./failure-policy.js";

export type RunBriefView = {
  run_brief: RunBrief | null;
  run_brief_ref: string | null;
};

function toTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function buildRelativeRef(paths: WorkspacePaths, absolutePath: string): string {
  return relative(paths.rootDir, absolutePath);
}

function buildRunBriefRef(paths: WorkspacePaths, runId: string): string {
  return buildRelativeRef(paths, resolveRunPaths(paths, runId).runBriefFile);
}

function buildRunCurrentRef(paths: WorkspacePaths, runId: string): string {
  return buildRelativeRef(paths, resolveRunPaths(paths, runId).currentFile);
}

function buildRunAutomationRef(paths: WorkspacePaths, runId: string): string {
  return buildRelativeRef(paths, resolveRunPaths(paths, runId).automationFile);
}

function buildRunWorkingContextRef(paths: WorkspacePaths, runId: string): string {
  return buildRelativeRef(paths, resolveRunPaths(paths, runId).workingContextFile);
}

function buildAttemptPreflightRef(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): string {
  return buildRelativeRef(
    paths,
    resolveAttemptPaths(paths, runId, attemptId).preflightEvaluationFile
  );
}

function buildAttemptHandoffRef(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): string {
  return buildRelativeRef(
    paths,
    resolveAttemptPaths(paths, runId, attemptId).handoffBundleFile
  );
}

function buildAttemptRuntimeVerificationRef(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): string {
  return buildRelativeRef(
    paths,
    resolveAttemptPaths(paths, runId, attemptId).runtimeVerificationFile
  );
}

function buildAttemptAdversarialVerificationRef(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): string {
  return buildRelativeRef(
    paths,
    resolveAttemptPaths(paths, runId, attemptId).adversarialVerificationFile
  );
}

function pickLatestAttempt(
  attempts: Attempt[],
  current: CurrentDecision | null
): Attempt | null {
  return (
    attempts.find((attempt) => attempt.id === current?.latest_attempt_id) ??
    attempts.at(-1) ??
    null
  );
}

async function resolveLatestEvidenceArtifacts(input: {
  paths: WorkspacePaths;
  runId: string;
  latestAttempt: Attempt | null;
  attempts: Attempt[];
}): Promise<{
  evidenceAttempt: Attempt | null;
  latestPreflight: Awaited<ReturnType<typeof getAttemptPreflightEvaluation>> | null;
  latestHandoff: Awaited<ReturnType<typeof getAttemptHandoffBundle>> | null;
  latestRuntimeVerification: Awaited<ReturnType<typeof getAttemptRuntimeVerification>> | null;
  latestAdversarialVerification:
    Awaited<ReturnType<typeof getAttemptAdversarialVerification>> | null;
}> {
  if (!input.latestAttempt) {
    return {
      evidenceAttempt: null,
      latestPreflight: null,
      latestHandoff: null,
      latestRuntimeVerification: null,
      latestAdversarialVerification: null
    };
  }

  const orderedCandidates = [
    input.latestAttempt,
    ...input.attempts
      .slice()
      .reverse()
      .filter((attempt) => attempt.id !== input.latestAttempt?.id)
  ];

  for (const candidate of orderedCandidates) {
    const [
      candidatePreflight,
      candidateHandoff,
      candidateRuntimeVerification,
      candidateAdversarialVerification
    ] =
      await Promise.all([
        getAttemptPreflightEvaluation(input.paths, input.runId, candidate.id),
        getAttemptHandoffBundle(input.paths, input.runId, candidate.id),
        getAttemptRuntimeVerification(input.paths, input.runId, candidate.id),
        getAttemptAdversarialVerification(input.paths, input.runId, candidate.id)
      ]);

    if (
      candidatePreflight ||
      candidateHandoff ||
      candidateRuntimeVerification ||
      candidateAdversarialVerification
    ) {
      return {
        evidenceAttempt: candidate,
        latestPreflight: candidatePreflight,
        latestHandoff: candidateHandoff,
        latestRuntimeVerification: candidateRuntimeVerification,
        latestAdversarialVerification: candidateAdversarialVerification
      };
    }
  }

  return {
    evidenceAttempt: input.latestAttempt,
    latestPreflight: null,
    latestHandoff: null,
    latestRuntimeVerification: null,
    latestAdversarialVerification: null
  };
}

function buildHeadline(input: {
  automation: RunAutomationControl;
  current: CurrentDecision;
  governance: RunGovernanceState;
  handoffSummary: string | null;
  preflightFailure: string | null;
  workingContextAttention: string | null;
  runDescription: string;
}): string {
  if (input.automation.mode === "manual_only") {
    return input.automation.reason ?? "自动化已停，等待人工恢复。";
  }

  if (input.current.waiting_for_human) {
    return (
      input.current.blocking_reason ??
      input.current.summary ??
      input.governance.context_summary.blocker_summary ??
      "当前等待人工处理。"
    );
  }

  if (input.handoffSummary) {
    return input.handoffSummary;
  }

  if (input.preflightFailure) {
    return input.preflightFailure;
  }

  if (input.governance.status === "blocked") {
    return (
      input.governance.context_summary.blocker_summary ??
      input.governance.active_problem_summary ??
      input.governance.context_summary.headline
    );
  }

  return (
    input.current.summary ??
    input.workingContextAttention ??
    input.runDescription
  );
}

export async function buildRunBrief(
  paths: WorkspacePaths,
  runId: string
): Promise<RunBrief> {
  const [
    run,
    currentState,
    automationControl,
    governanceState,
    workingContextView,
    attempts
  ] =
    await Promise.all([
      getRun(paths, runId),
      getCurrentDecision(paths, runId),
      getRunAutomationControl(paths, runId),
      getRunGovernanceState(paths, runId),
      readRunWorkingContextView(paths, runId),
      listAttempts(paths, runId)
    ]);
  const workingContext = workingContextView.working_context;
  const current =
    currentState ??
    createCurrentDecision({
      run_id: runId,
      run_status: "draft",
      summary: "Run created. Waiting for first attempt."
    });
  const automation =
    automationControl ??
    createRunAutomationControl({
      run_id: runId
    });
  const governance =
    governanceState ??
    createRunGovernanceState({
      run_id: runId
    });
  const latestAttempt = pickLatestAttempt(attempts, current);
  const {
    evidenceAttempt,
    latestPreflight,
    latestHandoff,
    latestRuntimeVerification,
    latestAdversarialVerification
  } = await resolveLatestEvidenceArtifacts({
    paths,
    runId,
    latestAttempt,
    attempts
  });

  const evidenceRefs: RunBrief["evidence_refs"] = [];
  if (latestHandoff && evidenceAttempt) {
    evidenceRefs.push({
      kind: "handoff_bundle",
      ref: buildAttemptHandoffRef(paths, runId, evidenceAttempt.id),
      label: "优先读交接",
      summary:
        latestHandoff.summary ??
        latestHandoff.failure_context?.message ??
        latestHandoff.failure_code
    });
  }
  if (latestPreflight && evidenceAttempt) {
    evidenceRefs.push({
      kind: "preflight_evaluation",
      ref: buildAttemptPreflightRef(paths, runId, evidenceAttempt.id),
      label: "发车前结论",
      summary:
        latestPreflight.failure_reason ??
        `status=${latestPreflight.status}`
    });
  }
  if (latestRuntimeVerification && evidenceAttempt) {
    evidenceRefs.push({
      kind: "runtime_verification",
      ref: buildAttemptRuntimeVerificationRef(paths, runId, evidenceAttempt.id),
      label: "回放证据",
      summary:
        latestRuntimeVerification.failure_reason ??
        `status=${latestRuntimeVerification.status}`
    });
  }
  if (latestAdversarialVerification && evidenceAttempt) {
    evidenceRefs.push({
      kind: "adversarial_verification",
      ref: buildAttemptAdversarialVerificationRef(paths, runId, evidenceAttempt.id),
      label: "对抗验证",
      summary:
        latestAdversarialVerification.failure_reason ??
        latestAdversarialVerification.summary ??
        `status=${latestAdversarialVerification.status}`
    });
  }
  if (workingContext) {
    evidenceRefs.push({
      kind: "working_context",
      ref: buildRunWorkingContextRef(paths, runId),
      label: "运行中现场",
      summary:
        workingContext.next_operator_attention ??
        workingContext.current_focus
    });
  }
  if (current.summary || current.blocking_reason) {
    evidenceRefs.push({
      kind: "current_decision",
      ref: buildRunCurrentRef(paths, runId),
      label: "当前判断",
      summary: current.blocking_reason ?? current.summary
    });
  }
  if (automation.mode === "manual_only") {
    evidenceRefs.push({
      kind: "automation",
      ref: buildRunAutomationRef(paths, runId),
      label: "自动化状态",
      summary: automation.reason
    });
  }

  const failureSignal = pickPrimaryFailureSignal(
    deriveFailureSignalFromHandoffBundle({
      handoff: latestHandoff,
      sourceRef:
        latestHandoff && evidenceAttempt
          ? buildAttemptHandoffRef(paths, runId, evidenceAttempt.id)
          : null
    }),
    deriveFailureSignalFromAdversarialVerification({
      verification: latestAdversarialVerification,
      sourceRef:
        latestAdversarialVerification && evidenceAttempt
          ? buildAttemptAdversarialVerificationRef(paths, runId, evidenceAttempt.id)
          : null
    }),
    deriveFailureSignalFromRuntimeVerification({
      verification: latestRuntimeVerification,
      sourceRef:
        latestRuntimeVerification && evidenceAttempt
          ? buildAttemptRuntimeVerificationRef(paths, runId, evidenceAttempt.id)
          : null
    }),
    deriveFailureSignalFromPreflight({
      preflight: latestPreflight,
      sourceRef:
        latestPreflight && evidenceAttempt
          ? buildAttemptPreflightRef(paths, runId, evidenceAttempt.id)
          : null
    }),
    deriveFailureSignalFromHandoffGap({
      latestAttempt,
      current,
      handoff: latestHandoff,
      sourceRef: latestAttempt ? buildAttemptHandoffRef(paths, runId, latestAttempt.id) : null
    }),
    deriveFailureSignalFromWorkingContext({
      degraded: workingContextView.working_context_degraded,
      sourceRef: workingContextView.working_context_ref
    })
  );

  const headline = buildHeadline({
    automation,
    current,
    governance,
    handoffSummary: latestHandoff?.summary ?? null,
    preflightFailure: latestPreflight?.failure_reason ?? null,
    workingContextAttention: workingContext?.next_operator_attention ?? null,
    runDescription: run.description
  });
  const summary =
    current.summary ??
    latestHandoff?.summary ??
    latestPreflight?.failure_reason ??
    workingContext?.next_operator_attention ??
    headline;

  return createRunBrief({
    run_id: runId,
    status: current.run_status,
    headline,
    summary,
    failure_signal: failureSignal,
    blocker_summary:
      workingContext?.current_blocker?.summary ??
      current.blocking_reason ??
      governance.context_summary.blocker_summary ??
      automation.reason,
    recommended_next_action:
      current.recommended_next_action ??
      latestHandoff?.recommended_next_action ??
      null,
    recommended_attempt_type:
      current.recommended_attempt_type ??
      latestHandoff?.recommended_attempt_type ??
      null,
    waiting_for_human: current.waiting_for_human,
    automation_mode: automation.mode,
    latest_attempt_id: latestAttempt?.id ?? null,
    primary_focus:
      workingContext?.current_focus ??
      latestHandoff?.approved_attempt_contract?.objective ??
      latestAttempt?.objective ??
      run.description,
    evidence_refs: evidenceRefs
  });
}

export async function refreshRunBrief(
  paths: WorkspacePaths,
  runId: string
): Promise<RunBrief> {
  const runBrief = await buildRunBrief(paths, runId);
  await saveRunBrief(paths, runBrief);
  return runBrief;
}

export async function refreshRunOperatorSurface(
  paths: WorkspacePaths,
  runId: string
): Promise<RunBrief> {
  try {
    await refreshRunWorkingContext(paths, runId);
  } catch (error) {
    if (!(error instanceof RunWorkingContextWriteError)) {
      throw error;
    }

    await appendRunJournal(
      paths,
      createRunJournalEntry({
        run_id: runId,
        type: "run.working_context.refresh_failed",
        payload: {
          failure_class: "working_context_degraded",
          failure_policy_mode: "soft_degrade",
          reason_code: "context_write_failed",
          summary: "working context 写入失败，当前现场不可信。",
          detail: error.message
        }
      })
    );
  }

  return await refreshRunBrief(paths, runId);
}

export async function readRunBriefView(
  paths: WorkspacePaths,
  runId: string
): Promise<RunBriefView> {
  const runBrief = await getRunBrief(paths, runId);

  return {
    run_brief: runBrief,
    run_brief_ref: runBrief ? buildRunBriefRef(paths, runId) : null
  };
}
