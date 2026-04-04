import { join, relative } from "node:path";
import {
  createCurrentDecision,
  createRunAutomationControl,
  createRunGovernanceState,
  createRunWorkingContext,
  createRunWorkingContextDegradedState,
  type Attempt,
  type CurrentDecision,
  type RunAutomationControl,
  type RunGovernanceState,
  type RunSteer,
  type RunWorkingContext,
  type RunWorkingContextDegradedState
} from "@autoresearch/domain";
import {
  buildProjectRef,
  getAttemptContract,
  getAttemptHandoffBundle,
  getAttemptPreflightEvaluation,
  getAttemptReviewPacket,
  getAttemptRuntimeVerification,
  getAttachedProjectBaselineSnapshot,
  getAttachedProjectCapabilitySnapshot,
  getAttachedProjectProfile,
  getCurrentDecision,
  getRun,
  getRunAutomationControl,
  getRunGovernanceState,
  getRunWorkingContext,
  listAttempts,
  listRunJournal,
  listRunSteers,
  resolveAttemptPaths,
  resolveRunPaths,
  saveRunWorkingContext,
  type WorkspacePaths
} from "@autoresearch/state-store";

export type RunWorkingContextView = {
  working_context: RunWorkingContext | null;
  working_context_ref: string | null;
  working_context_degraded: RunWorkingContextDegradedState;
};

export class RunWorkingContextWriteError extends Error {
  readonly causeError: unknown;

  constructor(message: string, causeError: unknown) {
    super(message);
    this.name = "RunWorkingContextWriteError";
    this.causeError = causeError;
  }
}

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

function buildRunContractRef(paths: WorkspacePaths, runId: string): string {
  return buildRelativeRef(paths, resolveRunPaths(paths, runId).contractFile);
}

function buildRunCurrentRef(paths: WorkspacePaths, runId: string): string {
  return buildRelativeRef(paths, resolveRunPaths(paths, runId).currentFile);
}

function buildRunAutomationRef(paths: WorkspacePaths, runId: string): string {
  return buildRelativeRef(paths, resolveRunPaths(paths, runId).automationFile);
}

function buildRunGovernanceRef(paths: WorkspacePaths, runId: string): string {
  return buildRelativeRef(paths, resolveRunPaths(paths, runId).governanceFile);
}

function buildRunSteerRef(paths: WorkspacePaths, runId: string, steerId: string): string {
  return buildRelativeRef(paths, join(resolveRunPaths(paths, runId).steersDir, `${steerId}.json`));
}

function buildAttemptContractRef(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): string {
  return buildRelativeRef(paths, resolveAttemptPaths(paths, runId, attemptId).contractFile);
}

