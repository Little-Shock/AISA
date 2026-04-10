import { relative } from "node:path";
import {
  createRunBlockedDiagnosis,
  createRunJournalEntry,
  createRunMaintenancePlane,
  type Attempt,
  type AttemptAdversarialVerification,
  type AttemptEvaluatorCalibrationSample,
  type AttemptReviewPacket,
  type AttemptRuntimeVerification,
  type CurrentDecision,
  type RunBrief,
  type RunFailureSignal,
  type RunGovernanceState,
  type RunHealthAssessment,
  type RunMaintenanceOutput,
  type RunMaintenancePlane,
  type RunMaintenanceSource,
  type RunPolicyRuntime,
  type RunWorkingContext
} from "@autoresearch/domain";
import {
  appendRunJournal,
  getAttemptAdversarialVerification,
  getAttemptEvaluatorCalibrationSample,
  getAttemptHeartbeat,
  getAttemptPreflightEvaluation,
  getAttemptReviewPacket,
  getAttemptRuntimeState,
  getAttemptRuntimeVerification,
  getAttemptHandoffBundle,
  getCurrentDecision,
  getRun,
  getRunGovernanceState,
  getRunMaintenancePlane,
  getRunRuntimeHealthSnapshot,
  listAttempts,
  readRunPolicyRuntimeStrict,
  resolveAttemptPaths,
  resolveRunPaths,
  saveRunMaintenancePlane,
  type WorkspacePaths
} from "@autoresearch/state-store";
import {
  refreshRunBrief,
  readRunBriefView,
  type RunBriefView
} from "./run-brief.js";
import { deriveRunSurfaceFailureSignal } from "./failure-policy.js";
import {
  readRunWorkingContextView,
  refreshRunWorkingContext,
  RunWorkingContextWriteError,
  type RunWorkingContextView
} from "./working-context.js";
import { assessRunHealth } from "./run-health.js";
import {
  describeRunEffectivePolicyBundle,
  type RunEffectivePolicyBundleView
} from "./effective-policy-bundle.js";

export type RunMaintenancePlaneView = {
  maintenance_plane: RunMaintenancePlane | null;
  maintenance_plane_ref: string | null;
};

export type RefreshRunMaintenancePlaneOptions = {
  staleAfterMs: number;
};

type RunPolicyRuntimeSurface = {
  policyRuntime: RunPolicyRuntime | null;
  policyRuntimeRef: string | null;
  policyRuntimeInvalidReason: string | null;
};

type LatestEvidenceArtifacts = {
  evidenceAttempt: Attempt | null;
  latestPreflight: Awaited<ReturnType<typeof getAttemptPreflightEvaluation>> | null;
  latestHandoff: Awaited<ReturnType<typeof getAttemptHandoffBundle>> | null;
  latestReviewPacket: AttemptReviewPacket | null;
  latestRuntimeVerification: AttemptRuntimeVerification | null;
  latestAdversarialVerification: AttemptAdversarialVerification | null;
  latestEvaluatorCalibrationSample: AttemptEvaluatorCalibrationSample | null;
};

function buildRelativeRef(paths: WorkspacePaths, absolutePath: string): string {
  return relative(paths.rootDir, absolutePath);
}

function buildRunCurrentRef(paths: WorkspacePaths, runId: string): string {
  return buildRelativeRef(paths, resolveRunPaths(paths, runId).currentFile);
}

function buildRunGovernanceRef(paths: WorkspacePaths, runId: string): string {
  return buildRelativeRef(paths, resolveRunPaths(paths, runId).governanceFile);
}

async function readRunPolicyRuntimeSurface(
  paths: WorkspacePaths,
  runId: string
): Promise<RunPolicyRuntimeSurface> {
  const policyRuntimeRef = buildRelativeRef(paths, resolveRunPaths(paths, runId).policyFile);
  try {
    return {
      policyRuntime: await readRunPolicyRuntimeStrict(paths, runId),
      policyRuntimeRef,
      policyRuntimeInvalidReason: null
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
      return {
        policyRuntime: null,
        policyRuntimeRef: null,
        policyRuntimeInvalidReason: null
      };
    }

    return {
      policyRuntime: null,
      policyRuntimeRef,
      policyRuntimeInvalidReason:
        error instanceof Error ? error.message : "Policy runtime is unreadable."
    };
  }
}

