import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import { config as loadEnv } from "dotenv";
import Fastify from "fastify";
import { z } from "../../../scripts/local-zod.mjs";
import {
  AttachProjectInputSchema,
  AttachedProjectStackPackIdSchema,
  AttachedProjectTaskPresetIdSchema,
  CreateRunInputSchema,
  CreateGoalInputSchema,
  type AttachedProjectProfile,
  createBranch,
  createCurrentDecision,
  createEvent,
  createGoal,
  createRunAutomationControl,
  createRunPolicyRuntime,
  createRun,
  createRunJournalEntry,
  createRunSteer,
  createSteer,
  updateCurrentDecision,
  updateRunPolicyRuntime,
  updateBranch,
  updateGoal
} from "@autoresearch/domain";
import { ContextManager } from "@autoresearch/context-manager";
import { appendEvent, listEvents } from "@autoresearch/event-log";
import {
  assessRunHealth,
  buildRuntimeWorkspaceScopeRoots,
  buildPersistedRunWorkspaceScope,
  createRunScopedWorkspacePolicy,
  captureAttachedProjectCapabilitySnapshot,
  captureSelfBootstrapRuntimeHealthSnapshot,
  captureSelfBootstrapNextTaskArtifacts,
  createRunWorkspaceScopePolicy,
  deriveRunRecoveryGuidance,
  deriveRunSurfaceFailureSignal,
  lockRunWorkspaceRoot,
  loadSelfBootstrapNextTaskActiveEntry,
  Orchestrator,
  parseRunWorkspaceScopeRoots,
  appendResolvedRunMailboxEntry,
  assertRuntimeDataRootCompatible,
  buildAttachedProjectExecutionContractPreview,
  buildAttachedProjectExecutionDefaults,
  buildRunMailboxThreadId,
  readRunBriefView,
  listAttachedProjectTaskPresetRecommendations,
  readRunMaintenancePlaneView,
  recommendAttachedProjectStackPack,
  resolveRunMailboxThread,
  readRunWorkingContextView,
  repairRunManagedWorkspace,
  ensureRunManagedWorkspace,
  inspectAttachedProjectWorkspace,
  refreshRunOperatorSurface,
  resolveRuntimeLayout,
  syncRuntimeLayoutHint,
  ProjectAttachError,
  RunWorkspaceScopeError
} from "@autoresearch/orchestrator";
import { buildSelfBootstrapRunTemplate, generateInitialPlan } from "@autoresearch/planner";
import {
  appendRunJournal,
  buildProjectRef,
  buildRunRef,
  getAttachedProjectBaselineSnapshot,
  getAttachedProjectCapabilitySnapshot,
  getAttachedProjectProfile,
  getAttemptAdversarialVerification,
  getAttemptContract,
  getAttemptContext,
  ensureWorkspace,
  getAttemptEvaluation,
  getAttemptHandoffBundle,
  getAttemptHeartbeat,
  getAttemptReviewPacket,
  getAttemptLogExcerpt,
  getAttemptPreflightEvaluation,
  getAttemptResult,
  getAttemptRuntimeState,
  getAttemptRuntimeVerification,
  getCurrentDecision,
  getBranch,
  getContextBoard,
  getGoal,
  getPlanArtifacts,
  getReport,
  getRun,
  getRunGovernanceState,
  getRunAutomationControl,
  getRunMailbox,
  getRunPolicyRuntime,
  getRunReport,
  getWriteback,
  listAttemptRuntimeEvents,
  listAttachedProjectProfiles,
  listAttempts,
  listBranches,
  listGoals,
  listRunJournal,
  listRuns,
  listRunSteers,
  listSteers,
  listWorkerRuns,
  pickLatestAttempt,
  readLatestRunEvidenceSurface,
  resolveRunPaths,
  resolveWorkspacePaths,
  readRunPolicyRuntimeStrict,
  readRunMailboxStrict,
  saveCurrentDecision,
  saveAttachedProjectBaselineSnapshot,
  saveAttachedProjectCapabilitySnapshot,
  saveAttachedProjectProfile,
  saveBranch,
  saveGoal,
  savePlanArtifacts,
  saveRunPolicyRuntime,
  saveRun,
  saveRunAutomationControl,
  saveRunRuntimeHealthSnapshot,
  saveRunSteer,
  saveSteer
} from "@autoresearch/state-store";
import {
  loadAdversarialVerifierAdapter,
  loadExecutionWorkerAdapter
} from "@autoresearch/worker-adapters";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(currentDir, "..", "..", "..");
loadEnv({ path: join(repositoryRoot, ".env") });

function resolveAllowedProjectRoots(
  explicitRoots: string[] | undefined,
  env: NodeJS.ProcessEnv
): string[] {
  return [
    ...(explicitRoots ?? []),
    ...parseRunWorkspaceScopeRoots(env.AISA_ALLOWED_PROJECT_ROOTS),
    ...parseRunWorkspaceScopeRoots(env.AISA_ALLOWED_WORKSPACE_ROOTS)
  ];
}

function inferLaunchAttemptType(input: {
  current: Awaited<ReturnType<typeof getCurrentDecision>> | null;
  attempts: Awaited<ReturnType<typeof listAttempts>>;
}): "research" | "execution" {
  const latestAttempt = pickLatestAttempt(input.attempts, input.current);

  return (
    input.current?.recommended_attempt_type ??
    latestAttempt?.attempt_type ??
    "research"
  );
}

function inferLaunchNextAction(input: {
  current: Awaited<ReturnType<typeof getCurrentDecision>> | null;
  attempts: Awaited<ReturnType<typeof listAttempts>>;
}): string {
  const currentAction = input.current?.recommended_next_action;
  if (currentAction && currentAction !== "wait_for_human") {
    return currentAction;
  }

  const latestAttempt = pickLatestAttempt(input.attempts, input.current);

  if (!latestAttempt) {
    return "start_first_attempt";
  }

  if (latestAttempt.status === "failed" || latestAttempt.status === "stopped") {
    return "retry_attempt";
  }

  return inferLaunchAttemptType(input) === "execution"
    ? "continue_execution"
    : "continue_research";
}

function buildRecoveryResumeSummary(input: {
  path: "first_attempt" | "latest_decision" | "handoff_first" | "degraded_rebuild";
  handoffBundleRef: string | null;
}): string {
  switch (input.path) {
    case "handoff_first":
      return input.handoffBundleRef
        ? `Recovery remains handoff-first from ${input.handoffBundleRef}. Relaunch will follow that settled handoff.`
        : "Recovery remains handoff-first from the latest settled handoff bundle.";
    case "degraded_rebuild":
      return "Recovery is degraded because the latest settled attempt has no handoff bundle. Relaunch will rebuild from research first.";
    case "first_attempt":
      return "Relaunch will create the first research attempt.";
    case "latest_decision":
    default:
      return "Relaunch will continue from the latest decision.";
  }
}

type RecoveryEvidenceRefPayload = {
  kind: string;
  ref: string;
  label: string;
  summary: string | null;
};

type RunRecoveryProjectStatus = "not_applicable" | "ready" | "degraded" | "blocked";

type RunRecoveryGuidanceView = Awaited<ReturnType<typeof deriveRunRecoveryGuidance>> & {
  reasonCode: string;
  reasonSummary: string;
  projectStatus: RunRecoveryProjectStatus;
  projectProfileRef: string | null;
  baselineSnapshotRef: string | null;
  capabilitySnapshotRef: string | null;
  baselineRefs: RecoveryEvidenceRefPayload[];
  keyFileRefs: RecoveryEvidenceRefPayload[];
  latestSettledEvidenceRefs: RecoveryEvidenceRefPayload[];
};

function buildRecoveryReason(input: {
  path: "first_attempt" | "latest_decision" | "handoff_first" | "degraded_rebuild";
  handoffBundleRef: string | null;
}): {
  code: string;
  summary: string;
} {
  switch (input.path) {
    case "first_attempt":
      return {
        code: "first_attempt",
        summary: "No settled attempt exists yet, so recovery starts from the first research step."
      };
    case "handoff_first":
      return {
        code: "settled_handoff_available",
        summary: input.handoffBundleRef
          ? `Recovery can trust the settled handoff at ${input.handoffBundleRef}.`
          : "Recovery can trust the latest settled handoff bundle."
      };
    case "degraded_rebuild":
      return {
        code: "missing_settled_handoff",
        summary:
          "The latest settled attempt has no handoff bundle, so recovery must rebuild from primary evidence."
      };
    case "latest_decision":
    default:
      return {
        code: "latest_decision",
        summary: "Recovery follows the latest in-flight decision because the run has not settled yet."
      };
  }
}

function buildLatestSettledEvidenceRefs(input: {
  latestAttemptSurface: Awaited<ReturnType<typeof readLatestRunEvidenceSurface>>;
}): RecoveryEvidenceRefPayload[] {
  const refs: RecoveryEvidenceRefPayload[] = [];

  if (input.latestAttemptSurface.latestHandoffBundleRef) {
    refs.push({
      kind: "handoff_bundle",
      ref: input.latestAttemptSurface.latestHandoffBundleRef,
      label: "Settled handoff",
      summary:
        input.latestAttemptSurface.latestHandoffBundle?.summary ??
        input.latestAttemptSurface.latestHandoffBundle?.failure_context?.message ??
        null
    });
  }

  if (input.latestAttemptSurface.latestReviewPacketRef) {
    refs.push({
      kind: "review_packet",
      ref: input.latestAttemptSurface.latestReviewPacketRef,
      label: "Review packet",
      summary:
        input.latestAttemptSurface.latestReviewPacket?.failure_context?.message ??
        input.latestAttemptSurface.latestReviewPacket?.evaluation?.rationale ??
        null
    });
  }

  if (input.latestAttemptSurface.latestRuntimeVerificationRef) {
    refs.push({
      kind: "runtime_verification",
      ref: input.latestAttemptSurface.latestRuntimeVerificationRef,
      label: "Runtime verification",
      summary: input.latestAttemptSurface.latestRuntimeVerification?.failure_reason ??
        (input.latestAttemptSurface.latestRuntimeVerification
          ? `status=${input.latestAttemptSurface.latestRuntimeVerification.status}`
          : null)
    });
  }

  if (input.latestAttemptSurface.latestAdversarialVerificationRef) {
    refs.push({
      kind: "adversarial_verification",
      ref: input.latestAttemptSurface.latestAdversarialVerificationRef,
      label: "Adversarial verification",
      summary:
        input.latestAttemptSurface.latestAdversarialVerification?.failure_reason ??
        input.latestAttemptSurface.latestAdversarialVerification?.summary ??
        null
    });
  }

  if (input.latestAttemptSurface.latestPreflightEvaluationRef) {
    refs.push({
      kind: "preflight_evaluation",
      ref: input.latestAttemptSurface.latestPreflightEvaluationRef,
      label: "Preflight evaluation",
      summary: input.latestAttemptSurface.latestPreflightEvaluation?.failure_reason ??
        (input.latestAttemptSurface.latestPreflightEvaluation
          ? `status=${input.latestAttemptSurface.latestPreflightEvaluation.status}`
          : null)
    });
  }

  return refs;
}

function buildAttachedProjectKeyFileRefs(
  project: AttachedProjectProfile | null
): RecoveryEvidenceRefPayload[] {
  if (!project) {
    return [];
  }

  const manifestFiles = Array.from(
    new Set(
      project.manifest_files.filter(
        (file: unknown): file is string => typeof file === "string"
      )
    )
  ) as string[];

  return manifestFiles
    .slice(0, 5)
    .map((file) => ({
      kind: "project_manifest",
      ref: join(project.workspace_root, file),
      label: file,
      summary: project.detection_reasons[0] ?? null
    }));
}

function toRecoveryPayload(guidance: RunRecoveryGuidanceView) {
  return {
    path: guidance.path,
    recommended_next_action: guidance.nextAction,
    recommended_attempt_type: guidance.attemptType,
    summary: guidance.summary,
    blocking_reason: guidance.blockingReason,
    handoff_bundle_ref: guidance.handoffBundleRef,
    reason_code: guidance.reasonCode,
    reason: guidance.reasonSummary,
    project_status: guidance.projectStatus,
    project_profile_ref: guidance.projectProfileRef,
    baseline_snapshot_ref: guidance.baselineSnapshotRef,
    capability_snapshot_ref: guidance.capabilitySnapshotRef,
    baseline_refs: guidance.baselineRefs,
    key_file_refs: guidance.keyFileRefs,
    latest_settled_evidence_refs: guidance.latestSettledEvidenceRefs
  };
}

