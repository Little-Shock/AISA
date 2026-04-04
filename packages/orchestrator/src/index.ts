import { createHash, randomUUID } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  createAttemptAdversarialVerification,
  createAttemptRuntimeState,
  createAttemptHandoffBundle,
  createAttempt,
  createAttemptContract,
  createAttemptPreflightEvaluation,
  createCurrentDecision,
  createRunAutomationControl,
  createEvent,
  createRunGovernanceState,
  createRunJournalEntry,
  createRunPolicyRuntime,
  createWorkerRun,
  finishWorkerRun,
  updateAttempt,
  updateAttemptRuntimeState,
  updateBranch,
  updateCurrentDecision,
  updateRunAutomationControl,
  updateGoal,
  updateRunGovernanceState,
  updateRunPolicyRuntime,
  updateRunSteer,
  updateSteer,
  resolveRunHarnessProfile,
  type Attempt,
  type AttemptAdversarialVerification,
  type AttemptContract,
  type AttemptContractDraft,
  type AttemptEvaluation,
  type AttemptEvaluationSynthesisRecord,
  type AttemptFailureContext,
  type AttemptHandoffBundle,
  type AttemptPreflightCheck,
  type AttemptPreflightFailureCode,
  type AttemptReviewInputPacket,
  type AttemptReviewInputRef,
  type AttemptReviewPacket,
  type AttemptReviewerOpinion,
  type AttemptRuntimeVerification,
  type Branch,
  type CurrentDecision,
  DEFAULT_EXECUTION_VERIFIER_KIT,
  resolveExecutionVerifierKit,
  type RunAutomationControl,
  type ExecutionVerificationPlan,
  type ExecutionVerifierKit,
  type EvalSpec,
  type Goal,
  type ReviewPacketArtifact,
  type Run,
  type RunGovernanceState,
  type RunPolicyRuntime,
  type VerificationCommand,
  type WorkerEffortLevel,
  type WorkerWriteback
} from "@autoresearch/domain";
import { appendEvent } from "@autoresearch/event-log";
import {
  createAttemptEvaluationSynthesizer,
  createAttemptReviewerAdapters,
  evaluateBranch,
  runAttemptReviewerPipeline as executeAttemptReviewerPipeline,
  synthesizeAttemptEvaluation,
  type AttemptEvaluationSynthesizerAdapter,
  type AttemptEvaluationSynthesizerConfig,
  type AttemptReviewerConfig,
  type AttemptReviewerAdapter
} from "@autoresearch/judge";
import { buildGoalReport } from "@autoresearch/report-builder";
import {
  appendRunJournal,
  getAttempt,
  getAttemptContract,
  getAttemptContext,
  getAttemptAdversarialVerification,
  getAttemptHandoffBundle,
  getAttemptHeartbeat,
  getAttemptEvaluation,
  getAttemptLogExcerpt,
  getAttemptEvaluationSynthesisRecord,
  getAttemptEvaluatorCalibrationSample,
  getAttemptReviewInputPacket,
  getAttemptReviewPacket,
  getAttemptResult,
  getAttemptPreflightEvaluation,
  getAttemptRuntimeState,
  getAttemptRuntimeVerification,
  getCurrentDecision,
  getBranch,
  getContextBoard,
  getEvalResult,
  getGoal,
  getPlanArtifacts,
  getRun,
  getRunAutomationControl,
  getRunGovernanceState,
  getRunPolicyRuntime,
  getRunRuntimeHealthSnapshot,
  listAttempts,
  listAttemptReviewOpinions,
  listRunJournal,
  getWriteback,
  listBranches,
  listGoals,
  listRuns,
  listRunSteers,
  listSteers,
  resolveAttemptPaths,
  resolveBranchArtifactPaths,
  resolveRunPaths,
  readRunPolicyRuntimeStrict,
  saveAttempt,
  saveAttemptContract,
  saveAttemptContext,
  saveAttemptAdversarialVerification,
  saveAttemptEvaluation,
  saveAttemptEvaluationSynthesisRecord,
  saveAttemptEvaluatorCalibrationSample,
  saveAttemptPreflightEvaluation,
  saveAttemptHeartbeat,
  saveAttemptHandoffBundle,
  saveAttemptReviewInputPacket,
  saveAttemptReviewOpinion,
  saveAttemptReviewPacket,
  saveAttemptResult,
  saveAttemptRuntimeState,
  saveBranch,
  saveCurrentDecision,
  saveEvalResult,
  saveGoal,
  saveReport,
  saveRun,
  saveRunAutomationControl,
  saveRunGovernanceState,
  saveRunPolicyRuntime,
  saveRunReport,
  saveRunSteer,
  saveSteer,
  saveWorkerRun,
  type WorkspacePaths
} from "@autoresearch/state-store";
import { ContextManager } from "@autoresearch/context-manager";
import {
  type WorkerAdapter,
  isWorkerWritebackParseError,
  resolveExecutionWorkerEffort,
  type ExecutionWorkerEffortSetting
} from "@autoresearch/worker-adapters";
import {
  captureAttemptCheckpointPreflight,
  maybeCreateVerifiedExecutionCheckpoint,
  type GitCheckpointPreflight,
  type AttemptCheckpointOutcome
} from "./git-checkpoint.js";
import {
  buildGovernanceSignature,
  buildGovernanceCheckpointContext,
  deriveRunGovernanceState,
  validateGovernedAttemptCandidate
} from "./governance.js";
import {
  detectLiveRuntimeSourceDrift,
  probeVerificationCommandReadiness,
  runAttemptRuntimeVerification,
  type AttemptRuntimeVerificationOutcome
} from "./runtime-verification.js";
import {
  maybePromoteVerifiedCheckpoint,
  type RuntimePromotionOutcome
} from "./runtime-promotion.js";
import { buildAttemptEvaluatorCalibrationSample } from "./evaluator-calibration.js";
import {
  assertAttemptWorkspaceWithinRunScope,
  createDefaultRunWorkspaceScopePolicy,
  lockRunWorkspaceRoot,
  RunWorkspaceScopeError,
  type RunWorkspaceScopePolicy
} from "./workspace-scope.js";
import {
  ensureRunManagedWorkspace,
  getEffectiveRunWorkspaceRoot
} from "./run-workspace.js";

export type RunRecoveryPath =
  | "first_attempt"
  | "latest_decision"
  | "handoff_first"
  | "degraded_rebuild";

export type RunRecoveryGuidance = {
  path: RunRecoveryPath;
  nextAction: string;
  attemptType: Attempt["attempt_type"];
  summary: string;
  blockingReason: string | null;
  handoffBundleRef: string | null;
};

function getDefaultRecoveryNextAction(input: {
  latestAttempt: Attempt;
  attemptType: Attempt["attempt_type"];
}): string {
  if (input.latestAttempt.status === "completed") {
    return input.attemptType === "execution"
      ? input.latestAttempt.attempt_type === "research"
        ? "start_execution"
        : "continue_execution"
      : "continue_research";
  }

  if (
    input.latestAttempt.attempt_type === "research" &&
    input.attemptType === "execution"
  ) {
    return "start_execution";
  }

  return "retry_attempt";
}

function buildDegradedRecoveryReason(
  current: CurrentDecision | null
): string {
  const degradedMessage =
    "最近一轮 settled attempt 没有 handoff bundle，所以恢复必须先走 degraded / rebuild path，不能再静默回退到多源拼装。";
  return [current?.blocking_reason, degradedMessage].filter(Boolean).join(" ");
}

export function deriveRunRecoveryGuidance(input: {
  current: CurrentDecision | null;
  latestAttempt: Attempt | null;
  latestHandoffBundle: AttemptHandoffBundle | null;
  latestHandoffBundleRef: string | null;
}): RunRecoveryGuidance {
  if (!input.latestAttempt) {
    return {
      path: "first_attempt",
      nextAction: "start_first_attempt",
      attemptType: "research",
      summary: "系统会重新启动首次研究。",
      blockingReason: input.current?.blocking_reason ?? null,
      handoffBundleRef: null
    };
  }

  const latestAttempt = input.latestAttempt;

  if (
    latestAttempt.status !== "completed" &&
    latestAttempt.status !== "failed" &&
    latestAttempt.status !== "stopped"
  ) {
    const attemptType =
      input.current?.recommended_attempt_type ?? latestAttempt.attempt_type;
    const nextAction =
      input.current?.recommended_next_action &&
      input.current.recommended_next_action !== "wait_for_human"
        ? input.current.recommended_next_action
        : attemptType === "execution"
          ? "continue_execution"
          : "continue_research";
    return {
      path: "latest_decision",
      nextAction,
      attemptType,
      summary: "系统会沿当前最新决策继续恢复。",
      blockingReason: input.current?.blocking_reason ?? null,
      handoffBundleRef: null
    };
  }

  if (!input.latestHandoffBundle) {
    return {
      path: "degraded_rebuild",
      nextAction: "continue_research",
      attemptType: "research",
      summary:
        "最近一轮 settled attempt 没有 handoff bundle，系统会先进入 degraded / rebuild path，再决定下一步执行。",
      blockingReason: buildDegradedRecoveryReason(input.current),
      handoffBundleRef: null
    };
  }

  const handoffAttemptType =
    input.latestHandoffBundle.recommended_attempt_type ??
    input.latestHandoffBundle.current_decision_snapshot?.recommended_attempt_type ??
    input.current?.recommended_attempt_type ??
    latestAttempt.attempt_type;
  const handoffNextActionCandidate =
    input.latestHandoffBundle.recommended_next_action &&
    input.latestHandoffBundle.recommended_next_action !== "wait_for_human"
      ? input.latestHandoffBundle.recommended_next_action
      : input.latestHandoffBundle.current_decision_snapshot?.recommended_next_action &&
          input.latestHandoffBundle.current_decision_snapshot.recommended_next_action !==
            "wait_for_human"
        ? input.latestHandoffBundle.current_decision_snapshot.recommended_next_action
        : null;

  return {
    path: "handoff_first",
    nextAction:
      handoffNextActionCandidate ??
      getDefaultRecoveryNextAction({
        latestAttempt,
        attemptType: handoffAttemptType
      }),
    attemptType: handoffAttemptType,
    summary:
      input.latestHandoffBundle.summary ??
      "系统会按最新 settled handoff bundle 继续恢复。",
    blockingReason:
      input.latestHandoffBundle.failure_context?.message ??
      input.latestHandoffBundle.current_decision_snapshot?.blocking_reason ??
      input.current?.blocking_reason ??
      null,
    handoffBundleRef: input.latestHandoffBundleRef
  };
}
import { type RuntimeLayout } from "./runtime-layout.js";
import {
  SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH,
  SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME,
  SELF_BOOTSTRAP_NEXT_TASK_SOURCE_ASSET_SNAPSHOT_FILE_NAME,
  assertSelfBootstrapNextTaskSourceAnchorMatchesPayload,
  loadSelfBootstrapNextTaskSourceAsset,
  loadSelfBootstrapNextTaskSourceAssetSnapshot,
  parseSelfBootstrapNextTaskActiveEntry,
  type SelfBootstrapNextTaskActiveEntry
} from "./self-bootstrap-next-task.js";
import { refreshRunOperatorSurface } from "./maintenance-plane.js";
import { readRunWorkingContextView } from "./working-context.js";
import {
  deriveFailureSignalFromAdversarialVerification,
  deriveFailureSignalFromPreflight,
  deriveFailureSignalFromRuntimeVerification
} from "./failure-policy.js";
import {
  describeRunHarnessGates as buildRunHarnessGatesView,
  type RunHarnessGatesView
} from "./gate-registry.js";
import {
  describeRunHarnessSlots as buildRunHarnessSlotsView,
  resolveRunHarnessSlotBinding,
  type RunHarnessSlotsView
} from "./slot-registry.js";
import {
  describeAttemptEffectiveVerifierKit as buildAttemptEffectiveVerifierKitView,
  describeExecutionVerifierKit as buildExecutionVerifierKitView,
  describeRunDefaultVerifierKit as buildRunDefaultVerifierKitView,
  executionVerifierKitAllowsWorkspaceScriptInference,
  getExecutionVerifierKitRegistryEntry,
  type ExecutionVerifierKitView
} from "./verifier-kit-registry.js";
import {
  describeRunEffectivePolicyBundle as buildRunEffectivePolicyBundleView,
  type RunEffectivePolicyBundleView
} from "./effective-policy-bundle.js";
import {
  appendResolvedRunMailboxEntry,
  buildRunMailboxThreadId,
  resolveOpenRunMailboxMessagesByType,
  resolveRunMailboxThread,
  upsertOpenRunMailboxEntry
} from "./run-mailbox.js";

export interface OrchestratorOptions {
  attemptHeartbeatIntervalMs?: number;
  attemptHeartbeatStaleMs?: number;
  maxConcurrentAttempts?: number;
  waitingHumanAutoResumeMs?: number;
  maxAutomaticResumeCycles?: number;
  providerRateLimitAutoResumeMs?: number;
  maxProviderRateLimitAutoResumeCycles?: number;
  workerStallAutoResumeMs?: number;
  runtimeSourceDriftAutoResumeMs?: number;
  runWorkspaceScopePolicy?: RunWorkspaceScopePolicy;
  reviewers?: AttemptReviewerAdapter[];
  reviewerConfigs?: AttemptReviewerConfig[];
  reviewerConfigEnv?: NodeJS.ProcessEnv;
  synthesizer?: AttemptEvaluationSynthesizerAdapter | null;
  synthesizerConfig?: AttemptEvaluationSynthesizerConfig | null;
  synthesizerConfigEnv?: NodeJS.ProcessEnv;
  requestRuntimeRestart?: (request: RuntimeRestartRequest) => Promise<void> | void;
  runtimeLayout?: RuntimeLayout | null;
}

export type RuntimeRestartRequest = {
  runId: string;
  attemptId: string;
  reason: "runtime_source_drift" | "runtime_promotion";
  affectedFiles: string[];
  message: string;
  promotedSha?: string | null;
};

export type RunWorkerEffortSlotView = {
  requested_effort: WorkerEffortLevel;
  default_effort: "medium";
  source: string;
  status: "applied" | "unsupported";
  applied: boolean;
  detail: string;
};

export type RunWorkerEffortView = {
  execution: ExecutionWorkerEffortSetting;
  reviewer: RunWorkerEffortSlotView;
  synthesizer: RunWorkerEffortSlotView;
};

const ADVERSARIAL_VERIFICATION_ARTIFACT_RELATIVE_PATH =
  "artifacts/adversarial-verification.json";

function buildVerifierKitFocusKeywords(verifierKit: ExecutionVerifierKit): string[] {
  switch (verifierKit) {
    case "web":
      return ["ui", "render", "browser", "playwright", "click", "screen", "interaction"];
    case "api":
      return ["api", "http", "endpoint", "response", "status", "request", "error"];
    case "cli":
      return ["cli", "flag", "stdout", "stderr", "argument", "exit", "command"];
    case "repo":
    default:
      return ["repo", "git", "workspace", "replay", "change"];
  }
}

function assessVerifierKitAdversarialFocus(input: {
  verifierKit: ExecutionVerifierKit;
  summary: string | null;
  checks: AttemptAdversarialVerification["checks"];
  commands: AttemptAdversarialVerification["commands"];
}): {
  ok: boolean;
  check: AttemptAdversarialVerification["checks"][number];
} {
  const registryEntry = getExecutionVerifierKitRegistryEntry(input.verifierKit);
  const keywords = buildVerifierKitFocusKeywords(input.verifierKit);
  const haystacks = [
    input.summary ?? "",
    ...input.checks.map(
      (check: AttemptAdversarialVerification["checks"][number]) =>
        `${check.code} ${check.message}`
    ),
    ...input.commands.map(
      (command: AttemptAdversarialVerification["commands"][number]) =>
        `${command.purpose} ${command.command}`
    )
  ]
    .join("\n")
    .toLowerCase();
  const matchedKeyword = keywords.find((keyword) => haystacks.includes(keyword));
  if (matchedKeyword) {
    return {
      ok: true,
      check: {
        code: "verifier_kit_focus_present",
        status: "passed",
        message: `${registryEntry.title} adversarial focus is grounded by keyword ${matchedKeyword}.`
      }
    };
  }

  return {
    ok: false,
    check: {
      code: "verifier_kit_focus_present",
      status: "failed",
      message: `${registryEntry.title} adversarial focus must mention one of: ${keywords.join(", ")}.`
    }
  };
}

type RunDispatchLeaseRecord = {
  version: 1;
  run_id: string;
  owner_id: string;
  owner_pid: number;
  purpose: string;
  acquired_at: string;
};

type RunDispatchLease = {
  release: () => Promise<void>;
};

class RunDispatchLeaseError extends Error {
  constructor(
    readonly code:
      | "stale_live_owner"
      | "invalid_lease_payload"
      | "lease_owner_mismatch",
    message: string
  ) {
    super(message);
    this.name = "RunDispatchLeaseError";
  }
}

const RUN_DISPATCH_LEASE_FILE_NAME = "run-dispatch-lease.json";

export type ExecutionVerificationToolchainAssessment = {
  verifier_kit: ExecutionVerifierKit | null;
  command_policy:
    | "workspace_script_inference"
    | "contract_locked_commands"
    | null;
  has_package_json: boolean;
  has_local_node_modules: boolean;
  inferred_pnpm_commands: string[];
  blocked_pnpm_commands: string[];
  unrunnable_verification_commands: Array<{
    purpose: string;
    command: string;
    cwd: string | null;
    reason: string;
  }>;
};

type AttemptDispatchPreflightOutcome = {
  dispatchableAttemptContract: AttemptContract;
  checkpointPreflight: GitCheckpointPreflight | null;
};

async function readWorkspacePackageScripts(
  workspaceRoot: string
): Promise<Record<string, string> | null> {
  const packageJsonPath = resolve(workspaceRoot, "package.json");

  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    return packageJson.scripts ?? {};
  } catch {
    return null;
  }
}

function buildDefaultExecutionVerificationCommandsFromScripts(
  scripts: Record<string, string>
): ExecutionVerificationPlan["commands"] {
  const commands: ExecutionVerificationPlan["commands"] = [];

  if (typeof scripts.typecheck === "string" && scripts.typecheck.length > 0) {
    commands.push({
      purpose: "typecheck the workspace after the change",
      command: "pnpm typecheck"
    });
  }

  if (typeof scripts["verify:runtime"] === "string" && scripts["verify:runtime"].length > 0) {
    commands.push({
      purpose: "replay the runtime regression suite after the change",
      command: "pnpm verify:runtime"
    });
  } else if (typeof scripts.test === "string" && scripts.test.length > 0) {
    commands.push({
      purpose: "run the workspace test suite after the change",
      command: "pnpm test"
    });
  } else if (typeof scripts.build === "string" && scripts.build.length > 0) {
    commands.push({
      purpose: "build the workspace after the change",
      command: "pnpm build"
    });
  }

  return commands;
}

async function workspaceHasLocalNodeModules(workspaceRoot: string): Promise<boolean> {
  try {
    return (await stat(resolve(workspaceRoot, "node_modules"))).isDirectory();
  } catch {
    return false;
  }
}

export async function assessExecutionVerificationToolchain(input: {
  workspaceRoot: string;
  verifierKit?: ExecutionVerifierKit | null;
  verificationPlan?: ExecutionVerificationPlan | null;
}): Promise<ExecutionVerificationToolchainAssessment> {
  const verifierKit = input.verifierKit ?? DEFAULT_EXECUTION_VERIFIER_KIT;
  const commandPolicy = executionVerifierKitAllowsWorkspaceScriptInference(verifierKit)
    ? "workspace_script_inference"
    : "contract_locked_commands";
  const scripts = await readWorkspacePackageScripts(input.workspaceRoot);
  const inferredCommands =
    scripts === null || commandPolicy !== "workspace_script_inference"
      ? []
      : buildDefaultExecutionVerificationCommandsFromScripts(scripts);
  const blockedPnpmCommands = (input.verificationPlan?.commands ?? [])
    .map((command: ExecutionVerificationPlan["commands"][number]) => command.command.trim())
    .filter((command: string) => command.startsWith("pnpm "));
  const hasLocalNodeModules = await workspaceHasLocalNodeModules(input.workspaceRoot);
  const unrunnableVerificationCommands = (
    await Promise.all(
      (input.verificationPlan?.commands ?? []).map(
        async (command: ExecutionVerificationPlan["commands"][number]) => {
          const readiness = await probeVerificationCommandReadiness({
            workspaceRoot: input.workspaceRoot,
            command
          });

          if (readiness.ok) {
            return null;
          }

          return {
            purpose: command.purpose,
            command: command.command,
            cwd: command.cwd ?? null,
            reason: readiness.reason
          };
        }
      )
    )
  ).filter(
    (entry): entry is NonNullable<ExecutionVerificationToolchainAssessment["unrunnable_verification_commands"][number]> =>
      entry !== null
  );

  return {
    verifier_kit: verifierKit,
    command_policy: commandPolicy,
    has_package_json: scripts !== null,
    has_local_node_modules: hasLocalNodeModules,
    inferred_pnpm_commands: inferredCommands.map(
      (command: ExecutionVerificationPlan["commands"][number]) => command.command
    ),
    blocked_pnpm_commands: blockedPnpmCommands,
    unrunnable_verification_commands: unrunnableVerificationCommands
  };
}

function formatVerificationCommands(commands: string[]): string {
  return commands.join(", ");
}

function isPostflightAdversarialGateRequired(run: Run): boolean {
  return resolveRunHarnessProfile(run).gates.postflight_adversarial.mode === "required";
}

function buildDefaultExecutionRequiredEvidence(
  postflightAdversarialGateRequired: boolean
): string[] {
  const requiredEvidence = [
    "Leave git-visible workspace changes tied to the objective.",
    "Leave artifacts that show what changed.",
    "Pass the replayable verification commands locked into this contract."
  ];

  if (postflightAdversarialGateRequired) {
    requiredEvidence.push(
      "Leave a machine-readable adversarial verification artifact after deterministic replay passes."
    );
  }

  return requiredEvidence;
}

function buildDefaultExecutionForbiddenShortcuts(
  postflightAdversarialGateRequired: boolean
): string[] {
  const forbiddenShortcuts = [
    "Do not claim success without replayable verification commands.",
    "Do not treat unchanged workspace state as a completed execution step."
  ];

  if (postflightAdversarialGateRequired) {
    forbiddenShortcuts.push(
      "Do not treat deterministic replay as the only verification layer for execution."
    );
  }

  return forbiddenShortcuts;
}

function buildDefaultExecutionExpectedArtifacts(
  postflightAdversarialGateRequired: boolean
): string[] {
  const expectedArtifacts = ["changed files visible in git status"];

  if (postflightAdversarialGateRequired) {
    expectedArtifacts.push("artifacts/adversarial-verification.json");
  }

  return expectedArtifacts;
}

function normalizeExecutionRequiredEvidence(
  requiredEvidence: string[],
  postflightAdversarialGateRequired: boolean
): string[] {
  const adversarialEvidence =
    "Leave a machine-readable adversarial verification artifact after deterministic replay passes.";
  const normalized = requiredEvidence.filter((item) => item !== adversarialEvidence);

  return postflightAdversarialGateRequired
    ? [...normalized, adversarialEvidence]
    : normalized;
}

function normalizeExecutionForbiddenShortcuts(
  forbiddenShortcuts: string[],
  postflightAdversarialGateRequired: boolean
): string[] {
  const adversarialShortcut =
    "Do not treat deterministic replay as the only verification layer for execution.";
  const normalized = forbiddenShortcuts.filter((item) => item !== adversarialShortcut);

  return postflightAdversarialGateRequired
    ? [...normalized, adversarialShortcut]
    : normalized;
}

function normalizeExecutionExpectedArtifacts(
  expectedArtifacts: string[],
  postflightAdversarialGateRequired: boolean
): string[] {
  const adversarialArtifact = "artifacts/adversarial-verification.json";
  const normalized = expectedArtifacts.filter((item) => item !== adversarialArtifact);

  return postflightAdversarialGateRequired
    ? [...normalized, adversarialArtifact]
    : normalized;
}

function buildDefaultExecutionDoneRubric(
  postflightAdversarialGateRequired = true
): AttemptContract["done_rubric"] {
  const doneRubric: AttemptContract["done_rubric"] = [
    {
      code: "git_change_recorded",
      description: "Leave a git-visible workspace change tied to the execution objective."
    },
    {
      code: "artifact_recorded",
      description: "Leave machine-readable artifacts that point at what changed."
    },
    {
      code: "verification_replay_passed",
      description: "Pass the replayable verification commands locked into this contract."
    }
  ];

  if (postflightAdversarialGateRequired) {
    doneRubric.push({
      code: "adversarial_verification_passed",
      description:
        "Leave a machine-readable adversarial verification artifact after deterministic replay passes."
    });
  }

  return doneRubric;
}

function normalizeExecutionDoneRubric(
  doneRubric: AttemptContract["done_rubric"],
  postflightAdversarialGateRequired: boolean
): AttemptContract["done_rubric"] {
  const normalized = doneRubric.filter(
    (item: AttemptContract["done_rubric"][number]) =>
      item.code !== "adversarial_verification_passed"
  );

  if (!postflightAdversarialGateRequired) {
    return normalized;
  }

  const adversarialItem = buildDefaultExecutionDoneRubric(true).find(
    (item: AttemptContract["done_rubric"][number]) =>
      item.code === "adversarial_verification_passed"
  );
  return adversarialItem ? [...normalized, adversarialItem] : normalized;
}

function buildDefaultExecutionFailureModes(
  postflightAdversarialGateRequired = true
): AttemptContract["failure_modes"] {
  const failureModes: AttemptContract["failure_modes"] = [
    {
      code: "missing_replayable_verification_plan",
      description: "Do not dispatch when attempt_contract.json has no replayable verification commands."
    },
    {
      code: "missing_local_verifier_toolchain",
      description: "Do not dispatch when pnpm replay depends on local node_modules that are missing."
    },
    {
      code: "unchanged_workspace_state",
      description: "Do not treat unchanged workspace state as a completed execution step."
    }
  ];

  if (postflightAdversarialGateRequired) {
    failureModes.push(
      {
        code: "missing_adversarial_verification_requirement",
        description:
          "Do not dispatch execution when attempt_contract.json does not explicitly require adversarial verification."
      },
      {
        code: "missing_adversarial_verification_artifact",
        description:
          "Do not treat execution as complete without a machine-readable adversarial verification artifact."
      }
    );
  }

  return failureModes;
}

function normalizeExecutionFailureModes(
  failureModes: AttemptContract["failure_modes"],
  postflightAdversarialGateRequired: boolean
): AttemptContract["failure_modes"] {
  const adversarialCodes = new Set([
    "missing_adversarial_verification_requirement",
    "missing_adversarial_verification_artifact"
  ]);
  const normalized = failureModes.filter(
    (item: AttemptContract["failure_modes"][number]) => !adversarialCodes.has(item.code)
  );

  if (!postflightAdversarialGateRequired) {
    return normalized;
  }

  const adversarialFailureModes = buildDefaultExecutionFailureModes(true).filter(
    (item: AttemptContract["failure_modes"][number]) => adversarialCodes.has(item.code)
  );
  return [...normalized, ...adversarialFailureModes];
}