function buildRunMaintenancePlaneRef(paths: WorkspacePaths, runId: string): string {
  return buildRelativeRef(paths, resolveRunPaths(paths, runId).maintenancePlaneFile);
}

function buildRuntimeHealthSnapshotRef(paths: WorkspacePaths, runId: string): string {
  return buildRelativeRef(paths, resolveRunPaths(paths, runId).runtimeHealthSnapshotFile);
}

function buildAttemptRef(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string,
  key:
    | "preflightEvaluationFile"
    | "handoffBundleFile"
    | "reviewPacketFile"
    | "runtimeVerificationFile"
    | "adversarialVerificationFile"
    | "evaluatorCalibrationSampleFile"
): string {
  return buildRelativeRef(paths, resolveAttemptPaths(paths, runId, attemptId)[key]);
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
}): Promise<LatestEvidenceArtifacts> {
  if (!input.latestAttempt) {
    return {
      evidenceAttempt: null,
      latestPreflight: null,
      latestHandoff: null,
      latestReviewPacket: null,
      latestRuntimeVerification: null,
      latestAdversarialVerification: null,
      latestEvaluatorCalibrationSample: null
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
      latestPreflight,
      latestHandoff,
      latestReviewPacket,
      latestRuntimeVerification,
      latestAdversarialVerification,
      latestEvaluatorCalibrationSample
    ] = await Promise.all([
      getAttemptPreflightEvaluation(input.paths, input.runId, candidate.id),
      getAttemptHandoffBundle(input.paths, input.runId, candidate.id),
      getAttemptReviewPacket(input.paths, input.runId, candidate.id),
      getAttemptRuntimeVerification(input.paths, input.runId, candidate.id),
      getAttemptAdversarialVerification(input.paths, input.runId, candidate.id),
      getAttemptEvaluatorCalibrationSample(input.paths, input.runId, candidate.id)
    ]);

    if (
      latestPreflight ||
      latestHandoff ||
      latestReviewPacket ||
      latestRuntimeVerification ||
      latestAdversarialVerification ||
      latestEvaluatorCalibrationSample
    ) {
      return {
        evidenceAttempt: candidate,
        latestPreflight,
        latestHandoff,
        latestReviewPacket,
        latestRuntimeVerification,
        latestAdversarialVerification,
        latestEvaluatorCalibrationSample
      };
    }
  }

  return {
    evidenceAttempt: input.latestAttempt,
    latestPreflight: null,
    latestHandoff: null,
    latestReviewPacket: null,
    latestRuntimeVerification: null,
    latestAdversarialVerification: null,
    latestEvaluatorCalibrationSample: null
  };
}

function buildWorkingContextOutput(
  workingContextView: RunWorkingContextView
): RunMaintenanceOutput {
  const workingContext = workingContextView.working_context;
  const degraded = workingContextView.working_context_degraded;
  return {
    key: "working_context",
    label: "运行现场",
    plane: "maintenance",
    status: degraded.is_degraded
      ? "degraded"
      : workingContext
        ? "ready"
        : "not_available",
    ref: workingContextView.working_context_ref,
    summary:
      degraded.summary ??
      workingContext?.next_operator_attention ??
      workingContext?.current_focus ??
      null
  };
}

function buildRunBriefOutput(runBriefView: RunBriefView): RunMaintenanceOutput {
  const runBrief = runBriefView.run_brief;
  const degraded = runBriefView.run_brief_degraded;
  return {
    key: "run_brief",
    label: "操作员摘要",
    plane: "maintenance",
    status: degraded.is_degraded
      ? "degraded"
      : !runBrief
      ? "not_available"
      : runBrief.failure_signal
        ? "attention"
        : "ready",
    ref: runBriefView.run_brief_ref,
    summary:
      degraded.summary ??
      runBriefView.run_brief_invalid_reason ??
      runBrief?.headline ??
      runBrief?.summary ??
      null
  };
}