async function readRunRecoveryGuidance(input: {
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  runId: string;
  current: Awaited<ReturnType<typeof getCurrentDecision>> | null;
  attempts: Awaited<ReturnType<typeof listAttempts>>;
  run?: Awaited<ReturnType<typeof getRun>>;
}): Promise<RunRecoveryGuidanceView> {
  const [run, latestAttemptSurface] = await Promise.all([
    input.run ?? getRun(input.workspacePaths, input.runId),
    readLatestRunEvidenceSurface({
      paths: input.workspacePaths,
      runId: input.runId,
      current: input.current,
      attempts: input.attempts
    })
  ]);
  const guidance = deriveRunRecoveryGuidance({
    current: input.current,
    latestAttempt: pickLatestAttempt(input.attempts, input.current),
    latestHandoffBundle: latestAttemptSurface.latestHandoffBundle,
    latestHandoffBundleRef: latestAttemptSurface.latestHandoffBundleRef
  });
  const recoveryReason = buildRecoveryReason({
    path: guidance.path,
    handoffBundleRef: guidance.handoffBundleRef
  });
  const latestSettledEvidenceRefs = buildLatestSettledEvidenceRefs({
    latestAttemptSurface
  });

  if (!run.attached_project_id) {
    return {
      ...guidance,
      reasonCode: recoveryReason.code,
      reasonSummary: recoveryReason.summary,
      projectStatus: "not_applicable",
      projectProfileRef: null,
      baselineSnapshotRef: null,
      capabilitySnapshotRef: null,
      baselineRefs: [],
      keyFileRefs: [],
      latestSettledEvidenceRefs
    };
  }

  const projectId = run.attached_project_id;
  const [project, baselineSnapshot, capabilitySnapshot] = await Promise.all([
    getAttachedProjectProfile(input.workspacePaths, projectId).catch((error) => {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        return null;
      }
      throw error;
    }),
    getAttachedProjectBaselineSnapshot(input.workspacePaths, projectId),
    getAttachedProjectCapabilitySnapshot(input.workspacePaths, projectId)
  ]);
  const projectProfileRef = project
    ? buildProjectRef(input.workspacePaths, projectId, "profileFile")
    : null;
  const baselineSnapshotRef = baselineSnapshot
    ? buildProjectRef(input.workspacePaths, projectId, "baselineSnapshotFile")
    : null;
  const capabilitySnapshotRef = capabilitySnapshot
    ? buildProjectRef(input.workspacePaths, projectId, "capabilitySnapshotFile")
    : null;
  const baselineRefs: RecoveryEvidenceRefPayload[] = [];

  if (projectProfileRef && project) {
    baselineRefs.push({
      kind: "project_profile",
      ref: projectProfileRef,
      label: "Project profile",
      summary: `${project.project_type} / ${project.primary_language}`
    });
  }
  if (baselineSnapshotRef && baselineSnapshot) {
    baselineRefs.push({
      kind: "baseline_snapshot",
      ref: baselineSnapshotRef,
      label: "Baseline snapshot",
      summary:
        baselineSnapshot.git.head_sha
          ? `head=${baselineSnapshot.git.head_sha}`
          : "git baseline captured"
    });
  }
  if (capabilitySnapshotRef && capabilitySnapshot) {
    baselineRefs.push({
      kind: "capability_snapshot",
      ref: capabilitySnapshotRef,
      label: "Capability snapshot",
      summary: `status=${capabilitySnapshot.overall_status}`
    });
  }

  let projectStatus: RunRecoveryProjectStatus = "ready";
  let projectReasonCode: string | null = null;
  let projectReasonSummary: string | null = null;

  if (!project) {
    projectStatus = "blocked";
    projectReasonCode = "attached_project_missing";
    projectReasonSummary =
      "Attached project facts are missing, so recovery stays manual until the project is re-attached.";
  } else if (project.workspace_root !== run.workspace_root) {
    projectStatus = "blocked";
    projectReasonCode = "attached_project_workspace_mismatch";
    projectReasonSummary =
      "Attached project workspace no longer matches the run workspace, so recovery must stop for operator repair.";
  } else if (!baselineSnapshot) {
    projectStatus = "degraded";
    projectReasonCode = "attached_project_baseline_missing";
    projectReasonSummary =
      "Attached project baseline snapshot is missing, so recovery should rebuild project facts before resuming.";
  } else if (!capabilitySnapshot) {
    projectStatus = "degraded";
    projectReasonCode = "attached_project_capability_missing";
    projectReasonSummary =
      "Attached project capability snapshot is missing, so recovery should refresh project readiness before relaunch.";
  } else {
    const launchGate = capabilitySnapshot.launch_readiness[guidance.attemptType];
    if (launchGate.status === "blocked") {
      projectStatus = "blocked";
      projectReasonCode = "attached_project_capability_blocked";
      projectReasonSummary = launchGate.summary;
    } else if (capabilitySnapshot.overall_status === "degraded") {
      projectStatus = "degraded";
      projectReasonCode = "attached_project_capability_degraded";
      projectReasonSummary =
        capabilitySnapshot.blocking_reasons[0]?.message ??
        "Attached project capability is degraded and should be refreshed before execution."
    }
  }

  const forcesProjectDegradedRebuild =
    projectReasonCode === "attached_project_baseline_missing" ||
    projectReasonCode === "attached_project_capability_missing";

  return {
    ...guidance,
    path: forcesProjectDegradedRebuild ? "degraded_rebuild" : guidance.path,
    nextAction: projectStatus === "blocked"
      ? "wait_for_human"
      : forcesProjectDegradedRebuild
        ? "continue_research"
        : guidance.nextAction,
    attemptType: forcesProjectDegradedRebuild ? "research" : guidance.attemptType,
    summary: forcesProjectDegradedRebuild
      ? "Attached project recovery facts are incomplete, so recovery must rebuild from project and run evidence first."
      : guidance.summary,
    blockingReason:
      projectStatus === "blocked" || forcesProjectDegradedRebuild
        ? [projectReasonSummary, guidance.blockingReason].filter(Boolean).join(" ")
        : guidance.blockingReason,
    reasonCode: projectReasonCode ?? recoveryReason.code,
    reasonSummary:
      projectReasonSummary === null
        ? recoveryReason.summary
        : [projectReasonSummary, recoveryReason.summary].join(" "),
    projectStatus,
    projectProfileRef,
    baselineSnapshotRef,
    capabilitySnapshotRef,
    baselineRefs,
    keyFileRefs: buildAttachedProjectKeyFileRefs(project),
    latestSettledEvidenceRefs
  };
}

function isExecutionApprovalPending(
  policyRuntime: Awaited<ReturnType<typeof getRunPolicyRuntime>> | null
): boolean {
  return (
    policyRuntime?.approval_required === true &&
    policyRuntime.proposed_attempt_type === "execution" &&
    policyRuntime.approval_status === "pending"
  );
}

function hasApprovedExecutionPlan(
  policyRuntime: Awaited<ReturnType<typeof getRunPolicyRuntime>> | null
): boolean {
  return (
    policyRuntime?.approval_required === true &&
    policyRuntime.approval_status === "approved" &&
    policyRuntime.proposed_attempt_type === "execution"
  );
}

function buildInitialRunPolicyRuntime(input: {
  runId: string;
  runtimeUpgradeIntent: boolean;
}) {
  return createRunPolicyRuntime({
    run_id: input.runId,
    stage: "planning",
    last_decision: "planning",
    runtime_upgrade_approval_status: input.runtimeUpgradeIntent
      ? "pending"
      : "not_required",
    runtime_upgrade_requested_at: input.runtimeUpgradeIntent
      ? new Date().toISOString()
      : null
  });
}

const CreateAttachedProjectRunRequestSchema = z.object({
  owner_id: z.string().min(1).optional(),
  stack_pack_id: AttachedProjectStackPackIdSchema.optional(),
  task_preset_id: AttachedProjectTaskPresetIdSchema.optional(),
  runtime_upgrade_intent: z.boolean().optional()
});

type AttachedProjectRunTemplate = {
  title: string;
  description: string;
  success_criteria: string[];
  constraints: string[];
  owner_id: string;
  workspace_root: string;
};

function buildAttachedProjectRunTemplate(input: {
  project: AttachedProjectProfile;
  ownerId?: string | null;
  taskPresetTitle?: string | null;
}): AttachedProjectRunTemplate {
  const taskPresetLabel = input.taskPresetTitle?.trim().toLowerCase();
  const stepLabel = taskPresetLabel ? `${taskPresetLabel} step` : "safe development step";
  const changeLabel = taskPresetLabel ? `${taskPresetLabel} change` : "safe change";

  return {
    title: `Attach ${input.project.repo_name}`,
    description:
      `Use the attached project profile for ${input.project.repo_name} to plan the first ${stepLabel}.`,
    success_criteria: [
      "Confirm the attached project profile and baseline snapshot are accurate.",
      `Produce a first research attempt that identifies the next ${changeLabel}.`,
      "Keep the work inside the attached workspace scope."
    ],
    constraints: [
      `Stay inside ${input.project.workspace_root}.`,
      "Treat the attached baseline snapshot as the starting evidence surface."
    ],
    owner_id: input.ownerId?.trim() || "operator",
    workspace_root: input.project.workspace_root
  };
}

type RunPolicyRuntimeSurface = {
  policyRuntime: Awaited<ReturnType<typeof getRunPolicyRuntime>> | null;
  policyRuntimeRef: string | null;
  policyRuntimeInvalidReason: string | null;
};

type RunMailboxSurface = {
  runMailbox: Awaited<ReturnType<typeof getRunMailbox>> | null;
  runMailboxRef: string | null;
  runMailboxInvalidReason: string | null;
};

type RunPreflightEvaluationSummary = {
  status: string;
  summary: string;
  failure_class: string | null;
  failure_policy_mode: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  requires_adversarial_verification: boolean;
  verifier_kit: string | null;
  verification_command_count: number;
  source_ref: string | null;
} | null;

type RunHandoffSummary = {
  summary: string | null;
  recommended_next_action: string | null;
  recommended_attempt_type: string | null;
  failure_class: string | null;
  failure_policy_mode: string | null;
  failure_code: string | null;
  adversarial_failure_code: string | null;
  source_ref: string | null;
} | null;

type RunPolicyActivityItem = {
  id: string;
  ts: string;
  kind: "decision" | "hook";
  status:
    | "pending"
    | "approved"
    | "rejected"
    | "blocked"
    | "active"
    | "cleared"
    | "passed"
    | "failed";
  headline: string;
  summary: string | null;
  actor: string | null;
  note: string | null;
  proposed_signature: string | null;
  attempt_type: string | null;
  objective: string | null;
  permission_profile: string | null;
  hook_policy: string | null;
  danger_mode: string | null;
  verifier_kit: string | null;
  verification_commands: string[];
  source_attempt_id: string | null;
  source_ref: string | null;
  evidence_ref: string | null;
  hook_key: string | null;
};