function normalizeExecutionObjective(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[`"'“”‘’]/gu, "")
    .replace(/[^\p{L}\p{N}\/._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function executionObjectivesDescribeSameWork(
  plannedObjective: string | null | undefined,
  candidateObjective: string | null | undefined
): boolean {
  const planned = normalizeExecutionObjective(plannedObjective);
  const candidate = normalizeExecutionObjective(candidateObjective);
  if (planned.length === 0 || candidate.length === 0) {
    return false;
  }

  return planned === candidate || planned.includes(candidate) || candidate.includes(planned);
}

type ExecutionSteerIntent =
  | "preserve_existing_contract"
  | "replace_existing_contract"
  | "unspecified";

function classifyExecutionSteerIntent(steerMessages: string[]): ExecutionSteerIntent {
  const normalized = normalizeExecutionObjective(steerMessages.join("\n"));
  if (normalized.length === 0) {
    return "unspecified";
  }

  const replacePatterns = [
    /\b(switch|replace|change)\b/,
    /\bnew target\b/,
    /\bdo not reuse\b/,
    /\bdont reuse\b/,
    /\bdo not keep\b/,
    /\bstop using\b/,
    /切到新/,
    /切换/,
    /改成/,
    /不要再沿用/,
    /不要沿用/,
    /不要复用/
  ];
  if (replacePatterns.some((pattern) => pattern.test(normalized))) {
    return "replace_existing_contract";
  }

  const preservePatterns = [
    /\bretry the same\b/,
    /\bsame execution step\b/,
    /\bkeep the original\b/,
    /\bkeep original\b/,
    /\bkeep the existing\b/,
    /\bpreserve the contract\b/,
    /同一步/,
    /继续同一/,
    /保留原/,
    /沿用原/,
    /保留原有/,
    /保留现有/
  ];
  if (preservePatterns.some((pattern) => pattern.test(normalized))) {
    return "preserve_existing_contract";
  }

  return "unspecified";
}

function isExecutionContractDraft(
  contract: AttemptContractDraft | null | undefined
): contract is AttemptContractDraft {
  return contract?.attempt_type === "execution";
}

type RunPolicyProposal = {
  signature: string;
  attemptType: Attempt["attempt_type"];
  objective: string;
  successCriteria: string[];
  permissionProfile: RunPolicyRuntime["permission_profile"];
  hookPolicy: RunPolicyRuntime["hook_policy"];
  dangerMode: RunPolicyRuntime["danger_mode"];
  verifierKit: ExecutionVerifierKit | null;
  verificationCommands: string[];
  sourceAttemptId: string | null;
};

function buildRunPolicyProposal(input: {
  attemptType: Attempt["attempt_type"];
  objective: string;
  successCriteria: string[];
  verifierKit?: ExecutionVerifierKit | null;
  verificationCommands?: string[];
  sourceAttemptId?: string | null;
}): RunPolicyProposal {
  const verifierKit = input.verifierKit ?? null;
  const verificationCommands = input.verificationCommands ?? [];
  const permissionProfile =
    input.attemptType === "execution" ? "workspace_write" : "read_only";
  const hookPolicy =
    input.attemptType === "execution"
      ? "enforce_runtime_contract"
      : "not_required";
  const dangerMode = "forbid";

  return {
    signature: createHash("sha256")
      .update(
        JSON.stringify({
          attempt_type: input.attemptType,
          objective: input.objective,
          success_criteria: input.successCriteria,
          verifier_kit: verifierKit,
          verification_commands: verificationCommands,
          permission_profile: permissionProfile,
          hook_policy: hookPolicy,
          danger_mode: dangerMode
        })
      )
      .digest("hex")
      .slice(0, 20),
    attemptType: input.attemptType,
    objective: input.objective,
    successCriteria: input.successCriteria,
    permissionProfile,
    hookPolicy,
    dangerMode,
    verifierKit,
    verificationCommands,
    sourceAttemptId: input.sourceAttemptId ?? null
  };
}

function buildPendingApprovalSummary(proposal: RunPolicyProposal): string {
  return proposal.attemptType === "execution"
    ? "Execution plan is ready, but dispatch is blocked pending leader approval."
    : "Attempt plan is waiting for explicit approval.";
}

type DangerousVerificationCommandFinding = {
  command: string;
  rule: "destructive_git_reset" | "destructive_git_checkout" | "destructive_git_clean" | "destructive_rm";
};

const DANGEROUS_VERIFICATION_COMMAND_PATTERNS: Array<{
  rule: DangerousVerificationCommandFinding["rule"];
  pattern: RegExp;
}> = [
  {
    rule: "destructive_git_reset",
    pattern: /(^|[;&|]\s*)git\s+reset\s+--hard(\s|$)/i
  },
  {
    rule: "destructive_git_checkout",
    pattern: /(^|[;&|]\s*)git\s+checkout\s+--(\s|$)/i
  },
  {
    rule: "destructive_git_clean",
    pattern: /(^|[;&|]\s*)git\s+clean\s+-[^\n]*f/i
  },
  {
    rule: "destructive_rm",
    pattern: /(^|[;&|]\s*)rm\s+-rf(\s|$)/i
  }
];

function findDangerousVerificationCommand(
  commands: string[]
): DangerousVerificationCommandFinding | null {
  for (const command of commands) {
    const normalized = command.trim().replace(/\s+/g, " ");
    for (const candidate of DANGEROUS_VERIFICATION_COMMAND_PATTERNS) {
      if (candidate.pattern.test(normalized)) {
        return {
          command: normalized,
          rule: candidate.rule
        };
      }
    }
  }

  return null;
}

function buildDangerousVerificationCommandMessage(input: {
  proposal: RunPolicyProposal;
  finding: DangerousVerificationCommandFinding;
}): string {
  return [
    `Execution plan cannot enter approval because runtime replay includes a destructive command: ${input.finding.command}.`,
    "Rewrite the execution contract with replay-safe verification commands before requesting approval."
  ].join(" ");
}

export class Orchestrator {
  private timer: NodeJS.Timeout | null = null;
  private tickPromise: Promise<void> | null = null;
  private readonly activeBranches = new Set<string>();
  private readonly activeAttempts = new Set<string>();
  private readonly instanceId = `orch_${randomUUID().slice(0, 8)}`;
  private readonly attemptHeartbeatIntervalMs: number;
  private readonly attemptHeartbeatStaleMs: number;
  private readonly maxConcurrentAttempts: number;
  private readonly runDispatchLeaseStaleMs: number;
  private readonly waitingHumanAutoResumeMs: number;
  private readonly maxAutomaticResumeCycles: number;
  private readonly providerRateLimitAutoResumeMs: number;
  private readonly maxProviderRateLimitAutoResumeCycles: number;
  private readonly workerStallAutoResumeMs: number;
  private readonly runtimeSourceDriftAutoResumeMs: number;
  private readonly runWorkspaceScopePolicy: RunWorkspaceScopePolicy;
  private readonly reviewers: AttemptReviewerAdapter[];
  private readonly synthesizer: AttemptEvaluationSynthesizerAdapter;
  private readonly requestRuntimeRestart: ((
    request: RuntimeRestartRequest
  ) => Promise<void> | void) | null;
  private readonly runtimeLayout: RuntimeLayout;
  private readonly instanceStartedAtMs: number;

  constructor(
    private readonly workspacePaths: WorkspacePaths,
    private readonly adapter: WorkerAdapter,
    private readonly contextManager = new ContextManager(),
    private readonly pollIntervalMs = 1500,
    options: OrchestratorOptions = {}
  ) {
    this.attemptHeartbeatIntervalMs = options.attemptHeartbeatIntervalMs ?? 1000;
    this.attemptHeartbeatStaleMs = options.attemptHeartbeatStaleMs ?? 5000;
    this.maxConcurrentAttempts =
      options.maxConcurrentAttempts ??
      readPositiveIntegerEnv("AISA_MAX_CONCURRENT_ATTEMPTS", 3);
    this.runDispatchLeaseStaleMs = readPositiveIntegerEnv(
      "AISA_RUN_DISPATCH_LEASE_STALE_MS",
      60_000
    );
    this.waitingHumanAutoResumeMs =
      options.waitingHumanAutoResumeMs ??
      readPositiveIntegerEnv("AISA_WAITING_HUMAN_AUTO_RESUME_MS", 120_000);
    this.maxAutomaticResumeCycles =
      options.maxAutomaticResumeCycles ??
      readPositiveIntegerEnv("AISA_MAX_AUTOMATIC_RESUME_CYCLES", 3);
    this.providerRateLimitAutoResumeMs =
      options.providerRateLimitAutoResumeMs ??
      readPositiveIntegerEnv("AISA_PROVIDER_RATE_LIMIT_AUTO_RESUME_MS", 15_000);
    this.maxProviderRateLimitAutoResumeCycles =
      options.maxProviderRateLimitAutoResumeCycles ??
      readPositiveIntegerEnv("AISA_MAX_PROVIDER_RATE_LIMIT_AUTO_RESUME_CYCLES", 8);
    this.workerStallAutoResumeMs =
      options.workerStallAutoResumeMs ??
      readPositiveIntegerEnv("AISA_WORKER_STALL_AUTO_RESUME_MS", 5_000);
    this.runtimeSourceDriftAutoResumeMs =
      options.runtimeSourceDriftAutoResumeMs ??
      readPositiveIntegerEnv("AISA_RUNTIME_SOURCE_DRIFT_AUTO_RESUME_MS", 1_000);
    this.runWorkspaceScopePolicy =
      options.runWorkspaceScopePolicy ??
      createDefaultRunWorkspaceScopePolicy(this.workspacePaths.rootDir);
    if (options.reviewers && options.reviewerConfigs) {
      throw new Error("Orchestrator reviewer injection is ambiguous. Use reviewers or reviewerConfigs.");
    }
    if (options.synthesizer && options.synthesizerConfig) {
      throw new Error(
        "Orchestrator synthesizer injection is ambiguous. Use synthesizer or synthesizerConfig."
      );
    }
    if (options.reviewers && options.reviewers.length === 0) {
      throw new Error("Orchestrator reviewers cannot be an empty array.");
    }
    this.reviewers =
      options.reviewers && options.reviewers.length > 0
        ? options.reviewers
        : createAttemptReviewerAdapters({
            configs: options.reviewerConfigs,
            env: options.reviewerConfigEnv ?? process.env
          });
    this.synthesizer =
      options.synthesizer ??
      createAttemptEvaluationSynthesizer({
        config: options.synthesizerConfig,
        env: options.synthesizerConfigEnv ?? process.env
      });
    this.requestRuntimeRestart = options.requestRuntimeRestart ?? null;
    this.runtimeLayout =
      options.runtimeLayout ?? {
        repositoryRoot: this.workspacePaths.rootDir,
        runtimeRepoRoot: this.workspacePaths.rootDir,
        devRepoRoot: this.workspacePaths.rootDir,
        runtimeDataRoot: this.workspacePaths.rootDir,
        managedWorkspaceRoot: this.runWorkspaceScopePolicy.managedWorkspaceRoot
      };
    this.instanceStartedAtMs = Date.now();
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);

    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  describeRunWorkerEffort(run: Run): RunWorkerEffortView {
    const harnessProfile = resolveRunHarnessProfile(run);

    return {
      execution:
        this.adapter.resolveExecutionEffort?.({
          requestedEffort: harnessProfile.execution.effort,
          source: "run.harness_profile.execution.effort"
        }) ??
        resolveExecutionWorkerEffort({
          requestedEffort: harnessProfile.execution.effort,
          source: "run.harness_profile.execution.effort"
        }),
      reviewer: this.buildJudgeEffortView({
        requestedEffort: harnessProfile.reviewer.effort,
        source: "run.harness_profile.reviewer.effort",
        usesCliTransport: this.reviewers.some(
          (reviewer) => reviewer.reviewer.adapter !== "deterministic-heuristic"
        ),
        slot: "reviewer"
      }),
      synthesizer: this.buildJudgeEffortView({
        requestedEffort: harnessProfile.synthesizer.effort,
        source: "run.harness_profile.synthesizer.effort",
        usesCliTransport: this.synthesizer.kind === "cli",
        slot: "synthesizer"
      })
    };
  }

  describeRunHarnessGates(run: Run): RunHarnessGatesView {
    return buildRunHarnessGatesView(run);
  }

  describeRunHarnessSlots(run: Run): RunHarnessSlotsView {
    return buildRunHarnessSlotsView(run);
  }

  describeRunDefaultVerifierKit(run: Run): ExecutionVerifierKitView {
    return buildRunDefaultVerifierKitView(run);
  }

  describeRunEffectivePolicyBundle(run: Run): RunEffectivePolicyBundleView {
    return buildRunEffectivePolicyBundleView(run);
  }

  describeAttemptEffectiveVerifierKit(input: {
    attemptType: Attempt["attempt_type"];
    run: Run;
    attemptContract?: Pick<AttemptContract, "attempt_type" | "verifier_kit"> | null;
    runtimeVerification?: Pick<AttemptRuntimeVerification, "verifier_kit"> | null;
    adversarialVerification?: Pick<AttemptAdversarialVerification, "verifier_kit"> | null;
  }): ExecutionVerifierKitView | null {
    return buildAttemptEffectiveVerifierKitView({
      attemptType: input.attemptType,
      attemptContract: input.attemptContract,
      runtimeVerification: input.runtimeVerification,
      adversarialVerification: input.adversarialVerification,
      fallbackKit: resolveRunHarnessProfile(input.run).execution.default_verifier_kit
    });
  }

  private assertRunHarnessSlotBinding(input: {
    run: Run;
    slot: "research_or_planning" | "execution";
  }): void {
    const resolution = resolveRunHarnessSlotBinding({
      run: input.run,
      slot: input.slot,
      workerAdapterType: this.adapter.type
    });
    if (!resolution.ok) {
      throw new Error(resolution.failure_reason);
    }
  }

  async tick(): Promise<void> {
    if (this.tickPromise) {
      return await this.tickPromise;
    }

    this.tickPromise = this.tickInternal().finally(() => {
      this.tickPromise = null;
    });

    return await this.tickPromise;
  }

  private async tickInternal(): Promise<void> {
    const goals = await listGoals(this.workspacePaths);

    for (const goal of goals) {
      if (!["planned", "running", "reviewing"].includes(goal.status)) {
        continue;
      }

      const branches = await listBranches(this.workspacePaths, goal.id);
      const queuedBranches = branches.filter((branch) => branch.status === "queued");
      const runningCount = branches.filter((branch) => branch.status === "running").length;
      const availableSlots = Math.max(0, goal.budget.max_concurrency - runningCount);

      for (const branch of queuedBranches.slice(0, availableSlots)) {
        const activeKey = this.getActiveBranchKey(goal.id, branch.id);

        if (this.activeBranches.has(activeKey)) {
          continue;
        }

        this.activeBranches.add(activeKey);
        void this.executeBranch(goal.id, branch.id).finally(() => {
          this.activeBranches.delete(activeKey);
        });
      }
    }

    await this.tickRuns();
  }

  private buildJudgeEffortView(input: {
    requestedEffort: WorkerEffortLevel;
    source: string;
    usesCliTransport: boolean;
    slot: "reviewer" | "synthesizer";
  }): RunWorkerEffortSlotView {
    return {
      requested_effort: input.requestedEffort,
      default_effort: "medium",
      source: input.source,
      status: "unsupported",
      applied: false,
      detail: input.usesCliTransport
        ? `当前 ${input.slot} CLI 入口还没有标准化的原生 effort 透传。`
        : `当前 ${input.slot} 入口不是独立 CLI 模型调用，effort 只会保留为配置记录。`
    };
  }

  async executeBranch(goalId: string, branchId: string): Promise<void> {
    const goal = await getGoal(this.workspacePaths, goalId);
    let branch = await getBranch(this.workspacePaths, goalId, branchId);
    const plan = await getPlanArtifacts(this.workspacePaths, goalId);

    if (!plan) {
      throw new Error(`No plan artifacts found for goal ${goalId}`);
    }

    const queuedSteers = (await listSteers(this.workspacePaths, goalId)).filter(
      (steer) =>
        steer.status === "queued" &&
        (steer.scope === "goal" || steer.branch_id === branchId || steer.scope === "branch")
    );

    const snapshot = await this.contextManager.buildSnapshot({
      workspacePaths: this.workspacePaths,
      goal,
      branch,
      steers: queuedSteers
    });

    branch = updateBranch(branch, {
      status: "running",
      context_snapshot_id: snapshot.id
    });
    await saveBranch(this.workspacePaths, branch);
    await appendEvent(
      this.workspacePaths,
      createEvent({
        goal_id: goal.id,
        branch_id: branch.id,
        type: "worker.started",
        payload: {
          branch_id: branch.id,
          context_snapshot_id: snapshot.id
        }
      })
    );

    const artifactDir = resolveBranchArtifactPaths(
      this.workspacePaths,
      goal.id,
      branch.id
    ).branchDir;
    let run = createWorkerRun(
      goal.id,
      branch.id,
      this.adapter.type,
      {
        hypothesis: branch.hypothesis,
        objective: branch.objective,
        success_criteria: branch.success_criteria
      },
      artifactDir
    );

    await saveWorkerRun(this.workspacePaths, run);
    branch = updateBranch(branch, {
      latest_run_id: run.id
    });
    await saveBranch(this.workspacePaths, branch);

    try {
      if (!this.adapter.runBranchTask) {
        throw new Error(
          `Worker adapter ${this.adapter.type} does not support branch execution.`
        );
      }
      const execution = await this.adapter.runBranchTask({
        goal,
        branch,
        contextSnapshot: snapshot,
        workspacePaths: this.workspacePaths
      });

      run = finishWorkerRun(run, {
        state: "completed",
        writeback_file: resolveBranchArtifactPaths(
          this.workspacePaths,
          goal.id,
          branch.id
        ).writebackFile
      });
      await saveWorkerRun(this.workspacePaths, run);
      await appendEvent(
        this.workspacePaths,
        createEvent({
          goal_id: goal.id,
          branch_id: branch.id,
          run_id: run.id,
          type: "worker.finished",
          payload: {
            writeback_file: run.writeback_file
          }
        })
      );

      await this.contextManager.applyWriteback({
        workspacePaths: this.workspacePaths,
        goal,
        branch,
        writeback: execution.writeback
      });

      const evaluation = evaluateBranch({
        goal,
        branch,
        writeback: execution.writeback,
        evalSpec: plan.evalSpec as EvalSpec
      });
      await saveEvalResult(this.workspacePaths, evaluation);

      branch = updateBranch(branch, {
        status:
          evaluation.recommendation === "keep"
            ? "kept"
            : evaluation.recommendation === "rerun"
              ? "respawned"
              : "discarded",
        score: evaluation.score,
        confidence: evaluation.confidence
      });
      await saveBranch(this.workspacePaths, branch);

      for (const steer of queuedSteers) {
        await saveSteer(
          this.workspacePaths,
          updateSteer(steer, {
            status: "applied"
          })
        );
      }

      await appendEvent(
        this.workspacePaths,
        createEvent({
          goal_id: goal.id,
          branch_id: branch.id,
          run_id: run.id,
          type: "judge.completed",
          payload: {
            recommendation: evaluation.recommendation,
            score: evaluation.score
          }
        })
      );

      await this.completeGoalIfDone(goal.id);
      await this.refreshGoalReport(goal.id);
    } catch (error) {
      run = finishWorkerRun(run, {
        state: "failed"
      });
      await saveWorkerRun(this.workspacePaths, run);
      branch = updateBranch(branch, {
        status: "failed"
      });
      await saveBranch(this.workspacePaths, branch);
      await appendEvent(
        this.workspacePaths,
        createEvent({
          goal_id: goal.id,
          branch_id: branch.id,
          run_id: run.id,
          type: "worker.failed",
          payload: {
            message: error instanceof Error ? error.message : String(error)
          }
        })
      );
    }
  }

  async refreshGoalReport(goalId: string): Promise<string> {
    const goal = await getGoal(this.workspacePaths, goalId);
    const branches = await listBranches(this.workspacePaths, goalId);
    const contextBoard = await getContextBoard(this.workspacePaths, goalId);
    const writebacks = Object.fromEntries(
      await Promise.all(
        branches.map(async (branch) => [branch.id, await getWriteback(this.workspacePaths, goalId, branch.id)] as const)
      )
    );
    const evaluations = Object.fromEntries(
      await Promise.all(
        branches.map(async (branch) => [branch.id, await getEvalResult(this.workspacePaths, goalId, branch.id)] as const)
      )
    );

    const report = buildGoalReport({
      goal,
      branches,
      contextBoard,
      writebacks,
      evaluations
    });

    await saveReport(this.workspacePaths, goalId, report);
    await appendEvent(
      this.workspacePaths,
      createEvent({
        goal_id: goalId,
        type: "report.updated",
        payload: {
          branch_count: branches.length
        }
      })
    );

    return report;
  }

  private async completeGoalIfDone(goalId: string): Promise<void> {
    const goal = await getGoal(this.workspacePaths, goalId);
    const branches = await listBranches(this.workspacePaths, goalId);

    if (
      branches.length > 0 &&
      branches.every((branch) =>
        ["kept", "discarded", "respawned", "failed", "stopped"].includes(branch.status)
      )
    ) {
      const nextStatus: Goal["status"] = branches.some((branch) => branch.status === "kept")
        ? "completed"
        : "failed";

      await saveGoal(
        this.workspacePaths,
        updateGoal(goal, {
          status: nextStatus
        })
      );
      await appendEvent(
        this.workspacePaths,
        createEvent({
          goal_id: goalId,
          type: "goal.completed",
          payload: {
            status: nextStatus
          }
        })
      );
    } else if (goal.status !== "running") {
      await saveGoal(
        this.workspacePaths,
        updateGoal(goal, {
          status: "running"
        })
      );
    }
  }

  private getActiveBranchKey(goalId: string, branchId: string): string {
    return `${goalId}:${branchId}`;
  }

  private async loadRunAutomationControl(runId: string): Promise<RunAutomationControl> {
    return (
      (await getRunAutomationControl(this.workspacePaths, runId)) ??
      createRunAutomationControl({
        run_id: runId
      })
    );
  }

  private async persistManualOnlyRunAutomation(input: {
    runId: string;
    reasonCode:
      | "superseded_self_bootstrap_run"
      | "automatic_resume_blocked"
      | "automatic_resume_exhausted"
      | "manual_recovery";
    reason: string;
    imposedBy: string;
    activeRunId?: string | null;
    failureCode?: string | null;
  }): Promise<RunAutomationControl> {
    const currentControl = await this.loadRunAutomationControl(input.runId);
    const nextControl = updateRunAutomationControl(currentControl, {
      mode: "manual_only",
      reason_code: input.reasonCode,
      reason: input.reason,
      imposed_by: input.imposedBy,
      active_run_id: input.activeRunId ?? null,
      failure_code: input.failureCode ?? null
    });
    await saveRunAutomationControl(this.workspacePaths, nextControl);
    return nextControl;
  }

  private async enforceManualOnlyRunGate(
    runId: string,
    current: CurrentDecision,
    automation: RunAutomationControl
  ): Promise<void> {
    if (automation.mode !== "manual_only" || current.run_status !== "running") {
      return;
    }

    const message =
      automation.reason ??
      "This run is in manual-only mode. Launch or queue steer before it can continue.";
    await saveCurrentDecision(
      this.workspacePaths,
      updateCurrentDecision(current, {
        run_status: "waiting_steer",
        recommended_next_action: "wait_for_human",
        summary: message,
        blocking_reason: message,
        waiting_for_human: true
      })
    );
    await refreshRunOperatorSurface(this.workspacePaths, runId);
  }

  private async tickRuns(): Promise<void> {
    const runs = await listRuns(this.workspacePaths);

    for (const persistedRun of runs) {
      let run = persistedRun;
      const [current, automation] = await Promise.all([
        getCurrentDecision(this.workspacePaths, run.id),
        this.loadRunAutomationControl(run.id)
      ]);
      const attempts = await listAttempts(this.workspacePaths, run.id);
      await this.ensureSettledAttemptReviewPackets(run.id, current, attempts);

      if (!current) {
        continue;
      }

      try {
        const ensuredRun = await this.ensureRunWorkspaceReady(run);
        if (
          ensuredRun.workspace_root !== run.workspace_root ||
          ensuredRun.managed_workspace_root !== run.managed_workspace_root
        ) {
          run = ensuredRun;
          await saveRun(this.workspacePaths, run);
        }
      } catch (error) {
        if (error instanceof RunWorkspaceScopeError) {
          await this.persistRunWorkspaceScopeBlocked(run, current, error);
          continue;
        }

        throw error;
      }

      const workspaceScopeError = await this.getRunWorkspaceScopeError(run);
      if (workspaceScopeError) {
        await this.persistRunWorkspaceScopeBlocked(run, current, workspaceScopeError);
        continue;
      }

      if (automation.mode === "manual_only") {
        await this.enforceManualOnlyRunGate(run.id, current, automation);
        continue;
      }

      if (current.waiting_for_human) {
        await this.maybeAutoResumeWaitingRun(run.id, current, attempts);
        continue;
      }

      if (current.run_status !== "running") {
        continue;
      }

      const runningAttempt = attempts.find((attempt) => attempt.status === "running");

      if (runningAttempt) {
        const activeKey = this.getActiveAttemptKey(run.id, runningAttempt.id);

        if (!this.activeAttempts.has(activeKey)) {
          if (await this.isAttemptHeartbeatFresh(run.id, runningAttempt.id)) {
            continue;
          }

          const refreshedAttempt = await getAttempt(
            this.workspacePaths,
            run.id,
            runningAttempt.id
          );
          if (refreshedAttempt.status !== "running") {
            continue;
          }
          if (await this.isAttemptHeartbeatFresh(run.id, runningAttempt.id)) {
            continue;
          }

          await this.recoverRunningAttempt(run.id, refreshedAttempt.id);
        }
        continue;
      }

      const pendingAttempt = attempts.find((attempt) =>
        ["created", "queued"].includes(attempt.status)
      );

      if (pendingAttempt) {
        if (this.activeAttempts.size >= this.maxConcurrentAttempts) {
          continue;
        }
        const alignedAttempt = await this.ensureAttemptUsesRunWorkspace(
          run,
          pendingAttempt
        );
        const activeKey = this.getActiveAttemptKey(run.id, pendingAttempt.id);
        if (!this.activeAttempts.has(activeKey)) {
          this.activeAttempts.add(activeKey);
          void this.executeAttempt(run.id, alignedAttempt.id).finally(() => {
            this.activeAttempts.delete(activeKey);
          });
        }
        continue;
      }

      if (this.hasActiveAttemptForRun(run.id)) {
        continue;
      }

      if (this.activeAttempts.size >= this.maxConcurrentAttempts) {
        continue;
      }

      await this.createNextAttemptIfNeeded(run.id);
    }
  }

  private async recoverRunningAttempt(
    runId: string,
    attemptId: string
  ): Promise<void> {
    await this.withRunDispatchLease(runId, "recover_running_attempt", async () => {
      const [attempt, current] = await Promise.all([
        getAttempt(this.workspacePaths, runId, attemptId),
        getCurrentDecision(this.workspacePaths, runId)
      ]);
      if (attempt.status !== "running") {
        return;
      }

      const message =
        `尝试 ${attempt.id} 在编排器恢复时仍被标记为运行中。` +
        "会先短暂等待人工接管，超时后自动恢复。";
      const stoppedAttempt = updateAttempt(attempt, {
        status: "stopped",
        ended_at: new Date().toISOString()
      });
      const nextCurrent = updateCurrentDecision(
        current ?? createCurrentDecision({ run_id: runId }),
        {
          run_status: "waiting_steer",
          latest_attempt_id: attempt.id,
          recommended_next_action: "wait_for_human",
          recommended_attempt_type: attempt.attempt_type,
          summary: message,
          blocking_reason: message,
          waiting_for_human: true
        }
      );

      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: attempt.id,
          type: "attempt.recovery_required",
          payload: {
            previous_status: attempt.status,
            recovery_policy: "auto_resume_after_human_window"
          }
        })
      );
      await this.saveSettledAttemptState({
        runId,
        attempt: stoppedAttempt,
        currentSnapshot: nextCurrent
      });
    });
  }

  private async persistRunPolicyPlanning(runId: string): Promise<void> {
    const policyGate = await this.readRunPolicyGate({
      runId
    });
    if (policyGate.status === "invalid") {
      return;
    }

    const existingPolicy =
      policyGate.status === "ready" ? policyGate.policy : null;
    if (
      existingPolicy?.approval_required === true &&
      existingPolicy.approval_status === "approved" &&
      existingPolicy.proposed_attempt_type === "execution"
    ) {
      return;
    }

    const nextPolicy = existingPolicy
      ? updateRunPolicyRuntime(existingPolicy, {
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
      : createRunPolicyRuntime({
          run_id: runId,
          stage: "planning",
          last_decision: "planning"
        });

    await saveRunPolicyRuntime(this.workspacePaths, nextPolicy);
  }

  private buildRunPolicySourceRef(
    runId: string,
    sourceAttemptId: string | null
  ): string | null {
    if (!sourceAttemptId) {
      return null;
    }

    return this.buildAttemptResultRef(runId, sourceAttemptId);
  }

  private async persistRunPolicyReadyForDispatch(input: {
    runId: string;
    proposal: RunPolicyProposal;
  }): Promise<void> {
    const existingPolicy = await getRunPolicyRuntime(this.workspacePaths, input.runId);
    const approvalRequired = input.proposal.attemptType === "execution";
    const sourceRef = this.buildRunPolicySourceRef(
      input.runId,
      input.proposal.sourceAttemptId
    );
    const nextPolicy = existingPolicy
      ? updateRunPolicyRuntime(existingPolicy, {
          stage: "execution",
          approval_status:
            approvalRequired && existingPolicy.approval_status === "approved"
              ? "approved"
              : "not_required",
          approval_required: approvalRequired,
          proposed_signature: input.proposal.signature,
          proposed_attempt_type: input.proposal.attemptType,
          proposed_objective: input.proposal.objective,
          proposed_success_criteria: input.proposal.successCriteria,
          permission_profile: input.proposal.permissionProfile,
          hook_policy: input.proposal.hookPolicy,
          danger_mode: input.proposal.dangerMode,
          blocking_reason: null,
          last_decision: "dispatch_ready",
          source_attempt_id: input.proposal.sourceAttemptId,
          source_ref: sourceRef
        })
      : createRunPolicyRuntime({
          run_id: input.runId,
          stage: "execution",
          approval_status: approvalRequired ? "approved" : "not_required",
          approval_required: approvalRequired,
          proposed_signature: input.proposal.signature,
          proposed_attempt_type: input.proposal.attemptType,
          proposed_objective: input.proposal.objective,
          proposed_success_criteria: input.proposal.successCriteria,
          permission_profile: input.proposal.permissionProfile,
          hook_policy: input.proposal.hookPolicy,
          danger_mode: input.proposal.dangerMode,
          last_decision: "dispatch_ready",
          source_attempt_id: input.proposal.sourceAttemptId,
          source_ref: sourceRef
        });

    await saveRunPolicyRuntime(this.workspacePaths, nextPolicy);
  }

  private async appendRunPolicyHookEvaluation(input: {
    runId: string;
    proposal: RunPolicyProposal;
    hookKey: string;
    hookStatus: "passed" | "failed";
    message: string;
    evidenceRef?: string | null;
    dangerousCommand?: string | null;
  }): Promise<void> {
    const journal = await listRunJournal(this.workspacePaths, input.runId);
    const latestEntry = journal.at(-1);
    if (
      latestEntry?.type === "run.policy.hook_evaluated" &&
      latestEntry.payload.proposed_signature === input.proposal.signature &&
      latestEntry.payload.hook_key === input.hookKey &&
      latestEntry.payload.hook_status === input.hookStatus
    ) {
      return;
    }

    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: input.runId,
        attempt_id: input.proposal.sourceAttemptId,
        type: "run.policy.hook_evaluated",
        payload: {
          proposed_signature: input.proposal.signature,
          attempt_type: input.proposal.attemptType,
          objective: input.proposal.objective,
          verifier_kit: input.proposal.verifierKit,
          verification_commands: input.proposal.verificationCommands,
          permission_profile: input.proposal.permissionProfile,
          hook_policy: input.proposal.hookPolicy,
          danger_mode: input.proposal.dangerMode,
          hook_key: input.hookKey,
          hook_status: input.hookStatus,
          message: input.message,
          evidence_ref: input.evidenceRef ?? null,
          dangerous_command: input.dangerousCommand ?? null,
          source_ref: this.buildRunPolicySourceRef(
            input.runId,
            input.proposal.sourceAttemptId
          )
        }
      })
    );
  }

  private async readRunPolicyGate(input: {
    runId: string;
  }): Promise<
    | { status: "missing" }
    | { status: "ready"; policy: RunPolicyRuntime }
    | { status: "invalid"; message: string }
  > {
    try {
      return {
        status: "ready",
        policy: await readRunPolicyRuntimeStrict(this.workspacePaths, input.runId)
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        return {
          status: "missing"
        };
      }

      return {
        status: "invalid",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async persistRunPolicyApprovalRequested(input: {
    runId: string;
    current: CurrentDecision;
    proposal: RunPolicyProposal;
  }): Promise<void> {
    const existingPolicy = await getRunPolicyRuntime(this.workspacePaths, input.runId);
    const now = new Date().toISOString();
    const message = buildPendingApprovalSummary(input.proposal);
    const sourceRef = this.buildRunPolicySourceRef(
      input.runId,
      input.proposal.sourceAttemptId
    );
    const nextPolicy = existingPolicy
      ? updateRunPolicyRuntime(existingPolicy, {
          stage: "approval",
          approval_status: "pending",
          approval_required: true,
          proposed_signature: input.proposal.signature,
          proposed_attempt_type: input.proposal.attemptType,
          proposed_objective: input.proposal.objective,
          proposed_success_criteria: input.proposal.successCriteria,
          permission_profile: input.proposal.permissionProfile,
          hook_policy: input.proposal.hookPolicy,
          danger_mode: input.proposal.dangerMode,
          blocking_reason: message,
          last_decision: "approval_requested",
          approval_requested_at:
            existingPolicy.proposed_signature === input.proposal.signature &&
            existingPolicy.approval_status === "pending"
              ? existingPolicy.approval_requested_at ?? now
              : now,
          approval_decided_at: null,
          approval_actor: null,
          approval_note: null,
          source_attempt_id: input.proposal.sourceAttemptId,
          source_ref: sourceRef
        })
      : createRunPolicyRuntime({
          run_id: input.runId,
          stage: "approval",
          approval_status: "pending",
          approval_required: true,
          proposed_signature: input.proposal.signature,
          proposed_attempt_type: input.proposal.attemptType,
          proposed_objective: input.proposal.objective,
          proposed_success_criteria: input.proposal.successCriteria,
          permission_profile: input.proposal.permissionProfile,
          hook_policy: input.proposal.hookPolicy,
          danger_mode: input.proposal.dangerMode,
          blocking_reason: message,
          last_decision: "approval_requested",
          approval_requested_at: now,
          source_attempt_id: input.proposal.sourceAttemptId,
          source_ref: sourceRef
        });

    await saveRunPolicyRuntime(this.workspacePaths, nextPolicy);
    await upsertOpenRunMailboxEntry({
      paths: this.workspacePaths,
      runId: input.runId,
      threadId: buildRunMailboxThreadId({
        kind: "approval",
        value: input.proposal.signature
      }),
      messageType: "approval_request",
      fromSlot: "research_or_planning",
      toSlotOrActor: "operator",
      requiredAction: "approve_execution_plan",
      summary: message,
      sourceRef,
      sourceAttemptId: input.proposal.sourceAttemptId
    });
    await this.appendRunPolicyHookEvaluation({
      runId: input.runId,
      proposal: input.proposal,
      hookKey: "dangerous_verification_commands",
      hookStatus: "passed",
      message: "Replay commands passed the destructive command guard.",
      evidenceRef: sourceRef
    });

    const nextCurrent = updateCurrentDecision(input.current, {
      run_status: "waiting_steer",
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: input.proposal.attemptType,
      summary: message,
      blocking_reason: message,
      waiting_for_human: true
    });

    const currentAlreadyBlocked =
      input.current.run_status === nextCurrent.run_status &&
      input.current.recommended_next_action ===
        nextCurrent.recommended_next_action &&
      input.current.summary === nextCurrent.summary &&
      input.current.blocking_reason === nextCurrent.blocking_reason &&
      input.current.waiting_for_human === nextCurrent.waiting_for_human;

    if (!currentAlreadyBlocked) {
      await saveCurrentDecision(this.workspacePaths, nextCurrent);
    }

    const journal = await listRunJournal(this.workspacePaths, input.runId);
    const latestEntry = journal.at(-1);
    if (
      latestEntry?.type !== "run.policy.approval_requested" ||
      latestEntry.payload.proposed_signature !== input.proposal.signature
    ) {
      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: input.runId,
          attempt_id: input.proposal.sourceAttemptId,
          type: "run.policy.approval_requested",
          payload: {
            proposed_signature: input.proposal.signature,
            attempt_type: input.proposal.attemptType,
            objective: input.proposal.objective,
            verifier_kit: input.proposal.verifierKit,
            verification_commands: input.proposal.verificationCommands,
            permission_profile: input.proposal.permissionProfile,
            hook_policy: input.proposal.hookPolicy,
            danger_mode: input.proposal.dangerMode,
            source_ref: sourceRef
          }
        })
      );
    }

    await refreshRunOperatorSurface(this.workspacePaths, input.runId);
  }

  private async persistRunPolicyDangerousRuleBlocked(input: {
    runId: string;
    current: CurrentDecision;
    proposal: RunPolicyProposal;
    message: string;
    dangerousCommand: string;
  }): Promise<void> {
    const sourceRef = this.buildRunPolicySourceRef(
      input.runId,
      input.proposal.sourceAttemptId
    );
    const now = new Date().toISOString();
    const existingPolicy = await getRunPolicyRuntime(this.workspacePaths, input.runId);
    const nextPolicy = existingPolicy
      ? updateRunPolicyRuntime(existingPolicy, {
          stage: "approval",
          approval_status: "rejected",
          approval_required: true,
          proposed_signature: input.proposal.signature,
          proposed_attempt_type: input.proposal.attemptType,
          proposed_objective: input.proposal.objective,
          proposed_success_criteria: input.proposal.successCriteria,
          permission_profile: input.proposal.permissionProfile,
          hook_policy: input.proposal.hookPolicy,
          danger_mode: "manual_only",
          blocking_reason: input.message,
          last_decision: "dangerous_rule_blocked",
          approval_requested_at: null,
          approval_decided_at: now,
          approval_actor: "policy-runtime",
          approval_note: input.message,
          source_attempt_id: input.proposal.sourceAttemptId,
          source_ref: sourceRef
        })
      : createRunPolicyRuntime({
          run_id: input.runId,
          stage: "approval",
          approval_status: "rejected",
          approval_required: true,
          proposed_signature: input.proposal.signature,
          proposed_attempt_type: input.proposal.attemptType,
          proposed_objective: input.proposal.objective,
          proposed_success_criteria: input.proposal.successCriteria,
          permission_profile: input.proposal.permissionProfile,
          hook_policy: input.proposal.hookPolicy,
          danger_mode: "manual_only",
          blocking_reason: input.message,
          last_decision: "dangerous_rule_blocked",
          approval_decided_at: now,
          approval_actor: "policy-runtime",
          approval_note: input.message,
          source_attempt_id: input.proposal.sourceAttemptId,
          source_ref: sourceRef
        });
    await saveRunPolicyRuntime(this.workspacePaths, nextPolicy);
    const approvalThreadId = buildRunMailboxThreadId({
      kind: "approval",
      value: input.proposal.signature
    });
    await resolveRunMailboxThread({
      paths: this.workspacePaths,
      runId: input.runId,
      threadId: approvalThreadId,
      resolutionSummary: input.message,
      sourceRef
    });
    await appendResolvedRunMailboxEntry({
      paths: this.workspacePaths,
      runId: input.runId,
      threadId: approvalThreadId,
      messageType: "approval_resolution",
      toSlotOrActor: "research_or_planning",
      summary: input.message,
      requiredAction: "replan_execution",
      sourceRef,
      sourceAttemptId: input.proposal.sourceAttemptId
    });
    await this.appendRunPolicyHookEvaluation({
      runId: input.runId,
      proposal: input.proposal,
      hookKey: "dangerous_verification_commands",
      hookStatus: "failed",
      message: input.message,
      evidenceRef: sourceRef,
      dangerousCommand: input.dangerousCommand
    });

    const nextCurrent = updateCurrentDecision(input.current, {
      run_status: "waiting_steer",
      recommended_next_action: "continue_research",
      recommended_attempt_type: "research",
      summary: input.message,
      blocking_reason: input.message,
      waiting_for_human: true
    });
    await saveCurrentDecision(this.workspacePaths, nextCurrent);
    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: input.runId,
        attempt_id: input.proposal.sourceAttemptId,
        type: "run.policy.rejected",
        payload: {
          actor: "policy-runtime",
          note: input.message,
          proposed_signature: input.proposal.signature,
          permission_profile: input.proposal.permissionProfile,
          hook_policy: input.proposal.hookPolicy,
          danger_mode: "manual_only",
          source_ref: sourceRef
        }
      })
    );
    await refreshRunOperatorSurface(this.workspacePaths, input.runId);
  }

  private async persistRunPolicyDispatchBlocked(input: {
    runId: string;
    current: CurrentDecision;
    policy: RunPolicyRuntime | null;
    proposal: RunPolicyProposal;
    message: string;
    reason: string;
  }): Promise<void> {
    const sourceRef = this.buildRunPolicySourceRef(
      input.runId,
      input.proposal.sourceAttemptId
    );
    if (input.policy) {
      await saveRunPolicyRuntime(
        this.workspacePaths,
        updateRunPolicyRuntime(input.policy, {
          blocking_reason: input.message,
          last_decision: "dispatch_blocked"
        })
      );
    }
    await upsertOpenRunMailboxEntry({
      paths: this.workspacePaths,
      runId: input.runId,
      threadId: buildRunMailboxThreadId({
        kind: "dispatch_blocked",
        value: `${input.proposal.signature}:${input.reason}`
      }),
      messageType: "dispatch_blocked",
      toSlotOrActor: "operator",
      requiredAction: "review_dispatch_blocker",
      summary: input.message,
      sourceRef,
      sourceAttemptId: input.proposal.sourceAttemptId
    });

    const nextCurrent = updateCurrentDecision(input.current, {
      run_status: "waiting_steer",
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: input.proposal.attemptType,
      summary: input.message,
      blocking_reason: input.message,
      waiting_for_human: true
    });

    const currentAlreadyBlocked =
      input.current.run_status === nextCurrent.run_status &&
      input.current.recommended_next_action ===
        nextCurrent.recommended_next_action &&
      input.current.summary === nextCurrent.summary &&
      input.current.blocking_reason === nextCurrent.blocking_reason &&
      input.current.waiting_for_human === nextCurrent.waiting_for_human;

    if (!currentAlreadyBlocked) {
      await saveCurrentDecision(this.workspacePaths, nextCurrent);
    }

    const journal = await listRunJournal(this.workspacePaths, input.runId);
    const latestEntry = journal.at(-1);
    if (
      latestEntry?.type !== "run.policy.dispatch_blocked" ||
      latestEntry.payload.message !== input.message
    ) {
      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: input.runId,
          attempt_id: input.proposal.sourceAttemptId,
          type: "run.policy.dispatch_blocked",
          payload: {
            reason: input.reason,
            message: input.message,
            proposed_signature: input.proposal.signature,
            attempt_type: input.proposal.attemptType,
            verifier_kit: input.proposal.verifierKit,
            verification_commands: input.proposal.verificationCommands,
            permission_profile: input.proposal.permissionProfile,
            hook_policy: input.proposal.hookPolicy,
            danger_mode: input.proposal.dangerMode,
            source_ref: sourceRef
          }
        })
      );
    }

    await refreshRunOperatorSurface(this.workspacePaths, input.runId);
  }

  private async createNextAttemptIfNeeded(runId: string): Promise<void> {
    await this.withRunDispatchLease(runId, "plan_next_attempt", async () => {
      const [run, current, attempts] = await Promise.all([
        getRun(this.workspacePaths, runId),
        getCurrentDecision(this.workspacePaths, runId),
        listAttempts(this.workspacePaths, runId)
      ]);
      if (!current || current.waiting_for_human || current.run_status !== "running") {
        return;
      }

      if (attempts.some((attempt) => ["created", "queued", "running"].includes(attempt.status))) {
        return;
      }

      if (this.hasActiveAttemptForRun(runId)) {
        return;
      }

      await this.persistRunPolicyPlanning(run.id);

      let nextAttempt:
        | { attempt: Attempt; contract: AttemptContract; proposal: RunPolicyProposal }
        | null;
      try {
        nextAttempt = await this.planNextAttempt(runId, current, attempts);
      } catch (error) {
        await this.persistRunPlanningBlocked(run.id, current, error);
        return;
      }
      if (!nextAttempt) {
        return;
      }

      await saveAttempt(this.workspacePaths, nextAttempt.attempt);
      await saveAttemptContract(this.workspacePaths, nextAttempt.contract);
      await this.persistRunPolicyReadyForDispatch({
        runId: run.id,
        proposal: nextAttempt.proposal
      });
      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: run.id,
          attempt_id: nextAttempt.attempt.id,
          type: "attempt.created",
          payload: {
            attempt_type: nextAttempt.attempt.attempt_type,
            objective: nextAttempt.attempt.objective
          }
        })
      );
      await refreshRunOperatorSurface(this.workspacePaths, run.id);
    });
  }

  private async persistRunPlanningBlocked(
    runId: string,
    current: CurrentDecision,
    error: unknown
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const nextCurrent = updateCurrentDecision(current, {
      run_status: "waiting_steer",
      recommended_next_action: "wait_for_human",
      summary: message,
      blocking_reason: message,
      waiting_for_human: true
    });

    const currentAlreadyBlocked =
      current.run_status === nextCurrent.run_status &&
      current.recommended_next_action === nextCurrent.recommended_next_action &&
      current.summary === nextCurrent.summary &&
      current.blocking_reason === nextCurrent.blocking_reason &&
      current.waiting_for_human === nextCurrent.waiting_for_human;

    if (!currentAlreadyBlocked) {
      await saveCurrentDecision(this.workspacePaths, nextCurrent);
    }

    const journal = await listRunJournal(this.workspacePaths, runId);
    const latestEntry = journal.at(-1);
    if (
      latestEntry?.type === "run.planning.blocked" &&
      latestEntry.attempt_id === current.latest_attempt_id &&
      latestEntry.payload.message === message
    ) {
      return;
    }

    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: current.latest_attempt_id,
        type: "run.planning.blocked",
        payload: {
          message
        }
      })
    );
    await refreshRunOperatorSurface(this.workspacePaths, runId);
  }

  private async planNextAttempt(
    runId: string,
    current: CurrentDecision,
    attempts: Attempt[]
  ): Promise<
    | {
        attempt: Attempt;
        contract: AttemptContract;
        proposal: RunPolicyProposal;
      }
    | null
  > {
    const run = await getRun(this.workspacePaths, runId);
    const queuedSteers = (await listRunSteers(this.workspacePaths, runId)).filter(
      (runSteer) => runSteer.status === "queued"
    );
    const latestAttempt = this.getLatestAttempt(current, attempts);
    const latestResult = latestAttempt
      ? await getAttemptResult(this.workspacePaths, run.id, latestAttempt.id)
      : null;
    let nextExecutionDraft = isExecutionContractDraft(
      latestResult?.next_attempt_contract
    )
      ? latestResult.next_attempt_contract
      : latestResult
        ? null
        : await this.findLatestExecutionContractDraft(run.id, attempts);

    if (attempts.length === 0) {
      if (queuedSteers.length > 0) {
        const attempt = createAttempt({
          run_id: run.id,
          attempt_type: "research",
          worker: this.adapter.type,
          objective: this.buildSteeredAttemptObjective(
            run,
            current,
            "research",
            null,
            queuedSteers.map((runSteer) => runSteer.content)
          ),
          success_criteria: run.success_criteria,
          workspace_root: getEffectiveRunWorkspaceRoot(run)
        });
        return {
          attempt,
          contract: await this.buildAttemptContract(run, attempt, null, null),
          proposal: buildRunPolicyProposal({
            attemptType: attempt.attempt_type,
            objective: attempt.objective,
            successCriteria: attempt.success_criteria,
            sourceAttemptId: null
          })
        };
      }

      const attempt = createAttempt({
        run_id: run.id,
        attempt_type: "research",
        worker: this.adapter.type,
        objective: `Understand the repository and surface the best next step for goal: ${run.title}`,
        success_criteria: run.success_criteria,
        workspace_root: getEffectiveRunWorkspaceRoot(run)
      });
      return {
        attempt,
        contract: await this.buildAttemptContract(run, attempt, null, null),
        proposal: buildRunPolicyProposal({
          attemptType: attempt.attempt_type,
          objective: attempt.objective,
          successCriteria: attempt.success_criteria,
          sourceAttemptId: null
        })
      };
    }

    if (current.waiting_for_human || current.run_status !== "running") {
      return null;
    }

    let attemptType =
      current.recommended_attempt_type ?? latestAttempt?.attempt_type ?? "research";
    let objective =
      queuedSteers.length > 0
        ? this.buildSteeredAttemptObjective(
            run,
            current,
            attemptType,
            latestResult,
            queuedSteers.map((runSteer) => runSteer.content)
          )
          : attemptType === "execution" && nextExecutionDraft?.objective
            ? nextExecutionDraft.objective
            : attemptType === "execution" && latestResult?.recommended_next_steps[0]
              ? latestResult.recommended_next_steps[0]
          : this.buildPlannedAttemptObjective(run, current, attemptType, latestResult);

    if (!objective) {
      return null;
    }

    const governance = await getRunGovernanceState(this.workspacePaths, runId);
    const candidateDecision = await validateGovernedAttemptCandidate({
      governance,
      candidate: {
        attemptType,
        objective,
        nextAction: current.recommended_next_action,
        nextExecutionDraft
      },
      rootDir: this.workspacePaths.rootDir
    });

    if (candidateDecision.status === "blocked") {
      await this.persistGovernanceDispatchBlocked({
        runId,
        current,
        governance,
        latestAttempt,
        objective,
        decision: candidateDecision
      });
      return null;
    }

    if (candidateDecision.status === "redirect") {
      attemptType = candidateDecision.candidate.attemptType;
      objective = candidateDecision.candidate.objective;
      nextExecutionDraft = candidateDecision.candidate.nextExecutionDraft;
      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: latestAttempt?.id ?? null,
          type: "run.governance.redirected",
          payload: {
            next_action: candidateDecision.candidate.nextAction,
            attempt_type: candidateDecision.candidate.attemptType,
            objective: candidateDecision.candidate.objective,
            message: candidateDecision.message
          }
        })
      );
    }

    const executionPlanningState =
      attemptType === "execution"
        ? await this.resolveExecutionContractPlanningState({
            run,
            runId,
            objective,
            nextExecutionDraft,
            latestAttempt,
            recommendedNextAction: candidateDecision.candidate.nextAction,
            steerMessages: queuedSteers.map((runSteer) => runSteer.content)
          })
        : {
            draft: null,
            reusableExecutionContract: null
          };
    nextExecutionDraft = executionPlanningState.draft;
    let successCriteria =
      attemptType === "execution" && nextExecutionDraft?.success_criteria
        ? nextExecutionDraft.success_criteria
        : attemptType === "execution" &&
            executionPlanningState.reusableExecutionContract?.success_criteria.length
          ? executionPlanningState.reusableExecutionContract.success_criteria
          : run.success_criteria;
    if (attemptType === "execution") {
      const policyGate = await this.readRunPolicyGate({
        runId
      });
      if (
        policyGate.status === "ready" &&
        policyGate.policy.approval_status === "approved" &&
        policyGate.policy.approval_required === true &&
        policyGate.policy.proposed_attempt_type === "execution" &&
        policyGate.policy.proposed_objective
      ) {
        objective = policyGate.policy.proposed_objective;
        successCriteria =
          policyGate.policy.proposed_success_criteria.length > 0
            ? policyGate.policy.proposed_success_criteria
            : successCriteria;
      }

      const attempt = createAttempt({
        run_id: run.id,
        attempt_type: attemptType,
        worker: this.adapter.type,
        objective,
        success_criteria: successCriteria,
        workspace_root: getEffectiveRunWorkspaceRoot(run)
      });
      const contract = await this.buildAttemptContract(
        run,
        attempt,
        nextExecutionDraft,
        executionPlanningState.reusableExecutionContract
      );
      const proposal = buildRunPolicyProposal({
        attemptType,
        objective: attempt.objective,
        successCriteria: contract.success_criteria,
        verifierKit: resolveExecutionVerifierKit(contract),
        verificationCommands:
          contract.verification_plan?.commands.map(
            (item: VerificationCommand) => item.command
          ) ?? [],
        sourceAttemptId: latestAttempt?.id ?? null
      });
      const dangerousCommandFinding = findDangerousVerificationCommand(
        proposal.verificationCommands
      );
      if (dangerousCommandFinding) {
        await this.persistRunPolicyDangerousRuleBlocked({
          runId,
          current,
          proposal,
          message: buildDangerousVerificationCommandMessage({
            proposal,
            finding: dangerousCommandFinding
          }),
          dangerousCommand: dangerousCommandFinding.command
        });
        return null;
      }
      if (policyGate.status === "invalid") {
        await this.persistRunPolicyDispatchBlocked({
          runId,
          current,
          policy: null,
          proposal,
          message:
            "Execution plan cannot dispatch because the policy runtime file is unreadable.",
          reason: "invalid_policy_runtime"
        });
        return null;
      }

      if (policyGate.status === "missing") {
        await this.persistRunPolicyApprovalRequested({
          runId,
          current,
          proposal
        });
        return null;
      }

      const approvedPolicy = policyGate.policy;
      if (approvedPolicy.killswitch_active) {
        await this.persistRunPolicyDispatchBlocked({
          runId,
          current,
          policy: approvedPolicy,
          proposal,
          message:
            approvedPolicy.killswitch_reason ??
            "Execution plan cannot dispatch because the policy killswitch is active.",
          reason: "killswitch_active"
        });
        return null;
      }

      if (
        approvedPolicy.approval_status !== "approved" ||
        approvedPolicy.approval_required !== true ||
        approvedPolicy.proposed_signature !== proposal.signature
      ) {
        await this.persistRunPolicyApprovalRequested({
          runId,
          current,
          proposal
        });
        return null;
      }

      return {
        attempt,
        contract,
        proposal
      };
    }

    const attempt = createAttempt({
      run_id: run.id,
      attempt_type: attemptType,
      worker: this.adapter.type,
      objective,
      success_criteria: successCriteria,
      workspace_root: getEffectiveRunWorkspaceRoot(run)
    });
    return {
      attempt,
      contract: await this.buildAttemptContract(
        run,
        attempt,
        nextExecutionDraft,
        executionPlanningState.reusableExecutionContract
      ),
      proposal: buildRunPolicyProposal({
        attemptType: attempt.attempt_type,
        objective: attempt.objective,
        successCriteria: attempt.success_criteria,
        sourceAttemptId: latestAttempt?.id ?? null
      })
    };
  }

  private async executeAttempt(runId: string, attemptId: string): Promise<void> {
    let run = await getRun(this.workspacePaths, runId);
    let attempt = await getAttempt(this.workspacePaths, runId, attemptId);
    const attemptPaths = resolveAttemptPaths(this.workspacePaths, runId, attemptId);
    let current = await getCurrentDecision(this.workspacePaths, runId);
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let heartbeatStarted = false;
    let heartbeatClosed = false;
    let heartbeatWritePromise: Promise<void> = Promise.resolve();
    let runtimeRestartRequest: RuntimeRestartRequest | null = null;
    let checkpointPreflight: GitCheckpointPreflight | null = null;
    const startLease = await this.tryAcquireRunDispatchLease(
      runId,
      `start_attempt:${attemptId}`
    );
    if (!startLease) {
      return;
    }
    let startLeaseReleased = false;
    const enqueueHeartbeatWrite = (status: "active" | "released"): Promise<void> => {
      heartbeatWritePromise = heartbeatWritePromise.then(() =>
        this.writeAttemptHeartbeat({
          runId,
          attemptId: attempt.id,
          startedAt: attempt.started_at ?? new Date().toISOString(),
          status
        })
      );
      return heartbeatWritePromise;
    };

    try {
      run = await getRun(this.workspacePaths, runId);
      attempt = await getAttempt(this.workspacePaths, runId, attemptId);
      current = await getCurrentDecision(this.workspacePaths, runId);
      if (!["created", "queued"].includes(attempt.status)) {
        return;
      }

      attempt = await this.ensureAttemptUsesRunWorkspace(run, attempt);
      const attemptContract = await getAttemptContract(
        this.workspacePaths,
        runId,
        attemptId
      );
      const steers = await listRunSteers(this.workspacePaths, runId);
      const attempts = await listAttempts(this.workspacePaths, runId);
      const previousAttempts = (
        await Promise.all(
          attempts
            .filter((item) => item.id !== attempt.id)
            .slice(-3)
            .map(async (item) => ({
              attempt: item,
              result: await getAttemptResult(this.workspacePaths, runId, item.id)
            }))
        )
      ).map(({ attempt: previousAttempt, result }) => ({
        id: previousAttempt.id,
        type: previousAttempt.attempt_type,
        status: previousAttempt.status,
        summary: result?.summary ?? ""
      }));
      const runtimeHealthSnapshot = await getRunRuntimeHealthSnapshot(
        this.workspacePaths,
        runId
      );
      const workerEffort = this.describeRunWorkerEffort(run);
      const activeNextTask = await this.getSelfBootstrapActiveNextTaskContext(
        run,
        runId,
        attempts,
        attempt.id
      );
      const context = {
        contract: {
          title: run.title,
          description: run.description,
          success_criteria: run.success_criteria,
          constraints: run.constraints,
          workspace_root: attempt.workspace_root,
          ...(run.managed_workspace_root
            ? {
                source_workspace_root: run.workspace_root
              }
            : {})
        },
        current_decision: current,
        queued_steers: steers
          .filter((runSteer) => runSteer.status === "queued")
          .map((runSteer) => ({
            id: runSteer.id,
            content: runSteer.content
          })),
        worker_effort: workerEffort,
        previous_attempts: previousAttempts,
        ...(activeNextTask
          ? {
              active_next_task: activeNextTask
            }
          : {}),
        ...(runtimeHealthSnapshot
          ? {
              runtime_health_snapshot: {
                path: relative(
                  this.workspacePaths.rootDir,
                  resolveRunPaths(this.workspacePaths, runId).runtimeHealthSnapshotFile
                ),
                verify_runtime: {
                  status: runtimeHealthSnapshot.verify_runtime.status,
                  summary: runtimeHealthSnapshot.verify_runtime.summary
                },
                history_contract_drift: {
                  status: runtimeHealthSnapshot.history_contract_drift.status,
                  summary: runtimeHealthSnapshot.history_contract_drift.summary,
                  drift_count: runtimeHealthSnapshot.history_contract_drift.drift_count
                },
                created_at: runtimeHealthSnapshot.created_at
              }
            }
          : {})
      };

      await this.assertAttemptWorkspaceScope(run, attempt);
      await saveAttemptContext(this.workspacePaths, runId, attempt.id, context);
      attempt = updateAttempt(attempt, {
        input_context_ref: this.buildAttemptContextRef(runId, attempt.id)
      });
      await saveAttempt(this.workspacePaths, attempt);
      const preflightOutcome = await this.runAttemptDispatchPreflight({
        run,
        runId,
        attempt,
        attemptContract,
        attemptPaths
      });
      checkpointPreflight = preflightOutcome.checkpointPreflight;
      attempt = updateAttempt(attempt, {
        status: "running",
        started_at: new Date().toISOString()
      });
      await saveAttempt(this.workspacePaths, attempt);
      await saveCurrentDecision(
        this.workspacePaths,
        updateCurrentDecision(current ?? createCurrentDecision({ run_id: runId }), {
          run_status: "running",
          latest_attempt_id: attempt.id,
          recommended_next_action: "attempt_running",
          recommended_attempt_type: attempt.attempt_type,
          summary: `Running ${attempt.attempt_type} attempt: ${attempt.objective}`,
          blocking_reason: null,
          waiting_for_human: false
        })
      );
      await enqueueHeartbeatWrite("active");
      heartbeatStarted = true;
      heartbeatTimer = setInterval(() => {
        if (heartbeatClosed) {
          return;
        }
        void enqueueHeartbeatWrite("active");
      }, this.attemptHeartbeatIntervalMs);
      heartbeatTimer.unref?.();
      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: attempt.id,
          type: "attempt.started",
          payload: {
            attempt_type: attempt.attempt_type
          }
        })
      );
      await resolveOpenRunMailboxMessagesByType({
        paths: this.workspacePaths,
        runId,
        messageType: "handoff_ready",
        resolutionSummary: "A new attempt picked up the run, so the previous handoff mailbox thread is closed."
      });
      await refreshRunOperatorSurface(this.workspacePaths, runId);
      await startLease.release();
      startLeaseReleased = true;

      if (attempt.attempt_type === "execution") {
        this.assertRunHarnessSlotBinding({
          run,
          slot: "execution"
        });
      }

      const execution = await this.adapter.runAttemptTask({
        run,
        attempt,
        attemptContract: preflightOutcome.dispatchableAttemptContract,
        context,
        worker_effort:
          attempt.attempt_type === "execution" ? workerEffort.execution : undefined,
        workspacePaths: this.workspacePaths
      });

      await saveAttemptResult(this.workspacePaths, runId, attempt.id, execution.writeback);
      attempt = updateAttempt(attempt, {
        result_ref: this.buildAttemptResultRef(runId, attempt.id)
      });
      if (attempt.attempt_type === "execution") {
        await this.transitionAttemptRuntimeState({
          runId,
          attempt,
          phase: "verifying",
          running: true,
          progressText: "运行时回放中"
        });
      }
      const runtimeVerification = await runAttemptRuntimeVerification({
        run,
        attempt,
        attemptContract: preflightOutcome.dispatchableAttemptContract,
        result: execution.writeback,
        attemptPaths
      });
      const adversarialVerification = await this.runAttemptAdversarialVerification({
        run,
        attempt,
        attemptContract: preflightOutcome.dispatchableAttemptContract,
        result: execution.writeback,
        runtimeVerification: runtimeVerification.verification,
        attemptPaths
      });
      const completedAttemptForEvaluation = updateAttempt(attempt, {
        status: "completed",
        ended_at: new Date().toISOString(),
        evaluation_ref: null
      });
      const reviewInputPacket = await this.buildAttemptReviewInputPacket({
        runId,
        attempt: completedAttemptForEvaluation,
        attemptContract,
        currentSnapshot: current,
        context,
        result: execution.writeback,
        runtimeVerification: runtimeVerification.verification,
        adversarialVerification,
        journal: await listRunJournal(this.workspacePaths, runId)
      });
      await saveAttemptReviewInputPacket(this.workspacePaths, reviewInputPacket);
      const reviewInputPacketRef = this.buildAttemptReviewInputPacketRef(runId, attempt.id);
      const reviewerInputRefs = this.buildReviewerInputRefs(
        reviewInputPacketRef,
        reviewInputPacket
      );
      await this.transitionAttemptRuntimeState({
        runId,
        attempt: completedAttemptForEvaluation,
        phase: "reviewing",
        running: true,
        progressText: "评审中"
      });
      const reviewOpinions = await this.runAttemptReviewerPipeline({
        reviewInputPacket,
        reviewInputPacketRef,
        inputRefs: reviewerInputRefs
      });
      await Promise.all(
        reviewOpinions.map((opinion) => saveAttemptReviewOpinion(this.workspacePaths, opinion))
      );
      await this.transitionAttemptRuntimeState({
        runId,
        attempt: completedAttemptForEvaluation,
        phase: "synthesizing",
        running: true,
        progressText: "汇总结论中"
      });
      const synthesis = await this.runAttemptEvaluationSynthesis({
        reviewInputPacket,
        opinions: reviewOpinions,
        reviewInputPacketRef,
        opinionRefs: reviewOpinions.map((opinion) =>
          this.buildAttemptReviewOpinionRef(runId, attempt.id, opinion.opinion_id)
        )
      });
      if (synthesis.synthesisRecord) {
        await saveAttemptEvaluationSynthesisRecord(
          this.workspacePaths,
          synthesis.synthesisRecord
        );
      }
      await saveAttemptEvaluation(this.workspacePaths, synthesis.evaluation);

      attempt = updateAttempt(completedAttemptForEvaluation, {
        evaluation_ref: `runs/${runId}/attempts/${attempt.id}/evaluation.json`
      });

      const completedAttempts = [...attempts.filter((item) => item.id !== attempt.id), attempt];
      let nextCurrent = this.buildNextCurrentDecision({
        run,
        current,
        attempt,
        attempts: completedAttempts,
        evaluation: synthesis.evaluation,
        result: execution.writeback
      });
      const provisionalGovernance = await this.buildSettledGovernanceState({
        runId,
        attempt,
        currentSnapshot: nextCurrent,
        previousGovernance: await getRunGovernanceState(this.workspacePaths, runId)
      });
      const checkpointOutcome = await maybeCreateVerifiedExecutionCheckpoint({
        run,
        attempt,
        evaluation: synthesis.evaluation,
        attemptPaths,
        preflight: checkpointPreflight,
        governanceContextLines: buildGovernanceCheckpointContext(provisionalGovernance)
      });
      nextCurrent = this.applyCheckpointOutcomeToCurrentDecision(
        nextCurrent,
        attempt,
        checkpointOutcome
      );
      const promotionOutcome = await maybePromoteVerifiedCheckpoint({
        layout: this.runtimeLayout,
        run,
        attempt,
        attemptPaths,
        checkpointOutcome
      });
      nextCurrent = this.applyRuntimePromotionOutcomeToCurrentDecision(
        nextCurrent,
        attempt,
        promotionOutcome
      );
      const runtimeSourceDriftFiles = await detectLiveRuntimeSourceDrift({
        changedFiles: runtimeVerification.verification.changed_files,
        attemptWorkspaceRoot: attempt.workspace_root,
        runtimeRepoRoot: this.runtimeLayout.runtimeRepoRoot
      });
      if (promotionOutcome.status === "promoted" && promotionOutcome.restart_required) {
        runtimeRestartRequest = {
          runId,
          attemptId: attempt.id,
          reason: "runtime_promotion",
          affectedFiles: [],
          message: promotionOutcome.message,
          promotedSha: promotionOutcome.checkpoint_sha
        };
      } else if (runtimeSourceDriftFiles.length > 0) {
        runtimeRestartRequest = {
          runId,
          attemptId: attempt.id,
          reason: "runtime_source_drift",
          affectedFiles: runtimeSourceDriftFiles,
          message: this.buildRuntimeSourceDriftMessage(runtimeSourceDriftFiles),
          promotedSha: null
        };
      }
      nextCurrent = this.applyRuntimeSourceDriftOutcomeToCurrentDecision(
        nextCurrent,
        attempt,
        runtimeSourceDriftFiles
      );
      nextCurrent = this.applyMissingRuntimeRestartHandlerOutcomeToCurrentDecision(
        nextCurrent,
        attempt,
        runtimeRestartRequest
      );
      const governance = await this.buildSettledGovernanceState({
        runId,
        attempt,
        currentSnapshot: nextCurrent,
        previousGovernance: await getRunGovernanceState(this.workspacePaths, runId)
      });
      nextCurrent = this.applyGovernanceToCurrentDecision(nextCurrent, governance);
      await saveRunReport(
        this.workspacePaths,
        runId,
        this.buildRunReport(
          run,
          attempt,
          execution.writeback,
          synthesis.evaluation,
          runtimeVerification,
          nextCurrent,
          governance
        )
      );

      for (const runSteer of steers.filter((item) => item.status === "queued")) {
        await saveRunSteer(
          this.workspacePaths,
          updateRunSteer(runSteer, {
            status: "applied"
          })
        );
      }

      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: attempt.id,
          type: "attempt.completed",
          payload: {
            recommendation: synthesis.evaluation.recommendation,
            goal_progress: synthesis.evaluation.goal_progress,
            suggested_attempt_type: synthesis.evaluation.suggested_attempt_type
          }
        })
      );
      await this.appendRuntimeVerificationJournal(runId, attempt.id, runtimeVerification);
      await this.appendAdversarialVerificationJournal(
        runId,
        attempt.id,
        adversarialVerification
      );
      await this.appendCheckpointJournal(runId, attempt.id, checkpointOutcome);
      await this.appendRuntimePromotionJournal(runId, attempt.id, promotionOutcome);
      await this.appendRuntimeSourceDriftJournal(
        runId,
        attempt.id,
        runtimeSourceDriftFiles,
        runtimeVerification.artifact_path
      );
      await this.appendGovernanceJournal(runId, attempt.id, governance);
      await this.saveSettledAttemptState({
        runId,
        attempt,
        currentSnapshot: nextCurrent,
        governanceSnapshot: governance
      });
      await this.transitionAttemptRuntimeState({
        runId,
        attempt,
        phase: "completed",
        running: false,
        progressText: attempt.attempt_type === "execution" ? "执行完成" : "已完成",
        error: null
      });
    } catch (error) {
      if (!startLeaseReleased) {
        await startLease.release();
        startLeaseReleased = true;
      }
      if (error instanceof RunWorkspaceScopeError) {
        await this.appendRunWorkspaceScopeBlockedEntry(run.id, attempt.id, error);
      }
      attempt = updateAttempt(attempt, {
        status: "failed",
        ended_at: new Date().toISOString()
      });
      const failedCurrentDecision = updateCurrentDecision(
        current ?? createCurrentDecision({ run_id: runId }),
        {
          run_status: "waiting_steer",
          latest_attempt_id: attempt.id,
          recommended_next_action: "wait_for_human",
          recommended_attempt_type: attempt.attempt_type,
          summary: error instanceof Error ? error.message : String(error),
          blocking_reason: error instanceof Error ? error.message : String(error),
          waiting_for_human: true
        }
      );
      const failurePayload = this.buildAttemptFailurePayload(runId, attempt.id, error);
      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: attempt.id,
          type: "attempt.failed",
          payload: failurePayload
        })
      );
      const governance = await this.buildSettledGovernanceState({
        runId,
        attempt,
        currentSnapshot: failedCurrentDecision,
        previousGovernance: await getRunGovernanceState(this.workspacePaths, runId)
      });
      await this.appendGovernanceJournal(runId, attempt.id, governance);
      await this.saveSettledAttemptState({
        runId,
        attempt,
        currentSnapshot: failedCurrentDecision,
        governanceSnapshot: governance
      });
      await this.transitionAttemptRuntimeState({
        runId,
        attempt,
        phase: "failed",
        running: false,
        progressText: "尝试失败",
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      if (!startLeaseReleased) {
        await startLease.release();
      }
      heartbeatClosed = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (heartbeatStarted) {
        await enqueueHeartbeatWrite("released");
      }
      if (runtimeRestartRequest) {
        await this.requestRuntimeRestart?.(runtimeRestartRequest);
      }
    }
  }

  private async saveSettledAttemptState(input: {
    runId: string;
    attempt: Attempt;
    currentSnapshot: CurrentDecision | null;
    governanceSnapshot?: RunGovernanceState | null;
  }): Promise<void> {
    const [
      attemptContract,
      context,
      result,
      evaluation,
      evaluationSynthesis,
      reviewInputPacket,
      reviewOpinions,
      preflightEvaluation,
      runtimeVerification,
      adversarialVerification,
      journal,
      previousGovernance
    ] = await Promise.all([
      getAttemptContract(this.workspacePaths, input.runId, input.attempt.id),
      getAttemptContext(this.workspacePaths, input.runId, input.attempt.id),
      getAttemptResult(this.workspacePaths, input.runId, input.attempt.id),
      getAttemptEvaluation(this.workspacePaths, input.runId, input.attempt.id),
      getAttemptEvaluationSynthesisRecord(this.workspacePaths, input.runId, input.attempt.id),
      getAttemptReviewInputPacket(this.workspacePaths, input.runId, input.attempt.id),
      listAttemptReviewOpinions(this.workspacePaths, input.runId, input.attempt.id),
      getAttemptPreflightEvaluation(this.workspacePaths, input.runId, input.attempt.id),
      getAttemptRuntimeVerification(this.workspacePaths, input.runId, input.attempt.id),
      getAttemptAdversarialVerification(this.workspacePaths, input.runId, input.attempt.id),
      listRunJournal(this.workspacePaths, input.runId),
      getRunGovernanceState(this.workspacePaths, input.runId)
    ]);
    const effectiveReviewInputPacket =
      reviewInputPacket ??
      (await this.buildAttemptReviewInputPacket({
        runId: input.runId,
        attempt: input.attempt,
        attemptContract,
        currentSnapshot: input.currentSnapshot,
        context,
        result,
        runtimeVerification,
        adversarialVerification,
        journal
      }));
    const reviewPacket = await this.buildAttemptReviewPacket({
      attempt: input.attempt,
      reviewInputPacket: effectiveReviewInputPacket,
      evaluation,
      currentSnapshot: input.currentSnapshot,
      journal,
      reviewInputPacketRef: reviewInputPacket
        ? this.buildAttemptReviewInputPacketRef(input.runId, input.attempt.id)
        : null,
      reviewOpinions,
      evaluationSynthesis
    });
    const reviewPacketRef = this.buildAttemptReviewPacketRef(input.runId, input.attempt.id);
    const handoffBundle = this.buildAttemptHandoffBundle({
      runId: input.runId,
      attempt: input.attempt,
      attemptContract,
      preflightEvaluation,
      currentSnapshot: reviewPacket.current_decision_snapshot,
      failureContext: reviewPacket.failure_context,
      runtimeVerification: reviewPacket.runtime_verification,
      adversarialVerification: reviewPacket.adversarial_verification,
      reviewPacketRef
    });

    await saveAttemptReviewPacket(this.workspacePaths, reviewPacket);
    await saveAttemptHandoffBundle(this.workspacePaths, handoffBundle);
    await this.persistAttemptEvaluatorCalibrationSample({
      runId: input.runId,
      attempt: input.attempt,
      preflightEvaluation,
      reviewPacket,
      handoffBundle
    });
    await upsertOpenRunMailboxEntry({
      paths: this.workspacePaths,
      runId: input.runId,
      threadId: buildRunMailboxThreadId({
        kind: "handoff",
        value: input.attempt.id
      }),
      messageType: "handoff_ready",
      fromSlot: "final_synthesis",
      toSlotOrActor: "operator",
      requiredAction:
        handoffBundle.recommended_next_action ?? "review_handoff",
      summary:
        handoffBundle.summary ??
        `Attempt ${input.attempt.id} produced a settled handoff bundle.`,
      sourceRef: this.buildAttemptHandoffBundleRef(input.runId, input.attempt.id),
      sourceAttemptId: input.attempt.id
    });
    await saveAttempt(this.workspacePaths, input.attempt);
    if (input.currentSnapshot) {
      await saveCurrentDecision(this.workspacePaths, input.currentSnapshot);
    }
    const governanceSnapshot =
      input.governanceSnapshot ??
      deriveRunGovernanceState({
        previous: previousGovernance,
        attempt: input.attempt,
        currentSnapshot: input.currentSnapshot,
        evaluation,
        result,
        runtimeVerification
      });
    await saveRunGovernanceState(this.workspacePaths, governanceSnapshot);
    if (
      input.currentSnapshot?.run_status === "running" &&
      input.currentSnapshot.waiting_for_human === false
    ) {
      await this.persistRunPolicyPlanning(input.runId);
    }
    await refreshRunOperatorSurface(this.workspacePaths, input.runId);
  }

  private async transitionAttemptRuntimeState(input: {
    runId: string;
    attempt: Attempt;
    phase: string;
    running: boolean;
    progressText: string;
    error?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    const existing = await getAttemptRuntimeState(
      this.workspacePaths,
      input.runId,
      input.attempt.id
    );
    const nextState = existing
      ? updateAttemptRuntimeState(existing, {
          running: input.running,
          phase: input.phase,
          last_event_at: now,
          progress_text: input.progressText,
          error: input.error ?? null,
          active_since: existing.active_since ?? input.attempt.started_at ?? now
        })
      : createAttemptRuntimeState({
          attempt_id: input.attempt.id,
          run_id: input.runId,
          running: input.running,
          phase: input.phase,
          active_since: input.attempt.started_at ?? now,
          last_event_at: now,
          progress_text: input.progressText,
          error: input.error ?? null
        });
    await saveAttemptRuntimeState(this.workspacePaths, nextState);
  }

  private async appendRuntimeVerificationJournal(
    runId: string,
    attemptId: string,
    verificationOutcome: AttemptRuntimeVerificationOutcome
  ): Promise<void> {
    if (verificationOutcome.verification.status === "not_applicable") {
      return;
    }

    const failureSignal = deriveFailureSignalFromRuntimeVerification({
      verification: verificationOutcome.verification,
      sourceRef: verificationOutcome.artifact_path
    });
    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: attemptId,
        type:
          verificationOutcome.verification.status === "passed"
            ? "attempt.verification.passed"
            : "attempt.verification.failed",
        payload: {
          status: verificationOutcome.verification.status,
          failure_class: failureSignal?.failure_class ?? null,
          failure_policy_mode: failureSignal?.policy_mode ?? null,
          failure_code: verificationOutcome.verification.failure_code,
          failure_reason: verificationOutcome.verification.failure_reason,
          changed_files: verificationOutcome.verification.changed_files,
          command_count: verificationOutcome.verification.command_results.length,
          artifact_path: verificationOutcome.artifact_path
        }
      })
    );
  }

  private async appendAdversarialVerificationJournal(
    runId: string,
    attemptId: string,
    verification: AttemptAdversarialVerification
  ): Promise<void> {
    if (verification.status === "not_applicable") {
      return;
    }

    const artifactPath = this.buildAttemptAdversarialVerificationRef(runId, attemptId);
    const failureSignal = deriveFailureSignalFromAdversarialVerification({
      verification,
      sourceRef: artifactPath
    });
    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: attemptId,
        type:
          verification.status === "passed"
            ? "attempt.adversarial_verification.passed"
            : "attempt.adversarial_verification.failed",
        payload: {
          status: verification.status,
          verdict: verification.verdict,
          failure_class: failureSignal?.failure_class ?? null,
          failure_policy_mode: failureSignal?.policy_mode ?? null,
          failure_code: verification.failure_code,
          message: verification.failure_reason ?? verification.summary,
          command_count: verification.commands.length,
          output_count: verification.output_refs.length,
          artifact_path: artifactPath
        }
      })
    );
  }

  private async runAttemptAdversarialVerification(input: {
    run: Run;
    attempt: Attempt;
    attemptContract: AttemptContract | null;
    result: WorkerWriteback;
    runtimeVerification: AttemptRuntimeVerification;
    attemptPaths: ReturnType<typeof resolveAttemptPaths>;
  }): Promise<AttemptAdversarialVerification> {
    const persist = async (
      verification: AttemptAdversarialVerification
    ): Promise<AttemptAdversarialVerification> => {
      await saveAttemptAdversarialVerification(this.workspacePaths, verification);
      return verification;
    };
    const verifierKit = resolveExecutionVerifierKit(input.attemptContract);
    const postflightSlotResolution = resolveRunHarnessSlotBinding({
      run: input.run,
      slot: "postflight_review"
    });
    const postflightAdversarialGateMode =
      resolveRunHarnessProfile(input.run).gates.postflight_adversarial.mode;

    if (input.attempt.attempt_type !== "execution") {
      return await persist(
        createAttemptAdversarialVerification({
          run_id: input.run.id,
          attempt_id: input.attempt.id,
          attempt_type: input.attempt.attempt_type,
          status: "not_applicable",
          verifier_kit: verifierKit,
          summary: "Adversarial verification only applies to execution attempts."
        })
      );
    }

    if (input.runtimeVerification.status !== "passed") {
      return await persist(
        createAttemptAdversarialVerification({
          run_id: input.run.id,
          attempt_id: input.attempt.id,
          attempt_type: input.attempt.attempt_type,
          status: "not_applicable",
          verifier_kit: verifierKit,
          summary:
            "Adversarial verification was skipped because deterministic runtime verification did not pass.",
          failure_reason: input.runtimeVerification.failure_reason
        })
      );
    }

    if (postflightAdversarialGateMode === "disabled") {
      if (input.attemptContract?.adversarial_verification_required) {
        return await persist(
          createAttemptAdversarialVerification({
            run_id: input.run.id,
            attempt_id: input.attempt.id,
            attempt_type: input.attempt.attempt_type,
            status: "failed",
            verifier_kit: verifierKit,
            verdict: "fail",
            summary:
              "Execution contract drifted away from the run harness gate bundle.",
            failure_code: "gate_profile_mismatch",
            failure_reason:
              "Run harness profile disables the postflight adversarial gate, but attempt_contract.json still requires it."
          })
        );
      }

      return await persist(
        createAttemptAdversarialVerification({
          run_id: input.run.id,
          attempt_id: input.attempt.id,
          attempt_type: input.attempt.attempt_type,
          status: "not_applicable",
          verifier_kit: verifierKit,
          summary:
            "Adversarial verification was skipped because the run harness profile disables the postflight adversarial gate."
        })
      );
    }

    if (postflightAdversarialGateMode === "disabled") {
      if (input.attemptContract?.adversarial_verification_required) {
        return await persist(
          createAttemptAdversarialVerification({
            run_id: input.run.id,
            attempt_id: input.attempt.id,
            attempt_type: input.attempt.attempt_type,
            status: "failed",
            verifier_kit: verifierKit,
            verdict: "fail",
            summary:
              "Execution contract still requires postflight adversarial verification after the run harness profile disabled that gate.",
            failure_code: "gate_profile_mismatch",
            failure_reason:
              "run.harness_profile.gates.postflight_adversarial.mode is disabled, but attempt_contract.json still requires postflight adversarial verification."
          })
        );
      }

      return await persist(
        createAttemptAdversarialVerification({
          run_id: input.run.id,
          attempt_id: input.attempt.id,
          attempt_type: input.attempt.attempt_type,
          status: "not_applicable",
          verifier_kit: verifierKit,
          summary:
            "Adversarial verification was skipped because the run harness profile disabled the postflight adversarial gate."
        })
      );
    }

    if (!postflightSlotResolution.ok) {
      return await persist(
        createAttemptAdversarialVerification({
          run_id: input.run.id,
          attempt_id: input.attempt.id,
          attempt_type: input.attempt.attempt_type,
          status: "failed",
          verifier_kit: verifierKit,
          verdict: "fail",
          summary: "Postflight adversarial review slot is misconfigured.",
          failure_code: "slot_binding_mismatch",
          failure_reason: postflightSlotResolution.failure_reason
        })
      );
    }

    if (!input.attemptContract?.adversarial_verification_required) {
      return await persist(
        createAttemptAdversarialVerification({
          run_id: input.run.id,
          attempt_id: input.attempt.id,
          attempt_type: input.attempt.attempt_type,
          status: "failed",
          verifier_kit: verifierKit,
          verdict: "fail",
          summary: "Execution contract is missing the adversarial verification requirement.",
          failure_code: "missing_requirement",
          failure_reason:
            "Execution contract does not explicitly require adversarial verification after deterministic replay passes."
        })
      );
    }

    const sourceArtifactPath =
      input.result.artifacts.find(
        (artifact: WorkerWriteback["artifacts"][number]) =>
          artifact.path === ADVERSARIAL_VERIFICATION_ARTIFACT_RELATIVE_PATH
      )?.path ??
      input.result.artifacts.find((artifact: WorkerWriteback["artifacts"][number]) =>
        artifact.path.endsWith("/adversarial-verification.json")
      )?.path ??
      null;
    if (!sourceArtifactPath) {
      return await persist(
        createAttemptAdversarialVerification({
          run_id: input.run.id,
          attempt_id: input.attempt.id,
          attempt_type: input.attempt.attempt_type,
          status: "failed",
          verifier_kit: verifierKit,
          verdict: "fail",
          summary: "Execution finished without a machine-readable adversarial verification artifact.",
          failure_code: "missing_artifact",
          failure_reason:
            "Execution must leave artifacts/adversarial-verification.json and include it in writeback.artifacts."
        })
      );
    }

    const resolvedSourceArtifactPath = resolve(input.attempt.workspace_root, sourceArtifactPath);

    try {
      const raw = JSON.parse(await readFile(resolvedSourceArtifactPath, "utf8")) as Record<
        string,
        unknown
      >;
      const normalized = createAttemptAdversarialVerification({
        run_id: input.run.id,
        attempt_id: input.attempt.id,
        attempt_type: input.attempt.attempt_type,
        status:
          raw.status === "passed" || raw.status === "failed" || raw.status === "not_applicable"
            ? raw.status
            : raw.verdict === "pass"
              ? "passed"
              : raw.verdict === "fail" || raw.verdict === "partial"
                ? "failed"
              : "failed",
        verifier_kit: verifierKit,
        verdict:
          raw.verdict === "pass" || raw.verdict === "fail" || raw.verdict === "partial"
            ? raw.verdict
            : null,
        summary: typeof raw.summary === "string" ? raw.summary : null,
        failure_code:
          raw.failure_code === "gate_profile_mismatch" ||
          raw.failure_code === "missing_requirement" ||
          raw.failure_code === "missing_artifact" ||
          raw.failure_code === "invalid_artifact" ||
          raw.failure_code === "missing_checks" ||
          raw.failure_code === "missing_commands" ||
          raw.failure_code === "missing_outputs" ||
          raw.failure_code === "verdict_fail" ||
          raw.failure_code === "verdict_partial"
            ? raw.failure_code
            : null,
        failure_reason: typeof raw.failure_reason === "string" ? raw.failure_reason : null,
        checks: Array.isArray(raw.checks) ? raw.checks : [],
        commands: Array.isArray(raw.commands)
          ? raw.commands.map((command: unknown) =>
              typeof command === "object" && command !== null
                ? {
                    ...command,
                    cwd:
                      "cwd" in command && typeof command.cwd === "string"
                        ? resolve(input.attempt.workspace_root, command.cwd)
                        : null,
                    output_ref:
                      "output_ref" in command && typeof command.output_ref === "string"
                        ? resolve(input.attempt.workspace_root, command.output_ref)
                        : null
                  }
                : command
            )
          : [],
        output_refs: Array.isArray(raw.output_refs)
          ? raw.output_refs
              .filter(
                (value: unknown): value is string =>
                  typeof value === "string" && value.length > 0
              )
              .map((value: string) => resolve(input.attempt.workspace_root, value))
          : [],
        source_artifact_path: resolvedSourceArtifactPath
      });

      const effectiveOutputRefs = [
        ...normalized.output_refs,
        ...normalized.commands
          .map(
            (
              command: AttemptAdversarialVerification["commands"][number]
            ) => command.output_ref
          )
          .filter((value: string | null): value is string => Boolean(value))
      ];
      const uniqueOutputRefs = [...new Set(effectiveOutputRefs)];
      const kitFocusAssessment = assessVerifierKitAdversarialFocus({
        verifierKit,
        summary: normalized.summary,
        checks: normalized.checks,
        commands: normalized.commands
      });
      const checksWithHarnessFocus = [...normalized.checks, kitFocusAssessment.check];
      const base = {
        run_id: normalized.run_id,
        attempt_id: normalized.attempt_id,
        attempt_type: normalized.attempt_type,
        verifier_kit: normalized.verifier_kit,
        verdict: normalized.verdict,
        summary: normalized.summary,
        checks: checksWithHarnessFocus,
        commands: normalized.commands,
        output_refs: uniqueOutputRefs,
        source_artifact_path: normalized.source_artifact_path
      } as const;

      if (!normalized.verdict) {
        return await persist(
          createAttemptAdversarialVerification({
            ...base,
            status: "failed",
            verdict: "fail",
            failure_code: "invalid_artifact",
            failure_reason:
              "Adversarial verification artifact is missing a machine-readable verdict."
          })
        );
      }

      if (normalized.checks.length === 0) {
        return await persist(
          createAttemptAdversarialVerification({
            ...base,
            status: "failed",
            failure_code: "missing_checks",
            failure_reason:
              "Adversarial verification artifact must include at least one structured check."
          })
        );
      }

      if (normalized.commands.length === 0) {
        return await persist(
          createAttemptAdversarialVerification({
            ...base,
            status: "failed",
            failure_code: "missing_commands",
            failure_reason:
              "Adversarial verification artifact must include at least one executed command."
          })
        );
      }

      if (!kitFocusAssessment.ok) {
        return await persist(
          createAttemptAdversarialVerification({
            ...base,
            status: "failed",
            failure_code: "missing_kit_focus",
            failure_reason: kitFocusAssessment.check.message
          })
        );
      }

      if (uniqueOutputRefs.length === 0) {
        return await persist(
          createAttemptAdversarialVerification({
            ...base,
            status: "failed",
            failure_code: "missing_outputs",
            failure_reason:
              "Adversarial verification artifact must include at least one output reference."
          })
        );
      }

      if (normalized.verdict === "fail") {
        return await persist(
          createAttemptAdversarialVerification({
            ...base,
            status: "failed",
            failure_code: normalized.failure_code ?? "verdict_fail",
            failure_reason:
              normalized.failure_reason ??
              "Adversarial verification returned a failing verdict."
          })
        );
      }

      if (normalized.verdict === "partial") {
        return await persist(
          createAttemptAdversarialVerification({
            ...base,
            status: "failed",
            failure_code: normalized.failure_code ?? "verdict_partial",
            failure_reason:
              normalized.failure_reason ??
              "Adversarial verification returned PARTIAL, so execution cannot complete."
          })
        );
      }

      return await persist(
        createAttemptAdversarialVerification({
          ...base,
          status: "passed"
        })
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return await persist(
        createAttemptAdversarialVerification({
          run_id: input.run.id,
          attempt_id: input.attempt.id,
          attempt_type: input.attempt.attempt_type,
          status: "failed",
          verifier_kit: verifierKit,
          verdict: "fail",
          summary: "Execution left an unreadable adversarial verification artifact.",
          failure_code: "invalid_artifact",
          failure_reason: `Failed to parse ${sourceArtifactPath}: ${reason}`,
          source_artifact_path: resolvedSourceArtifactPath
        })
      );
    }
  }

  private buildAttemptContextRef(runId: string, attemptId: string): string {
    return `runs/${runId}/attempts/${attemptId}/context.json`;
  }

  private buildAttemptWorkerOutputRef(runId: string, attemptId: string): string {
    return `runs/${runId}/attempts/${attemptId}/worker-output.json`;
  }

  private buildAttemptResultRef(runId: string, attemptId: string): string {
    return `runs/${runId}/attempts/${attemptId}/result.json`;
  }

  private buildAttemptEvaluationRef(runId: string, attemptId: string): string {
    return `runs/${runId}/attempts/${attemptId}/evaluation.json`;
  }

  private buildAttemptEvaluationSynthesisRef(runId: string, attemptId: string): string {
    return `runs/${runId}/attempts/${attemptId}/evaluation_synthesis.json`;
  }

  private buildAttemptReviewPacketRef(runId: string, attemptId: string): string {
    return `runs/${runId}/attempts/${attemptId}/review_packet.json`;
  }

  private buildAttemptRuntimeVerificationRef(runId: string, attemptId: string): string {
    return `runs/${runId}/attempts/${attemptId}/artifacts/runtime-verification.json`;
  }

  private buildAttemptAdversarialVerificationRef(runId: string, attemptId: string): string {
    return `runs/${runId}/attempts/${attemptId}/artifacts/adversarial-verification.json`;
  }

  private buildAttemptHandoffBundleRef(runId: string, attemptId: string): string {
    return `runs/${runId}/attempts/${attemptId}/artifacts/handoff_bundle.json`;
  }

  private buildAttemptMetaRef(runId: string, attemptId: string): string {
    return `runs/${runId}/attempts/${attemptId}/meta.json`;
  }

  private buildAttemptContractRef(runId: string, attemptId: string): string {
    return `runs/${runId}/attempts/${attemptId}/attempt_contract.json`;
  }

  private buildRunContractRef(runId: string): string {
    return `runs/${runId}/contract.json`;
  }

  private buildCurrentDecisionRef(runId: string): string {
    return `runs/${runId}/current.json`;
  }

  private buildAttemptFailurePayload(
    runId: string,
    attemptId: string,
    error: unknown
  ): Record<string, unknown> {
    const message = error instanceof Error ? error.message : String(error);

    if (isWorkerWritebackParseError(error)) {
      return {
        message,
        code: error.code,
        field_path: error.fieldPath,
        issue_code: error.issueCode,
        repair_hint: error.repairHint,
        raw_output_file:
          error.rawOutputFile ?? this.buildAttemptWorkerOutputRef(runId, attemptId)
      };
    }

    return {
      message
    };
  }

  private buildAttemptReviewInputPacketRef(runId: string, attemptId: string): string {
    return `runs/${runId}/attempts/${attemptId}/review_input_packet.json`;
  }

  private buildAttemptReviewOpinionRef(
    runId: string,
    attemptId: string,
    opinionId: string
  ): string {
    return `runs/${runId}/attempts/${attemptId}/review_opinions/${opinionId}.json`;
  }

  private buildReviewerInputRefs(
    reviewInputPacketRef: string,
    reviewInputPacket: AttemptReviewInputPacket
  ): AttemptReviewInputRef[] {
    const seen = new Set<string>();
    const refs: AttemptReviewInputRef[] = [];
    const addRef = (kind: string, path: string | null | undefined): void => {
      if (!path) {
        return;
      }

      const key = `${kind}:${path}`;
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      refs.push({
        kind,
        path
      });
    };

    addRef("review_input_packet", reviewInputPacketRef);
    for (const artifact of reviewInputPacket.artifact_manifest) {
      if (artifact.exists) {
        addRef(artifact.kind, artifact.path);
      }
    }

    return refs;
  }

  private async runAttemptReviewerPipeline(input: {
    reviewInputPacket: AttemptReviewInputPacket;
    reviewInputPacketRef: string;
    inputRefs: AttemptReviewInputRef[];
  }): Promise<AttemptReviewerOpinion[]> {
    try {
      return await executeAttemptReviewerPipeline({
        reviewInputPacket: input.reviewInputPacket,
        reviewers: this.reviewers,
        reviewInputPacketRef: input.reviewInputPacketRef,
        inputRefs: input.inputRefs
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `尝试 ${input.reviewInputPacket.attempt_id} 的 reviewer 在 opinion 落盘前失败：${reason}`
      );
    }
  }

  private async buildSettledGovernanceState(input: {
    runId: string;
    attempt: Attempt;
    currentSnapshot: CurrentDecision | null;
    previousGovernance?: RunGovernanceState | null;
  }): Promise<RunGovernanceState> {
    const [result, evaluation, runtimeVerification, previousGovernance] = await Promise.all([
      getAttemptResult(this.workspacePaths, input.runId, input.attempt.id),
      getAttemptEvaluation(this.workspacePaths, input.runId, input.attempt.id),
      getAttemptRuntimeVerification(this.workspacePaths, input.runId, input.attempt.id),
      input.previousGovernance === undefined
        ? getRunGovernanceState(this.workspacePaths, input.runId)
        : Promise.resolve(input.previousGovernance)
    ]);

    return deriveRunGovernanceState({
      previous: previousGovernance,
      attempt: input.attempt,
      currentSnapshot: input.currentSnapshot,
      evaluation,
      result,
      runtimeVerification
      });
  }

  private async persistAttemptEvaluatorCalibrationSample(input: {
    runId: string;
    attempt: Attempt;
    preflightEvaluation: Awaited<ReturnType<typeof getAttemptPreflightEvaluation>> | null;
    reviewPacket: AttemptReviewPacket;
    handoffBundle: AttemptHandoffBundle;
  }): Promise<void> {
    await saveAttemptEvaluatorCalibrationSample(
      this.workspacePaths,
      buildAttemptEvaluatorCalibrationSample({
        attempt: input.attempt,
        preflightEvaluation: input.preflightEvaluation,
        preflightEvaluationRef: input.preflightEvaluation
          ? this.buildAttemptPreflightEvaluationRef(input.runId, input.attempt.id)
          : null,
        reviewPacket: input.reviewPacket,
        reviewPacketRef: this.buildAttemptReviewPacketRef(input.runId, input.attempt.id),
        runtimeVerification: input.reviewPacket.runtime_verification,
        runtimeVerificationRef: input.reviewPacket.runtime_verification
          ? this.buildAttemptRuntimeVerificationRef(input.runId, input.attempt.id)
          : null,
        adversarialVerification: input.reviewPacket.adversarial_verification,
        adversarialVerificationRef: input.reviewPacket.adversarial_verification
          ? this.buildAttemptAdversarialVerificationRef(input.runId, input.attempt.id)
          : null,
        handoffBundle: input.handoffBundle,
        handoffBundleRef: this.buildAttemptHandoffBundleRef(input.runId, input.attempt.id)
      })
    );
  }

  private applyGovernanceToCurrentDecision(
    current: CurrentDecision,
    governance: RunGovernanceState
  ): CurrentDecision {
    if (governance.status !== "blocked" || governance.blocker_repeat_count < 2) {
      return current;
    }

    return updateCurrentDecision(current, {
      run_status: "waiting_steer",
      recommended_next_action: "wait_for_human",
      summary: governance.context_summary.headline,
      blocking_reason:
        governance.context_summary.blocker_summary ?? governance.context_summary.headline,
      waiting_for_human: true
    });
  }

  private async appendGovernanceJournal(
    runId: string,
    attemptId: string | null,
    governance: RunGovernanceState
  ): Promise<void> {
    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: attemptId,
        type: "run.governance.updated",
        payload: {
          status: governance.status,
          blocker_repeat_count: governance.blocker_repeat_count,
          active_problem_signature: governance.active_problem_signature,
          mainline_attempt_type: governance.mainline_attempt_type,
          mainline_summary: governance.mainline_summary,
          excluded_plan_count: governance.excluded_plans.length
        }
      })
    );
  }

  private async persistGovernanceDispatchBlocked(input: {
    runId: string;
    current: CurrentDecision;
    governance: RunGovernanceState | null;
    latestAttempt: Attempt | null;
    objective: string;
    decision: Extract<
      Awaited<ReturnType<typeof validateGovernedAttemptCandidate>>,
      { status: "blocked" }
    >;
  }): Promise<void> {
    const baseGovernance =
      input.governance ??
      createRunGovernanceState({
        run_id: input.runId
      });
    const blockedGovernance = updateRunGovernanceState(baseGovernance, {
      status: "blocked",
      active_problem_summary: input.decision.message,
      active_problem_signature:
        buildGovernanceSignature(input.decision.message) ?? baseGovernance.active_problem_signature,
      excluded_plans: input.decision.excludedPlan
        ? [input.decision.excludedPlan, ...baseGovernance.excluded_plans]
        : baseGovernance.excluded_plans,
      next_allowed_actions: ["wait_for_human", "apply_steer"],
      context_summary: {
        headline: "治理层拦下了下一轮派发。",
        progress_summary: null,
        blocker_summary: input.decision.message,
        avoid_summary: [`不要再按这个目标继续：${input.objective}`],
        generated_at: new Date().toISOString()
      }
    });
    const blockedCurrent = updateCurrentDecision(input.current, {
      run_status: "waiting_steer",
      latest_attempt_id: input.latestAttempt?.id ?? input.current.latest_attempt_id,
      recommended_next_action: "wait_for_human",
      summary: input.decision.message,
      blocking_reason: input.decision.message,
      waiting_for_human: true
    });

    await saveRunGovernanceState(this.workspacePaths, blockedGovernance);
    await saveCurrentDecision(this.workspacePaths, blockedCurrent);
    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: input.runId,
        attempt_id: input.latestAttempt?.id ?? null,
        type: "run.governance.dispatch_blocked",
        payload: {
          reason: input.decision.reason,
          message: input.decision.message,
          objective: input.objective,
          invalid_refs: input.decision.invalidRefs
        }
      })
    );
    await refreshRunOperatorSurface(this.workspacePaths, input.runId);
  }

  private async runAttemptEvaluationSynthesis(input: {
    reviewInputPacket: AttemptReviewInputPacket;
    reviewInputPacketRef: string;
    opinions: AttemptReviewerOpinion[];
    opinionRefs: string[];
  }): Promise<Awaited<ReturnType<typeof synthesizeAttemptEvaluation>>> {
    const synthesisSlotResolution = resolveRunHarnessSlotBinding({
      run: await getRun(this.workspacePaths, input.reviewInputPacket.run_id),
      slot: "final_synthesis"
    });
    if (!synthesisSlotResolution.ok) {
      throw new Error(synthesisSlotResolution.failure_reason);
    }

    try {
      return await synthesizeAttemptEvaluation({
        ...input,
        synthesizer: this.synthesizer
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `尝试 ${input.reviewInputPacket.attempt_id} 的 synthesizer 在 evaluation 落盘前失败：${reason}`
      );
    }
  }

  private async ensureSettledAttemptReviewPackets(
    runId: string,
    current: CurrentDecision | null,
    attempts: Attempt[]
  ): Promise<void> {
    for (const attempt of attempts) {
      if (!["completed", "failed", "stopped"].includes(attempt.status)) {
        continue;
      }

      const [reviewPacket, handoffBundle, evaluatorCalibrationSample] = await Promise.all([
        getAttemptReviewPacket(this.workspacePaths, runId, attempt.id),
        getAttemptHandoffBundle(this.workspacePaths, runId, attempt.id),
        getAttemptEvaluatorCalibrationSample(this.workspacePaths, runId, attempt.id)
      ]);
      if (!reviewPacket) {
        await this.persistAttemptReviewPacket(runId, attempt.id, current);
        continue;
      }

      let nextHandoffBundle = handoffBundle;
      let preflightEvaluation: Awaited<ReturnType<typeof getAttemptPreflightEvaluation>> | null =
        null;

      if (!nextHandoffBundle) {
        const attemptContract = await getAttemptContract(
          this.workspacePaths,
          runId,
          attempt.id
        );
        preflightEvaluation = await getAttemptPreflightEvaluation(
          this.workspacePaths,
          runId,
          attempt.id
        );
        nextHandoffBundle = this.buildAttemptHandoffBundle({
          runId,
          attempt,
          attemptContract,
          preflightEvaluation,
          currentSnapshot: reviewPacket.current_decision_snapshot,
          failureContext: reviewPacket.failure_context,
          runtimeVerification: reviewPacket.runtime_verification,
          adversarialVerification: reviewPacket.adversarial_verification,
          reviewPacketRef: this.buildAttemptReviewPacketRef(runId, attempt.id)
        });
        await saveAttemptHandoffBundle(this.workspacePaths, nextHandoffBundle);
        await upsertOpenRunMailboxEntry({
          paths: this.workspacePaths,
          runId,
          threadId: buildRunMailboxThreadId({
            kind: "handoff",
            value: attempt.id
          }),
          messageType: "handoff_ready",
          fromSlot: "final_synthesis",
          toSlotOrActor: "operator",
          requiredAction:
            nextHandoffBundle.recommended_next_action ?? "review_handoff",
          summary:
            nextHandoffBundle.summary ??
            `Attempt ${attempt.id} produced a settled handoff bundle.`,
          sourceRef: this.buildAttemptHandoffBundleRef(runId, attempt.id),
          sourceAttemptId: attempt.id
        });
      }

      if (evaluatorCalibrationSample) {
        continue;
      }

      if (!preflightEvaluation) {
        preflightEvaluation = await getAttemptPreflightEvaluation(
          this.workspacePaths,
          runId,
          attempt.id
        );
      }

      await this.persistAttemptEvaluatorCalibrationSample({
        runId,
        attempt,
        preflightEvaluation,
        reviewPacket,
        handoffBundle: nextHandoffBundle
      });
    }
  }

  private async persistAttemptReviewPacket(
    runId: string,
    attemptId: string,
    currentSnapshot: CurrentDecision | null
  ): Promise<void> {
    const [
      attempt,
      attemptContract,
      context,
      result,
      evaluation,
      evaluationSynthesis,
      reviewInputPacket,
      reviewOpinions,
      preflightEvaluation,
      runtimeVerification,
      adversarialVerification,
      journal
    ] = await Promise.all([
      getAttempt(this.workspacePaths, runId, attemptId),
      getAttemptContract(this.workspacePaths, runId, attemptId),
      getAttemptContext(this.workspacePaths, runId, attemptId),
      getAttemptResult(this.workspacePaths, runId, attemptId),
      getAttemptEvaluation(this.workspacePaths, runId, attemptId),
      getAttemptEvaluationSynthesisRecord(this.workspacePaths, runId, attemptId),
      getAttemptReviewInputPacket(this.workspacePaths, runId, attemptId),
      listAttemptReviewOpinions(this.workspacePaths, runId, attemptId),
      getAttemptPreflightEvaluation(this.workspacePaths, runId, attemptId),
      getAttemptRuntimeVerification(this.workspacePaths, runId, attemptId),
      getAttemptAdversarialVerification(this.workspacePaths, runId, attemptId),
      listRunJournal(this.workspacePaths, runId)
    ]);
    const effectiveReviewInputPacket =
      reviewInputPacket ??
      (await this.buildAttemptReviewInputPacket({
        runId,
        attempt,
        attemptContract,
        currentSnapshot,
        context,
        result,
        runtimeVerification,
        adversarialVerification,
        journal
      }));
    const reviewPacket = await this.buildAttemptReviewPacket({
      attempt,
      reviewInputPacket: effectiveReviewInputPacket,
      evaluation,
      currentSnapshot,
      journal,
      reviewInputPacketRef: reviewInputPacket
        ? this.buildAttemptReviewInputPacketRef(runId, attemptId)
        : null,
      reviewOpinions,
      evaluationSynthesis
    });
    const handoffBundle = this.buildAttemptHandoffBundle({
      runId,
      attempt,
      attemptContract,
      preflightEvaluation,
      currentSnapshot: reviewPacket.current_decision_snapshot,
      failureContext: reviewPacket.failure_context,
      runtimeVerification: reviewPacket.runtime_verification,
      adversarialVerification: reviewPacket.adversarial_verification,
      reviewPacketRef: this.buildAttemptReviewPacketRef(runId, attemptId)
    });

    await saveAttemptReviewPacket(this.workspacePaths, reviewPacket);
    await saveAttemptHandoffBundle(this.workspacePaths, handoffBundle);
    await this.persistAttemptEvaluatorCalibrationSample({
      runId,
      attempt,
      preflightEvaluation,
      reviewPacket,
      handoffBundle
    });
  }

  private buildReviewPacketFailureContext(input: {
    attempt: Attempt;
    currentSnapshot: CurrentDecision | null;
    runtimeVerification: AttemptRuntimeVerification | null;
    adversarialVerification: AttemptAdversarialVerification | null;
    journal: Awaited<ReturnType<typeof listRunJournal>>;
  }): AttemptReviewInputPacket["failure_context"] {
    const failureEntry = [...input.journal].reverse().find((entry) =>
      [
        "attempt.failed",
        "attempt.recovery_required",
        "attempt.restart_required"
      ].includes(entry.type)
    );
    const currentBlockingReason =
      input.currentSnapshot?.latest_attempt_id === input.attempt.id
        ? input.currentSnapshot.blocking_reason
        : null;
    const failureMessage =
      this.getReviewPacketFailureMessage(failureEntry?.payload) ??
      input.runtimeVerification?.failure_reason ??
      input.adversarialVerification?.failure_reason ??
      (["failed", "stopped"].includes(input.attempt.status)
        ? currentBlockingReason ?? `Attempt ${input.attempt.id} ended as ${input.attempt.status}.`
        : currentBlockingReason);

    return failureMessage
      ? {
          message: failureMessage,
          journal_event_id: failureEntry?.id ?? null,
          journal_event_ts: failureEntry?.ts ?? null
        }
      : null;
  }

  private async buildAttemptReviewInputPacket(input: {
    runId: string;
    attempt: Attempt;
    attemptContract: AttemptContract | null;
    currentSnapshot: CurrentDecision | null;
    context: unknown | null;
    result: WorkerWriteback | null;
    runtimeVerification: AttemptRuntimeVerification | null;
    adversarialVerification: AttemptAdversarialVerification | null;
    journal: Awaited<ReturnType<typeof listRunJournal>>;
  }): Promise<AttemptReviewInputPacket> {
    const attemptPaths = resolveAttemptPaths(
      this.workspacePaths,
      input.runId,
      input.attempt.id
    );
    const attemptJournal = input.journal.filter((entry) => entry.attempt_id === input.attempt.id);

    return {
      run_id: input.runId,
      attempt_id: input.attempt.id,
      attempt: input.attempt,
      attempt_contract: input.attemptContract,
      current_decision_snapshot: input.currentSnapshot,
      context: input.context,
      journal: attemptJournal,
      failure_context: this.buildReviewPacketFailureContext({
        attempt: input.attempt,
        currentSnapshot: input.currentSnapshot,
        runtimeVerification: input.runtimeVerification,
        adversarialVerification: input.adversarialVerification,
        journal: attemptJournal
      }),
      result: input.result,
      runtime_verification: input.runtimeVerification,
      adversarial_verification: input.adversarialVerification,
      artifact_manifest: await this.buildAttemptArtifactManifest({
        attemptPaths,
        result: input.result,
        runtimeVerification: input.runtimeVerification,
        adversarialVerification: input.adversarialVerification,
        journal: attemptJournal,
        reviewInputPacketFile: null,
        evaluationSynthesisFile: null,
        reviewOpinionFiles: []
      }),
      generated_at: new Date().toISOString()
    };
  }

  private async buildAttemptReviewPacket(input: {
    attempt: Attempt;
    reviewInputPacket: AttemptReviewInputPacket;
    evaluation: AttemptEvaluation | null;
    evaluationSynthesis: AttemptEvaluationSynthesisRecord | null;
    currentSnapshot: CurrentDecision | null;
    journal: Awaited<ReturnType<typeof listRunJournal>>;
    reviewInputPacketRef: string | null;
    reviewOpinions: AttemptReviewerOpinion[];
  }): Promise<AttemptReviewPacket> {
    const attemptPaths = resolveAttemptPaths(
      this.workspacePaths,
      input.reviewInputPacket.run_id,
      input.reviewInputPacket.attempt_id
    );
    const attemptJournal = input.journal.filter(
      (entry) => entry.attempt_id === input.reviewInputPacket.attempt_id
    );
    const reviewOpinionRefs = input.reviewOpinions.map((opinion) =>
      this.buildAttemptReviewOpinionRef(
        input.reviewInputPacket.run_id,
        input.reviewInputPacket.attempt_id,
        opinion.opinion_id
      )
    );

    return {
      ...input.reviewInputPacket,
      attempt: input.attempt,
      current_decision_snapshot: input.currentSnapshot,
      journal: attemptJournal,
      failure_context: this.buildReviewPacketFailureContext({
        attempt: input.attempt,
        currentSnapshot: input.currentSnapshot,
        runtimeVerification: input.reviewInputPacket.runtime_verification,
        adversarialVerification: input.reviewInputPacket.adversarial_verification,
        journal: attemptJournal
      }),
      evaluation: input.evaluation,
      artifact_manifest: await this.buildAttemptArtifactManifest({
        attemptPaths,
        result: input.reviewInputPacket.result,
        runtimeVerification: input.reviewInputPacket.runtime_verification,
        adversarialVerification: input.reviewInputPacket.adversarial_verification,
        journal: attemptJournal,
        reviewInputPacketFile: input.reviewInputPacketRef
          ? attemptPaths.reviewInputPacketFile
          : null,
        evaluationSynthesisFile: input.evaluationSynthesis
          ? attemptPaths.evaluationSynthesisFile
          : null,
        reviewOpinionFiles: input.reviewOpinions.map((opinion) =>
          resolve(attemptPaths.reviewOpinionsDir, `${opinion.opinion_id}.json`)
        )
      }),
      review_input_packet_ref: input.reviewInputPacketRef,
      review_opinion_refs: reviewOpinionRefs,
      synthesized_evaluation_ref: input.evaluation
        ? this.buildAttemptEvaluationRef(
            input.reviewInputPacket.run_id,
            input.reviewInputPacket.attempt_id
          )
        : null,
      evaluation_synthesis_ref: input.evaluationSynthesis
        ? this.buildAttemptEvaluationSynthesisRef(
            input.reviewInputPacket.run_id,
            input.reviewInputPacket.attempt_id
          )
        : null,
      generated_at: new Date().toISOString()
    };
  }

  private buildAttemptHandoffBundle(input: {
    runId: string;
    attempt: Attempt;
    attemptContract: AttemptContract | null;
    preflightEvaluation: Awaited<ReturnType<typeof getAttemptPreflightEvaluation>> | null;
    currentSnapshot: CurrentDecision | null;
    failureContext: AttemptFailureContext | null;
    runtimeVerification: AttemptRuntimeVerification | null;
    adversarialVerification: AttemptAdversarialVerification | null;
    reviewPacketRef: string | null;
  }): AttemptHandoffBundle {
    return createAttemptHandoffBundle({
      attempt: input.attempt,
      approved_attempt_contract: input.attemptContract,
      preflight_evaluation: input.preflightEvaluation,
      current_decision_snapshot: input.currentSnapshot,
      failure_context: input.failureContext,
      runtime_verification: input.runtimeVerification,
      adversarial_verification: input.adversarialVerification,
      source_refs: {
        run_contract: this.buildRunContractRef(input.runId),
        attempt_meta: this.buildAttemptMetaRef(input.runId, input.attempt.id),
        attempt_contract: input.attemptContract
          ? this.buildAttemptContractRef(input.runId, input.attempt.id)
          : null,
        preflight_evaluation: input.preflightEvaluation
          ? this.buildAttemptPreflightEvaluationRef(input.runId, input.attempt.id)
          : null,
        current_decision: input.currentSnapshot
          ? this.buildCurrentDecisionRef(input.runId)
          : null,
        review_packet: input.reviewPacketRef,
        runtime_verification: input.runtimeVerification
          ? this.buildAttemptRuntimeVerificationRef(input.runId, input.attempt.id)
          : null,
        adversarial_verification: input.adversarialVerification
          ? this.buildAttemptAdversarialVerificationRef(input.runId, input.attempt.id)
          : null
      }
    });
  }

  private async buildAttemptArtifactManifest(input: {
    attemptPaths: ReturnType<typeof resolveAttemptPaths>;
    result: WorkerWriteback | null;
    runtimeVerification: AttemptRuntimeVerification | null;
    adversarialVerification: AttemptAdversarialVerification | null;
    journal: Awaited<ReturnType<typeof listRunJournal>>;
    reviewInputPacketFile: string | null;
    evaluationSynthesisFile: string | null;
    reviewOpinionFiles: string[];
  }): Promise<ReviewPacketArtifact[]> {
    const candidatePaths = new Map<string, { kind: string; rawPath: string }>();
    const addPath = (kind: string, rawPath: string | null | undefined): void => {
      if (!rawPath) {
        return;
      }

      const key = `${kind}:${rawPath}`;
      if (!candidatePaths.has(key)) {
        candidatePaths.set(key, { kind, rawPath });
      }
    };

    addPath("attempt_meta", input.attemptPaths.metaFile);
    addPath("attempt_contract", input.attemptPaths.contractFile);
    addPath("attempt_context", input.attemptPaths.contextFile);
    addPath("preflight_evaluation", input.attemptPaths.preflightEvaluationFile);
    addPath("attempt_result", input.attemptPaths.resultFile);
    addPath("attempt_evaluation", input.attemptPaths.evaluationFile);
    addPath("review_input_packet", input.reviewInputPacketFile);
    addPath("evaluation_synthesis", input.evaluationSynthesisFile);
    addPath("runtime_verification", input.attemptPaths.runtimeVerificationFile);
    addPath("adversarial_verification", input.attemptPaths.adversarialVerificationFile);
    addPath("heartbeat", input.attemptPaths.heartbeatFile);
    addPath("stdout", input.attemptPaths.stdoutFile);
    addPath("stderr", input.attemptPaths.stderrFile);
    for (const reviewOpinionPath of input.reviewOpinionFiles) {
      addPath("review_opinion", reviewOpinionPath);
    }

    for (const artifact of input.result?.artifacts ?? []) {
      addPath(`worker_${artifact.type}`, artifact.path);
    }

    for (const commandResult of input.runtimeVerification?.command_results ?? []) {
      addPath("verification_stdout", commandResult.stdout_file);
      addPath("verification_stderr", commandResult.stderr_file);
    }

    for (const command of input.adversarialVerification?.commands ?? []) {
      addPath("adversarial_output", command.output_ref);
    }

    for (const outputRef of input.adversarialVerification?.output_refs ?? []) {
      addPath("adversarial_output", outputRef);
    }

    addPath(
      "attempt.runtime_verification.self_bootstrap.publication_artifact",
      input.runtimeVerification?.synced_self_bootstrap_artifacts?.publication_artifact
    );
    addPath(
      "attempt.runtime_verification.self_bootstrap.source_asset_snapshot",
      input.runtimeVerification?.synced_self_bootstrap_artifacts?.source_asset_snapshot
    );
    addPath(
      "attempt.runtime_verification.self_bootstrap.published_active_entry",
      input.runtimeVerification?.synced_self_bootstrap_artifacts?.published_active_entry
    );

    for (const entry of input.journal) {
      const artifactPath =
        entry.payload && typeof entry.payload === "object" && "artifact_path" in entry.payload
          ? entry.payload.artifact_path
          : null;
      if (typeof artifactPath === "string" && artifactPath.length > 0) {
        addPath(entry.type, artifactPath);
      }
    }

    return await Promise.all(
      [...candidatePaths.values()].map(async ({ kind, rawPath }) => {
        const { displayPath, resolvedPath } = this.resolveReviewArtifactPath(
          input.attemptPaths.attemptDir,
          rawPath
        );

        try {
          const fileStat = await stat(resolvedPath);
          return {
            kind,
            path: displayPath,
            exists: true,
            size_bytes: fileStat.isFile() ? fileStat.size : null
          };
        } catch {
          return {
            kind,
            path: displayPath,
            exists: false,
            size_bytes: null
          };
        }
      })
    );
  }

  private resolveReviewArtifactPath(
    attemptDir: string,
    rawPath: string
  ): {
    displayPath: string;
    resolvedPath: string;
  } {
    const resolvedPath = resolve(attemptDir, rawPath);
    const relativePath = relative(attemptDir, resolvedPath);
    const displayPath =
      relativePath.length > 0 && !relativePath.startsWith("..")
        ? relativePath
        : rawPath;

    return {
      displayPath,
      resolvedPath
    };
  }

  private getReviewPacketFailureMessage(
    payload: Record<string, unknown> | undefined
  ): string | null {
    if (!payload) {
      return null;
    }

    const message = payload.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }

    const reason = payload.reason;
    if (typeof reason === "string" && reason.length > 0) {
      return reason;
    }

    return null;
  }

  private applyCheckpointOutcomeToCurrentDecision(
    current: CurrentDecision,
    attempt: Attempt,
    checkpointOutcome: AttemptCheckpointOutcome
  ): CurrentDecision {
    if (checkpointOutcome.status !== "blocked") {
      return current;
    }

    return updateCurrentDecision(current, {
      run_status: "waiting_steer",
      latest_attempt_id: attempt.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: attempt.attempt_type,
      summary: checkpointOutcome.message,
      blocking_reason: checkpointOutcome.message,
      waiting_for_human: true
    });
  }

  private applyRuntimePromotionOutcomeToCurrentDecision(
    current: CurrentDecision,
    attempt: Attempt,
    promotionOutcome: RuntimePromotionOutcome
  ): CurrentDecision {
    if (promotionOutcome.status !== "blocked") {
      return current;
    }

    return updateCurrentDecision(current, {
      run_status: "waiting_steer",
      latest_attempt_id: attempt.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: attempt.attempt_type,
      summary: promotionOutcome.message,
      blocking_reason: promotionOutcome.message,
      waiting_for_human: true
    });
  }

  private applyRuntimeSourceDriftOutcomeToCurrentDecision(
    current: CurrentDecision,
    attempt: Attempt,
    affectedFiles: string[]
  ): CurrentDecision {
    if (attempt.attempt_type !== "execution" || affectedFiles.length === 0) {
      return current;
    }

    const message = this.buildRuntimeSourceDriftMessage(affectedFiles);
    const preservedNextAction =
      current.recommended_next_action ??
      (current.recommended_attempt_type === "execution"
        ? "continue_execution"
        : current.recommended_attempt_type === "research"
          ? "continue_research"
          : "wait_for_human");
    return updateCurrentDecision(current, {
      run_status: "waiting_steer",
      latest_attempt_id: attempt.id,
      recommended_next_action: preservedNextAction,
      recommended_attempt_type: current.recommended_attempt_type ?? attempt.attempt_type,
      summary: message,
      blocking_reason: [current.blocking_reason, message].filter(Boolean).join(" "),
      waiting_for_human: true
    });
  }

  private applyMissingRuntimeRestartHandlerOutcomeToCurrentDecision(
    current: CurrentDecision,
    attempt: Attempt,
    runtimeRestartRequest: RuntimeRestartRequest | null
  ): CurrentDecision {
    if (!runtimeRestartRequest || this.requestRuntimeRestart) {
      return current;
    }

    const preservedNextAction =
      current.recommended_next_action ??
      (current.recommended_attempt_type === "execution"
        ? "continue_execution"
        : current.recommended_attempt_type === "research"
          ? "continue_research"
          : "wait_for_human");

    return updateCurrentDecision(current, {
      run_status: "waiting_steer",
      latest_attempt_id: attempt.id,
      recommended_next_action: preservedNextAction,
      recommended_attempt_type: current.recommended_attempt_type ?? attempt.attempt_type,
      summary: runtimeRestartRequest.message,
      blocking_reason: [current.blocking_reason, runtimeRestartRequest.message]
        .filter(Boolean)
        .join(" "),
      waiting_for_human: true
    });
  }

  private async appendCheckpointJournal(
    runId: string,
    attemptId: string,
    checkpointOutcome: AttemptCheckpointOutcome
  ): Promise<void> {
    if (checkpointOutcome.status === "not_applicable") {
      return;
    }

    if (checkpointOutcome.status === "created") {
      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: attemptId,
          type: "attempt.checkpoint.created",
          payload: {
            commit_sha: checkpointOutcome.commit.sha,
            commit_message: checkpointOutcome.commit.message,
            artifact_path: checkpointOutcome.artifact_path
          }
        })
      );
      return;
    }

    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: attemptId,
        type:
          checkpointOutcome.status === "blocked"
            ? "attempt.checkpoint.blocked"
            : "attempt.checkpoint.skipped",
        payload: {
          reason: checkpointOutcome.reason,
          message: checkpointOutcome.message,
          artifact_path: checkpointOutcome.artifact_path
        }
        })
      );
  }

  private async appendRuntimePromotionJournal(
    runId: string,
    attemptId: string,
    promotionOutcome: RuntimePromotionOutcome
  ): Promise<void> {
    if (promotionOutcome.status === "promoted") {
      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: attemptId,
          type: "attempt.runtime.promoted",
          payload: {
            checkpoint_sha: promotionOutcome.checkpoint_sha,
            dev_repo_root: promotionOutcome.dev_repo_root,
            runtime_repo_root: promotionOutcome.runtime_repo_root,
            artifact_path: promotionOutcome.artifact_path,
            restart_required: promotionOutcome.restart_required
          }
        })
      );

      if (promotionOutcome.restart_required) {
        await appendRunJournal(
          this.workspacePaths,
          createRunJournalEntry({
            run_id: runId,
            attempt_id: attemptId,
            type: "attempt.restart_required",
            payload: {
              reason: "runtime_promotion",
              message: promotionOutcome.message,
              affected_files: [],
              artifact_path: promotionOutcome.artifact_path,
              checkpoint_sha: promotionOutcome.checkpoint_sha
            }
          })
        );
      }
      return;
    }

    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: attemptId,
        type:
          promotionOutcome.status === "blocked"
            ? "attempt.runtime.promotion.blocked"
            : "attempt.runtime.promotion.skipped",
        payload: {
          reason: promotionOutcome.reason,
          message: promotionOutcome.message,
          artifact_path: promotionOutcome.artifact_path,
          checkpoint_sha: promotionOutcome.checkpoint_sha
        }
      })
    );
  }

  private async appendRuntimeSourceDriftJournal(
    runId: string,
    attemptId: string,
    affectedFiles: string[],
    artifactPath: string
  ): Promise<void> {
    if (affectedFiles.length === 0) {
      return;
    }

    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: attemptId,
        type: "attempt.restart_required",
        payload: {
          reason: "runtime_source_drift",
          message: this.buildRuntimeSourceDriftMessage(affectedFiles),
          affected_files: affectedFiles,
          artifact_path: artifactPath
        }
      })
    );
  }

  private buildRuntimeSourceDriftMessage(affectedFiles: string[]): string {
    return [
      "Execution changed live runtime source files already loaded by the in-process control-api/orchestrator.",
      `Restart before the next dispatch. Affected files: ${affectedFiles.join(", ")}`
    ].join(" ");
  }

  private async getSelfBootstrapActiveNextTaskContext(
    run: Run,
    runId: string,
    attempts: Attempt[],
    currentAttemptId: string
  ): Promise<{
    path: string;
    snapshot_path: string;
    source_snapshot_path: string;
    updated_at: string;
    title: string;
    summary: string;
    source_anchor: SelfBootstrapNextTaskActiveEntry["source_anchor"];
  } | null> {
    const previousAttemptCount = attempts.filter(
      (item) => item.id !== currentAttemptId
    ).length;
    if (!(previousAttemptCount === 0 && run.title === "AISA 自举下一步规划")) {
      return null;
    }

    const snapshotPath = join(
      resolveRunPaths(this.workspacePaths, runId).artifactsDir,
      SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME
    );
    let snapshot: SelfBootstrapNextTaskActiveEntry;

    try {
      snapshot = parseSelfBootstrapNextTaskActiveEntry(
        JSON.parse(await readFile(snapshotPath, "utf8"))
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `self-bootstrap blocked because active next task snapshot is missing or invalid: ${reason}`
      );
    }

    return {
      path: SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH,
      snapshot_path: relative(this.workspacePaths.rootDir, snapshotPath),
      source_snapshot_path: relative(
        this.workspacePaths.rootDir,
        join(
          resolveRunPaths(this.workspacePaths, runId).artifactsDir,
          SELF_BOOTSTRAP_NEXT_TASK_SOURCE_ASSET_SNAPSHOT_FILE_NAME
        )
      ),
      updated_at: snapshot.updated_at,
      title: snapshot.title,
      summary: snapshot.summary,
      source_anchor: snapshot.source_anchor
    };
  }

  private buildPlannedAttemptObjective(
    run: Run,
    current: CurrentDecision,
    attemptType: Attempt["attempt_type"],
    latestResult: WorkerWriteback | null
  ): string | null {
    switch (current.recommended_next_action) {
      case "start_first_attempt":
        return `理解仓库现状并找出目标的最佳下一步：${run.title}`;
      case "continue_research": {
        const checkpointResearchHint =
          current.blocking_reason?.includes("Execution auto-checkpoint")
            ? "先区分哪些改动属于这轮目标，哪些是预存现场，再留下可回放的下一轮执行约定，避免提交时继续混入脏工作区。"
            : null;
        return [
          `继续研究目标：${run.title}`,
          current.blocking_reason
            ? `先怀疑并复核这个卡点：${current.blocking_reason}`
            : "先怀疑上一轮结论，再补上缺失证据并收束到最值得做的下一步。",
          latestResult ? `最新摘要：${latestResult.summary}` : null,
          checkpointResearchHint,
          "不要延续默认假设，优先找出为什么现有方向可能不成立。"
        ]
          .filter(Boolean)
          .join("\n");
      }
      case "start_execution":
      case "continue_execution":
        return [
          `执行目标的下一项具体动作：${run.title}`,
          latestResult ? `最新摘要：${latestResult.summary}` : current.summary || null,
          current.blocking_reason ? `关注点：${current.blocking_reason}` : null,
          "在工作区留下清晰的产物和验证证据。"
        ]
          .filter(Boolean)
          .join("\n");
      case "retry_attempt":
        return [
          `重试上一轮${attemptType === "execution" ? "执行" : "研究"}尝试，目标：${run.title}`,
          current.blocking_reason
            ? `先修这个问题：${current.blocking_reason}`
            : "补强结果，让证据更具体。",
          latestResult ? `上一轮摘要：${latestResult.summary}` : null
        ]
          .filter(Boolean)
          .join("\n");
      default:
        return null;
    }
  }

  private buildSteeredAttemptObjective(
    run: Run,
    current: CurrentDecision,
    attemptType: Attempt["attempt_type"],
    latestResult: WorkerWriteback | null,
    steerMessages: string[]
  ): string {
    return [
      `应用目标的最新人工指令：${run.title}`,
      latestResult ? `最新摘要：${latestResult.summary}` : current.summary || null,
      "人工指令：",
      ...steerMessages.map((message) => `- ${message}`),
      attemptType === "execution"
        ? "做最小且有价值的改动，并留下清晰的产物和验证证据。"
        : "按人工指令收束分析，并返回有证据支撑的结论。"
    ]
      .filter(Boolean)
      .join("\n");
  }

  private buildNextCurrentDecision(input: {
    run: Run;
    current: CurrentDecision | null;
    attempt: Attempt;
    attempts: Attempt[];
    evaluation: AttemptEvaluation;
    result: WorkerWriteback;
  }): CurrentDecision {
    const { run, current, attempt, attempts, evaluation, result } = input;
    const baseCurrent = current ?? createCurrentDecision({ run_id: run.id });
    const bestAttemptId =
      evaluation.recommendation === "complete" || evaluation.goal_progress >= 0.55
        ? attempt.id
        : baseCurrent.best_attempt_id;
    const nextAttemptType = evaluation.suggested_attempt_type ?? attempt.attempt_type;

    if (this.shouldPauseAfterRepeatedAttempt(attempts, attempt, evaluation)) {
      return updateCurrentDecision(baseCurrent, {
        run_status: "waiting_steer",
        best_attempt_id: bestAttemptId,
        latest_attempt_id: attempt.id,
        recommended_next_action: "wait_for_human",
        recommended_attempt_type: nextAttemptType,
        summary: result.summary,
        blocking_reason: this.buildRepeatedAttemptPauseReason(attempt, evaluation),
        waiting_for_human: true
      });
    }

    switch (evaluation.recommendation) {
      case "complete":
        return updateCurrentDecision(baseCurrent, {
          run_status: "completed",
          best_attempt_id: attempt.id,
          latest_attempt_id: attempt.id,
          recommended_next_action: null,
          recommended_attempt_type: null,
          summary: result.summary,
          blocking_reason: null,
          waiting_for_human: false
        });
      case "retry":
        return updateCurrentDecision(baseCurrent, {
          run_status: "running",
          best_attempt_id: bestAttemptId,
          latest_attempt_id: attempt.id,
          recommended_next_action: "retry_attempt",
          recommended_attempt_type: nextAttemptType,
          summary: result.summary,
          blocking_reason: evaluation.missing_evidence[0] ?? evaluation.rationale,
          waiting_for_human: false
        });
      case "continue":
        return updateCurrentDecision(baseCurrent, {
          run_status: "running",
          best_attempt_id: bestAttemptId,
          latest_attempt_id: attempt.id,
          recommended_next_action: this.getContinueAction(attempt, nextAttemptType),
          recommended_attempt_type: nextAttemptType,
          summary: result.summary,
          blocking_reason: evaluation.missing_evidence[0] ?? null,
          waiting_for_human: false
        });
      case "wait_human":
      default:
        return updateCurrentDecision(baseCurrent, {
          run_status: "waiting_steer",
          best_attempt_id: bestAttemptId,
          latest_attempt_id: attempt.id,
          recommended_next_action: "wait_for_human",
          recommended_attempt_type: nextAttemptType,
          summary: result.summary,
          blocking_reason: evaluation.missing_evidence[0] ?? evaluation.rationale,
          waiting_for_human: true
        });
    }
  }

  private buildRunReport(
    run: Run,
    attempt: Attempt,
    result: WorkerWriteback,
    evaluation: AttemptEvaluation,
    runtimeVerification: AttemptRuntimeVerificationOutcome,
    current: CurrentDecision,
    governance: RunGovernanceState | null
  ): string {
    return [
      `# 运行报告：${run.title}`,
      "",
      `- 最新尝试：${attempt.id}`,
      `- 类型：${attempt.attempt_type}`,
      `- 运行状态：${current.run_status}`,
      `- 评估建议：${evaluation.recommendation}`,
      `- 建议的下一次类型：${evaluation.suggested_attempt_type ?? "none"}`,
      `- 验证状态：${evaluation.verification_status}`,
      `- 对抗验证：${evaluation.adversarial_verification_status}`,
      `- 运行时回放：${runtimeVerification.verification.status}`,
      "",
      "## 摘要",
      "",
      result.summary,
      "",
      "## 评估结论",
      "",
      evaluation.rationale,
      "",
      "## 运行时回放",
      "",
      runtimeVerification.verification.failure_reason ??
        `改动文件：${runtimeVerification.verification.changed_files.join(", ") || "none"}`,
      "",
      "## 下一动作",
      "",
      current.recommended_next_action ?? "暂无",
      "",
      "## 治理结论",
      "",
      governance?.context_summary.headline ?? "暂无治理结论",
      governance?.mainline_summary ? `主线：${governance.mainline_summary}` : "",
      governance?.context_summary.blocker_summary
        ? `阻塞：${governance.context_summary.blocker_summary}`
        : "",
      governance?.context_summary.avoid_summary[0]
        ? `避免：${governance.context_summary.avoid_summary[0]}`
        : ""
    ].join("\n");
  }

  private getContinueAction(
    attempt: Attempt,
    nextAttemptType: Attempt["attempt_type"]
  ): string {
    if (nextAttemptType === "execution" && attempt.attempt_type === "research") {
      return "start_execution";
    }

    return nextAttemptType === "execution" ? "continue_execution" : "continue_research";
  }

  private shouldPauseAfterRepeatedAttempt(
    attempts: Attempt[],
    attempt: Attempt,
    evaluation: AttemptEvaluation
  ): boolean {
    if (attempt.attempt_type === "execution" && evaluation.verification_status === "passed") {
      return false;
    }

    if (!["continue", "retry"].includes(evaluation.recommendation)) {
      return false;
    }

    const nextAttemptType = evaluation.suggested_attempt_type ?? attempt.attempt_type;
    if (nextAttemptType !== attempt.attempt_type) {
      return false;
    }

    return this.countTrailingCompletedAttemptsOfType(attempts, attempt.attempt_type) >= 2;
  }

  private buildRepeatedAttemptPauseReason(
    attempt: Attempt,
    evaluation: AttemptEvaluation
  ): string {
    const repeatedPauseMessage = `Loop paused after repeated ${attempt.attempt_type} attempts without fresh progress.`;

    return [evaluation.missing_evidence.join(" "), repeatedPauseMessage]
      .filter((value) => value.length > 0)
      .join(" ");
  }

  private countTrailingCompletedAttemptsOfType(
    attempts: Attempt[],
    attemptType: Attempt["attempt_type"]
  ): number {
    const orderedAttempts = [...attempts].sort((left, right) =>
      left.created_at.localeCompare(right.created_at)
    );
    let count = 0;

    for (let index = orderedAttempts.length - 1; index >= 0; index -= 1) {
      const attempt = orderedAttempts[index];
      if (attempt.status !== "completed" || attempt.attempt_type !== attemptType) {
        break;
      }
      count += 1;
    }

    return count;
  }

  private getLatestAttempt(
    current: CurrentDecision,
    attempts: Attempt[]
  ): Attempt | null {
    const latestAttempt =
      (current.latest_attempt_id
        ? attempts.find((attempt) => attempt.id === current.latest_attempt_id)
        : null) ?? attempts.at(-1);

    return latestAttempt ?? null;
  }

  private async findLatestExecutionContractDraft(
    runId: string,
    attempts: Attempt[]
  ): Promise<AttemptContractDraft | null> {
    const orderedAttempts = [...attempts].sort((left, right) =>
      right.created_at.localeCompare(left.created_at)
    );

    for (const attempt of orderedAttempts) {
      const result = await getAttemptResult(this.workspacePaths, runId, attempt.id);
      if (isExecutionContractDraft(result?.next_attempt_contract)) {
        return result.next_attempt_contract;
      }
    }

    return null;
  }

  private async getPublishedSelfBootstrapExecutionDraft(
    run: Run,
    runId: string
  ): Promise<AttemptContractDraft | null> {
    if (run.title !== "AISA 自举下一步规划") {
      return null;
    }

    const snapshotPath = join(
      resolveRunPaths(this.workspacePaths, runId).artifactsDir,
      SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME
    );
    let snapshot: SelfBootstrapNextTaskActiveEntry;

    try {
      snapshot = parseSelfBootstrapNextTaskActiveEntry(
        JSON.parse(await readFile(snapshotPath, "utf8"))
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `self-bootstrap blocked because active next task snapshot is missing or invalid while building execution contract: ${reason}`
      );
    }

    const sourceSnapshotPath = join(
      resolveRunPaths(this.workspacePaths, runId).artifactsDir,
      SELF_BOOTSTRAP_NEXT_TASK_SOURCE_ASSET_SNAPSHOT_FILE_NAME
    );
    let sourceSnapshot;

    try {
      sourceSnapshot = await loadSelfBootstrapNextTaskSourceAssetSnapshot({
        absolutePath: sourceSnapshotPath,
        path: relative(this.workspacePaths.rootDir, sourceSnapshotPath)
      });
      assertSelfBootstrapNextTaskSourceAnchorMatchesPayload({
        sourceAnchor: snapshot.source_anchor,
        observedPath: sourceSnapshot.path,
        observedPayloadSha256: sourceSnapshot.payload_sha256,
        subjectLabel: "run-local active next task source snapshot"
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `self-bootstrap blocked because active next task source snapshot is missing or invalid while building execution contract: ${reason}`
      );
    }

    let liveSourceAsset;
    try {
      liveSourceAsset = await loadSelfBootstrapNextTaskSourceAsset({
        workspaceRoot: run.workspace_root,
        sourceAssetPath: snapshot.source_anchor.asset_path
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `self-bootstrap blocked because active next task source drifted after run start while building execution contract: ${reason}`
      );
    }

    if (liveSourceAsset.payload_sha256 !== sourceSnapshot.payload_sha256) {
      throw new Error(
        [
          "self-bootstrap blocked because active next task source drifted after run start while building execution contract:",
          `${snapshot.source_anchor.asset_path} payload_sha256 changed from ${sourceSnapshot.payload_sha256} to ${liveSourceAsset.payload_sha256}`
        ].join(" ")
      );
    }

    return sourceSnapshot.draft.attempt_type === "execution"
      ? sourceSnapshot.draft
      : null;
  }

  private async resolveExecutionContractPlanningState(input: {
    run: Run;
    runId: string;
    objective: string;
    nextExecutionDraft: AttemptContractDraft | null;
    latestAttempt: Attempt | null;
    recommendedNextAction: string | null;
    steerMessages: string[];
  }): Promise<{
    draft: AttemptContractDraft | null;
    reusableExecutionContract: AttemptContract | null;
  }> {
    const steerIntent = classifyExecutionSteerIntent(input.steerMessages);
    const shouldCarryForwardPreviousExecutionPlan =
      input.recommendedNextAction === "retry_attempt" ||
      input.recommendedNextAction === "continue_execution" ||
      steerIntent === "preserve_existing_contract";
    const alignedDraft =
      isExecutionContractDraft(input.nextExecutionDraft) &&
      (shouldCarryForwardPreviousExecutionPlan ||
        (steerIntent !== "replace_existing_contract" &&
          executionObjectivesDescribeSameWork(
            input.objective,
            input.nextExecutionDraft.objective
          )))
        ? input.nextExecutionDraft
        : null;
    const publishedDraft = alignedDraft
      ? null
      : await this.getPublishedSelfBootstrapExecutionDraft(input.run, input.runId);
    const reusableExecutionContractCandidate =
      input.latestAttempt?.attempt_type === "execution" &&
      ["retry_attempt", "continue_execution", "apply_steer"].includes(
        input.recommendedNextAction ?? ""
      )
        ? await getAttemptContract(this.workspacePaths, input.run.id, input.latestAttempt.id)
        : null;

    return {
      draft:
        alignedDraft ??
        (publishedDraft &&
        executionObjectivesDescribeSameWork(input.objective, publishedDraft.objective)
          ? publishedDraft
          : null),
      reusableExecutionContract:
        reusableExecutionContractCandidate &&
        (shouldCarryForwardPreviousExecutionPlan ||
          (steerIntent !== "replace_existing_contract" &&
            executionObjectivesDescribeSameWork(
              input.objective,
              reusableExecutionContractCandidate.objective
            )))
          ? reusableExecutionContractCandidate
          : null
    };
  }

  private async buildAttemptContract(
    run: Run,
    attempt: Attempt,
    nextExecutionDraft: AttemptContractDraft | null,
    reusableExecutionContract: AttemptContract | null
  ): Promise<AttemptContract> {
    const harnessProfile = resolveRunHarnessProfile(run);
    if (attempt.attempt_type === "execution") {
      const postflightAdversarialGateRequired = isPostflightAdversarialGateRequired(run);
      const draft = isExecutionContractDraft(nextExecutionDraft)
        ? nextExecutionDraft
        : null;
      const draftVerifierKit =
        draft?.attempt_type === "execution" ? draft.verifier_kit : null;
      const verifierKit =
        draftVerifierKit ??
        resolveExecutionVerifierKit(reusableExecutionContract) ??
        harnessProfile.execution.default_verifier_kit;
      const inferredVerificationPlan =
        draft?.verification_plan ??
        reusableExecutionContract?.verification_plan ??
        (await this.inferDefaultExecutionVerificationPlan(attempt.workspace_root, verifierKit));
      return createAttemptContract({
        attempt_id: attempt.id,
        run_id: run.id,
        attempt_type: attempt.attempt_type,
        objective: attempt.objective,
        success_criteria: attempt.success_criteria,
        required_evidence: normalizeExecutionRequiredEvidence(
          draft?.required_evidence ??
            reusableExecutionContract?.required_evidence ??
            buildDefaultExecutionRequiredEvidence(postflightAdversarialGateRequired),
          postflightAdversarialGateRequired
        ),
        adversarial_verification_required: postflightAdversarialGateRequired,
        verifier_kit: verifierKit,
        done_rubric: normalizeExecutionDoneRubric(
          draft && draft.done_rubric.length > 0
            ? draft.done_rubric
            : reusableExecutionContract && reusableExecutionContract.done_rubric.length > 0
              ? reusableExecutionContract.done_rubric
              : buildDefaultExecutionDoneRubric(postflightAdversarialGateRequired),
          postflightAdversarialGateRequired
        ),
        failure_modes: normalizeExecutionFailureModes(
          draft && draft.failure_modes.length > 0
            ? draft.failure_modes
            : reusableExecutionContract && reusableExecutionContract.failure_modes.length > 0
              ? reusableExecutionContract.failure_modes
              : buildDefaultExecutionFailureModes(postflightAdversarialGateRequired),
          postflightAdversarialGateRequired
        ),
        forbidden_shortcuts: normalizeExecutionForbiddenShortcuts(
          draft?.forbidden_shortcuts ??
            reusableExecutionContract?.forbidden_shortcuts ??
            buildDefaultExecutionForbiddenShortcuts(postflightAdversarialGateRequired),
          postflightAdversarialGateRequired
        ),
        expected_artifacts: normalizeExecutionExpectedArtifacts(
          draft?.expected_artifacts ??
            reusableExecutionContract?.expected_artifacts ??
            buildDefaultExecutionExpectedArtifacts(postflightAdversarialGateRequired),
          postflightAdversarialGateRequired
        ),
        verification_plan: inferredVerificationPlan
      });
    }

    return createAttemptContract({
      attempt_id: attempt.id,
      run_id: run.id,
      attempt_type: attempt.attempt_type,
      objective: attempt.objective,
      success_criteria: attempt.success_criteria,
      required_evidence: [
        "Ground findings in concrete files, commands, or artifacts.",
        "If execution is recommended, leave a replayable execution contract for the next attempt."
      ],
      forbidden_shortcuts: [
        "Do not claim repository facts without evidence.",
        "Do not recommend execution without replayable verification steps."
      ],
      expected_artifacts: ["grounded findings or notes"]
    });
  }

  private async inferDefaultExecutionVerificationPlan(
    workspaceRoot: string,
    verifierKit: ExecutionVerifierKit = DEFAULT_EXECUTION_VERIFIER_KIT
  ): Promise<ExecutionVerificationPlan | undefined> {
    if (!executionVerifierKitAllowsWorkspaceScriptInference(verifierKit)) {
      return undefined;
    }

    const scripts = await readWorkspacePackageScripts(workspaceRoot);
    if (!scripts) {
      return undefined;
    }

    const commands = buildDefaultExecutionVerificationCommandsFromScripts(scripts);
    if (commands.length === 0) {
      return undefined;
    }

    if (!(await workspaceHasLocalNodeModules(workspaceRoot))) {
      return undefined;
    }

    return { commands };
  }

  private buildMissingVerificationToolchainMessage(
    attempt: Attempt,
    assessment: ExecutionVerificationToolchainAssessment
  ): string | null {
    if (
      assessment.command_policy === "workspace_script_inference" &&
      assessment.has_package_json &&
      !assessment.has_local_node_modules &&
      assessment.inferred_pnpm_commands.length > 0
    ) {
      return [
        `Execution attempt ${attempt.id} is blocked before dispatch because ${attempt.workspace_root} has package.json verification scripts but no local node_modules.`,
        `Runtime refused to auto-generate ${formatVerificationCommands(assessment.inferred_pnpm_commands)}.`,
        "Add the local verifier toolchain or lock direct replay commands into attempt_contract.json."
      ].join(" ");
    }

    return null;
  }

  private buildBlockedPnpmVerificationMessage(
    attempt: Attempt,
    assessment: ExecutionVerificationToolchainAssessment
  ): string | null {
    if (
      !assessment.has_local_node_modules &&
      assessment.blocked_pnpm_commands.length > 0
    ) {
      return [
        `Execution attempt ${attempt.id} is blocked before dispatch because attempt_contract.json asks runtime to replay ${formatVerificationCommands(assessment.blocked_pnpm_commands)}.`,
        `${attempt.workspace_root} has no local node_modules, so those pnpm commands are not replayable here.`,
        "Add the local verifier toolchain or replace the pnpm commands with direct replay commands."
      ].join(" ");
    }

    return null;
  }

  private buildAttemptPreflightEvaluationRef(runId: string, attemptId: string): string {
    return `runs/${runId}/attempts/${attemptId}/artifacts/preflight-evaluation.json`;
  }

  private buildAttemptContractPreflightSummary(
    attemptContract: AttemptContract | null
  ): NonNullable<
    Parameters<typeof createAttemptPreflightEvaluation>[0]["contract"]
  > | null {
    if (!attemptContract) {
      return null;
    }

    return {
      has_required_evidence: attemptContract.required_evidence.length > 0,
      requires_adversarial_verification:
        attemptContract.adversarial_verification_required === true,
      verifier_kit: resolveExecutionVerifierKit(attemptContract),
      has_done_rubric: attemptContract.done_rubric.length > 0,
      has_failure_modes: attemptContract.failure_modes.length > 0,
      has_verification_plan: (attemptContract.verification_plan?.commands.length ?? 0) > 0,
      done_rubric_codes: attemptContract.done_rubric.map(
        (item: AttemptContract["done_rubric"][number]) => item.code
      ),
      failure_mode_codes: attemptContract.failure_modes.map(
        (item: AttemptContract["failure_modes"][number]) => item.code
      ),
      verification_commands:
        attemptContract.verification_plan?.commands.map(
          (item: VerificationCommand) => item.command
        ) ?? []
    };
  }

  private async runAttemptDispatchPreflight(input: {
    run: Run;
    runId: string;
    attempt: Attempt;
    attemptContract: AttemptContract | null;
    attemptPaths: ReturnType<typeof resolveAttemptPaths>;
  }): Promise<AttemptDispatchPreflightOutcome> {
    if (input.attempt.attempt_type !== "execution") {
      if (!input.attemptContract) {
        throw new Error(
          `Attempt ${input.attempt.id} is missing attempt_contract.json. Dispatch is blocked until the contract is recreated.`
        );
      }
      return {
        dispatchableAttemptContract: input.attemptContract,
        checkpointPreflight: null
      };
    }

    const postflightAdversarialGateMode =
      resolveRunHarnessProfile(input.run).gates.postflight_adversarial.mode;
    const verifierKit =
      resolveExecutionVerifierKit(input.attemptContract) ?? DEFAULT_EXECUTION_VERIFIER_KIT;
    const verifierKitView = buildExecutionVerifierKitView({
      kit: verifierKit,
      source: "attempt_contract.verifier_kit"
    });
    const checkpointPreflight = await captureAttemptCheckpointPreflight({
      run: input.run,
      attempt: input.attempt,
      attemptPaths: input.attemptPaths
    });
    const assessment = await assessExecutionVerificationToolchain({
      workspaceRoot: input.attempt.workspace_root,
      verifierKit,
      verificationPlan: input.attemptContract.verification_plan ?? null
    });
    const contractSummary = this.buildAttemptContractPreflightSummary(input.attemptContract);
    const checks: AttemptPreflightCheck[] = [];
    const addCheck = (
      code: string,
      status: AttemptPreflightCheck["status"],
      message: string
    ): void => {
      checks.push({
        code,
        status,
        message
      });
    };

    let failureCode: AttemptPreflightFailureCode | null = null;
    let failureReason: string | null = null;

    const preflightSlotResolution = resolveRunHarnessSlotBinding({
      run: input.run,
      slot: "preflight_review"
    });
    if (preflightSlotResolution.ok) {
      addCheck(
        "slot_preflight_review_binding",
        "passed",
        `Preflight is running through ${preflightSlotResolution.binding}.`
      );
    } else {
      failureCode = "slot_binding_mismatch";
      failureReason = preflightSlotResolution.failure_reason;
      addCheck("slot_preflight_review_binding", "failed", failureReason);
    }

    const executionSlotResolution = resolveRunHarnessSlotBinding({
      run: input.run,
      slot: "execution",
      workerAdapterType: this.adapter.type
    });
    if (executionSlotResolution.ok) {
      addCheck(
        "slot_execution_binding",
        "passed",
        `Execution will dispatch through ${executionSlotResolution.binding}.`
      );
    } else if (!failureReason) {
      failureCode = "slot_binding_mismatch";
      failureReason = executionSlotResolution.failure_reason;
      addCheck("slot_execution_binding", "failed", failureReason);
    } else {
      addCheck(
        "slot_execution_binding",
        "not_applicable",
        "execution slot binding check was skipped after an earlier preflight failure."
      );
    }

    if (input.attemptContract) {
      addCheck("attempt_contract_present", "passed", "attempt_contract.json is present.");
    } else {
      failureCode = "missing_attempt_contract";
      failureReason = `Attempt ${input.attempt.id} is missing attempt_contract.json. Dispatch is blocked until the contract is recreated.`;
      addCheck("attempt_contract_present", "failed", failureReason);
    }

    addCheck(
      "verifier_kit_policy_loaded",
      "passed",
      verifierKitView.command_policy === "workspace_script_inference"
        ? `${verifierKitView.title} uses workspace_script_inference, so preflight may infer replay commands from local workspace scripts when the repo toolchain is already present.`
        : `${verifierKitView.title} uses contract_locked_commands, so preflight requires explicit replay commands instead of auto-inferring workspace scripts.`
    );
    addCheck(
      "postflight_adversarial_gate_mode",
      "passed",
      postflightAdversarialGateMode === "required"
        ? "Run harness profile requires the postflight adversarial gate for this execution."
        : "Run harness profile sets the postflight adversarial gate to disabled for this execution."
    );

    if (
      postflightAdversarialGateMode === "required" &&
      contractSummary?.requires_adversarial_verification
    ) {
      addCheck(
        "adversarial_verification_required",
        "passed",
        "Execution contract explicitly requires adversarial verification."
      );
    } else if (
      postflightAdversarialGateMode === "required" &&
      !failureReason
    ) {
      failureCode = "missing_adversarial_verification_requirement";
      failureReason = `Execution attempt ${input.attempt.id} is blocked before dispatch because attempt_contract.json does not explicitly require adversarial verification.`;
      addCheck("adversarial_verification_required", "failed", failureReason);
    } else if (
      postflightAdversarialGateMode === "disabled" &&
      contractSummary?.requires_adversarial_verification
    ) {
      failureCode = "adversarial_gate_profile_mismatch";
      failureReason = `Execution attempt ${input.attempt.id} is blocked before dispatch because the postflight adversarial gate is disabled in run.harness_profile.gates.postflight_adversarial.mode, but attempt_contract.json still requires postflight adversarial verification.`;
      addCheck("adversarial_verification_required", "failed", failureReason);
    } else if (postflightAdversarialGateMode === "disabled") {
      addCheck(
        "adversarial_verification_required",
        "passed",
        "Execution contract correctly leaves the postflight adversarial requirement disabled."
      );
    } else {
      addCheck(
        "adversarial_verification_required",
        "not_applicable",
        "adversarial verification requirement check was skipped after an earlier preflight failure."
      );
    }

    if (contractSummary?.has_done_rubric) {
      addCheck("done_rubric_present", "passed", "Execution contract includes done_rubric.");
    } else if (!failureReason) {
      failureCode = "missing_done_rubric";
      failureReason = `Execution attempt ${input.attempt.id} is blocked before dispatch because attempt_contract.json is missing done_rubric.`;
      addCheck("done_rubric_present", "failed", failureReason);
    } else {
      addCheck(
        "done_rubric_present",
        "not_applicable",
        "done_rubric check was skipped after an earlier preflight failure."
      );
    }

    if (contractSummary?.has_failure_modes) {
      addCheck("failure_modes_present", "passed", "Execution contract includes failure_modes.");
    } else if (!failureReason) {
      failureCode = "missing_failure_modes";
      failureReason = `Execution attempt ${input.attempt.id} is blocked before dispatch because attempt_contract.json is missing failure_modes.`;
      addCheck("failure_modes_present", "failed", failureReason);
    } else {
      addCheck(
        "failure_modes_present",
        "not_applicable",
        "failure_modes check was skipped after an earlier preflight failure."
      );
    }

    const missingVerificationPlanMessage =
      this.buildMissingVerificationToolchainMessage(input.attempt, assessment) ??
      `Execution attempt ${input.attempt.id} is missing replayable verification commands in attempt_contract.json.`;
    if (contractSummary?.has_verification_plan) {
      addCheck(
        "verification_plan_present",
        "passed",
        "Execution contract includes replayable verification commands."
      );
    } else if (!failureReason) {
      failureCode = "missing_contract_verification_plan";
      failureReason = missingVerificationPlanMessage;
      addCheck("verification_plan_present", "failed", failureReason);
    } else {
      addCheck(
        "verification_plan_present",
        "not_applicable",
        "verification_plan check was skipped after an earlier preflight failure."
      );
    }

    if (checkpointPreflight?.status === "ready" && checkpointPreflight.repo_root) {
      addCheck(
        "workspace_is_git_repo",
        "passed",
        "Execution workspace is a git repository and can capture a real preflight baseline."
      );
    } else if (!failureReason) {
      failureCode = "workspace_not_git_repo";
      failureReason = `Execution attempt ${input.attempt.id} is blocked before dispatch because ${input.attempt.workspace_root} is not a git repository, so the runtime cannot capture a preflight baseline.`;
      addCheck("workspace_is_git_repo", "failed", failureReason);
    } else {
      addCheck(
        "workspace_is_git_repo",
        "not_applicable",
        "git baseline check was skipped after an earlier preflight failure."
      );
    }

    const unrunnableVerificationCommand =
      assessment.unrunnable_verification_commands[0] ?? null;
    if (failureReason) {
      addCheck(
        "verification_commands_runnable",
        "not_applicable",
        "verification command probe was skipped after an earlier preflight failure."
      );
    } else if (!unrunnableVerificationCommand) {
      addCheck(
        "verification_commands_runnable",
        "passed",
        "Replay commands resolved to runnable executables in the declared workspace cwd."
      );
    } else {
      failureCode = "verification_command_not_runnable";
      failureReason = unrunnableVerificationCommand.reason;
      addCheck("verification_commands_runnable", "failed", failureReason);
    }

    const blockedPnpmMessage = this.buildBlockedPnpmVerificationMessage(
      input.attempt,
      assessment
    );
    if (failureReason) {
      addCheck(
        "pnpm_replay_commands_locally_available",
        "not_applicable",
        "pnpm replay check was skipped after an earlier preflight failure."
      );
    } else if (blockedPnpmMessage === null) {
      addCheck(
        "pnpm_replay_commands_locally_available",
        "passed",
        "Replay commands are locally runnable in this workspace."
      );
    } else {
      failureCode = "blocked_pnpm_verification_plan";
      failureReason = blockedPnpmMessage;
      addCheck("pnpm_replay_commands_locally_available", "failed", failureReason);
    }

    const evaluation = createAttemptPreflightEvaluation({
      run_id: input.runId,
      attempt_id: input.attempt.id,
      attempt_type: input.attempt.attempt_type,
      status: failureReason ? "failed" : "passed",
      failure_code: failureCode,
      failure_reason: failureReason,
      contract: contractSummary,
      toolchain_assessment: assessment,
      checkpoint_preflight: checkpointPreflight,
      checks
    });
    await saveAttemptPreflightEvaluation(this.workspacePaths, evaluation);

    const artifactPath = this.buildAttemptPreflightEvaluationRef(
      input.runId,
      input.attempt.id
    );
    const failureSignal = deriveFailureSignalFromPreflight({
      preflight: evaluation,
      sourceRef: artifactPath
    });
    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: input.runId,
        attempt_id: input.attempt.id,
        type: failureReason ? "attempt.preflight.failed" : "attempt.preflight.passed",
        payload: {
          status: evaluation.status,
          failure_class: failureSignal?.failure_class ?? null,
          failure_policy_mode: failureSignal?.policy_mode ?? null,
          failure_code: evaluation.failure_code,
          message: evaluation.failure_reason,
          artifact_path: artifactPath
        }
      })
    );

    if (failureReason) {
      throw new Error(failureReason);
    }

    return {
      dispatchableAttemptContract: input.attemptContract!,
      checkpointPreflight
    };
  }

  private getActiveAttemptKey(runId: string, attemptId: string): string {
    return `${runId}:${attemptId}`;
  }

  private async maybeAutoResumeWaitingRun(
    runId: string,
    _current: CurrentDecision,
    _attempts: Attempt[]
  ): Promise<void> {
    await this.withRunDispatchLease(runId, "auto_resume_waiting_run", async () => {
      const [current, attempts, automation] = await Promise.all([
        getCurrentDecision(this.workspacePaths, runId),
        listAttempts(this.workspacePaths, runId),
        this.loadRunAutomationControl(runId)
      ]);
      if (
        !current ||
        current.run_status !== "waiting_steer" ||
        this.waitingHumanAutoResumeMs <= 0
      ) {
        return;
      }

      const journal = await listRunJournal(this.workspacePaths, runId);
      if (
        automation.mode === "manual_only" ||
        (!automation.reason_code && this.isAutomaticResumeSuppressed(journal))
      ) {
        return;
      }
      const autoResumePolicy = await this.getAutomaticResumePolicy({
        current,
        attempts,
        journal
      });
      const updatedAtMs = Date.parse(current.updated_at);
      if (Number.isNaN(updatedAtMs) || Date.now() - updatedAtMs < autoResumePolicy.delayMs) {
        return;
      }

      const automaticResumeCount = this.countAutomaticResumeCyclesSinceLastSteer(
        journal,
        autoResumePolicy.reasonPrefix
      );
      const latestAttempt = this.getLatestAttempt(current, attempts);
      const latestHandoffBundle = latestAttempt
        ? await getAttemptHandoffBundle(this.workspacePaths, runId, latestAttempt.id)
        : null;
      const latestHandoffBundleRef = latestAttempt
        ? this.buildAttemptHandoffBundleRef(runId, latestAttempt.id)
        : null;

      if (automaticResumeCount >= autoResumePolicy.maxCycles) {
        await this.persistAutomaticResumeExhausted(runId, current, journal, automaticResumeCount);
        return;
      }

      const blocker = await this.detectAutomaticResumeBlocker({
        runId,
        current,
        attempts,
        journal,
        latestAttempt,
        latestHandoffBundle,
        latestHandoffBundleRef
      });

      if (blocker) {
        await this.persistAutomaticResumeBlocked(runId, current, journal, blocker);
        return;
      }

      const plan = await this.buildAutomaticResumePlan({
        runId,
        current,
        attempts,
        journal,
        latestAttempt,
        latestHandoffBundle,
        latestHandoffBundleRef
      });

      if (!plan) {
        await this.persistAutomaticResumeBlocked(runId, current, journal);
        return;
      }

      await saveCurrentDecision(
        this.workspacePaths,
        updateCurrentDecision(current, {
          run_status: "running",
          recommended_next_action: plan.next_action,
          recommended_attempt_type: plan.attempt_type,
          summary: plan.summary,
          blocking_reason: plan.blocking_reason,
          waiting_for_human: false
        })
      );
      await appendRunJournal(
        this.workspacePaths,
        createRunJournalEntry({
          run_id: runId,
          attempt_id: current.latest_attempt_id,
          type: "run.auto_resume.scheduled",
          payload: {
            cycle: automaticResumeCount + 1,
            next_action: plan.next_action,
            attempt_type: plan.attempt_type,
            reason: plan.reason,
            handoff_bundle_ref: plan.handoffBundleRef
          }
        })
      );
      await refreshRunOperatorSurface(this.workspacePaths, runId);
    });
  }

  private isAutomaticResumeSuppressed(
    journal: Awaited<ReturnType<typeof listRunJournal>>
  ): boolean {
    for (let index = journal.length - 1; index >= 0; index -= 1) {
      const entry = journal[index];
      if (!entry) {
        continue;
      }

      if (this.isAutoResumeResetBoundary(entry.type)) {
        return false;
      }

      if (entry.type === "run.self_bootstrap.superseded") {
        return true;
      }
    }

    return false;
  }

  private async detectAutomaticResumeBlocker(input: {
    runId: string;
    current: CurrentDecision;
    attempts: Attempt[];
    journal: Awaited<ReturnType<typeof listRunJournal>>;
    latestAttempt: Attempt | null;
    latestHandoffBundle: AttemptHandoffBundle | null;
    latestHandoffBundleRef: string | null;
  }): Promise<{
    reason: string;
    message: string;
    failureClass?: string;
    failurePolicyMode?: string;
    failureCode?: string;
    handoffBundleRef?: string | null;
  } | null> {
    const governance = await getRunGovernanceState(this.workspacePaths, input.runId);
    if (governance?.status === "blocked" && governance.blocker_repeat_count >= 2) {
      return {
        reason: "governance_repeated_blocker",
        message:
          governance.context_summary.blocker_summary ?? governance.context_summary.headline
      };
    }

    const policyGate = await this.readRunPolicyGate({
      runId: input.runId
    });
    if (policyGate.status === "invalid") {
      return {
        reason: "policy_runtime_invalid",
        message: "Policy runtime is unreadable, so automatic resume stays blocked."
      };
    }

    const policyRuntime =
      policyGate.status === "ready" ? policyGate.policy : null;
    if (
      policyRuntime?.approval_required === true &&
      policyRuntime.proposed_attempt_type === "execution" &&
      policyRuntime.approval_status === "pending"
    ) {
      return {
        reason: "policy_approval_pending",
        message:
          policyRuntime.blocking_reason ??
          "Execution plan is still pending leader approval."
      };
    }

    if (
      policyRuntime?.approval_required === true &&
      policyRuntime.proposed_attempt_type === "execution" &&
      policyRuntime.approval_status === "rejected"
    ) {
      return {
        reason: "policy_approval_rejected",
        message:
          policyRuntime.blocking_reason ??
          "Execution plan was rejected and must be replanned before auto-resume."
      };
    }

    if (policyRuntime?.killswitch_active) {
      return {
        reason: "policy_killswitch_active",
        message:
          policyRuntime.killswitch_reason ??
          "Execution is paused because the policy killswitch is active."
      };
    }

    const workspaceScopeMessage = this.getRunWorkspaceScopeBlockedMessage(
      input.journal,
      input.latestAttempt?.id ?? input.current.latest_attempt_id ?? null
    );
    if (workspaceScopeMessage) {
      return {
        reason: "workspace_scope_blocked",
        message: workspaceScopeMessage
      };
    }

    const workingContextView = await readRunWorkingContextView(
      this.workspacePaths,
      input.runId
    );
    const run = await getRun(this.workspacePaths, input.runId);
    const effectivePolicyBundle = run
      ? this.describeRunEffectivePolicyBundle(run)
      : null;
    const latestAttemptIsSettled =
      input.latestAttempt?.status === "completed" || input.latestAttempt?.status === "failed";
    const canRecoverFromSettledHandoff =
      latestAttemptIsSettled && input.latestHandoffBundle !== null;
    if (
      workingContextView.working_context_degraded.is_degraded &&
      !canRecoverFromSettledHandoff &&
      (input.latestAttempt !== null ||
        workingContextView.working_context_degraded.reason_code !== "context_missing")
    ) {
      return {
        reason: "working_context_degraded",
        message:
          workingContextView.working_context_degraded.summary ??
          "Working context is degraded, so automatic resume stays blocked.",
        failureClass: "working_context_degraded",
        failurePolicyMode: "fail_closed",
        failureCode: workingContextView.working_context_degraded.reason_code ?? null
      };
    }

    if (!input.latestAttempt) {
      return null;
    }

    if (
      canRecoverFromSettledHandoff &&
      effectivePolicyBundle &&
      !effectivePolicyBundle.recovery.auto_resume_from_settled_handoff
    ) {
      return {
        reason: "profile_manual_recovery",
        message:
          "Low reviewer effort keeps settled handoff recovery in manual recovery mode, so automatic resume stays blocked.",
        handoffBundleRef: input.latestHandoffBundleRef
      };
    }

    const preflightBlocker =
      input.latestAttempt.attempt_type === "execution"
        ? this.getAutomaticResumePreflightBlocker({
            handoffBundle: input.latestHandoffBundle,
            handoffBundleRef: input.latestHandoffBundleRef
          })
        : null;
    if (preflightBlocker) {
      return preflightBlocker;
    }

    const runtimeVerificationBlocker =
      input.latestAttempt.attempt_type === "execution"
        ? this.getAutomaticResumeRuntimeVerificationBlocker({
            handoffBundle: input.latestHandoffBundle,
            handoffBundleRef: input.latestHandoffBundleRef
          })
        : null;
    if (runtimeVerificationBlocker) {
      return runtimeVerificationBlocker;
    }

    const adversarialVerificationBlocker =
      input.latestAttempt.attempt_type === "execution"
        ? this.getAutomaticResumeAdversarialVerificationBlocker({
            handoffBundle: input.latestHandoffBundle,
            handoffBundleRef: input.latestHandoffBundleRef
          })
        : null;
    if (adversarialVerificationBlocker) {
      return adversarialVerificationBlocker;
    }

    const restartRequiredEntry = this.getLatestAttemptJournalEntry(
      input.journal,
      input.latestAttempt.id,
      ["attempt.restart_required"]
    );
    const restartRequiredMessage = restartRequiredEntry
      ? this.getReviewPacketFailureMessage(restartRequiredEntry.payload)
      : null;
    if (
      restartRequiredMessage &&
      !this.hasRuntimeRestartedSinceJournalEntry(restartRequiredEntry?.ts)
    ) {
      return {
        reason: "runtime_source_drift",
        message: restartRequiredMessage
      };
    }

    if (input.latestAttempt.status !== "failed") {
      return null;
    }

    const failureMessage = await this.getLatestAttemptFailureMessage({
      current: input.current,
      journal: input.journal,
      latestAttempt: input.latestAttempt,
      handoffBundle: input.latestHandoffBundle
    });
    const failureMode = this.classifyFailureMode(failureMessage);

    if (failureMode === "worker_output_schema_invalid" && failureMessage) {
      return {
        reason: "worker_output_schema_invalid",
        message: `上一轮${input.latestAttempt.attempt_type === "execution" ? "execution" : "research"}的 worker 输出不符合结果契约，自动续跑已暂停。原始阻塞：${failureMessage}`,
        failureCode: "worker_output_schema_invalid",
        handoffBundleRef: input.latestHandoffBundleRef
      };
    }

    if (failureMode !== "provider_auth_failed" || !failureMessage) {
      return null;
    }

    return {
      reason: failureMode,
      message: `上一轮${input.latestAttempt.attempt_type === "execution" ? "execution" : "research"}命中 provider 鉴权失败，自动续跑已暂停。原始阻塞：${failureMessage}`,
      handoffBundleRef: input.latestHandoffBundleRef
    };
  }

  private async buildAutomaticResumePlan(input: {
    runId: string;
    current: CurrentDecision;
    attempts: Attempt[];
    journal: Awaited<ReturnType<typeof listRunJournal>>;
    latestAttempt: Attempt | null;
    latestHandoffBundle: AttemptHandoffBundle | null;
    latestHandoffBundleRef: string | null;
  }): Promise<
    | {
        next_action: string;
        attempt_type: Attempt["attempt_type"];
        summary: string;
        blocking_reason: string | null;
        reason: string;
        handoffBundleRef: string | null;
      }
    | null
  > {
    const governance = await getRunGovernanceState(this.workspacePaths, input.runId);
    const recoveryGuidance = deriveRunRecoveryGuidance({
      current: input.current,
      latestAttempt: input.latestAttempt,
      latestHandoffBundle: input.latestHandoffBundle,
      latestHandoffBundleRef: input.latestHandoffBundleRef
    });
    if (!input.latestAttempt) {
      return {
        next_action: recoveryGuidance.nextAction,
        attempt_type: recoveryGuidance.attemptType,
        summary: `人工窗口超时，${recoveryGuidance.summary}`,
        blocking_reason: recoveryGuidance.blockingReason,
        reason: "no_attempts_yet",
        handoffBundleRef: recoveryGuidance.handoffBundleRef
      };
    }

    const restartRequiredEntry = this.getLatestAttemptJournalEntry(
      input.journal,
      input.latestAttempt.id,
      ["attempt.restart_required"]
    );
    if (
      restartRequiredEntry &&
      this.hasRuntimeRestartedSinceJournalEntry(restartRequiredEntry.ts) &&
      input.latestAttempt.attempt_type === "execution"
    ) {
      return {
        next_action: "continue_execution",
        attempt_type: "execution",
        summary: "检测到 runtime 已在 source drift 后重启，系统继续上一轮 execution。",
        blocking_reason: null,
        reason: "runtime_restarted_continue_execution",
        handoffBundleRef: input.latestHandoffBundleRef
      };
    }

    if (this.hasCheckpointBlocker(input.journal, input.latestAttempt.id)) {
      const checkpointMessage =
        input.latestHandoffBundle?.failure_context?.message ??
        input.latestHandoffBundle?.current_decision_snapshot?.blocking_reason ??
        this.getAttemptJournalMessage(input.journal, input.latestAttempt.id, [
          "attempt.checkpoint.blocked"
        ]) ??
        input.current.blocking_reason ??
        "Execution auto-checkpoint was blocked and needs workspace diagnosis.";

      return {
        next_action: "retry_attempt",
        attempt_type: "execution",
        summary:
          "人工窗口超时，系统直接继续执行，先把提交现场和工作区阻塞处理掉。",
        blocking_reason: checkpointMessage,
        reason: "checkpoint_blocked_retries_execution",
        handoffBundleRef: input.latestHandoffBundleRef
      };
    }

    if (input.latestAttempt.status === "stopped") {
      return {
        next_action: recoveryGuidance.nextAction,
        attempt_type: recoveryGuidance.attemptType,
        summary: `人工窗口超时，${recoveryGuidance.summary}`,
        blocking_reason:
          recoveryGuidance.blockingReason ??
          "上一轮尝试中断，系统会先按恢复指引继续。",
        reason:
          recoveryGuidance.path === "degraded_rebuild"
            ? "degraded_rebuild_missing_handoff"
            : "resume_stopped_attempt",
        handoffBundleRef: recoveryGuidance.handoffBundleRef
      };
    }

    if (input.latestAttempt.status === "failed") {
      const failureMessage = await this.getLatestAttemptFailureMessage({
        current: input.current,
        journal: input.journal,
        latestAttempt: input.latestAttempt,
        handoffBundle: input.latestHandoffBundle
      });
      const failureMode = this.classifyFailureMode(failureMessage);

      if (failureMode === "provider_rate_limited") {
        return {
          next_action: "retry_attempt",
          attempt_type: input.latestAttempt.attempt_type,
          summary:
            input.latestAttempt.attempt_type === "execution"
              ? "provider 限流，系统短退避后自动重试上一轮执行。"
              : "provider 限流，系统短退避后自动重试上一轮研究。",
          blocking_reason:
            failureMessage ??
            input.latestHandoffBundle?.current_decision_snapshot?.blocking_reason ??
            input.current.blocking_reason ??
            "上一轮命中 provider 限流，系统会短退避后重试。",
          reason:
            input.latestAttempt.attempt_type === "execution"
              ? "provider_rate_limited_retry_execution"
              : "provider_rate_limited_retry_research",
          handoffBundleRef: input.latestHandoffBundleRef
        };
      }

      if (failureMode === "worker_stalled") {
        return {
          next_action: "retry_attempt",
          attempt_type: input.latestAttempt.attempt_type,
          summary:
            input.latestAttempt.attempt_type === "execution"
              ? "worker 卡住，系统短退避后自动重试上一轮执行。"
              : "worker 卡住，系统短退避后自动重试上一轮研究。",
          blocking_reason:
            failureMessage ??
            input.latestHandoffBundle?.current_decision_snapshot?.blocking_reason ??
            input.current.blocking_reason ??
            "上一轮 worker 卡住，系统会短退避后重试。",
          reason:
            input.latestAttempt.attempt_type === "execution"
              ? "worker_stalled_retry_execution"
              : "worker_stalled_retry_research",
          handoffBundleRef: input.latestHandoffBundleRef
        };
      }

      if (input.latestAttempt.attempt_type === "execution") {
        return {
          next_action: recoveryGuidance.nextAction,
          attempt_type: recoveryGuidance.attemptType,
          summary: `人工窗口超时，${recoveryGuidance.summary}`,
          blocking_reason:
            recoveryGuidance.blockingReason ??
            "上一轮执行失败，恢复路径会先处理当前阻塞。",
          reason:
            recoveryGuidance.path === "degraded_rebuild"
              ? "degraded_rebuild_missing_handoff"
              : "failed_execution_retries_directly",
          handoffBundleRef: recoveryGuidance.handoffBundleRef
        };
      }

      return {
        next_action: recoveryGuidance.nextAction,
        attempt_type: recoveryGuidance.attemptType,
        summary: `人工窗口超时，${recoveryGuidance.summary}`,
        blocking_reason:
          recoveryGuidance.blockingReason ??
          "上一轮研究失败，恢复路径会先重建阻塞上下文。",
        reason:
          recoveryGuidance.path === "degraded_rebuild"
            ? "degraded_rebuild_missing_handoff"
            : "failed_research_retry",
        handoffBundleRef: recoveryGuidance.handoffBundleRef
      };
    }

    if (input.latestAttempt.status === "completed") {
      if (
        governance &&
        governance.status !== "blocked" &&
        governance.status !== "resolved" &&
        governance.mainline_attempt_type === "execution" &&
        governance.mainline_summary
      ) {
        return {
          next_action:
            input.latestAttempt.attempt_type === "research" ? "start_execution" : "continue_execution",
          attempt_type: "execution",
          summary: "人工窗口超时，治理层要求沿着已经验证的 execution 主线继续。",
          blocking_reason:
            governance.context_summary.blocker_summary ?? governance.active_problem_summary,
          reason: "governance_preserves_execution_mainline",
          handoffBundleRef: input.latestHandoffBundleRef
        };
      }
      return {
        next_action: recoveryGuidance.nextAction,
        attempt_type: recoveryGuidance.attemptType,
        summary: `人工窗口超时，${recoveryGuidance.summary}`,
        blocking_reason:
          recoveryGuidance.blockingReason ??
          "恢复路径会先基于 settled handoff 重新确认下一步。",
        reason:
          recoveryGuidance.path === "degraded_rebuild"
            ? "degraded_rebuild_missing_handoff"
            : recoveryGuidance.attemptType === "execution"
              ? input.latestAttempt.attempt_type === "research"
                ? "completed_research_starts_execution"
                : "completed_execution_continues_execution"
              : "completed_attempt_needs_skeptical_review",
        handoffBundleRef: recoveryGuidance.handoffBundleRef
      };
    }

    return null;
  }

  private countAutomaticResumeCyclesSinceLastSteer(
    journal: Awaited<ReturnType<typeof listRunJournal>>,
    reasonPrefix?: string
  ): number {
    let count = 0;

    for (let index = journal.length - 1; index >= 0; index -= 1) {
      const entry = journal[index];
      if (!entry) {
        continue;
      }

      if (this.isAutoResumeResetBoundary(entry.type)) {
        break;
      }

      if (entry.type === "run.auto_resume.scheduled") {
        if (
          reasonPrefix &&
          !String(entry.payload.reason ?? "").startsWith(reasonPrefix)
        ) {
          continue;
        }
        count += 1;
      }
    }

    return count;
  }

  private async getAutomaticResumePolicy(input: {
    current: CurrentDecision;
    attempts: Attempt[];
    journal: Awaited<ReturnType<typeof listRunJournal>>;
  }): Promise<{
    delayMs: number;
    maxCycles: number;
    reasonPrefix?: string;
  }> {
    const latestAttempt = this.getLatestAttempt(input.current, input.attempts);
    const restartRequiredEntry =
      latestAttempt === null
        ? null
        : this.getLatestAttemptJournalEntry(input.journal, latestAttempt.id, [
            "attempt.restart_required"
          ]);
    if (
      restartRequiredEntry &&
      this.hasRuntimeRestartedSinceJournalEntry(restartRequiredEntry.ts)
    ) {
      return {
        delayMs: this.runtimeSourceDriftAutoResumeMs,
        maxCycles: this.maxAutomaticResumeCycles,
        reasonPrefix: "runtime_restarted_continue_execution"
      };
    }

    if (!latestAttempt || latestAttempt.status !== "failed") {
      return {
        delayMs: this.waitingHumanAutoResumeMs,
        maxCycles: this.maxAutomaticResumeCycles
      };
    }
    const latestHandoffBundle = await getAttemptHandoffBundle(
      this.workspacePaths,
      latestAttempt.run_id,
      latestAttempt.id
    );

    const failureMessage = await this.getLatestAttemptFailureMessage({
      current: input.current,
      journal: input.journal,
      latestAttempt,
      handoffBundle: latestHandoffBundle
    });
    const failureMode = this.classifyFailureMode(failureMessage);
    if (failureMode === "provider_rate_limited") {
      return {
        delayMs: this.providerRateLimitAutoResumeMs,
        maxCycles: this.maxProviderRateLimitAutoResumeCycles,
        reasonPrefix:
          latestAttempt.attempt_type === "execution"
            ? "provider_rate_limited_retry_execution"
            : "provider_rate_limited_retry_research"
      };
    }

    if (failureMode === "worker_stalled") {
      return {
        delayMs: this.workerStallAutoResumeMs,
        maxCycles: this.maxAutomaticResumeCycles,
        reasonPrefix:
          latestAttempt.attempt_type === "execution"
            ? "worker_stalled_retry_execution"
            : "worker_stalled_retry_research"
      };
    }

    return {
      delayMs: this.waitingHumanAutoResumeMs,
      maxCycles: this.maxAutomaticResumeCycles
    };
  }

  private getAutomaticResumePreflightBlocker(input: {
    handoffBundle: AttemptHandoffBundle | null;
    handoffBundleRef: string | null;
  }): {
    reason: string;
    message: string;
    failureClass?: string;
    failurePolicyMode?: string;
    failureCode?: string;
    handoffBundleRef?: string | null;
  } | null {
    if (input.handoffBundle?.failure_signal?.source_kind !== "preflight_evaluation") {
      return null;
    }

    return {
      reason: "preflight_blocked",
      failureClass: "preflight_blocked",
      failurePolicyMode:
        input.handoffBundle.failure_signal.policy_mode ?? "fail_closed",
      failureCode: input.handoffBundle.failure_signal.failure_code ?? undefined,
      message:
        input.handoffBundle.failure_signal.summary ??
        "上一轮 execution 在 preflight 被挡住，自动续跑已暂停。",
      handoffBundleRef: input.handoffBundleRef
    };
  }

  private getAutomaticResumeRuntimeVerificationBlocker(input: {
    handoffBundle: AttemptHandoffBundle | null;
    handoffBundleRef: string | null;
  }): {
    reason: string;
    message: string;
    failureClass?: string;
    failurePolicyMode?: string;
    failureCode?: string;
    handoffBundleRef?: string | null;
  } | null {
    if (input.handoffBundle?.runtime_verification?.status !== "failed") {
      return null;
    }

    switch (input.handoffBundle.failure_code ?? input.handoffBundle.runtime_verification.failure_code) {
      case "no_git_changes":
        return {
          reason: "runtime_verification_failed",
          failureClass: "runtime_verification_failed",
          failurePolicyMode: "fail_closed",
          failureCode: "no_git_changes",
          message:
            "上一轮 execution 的运行时回放失败码是 no_git_changes，说明没有留下新的 git 可见改动，自动续跑已暂停。",
          handoffBundleRef: input.handoffBundleRef
        };
      default:
        return null;
    }
  }

  private getAutomaticResumeAdversarialVerificationBlocker(input: {
    handoffBundle: AttemptHandoffBundle | null;
    handoffBundleRef: string | null;
  }): {
    reason: string;
    message: string;
    failureClass?: string;
    failurePolicyMode?: string;
    failureCode?: string;
    handoffBundleRef?: string | null;
  } | null {
    if (input.handoffBundle?.adversarial_verification?.status !== "failed") {
      return null;
    }

    return {
      reason: "adversarial_verification_failed",
      failureClass: "adversarial_verification_failed",
      failurePolicyMode: "fail_closed",
      failureCode:
        input.handoffBundle.adversarial_failure_code ??
        input.handoffBundle.adversarial_verification.failure_code ??
        undefined,
      message:
        input.handoffBundle.adversarial_verification.failure_reason ??
        input.handoffBundle.adversarial_verification.summary ??
        "上一轮 execution 的 adversarial verification 没有通过，自动续跑已暂停。",
      handoffBundleRef: input.handoffBundleRef
    };
  }

  private hasCheckpointBlocker(
    journal: Awaited<ReturnType<typeof listRunJournal>>,
    attemptId: string
  ): boolean {
    return journal.some(
      (entry) => entry.attempt_id === attemptId && entry.type === "attempt.checkpoint.blocked"
    );
  }

  private getAttemptJournalMessage(
    journal: Awaited<ReturnType<typeof listRunJournal>>,
    attemptId: string,
    entryTypes: string[]
  ): string | null {
    const entry = this.getLatestAttemptJournalEntry(journal, attemptId, entryTypes);
    return entry ? this.getReviewPacketFailureMessage(entry.payload) : null;
  }

  private getLatestAttemptJournalEntry(
    journal: Awaited<ReturnType<typeof listRunJournal>>,
    attemptId: string,
    entryTypes: string[]
  ): (Awaited<ReturnType<typeof listRunJournal>>)[number] | null {
    for (let index = journal.length - 1; index >= 0; index -= 1) {
      const entry = journal[index];
      if (!entry || entry.attempt_id !== attemptId || !entryTypes.includes(entry.type)) {
        continue;
      }

      return entry;
    }

    return null;
  }

  private hasRuntimeRestartedSinceJournalEntry(ts: string | null | undefined): boolean {
    if (!ts) {
      return false;
    }

    const entryTsMs = Date.parse(ts);
    if (Number.isNaN(entryTsMs)) {
      return false;
    }

    return this.instanceStartedAtMs > entryTsMs;
  }

  private getRunWorkspaceScopeBlockedMessage(
    journal: Awaited<ReturnType<typeof listRunJournal>>,
    attemptId: string | null
  ): string | null {
    for (let index = journal.length - 1; index >= 0; index -= 1) {
      const entry = journal[index];
      if (!entry || entry.type !== "run.workspace_scope.blocked") {
        continue;
      }

      if (attemptId && entry.attempt_id !== attemptId) {
        continue;
      }

      const payload =
        entry.payload && typeof entry.payload === "object"
          ? (entry.payload as Record<string, unknown>)
          : null;
      const message = payload?.message;
      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }

    return null;
  }

  private async getLatestAttemptFailureMessage(input: {
    current: CurrentDecision;
    journal: Awaited<ReturnType<typeof listRunJournal>>;
    latestAttempt: Attempt;
    handoffBundle?: AttemptHandoffBundle | null;
  }): Promise<string | null> {
    const [stderrSignal, stdoutSignal] = await Promise.all([
      this.getAttemptLogFailureSignal(
        input.latestAttempt.run_id,
        input.latestAttempt.id,
        "stderr"
      ),
      this.getAttemptLogFailureSignal(
        input.latestAttempt.run_id,
        input.latestAttempt.id,
        "stdout"
      )
    ]);

    return this.pickFailureMessageCandidate([
      input.handoffBundle?.failure_context?.message,
      input.handoffBundle?.current_decision_snapshot?.blocking_reason,
      this.getAttemptJournalMessage(input.journal, input.latestAttempt.id, ["attempt.failed"]),
      input.current.blocking_reason,
      stderrSignal,
      stdoutSignal
    ]);
  }

  private async getAttemptLogFailureSignal(
    runId: string,
    attemptId: string,
    stream: "stdout" | "stderr"
  ): Promise<string | null> {
    const excerpt = await getAttemptLogExcerpt(
      this.workspacePaths,
      runId,
      attemptId,
      stream
    );
    if (!excerpt) {
      return null;
    }

    const lines = excerpt
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .reverse();
    const candidates: string[] = [];

    for (const line of lines) {
      candidates.push(...this.extractFailureMessagesFromLogLine(line));
    }

    return this.pickFailureMessageCandidate(candidates);
  }

  private extractFailureMessagesFromLogLine(line: string): string[] {
    const pushCandidate = (value: unknown, target: string[]): void => {
      if (typeof value !== "string") {
        return;
      }

      const normalized = value.trim().replace(/\s+/g, " ");
      if (normalized.length === 0) {
        return;
      }

      target.push(
        normalized.length > 600 ? normalized.slice(normalized.length - 600) : normalized
      );
    };

    if (!line.startsWith("{")) {
      const candidateLines: string[] = [];
      pushCandidate(line, candidateLines);
      return candidateLines;
    }

    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const candidates: string[] = [];
      pushCandidate(parsed.message, candidates);
      if (parsed.error && typeof parsed.error === "object") {
        pushCandidate((parsed.error as Record<string, unknown>).message, candidates);
      }
      if (parsed.item && typeof parsed.item === "object") {
        pushCandidate((parsed.item as Record<string, unknown>).aggregated_output, candidates);
      }
      return candidates;
    } catch {
      const candidateLines: string[] = [];
      pushCandidate(line, candidateLines);
      return candidateLines;
    }
  }

  private pickFailureMessageCandidate(
    candidates: Array<string | null | undefined>
  ): string | null {
    const normalizedCandidates = Array.from(
      new Set(
        candidates
          .map((candidate) => candidate?.trim())
          .filter((candidate): candidate is string => Boolean(candidate && candidate.length > 0))
      )
    );

    for (const candidate of normalizedCandidates) {
      if (this.classifyFailureMode(candidate) !== null) {
        return candidate;
      }
    }

    return normalizedCandidates[0] ?? null;
  }

  private classifyFailureMode(
    message: string | null | undefined
  ):
    | "provider_rate_limited"
    | "provider_auth_failed"
    | "worker_stalled"
    | "worker_output_schema_invalid"
    | null {
    if (!message) {
      return null;
    }

    const rateLimitPatterns = [
      /\b429\b/,
      /rate[\s_-]?limit/i,
      /too many requests/i,
      /insufficient[_\s-]?quota/i,
      /quota exceeded/i,
      /resource[_\s-]?exhausted/i,
      /throttl(?:e|ed|ing)/i,
      /限流/u,
      /配额/u
    ];
    if (rateLimitPatterns.some((pattern) => pattern.test(message))) {
      return "provider_rate_limited";
    }

    const authPatterns = [
      /\b401\b/,
      /\b403\b/,
      /unauthorized/i,
      /forbidden/i,
      /authentication/i,
      /authorization/i,
      /auth(?:\s+error|\s+failed)?/i,
      /invalid api key/i,
      /api key/i,
      /invalid token/i,
      /鉴权/u,
      /认证/u,
      /授权/u
    ];
    if (authPatterns.some((pattern) => pattern.test(message))) {
      return "provider_auth_failed";
    }

    const workerStallPatterns = [
      /Codex CLI stalled/i,
      /stall watchdog/i,
      /no runtime stdout activity/i,
      /no live child command remained/i,
      /no final output was written/i,
      /worker 卡住/u
    ];
    if (workerStallPatterns.some((pattern) => pattern.test(message))) {
      return "worker_stalled";
    }

    const workerOutputSchemaInvalidPatterns = [
      /Worker writeback schema invalid/i,
      /Expected [a-z_]+, received [a-z_]+ at (artifacts|findings|questions|recommended_next_steps|verification_plan)/i
    ];
    if (workerOutputSchemaInvalidPatterns.some((pattern) => pattern.test(message))) {
      return "worker_output_schema_invalid";
    }

    return null;
  }

  private async persistAutomaticResumeBlocked(
    runId: string,
    current: CurrentDecision,
    journal: Awaited<ReturnType<typeof listRunJournal>>,
    blocker?: {
      reason: string;
      message: string;
      failureClass?: string;
      failurePolicyMode?: string;
      failureCode?: string;
      handoffBundleRef?: string | null;
    }
  ): Promise<void> {
    if (this.hasAutoResumeTerminalEvent(journal, "run.auto_resume.blocked")) {
      return;
    }

    const message =
      blocker?.message ??
      current.blocking_reason ??
      "当前阻塞涉及人工边界，系统未找到安全的自动续跑方案。";
    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: current.latest_attempt_id,
        type: "run.auto_resume.blocked",
        payload: {
          reason: blocker?.reason ?? "manual_only_blocker",
          failure_class: blocker?.failureClass ?? null,
          failure_policy_mode: blocker?.failurePolicyMode ?? null,
          failure_code: blocker?.failureCode ?? null,
          handoff_bundle_ref: blocker?.handoffBundleRef ?? null,
          message
        }
      })
    );
    await this.persistManualOnlyRunAutomation({
      runId,
      reasonCode: "automatic_resume_blocked",
      reason: message,
      imposedBy: "orchestrator",
      failureCode: blocker?.failureCode ?? null
    });
    await refreshRunOperatorSurface(this.workspacePaths, runId);
  }

  private async persistAutomaticResumeExhausted(
    runId: string,
    current: CurrentDecision,
    journal: Awaited<ReturnType<typeof listRunJournal>>,
    automaticResumeCount: number
  ): Promise<void> {
    if (this.hasAutoResumeTerminalEvent(journal, "run.auto_resume.exhausted")) {
      return;
    }

    const message = `自动续跑已尝试 ${automaticResumeCount} 轮，仍未形成可执行推进方案，现停下等待人工。`;
    await saveCurrentDecision(
      this.workspacePaths,
      updateCurrentDecision(current, {
        run_status: "waiting_steer",
        recommended_next_action: "wait_for_human",
        summary: message,
        blocking_reason: [current.blocking_reason, message].filter(Boolean).join(" "),
        waiting_for_human: true
      })
    );
    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: current.latest_attempt_id,
        type: "run.auto_resume.exhausted",
        payload: {
          attempted_cycles: automaticResumeCount,
          message
        }
      })
    );
    await this.persistManualOnlyRunAutomation({
      runId,
      reasonCode: "automatic_resume_exhausted",
      reason: message,
      imposedBy: "orchestrator"
    });
    await refreshRunOperatorSurface(this.workspacePaths, runId);
  }

  private hasAutoResumeTerminalEvent(
    journal: Awaited<ReturnType<typeof listRunJournal>>,
    type: "run.auto_resume.blocked" | "run.auto_resume.exhausted"
  ): boolean {
    for (let index = journal.length - 1; index >= 0; index -= 1) {
      const entry = journal[index];
      if (!entry) {
        continue;
      }

      if (this.isAutoResumeResetBoundary(entry.type)) {
        return false;
      }

      if (entry.type === type) {
        return true;
      }
    }

    return false;
  }

  private isAutoResumeResetBoundary(type: string): boolean {
    return (
      type === "run.steer.queued" ||
      type === "run.launched" ||
      type === "run.manual_recovery" ||
      type === "attempt.checkpoint.created"
    );
  }

  private async getRunWorkspaceScopeError(
    run: Run
  ): Promise<RunWorkspaceScopeError | null> {
    try {
      await lockRunWorkspaceRoot(run.workspace_root, this.runWorkspaceScopePolicy);
      if (run.managed_workspace_root) {
        await lockRunWorkspaceRoot(
          run.managed_workspace_root,
          this.runWorkspaceScopePolicy
        );
      }
      return null;
    } catch (error) {
      if (error instanceof RunWorkspaceScopeError) {
        return error;
      }

      throw error;
    }
  }

  private async assertAttemptWorkspaceScope(
    run: Run,
    attempt: Attempt
  ): Promise<void> {
    await assertAttemptWorkspaceWithinRunScope({
      runWorkspaceRoot: run.workspace_root,
      managedRunWorkspaceRoot: run.managed_workspace_root,
      attemptWorkspaceRoot: attempt.workspace_root,
      policy: this.runWorkspaceScopePolicy
    });
  }

  private async ensureRunWorkspaceReady(run: Run): Promise<Run> {
    return await ensureRunManagedWorkspace({
      run,
      policy: this.runWorkspaceScopePolicy
    });
  }

  private async ensureAttemptUsesRunWorkspace(
    run: Run,
    attempt: Attempt
  ): Promise<Attempt> {
    if (!run.managed_workspace_root) {
      return attempt;
    }

    if (attempt.workspace_root !== run.workspace_root) {
      return attempt;
    }

    if (!["created", "queued"].includes(attempt.status)) {
      return attempt;
    }

    const nextAttempt = updateAttempt(attempt, {
      workspace_root: run.managed_workspace_root
    });
    await saveAttempt(this.workspacePaths, nextAttempt);
    return nextAttempt;
  }

  private async persistRunWorkspaceScopeBlocked(
    run: Run,
    current: CurrentDecision,
    error: RunWorkspaceScopeError
  ): Promise<void> {
    const nextCurrent = updateCurrentDecision(current, {
      run_status: "waiting_steer",
      recommended_next_action: "wait_for_human",
      summary: error.message,
      blocking_reason: error.message,
      waiting_for_human: true
    });

    const currentAlreadyBlocked =
      current.run_status === nextCurrent.run_status &&
      current.recommended_next_action === nextCurrent.recommended_next_action &&
      current.summary === nextCurrent.summary &&
      current.blocking_reason === nextCurrent.blocking_reason &&
      current.waiting_for_human === nextCurrent.waiting_for_human;

    if (!currentAlreadyBlocked) {
      await saveCurrentDecision(this.workspacePaths, nextCurrent);
    }

    await this.appendRunWorkspaceScopeBlockedEntry(run.id, current.latest_attempt_id, error);
    await refreshRunOperatorSurface(this.workspacePaths, run.id);
  }

  private async appendRunWorkspaceScopeBlockedEntry(
    runId: string,
    attemptId: string | null,
    error: RunWorkspaceScopeError
  ): Promise<void> {
    const journal = await listRunJournal(this.workspacePaths, runId);
    const latestEntry = journal.at(-1);
    if (
      latestEntry?.type === "run.workspace_scope.blocked" &&
      latestEntry.attempt_id === attemptId &&
      latestEntry.payload.message === error.message
    ) {
      return;
    }

    await appendRunJournal(
      this.workspacePaths,
      createRunJournalEntry({
        run_id: runId,
        attempt_id: attemptId,
        type: "run.workspace_scope.blocked",
        payload: {
          code: error.code,
          message: error.message,
          ...error.details
        }
      })
    );
  }

  private async withRunDispatchLease(
    runId: string,
    purpose: string,
    callback: () => Promise<void>
  ): Promise<void> {
    const lease = await this.tryAcquireRunDispatchLease(runId, purpose);
    if (!lease) {
      return;
    }

    try {
      await callback();
    } finally {
      await lease.release();
    }
  }

  private async tryAcquireRunDispatchLease(
    runId: string,
    purpose: string
  ): Promise<RunDispatchLease | null> {
    const leaseFile = this.getRunDispatchLeaseFile(runId);
    const leaseRecord: RunDispatchLeaseRecord = {
      version: 1,
      run_id: runId,
      owner_id: this.instanceId,
      owner_pid: process.pid,
      purpose,
      acquired_at: new Date().toISOString()
    };

    while (true) {
      try {
        const handle = await open(leaseFile, "wx");
        try {
          await handle.writeFile(`${JSON.stringify(leaseRecord, null, 2)}\n`, "utf8");
        } finally {
          await handle.close();
        }
        return {
          release: async () => {
            await this.releaseRunDispatchLease(runId, leaseRecord);
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }

        const existingLease = await this.inspectRunDispatchLease(runId);
        if (existingLease.status === "held") {
          return null;
        }

        await unlink(leaseFile).catch((unlinkError) => {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw unlinkError;
          }
        });
      }
    }
  }

  private async inspectRunDispatchLease(runId: string): Promise<
    | {
        status: "held";
      }
    | {
        status: "stale_dead_owner";
      }
  > {
    const leaseFile = this.getRunDispatchLeaseFile(runId);
    const leaseStats = await stat(leaseFile);
    const ageMs = Date.now() - leaseStats.mtimeMs;
    if (ageMs <= this.runDispatchLeaseStaleMs) {
      return {
        status: "held"
      };
    }

    const raw = await readFile(leaseFile, "utf8");
    let parsed: Partial<RunDispatchLeaseRecord>;
    try {
      parsed = JSON.parse(raw) as Partial<RunDispatchLeaseRecord>;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RunDispatchLeaseError(
        "invalid_lease_payload",
        `Run ${runId} has an unreadable dispatch lease at ${leaseFile}: ${reason}`
      );
    }

    if (
      parsed.version !== 1 ||
      parsed.run_id !== runId ||
      typeof parsed.owner_id !== "string" ||
      parsed.owner_id.length === 0 ||
      typeof parsed.owner_pid !== "number" ||
      !Number.isInteger(parsed.owner_pid) ||
      parsed.owner_pid <= 0 ||
      typeof parsed.purpose !== "string" ||
      parsed.purpose.length === 0 ||
      typeof parsed.acquired_at !== "string" ||
      parsed.acquired_at.length === 0
    ) {
      throw new RunDispatchLeaseError(
        "invalid_lease_payload",
        `Run ${runId} has an invalid dispatch lease payload at ${leaseFile}.`
      );
    }

    if (this.isProcessAlive(parsed.owner_pid)) {
      throw new RunDispatchLeaseError(
        "stale_live_owner",
        `Run ${runId} dispatch lease is still owned by live pid ${parsed.owner_pid} after ${ageMs}ms.`
      );
    }

    return {
      status: "stale_dead_owner"
    };
  }

  private async releaseRunDispatchLease(
    runId: string,
    expectedLease: RunDispatchLeaseRecord
  ): Promise<void> {
    const leaseFile = this.getRunDispatchLeaseFile(runId);
    let raw: string;
    try {
      raw = await readFile(leaseFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    let parsed: Partial<RunDispatchLeaseRecord>;
    try {
      parsed = JSON.parse(raw) as Partial<RunDispatchLeaseRecord>;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RunDispatchLeaseError(
        "invalid_lease_payload",
        `Run ${runId} dispatch lease became unreadable before release: ${reason}`
      );
    }

    if (
      parsed.run_id !== expectedLease.run_id ||
      parsed.owner_id !== expectedLease.owner_id ||
      parsed.owner_pid !== expectedLease.owner_pid ||
      parsed.acquired_at !== expectedLease.acquired_at
    ) {
      throw new RunDispatchLeaseError(
        "lease_owner_mismatch",
        `Run ${runId} dispatch lease owner changed before release.`
      );
    }

    await unlink(leaseFile);
  }

  private getRunDispatchLeaseFile(runId: string): string {
    return join(
      resolveRunPaths(this.workspacePaths, runId).artifactsDir,
      RUN_DISPATCH_LEASE_FILE_NAME
    );
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        return false;
      }
      if (code === "EPERM") {
        return true;
      }
      throw error;
    }
  }

  private hasActiveAttemptForRun(runId: string): boolean {
    const prefix = `${runId}:`;
    for (const activeKey of this.activeAttempts) {
      if (activeKey.startsWith(prefix)) {
        return true;
      }
    }

    return false;
  }

  private async isAttemptHeartbeatFresh(
    runId: string,
    attemptId: string
  ): Promise<boolean> {
    const heartbeat = await getAttemptHeartbeat(this.workspacePaths, runId, attemptId);
    if (!heartbeat || heartbeat.status !== "active") {
      return false;
    }

    const heartbeatAtMs = Date.parse(heartbeat.heartbeat_at);
    if (Number.isNaN(heartbeatAtMs)) {
      return false;
    }

    return Date.now() - heartbeatAtMs <= this.attemptHeartbeatStaleMs;
  }

  private async writeAttemptHeartbeat(input: {
    runId: string;
    attemptId: string;
    startedAt: string;
    status: "active" | "released";
  }): Promise<void> {
    const now = new Date().toISOString();
    await saveAttemptHeartbeat(this.workspacePaths, {
      attempt_id: input.attemptId,
      run_id: input.runId,
      owner_id: this.instanceId,
      status: input.status,
      started_at: input.startedAt,
      heartbeat_at: now,
      released_at: input.status === "released" ? now : null
    });
  }
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export {
  assessRunHealth,
  getRunMostRecentActivityTs,
  type RunHealthAssessment,
  type RunHealthStatus
} from "./run-health.js";