function buildRunPolicyOutput(input: {
  policyRuntime: RunPolicyRuntime | null;
  policyRuntimeRef: string | null;
  policyRuntimeInvalidReason: string | null;
}): RunMaintenanceOutput {
  const policyRuntime = input.policyRuntime;
  return {
    key: "policy_runtime",
    label: "策略边界",
    plane: "maintenance",
    status: input.policyRuntimeInvalidReason
      ? "degraded"
      : !policyRuntime
      ? "not_available"
      : policyRuntime.killswitch_active ||
          policyRuntime.approval_status === "pending" ||
          policyRuntime.approval_status === "rejected"
        ? "attention"
        : "ready",
    ref: input.policyRuntimeRef,
    summary: input.policyRuntimeInvalidReason ??
      policyRuntime?.blocking_reason ??
      policyRuntime?.proposed_objective ??
      policyRuntime?.last_decision ??
      null
  };
}

function buildRunHealthOutput(runHealth: RunHealthAssessment): RunMaintenanceOutput {
  return {
    key: "run_health",
    label: "运行健康",
    plane: "maintenance",
    status:
      runHealth.status === "healthy"
        ? "ready"
        : runHealth.status === "unknown"
          ? "degraded"
          : "attention",
    ref: null,
    summary: runHealth.summary
  };
}

function buildEffectivePolicyOutput(
  effectivePolicyBundle: RunEffectivePolicyBundleView
): RunMaintenanceOutput {
  const refreshSummary =
    effectivePolicyBundle.maintenance_refresh.strategy === "saved_boundary_snapshot"
      ? "saved boundary snapshot"
      : "live recompute";

  return {
    key: "effective_policy",
    label: "有效策略包",
    plane: "maintenance",
    status: "ready",
    ref: null,
    summary: `Maintenance reads use ${refreshSummary}; settled recovery stays ${effectivePolicyBundle.recovery.settled_run}.`
  };
}

function buildHistoryContractDriftOutput(input: {
  runtimeHealthSnapshot: Awaited<ReturnType<typeof getRunRuntimeHealthSnapshot>> | null;
  snapshotRef: string | null;
}): RunMaintenanceOutput {
  const snapshot = input.runtimeHealthSnapshot;
  if (!snapshot) {
    return {
      key: "history_contract_drift",
      label: "历史漂移",
      plane: "maintenance",
      status: "not_available",
      ref: null,
      summary: "runtime health snapshot 尚未落盘。"
    };
  }

  return {
    key: "history_contract_drift",
    label: "历史漂移",
    plane: "maintenance",
    status:
      snapshot.history_contract_drift.status === "drift_detected"
        ? "attention"
        : "ready",
    ref: input.snapshotRef,
    summary: snapshot.history_contract_drift.summary
  };
}

function buildReviewPacketOutput(input: {
  reviewPacket: AttemptReviewPacket | null;
  reviewPacketRef: string | null;
}): RunMaintenanceOutput {
  if (!input.reviewPacket) {
    return {
      key: "review_packet_summary",
      label: "评审摘要",
      plane: "maintenance",
      status: "not_available",
      ref: null,
      summary: "review packet 尚未落盘。"
    };
  }

  return {
    key: "review_packet_summary",
    label: "评审摘要",
    plane: "maintenance",
    status: input.reviewPacket.failure_context ? "attention" : "ready",
    ref: input.reviewPacketRef,
    summary:
      input.reviewPacket.failure_context?.message ??
      input.reviewPacket.evaluation?.rationale ??
      "latest review packet"
  };
}