function buildAttemptMetaRef(paths: WorkspacePaths, runId: string, attemptId: string): string {
  return buildRelativeRef(paths, resolveAttemptPaths(paths, runId, attemptId).metaFile);
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

function buildAttemptReviewPacketRef(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): string {
  return buildRelativeRef(
    paths,
    resolveAttemptPaths(paths, runId, attemptId).reviewPacketFile
  );
}

function buildAttemptHandoffBundleRef(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): string {
  return buildRelativeRef(
    paths,
    resolveAttemptPaths(paths, runId, attemptId).handoffBundleFile
  );
}

function buildAttachedProjectBaselineRefs(input: {
  paths: WorkspacePaths;
  projectId: string;
  project: Awaited<ReturnType<typeof getAttachedProjectProfile>> | null;
  baselineSnapshot: Awaited<ReturnType<typeof getAttachedProjectBaselineSnapshot>>;
  capabilitySnapshot: Awaited<ReturnType<typeof getAttachedProjectCapabilitySnapshot>>;
}): RunWorkingContext["baseline_refs"] {
  const refs: RunWorkingContext["baseline_refs"] = [];

  if (input.project) {
    refs.push({
      kind: "project_profile",
      ref: buildProjectRef(input.paths, input.projectId, "profileFile"),
      note: `${input.project.project_type} / ${input.project.primary_language}`
    });
  }

  if (input.baselineSnapshot) {
    refs.push({
      kind: "baseline_snapshot",
      ref: buildProjectRef(input.paths, input.projectId, "baselineSnapshotFile"),
      note:
        input.baselineSnapshot.git.head_sha
          ? `head=${input.baselineSnapshot.git.head_sha}`
          : "git baseline captured"
    });
  }

  if (input.capabilitySnapshot) {
    refs.push({
      kind: "capability_snapshot",
      ref: buildProjectRef(input.paths, input.projectId, "capabilitySnapshotFile"),
      note: `status=${input.capabilitySnapshot.overall_status}`
    });
  }

  return refs;
}

function buildAttachedProjectKeyFileRefs(input: {
  project: Awaited<ReturnType<typeof getAttachedProjectProfile>> | null;
}): RunWorkingContext["key_file_refs"] {
  if (!input.project) {
    return [];
  }

  const manifestFiles = Array.from(
    new Set(
      input.project.manifest_files.filter(
        (file: unknown): file is string => typeof file === "string"
      )
    )
  ) as string[];

  return manifestFiles
    .slice(0, 5)
    .map((file) => ({
      kind: "project_manifest",
      ref: join(input.project.workspace_root, file),
      note: input.project.detection_reasons[0] ?? "detected project manifest"
    }));
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

function pickLatestSteer(steers: RunSteer[]): RunSteer | null {
  return steers
    .slice()
    .sort((left, right) => toTimestamp(left.updated_at) - toTimestamp(right.updated_at))
    .at(-1) ?? null;
}

function pickSourceLabel(input: {
  actualRef: string | null;
  snapshotRef: string | null;
  fallback: string;
}): string {
  return input.actualRef ?? input.snapshotRef ?? input.fallback;
}

function buildSourceSnapshot(input: {
  paths: WorkspacePaths;
  runId: string;
  current: CurrentDecision | null;
  automation: RunAutomationControl | null;
  governance: RunGovernanceState | null;
  latestAttempt: Attempt | null;
  latestSteer: RunSteer | null;
}): RunWorkingContext["source_snapshot"] {
  return {
    current: {
      ref: input.current ? buildRunCurrentRef(input.paths, input.runId) : null,
      updated_at: input.current?.updated_at ?? null
    },
    automation: {
      ref: input.automation ? buildRunAutomationRef(input.paths, input.runId) : null,
      updated_at: input.automation?.updated_at ?? null
    },
    governance: {
      ref: input.governance ? buildRunGovernanceRef(input.paths, input.runId) : null,
      updated_at: input.governance?.updated_at ?? null
    },
    latest_attempt: {
      ref: input.latestAttempt
        ? buildAttemptMetaRef(input.paths, input.runId, input.latestAttempt.id)
        : null,
      updated_at: input.latestAttempt?.updated_at ?? null,
      attempt_id: input.latestAttempt?.id ?? null
    },
    latest_steer: {
      ref: input.latestSteer
        ? buildRunSteerRef(input.paths, input.runId, input.latestSteer.id)
        : null,
      updated_at: input.latestSteer?.updated_at ?? null,
      steer_id: input.latestSteer?.id ?? null
    }
  };
}

function buildCurrentFocus(input: {
  current: CurrentDecision | null;
  latestAttempt: Attempt | null;
  latestAttemptObjective: string | null;
  queuedSteers: RunSteer[];
  runDescription: string;
}): string {
  if (
    input.current?.recommended_next_action === "apply_steer" &&
    input.queuedSteers[0]?.content
  ) {
    return input.queuedSteers[0].content;
  }

  return (
    input.latestAttemptObjective ??
    input.latestAttempt?.objective ??
    input.current?.summary ??
    input.runDescription
  );
}

function buildCurrentBlocker(input: {
  paths: WorkspacePaths;
  runId: string;
  current: CurrentDecision | null;
  automation: RunAutomationControl;
  governance: RunGovernanceState;
}): RunWorkingContext["current_blocker"] {
  if (input.automation.mode === "manual_only") {
    const summary =
      input.automation.reason ??
      input.current?.blocking_reason ??
      input.current?.summary;
    return summary
      ? {
          code: input.automation.reason_code,
          summary,
          ref: buildRunAutomationRef(input.paths, input.runId)
        }
      : null;
  }

  if (input.current?.blocking_reason) {
    return {
      code: input.governance.active_problem_signature,
      summary: input.current.blocking_reason,
      ref:
        input.governance.status === "blocked"
          ? buildRunGovernanceRef(input.paths, input.runId)
          : buildRunCurrentRef(input.paths, input.runId)
    };
  }

  if (
    input.governance.status === "blocked" &&
    input.governance.active_problem_summary
  ) {
    return {
      code: input.governance.active_problem_signature,
      summary: input.governance.active_problem_summary,
      ref: buildRunGovernanceRef(input.paths, input.runId)
    };
  }

  return null;
}

function buildNextOperatorAttention(input: {
  current: CurrentDecision | null;
  blocker: RunWorkingContext["current_blocker"];
  queuedSteers: RunSteer[];
  focus: string;
}): string {
  if (input.current?.waiting_for_human) {
    return input.blocker?.summary ?? input.current.summary ?? input.focus;
  }

  if (
    input.current?.recommended_next_action === "apply_steer" &&
    input.queuedSteers[0]
  ) {
    return `优先应用 steer ${input.queuedSteers[0].id}。`;
  }

  if (input.current?.recommended_next_action) {
    return `当前建议动作是 ${input.current.recommended_next_action}。`;
  }

  return input.current?.summary ?? input.focus;
}

function buildDegradedState(input: {
  paths: WorkspacePaths;
  runId: string;
  workingContext: RunWorkingContext | null;
  current: CurrentDecision | null;
  automation: RunAutomationControl | null;
  governance: RunGovernanceState | null;
  latestAttempt: Attempt | null;
  latestSteer: RunSteer | null;
  latestRefreshFailure: {
    ts: string;
    reason_code: string | null;
    summary: string | null;
  } | null;
}): RunWorkingContextDegradedState {
  const workingContextUpdatedAt = toTimestamp(input.workingContext?.updated_at);
  const latestRefreshFailureAt = toTimestamp(input.latestRefreshFailure?.ts);

  if (
    input.latestRefreshFailure &&
    (!input.workingContext || latestRefreshFailureAt > workingContextUpdatedAt)
  ) {
    return createRunWorkingContextDegradedState({
      is_degraded: true,
      reason_code: "context_write_failed",
      summary:
        input.latestRefreshFailure.summary ??
        "working context 写入失败，当前现场不可信。"
    });
  }

  if (!input.workingContext) {
    return createRunWorkingContextDegradedState({
      is_degraded: true,
      reason_code: "context_missing",
      summary: "working context 还没有落盘。"
    });
  }

  if (input.workingContext.degraded.is_degraded) {
    return input.workingContext.degraded;
  }

  const snapshot = input.workingContext.source_snapshot;
  const staleSources = [
    {
      label: pickSourceLabel({
        actualRef: input.current ? buildRunCurrentRef(input.paths, input.runId) : null,
        snapshotRef: snapshot.current.ref,
        fallback: "current"
      }),
      stale:
        toTimestamp(input.current?.updated_at) > toTimestamp(snapshot.current.updated_at)
    },
    {
      label: pickSourceLabel({
        actualRef: input.automation ? buildRunAutomationRef(input.paths, input.runId) : null,
        snapshotRef: snapshot.automation.ref,
        fallback: "automation"
      }),
      stale:
        toTimestamp(input.automation?.updated_at) > toTimestamp(snapshot.automation.updated_at)
    },
    {
      label: pickSourceLabel({
        actualRef: input.governance ? buildRunGovernanceRef(input.paths, input.runId) : null,
        snapshotRef: snapshot.governance.ref,
        fallback: "governance"
      }),
      stale:
        toTimestamp(input.governance?.updated_at) > toTimestamp(snapshot.governance.updated_at)
    },
    {
      label: pickSourceLabel({
        actualRef: input.latestAttempt
          ? buildAttemptMetaRef(input.paths, input.runId, input.latestAttempt.id)
          : null,
        snapshotRef: snapshot.latest_attempt.ref,
        fallback: "latest_attempt"
      }),
      stale:
        toTimestamp(input.latestAttempt?.updated_at) >
          toTimestamp(snapshot.latest_attempt.updated_at) ||
        (input.latestAttempt?.id ?? null) !== snapshot.latest_attempt.attempt_id ||
        (input.latestAttempt?.id ?? null) !== input.workingContext.source_attempt_id
    },
    {
      label: pickSourceLabel({
        actualRef: input.latestSteer
          ? buildRunSteerRef(input.paths, input.runId, input.latestSteer.id)
          : null,
        snapshotRef: snapshot.latest_steer.ref,
        fallback: "latest_steer"
      }),
      stale:
        toTimestamp(input.latestSteer?.updated_at) >
          toTimestamp(snapshot.latest_steer.updated_at) ||
        (input.latestSteer?.id ?? null) !== snapshot.latest_steer.steer_id
    }
  ]
    .filter((item) => item.stale)
    .map((item) => item.label);

  if (staleSources.length > 0) {
    return createRunWorkingContextDegradedState({
      is_degraded: true,
      reason_code: "context_stale",
      summary: `working context 落后于 ${Array.from(new Set(staleSources)).join(" / ")} 的最新现场。`
    });
  }

  return createRunWorkingContextDegradedState();
}

export async function buildRunWorkingContext(
  paths: WorkspacePaths,
  runId: string
): Promise<RunWorkingContext> {
  const [run, current, automationControl, governanceState, attempts, steers] =
    await Promise.all([
      getRun(paths, runId),
      getCurrentDecision(paths, runId),
      getRunAutomationControl(paths, runId),
      getRunGovernanceState(paths, runId),
      listAttempts(paths, runId),
      listRunSteers(paths, runId)
    ]);
  const currentSnapshot =
    current ??
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
  const latestAttempt = pickLatestAttempt(attempts, currentSnapshot);
  const queuedSteers = steers
    .filter((steer) => steer.status === "queued")
    .sort((left, right) => toTimestamp(right.updated_at) - toTimestamp(left.updated_at));
  const latestSteer = pickLatestSteer(steers);
  const [latestContract, latestPreflight, latestRuntimeVerification, latestReviewPacket, latestHandoffBundle] =
    latestAttempt
      ? await Promise.all([
          getAttemptContract(paths, runId, latestAttempt.id),
          getAttemptPreflightEvaluation(paths, runId, latestAttempt.id),
          getAttemptRuntimeVerification(paths, runId, latestAttempt.id),
          getAttemptReviewPacket(paths, runId, latestAttempt.id),
          getAttemptHandoffBundle(paths, runId, latestAttempt.id)
        ])
      : [null, null, null, null, null];
  const attachedProjectId = run.attached_project_id;
  const attachedProject =
    attachedProjectId === null
      ? null
      : await getAttachedProjectProfile(paths, attachedProjectId).catch(() => null);
  const [attachedProjectBaselineSnapshot, attachedProjectCapabilitySnapshot] =
    attachedProjectId === null
      ? [null, null]
      : await Promise.all([
          getAttachedProjectBaselineSnapshot(paths, attachedProjectId),
          getAttachedProjectCapabilitySnapshot(paths, attachedProjectId)
        ]);
  const baselineRefs =
    attachedProjectId === null
      ? []
      : buildAttachedProjectBaselineRefs({
          paths,
          projectId: attachedProjectId,
          project: attachedProject,
          baselineSnapshot: attachedProjectBaselineSnapshot,
          capabilitySnapshot: attachedProjectCapabilitySnapshot
        });
  const keyFileRefs = buildAttachedProjectKeyFileRefs({
    project: attachedProject
  });

  const activeTaskRefs: RunWorkingContext["active_task_refs"] = [];
  if (latestAttempt) {
    activeTaskRefs.push({
      task_id: latestAttempt.id,
      title: latestContract?.objective ?? latestAttempt.objective,
      source_ref: latestContract
        ? buildAttemptContractRef(paths, runId, latestAttempt.id)
        : buildRelativeRef(paths, resolveAttemptPaths(paths, runId, latestAttempt.id).metaFile)
    });
  }
  for (const steer of queuedSteers.slice(0, 2)) {
    activeTaskRefs.push({
      task_id: steer.id,
      title: steer.content,
      source_ref: buildRunSteerRef(paths, runId, steer.id)
    });
  }

  const recentEvidenceRefs: RunWorkingContext["recent_evidence_refs"] = [];
  if (latestAttempt && latestPreflight) {
    recentEvidenceRefs.push({
      kind: "preflight_evaluation",
      ref: buildAttemptPreflightRef(paths, runId, latestAttempt.id),
      note:
        latestPreflight.failure_reason ??
        `status=${latestPreflight.status}`
    });
  }
  if (latestAttempt && latestRuntimeVerification) {
    recentEvidenceRefs.push({
      kind: "runtime_verification",
      ref: buildAttemptRuntimeVerificationRef(paths, runId, latestAttempt.id),
      note:
        latestRuntimeVerification.failure_reason ??
        `status=${latestRuntimeVerification.status}`
    });
  }
  if (latestAttempt && latestReviewPacket) {
    recentEvidenceRefs.push({
      kind: "review_packet",
      ref: buildAttemptReviewPacketRef(paths, runId, latestAttempt.id),
      note:
        latestReviewPacket.failure_context?.message ??
        latestReviewPacket.evaluation?.rationale ??
        "latest review packet"
    });
  }
  if (latestAttempt && latestHandoffBundle) {
    recentEvidenceRefs.push({
      kind: "handoff_bundle",
      ref: buildAttemptHandoffBundleRef(paths, runId, latestAttempt.id),
      note:
        latestHandoffBundle.summary ??
        latestHandoffBundle.failure_context?.message ??
        "latest handoff bundle"
    });
  }

  const focus = buildCurrentFocus({
    current: currentSnapshot,
    latestAttempt,
    latestAttemptObjective: latestContract?.objective ?? null,
    queuedSteers,
    runDescription: run.description
  });
  const blocker = buildCurrentBlocker({
    paths,
    runId,
    current: currentSnapshot,
    automation,
    governance
  });

  return createRunWorkingContext({
    run_id: runId,
    plan_ref:
      latestAttempt && latestContract
        ? buildAttemptContractRef(paths, runId, latestAttempt.id)
        : buildRunContractRef(paths, runId),
    active_task_refs: activeTaskRefs,
    baseline_refs: baselineRefs,
    key_file_refs: keyFileRefs,
    recent_evidence_refs: recentEvidenceRefs,
    current_focus: focus,
    current_blocker: blocker,
    next_operator_attention: buildNextOperatorAttention({
      current: currentSnapshot,
      blocker,
      queuedSteers,
      focus
    }),
    automation: {
      mode: automation.mode,
      reason_code: automation.reason_code
    },
    degraded: createRunWorkingContextDegradedState(),
    source_snapshot: buildSourceSnapshot({
      paths,
      runId,
      current,
      automation: automationControl,
      governance: governanceState,
      latestAttempt,
      latestSteer
    }),
    source_attempt_id: latestAttempt?.id ?? null
  });
}

export async function refreshRunWorkingContext(
  paths: WorkspacePaths,
  runId: string
): Promise<RunWorkingContext> {
  const workingContext = await buildRunWorkingContext(paths, runId);
  try {
    await saveRunWorkingContext(paths, workingContext);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RunWorkingContextWriteError(
      `Failed to save working context for run ${runId}: ${reason}`,
      error
    );
  }
  return workingContext;
}

export async function readRunWorkingContextView(
  paths: WorkspacePaths,
  runId: string
): Promise<RunWorkingContextView> {
  const [workingContext, current, automationControl, governanceState, attempts, steers, journal] =
    await Promise.all([
      getRunWorkingContext(paths, runId),
      getCurrentDecision(paths, runId),
      getRunAutomationControl(paths, runId),
      getRunGovernanceState(paths, runId),
      listAttempts(paths, runId),
      listRunSteers(paths, runId),
      listRunJournal(paths, runId)
    ]);
  const latestAttempt = pickLatestAttempt(attempts, current);
  const latestSteer = pickLatestSteer(steers);
  const latestRefreshFailure = journal
    .filter((entry) => entry.type === "run.working_context.refresh_failed")
    .slice()
    .sort((left, right) => toTimestamp(left.ts) - toTimestamp(right.ts))
    .at(-1);
  const degraded = buildDegradedState({
    paths,
    runId,
    workingContext,
    current,
    automation: automationControl,
    governance: governanceState,
    latestAttempt,
    latestSteer,
    latestRefreshFailure: latestRefreshFailure
      ? {
          ts: latestRefreshFailure.ts,
          reason_code:
            typeof latestRefreshFailure.payload.reason_code === "string"
              ? latestRefreshFailure.payload.reason_code
              : null,
          summary:
            typeof latestRefreshFailure.payload.summary === "string"
              ? latestRefreshFailure.payload.summary
              : null
        }
      : null
  });

  return {
    working_context: workingContext,
    working_context_ref: workingContext
      ? buildRelativeRef(paths, resolveRunPaths(paths, runId).workingContextFile)
      : null,
    working_context_degraded: degraded
  };
}