async function readRunPolicyRuntimeSurface(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string
): Promise<RunPolicyRuntimeSurface> {
  const policyRuntimeRef = buildRunRef(workspacePaths, runId, "policyFile");

  try {
    return {
      policyRuntime: await readRunPolicyRuntimeStrict(workspacePaths, runId),
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

function buildPreflightEvaluationSummary(input: {
  evaluation: Awaited<ReturnType<typeof getAttemptPreflightEvaluation>> | null;
  ref: string | null;
  fallbackContract?: Awaited<ReturnType<typeof getAttemptContract>> | null;
  fallbackVerifierKit?: string | null;
}): RunPreflightEvaluationSummary {
  if (!input.evaluation) {
    return null;
  }

  const evaluation = input.evaluation;
  const contract = evaluation.contract ?? (input.fallbackContract
    ? {
        requires_adversarial_verification:
          input.fallbackContract.adversarial_verification_required === true,
        verifier_kit: input.fallbackContract.verifier_kit,
        verification_commands:
          input.fallbackContract.verification_plan?.commands.map(
            (command: { command: string }) => command.command
          ) ??
          []
      }
    : null);
  const verificationCommandCount =
    contract?.verification_commands.length ?? 0;
  const summary =
    evaluation.failure_reason ??
    (evaluation.status === "passed"
      ? "Preflight evaluation passed."
      : evaluation.status === "failed"
        ? "Preflight evaluation failed."
        : "Preflight evaluation was not applicable.");

  return {
    status: evaluation.status,
    summary,
    failure_class: evaluation.failure_class,
    failure_policy_mode: evaluation.failure_policy_mode,
    failure_code: evaluation.failure_code,
    failure_reason: evaluation.failure_reason,
    requires_adversarial_verification:
      contract?.requires_adversarial_verification ?? false,
    verifier_kit:
      contract?.verifier_kit ??
      evaluation.toolchain_assessment?.verifier_kit ??
      input.fallbackVerifierKit ??
      null,
    verification_command_count: verificationCommandCount,
    source_ref: input.ref
  };
}

function buildHandoffSummary(input: {
  handoff: Awaited<ReturnType<typeof getAttemptHandoffBundle>> | null;
  ref: string | null;
}): RunHandoffSummary {
  if (!input.handoff) {
    return null;
  }

  const handoff = input.handoff;

  return {
    summary: handoff.summary,
    recommended_next_action: handoff.recommended_next_action,
    recommended_attempt_type: handoff.recommended_attempt_type,
    failure_class: handoff.failure_class,
    failure_policy_mode: handoff.failure_policy_mode,
    failure_code: handoff.failure_code,
    adversarial_failure_code: handoff.adversarial_failure_code,
    source_ref: input.ref
  };
}

async function readRunMailboxSurface(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string
): Promise<RunMailboxSurface> {
  const runMailboxRef = buildRunRef(workspacePaths, runId, "mailboxFile");

  try {
    return {
      runMailbox: await readRunMailboxStrict(workspacePaths, runId),
      runMailboxRef,
      runMailboxInvalidReason: null
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
      return {
        runMailbox: null,
        runMailboxRef: null,
        runMailboxInvalidReason: null
      };
    }

    return {
      runMailbox: null,
      runMailboxRef,
      runMailboxInvalidReason:
        error instanceof Error ? error.message : "Run mailbox is unreadable."
    };
  }
}

function buildRunPolicyActivity(input: {
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  runId: string;
  journal: Awaited<ReturnType<typeof listRunJournal>>;
}): {
  policyActivity: RunPolicyActivityItem[];
  policyActivityRef: string | null;
} {
  const coerceStringArray = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item: unknown): item is string => typeof item === "string")
      : [];
  const policyActivityRef = buildRunRef(input.workspacePaths, input.runId, "journalFile");
  const policyEntries: RunPolicyActivityItem[] = input.journal
    .filter((entry) =>
      [
        "run.policy.approval_requested",
        "run.policy.approved",
        "run.policy.rejected",
        "run.policy.dispatch_blocked",
        "run.policy.killswitch_enabled",
        "run.policy.killswitch_cleared",
        "run.policy.hook_evaluated"
      ].includes(entry.type)
    )
    .slice(-8)
    .reverse()
    .map((entry) => {
      const payload = entry.payload;
      if (entry.type === "run.policy.hook_evaluated") {
        const hookStatus =
          payload.hook_status === "failed" ? "failed" : "passed";
        return {
          id: entry.id,
          ts: entry.ts,
          kind: "hook" as const,
          status: hookStatus,
          headline:
            hookStatus === "failed"
              ? "Policy hook blocked the proposal."
              : "Policy hook accepted the proposal.",
          summary:
            typeof payload.message === "string" ? payload.message : null,
          actor: null,
          note: null,
          proposed_signature:
            typeof payload.proposed_signature === "string"
              ? payload.proposed_signature
              : null,
          attempt_type:
            typeof payload.attempt_type === "string" ? payload.attempt_type : null,
          objective:
            typeof payload.objective === "string" ? payload.objective : null,
          permission_profile:
            typeof payload.permission_profile === "string"
              ? payload.permission_profile
              : null,
          hook_policy:
            typeof payload.hook_policy === "string" ? payload.hook_policy : null,
          danger_mode:
            typeof payload.danger_mode === "string" ? payload.danger_mode : null,
          verifier_kit:
            typeof payload.verifier_kit === "string" ? payload.verifier_kit : null,
          verification_commands: coerceStringArray(payload.verification_commands),
          source_attempt_id: entry.attempt_id,
          source_ref:
            typeof payload.source_ref === "string" ? payload.source_ref : null,
          evidence_ref:
            typeof payload.evidence_ref === "string" ? payload.evidence_ref : null,
          hook_key:
            typeof payload.hook_key === "string" ? payload.hook_key : null
        };
      }

      const status: RunPolicyActivityItem["status"] =
        entry.type === "run.policy.approval_requested"
          ? "pending"
          : entry.type === "run.policy.approved"
            ? "approved"
            : entry.type === "run.policy.rejected"
              ? "rejected"
              : entry.type === "run.policy.killswitch_enabled"
                ? "active"
                : entry.type === "run.policy.killswitch_cleared"
                  ? "cleared"
                  : "blocked";

      const headline =
        entry.type === "run.policy.approval_requested"
          ? "Execution plan is waiting for leader approval."
          : entry.type === "run.policy.approved"
            ? "Execution plan was approved."
            : entry.type === "run.policy.rejected"
              ? "Execution plan was rejected."
              : entry.type === "run.policy.killswitch_enabled"
                ? "Policy killswitch is active."
                : entry.type === "run.policy.killswitch_cleared"
                  ? "Policy killswitch was cleared."
                  : "Policy runtime blocked dispatch.";

      return {
        id: entry.id,
        ts: entry.ts,
        kind: "decision" as const,
        status,
        headline,
        summary:
          typeof payload.message === "string"
            ? payload.message
            : typeof payload.note === "string"
              ? payload.note
              : null,
        actor: typeof payload.actor === "string" ? payload.actor : null,
        note: typeof payload.note === "string" ? payload.note : null,
        proposed_signature:
          typeof payload.proposed_signature === "string"
            ? payload.proposed_signature
            : null,
        attempt_type:
          typeof payload.attempt_type === "string" ? payload.attempt_type : null,
        objective:
          typeof payload.objective === "string" ? payload.objective : null,
        permission_profile:
          typeof payload.permission_profile === "string"
            ? payload.permission_profile
            : null,
        hook_policy:
          typeof payload.hook_policy === "string" ? payload.hook_policy : null,
        danger_mode:
          typeof payload.danger_mode === "string" ? payload.danger_mode : null,
        verifier_kit:
          typeof payload.verifier_kit === "string" ? payload.verifier_kit : null,
        verification_commands: coerceStringArray(payload.verification_commands),
        source_attempt_id: entry.attempt_id,
        source_ref:
          typeof payload.source_ref === "string" ? payload.source_ref : null,
        evidence_ref: null,
        hook_key: null
      };
    });

  return {
    policyActivity: policyEntries,
    policyActivityRef: policyEntries.length > 0 ? policyActivityRef : null
  };
}

export async function buildServer(
  options: {
    workspaceRoot?: string;
    runtimeRepoRoot?: string;
    devRepoRoot?: string;
    runtimeDataRoot?: string;
    managedWorkspaceRoot?: string;
    startOrchestrator?: boolean;
    allowedRunWorkspaceRoots?: string[];
    allowedProjectRoots?: string[];
    enableSelfRestart?: boolean;
  } = {}
) {
  const runtimeLayout = resolveRuntimeLayout({
    repositoryRoot,
    workspaceRoot: options.workspaceRoot,
    runtimeRepoRoot: options.runtimeRepoRoot,
    devRepoRoot: options.devRepoRoot,
    runtimeDataRoot: options.runtimeDataRoot,
    managedWorkspaceRoot: options.managedWorkspaceRoot,
    env: process.env
  });
  syncRuntimeLayoutHint(runtimeLayout);
  const workspacePaths = resolveWorkspacePaths(runtimeLayout.runtimeDataRoot);
  const defaultRunWorkspaceRoot = runtimeLayout.devRepoRoot;
  const contextManager = new ContextManager();
  const { adapter, config: adapterConfig } = loadExecutionWorkerAdapter(process.env);
  const {
    adapter: adversarialVerifier,
    config: adversarialVerifierConfig
  } = loadAdversarialVerifierAdapter(process.env);
  const app = Fastify({
    logger: true
  });
  const runHealthStaleMs = readPositiveIntegerEnv("AISA_RUN_HEALTH_STALE_MS", 180_000);
  const allowedProjectRoots = resolveAllowedProjectRoots(
    options.allowedProjectRoots,
    process.env
  );
  const runWorkspaceScopePolicy = await createRunWorkspaceScopePolicy({
    runtimeRoot: runtimeLayout.runtimeRepoRoot,
    allowedRoots: buildRuntimeWorkspaceScopeRoots(
      runtimeLayout,
      [...(options.allowedRunWorkspaceRoots ?? []), ...allowedProjectRoots]
    ),
    managedWorkspaceRoot: runtimeLayout.managedWorkspaceRoot
  });
  await assertRuntimeDataRootCompatible({
    layout: runtimeLayout,
    runWorkspaceScopePolicy
  });
  let orchestratorStarted = false;
  let restartPending = false;
  let orchestrator: Orchestrator;
  const requestRuntimeRestart = (request: {
    runId: string;
    attemptId: string;
    reason: "runtime_source_drift" | "runtime_promotion";
    affectedFiles: string[];
    message: string;
    promotedSha?: string | null;
  }): void => {
    if (!options.enableSelfRestart || restartPending) {
      return;
    }

    restartPending = true;
    app.log.warn(
      {
        run_id: request.runId,
        attempt_id: request.attemptId,
        reason: request.reason,
        affected_files: request.affectedFiles,
        promoted_sha: request.promotedSha ?? null
      },
      "Runtime restart requested. Scheduling control-api restart."
    );

    if (orchestratorStarted) {
      orchestrator.stop();
      orchestratorStarted = false;
    }

    setTimeout(() => {
      void app.close().finally(() => {
        process.exit(readRestartExitCode());
      });
    }, 0);
  };
  orchestrator = new Orchestrator(workspacePaths, adapter, undefined, undefined, {
    runWorkspaceScopePolicy,
    adversarialVerifier,
    requestRuntimeRestart,
    runtimeLayout,
    maxConcurrentAttempts: readPositiveIntegerEnv("AISA_MAX_CONCURRENT_ATTEMPTS", 3)
  });

  const activateRunAutomation = async (runId: string, imposedBy: string) => {
    await saveRunAutomationControl(
      workspacePaths,
      createRunAutomationControl({
        run_id: runId,
        mode: "active",
        imposed_by: imposedBy
      })
    );
  };

  const setManualOnlyRunAutomation = async (input: {
    runId: string;
    reason: string;
    imposedBy: string;
  }) => {
    await saveRunAutomationControl(
      workspacePaths,
      createRunAutomationControl({
        run_id: input.runId,
        mode: "manual_only",
        reason_code: "manual_recovery",
        reason: input.reason,
        imposed_by: input.imposedBy
      })
    );
  };

  await ensureWorkspace(workspacePaths);
  await app.register(cors, {
    origin: true
  });

  if (options.startOrchestrator !== false) {
    app.addHook("onListen", async () => {
      if (orchestratorStarted) {
        return;
      }
      orchestrator.start();
      orchestratorStarted = true;
    });
  }

  app.addHook("onClose", async () => {
    if (orchestratorStarted) {
      orchestrator.stop();
      orchestratorStarted = false;
    }
  });

  const buildAttemptDetail = async (input: {
    run: Awaited<ReturnType<typeof getRun>>;
    runId: string;
    attempt: Awaited<ReturnType<typeof listAttempts>>[number];
    journal: Awaited<ReturnType<typeof listRunJournal>>;
  }) => {
    const { run, runId, attempt, journal } = input;
    const [
      contract,
      context,
      reviewPacket,
      result,
      evaluation,
      runtimeVerification,
      adversarialVerification,
      runtimeState,
      runtimeEvents,
      heartbeat,
      stdoutExcerpt,
      stderrExcerpt
    ] = await Promise.all([
      getAttemptContract(workspacePaths, runId, attempt.id),
      getAttemptContext(workspacePaths, runId, attempt.id),
      getAttemptReviewPacket(workspacePaths, runId, attempt.id),
      getAttemptResult(workspacePaths, runId, attempt.id),
      getAttemptEvaluation(workspacePaths, runId, attempt.id),
      getAttemptRuntimeVerification(workspacePaths, runId, attempt.id),
      getAttemptAdversarialVerification(workspacePaths, runId, attempt.id),
      getAttemptRuntimeState(workspacePaths, runId, attempt.id),
      listAttemptRuntimeEvents(workspacePaths, runId, attempt.id, 80),
      getAttemptHeartbeat(workspacePaths, runId, attempt.id),
      getAttemptLogExcerpt(workspacePaths, runId, attempt.id, "stdout"),
      getAttemptLogExcerpt(workspacePaths, runId, attempt.id, "stderr")
    ]);

    return {
      attempt,
      contract,
      effective_verifier_kit_profile: orchestrator.describeAttemptEffectiveVerifierKit({
        run,
        attemptType: attempt.attempt_type,
        attemptContract: contract,
        runtimeVerification,
        adversarialVerification
      }),
      context,
      failure_context: reviewPacket?.failure_context ?? null,
      result,
      evaluation,
      runtime_verification: runtimeVerification,
      adversarial_verification: adversarialVerification,
      runtime_state: runtimeState,
      runtime_events: runtimeEvents,
      heartbeat,
      stdout_excerpt: stdoutExcerpt,
      stderr_excerpt: stderrExcerpt,
      journal: journal.filter((entry) => entry.attempt_id === attempt.id)
    };
  };

  const buildLatestAttemptSurface = async (input: {
    runId: string;
    current: Awaited<ReturnType<typeof getCurrentDecision>> | null;
    attempts: Awaited<ReturnType<typeof listAttempts>>;
  }) => {
    const latestAttemptSurface = await readLatestRunEvidenceSurface({
      paths: workspacePaths,
      runId: input.runId,
      current: input.current,
      attempts: input.attempts
    });
    if (!latestAttemptSurface.latestAttempt) {
      return {
        latestAttempt: null,
        latest_preflight_evaluation: null,
        latest_preflight_evaluation_ref: null,
        latest_runtime_verification: null,
        latest_runtime_verification_ref: null,
        latest_adversarial_verification: null,
        latest_adversarial_verification_ref: null,
        latest_handoff_bundle: null,
        latest_handoff_bundle_ref: null
      };
    }

    return {
      latestAttempt: latestAttemptSurface.latestAttempt,
      latest_preflight_evaluation: latestAttemptSurface.latestPreflightEvaluation,
      latest_preflight_evaluation_ref: latestAttemptSurface.latestPreflightEvaluationRef,
      latest_runtime_verification: latestAttemptSurface.latestRuntimeVerification,
      latest_runtime_verification_ref: latestAttemptSurface.latestRuntimeVerificationRef,
      latest_adversarial_verification: latestAttemptSurface.latestAdversarialVerification,
      latest_adversarial_verification_ref:
        latestAttemptSurface.latestAdversarialVerificationRef,
      latest_handoff_bundle: latestAttemptSurface.latestHandoffBundle,
      latest_handoff_bundle_ref: latestAttemptSurface.latestHandoffBundleRef
    };
  };

  const buildRunDetailPayload = async (runId: string) => {
    const [run, current, automation, governance, policyRuntimeSurface, runMailboxSurface, attempts, steers, journal, report, workingContextView, runBriefView, maintenancePlaneView] = await Promise.all([
      getRun(workspacePaths, runId),
      getCurrentDecision(workspacePaths, runId),
      getRunAutomationControl(workspacePaths, runId),
      getRunGovernanceState(workspacePaths, runId),
      readRunPolicyRuntimeSurface(workspacePaths, runId),
      readRunMailboxSurface(workspacePaths, runId),
      listAttempts(workspacePaths, runId),
      listRunSteers(workspacePaths, runId),
      listRunJournal(workspacePaths, runId),
      getRunReport(workspacePaths, runId),
      readRunWorkingContextView(workspacePaths, runId),
      readRunBriefView(workspacePaths, runId),
      readRunMaintenancePlaneView(workspacePaths, runId, {
        staleAfterMs: runHealthStaleMs
      })
    ]);
    const latestAttemptSurface = await buildLatestAttemptSurface({
      runId,
      current,
      attempts
    });
    const { policyActivity, policyActivityRef } = buildRunPolicyActivity({
      workspacePaths,
      runId,
      journal
    });
    const automationView =
      automation ??
      createRunAutomationControl({
        run_id: runId
      });
    const attemptDetails = await Promise.all(
      attempts.map((attempt) =>
        buildAttemptDetail({
          run,
          runId,
          attempt,
          journal
        })
      )
    );
    const latestAttempt = latestAttemptSurface.latestAttempt;
    const latestAttemptDetail =
      attemptDetails.find((detail) => detail.attempt.id === latestAttempt?.id) ?? null;
    const preflightEvaluationSummary = buildPreflightEvaluationSummary({
      evaluation: latestAttemptSurface.latest_preflight_evaluation,
      ref: latestAttemptSurface.latest_preflight_evaluation_ref,
      fallbackContract: latestAttemptDetail?.contract ?? null,
      fallbackVerifierKit:
        latestAttemptDetail?.effective_verifier_kit_profile?.kit ??
        run.harness_profile.execution.default_verifier_kit
    });
    const handoffSummary = buildHandoffSummary({
      handoff: latestAttemptSurface.latest_handoff_bundle,
      ref: latestAttemptSurface.latest_handoff_bundle_ref
    });
    const recoveryGuidance = await readRunRecoveryGuidance({
      workspacePaths,
      runId,
      run,
      current,
      attempts
    });
    const runHealth =
      maintenancePlaneView.maintenance_plane?.run_health ??
      assessRunHealth({
        current,
        latestAttempt,
        latestRuntimeState: latestAttemptDetail?.runtime_state ?? null,
        latestHeartbeat: latestAttemptDetail?.heartbeat ?? null,
        staleAfterMs: runHealthStaleMs
      });
    const workerEffort = orchestrator.describeRunWorkerEffort(run);
    const harnessGates = orchestrator.describeRunHarnessGates(run);
    const harnessSlots = orchestrator.describeRunHarnessSlots(run);
    const defaultVerifierKitProfile = orchestrator.describeRunDefaultVerifierKit(run);
    const effectivePolicyBundle = orchestrator.describeRunEffectivePolicyBundle(run);
    const failureSignal = deriveRunSurfaceFailureSignal({
      latestAttempt,
      current,
      runBrief: runBriefView.run_brief,
      runBriefRef: runBriefView.run_brief_ref,
      runBriefDegraded: runBriefView.run_brief_degraded,
      preflight: latestAttemptSurface.latest_preflight_evaluation,
      preflightRef: latestAttemptSurface.latest_preflight_evaluation_ref,
      runtimeVerification: latestAttemptSurface.latest_runtime_verification,
      runtimeVerificationRef: latestAttemptSurface.latest_runtime_verification_ref,
      adversarialVerification: latestAttemptSurface.latest_adversarial_verification,
      adversarialVerificationRef:
        latestAttemptSurface.latest_adversarial_verification_ref,
      handoff: latestAttemptSurface.latest_handoff_bundle,
      handoffRef: latestAttemptSurface.latest_handoff_bundle_ref,
      workingContextDegraded: workingContextView.working_context_degraded,
      workingContextRef: workingContextView.working_context_ref
    });
    const attachedProjectPayload =
      run.attached_project_id === null
        ? null
        : await buildAttachedProjectPayload(run.attached_project_id, run.owner_id, {
            stack_pack_id: run.attached_project_stack_pack_id,
            task_preset_id: run.attached_project_task_preset_id
          }).catch((error) => {
            const err = error as NodeJS.ErrnoException;
            if (err?.code === "ENOENT") {
              return null;
            }
            throw error;
          });

    return {
      run,
      attached_project: attachedProjectPayload,
      current,
      automation: automationView,
      governance,
      policy_runtime: policyRuntimeSurface.policyRuntime,
      policy_runtime_ref: policyRuntimeSurface.policyRuntimeRef,
      policy_runtime_invalid_reason: policyRuntimeSurface.policyRuntimeInvalidReason,
      run_mailbox: runMailboxSurface.runMailbox,
      run_mailbox_ref: runMailboxSurface.runMailboxRef,
      run_mailbox_invalid_reason: runMailboxSurface.runMailboxInvalidReason,
      policy_activity: policyActivity,
      policy_activity_ref: policyActivityRef,
      failure_signal: failureSignal,
      latest_preflight_evaluation: latestAttemptSurface.latest_preflight_evaluation,
      latest_preflight_evaluation_ref: latestAttemptSurface.latest_preflight_evaluation_ref,
      preflight_evaluation_summary: preflightEvaluationSummary,
      latest_runtime_verification: latestAttemptSurface.latest_runtime_verification,
      latest_runtime_verification_ref: latestAttemptSurface.latest_runtime_verification_ref,
      latest_adversarial_verification: latestAttemptSurface.latest_adversarial_verification,
      latest_adversarial_verification_ref:
        latestAttemptSurface.latest_adversarial_verification_ref,
      latest_handoff_bundle: latestAttemptSurface.latest_handoff_bundle,
      latest_handoff_bundle_ref: latestAttemptSurface.latest_handoff_bundle_ref,
      handoff_summary: handoffSummary,
      run_brief: runBriefView.run_brief,
      run_brief_ref: runBriefView.run_brief_ref,
      run_brief_invalid_reason: runBriefView.run_brief_invalid_reason,
      run_brief_degraded: runBriefView.run_brief_degraded,
      maintenance_plane: maintenancePlaneView.maintenance_plane,
      maintenance_plane_ref: maintenancePlaneView.maintenance_plane_ref,
      working_context: workingContextView.working_context,
      working_context_ref: workingContextView.working_context_ref,
      working_context_degraded: workingContextView.working_context_degraded,
      run_health: runHealth,
      harness_gates: harnessGates,
      harness_slots: harnessSlots,
      default_verifier_kit_profile: defaultVerifierKitProfile,
      effective_policy_bundle: effectivePolicyBundle,
      worker_effort: workerEffort,
      recovery_guidance: toRecoveryPayload(recoveryGuidance),
      attempts,
      attempt_details: attemptDetails,
      steers,
      journal,
      report
    };
  };

  const buildRunSummaryItem = async (run: Awaited<ReturnType<typeof listRuns>>[number]) => {
    const [current, automation, governance, policyRuntimeSurface, runMailboxSurface, attempts, workingContextView, runBriefView, maintenancePlaneView] = await Promise.all([
      getCurrentDecision(workspacePaths, run.id),
      getRunAutomationControl(workspacePaths, run.id),
      getRunGovernanceState(workspacePaths, run.id),
      readRunPolicyRuntimeSurface(workspacePaths, run.id),
      readRunMailboxSurface(workspacePaths, run.id),
      listAttempts(workspacePaths, run.id),
      readRunWorkingContextView(workspacePaths, run.id),
      readRunBriefView(workspacePaths, run.id),
      readRunMaintenancePlaneView(workspacePaths, run.id, {
        staleAfterMs: runHealthStaleMs
      })
    ]);
    const latestAttemptSurface = await buildLatestAttemptSurface({
      runId: run.id,
      current,
      attempts
    });
    const automationView =
      automation ??
      createRunAutomationControl({
        run_id: run.id
      });
    const latestAttempt = latestAttemptSurface.latestAttempt;
    const [latestContract, latestRuntimeState, latestHeartbeat] = await Promise.all([
      latestAttempt
        ? getAttemptContract(workspacePaths, run.id, latestAttempt.id)
        : Promise.resolve(null),
      latestAttempt
        ? getAttemptRuntimeState(workspacePaths, run.id, latestAttempt.id)
        : Promise.resolve(null),
      latestAttempt
        ? getAttemptHeartbeat(workspacePaths, run.id, latestAttempt.id)
        : Promise.resolve(null)
    ]);
    const preflightEvaluationSummary = buildPreflightEvaluationSummary({
      evaluation: latestAttemptSurface.latest_preflight_evaluation,
      ref: latestAttemptSurface.latest_preflight_evaluation_ref,
      fallbackContract: latestContract,
      fallbackVerifierKit: run.harness_profile.execution.default_verifier_kit
    });
    const handoffSummary = buildHandoffSummary({
      handoff: latestAttemptSurface.latest_handoff_bundle,
      ref: latestAttemptSurface.latest_handoff_bundle_ref
    });

    const runHealth =
      maintenancePlaneView.maintenance_plane?.run_health ??
      assessRunHealth({
        current,
        latestAttempt,
        latestRuntimeState,
        latestHeartbeat,
        staleAfterMs: runHealthStaleMs
      });
    const harnessGates = orchestrator.describeRunHarnessGates(run);
    const harnessSlots = orchestrator.describeRunHarnessSlots(run);
    const defaultVerifierKitProfile = orchestrator.describeRunDefaultVerifierKit(run);
    const effectivePolicyBundle = orchestrator.describeRunEffectivePolicyBundle(run);
    const failureSignal = deriveRunSurfaceFailureSignal({
      latestAttempt,
      current,
      runBrief: runBriefView.run_brief,
      runBriefRef: runBriefView.run_brief_ref,
      runBriefDegraded: runBriefView.run_brief_degraded,
      preflight: latestAttemptSurface.latest_preflight_evaluation,
      preflightRef: latestAttemptSurface.latest_preflight_evaluation_ref,
      runtimeVerification: latestAttemptSurface.latest_runtime_verification,
      runtimeVerificationRef: latestAttemptSurface.latest_runtime_verification_ref,
      adversarialVerification: latestAttemptSurface.latest_adversarial_verification,
      adversarialVerificationRef:
        latestAttemptSurface.latest_adversarial_verification_ref,
      handoff: latestAttemptSurface.latest_handoff_bundle,
      handoffRef: latestAttemptSurface.latest_handoff_bundle_ref,
      workingContextDegraded: workingContextView.working_context_degraded,
      workingContextRef: workingContextView.working_context_ref
    });

    return {
      run,
      current,
      automation: automationView,
      governance,
      policy_runtime: policyRuntimeSurface.policyRuntime,
      policy_runtime_ref: policyRuntimeSurface.policyRuntimeRef,
      policy_runtime_invalid_reason: policyRuntimeSurface.policyRuntimeInvalidReason,
      run_mailbox: runMailboxSurface.runMailbox,
      run_mailbox_ref: runMailboxSurface.runMailboxRef,
      run_mailbox_invalid_reason: runMailboxSurface.runMailboxInvalidReason,
      failure_signal: failureSignal,
      latest_preflight_evaluation: latestAttemptSurface.latest_preflight_evaluation,
      latest_preflight_evaluation_ref: latestAttemptSurface.latest_preflight_evaluation_ref,
      preflight_evaluation_summary: preflightEvaluationSummary,
      latest_runtime_verification: latestAttemptSurface.latest_runtime_verification,
      latest_runtime_verification_ref: latestAttemptSurface.latest_runtime_verification_ref,
      latest_adversarial_verification: latestAttemptSurface.latest_adversarial_verification,
      latest_adversarial_verification_ref:
        latestAttemptSurface.latest_adversarial_verification_ref,
      latest_handoff_bundle: latestAttemptSurface.latest_handoff_bundle,
      latest_handoff_bundle_ref: latestAttemptSurface.latest_handoff_bundle_ref,
      handoff_summary: handoffSummary,
      run_brief: runBriefView.run_brief,
      run_brief_ref: runBriefView.run_brief_ref,
      run_brief_invalid_reason: runBriefView.run_brief_invalid_reason,
      run_brief_degraded: runBriefView.run_brief_degraded,
      maintenance_plane: maintenancePlaneView.maintenance_plane,
      maintenance_plane_ref: maintenancePlaneView.maintenance_plane_ref,
      working_context: workingContextView.working_context,
      working_context_ref: workingContextView.working_context_ref,
      working_context_degraded: workingContextView.working_context_degraded,
      harness_gates: harnessGates,
      harness_slots: harnessSlots,
      default_verifier_kit_profile: defaultVerifierKitProfile,
      effective_policy_bundle: effectivePolicyBundle,
      worker_effort: orchestrator.describeRunWorkerEffort(run),
      run_health: runHealth,
      attempt_count: attempts.length,
      latest_attempt: latestAttempt
        ? {
            id: latestAttempt.id,
            attempt_type: latestAttempt.attempt_type,
            status: latestAttempt.status,
            worker: latestAttempt.worker,
            objective: latestAttempt.objective,
            created_at: latestAttempt.created_at,
            started_at: latestAttempt.started_at,
            ended_at: latestAttempt.ended_at
          }
        : null,
      latest_attempt_runtime_state: latestRuntimeState,
      latest_attempt_heartbeat: latestHeartbeat,
      task_focus:
        runBriefView.run_brief?.primary_focus ??
        workingContextView.working_context?.current_focus ??
        latestContract?.objective ??
        latestAttempt?.objective ??
        run.description,
      verification_command_count:
        latestContract?.verification_plan?.commands.length ?? 0
    };
  };

  const captureAndPersistAttachedProjectCapability = async (
    project: AttachedProjectProfile
  ) => {
    const capabilitySnapshot = await captureAttachedProjectCapabilitySnapshot({
      project,
      policy: runWorkspaceScopePolicy,
      executionAdapter: {
        type: adapter.type,
        command: adapterConfig.command,
        model: adapterConfig.model ?? null
      }
    });
    await saveAttachedProjectCapabilitySnapshot(workspacePaths, capabilitySnapshot);
    return capabilitySnapshot;
  };

  const buildAttachedProjectPayload = async (
    projectId: string,
    ownerId?: string | null,
    selection?: {
      stack_pack_id?: z.infer<typeof AttachedProjectStackPackIdSchema> | null;
      task_preset_id?: z.infer<typeof AttachedProjectTaskPresetIdSchema> | null;
    }
  ) => {
    const [project, baselineSnapshot, capabilitySnapshot] = await Promise.all([
      getAttachedProjectProfile(workspacePaths, projectId),
      getAttachedProjectBaselineSnapshot(workspacePaths, projectId),
      getAttachedProjectCapabilitySnapshot(workspacePaths, projectId)
    ]);
    const recommendedStackPack = recommendAttachedProjectStackPack(project);
    const selectedExecutionDefaults = buildAttachedProjectExecutionDefaults({
      project,
      stack_pack_id: selection?.stack_pack_id ?? recommendedStackPack.id,
      task_preset_id:
        selection?.task_preset_id ?? recommendedStackPack.default_task_preset_id
    });

    return {
      project,
      project_profile_ref: buildProjectRef(workspacePaths, projectId, "profileFile"),
      baseline_snapshot: baselineSnapshot,
      baseline_snapshot_ref: baselineSnapshot
        ? buildProjectRef(workspacePaths, projectId, "baselineSnapshotFile")
        : null,
      capability_snapshot: capabilitySnapshot,
      capability_snapshot_ref: capabilitySnapshot
        ? buildProjectRef(workspacePaths, projectId, "capabilitySnapshotFile")
        : null,
      recommended_stack_pack: recommendedStackPack,
      task_preset_recommendations: listAttachedProjectTaskPresetRecommendations({
        stack_pack_id: selectedExecutionDefaults.stack_pack.id
      }),
      default_task_preset_id: selectedExecutionDefaults.stack_pack.default_task_preset_id,
      execution_contract_preview: buildAttachedProjectExecutionContractPreview({
        project,
        stack_pack_id: selectedExecutionDefaults.stack_pack.id,
        task_preset_id: selectedExecutionDefaults.task_preset.id
      }),
      run_template: buildAttachedProjectRunTemplate({
        project,
        ownerId,
        taskPresetTitle: selectedExecutionDefaults.task_preset.title
      })
    };
  };

  app.get("/projects", async () => {
    const projects = await listAttachedProjectProfiles(workspacePaths);

    return {
      projects: await Promise.all(
        projects.map(async (project) => {
          const [baselineSnapshot, capabilitySnapshot] = await Promise.all([
            getAttachedProjectBaselineSnapshot(workspacePaths, project.id),
            getAttachedProjectCapabilitySnapshot(workspacePaths, project.id)
          ]);
          const recommendedStackPack = recommendAttachedProjectStackPack(project);
          return {
            project,
            project_profile_ref: buildProjectRef(
              workspacePaths,
              project.id,
              "profileFile"
            ),
            baseline_snapshot_ref: baselineSnapshot
              ? buildProjectRef(
                  workspacePaths,
                  project.id,
                  "baselineSnapshotFile"
                )
              : null,
            baseline_captured_at: baselineSnapshot?.captured_at ?? null,
            capability_snapshot: capabilitySnapshot,
            capability_snapshot_ref: capabilitySnapshot
              ? buildProjectRef(
                  workspacePaths,
                  project.id,
                  "capabilitySnapshotFile"
                )
              : null,
            capability_captured_at: capabilitySnapshot?.captured_at ?? null,
            capability_overall_status: capabilitySnapshot?.overall_status ?? null,
            recommended_stack_pack_id: recommendedStackPack.id,
            default_task_preset_id: recommendedStackPack.default_task_preset_id
          };
        })
      )
    };
  });

  app.get("/projects/:projectId", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };

    try {
      return await buildAttachedProjectPayload(projectId);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        return reply.code(404).send({
          message: `Attached project not found: ${projectId}`
        });
      }

      throw error;
    }
  });

  app.post("/projects/attach", async (request, reply) => {
    try {
      const input = AttachProjectInputSchema.parse(request.body);
      const inspection = await inspectAttachedProjectWorkspace({
        workspaceRoot: input.workspace_root,
        policy: runWorkspaceScopePolicy,
        title: input.title ?? null
      });
      const existingProject = await getAttachedProjectProfile(
        workspacePaths,
        inspection.project.id
      ).catch(() => null);

      if (existingProject) {
        inspection.project.created_at = existingProject.created_at;
      }

      await saveAttachedProjectProfile(workspacePaths, inspection.project);
      await saveAttachedProjectBaselineSnapshot(
        workspacePaths,
        inspection.baselineSnapshot
      );
      await captureAndPersistAttachedProjectCapability(inspection.project);

      return reply.code(201).send({
        ...(await buildAttachedProjectPayload(
          inspection.project.id,
          input.owner_id ?? null
        )),
        attach_result: {
          workspace_root: inspection.lock.resolvedRoot,
          matched_scope_root: inspection.lock.matchedScopeRoot
        }
      });
    } catch (error) {
      if (error instanceof ProjectAttachError) {
        const statusCode =
          error.code === "workspace_not_git_repo" ||
          error.code === "invalid_project_manifest"
            ? 422
            : 400;
        return reply.code(statusCode).send({
          code: error.code,
          message: error.message,
          details: error.details
        });
      }

      return reply.code(400).send({
        message: describeWorkspaceScopeError(error)
      });
    }
  });

  app.post("/projects/:projectId/runs", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };

    try {
      const parsedInput = CreateAttachedProjectRunRequestSchema.safeParse(
        request.body ?? {}
      );
      if (!parsedInput.success) {
        return reply.code(400).send({
          message: parsedInput.error.issues
            .map((issue: { message: string }) => issue.message)
            .join("; ")
        });
      }
      const input = parsedInput.data;
      const project = await getAttachedProjectProfile(workspacePaths, projectId);
      const executionDefaults = buildAttachedProjectExecutionDefaults({
        project,
        stack_pack_id: input.stack_pack_id ?? null,
        task_preset_id: input.task_preset_id ?? null
      });
      const template = buildAttachedProjectRunTemplate({
        project,
        ownerId: input.owner_id ?? null,
        taskPresetTitle: executionDefaults.task_preset.title
      });
      const lockedWorkspace = await lockWorkspaceRootOrThrowDetailed(
        template.workspace_root
      );
      const run = createRun({
        ...template,
        attached_project_id: project.id,
        attached_project_stack_pack_id: executionDefaults.stack_pack.id,
        attached_project_task_preset_id: executionDefaults.task_preset.id,
        workspace_root: lockedWorkspace.resolvedRoot,
        workspace_scope: buildPersistedRunWorkspaceScope(lockedWorkspace),
        runtime_upgrade_intent: input.runtime_upgrade_intent ?? false,
        harness_profile: {
          execution: {
            default_verifier_kit: executionDefaults.verifier_kit
          }
        }
      });
      const current = createCurrentDecision({
        run_id: run.id,
        run_status: "draft",
        summary: "Attached project run created. Waiting to launch."
      });

      await saveRun(workspacePaths, run);
      await saveRunPolicyRuntime(
        workspacePaths,
        buildInitialRunPolicyRuntime({
          runId: run.id,
          runtimeUpgradeIntent: run.runtime_upgrade_intent
        })
      );
      await saveCurrentDecision(workspacePaths, current);
      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: run.id,
          type: "run.created",
          payload: {
            title: run.title,
            owner_id: run.owner_id,
            workspace_root: run.workspace_root,
            attached_project_id: project.id,
            attached_project_stack_pack_id: run.attached_project_stack_pack_id,
            attached_project_task_preset_id: run.attached_project_task_preset_id
          }
        })
      );
      await refreshRunOperatorSurface(workspacePaths, run.id);

      return reply.code(201).send({
        run,
        current,
        attached_project: await buildAttachedProjectPayload(
          project.id,
          input.owner_id ?? null,
          {
            stack_pack_id: executionDefaults.stack_pack.id,
            task_preset_id: executionDefaults.task_preset.id
          }
        )
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        return reply.code(404).send({
          message: `Attached project not found: ${projectId}`
        });
      }

      if (error instanceof RunWorkspaceScopeError) {
        return reply.code(400).send({
          message: error.message
        });
      }

      if (
        error instanceof Error &&
        error.message.includes("is not supported by attached project stack pack")
      ) {
        return reply.code(400).send({
          message: error.message
        });
      }

      throw error;
    }
  });

  app.get("/health", async () => {
    const runSummaries = await Promise.all((await listRuns(workspacePaths)).map((run) => buildRunSummaryItem(run)));
    const degradedRuns = runSummaries
      .filter((item) => item.run_health.likely_zombie)
      .map((item) => ({
        run_id: item.run.id,
        title: item.run.title,
        latest_attempt_id: item.run_health.latest_attempt_id,
        status: item.run_health.status,
        summary: item.run_health.summary,
        latest_activity_at: item.run_health.latest_activity_at,
        latest_activity_age_ms: item.run_health.latest_activity_age_ms
      }));

    return {
      status: degradedRuns.length > 0 ? "degraded" : "ok",
      execution_adapter: {
        type: adapter.type,
        command: adapterConfig.command,
        model: adapterConfig.model ?? null
      },
      adversarial_verifier: {
        type: adversarialVerifier.type,
        command: adversarialVerifierConfig.command,
        model: adversarialVerifierConfig.model ?? null,
        sandbox: adversarialVerifierConfig.sandbox
      },
      runtime_layout: {
        repository_root: runtimeLayout.repositoryRoot,
        dev_repo_root: runtimeLayout.devRepoRoot,
        runtime_repo_root: runtimeLayout.runtimeRepoRoot,
        runtime_data_root: runtimeLayout.runtimeDataRoot,
        managed_workspace_root: runtimeLayout.managedWorkspaceRoot
      },
      allowed_project_roots: allowedProjectRoots,
      allowed_run_workspace_roots: runWorkspaceScopePolicy.allowedRoots,
      run_health_stale_ms: runHealthStaleMs,
      run_count: runSummaries.length,
      degraded_run_count: degradedRuns.length,
      degraded_runs: degradedRuns
    };
  });

  app.get("/runs", async () => {
    const runs = await listRuns(workspacePaths);
    const data = await Promise.all(runs.map((run) => buildRunSummaryItem(run)));

    return { runs: data };
  });

  app.get("/runs/:runId", async (request, reply) => {
    const { runId } = request.params as { runId: string };

    try {
      return await buildRunDetailPayload(runId);
    } catch {
      return reply.code(404).send({ message: `Run ${runId} not found` });
    }
  });

  app.get("/runs/:runId/stream", async (request, reply) => {
    const { runId } = request.params as { runId: string };

    try {
      await getRun(workspacePaths, runId);
    } catch {
      return reply.code(404).send({ message: `Run ${runId} not found` });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    reply.raw.write(": connected\n\n");

    let closed = false;
    let lastSnapshot = "";
    let snapshotTimer: NodeJS.Timeout | null = null;
    let keepAliveTimer: NodeJS.Timeout | null = null;

    const closeStream = () => {
      if (closed) {
        return;
      }

      closed = true;
      if (snapshotTimer) {
        clearInterval(snapshotTimer);
      }
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
      }
      reply.raw.end();
    };

    const pushSnapshot = async () => {
      if (closed) {
        return;
      }

      try {
        const snapshot = await buildRunDetailPayload(runId);
        const serialized = JSON.stringify(snapshot);
        if (serialized === lastSnapshot) {
          return;
        }

        lastSnapshot = serialized;
        reply.raw.write(`event: snapshot\ndata: ${serialized}\n\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply.raw.write(
          `event: error\ndata: ${JSON.stringify({ message })}\n\n`
        );
      }
    };

    request.raw.on("close", closeStream);
    request.raw.on("end", closeStream);

    snapshotTimer = setInterval(() => {
      void pushSnapshot();
    }, 1000);
    keepAliveTimer = setInterval(() => {
      if (!closed) {
        reply.raw.write(`: keepalive ${Date.now()}\n\n`);
      }
    }, 15_000);

    await pushSnapshot();
    return reply;
  });

  app.post("/runs", async (request, reply) => {
    try {
      const input = CreateRunInputSchema.parse(request.body);
      const lockedWorkspace = await lockWorkspaceRootOrThrowDetailed(
        input.workspace_root ?? defaultRunWorkspaceRoot
      );
      const run = createRun({
        ...input,
        workspace_root: lockedWorkspace.resolvedRoot,
        workspace_scope: buildPersistedRunWorkspaceScope(lockedWorkspace)
      });
      const current = createCurrentDecision({
        run_id: run.id,
        run_status: "draft",
        summary: "Run created. Waiting for first attempt."
      });

      await saveRun(workspacePaths, run);
      await saveRunPolicyRuntime(
        workspacePaths,
        buildInitialRunPolicyRuntime({
          runId: run.id,
          runtimeUpgradeIntent: run.runtime_upgrade_intent
        })
      );
      await saveCurrentDecision(workspacePaths, current);
      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: run.id,
          type: "run.created",
          payload: {
            title: run.title,
            owner_id: run.owner_id,
            workspace_root: run.workspace_root
          }
        })
      );
      await refreshRunOperatorSurface(workspacePaths, run.id);

      return reply.code(201).send({ run, current });
    } catch (error) {
      return reply.code(400).send({
        message: describeWorkspaceScopeError(error)
      });
    }
  });

  app.post("/runs/self-bootstrap", async (request, reply) => {
    const body = (request.body as
      | {
          owner_id?: string;
          focus?: string;
          launch?: boolean;
          seed_steer?: boolean;
        }
      | undefined) ?? {
      launch: true,
      seed_steer: true
    };
    let activeNextTask;
    try {
      activeNextTask = await loadSelfBootstrapNextTaskActiveEntry(
        runtimeLayout.devRepoRoot
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ message });
    }

    const template = buildSelfBootstrapRunTemplate({
      workspaceRoot: runtimeLayout.devRepoRoot,
      ownerId: body.owner_id,
      focus: body.focus,
      activeNextTask: {
        path: activeNextTask.path,
        ...activeNextTask.entry
      }
    });
    let run;
    try {
      const lockedWorkspace = await lockWorkspaceRootOrThrowDetailed(
        template.runInput.workspace_root ?? defaultRunWorkspaceRoot
      );
      run = createRun({
        ...template.runInput,
        workspace_root: lockedWorkspace.resolvedRoot,
        workspace_scope: buildPersistedRunWorkspaceScope(lockedWorkspace),
        runtime_upgrade_intent: true
      });
    } catch (error) {
      return reply.code(400).send({
        message: describeWorkspaceScopeError(error)
      });
    }
    let current = createCurrentDecision({
      run_id: run.id,
      run_status: "draft",
      summary: "Self-bootstrap run created. Waiting to launch."
    });
    const runPaths = resolveRunPaths(workspacePaths, run.id);
    let selfBootstrapArtifacts: Awaited<
      ReturnType<typeof captureSelfBootstrapNextTaskArtifacts>
    >;
    try {
      selfBootstrapArtifacts =
        await captureSelfBootstrapNextTaskArtifacts({
          workspaceRoot: runtimeLayout.devRepoRoot,
          workspaceDataRoot: workspacePaths.rootDir,
          runArtifactsDir: runPaths.artifactsDir,
          activeEntry: activeNextTask.entry
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ message });
    }
    const runtimeHealthSnapshotRef = buildRunRef(
      workspacePaths,
      run.id,
      "runtimeHealthSnapshotFile"
    );
    let runtimeHealthSnapshot;
    try {
      runtimeHealthSnapshot = await captureSelfBootstrapRuntimeHealthSnapshot({
        runId: run.id,
        workspaceRoot: runtimeLayout.devRepoRoot,
        runtimeRepoRoot: runtimeLayout.runtimeRepoRoot
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ message });
    }
    const seededTemplate = buildSelfBootstrapRunTemplate({
      workspaceRoot: runtimeLayout.devRepoRoot,
      ownerId: body.owner_id,
      focus: body.focus,
      activeNextTask: {
        path: activeNextTask.path,
        ...activeNextTask.entry
      },
      runtimeHealthSnapshot: {
        path: runtimeHealthSnapshotRef,
        snapshot: runtimeHealthSnapshot
      }
    });
    await saveRun(workspacePaths, run);
    await saveRunPolicyRuntime(
      workspacePaths,
      buildInitialRunPolicyRuntime({
        runId: run.id,
        runtimeUpgradeIntent: run.runtime_upgrade_intent
      })
    );
    await saveRunRuntimeHealthSnapshot(workspacePaths, runtimeHealthSnapshot);
    await saveCurrentDecision(workspacePaths, current);
    await appendRunJournal(
      workspacePaths,
      createRunJournalEntry({
        run_id: run.id,
        type: "run.created",
        payload: {
          title: run.title,
          owner_id: run.owner_id,
          template: "self-bootstrap"
        }
      })
    );
    await appendRunJournal(
      workspacePaths,
      createRunJournalEntry({
        run_id: run.id,
        type: "run.self_bootstrap.active_next_task.captured",
        payload: {
          published_path: activeNextTask.path,
          snapshot_path: selfBootstrapArtifacts.activeEntrySnapshotRef,
          source_asset_snapshot_path:
            selfBootstrapArtifacts.sourceAssetSnapshotRef,
          title: activeNextTask.entry.title,
          source_anchor: activeNextTask.entry.source_anchor,
          captured_payload_sha256:
            selfBootstrapArtifacts.sourceAssetPayloadSha256
        }
      })
    );
    await appendRunJournal(
      workspacePaths,
      createRunJournalEntry({
        run_id: run.id,
        type: "run.runtime_health_snapshot.captured",
        payload: {
          path: runtimeHealthSnapshotRef,
          verify_runtime_status: runtimeHealthSnapshot.verify_runtime.status,
          history_contract_drift_status:
            runtimeHealthSnapshot.history_contract_drift.status,
          drift_count: runtimeHealthSnapshot.history_contract_drift.drift_count
        }
      })
    );

    let runSteer = null;
    if (body.seed_steer !== false) {
      runSteer = createRunSteer({
        run_id: run.id,
        content: seededTemplate.initialSteer
      });
      await saveRunSteer(workspacePaths, runSteer);
      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: run.id,
          type: "run.steer.queued",
          payload: {
            content: runSteer.content,
            template: "self-bootstrap"
          }
        })
      );
    }

    if (body.launch !== false) {
      current = updateCurrentDecision(current, {
        run_status: "running",
        waiting_for_human: false,
        blocking_reason: null,
        recommended_next_action: "start_first_attempt",
        recommended_attempt_type: "research",
        summary: "Self-bootstrap run launched. Loop will create the first attempt."
      });
      await saveCurrentDecision(workspacePaths, current);
      await saveRunPolicyRuntime(
        workspacePaths,
        buildInitialRunPolicyRuntime({
          runId: run.id,
          runtimeUpgradeIntent: run.runtime_upgrade_intent
        })
      );
      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: run.id,
          type: "run.launched",
          payload: {
            template: "self-bootstrap"
          }
        })
      );
      await activateRunAutomation(run.id, "control-api");
    }
    await refreshRunOperatorSurface(workspacePaths, run.id);

    return reply.code(201).send({
      run,
      current,
      steer: runSteer,
      template: "self-bootstrap",
      active_next_task: activeNextTask.path,
      active_next_task_snapshot: selfBootstrapArtifacts.activeEntrySnapshotRef,
      active_next_task_source_snapshot:
        selfBootstrapArtifacts.sourceAssetSnapshotRef,
      runtime_health_snapshot: runtimeHealthSnapshotRef
    });
  });

  app.post("/runs/:runId/launch", async (request, reply) => {
    const { runId } = request.params as { runId: string };

    try {
      const run = await getRun(workspacePaths, runId);
      await lockWorkspaceRootOrThrow(run.workspace_root);
      const attempts = await listAttempts(workspacePaths, runId);
      const current =
        (await getCurrentDecision(workspacePaths, runId)) ??
        createCurrentDecision({
          run_id: runId,
          run_status: "draft"
        });
      const latestAttemptSurface = await readLatestRunEvidenceSurface({
        paths: workspacePaths,
        runId,
        current,
        attempts
      });
      let policyRuntime = await getRunPolicyRuntime(workspacePaths, runId);
      if (policyRuntime === null) {
        try {
          policyRuntime = await readRunPolicyRuntimeStrict(workspacePaths, runId);
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err?.code !== "ENOENT") {
            return reply.code(409).send({
              message:
                error instanceof Error
                  ? error.message
                  : "Policy runtime is unreadable."
            });
          }
        }
      }
      if (isExecutionApprovalPending(policyRuntime)) {
        return reply.code(409).send({
          message:
            policyRuntime?.blocking_reason ??
            "Execution plan is blocked pending leader approval."
        });
      }
      if (policyRuntime?.killswitch_active) {
        return reply.code(409).send({
          message:
            policyRuntime.killswitch_reason ??
            "Execution is paused because the policy killswitch is active."
        });
      }
      const latestAttempt = pickLatestAttempt(attempts, current);
      const recoveryGuidance = await readRunRecoveryGuidance({
        workspacePaths,
        runId,
        run,
        current,
        attempts
      });
      const resumesApprovedExecution = hasApprovedExecutionPlan(policyRuntime);
      const forcesResearchReplan =
        policyRuntime?.approval_status === "rejected" &&
        policyRuntime.proposed_attempt_type === "execution";
      const nextAction = resumesApprovedExecution
        ? "continue_execution"
        : forcesResearchReplan
          ? "continue_research"
        : recoveryGuidance.path === "latest_decision"
          ? inferLaunchNextAction({
              current,
              attempts
            })
          : recoveryGuidance.nextAction;
      const nextAttemptType = resumesApprovedExecution
        ? "execution"
        : forcesResearchReplan
          ? "research"
        : recoveryGuidance.path === "latest_decision"
          ? inferLaunchAttemptType({
              current,
              attempts
            })
          : recoveryGuidance.attemptType;
      if (run.attached_project_id) {
        let attachedProject: AttachedProjectProfile;

        try {
          attachedProject = await getAttachedProjectProfile(
            workspacePaths,
            run.attached_project_id
          );
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err?.code === "ENOENT") {
            return reply.code(409).send({
              code: "attached_project_missing",
              message: `Attached project not found: ${run.attached_project_id}`
            });
          }

          throw error;
        }

        if (attachedProject.workspace_root !== run.workspace_root) {
          return reply.code(409).send({
            code: "attached_project_workspace_mismatch",
            message:
              "Attached project workspace no longer matches the run workspace."
          });
        }

        const capabilitySnapshot =
          await captureAndPersistAttachedProjectCapability(attachedProject);
        const capabilityGate = capabilitySnapshot.launch_readiness[nextAttemptType];
        if (capabilityGate.status === "blocked") {
          return reply.code(409).send({
            code: "attached_project_capability_blocked",
            message: capabilityGate.summary,
            attempt_type: nextAttemptType,
            capability_snapshot: capabilitySnapshot,
            capability_snapshot_ref: buildProjectRef(
              workspacePaths,
              attachedProject.id,
              "capabilitySnapshotFile"
            )
          });
        }
      }
      const launchSummary = resumesApprovedExecution
        ? "Run resumed. Loop will dispatch the approved execution plan."
        : forcesResearchReplan
          ? "Run resumed after execution rejection. Loop will gather more research before proposing another execution."
        : current.latest_attempt_id === null
          ? "Run launched. Loop will create the first attempt."
          : recoveryGuidance.path === "handoff_first"
            ? recoveryGuidance.handoffBundleRef
              ? `Run resumed from settled handoff ${recoveryGuidance.handoffBundleRef}. Loop will follow the handoff-first recovery path.`
              : "Run resumed from the latest settled handoff bundle. Loop will follow the handoff-first recovery path."
            : recoveryGuidance.path === "degraded_rebuild"
              ? "Run resumed without a settled handoff bundle. Loop will rebuild the recovery context from degraded evidence first."
              : "Run resumed. Loop will continue from the latest decision.";

      const nextCurrent = updateCurrentDecision(current, {
        run_status: "running",
        waiting_for_human: false,
        blocking_reason:
          resumesApprovedExecution || recoveryGuidance.path === "latest_decision"
            ? null
            : forcesResearchReplan
              ? policyRuntime?.blocking_reason ?? recoveryGuidance.blockingReason
            : recoveryGuidance.blockingReason,
        recommended_next_action: nextAction,
        recommended_attempt_type: nextAttemptType,
        summary: launchSummary
      });

      await saveCurrentDecision(workspacePaths, nextCurrent);
      await saveRunPolicyRuntime(
        workspacePaths,
        policyRuntime &&
          policyRuntime.approval_required === true &&
          policyRuntime.approval_status === "approved" &&
          policyRuntime.proposed_attempt_type === "execution"
          ? updateRunPolicyRuntime(policyRuntime, {
              stage: "execution",
              blocking_reason: null,
              last_decision: "approved"
            })
          : policyRuntime
          ? updateRunPolicyRuntime(policyRuntime, {
              stage: "planning",
              approval_status: "not_required",
              approval_required: false,
              proposed_signature: null,
              proposed_attempt_type: null,
              proposed_objective: null,
              proposed_success_criteria: [],
              permission_profile: "read_only",
              hook_policy: "not_required",
              danger_mode: "forbid",
              blocking_reason: null,
              last_decision: "planning",
              approval_requested_at: null,
              approval_decided_at: null,
              approval_actor: null,
              approval_note: null,
              source_ref: null
            })
          : buildInitialRunPolicyRuntime({
              runId,
              runtimeUpgradeIntent: run.runtime_upgrade_intent
            })
      );
      await activateRunAutomation(runId, "control-api");
      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          type: "run.launched",
          payload: {
            recovery_path: resumesApprovedExecution
              ? "approved_execution_plan"
              : forcesResearchReplan
                ? "rejected_execution_replan"
              : recoveryGuidance.path,
            handoff_bundle_ref: recoveryGuidance.handoffBundleRef
          }
        })
      );
      await refreshRunOperatorSurface(workspacePaths, runId);

      return {
        current: nextCurrent,
        recovery: {
          ...toRecoveryPayload(recoveryGuidance),
          path: resumesApprovedExecution
            ? "approved_execution_plan"
            : forcesResearchReplan
              ? "rejected_execution_replan"
            : recoveryGuidance.path,
          handoff_bundle_ref: recoveryGuidance.handoffBundleRef
        }
      };
    } catch (error) {
      if (error instanceof RunWorkspaceScopeError) {
        return reply.code(400).send({ message: error.message });
      }
      return reply.code(404).send({ message: `Run ${runId} not found` });
    }
  });

  app.post("/runs/:runId/policy/approve", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body =
      (request.body as
        | {
            actor?: string;
            note?: string;
          }
        | undefined) ?? {};

    try {
      const policyRuntime = await readRunPolicyRuntimeStrict(workspacePaths, runId);
      if (
        policyRuntime.approval_required !== true ||
        policyRuntime.proposed_attempt_type !== "execution" ||
        policyRuntime.approval_status !== "pending" ||
        policyRuntime.stage !== "approval"
      ) {
        return reply.code(409).send({
          message: "There is no pending execution plan waiting for approval."
        });
      }

      const current =
        (await getCurrentDecision(workspacePaths, runId)) ??
        createCurrentDecision({
          run_id: runId,
          run_status: "draft"
        });
      const nextPolicy = updateRunPolicyRuntime(policyRuntime, {
        stage: "execution",
        approval_status: "approved",
        blocking_reason: null,
        last_decision: "approved",
        approval_decided_at: new Date().toISOString(),
        approval_actor: body.actor?.trim() || "control-api",
        approval_note: body.note?.trim() || null
      });
      const nextCurrent = updateCurrentDecision(current, {
        run_status: "running",
        waiting_for_human: false,
        blocking_reason: null,
        recommended_next_action: "continue_execution",
        recommended_attempt_type: "execution",
        summary: "Execution plan approved. Loop will dispatch the approved attempt."
      });

      await saveRunPolicyRuntime(workspacePaths, nextPolicy);
      await saveCurrentDecision(workspacePaths, nextCurrent);
      const approvalThreadId = buildRunMailboxThreadId({
        kind: "approval",
        value: nextPolicy.proposed_signature ?? "pending"
      });
      await resolveRunMailboxThread({
        paths: workspacePaths,
        runId,
        threadId: approvalThreadId,
        resolutionSummary: "Execution plan approved.",
        resolvedAt: nextPolicy.approval_decided_at ?? undefined,
        sourceRef: nextPolicy.source_ref
      });
      await appendResolvedRunMailboxEntry({
        paths: workspacePaths,
        runId,
        threadId: approvalThreadId,
        messageType: "approval_resolution",
        toSlotOrActor: "execution",
        summary: "Execution plan approved.",
        sourceRef: nextPolicy.source_ref,
        sourceAttemptId: nextPolicy.source_attempt_id,
        createdAt: nextPolicy.approval_decided_at ?? undefined,
        resolvedAt: nextPolicy.approval_decided_at ?? undefined
      });
      await activateRunAutomation(runId, "control-api");
      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: policyRuntime.source_attempt_id,
          type: "run.policy.approved",
          payload: {
            actor: nextPolicy.approval_actor,
            note: nextPolicy.approval_note,
            proposed_signature: nextPolicy.proposed_signature
          }
        })
      );
      await refreshRunOperatorSurface(workspacePaths, runId);

      return {
        current: nextCurrent,
        policy_runtime: nextPolicy
      };
    } catch (error) {
      return reply.code(409).send({
        message:
          error instanceof Error
            ? error.message
            : "Policy runtime is missing or unreadable."
      });
    }
  });

  app.post("/runs/:runId/policy/reject", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body =
      (request.body as
        | {
            actor?: string;
            note?: string;
          }
        | undefined) ?? {};

    try {
      const policyRuntime = await readRunPolicyRuntimeStrict(workspacePaths, runId);
      if (
        policyRuntime.approval_required !== true ||
        policyRuntime.proposed_attempt_type !== "execution" ||
        policyRuntime.approval_status !== "pending" ||
        policyRuntime.stage !== "approval"
      ) {
        return reply.code(409).send({
          message: "There is no pending execution plan waiting for rejection."
        });
      }

      const current =
        (await getCurrentDecision(workspacePaths, runId)) ??
        createCurrentDecision({
          run_id: runId,
          run_status: "draft"
        });
      const rejectionMessage =
        body.note?.trim() ||
        "Execution plan was rejected. Relaunch to gather more research first.";
      const nextPolicy = updateRunPolicyRuntime(policyRuntime, {
        stage: "approval",
        approval_status: "rejected",
        blocking_reason: rejectionMessage,
        last_decision: "rejected",
        approval_decided_at: new Date().toISOString(),
        approval_actor: body.actor?.trim() || "control-api",
        approval_note: body.note?.trim() || null
      });
      const nextCurrent = updateCurrentDecision(current, {
        run_status: "waiting_steer",
        waiting_for_human: true,
        blocking_reason: rejectionMessage,
        recommended_next_action: "continue_research",
        recommended_attempt_type: "research",
        summary: rejectionMessage
      });

      await saveRunPolicyRuntime(workspacePaths, nextPolicy);
      await saveCurrentDecision(workspacePaths, nextCurrent);
      const approvalThreadId = buildRunMailboxThreadId({
        kind: "approval",
        value: nextPolicy.proposed_signature ?? "pending"
      });
      await resolveRunMailboxThread({
        paths: workspacePaths,
        runId,
        threadId: approvalThreadId,
        resolutionSummary: rejectionMessage,
        resolvedAt: nextPolicy.approval_decided_at ?? undefined,
        sourceRef: nextPolicy.source_ref
      });
      await appendResolvedRunMailboxEntry({
        paths: workspacePaths,
        runId,
        threadId: approvalThreadId,
        messageType: "approval_resolution",
        toSlotOrActor: "research_or_planning",
        summary: rejectionMessage,
        requiredAction: "replan_execution",
        sourceRef: nextPolicy.source_ref,
        sourceAttemptId: nextPolicy.source_attempt_id,
        createdAt: nextPolicy.approval_decided_at ?? undefined,
        resolvedAt: nextPolicy.approval_decided_at ?? undefined
      });
      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: policyRuntime.source_attempt_id,
          type: "run.policy.rejected",
          payload: {
            actor: nextPolicy.approval_actor,
            note: nextPolicy.approval_note,
            proposed_signature: nextPolicy.proposed_signature
          }
        })
      );
      await refreshRunOperatorSurface(workspacePaths, runId);

      return {
        current: nextCurrent,
        policy_runtime: nextPolicy
      };
    } catch (error) {
      return reply.code(409).send({
        message:
          error instanceof Error
            ? error.message
            : "Policy runtime is missing or unreadable."
      });
    }
  });

  app.post("/runs/:runId/runtime-upgrade/approve", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body =
      (request.body as
        | {
            actor?: string;
            note?: string;
          }
        | undefined) ?? {};

    try {
      const run = await getRun(workspacePaths, runId);
      if (!run.runtime_upgrade_intent) {
        return reply.code(409).send({
          message: "This run was not created as a runtime upgrade."
        });
      }

      const basePolicy =
        (await getRunPolicyRuntime(workspacePaths, runId)) ??
        buildInitialRunPolicyRuntime({
          runId,
          runtimeUpgradeIntent: true
        });
      const decidedAt = new Date().toISOString();
      const nextPolicy = updateRunPolicyRuntime(basePolicy, {
        runtime_upgrade_approval_status: "approved",
        runtime_upgrade_requested_at: basePolicy.runtime_upgrade_requested_at ?? decidedAt,
        runtime_upgrade_decided_at: decidedAt,
        runtime_upgrade_actor: body.actor?.trim() || "control-api",
        runtime_upgrade_note: body.note?.trim() || null
      });

      await saveRunPolicyRuntime(workspacePaths, nextPolicy);
      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          type: "run.runtime_upgrade.approved",
          payload: {
            actor: nextPolicy.runtime_upgrade_actor,
            note: nextPolicy.runtime_upgrade_note
          }
        })
      );
      await refreshRunOperatorSurface(workspacePaths, runId);

      return {
        policy_runtime: nextPolicy
      };
    } catch (error) {
      return reply.code(404).send({
        message: error instanceof Error ? error.message : `Run ${runId} not found`
      });
    }
  });

  app.post("/runs/:runId/runtime-upgrade/reject", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body =
      (request.body as
        | {
            actor?: string;
            note?: string;
          }
        | undefined) ?? {};

    try {
      const run = await getRun(workspacePaths, runId);
      if (!run.runtime_upgrade_intent) {
        return reply.code(409).send({
          message: "This run was not created as a runtime upgrade."
        });
      }

      const basePolicy =
        (await getRunPolicyRuntime(workspacePaths, runId)) ??
        buildInitialRunPolicyRuntime({
          runId,
          runtimeUpgradeIntent: true
        });
      const decidedAt = new Date().toISOString();
      const nextPolicy = updateRunPolicyRuntime(basePolicy, {
        runtime_upgrade_approval_status: "rejected",
        runtime_upgrade_requested_at: basePolicy.runtime_upgrade_requested_at ?? decidedAt,
        runtime_upgrade_decided_at: decidedAt,
        runtime_upgrade_actor: body.actor?.trim() || "control-api",
        runtime_upgrade_note:
          body.note?.trim() || "Runtime upgrade approval was rejected."
      });

      await saveRunPolicyRuntime(workspacePaths, nextPolicy);
      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          type: "run.runtime_upgrade.rejected",
          payload: {
            actor: nextPolicy.runtime_upgrade_actor,
            note: nextPolicy.runtime_upgrade_note
          }
        })
      );
      await refreshRunOperatorSurface(workspacePaths, runId);

      return {
        policy_runtime: nextPolicy
      };
    } catch (error) {
      return reply.code(404).send({
        message: error instanceof Error ? error.message : `Run ${runId} not found`
      });
    }
  });

  app.post("/runs/:runId/policy/killswitch/enable", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body =
      (request.body as
        | {
            actor?: string;
            reason?: string;
            note?: string;
          }
        | undefined) ?? {};

    try {
      const [run, policySurface, attempts] = await Promise.all([
        getRun(workspacePaths, runId),
        readRunPolicyRuntimeSurface(workspacePaths, runId),
        listAttempts(workspacePaths, runId)
      ]);
      if (policySurface.policyRuntimeInvalidReason) {
        return reply.code(409).send({
          message: policySurface.policyRuntimeInvalidReason
        });
      }

      const current =
        (await getCurrentDecision(workspacePaths, runId)) ??
        createCurrentDecision({
          run_id: runId,
          run_status: "draft"
        });
      const reason =
        body.reason?.trim() ||
        body.note?.trim() ||
        "Execution is paused because the policy killswitch is active.";
      const actor = body.actor?.trim() || "control-api";
      const basePolicy =
        policySurface.policyRuntime ??
        buildInitialRunPolicyRuntime({
          runId,
          runtimeUpgradeIntent: run.runtime_upgrade_intent
        });
      const preservedBlockingReason =
        basePolicy.blocking_reason && basePolicy.blocking_reason !== basePolicy.killswitch_reason
          ? basePolicy.blocking_reason
          : reason;
      const nextPolicy = updateRunPolicyRuntime(basePolicy, {
        run_id: runId,
        killswitch_active: true,
        killswitch_reason: reason,
        blocking_reason: preservedBlockingReason,
        last_decision: "killswitch_enabled"
      });

      await saveRunPolicyRuntime(workspacePaths, nextPolicy);
      const hasActiveAttempt = attempts.some((attempt) =>
        ["created", "queued", "running"].includes(attempt.status)
      );
      const nextCurrent = hasActiveAttempt
        ? current
        : updateCurrentDecision(current, {
            run_status: "waiting_steer",
            waiting_for_human: true,
            recommended_next_action: "wait_for_human",
            blocking_reason: reason,
            summary: reason
          });
      if (!hasActiveAttempt) {
        await saveCurrentDecision(workspacePaths, nextCurrent);
      }
      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: current.latest_attempt_id,
          type: "run.policy.killswitch_enabled",
          payload: {
            actor,
            note: body.note?.trim() || null,
            message: reason,
            proposed_signature: nextPolicy.proposed_signature,
            source_ref: nextPolicy.source_ref
          }
        })
      );
      await refreshRunOperatorSurface(workspacePaths, run.id);

      return {
        current: nextCurrent,
        policy_runtime: nextPolicy
      };
    } catch {
      return reply.code(404).send({ message: `Run ${runId} not found` });
    }
  });

  app.post("/runs/:runId/policy/killswitch/clear", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body =
      (request.body as
        | {
            actor?: string;
            note?: string;
          }
        | undefined) ?? {};

    try {
      const policyRuntime = await readRunPolicyRuntimeStrict(workspacePaths, runId);
      if (!policyRuntime.killswitch_active) {
        return reply.code(409).send({
          message: "The policy killswitch is not active."
        });
      }

      const [run, attempts] = await Promise.all([
        getRun(workspacePaths, runId),
        listAttempts(workspacePaths, runId)
      ]);
      const current =
        (await getCurrentDecision(workspacePaths, runId)) ??
        createCurrentDecision({
          run_id: runId,
          run_status: "draft"
        });
      const recoveryGuidance = await readRunRecoveryGuidance({
        workspacePaths,
        runId,
        current,
        attempts
      });
      const actor = body.actor?.trim() || "control-api";
      const restoredBlockingReason =
        policyRuntime.blocking_reason === policyRuntime.killswitch_reason
          ? null
          : policyRuntime.blocking_reason;
      const nextPolicy = updateRunPolicyRuntime(policyRuntime, {
        killswitch_active: false,
        killswitch_reason: null,
        blocking_reason: restoredBlockingReason,
        last_decision: "killswitch_cleared"
      });
      await saveRunPolicyRuntime(workspacePaths, nextPolicy);
      const resumesApprovedExecution = hasApprovedExecutionPlan(nextPolicy);

      const hasActiveAttempt = attempts.some((attempt) =>
        ["created", "queued", "running"].includes(attempt.status)
      );
      const clearMessage = resumesApprovedExecution
        ? [
            restoredBlockingReason ?? "Policy killswitch cleared. Relaunch when ready.",
            "Approved execution plan remains staged for relaunch."
          ].join(" ")
        : [
            restoredBlockingReason ?? "Policy killswitch cleared. Relaunch when ready.",
            buildRecoveryResumeSummary({
              path: recoveryGuidance.path,
              handoffBundleRef: recoveryGuidance.handoffBundleRef
            })
          ].join(" ");
      const nextCurrent = hasActiveAttempt
        ? current
        : updateCurrentDecision(current, {
            run_status: "waiting_steer",
            waiting_for_human: true,
            recommended_next_action: "wait_for_human",
            recommended_attempt_type: resumesApprovedExecution
              ? "execution"
              : recoveryGuidance.attemptType,
            blocking_reason:
              restoredBlockingReason ??
              (resumesApprovedExecution ? null : recoveryGuidance.blockingReason),
            summary: clearMessage
          });
      if (!hasActiveAttempt) {
        await saveCurrentDecision(workspacePaths, nextCurrent);
      }
      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: current.latest_attempt_id,
          type: "run.policy.killswitch_cleared",
          payload: {
            actor,
            note: body.note?.trim() || null,
            message: clearMessage,
            recovery_path: resumesApprovedExecution
              ? "approved_execution_plan"
              : recoveryGuidance.path,
            handoff_bundle_ref: resumesApprovedExecution
              ? null
              : recoveryGuidance.handoffBundleRef,
            proposed_signature: nextPolicy.proposed_signature,
            source_ref: nextPolicy.source_ref
          }
        })
      );
      await refreshRunOperatorSurface(workspacePaths, run.id);

      return {
        current: nextCurrent,
        policy_runtime: nextPolicy,
        recovery: {
          ...toRecoveryPayload(recoveryGuidance),
          path: resumesApprovedExecution
            ? "approved_execution_plan"
            : recoveryGuidance.path,
          handoff_bundle_ref: resumesApprovedExecution
            ? null
            : recoveryGuidance.handoffBundleRef
        }
      };
    } catch (error) {
      return reply.code(409).send({
        message:
          error instanceof Error
            ? error.message
            : "Policy runtime is missing or unreadable."
      });
    }
  });

  app.post("/runs/:runId/repair-managed-workspace", async (request, reply) => {
    const { runId } = request.params as { runId: string };

    try {
      const [run, attempts] = await Promise.all([
        getRun(workspacePaths, runId),
        listAttempts(workspacePaths, runId)
      ]);
      const current =
        (await getCurrentDecision(workspacePaths, runId)) ??
        createCurrentDecision({
          run_id: runId,
          run_status: "draft"
        });
      const recoveryGuidance = await readRunRecoveryGuidance({
        workspacePaths,
        runId,
        current,
        attempts
      });

      try {
        const scopedPolicy = createRunScopedWorkspacePolicy({
          run,
          managedWorkspaceRoot: runWorkspaceScopePolicy.managedWorkspaceRoot
        });
        const ensuredRun = await ensureRunManagedWorkspace({
          run,
          policy: scopedPolicy
        });
        if (
          ensuredRun.workspace_root !== run.workspace_root ||
          ensuredRun.managed_workspace_root !== run.managed_workspace_root
        ) {
          await saveRun(workspacePaths, ensuredRun);
        }

        const summary = [
          "隔离工作区已经就绪。",
          buildRecoveryResumeSummary({
            path: recoveryGuidance.path,
            handoffBundleRef: recoveryGuidance.handoffBundleRef
          })
        ].join(" ");
        const nextCurrent = updateCurrentDecision(current, {
          run_status: "waiting_steer",
          waiting_for_human: true,
          recommended_next_action: "wait_for_human",
          recommended_attempt_type: recoveryGuidance.attemptType,
          blocking_reason: recoveryGuidance.blockingReason ?? summary,
          summary
        });
        await saveCurrentDecision(workspacePaths, nextCurrent);
        await setManualOnlyRunAutomation({
          runId,
          reason: summary,
          imposedBy: "control-api"
        });
        await appendRunJournal(
          workspacePaths,
          createRunJournalEntry({
            run_id: runId,
            attempt_id: current.latest_attempt_id,
            type: "run.manual_recovery",
            payload: {
              action: "repair_managed_workspace",
              status: "noop",
              message: summary,
              recovery_path: recoveryGuidance.path,
              handoff_bundle_ref: recoveryGuidance.handoffBundleRef,
              managed_workspace_root:
                ensuredRun.managed_workspace_root ?? ensuredRun.workspace_root
            }
          })
        );
        await refreshRunOperatorSurface(workspacePaths, runId);

        return {
          run: ensuredRun,
          current: nextCurrent,
          repair: {
            status: "noop",
            message: summary
          },
          recovery: toRecoveryPayload(recoveryGuidance)
        };
      } catch (error) {
        if (
          !(error instanceof RunWorkspaceScopeError) ||
          error.code !== "managed_workspace_stale_from_source"
        ) {
          throw error;
        }

        const repair = await repairRunManagedWorkspace({
          run,
          policy: createRunScopedWorkspacePolicy({
            run,
            managedWorkspaceRoot: runWorkspaceScopePolicy.managedWorkspaceRoot
          })
        });
        await saveRun(workspacePaths, repair.run);

        const summary =
          `隔离工作区已重建，旧现场保留在 ${repair.archived_managed_workspace_root}。` +
          ` ${buildRecoveryResumeSummary({
            path: recoveryGuidance.path,
            handoffBundleRef: recoveryGuidance.handoffBundleRef
          })}`;
        const nextCurrent = updateCurrentDecision(current, {
          run_status: "waiting_steer",
          waiting_for_human: true,
          recommended_next_action: "wait_for_human",
          recommended_attempt_type: recoveryGuidance.attemptType,
          blocking_reason: recoveryGuidance.blockingReason ?? summary,
          summary
        });
        await saveCurrentDecision(workspacePaths, nextCurrent);
        await setManualOnlyRunAutomation({
          runId,
          reason: summary,
          imposedBy: "control-api"
        });
        await appendRunJournal(
          workspacePaths,
          createRunJournalEntry({
            run_id: runId,
            attempt_id: current.latest_attempt_id,
            type: "run.manual_recovery",
            payload: {
              action: "repair_managed_workspace",
              status: repair.status,
              previous_error_code: error.code,
              previous_error_message: error.message,
              previous_managed_workspace_root:
                repair.previous_managed_workspace_root,
              previous_managed_repo_root: repair.previous_managed_repo_root,
              previous_managed_head: repair.previous_managed_head,
              previous_managed_status: repair.previous_managed_status,
              archived_managed_workspace_root:
                repair.archived_managed_workspace_root,
              archived_managed_repo_root: repair.archived_managed_repo_root,
              repaired_managed_workspace_root:
                repair.repaired_managed_workspace_root,
              repaired_managed_repo_root: repair.repaired_managed_repo_root,
              repaired_managed_head: repair.repaired_managed_head,
              source_repo_root: repair.source_repo_root,
              source_head: repair.source_head,
              recovery_path: recoveryGuidance.path,
              handoff_bundle_ref: recoveryGuidance.handoffBundleRef,
              message: summary
            }
          })
        );
        await refreshRunOperatorSurface(workspacePaths, runId);

        return {
          run: repair.run,
          current: nextCurrent,
          repair,
          recovery: toRecoveryPayload(recoveryGuidance)
        };
      }
    } catch (error) {
      if (error instanceof RunWorkspaceScopeError) {
        return reply.code(400).send({ message: error.message });
      }
      return reply.code(404).send({ message: `Run ${runId} not found` });
    }
  });

  app.post("/runs/:runId/steers", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const body = request.body as {
      content: string;
      attempt_id?: string | null;
    };

    try {
      await getRun(workspacePaths, runId);
      const runSteer = createRunSteer({
        run_id: runId,
        attempt_id: body.attempt_id ?? null,
        content: body.content
      });
      await saveRunSteer(workspacePaths, runSteer);

      const current =
        (await getCurrentDecision(workspacePaths, runId)) ??
        createCurrentDecision({
          run_id: runId,
          run_status: "draft"
        });
      const nextCurrent = updateCurrentDecision(current, {
        run_status: "running",
        waiting_for_human: false,
        blocking_reason: null,
        recommended_next_action: "apply_steer",
        summary: "Steer queued. Loop will use it in the next attempt."
      });
      await saveCurrentDecision(workspacePaths, nextCurrent);
      await activateRunAutomation(runId, "control-api");

      await appendRunJournal(
        workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: runSteer.attempt_id,
          type: "run.steer.queued",
          payload: {
            content: runSteer.content
          }
        })
      );
      await refreshRunOperatorSurface(workspacePaths, runId);

      return reply.code(201).send({ steer: runSteer, current: nextCurrent });
    } catch {
      return reply.code(404).send({ message: `Run ${runId} not found` });
    }
  });

  app.get("/goals", async () => {
    const goals = await listGoals(workspacePaths);
    const data = await Promise.all(
      goals.map(async (goal) => {
        const branches = await listBranches(workspacePaths, goal.id);
        return {
          goal,
          branch_count: branches.length,
          running_count: branches.filter((branch) => branch.status === "running").length,
          kept_count: branches.filter((branch) => branch.status === "kept").length
        };
      })
    );
    return { goals: data };
  });

  app.get("/goals/:goalId", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    try {
      const [goal, branches, workerRuns, steers, events, context, report] =
        await Promise.all([
          getGoal(workspacePaths, goalId),
          listBranches(workspacePaths, goalId),
          listWorkerRuns(workspacePaths, goalId),
          listSteers(workspacePaths, goalId),
          listEvents(workspacePaths, goalId),
          getContextBoard(workspacePaths, goalId),
          getReport(workspacePaths, goalId)
        ]);

      const branchDetails = await Promise.all(
        branches.map(async (branch) => ({
          branch,
          writeback: await getWriteback(workspacePaths, goalId, branch.id)
        }))
      );

      return {
        goal,
        branches: branchDetails,
        worker_runs: workerRuns,
        steers,
        context,
        report,
        events
      };
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  app.post("/goals", async (request, reply) => {
    const input = CreateGoalInputSchema.parse(request.body);
    const goal = createGoal(input);

    await saveGoal(workspacePaths, goal);
    await contextManager.initializeGoal(workspacePaths, goal);
    await appendEvent(
      workspacePaths,
      createEvent({
        goal_id: goal.id,
        type: "goal.created",
        payload: {
          title: goal.title,
          owner_id: goal.owner_id
        }
      })
    );

    return reply.code(201).send({ goal });
  });

  app.post("/goals/:goalId/plan", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    try {
      const goal = await getGoal(workspacePaths, goalId);
      const plan = generateInitialPlan(goal);

      await savePlanArtifacts(
        workspacePaths,
        goal.id,
        plan.planMarkdown,
        plan.branchSpecs,
        plan.evalSpec
      );

      await appendEvent(
        workspacePaths,
        createEvent({
          goal_id: goal.id,
          type: "plan.generated",
          payload: {
            branch_count: plan.branchSpecs.length,
            dimensions: plan.evalSpec.dimensions
          }
        })
      );

      return {
        goal_id: goal.id,
        branch_specs: plan.branchSpecs,
        eval_spec: plan.evalSpec
      };
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  app.post("/goals/:goalId/launch", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    try {
      let goal = await getGoal(workspacePaths, goalId);
      let plan = await getPlanArtifacts(workspacePaths, goalId);

      if (!plan) {
        const generated = generateInitialPlan(goal);
        await savePlanArtifacts(
          workspacePaths,
          goal.id,
          generated.planMarkdown,
          generated.branchSpecs,
          generated.evalSpec
        );
        plan = generated;
      }

      const existingBranches = await listBranches(workspacePaths, goal.id);
      if (existingBranches.length === 0) {
        for (const spec of plan.branchSpecs) {
          const branch = createBranch(goal.id, spec, "pending");
          const queuedBranch = updateBranch(branch, {
            status: "queued"
          });
          await saveBranch(workspacePaths, queuedBranch);
          await appendEvent(
            workspacePaths,
            createEvent({
              goal_id: goal.id,
              branch_id: queuedBranch.id,
              type: "branch.spawned",
              payload: {
                hypothesis: queuedBranch.hypothesis
              }
            })
          );
          await appendEvent(
            workspacePaths,
            createEvent({
              goal_id: goal.id,
              branch_id: queuedBranch.id,
              type: "branch.queued",
              payload: {
                reason: "goal.launch"
              }
            })
          );
        }
      }

      goal = updateGoal(goal, {
        status: "planned"
      });
      await saveGoal(workspacePaths, goal);

      return {
        goal,
        branch_count: (await listBranches(workspacePaths, goal.id)).length
      };
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  app.post("/goals/:goalId/steers", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const body = request.body as {
      content: string;
      scope?: "goal" | "branch" | "worker";
      branch_id?: string | null;
    };

    try {
      await getGoal(workspacePaths, goalId);
      const steer = createSteer({
        goal_id: goalId,
        branch_id: body.branch_id ?? null,
        scope: body.scope ?? "goal",
        content: body.content
      });
      await saveSteer(workspacePaths, steer);
      await appendEvent(
        workspacePaths,
        createEvent({
          goal_id: goalId,
          branch_id: steer.branch_id,
          type: "steer.queued",
          payload: {
            content: steer.content,
            scope: steer.scope
          }
        })
      );

      return reply.code(201).send({ steer });
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  app.post("/goals/:goalId/branches/:branchId/rerun", async (request, reply) => {
    const { goalId, branchId } = request.params as { goalId: string; branchId: string };

    try {
      const branch = await getBranch(workspacePaths, goalId, branchId);
      const queuedBranch = updateBranch(branch, {
        status: "queued",
        score: null,
        confidence: null
      });
      await saveBranch(workspacePaths, queuedBranch);
      await appendEvent(
        workspacePaths,
        createEvent({
          goal_id: goalId,
          branch_id: branchId,
          type: "branch.queued",
          payload: {
            rerun: true
          }
        })
      );

      return { branch: queuedBranch };
    } catch {
      return reply.code(404).send({ message: `Branch ${branchId} not found` });
    }
  });

  app.get("/goals/:goalId/report", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    try {
      await getGoal(workspacePaths, goalId);
      return {
        report: await getReport(workspacePaths, goalId)
      };
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  app.get("/goals/:goalId/context", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    try {
      await getGoal(workspacePaths, goalId);
      return {
        context: await getContextBoard(workspacePaths, goalId)
      };
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  async function lockWorkspaceRootOrThrowDetailed(workspaceRoot: string) {
    return await lockRunWorkspaceRoot(workspaceRoot, runWorkspaceScopePolicy);
  }

  async function lockWorkspaceRootOrThrow(workspaceRoot: string): Promise<string> {
    const lockedWorkspace = await lockWorkspaceRootOrThrowDetailed(workspaceRoot);
    return lockedWorkspace.resolvedRoot;
  }

  function describeWorkspaceScopeError(error: unknown): string {
    if (error instanceof RunWorkspaceScopeError) {
      return error.message;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  return app;
}

const port = Number(process.env.CONTROL_API_PORT ?? process.env.PORT ?? "8787");
const host = process.env.CONTROL_API_HOST ?? process.env.HOST ?? "127.0.0.1";

const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  buildServer({
    enableSelfRestart:
      process.env.AISA_CONTROL_API_ENABLE_SELF_RESTART === "1" ||
      process.env.AISA_CONTROL_API_SUPERVISED === "1"
  })
    .then((app) => app.listen({ port, host }))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

function readRestartExitCode(): number {
  const raw = process.env.AISA_CONTROL_API_RESTART_EXIT_CODE;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 75;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