function buildVerifierOutput(input: {
  preflight: Awaited<ReturnType<typeof getAttemptPreflightEvaluation>> | null;
  preflightRef: string | null;
  runtimeVerification: AttemptRuntimeVerification | null;
  runtimeVerificationRef: string | null;
  adversarialVerification: AttemptAdversarialVerification | null;
  adversarialVerificationRef: string | null;
}): RunMaintenanceOutput {
  if (input.preflight?.status === "failed") {
    return {
      key: "verifier_summary",
      label: "验证摘要",
      plane: "maintenance",
      status: "attention",
      ref: input.preflightRef,
      summary:
        input.preflight.failure_reason ??
        `status=${input.preflight.status}`
    };
  }

  if (!input.runtimeVerification && !input.adversarialVerification) {
    return {
      key: "verifier_summary",
      label: "验证摘要",
      plane: "maintenance",
      status: "not_available",
      ref: null,
      summary: "runtime verification 和 adversarial verification 尚未落盘。"
    };
  }

  const adversarialSummary =
    input.adversarialVerification?.failure_reason ??
    input.adversarialVerification?.summary ??
    (input.adversarialVerification
      ? `status=${input.adversarialVerification.status}`
      : null);
  const runtimeSummary =
    input.runtimeVerification?.failure_reason ??
    (input.runtimeVerification ? `status=${input.runtimeVerification.status}` : null);
  const hasFailure =
    input.adversarialVerification?.status === "failed" ||
    input.runtimeVerification?.status === "failed";

  return {
    key: "verifier_summary",
    label: "验证摘要",
    plane: "maintenance",
    status: hasFailure ? "attention" : "ready",
    ref:
      input.adversarialVerificationRef ??
      input.runtimeVerificationRef,
    summary: adversarialSummary ?? runtimeSummary
  };
}

function buildEvaluatorCalibrationOutput(input: {
  sample: AttemptEvaluatorCalibrationSample | null;
  sampleRef: string | null;
}): RunMaintenanceOutput {
  if (!input.sample) {
    return {
      key: "evaluator_calibration",
      label: "校准样本",
      plane: "maintenance",
      status: "not_available",
      ref: null,
      summary: "最新 settled attempt 尚未产出 evaluator calibration sample。"
    };
  }

  const firstDerivedMode = input.sample.derived_failure_modes[0] ?? null;
  return {
    key: "evaluator_calibration",
    label: "校准样本",
    plane: "maintenance",
    status:
      input.sample.derived_failure_modes.length > 0 ||
      input.sample.failure_code !== null
        ? "attention"
        : "ready",
    ref: input.sampleRef,
    summary:
      firstDerivedMode?.summary ??
      input.sample.summary ??
      "latest evaluator calibration sample"
  };
}

function buildBlockedDiagnosis(input: {
  runId: string;
  paths: WorkspacePaths;
  current: CurrentDecision | null;
  governance: RunGovernanceState | null;
  runBrief: RunBrief | null;
  runBriefRef: string | null;
  failureSignal: RunFailureSignal | null;
  runHealth: RunHealthAssessment;
  workingContext: RunWorkingContext | null;
  latestHandoffRef: string | null;
}): ReturnType<typeof createRunBlockedDiagnosis> {
  if (!input.current) {
    return createRunBlockedDiagnosis({
      status: "not_applicable",
      summary: "current decision 缺失，无法建立阻塞诊断。",
      source_ref: null
    });
  }

  const evidenceRefs = Array.from(
    new Set(
      [
        input.workingContext?.current_blocker?.ref ?? null,
        input.latestHandoffRef,
        ...((input.runBrief?.evidence_refs ?? []).map(
          (item: NonNullable<RunBrief>["evidence_refs"][number]) => item.ref
        ))
      ].filter((value: string | null): value is string => Boolean(value))
    )
  ).slice(0, 5);

  if (input.runHealth.status === "stale_running_attempt") {
    return createRunBlockedDiagnosis({
      status: "attention",
      summary: input.runHealth.summary,
      recommended_next_action:
        input.runBrief?.recommended_next_action ??
        input.current.recommended_next_action,
      source_ref: buildRunCurrentRef(input.paths, input.runId),
      evidence_refs: evidenceRefs
    });
  }

  const failureSignal = input.failureSignal;
  if (failureSignal) {
    return createRunBlockedDiagnosis({
      status: "attention",
      summary:
        failureSignal.summary ??
        input.current.blocking_reason ??
        input.runBrief?.headline ??
        input.current.summary,
      recommended_next_action:
        input.runBrief?.recommended_next_action ??
        input.current.recommended_next_action,
      source_ref:
        failureSignal.source_ref ??
        input.workingContext?.current_blocker?.ref ??
        input.latestHandoffRef ??
        input.runBriefRef ??
        (input.governance?.status === "blocked"
          ? buildRunGovernanceRef(input.paths, input.runId)
          : buildRunCurrentRef(input.paths, input.runId)),
      evidence_refs: evidenceRefs
    });
  }

  if (input.current.waiting_for_human || input.governance?.status === "blocked") {
    return createRunBlockedDiagnosis({
      status: "attention",
      summary:
        input.current.blocking_reason ??
        input.governance?.context_summary.blocker_summary ??
        input.runBrief?.failure_signal?.summary ??
        input.runBrief?.headline ??
        input.current.summary,
      recommended_next_action:
        input.runBrief?.recommended_next_action ??
        input.current.recommended_next_action,
      source_ref:
        input.workingContext?.current_blocker?.ref ??
        (input.governance?.status === "blocked"
          ? buildRunGovernanceRef(input.paths, input.runId)
          : buildRunCurrentRef(input.paths, input.runId)),
      evidence_refs: evidenceRefs
    });
  }

  return createRunBlockedDiagnosis({
    status: "clear",
    summary: input.runBrief?.headline ?? input.current.summary,
    recommended_next_action:
      input.runBrief?.recommended_next_action ??
      input.current.recommended_next_action,
    source_ref: buildRunCurrentRef(input.paths, input.runId),
    evidence_refs: evidenceRefs
  });
}