export {
  assertAttemptWorkspaceWithinRunScope,
  createRunWorkspaceScopePolicy,
  createDefaultRunWorkspaceScopePolicy,
  lockRunWorkspaceRoot,
  RunWorkspaceScopeError,
  type RunWorkspaceScopePolicy
} from "./workspace-scope.js";

export {
  buildRuntimeWorkspaceScopeRoots,
  resolveRuntimeControlApiPaths,
  resolveRuntimeLayout,
  syncRuntimeLayoutHint,
  type RuntimeControlApiPaths,
  type RuntimeLayout
} from "./runtime-layout.js";

export {
  ensureRunManagedWorkspace,
  getEffectiveRunWorkspaceRoot,
  repairRunManagedWorkspace,
  type ManagedWorkspaceRepairResult
} from "./run-workspace.js";

export {
  maybePromoteVerifiedCheckpoint,
  type RuntimePromotionOutcome
} from "./runtime-promotion.js";

export {
  assertSelfBootstrapNextTaskSourceAnchorMatchesPayload,
  captureSelfBootstrapNextTaskArtifacts,
  SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH,
  SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME,
  SELF_BOOTSTRAP_NEXT_TASK_PROMOTION_ARTIFACT_FILE_NAME,
  SELF_BOOTSTRAP_NEXT_TASK_SOURCE_ASSET_SNAPSHOT_FILE_NAME,
  loadSelfBootstrapNextTaskSourceAsset,
  loadSelfBootstrapNextTaskSourceAssetSnapshot,
  loadSelfBootstrapNextTaskActiveEntry,
  parseSelfBootstrapNextTaskActiveEntry,
  type SelfBootstrapNextTaskActiveEntry,
  type SelfBootstrapNextTaskSourceAsset,
  type SelfBootstrapNextTaskSourceAnchor
} from "./self-bootstrap-next-task.js";

export { captureSelfBootstrapRuntimeHealthSnapshot } from "./self-bootstrap-runtime-health.js";

export {
  buildRunWorkingContext,
  readRunWorkingContextView,
  refreshRunWorkingContext,
  type RunWorkingContextView
} from "./working-context.js";

export {
  buildRunBrief,
  readRunBriefView,
  refreshRunBrief,
  type RunBriefView
} from "./run-brief.js";

export {
  buildRunMaintenancePlane,
  readRunMaintenancePlaneView,
  refreshRunMaintenancePlane,
  refreshRunOperatorSurface,
  type RefreshRunMaintenancePlaneOptions,
  type RunMaintenancePlaneView
} from "./maintenance-plane.js";

export {
  deriveFailureSignalFromRunBrief,
  deriveRunSurfaceFailureSignal,
  pickPrimaryFailureSignal
} from "./failure-policy.js";

export {
  describeRunEffectivePolicyBundle,
  type RunEffectivePolicyBundleView
} from "./effective-policy-bundle.js";

export {
  appendResolvedRunMailboxEntry,
  buildRunMailboxThreadId,
  resolveOpenRunMailboxMessagesByType,
  resolveRunMailboxThread,
  upsertOpenRunMailboxEntry
} from "./run-mailbox.js";