function buildSignalSources(input: {
  paths: WorkspacePaths;
  runId: string;
  current: CurrentDecision | null;
  governance: RunGovernanceState | null;
  policyRuntime: RunPolicyRuntime | null;
  policyRuntimeRef: string | null;
  policyRuntimeInvalidReason: string | null;
  workingContextView: RunWorkingContextView;
  runBriefView: RunBriefView;
  runHealth: RunHealthAssessment;
  blockedDiagnosis: ReturnType<typeof createRunBlockedDiagnosis>;
  historyContractDriftOutput: RunMaintenanceOutput;
  reviewPacketOutput: RunMaintenanceOutput;
  verifierOutput: RunMaintenanceOutput;
  effectivePolicyBundle: RunEffectivePolicyBundleView | null;
  latestEvidence: LatestEvidenceArtifacts;
}): RunMaintenanceSource[] {
  const sources: RunMaintenanceSource[] = [];
  if (input.current) {
    sources.push({
      key: "current_decision",
      label: "当前判断",
      plane: "mainline",
      ref: buildRunCurrentRef(input.paths, input.runId),
      summary: input.current.blocking_reason ?? input.current.summary
    });
  }
  if (input.governance) {
    sources.push({
      key: "governance",
      label: "治理主线",
      plane: "mainline",
      ref: buildRunGovernanceRef(input.paths, input.runId),
      summary:
        input.governance.context_summary.blocker_summary ??
        input.governance.context_summary.headline
    });
  }
  if (input.policyRuntime || input.policyRuntimeInvalidReason) {
    sources.push({
      key: "policy_runtime",
      label: "策略边界",
      plane: "mainline",
      ref: input.policyRuntimeRef,
      summary:
        input.policyRuntimeInvalidReason ??
        input.policyRuntime?.blocking_reason ??
        input.policyRuntime?.proposed_objective ??
        input.policyRuntime?.last_decision
    });
  }
  if (input.latestEvidence.latestPreflight && input.latestEvidence.evidenceAttempt) {
    sources.push({
      key: "preflight_evaluation",
      label: "Preflight",
      plane: "mainline",
      ref: buildAttemptRef(
        input.paths,
        input.runId,
        input.latestEvidence.evidenceAttempt.id,
        "preflightEvaluationFile"
      ),
      summary:
        input.latestEvidence.latestPreflight.failure_reason ??
        `status=${input.latestEvidence.latestPreflight.status}`
    });
  }
  if (input.latestEvidence.latestHandoff && input.latestEvidence.evidenceAttempt) {
    sources.push({
      key: "handoff_bundle",
      label: "交接包",
      plane: "mainline",
      ref: buildAttemptRef(
        input.paths,
        input.runId,
        input.latestEvidence.evidenceAttempt.id,
        "handoffBundleFile"
      ),
      summary:
        input.latestEvidence.latestHandoff.summary ??
        input.latestEvidence.latestHandoff.failure_context?.message ??
        input.latestEvidence.latestHandoff.failure_code
    });
  }
  if (
    input.latestEvidence.latestEvaluatorCalibrationSample &&
    input.latestEvidence.evidenceAttempt
  ) {
    sources.push({
      key: "evaluator_calibration",
      label: "校准样本",
      plane: "maintenance",
      ref: buildAttemptRef(
        input.paths,
        input.runId,
        input.latestEvidence.evidenceAttempt.id,
        "evaluatorCalibrationSampleFile"
      ),
      summary:
        input.latestEvidence.latestEvaluatorCalibrationSample.derived_failure_modes[0]
          ?.summary ??
        input.latestEvidence.latestEvaluatorCalibrationSample.summary
    });
  }
  sources.push({
    key: "working_context",
    label: "运行现场",
    plane: "maintenance",
    ref: input.workingContextView.working_context_ref,
    summary:
      input.workingContextView.working_context_degraded.summary ??
      input.workingContextView.working_context?.next_operator_attention ??
      input.workingContextView.working_context?.current_focus ??
      null
  });
  sources.push({
    key: "run_brief",
    label: "操作员摘要",
    plane: "maintenance",
    ref: input.runBriefView.run_brief_ref,
    summary:
      input.runBriefView.run_brief_degraded.summary ??
      input.runBriefView.run_brief_invalid_reason ??
      input.runBriefView.run_brief?.headline ??
      input.runBriefView.run_brief?.summary ??
      null
  });
  if (input.effectivePolicyBundle) {
    sources.push({
      key: "effective_policy",
      label: "有效策略包",
      plane: "maintenance",
      ref: null,
      summary:
        input.effectivePolicyBundle.verification_discipline.summary ??
        input.effectivePolicyBundle.maintenance_refresh.detail
    });
  }
  sources.push({
    key: "run_health",
    label: "运行健康",
    plane: "maintenance",
    ref: null,
    summary: input.runHealth.summary
  });
  sources.push({
    key: "blocked_run_diagnosis",
    label: "阻塞诊断",
    plane: "maintenance",
    ref: input.blockedDiagnosis.source_ref,
    summary: input.blockedDiagnosis.summary
  });
  sources.push({
    key: "history_contract_drift",
    label: "历史漂移",
    plane: "maintenance",
    ref: input.historyContractDriftOutput.ref,
    summary: input.historyContractDriftOutput.summary
  });
  sources.push({
    key: "review_packet_summary",
    label: "评审摘要",
    plane: "maintenance",
    ref: input.reviewPacketOutput.ref,
    summary: input.reviewPacketOutput.summary
  });
  sources.push({
    key: "verifier_summary",
    label: "验证摘要",
    plane: "maintenance",
    ref: input.verifierOutput.ref,
    summary: input.verifierOutput.summary
  });
  return sources;
}

export async function buildRunMaintenancePlane(
  paths: WorkspacePaths,
  runId: string,
  options: RefreshRunMaintenancePlaneOptions
): Promise<RunMaintenancePlane> {
  const [
    run,
    current,
    governance,
    policyRuntimeSurface,
    attempts,
    workingContextView,
    runBriefView,
    runtimeHealthSnapshot
  ] =
    await Promise.all([
      getRun(paths, runId),
      getCurrentDecision(paths, runId),
      getRunGovernanceState(paths, runId),
      readRunPolicyRuntimeSurface(paths, runId),
      listAttempts(paths, runId),
      readRunWorkingContextView(paths, runId),
      readRunBriefView(paths, runId),
      getRunRuntimeHealthSnapshot(paths, runId)
    ]);
  const effectivePolicyBundle = run
    ? describeRunEffectivePolicyBundle(run)
    : null;
  const policyRuntime = policyRuntimeSurface.policyRuntime;
  const latestAttempt = pickLatestAttempt(attempts, current);
  const latestEvidence = await resolveLatestEvidenceArtifacts({
    paths,
    runId,
    latestAttempt,
    attempts
  });
  const [latestRuntimeState, latestHeartbeat] = latestAttempt
    ? await Promise.all([
        getAttemptRuntimeState(paths, runId, latestAttempt.id),
        getAttemptHeartbeat(paths, runId, latestAttempt.id)
      ])
    : [null, null];
  const runHealth = assessRunHealth({
    current,
    latestAttempt,
    latestRuntimeState,
    latestHeartbeat,
    staleAfterMs: options.staleAfterMs
  });
  const evidenceAttempt = latestEvidence.evidenceAttempt;
  const preflightRef =
    evidenceAttempt && latestEvidence.latestPreflight
      ? buildAttemptRef(paths, runId, evidenceAttempt.id, "preflightEvaluationFile")
      : null;
  const handoffRef =
    evidenceAttempt && latestEvidence.latestHandoff
      ? buildAttemptRef(paths, runId, evidenceAttempt.id, "handoffBundleFile")
      : null;
  const runtimeVerificationRef =
    evidenceAttempt && latestEvidence.latestRuntimeVerification
      ? buildAttemptRef(paths, runId, evidenceAttempt.id, "runtimeVerificationFile")
      : null;
  const adversarialVerificationRef =
    evidenceAttempt && latestEvidence.latestAdversarialVerification
      ? buildAttemptRef(paths, runId, evidenceAttempt.id, "adversarialVerificationFile")
      : null;
  const evaluatorCalibrationSampleRef =
    evidenceAttempt && latestEvidence.latestEvaluatorCalibrationSample
      ? buildAttemptRef(paths, runId, evidenceAttempt.id, "evaluatorCalibrationSampleFile")
      : null;
  const runSurfaceFailureSignal = deriveRunSurfaceFailureSignal({
    latestAttempt,
    current,
    runBrief: runBriefView.run_brief,
    runBriefRef: runBriefView.run_brief_ref,
    runBriefDegraded: runBriefView.run_brief_degraded,
    preflight: latestEvidence.latestPreflight,
    preflightRef,
    runtimeVerification: latestEvidence.latestRuntimeVerification,
    runtimeVerificationRef,
    adversarialVerification: latestEvidence.latestAdversarialVerification,
    adversarialVerificationRef,
    handoff: latestEvidence.latestHandoff,
    handoffRef,
    workingContextDegraded: workingContextView.working_context_degraded,
    workingContextRef: workingContextView.working_context_ref
  });
  const historyContractDriftOutput = buildHistoryContractDriftOutput({
    runtimeHealthSnapshot,
    snapshotRef: runtimeHealthSnapshot
      ? buildRuntimeHealthSnapshotRef(paths, runId)
      : null
  });
  const reviewPacketOutput = buildReviewPacketOutput({
    reviewPacket: latestEvidence.latestReviewPacket,
    reviewPacketRef:
      evidenceAttempt && latestEvidence.latestReviewPacket
        ? buildAttemptRef(paths, runId, evidenceAttempt.id, "reviewPacketFile")
        : null
  });
  const verifierOutput = buildVerifierOutput({
    preflight: latestEvidence.latestPreflight,
    preflightRef,
    runtimeVerification: latestEvidence.latestRuntimeVerification,
    runtimeVerificationRef,
    adversarialVerification: latestEvidence.latestAdversarialVerification,
    adversarialVerificationRef
  });
  const evaluatorCalibrationOutput = buildEvaluatorCalibrationOutput({
    sample: latestEvidence.latestEvaluatorCalibrationSample,
    sampleRef: evaluatorCalibrationSampleRef
  });
  const blockedDiagnosis = buildBlockedDiagnosis({
    runId,
    paths,
    current,
    governance,
    runBrief: runBriefView.run_brief,
    runBriefRef: runBriefView.run_brief_ref,
    failureSignal: runSurfaceFailureSignal,
    runHealth,
    workingContext: workingContextView.working_context,
    latestHandoffRef: handoffRef
  });

  return createRunMaintenancePlane({
    run_id: runId,
    run_health: runHealth,
    outputs: [
      buildRunPolicyOutput({
        policyRuntime,
        policyRuntimeRef: policyRuntimeSurface.policyRuntimeRef,
        policyRuntimeInvalidReason: policyRuntimeSurface.policyRuntimeInvalidReason
      }),
      ...(effectivePolicyBundle ? [buildEffectivePolicyOutput(effectivePolicyBundle)] : []),
      buildWorkingContextOutput(workingContextView),
      buildRunBriefOutput(runBriefView),
      buildRunHealthOutput(runHealth),
      historyContractDriftOutput,
      reviewPacketOutput,
      verifierOutput,
      evaluatorCalibrationOutput
    ],
    signal_sources: buildSignalSources({
      paths,
      runId,
      current,
      governance,
      policyRuntime,
      policyRuntimeRef: policyRuntimeSurface.policyRuntimeRef,
      policyRuntimeInvalidReason: policyRuntimeSurface.policyRuntimeInvalidReason,
      workingContextView,
      runBriefView,
      runHealth,
      blockedDiagnosis,
      historyContractDriftOutput,
      reviewPacketOutput,
      verifierOutput,
      effectivePolicyBundle,
      latestEvidence
    }),
    blocked_diagnosis: blockedDiagnosis
  });
}

async function appendMaintenanceRefreshFailure(input: {
  paths: WorkspacePaths;
  runId: string;
  type: "run.working_context.refresh_failed" | "run.run_brief.refresh_failed" | "run.maintenance_plane.refresh_failed";
  failureClass: "working_context_degraded" | "run_brief_degraded";
  reasonCode: string;
  summary: string;
  detail: string;
}): Promise<void> {
  await appendRunJournal(
    input.paths,
    createRunJournalEntry({
      run_id: input.runId,
      type: input.type,
      payload: {
        failure_class: input.failureClass,
        failure_policy_mode: "soft_degrade",
        reason_code: input.reasonCode,
        summary: input.summary,
        detail: input.detail
      }
    })
  );
}

export async function refreshRunMaintenancePlane(
  paths: WorkspacePaths,
  runId: string,
  options: RefreshRunMaintenancePlaneOptions = { staleAfterMs: 60_000 }
): Promise<RunMaintenancePlane> {
  try {
    await refreshRunWorkingContext(paths, runId);
  } catch (error) {
    if (!(error instanceof RunWorkingContextWriteError)) {
      throw error;
    }
    await appendMaintenanceRefreshFailure({
      paths,
      runId,
      type: "run.working_context.refresh_failed",
      failureClass: "working_context_degraded",
      reasonCode: "context_write_failed",
      summary: "working context 写入失败，当前现场不可信。",
      detail: error.message
    });
  }

  try {
    await refreshRunBrief(paths, runId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await appendMaintenanceRefreshFailure({
      paths,
      runId,
      type: "run.run_brief.refresh_failed",
      failureClass: "run_brief_degraded",
      reasonCode: "run_brief_write_failed",
      summary: "run brief 写入失败，控制面摘要已退化。",
      detail
    });
  }

  const maintenancePlane = await buildRunMaintenancePlane(paths, runId, options);
  try {
    await saveRunMaintenancePlane(paths, maintenancePlane);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await appendMaintenanceRefreshFailure({
      paths,
      runId,
      type: "run.maintenance_plane.refresh_failed",
      failureClass: "run_brief_degraded",
      reasonCode: "maintenance_plane_write_failed",
      summary: "maintenance plane 写入失败，保留主链真相，维护视图已退化。",
      detail
    });
  }

  return maintenancePlane;
}

export async function readRunMaintenancePlaneView(
  paths: WorkspacePaths,
  runId: string,
  options: RefreshRunMaintenancePlaneOptions = { staleAfterMs: 60_000 }
): Promise<RunMaintenancePlaneView> {
  const [run, savedMaintenancePlane] = await Promise.all([
    getRun(paths, runId),
    getRunMaintenancePlane(paths, runId)
  ]);
  const effectivePolicyBundle = run
    ? describeRunEffectivePolicyBundle(run)
    : null;
  if (
    savedMaintenancePlane &&
    effectivePolicyBundle &&
    !effectivePolicyBundle.maintenance_refresh.refreshes_on_read
  ) {
    return {
      maintenance_plane: savedMaintenancePlane,
      maintenance_plane_ref: buildRunMaintenancePlaneRef(paths, runId)
    };
  }
  const maintenancePlane = await buildRunMaintenancePlane(paths, runId, {
    staleAfterMs: options.staleAfterMs
  });

  return {
    maintenance_plane: maintenancePlane,
    maintenance_plane_ref: savedMaintenancePlane
      ? buildRunMaintenancePlaneRef(paths, runId)
      : null
  };
}

export const refreshRunOperatorSurface = refreshRunMaintenancePlane;
