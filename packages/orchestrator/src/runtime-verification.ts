import { constants as fsConstants } from "node:fs";
import { createWriteStream } from "node:fs";
import { access, cp, mkdir, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  isExecutionAttemptContractReady,
  type AttemptContract,
  type AttemptPreflightCheck,
  AttemptRuntimeVerificationSchema,
  type Attempt,
  type AttemptRuntimeVerification,
  resolveExecutionVerifierKit,
  type ExecutionVerifierKit,
  type RuntimeVerificationFailureCode,
  type Run,
  type VerificationCommand,
  type VerificationCommandResult,
  type WorkerArtifact,
  type WorkerWriteback
} from "@autoresearch/domain";
import type { AttemptPaths } from "@autoresearch/state-store";
import { readJsonFile, writeJsonFile } from "@autoresearch/state-store";
import {
  SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME,
  SELF_BOOTSTRAP_NEXT_TASK_PROMOTION_ARTIFACT_FILE_NAME,
  SELF_BOOTSTRAP_NEXT_TASK_SOURCE_ASSET_SNAPSHOT_FILE_NAME
} from "./self-bootstrap-next-task.js";
import { annotateRuntimeVerificationFailure } from "./failure-policy.js";
import { getExecutionVerifierKitRegistryEntry } from "./verifier-kit-registry.js";
import {
  canCheckpointMitigateDangerousCommand,
  findDangerousVerificationCommand,
  type DangerousVerificationCommandFinding
} from "./dangerous-verification-commands.js";

export interface AttemptRuntimeVerificationOutcome {
  verification: AttemptRuntimeVerification;
  artifact_path: string;
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export type VerificationCommandReadiness =
  | {
      ok: true;
      cwd: string;
      executable: string;
    }
  | {
      ok: false;
      cwd: string | null;
      executable: string | null;
      reason: string;
    };

interface GitCheckpointPreflightArtifact {
  status: "ready" | "not_git_repo";
  repo_root: string | null;
  head_before: string | null;
  status_before: string[];
  created_at: string;
}

interface GitStatusDelta {
  preexistingGitStatus: string[];
  newGitStatus: string[];
  changedFiles: string[];
}

interface GitExecutionDelta extends GitStatusDelta {
  committedFiles: string[];
}

type SyncedSelfBootstrapArtifacts = NonNullable<
  AttemptRuntimeVerification["synced_self_bootstrap_artifacts"]
>;

type RuntimeVerificationCheck = AttemptRuntimeVerification["checks"][number];

const CHECKPOINT_PREFLIGHT_FILE_NAME = "git-checkpoint-preflight.json";
const LIVE_RUNTIME_SOURCE_PREFIXES = [
  "apps/control-api/src/",
  "packages/context-manager/src/",
  "packages/domain/src/",
  "packages/event-log/src/",
  "packages/judge/src/",
  "packages/orchestrator/src/",
  "packages/planner/src/",
  "packages/report-builder/src/",
  "packages/state-store/src/",
  "packages/worker-adapters/src/"
] as const;
const DEFAULT_RUNTIME_VERIFICATION_TIMEOUT_MS = 600_000;

let cachedVerificationShell: string | null = null;

async function resolveVerificationShell(): Promise<string> {
  if (cachedVerificationShell) {
    return cachedVerificationShell;
  }

  const candidates = [
    process.env.SHELL?.trim(),
    "/bin/bash",
    "/bin/sh"
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      cachedVerificationShell = candidate;
      return candidate;
    } catch {
      continue;
    }
  }

  cachedVerificationShell = "sh";
  return cachedVerificationShell;
}
const SELF_BOOTSTRAP_RUNTIME_SYNC_TARGETS = [
  {
    artifactKey: "publication_artifact",
    reportKey: "retained_publication_artifact",
    targetFileName: SELF_BOOTSTRAP_NEXT_TASK_PROMOTION_ARTIFACT_FILE_NAME,
    label: "retained publication artifact"
  },
  {
    artifactKey: "source_asset_snapshot",
    reportKey: "retained_source_asset_snapshot",
    targetFileName: SELF_BOOTSTRAP_NEXT_TASK_SOURCE_ASSET_SNAPSHOT_FILE_NAME,
    label: "retained source asset snapshot"
  },
  {
    artifactKey: "published_active_entry",
    reportKey: "retained_published_active_entry",
    targetFileName: SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME,
    label: "retained published active entry"
  }
] as const;

type SelfBootstrapVerificationReport = Record<string, unknown>;

function getVerifierKitRequiredArtifactTypes(
  verifierKit: ExecutionVerifierKit
): WorkerArtifact["type"][] {
  switch (verifierKit) {
    case "web":
      return ["screenshot", "report", "log"];
    case "api":
      return ["command_result", "test_result", "report", "log"];
    case "cli":
      return ["command_result", "test_result", "log"];
    case "repo":
    default:
      return [];
  }
}

function buildVerifierKitRuntimeChecks(input: {
  verifierKit: ExecutionVerifierKit;
  result: WorkerWriteback;
}): {
  checks: AttemptPreflightCheck[];
  failureCode: RuntimeVerificationFailureCode | null;
  failureReason: string | null;
} {
  const registryEntry = getExecutionVerifierKitRegistryEntry(input.verifierKit);
  const checks: AttemptPreflightCheck[] = [
    {
      code: "verifier_kit_runtime_expectations_loaded",
      status: "passed",
      message: registryEntry.runtime_expectations.join(" ")
    }
  ];
  const requiredArtifactTypes = getVerifierKitRequiredArtifactTypes(input.verifierKit);
  if (requiredArtifactTypes.length === 0) {
    checks.push({
      code: "verifier_kit_evidence_present",
      status: "passed",
      message:
        "Repository task accepts git-visible changes plus deterministic replay as runtime evidence."
    });
    return {
      checks,
      failureCode: null,
      failureReason: null
    };
  }

  const matchedArtifacts = input.result.artifacts.filter((artifact: WorkerArtifact) =>
    requiredArtifactTypes.includes(artifact.type)
  );
  if (matchedArtifacts.length > 0) {
    checks.push({
      code: "verifier_kit_evidence_present",
      status: "passed",
      message: `${registryEntry.title} left verifier-kit evidence via ${matchedArtifacts
        .map((artifact: WorkerArtifact) => artifact.type)
        .join(", ")} artifacts.`
    });
    return {
      checks,
      failureCode: null,
      failureReason: null
    };
  }

  const failureReason = [
    `${registryEntry.title} requires worker-declared evidence artifacts after deterministic replay.`,
    `Expected one of ${requiredArtifactTypes.join(", ")}.`,
    `Observed ${input.result.artifacts.length > 0 ? input.result.artifacts.map((artifact: WorkerArtifact) => artifact.type).join(", ") : "no worker artifacts"}.`
  ].join(" ");
  checks.push({
    code: "verifier_kit_evidence_present",
    status: "failed",
    message: failureReason
  });
  return {
    checks,
    failureCode: "missing_verifier_kit_evidence",
    failureReason
  };
}

export async function detectLiveRuntimeSourceDrift(input: {
  changedFiles: string[];
  attemptWorkspaceRoot: string;
  runtimeRepoRoot: string;
}): Promise<string[]> {
  const [attemptRepoRoot, runtimeRepoGitRoot] = await Promise.all([
    resolveGitRepoRoot(input.attemptWorkspaceRoot),
    resolveGitRepoRoot(input.runtimeRepoRoot)
  ]);

  if (!attemptRepoRoot || !runtimeRepoGitRoot) {
    return [];
  }

  if (resolve(attemptRepoRoot) !== resolve(runtimeRepoGitRoot)) {
    return [];
  }

  return [...new Set(input.changedFiles)]
    .filter((filePath) =>
      LIVE_RUNTIME_SOURCE_PREFIXES.some((prefix) => filePath.startsWith(prefix))
    )
    .sort();
}

export async function runAttemptRuntimeVerification(input: {
  run: Run;
  attempt: Attempt;
  attemptContract: AttemptContract | null;
  result: WorkerWriteback;
  attemptPaths: AttemptPaths;
  timeoutMs?: number;
}): Promise<AttemptRuntimeVerificationOutcome> {
  if (input.attempt.attempt_type !== "execution") {
    return await writeVerificationArtifact(input.attemptPaths, {
      attempt_id: input.attempt.id,
      run_id: input.run.id,
      attempt_type: input.attempt.attempt_type,
      status: "not_applicable",
      verifier_kit: null,
      repo_root: null,
      git_head: null,
      git_status: [],
      preexisting_git_status: [],
      new_git_status: [],
      changed_files: [],
      failure_code: null,
      failure_reason: null,
      command_results: [],
      synced_self_bootstrap_artifacts: null,
      created_at: new Date().toISOString()
    });
  }

  if (!input.attemptContract) {
    return await buildFailedVerificationArtifact({
      run: input.run,
      attempt: input.attempt,
      attemptPaths: input.attemptPaths,
      failureCode: "missing_attempt_contract",
      failureReason:
        "Execution verification requires attempt_contract.json so the runtime can replay the planned acceptance steps."
    });
  }

  const attemptContract = input.attemptContract;
  const verifierKit = resolveExecutionVerifierKit(attemptContract);
  if (!isExecutionAttemptContractReady(attemptContract)) {
    return await buildFailedVerificationArtifact({
      run: input.run,
      attempt: input.attempt,
      attemptPaths: input.attemptPaths,
      verifierKit,
      failureCode: "missing_contract_verification_plan",
      failureReason:
        "Execution attempt contract is missing replayable verification commands. Runtime verification only trusts commands locked in before dispatch."
    });
  }
  const verificationPlan = attemptContract.verification_plan;
  if (!verificationPlan) {
    return await buildFailedVerificationArtifact({
      run: input.run,
      attempt: input.attempt,
      attemptPaths: input.attemptPaths,
      verifierKit,
      failureCode: "missing_contract_verification_plan",
      failureReason:
        "Execution attempt contract lost its replayable verification commands before runtime verification started."
    });
  }

  const repoRoot = await resolveGitRepoRoot(input.attempt.workspace_root);
  if (!repoRoot) {
    return await buildFailedVerificationArtifact({
      run: input.run,
      attempt: input.attempt,
      attemptPaths: input.attemptPaths,
      verifierKit,
      failureCode: "workspace_not_git_repo",
      failureReason:
        "Execution verification requires a git workspace so the runtime can observe real changes."
    });
  }

  const workspaceRoot = resolve(input.attempt.workspace_root);
  const gitHead = await readGitHead(repoRoot);
  const checkpointPreflight = await readCheckpointPreflight(input.attemptPaths);
  if (
    !checkpointPreflight ||
    checkpointPreflight.status !== "ready" ||
    checkpointPreflight.repo_root !== repoRoot
  ) {
    const currentGitStatus = await readGitStatus(repoRoot);
    return await writeVerificationArtifact(input.attemptPaths, {
      attempt_id: input.attempt.id,
      run_id: input.run.id,
      attempt_type: input.attempt.attempt_type,
      status: "failed",
      verifier_kit: verifierKit,
      repo_root: repoRoot,
      git_head: gitHead,
      git_status: currentGitStatus,
      preexisting_git_status: checkpointPreflight?.status_before ?? [],
      new_git_status: [],
      changed_files: [],
      failure_code: "missing_preflight_baseline",
      failure_reason:
        "Execution verification requires the git preflight baseline captured before dispatch, but that baseline is missing or unreadable.",
      command_results: [],
      synced_self_bootstrap_artifacts: null,
      created_at: new Date().toISOString()
    });
  }

  const gitStatusAfterExecution = await readGitStatus(repoRoot);
  const gitStatusDelta = await buildGitExecutionDelta({
    repoRoot,
    statusBefore: checkpointPreflight.status_before,
    statusAfter: gitStatusAfterExecution,
    headBefore: checkpointPreflight.head_before,
    headAfter: gitHead
  });
  const verificationOnlyRecovery = isVerificationOnlyRecoveryAttempt({
    attempt: input.attempt,
    attemptContract
  });

  if (gitStatusDelta.changedFiles.length === 0 && !verificationOnlyRecovery) {
    return await writeVerificationArtifact(input.attemptPaths, {
      attempt_id: input.attempt.id,
      run_id: input.run.id,
      attempt_type: input.attempt.attempt_type,
      status: "failed",
      verifier_kit: verifierKit,
      repo_root: repoRoot,
      git_head: gitHead,
      git_status: gitStatusAfterExecution,
      preexisting_git_status: gitStatusDelta.preexistingGitStatus,
      new_git_status: gitStatusDelta.newGitStatus,
      changed_files: gitStatusDelta.changedFiles,
      failure_code: "no_git_changes",
      failure_reason:
        "Execution attempt finished without any new git-visible workspace changes beyond the preflight baseline, so the runtime cannot treat it as a verified implementation step.",
      command_results: [],
      synced_self_bootstrap_artifacts: null,
      created_at: new Date().toISOString()
    });
  }

  const commands: VerificationCommand[] = verificationPlan.commands;
  const dangerousCommandFinding = findDangerousVerificationCommand(
    commands.map((command) => command.command)
  );
  let safetyCheckpointChecks: AttemptPreflightCheck[] = [];
  if (
    dangerousCommandFinding &&
    canCheckpointMitigateDangerousCommand(dangerousCommandFinding)
  ) {
    const safetyCheckpoint = await createDangerousVerificationSafetyCheckpoint({
      run: input.run,
      attempt: input.attempt,
      repoRoot,
      finding: dangerousCommandFinding,
      changedFiles: gitStatusDelta.changedFiles,
      preexistingStatusBefore: checkpointPreflight.status_before
    });
    safetyCheckpointChecks = safetyCheckpoint.checks;
    if (!safetyCheckpoint.ok) {
      const currentGitStatus = await readGitStatus(repoRoot);
      const currentGitStatusDelta = await buildGitExecutionDelta({
        repoRoot,
        statusBefore: checkpointPreflight.status_before,
        statusAfter: currentGitStatus,
        headBefore: checkpointPreflight.head_before,
        headAfter: await readGitHead(repoRoot)
      });

      return await writeVerificationArtifact(input.attemptPaths, {
        attempt_id: input.attempt.id,
        run_id: input.run.id,
        attempt_type: input.attempt.attempt_type,
        status: "failed",
        verifier_kit: verifierKit,
        repo_root: repoRoot,
        git_head: await readGitHead(repoRoot),
        git_status: currentGitStatus,
        preexisting_git_status: currentGitStatusDelta.preexistingGitStatus,
        new_git_status: currentGitStatusDelta.newGitStatus,
        changed_files: currentGitStatusDelta.changedFiles,
        failure_code: "verification_command_failed",
        failure_reason: safetyCheckpoint.failureReason,
        checks: safetyCheckpointChecks,
        command_results: [],
        synced_self_bootstrap_artifacts: null,
        created_at: new Date().toISOString()
      });
    }
  }

  const verificationDir = join(input.attemptPaths.artifactsDir, "runtime-verification");
  await mkdir(verificationDir, { recursive: true });

  const commandResults: VerificationCommandResult[] = [];
  let syncedSelfBootstrapArtifacts: SyncedSelfBootstrapArtifacts | null = null;

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index]!;
    const resolvedCwd = resolveVerificationCwd(workspaceRoot, command);
    if (!resolvedCwd.ok) {
      return await writeVerificationArtifact(input.attemptPaths, {
        attempt_id: input.attempt.id,
        run_id: input.run.id,
        attempt_type: input.attempt.attempt_type,
        status: "failed",
        verifier_kit: verifierKit,
        repo_root: repoRoot,
        git_head: gitHead,
        git_status: gitStatusAfterExecution,
        preexisting_git_status: gitStatusDelta.preexistingGitStatus,
        new_git_status: gitStatusDelta.newGitStatus,
        changed_files: gitStatusDelta.changedFiles,
        failure_code: "invalid_verification_plan",
        failure_reason: resolvedCwd.reason,
        command_results: commandResults,
        synced_self_bootstrap_artifacts: syncedSelfBootstrapArtifacts,
        created_at: new Date().toISOString()
      });
    }

    const logStem = join(
      verificationDir,
      `command-${String(index + 1).padStart(2, "0")}`
    );
    const stdoutFile = `${logStem}.stdout.log`;
    const stderrFile = `${logStem}.stderr.log`;
    const expectedExitCode = command.expected_exit_code ?? 0;
    const runResult = await runVerificationCommand({
      command: command.command,
      cwd: resolvedCwd.cwd,
      stdoutFile,
      stderrFile,
      timeoutMs: input.timeoutMs ?? DEFAULT_RUNTIME_VERIFICATION_TIMEOUT_MS
    });

    const commandResult: VerificationCommandResult = {
      purpose: command.purpose,
      command: command.command,
      cwd: resolvedCwd.cwd,
      expected_exit_code: expectedExitCode,
      exit_code: runResult.exitCode,
      passed: runResult.exitCode === expectedExitCode,
      stdout_file: stdoutFile,
      stderr_file: stderrFile
    };
    commandResults.push(commandResult);

    if (!commandResult.passed) {
      const currentGitStatus = await readGitStatus(repoRoot);
      const currentGitStatusDelta = await buildGitExecutionDelta({
        repoRoot,
        statusBefore: checkpointPreflight.status_before,
        statusAfter: currentGitStatus,
        headBefore: checkpointPreflight.head_before,
        headAfter: await readGitHead(repoRoot)
      });

      return await writeVerificationArtifact(input.attemptPaths, {
        attempt_id: input.attempt.id,
        run_id: input.run.id,
        attempt_type: input.attempt.attempt_type,
        status: "failed",
        verifier_kit: verifierKit,
        repo_root: repoRoot,
        git_head: gitHead,
        git_status: currentGitStatus,
        preexisting_git_status: currentGitStatusDelta.preexistingGitStatus,
        new_git_status: currentGitStatusDelta.newGitStatus,
        changed_files: currentGitStatusDelta.changedFiles,
        failure_code: "verification_command_failed",
        failure_reason: [
          `Verification command failed for "${command.purpose}".`,
          `Expected exit code ${expectedExitCode}, got ${runResult.exitCode}.`,
          `Command: ${command.command}`
        ].join(" "),
        command_results: commandResults,
        synced_self_bootstrap_artifacts: syncedSelfBootstrapArtifacts,
        created_at: new Date().toISOString()
      });
    }

    try {
      const syncedArtifacts = await maybeSyncSelfBootstrapVerificationArtifacts({
        command: command.command,
        stdoutFile,
        workspaceRoot,
        repoRoot,
        attemptPaths: input.attemptPaths
      });
      if (syncedArtifacts) {
        syncedSelfBootstrapArtifacts = syncedArtifacts;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const currentGitStatus = await readGitStatus(repoRoot);
      const currentGitStatusDelta = await buildGitExecutionDelta({
        repoRoot,
        statusBefore: checkpointPreflight.status_before,
        statusAfter: currentGitStatus,
        headBefore: checkpointPreflight.head_before,
        headAfter: await readGitHead(repoRoot)
      });

      return await writeVerificationArtifact(input.attemptPaths, {
        attempt_id: input.attempt.id,
        run_id: input.run.id,
        attempt_type: input.attempt.attempt_type,
        status: "failed",
        verifier_kit: verifierKit,
        repo_root: repoRoot,
        git_head: gitHead,
        git_status: currentGitStatus,
        preexisting_git_status: currentGitStatusDelta.preexistingGitStatus,
        new_git_status: currentGitStatusDelta.newGitStatus,
        changed_files: currentGitStatusDelta.changedFiles,
        failure_code: "verification_command_failed",
        failure_reason: [
          `Verification command "${command.purpose}" did not preserve self-bootstrap evidence correctly.`,
          reason
        ].join(" "),
        command_results: commandResults,
        synced_self_bootstrap_artifacts: syncedSelfBootstrapArtifacts,
        created_at: new Date().toISOString()
      });
    }
  }

  const finalGitStatus = await readGitStatus(repoRoot);
  const finalGitStatusDelta = await buildGitExecutionDelta({
    repoRoot,
    statusBefore: checkpointPreflight.status_before,
    statusAfter: finalGitStatus,
    headBefore: checkpointPreflight.head_before,
    headAfter: await readGitHead(repoRoot)
  });
  const runtimeKitAssessment = buildVerifierKitRuntimeChecks({
    verifierKit,
    result: input.result
  });
  const verificationOnlyRecoveryChecks = buildVerificationOnlyRecoveryChecks(
    verificationOnlyRecovery,
    finalGitStatusDelta.changedFiles
  );
  const runtimeChecks = [
    ...safetyCheckpointChecks,
    ...verificationOnlyRecoveryChecks,
    ...runtimeKitAssessment.checks
  ];
  if (runtimeKitAssessment.failureReason) {
    return await writeVerificationArtifact(input.attemptPaths, {
      attempt_id: input.attempt.id,
      run_id: input.run.id,
      attempt_type: input.attempt.attempt_type,
      status: "failed",
      verifier_kit: verifierKit,
      repo_root: repoRoot,
      git_head: gitHead,
      git_status: finalGitStatus,
      preexisting_git_status: finalGitStatusDelta.preexistingGitStatus,
      new_git_status: finalGitStatusDelta.newGitStatus,
      changed_files: finalGitStatusDelta.changedFiles,
      failure_code: runtimeKitAssessment.failureCode,
      failure_reason: runtimeKitAssessment.failureReason,
      checks: runtimeChecks,
      command_results: commandResults,
      synced_self_bootstrap_artifacts: syncedSelfBootstrapArtifacts,
      created_at: new Date().toISOString()
    });
  }

  return await writeVerificationArtifact(input.attemptPaths, {
    attempt_id: input.attempt.id,
    run_id: input.run.id,
    attempt_type: input.attempt.attempt_type,
    status: "passed",
    verifier_kit: verifierKit,
    repo_root: repoRoot,
    git_head: await readGitHead(repoRoot),
    git_status: finalGitStatus,
    preexisting_git_status: finalGitStatusDelta.preexistingGitStatus,
    new_git_status: finalGitStatusDelta.newGitStatus,
    changed_files: finalGitStatusDelta.changedFiles,
    failure_code: null,
    failure_reason: null,
    checks: runtimeChecks,
    command_results: commandResults,
    synced_self_bootstrap_artifacts: syncedSelfBootstrapArtifacts,
    created_at: new Date().toISOString()
  });
}

function isVerificationOnlyRecoveryAttempt(input: {
  attempt: Attempt;
  attemptContract: AttemptContract;
}): boolean {
  if (input.attempt.attempt_type !== "execution") {
    return false;
  }

  const contract = input.attemptContract;
  if ((contract.verification_plan?.commands.length ?? 0) === 0) {
    return false;
  }

  const text = [
    input.attempt.objective,
    contract.objective,
    ...contract.required_evidence,
    ...contract.forbidden_shortcuts,
    ...contract.expected_artifacts,
    ...contract.done_rubric.map(
      (item: AttemptContract["done_rubric"][number]) =>
        `${item.code} ${item.description}`
    ),
    ...contract.failure_modes.map(
      (item: AttemptContract["failure_modes"][number]) =>
        `${item.code} ${item.description}`
    )
  ]
    .join("\n")
    .toLowerCase();

  const saysRecovery =
    text.includes("recovery only") ||
    text.includes("verification-only") ||
    text.includes("verification only") ||
    text.includes("postflight") ||
    text.includes("恢复") ||
    text.includes("复核") ||
    text.includes("重跑");
  const saysNoContentChange =
    text.includes("do not change") ||
    text.includes("do not add a second") ||
    text.includes("no new product commit") ||
    text.includes("不要改") ||
    text.includes("不要新增") ||
    text.includes("未改");

  return saysRecovery && saysNoContentChange;
}

function buildVerificationOnlyRecoveryChecks(
  verificationOnlyRecovery: boolean,
  changedFiles: string[]
): RuntimeVerificationCheck[] {
  if (!verificationOnlyRecovery) {
    return [];
  }

  return [
    {
      code: "verification_only_recovery_replayed",
      status: "passed",
      message:
        changedFiles.length === 0
          ? "Explicit verification-only recovery left no new git delta and replayed the locked verification commands."
          : "Explicit verification-only recovery replayed the locked verification commands after a git delta appeared."
    }
  ];
}

async function buildFailedVerificationArtifact(input: {
  run: Run;
  attempt: Attempt;
  attemptPaths: AttemptPaths;
  verifierKit?: ExecutionVerifierKit | null;
  failureCode: RuntimeVerificationFailureCode;
  failureReason: string;
}): Promise<AttemptRuntimeVerificationOutcome> {
  return writeVerificationArtifact(input.attemptPaths, {
    attempt_id: input.attempt.id,
    run_id: input.run.id,
    attempt_type: input.attempt.attempt_type,
    status: "failed",
    verifier_kit: input.verifierKit ?? null,
    repo_root: null,
    git_head: null,
    git_status: [],
    preexisting_git_status: [],
    new_git_status: [],
    changed_files: [],
    failure_code: input.failureCode,
    failure_reason: input.failureReason,
    command_results: [],
    synced_self_bootstrap_artifacts: null,
    created_at: new Date().toISOString()
  });
}

async function writeVerificationArtifact(
  attemptPaths: AttemptPaths,
  verification: AttemptRuntimeVerification
): Promise<AttemptRuntimeVerificationOutcome> {
  const artifactPath = attemptPaths.runtimeVerificationFile;
  const parsed = AttemptRuntimeVerificationSchema.parse(
    annotateRuntimeVerificationFailure(verification)
  );
  await writeJsonFile(artifactPath, parsed);
  return {
    verification: parsed,
    artifact_path: artifactPath
  };
}

type SafetyCheckpointResult =
  | {
      ok: true;
      checks: AttemptPreflightCheck[];
    }
  | {
      ok: false;
      checks: AttemptPreflightCheck[];
      failureReason: string;
    };

async function createDangerousVerificationSafetyCheckpoint(input: {
  run: Run;
  attempt: Attempt;
  repoRoot: string;
  finding: DangerousVerificationCommandFinding;
  changedFiles: string[];
  preexistingStatusBefore: string[];
}): Promise<SafetyCheckpointResult> {
  if (input.preexistingStatusBefore.length > 0) {
    const failureReason = [
      "Dangerous runtime replay requires a clean preflight baseline before AISA can checkpoint and continue.",
      `Preexisting changes: ${input.preexistingStatusBefore.slice(0, 5).join("; ")}`
    ].join(" ");
    return {
      ok: false,
      failureReason,
      checks: [
        {
          code: "dangerous_verification_safety_checkpoint",
          status: "failed",
          message: failureReason
        }
      ]
    };
  }

  if (input.changedFiles.length === 0) {
    return {
      ok: true,
      checks: [
        {
          code: "dangerous_verification_safety_checkpoint",
          status: "not_applicable",
          message:
            "Dangerous runtime replay was detected, but there were no git-visible execution changes to checkpoint."
        }
      ]
    };
  }

  const addResult = await runGit(input.repoRoot, [
    "add",
    "-A",
    "--",
    ...input.changedFiles
  ]);
  if (addResult.exitCode !== 0) {
    const failureReason =
      "AISA could not stage execution changes for the safety checkpoint before dangerous runtime replay.";
    return {
      ok: false,
      failureReason,
      checks: [
        {
          code: "dangerous_verification_safety_checkpoint",
          status: "failed",
          message: failureReason
        }
      ]
    };
  }

  const subject = `AISA safety checkpoint: ${input.run.id} ${input.attempt.id}`;
  const body = [
    `Run: ${input.run.title}`,
    `Run ID: ${input.run.id}`,
    `Attempt ID: ${input.attempt.id}`,
    `Dangerous replay command: ${input.finding.command}`,
    `Dangerous replay rule: ${input.finding.rule}`,
    `Changed files: ${input.changedFiles.join(", ")}`
  ].join("\n");
  const commitResult = await runGit(input.repoRoot, [
    "-c",
    "user.name=AISA",
    "-c",
    "user.email=aisa@local",
    "commit",
    "-m",
    subject,
    "-m",
    body
  ]);
  if (commitResult.exitCode !== 0) {
    const failureReason =
      "AISA could not create the safety checkpoint before dangerous runtime replay.";
    return {
      ok: false,
      failureReason,
      checks: [
        {
          code: "dangerous_verification_safety_checkpoint",
          status: "failed",
          message: failureReason
        }
      ]
    };
  }

  const headAfter = await readGitHead(input.repoRoot);
  return {
    ok: true,
    checks: [
      {
        code: "dangerous_verification_safety_checkpoint",
        status: "passed",
        message: `Created safety checkpoint ${headAfter ?? "unknown"} before dangerous runtime replay.`
      }
    ]
  };
}

async function readCheckpointPreflight(
  attemptPaths: AttemptPaths
): Promise<GitCheckpointPreflightArtifact | null> {
  try {
    return await readJsonFile<GitCheckpointPreflightArtifact>(
      join(attemptPaths.artifactsDir, CHECKPOINT_PREFLIGHT_FILE_NAME)
    );
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }

    throw error;
  }
}

function buildGitStatusDelta(input: {
  statusBefore: string[];
  statusAfter: string[];
}): GitStatusDelta {
  const remainingPreexistingStatus = new Map<string, number>();
  for (const line of input.statusBefore) {
    remainingPreexistingStatus.set(line, (remainingPreexistingStatus.get(line) ?? 0) + 1);
  }

  const newGitStatus: string[] = [];
  for (const line of input.statusAfter) {
    const remainingCount = remainingPreexistingStatus.get(line) ?? 0;
    if (remainingCount > 0) {
      remainingPreexistingStatus.set(line, remainingCount - 1);
      continue;
    }

    newGitStatus.push(line);
  }

  return {
    preexistingGitStatus: [...input.statusBefore],
    newGitStatus,
    changedFiles: extractChangedFiles(newGitStatus)
  };
}

async function buildGitExecutionDelta(input: {
  repoRoot: string;
  statusBefore: string[];
  statusAfter: string[];
  headBefore: string | null;
  headAfter: string | null;
}): Promise<GitExecutionDelta> {
  const statusDelta = buildGitStatusDelta({
    statusBefore: input.statusBefore,
    statusAfter: input.statusAfter
  });
  const committedFiles = await readCommittedChangedFiles({
    repoRoot: input.repoRoot,
    headBefore: input.headBefore,
    headAfter: input.headAfter
  });

  return {
    ...statusDelta,
    committedFiles,
    changedFiles: mergeChangedFiles(statusDelta.changedFiles, committedFiles)
  };
}

async function readCommittedChangedFiles(input: {
  repoRoot: string;
  headBefore: string | null;
  headAfter: string | null;
}): Promise<string[]> {
  if (!input.headBefore || !input.headAfter || input.headBefore === input.headAfter) {
    return [];
  }

  const result = await runGit(input.repoRoot, [
    "diff",
    "--name-only",
    `${input.headBefore}..${input.headAfter}`
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Runtime verification could not inspect committed changes from ${input.headBefore} to ${input.headAfter}.`
    );
  }

  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function mergeChangedFiles(
  statusChangedFiles: string[],
  committedFiles: string[]
): string[] {
  return [...new Set([...statusChangedFiles, ...committedFiles])].sort();
}

export async function probeVerificationCommandReadiness(input: {
  workspaceRoot: string;
  command: VerificationCommand;
}): Promise<VerificationCommandReadiness> {
  const resolvedCwd = resolveVerificationCwd(input.workspaceRoot, input.command);
  if (!resolvedCwd.ok) {
    return {
      ok: false,
      cwd: null,
      executable: null,
      reason: resolvedCwd.reason
    };
  }

  try {
    const cwdStat = await stat(resolvedCwd.cwd);
    if (!cwdStat.isDirectory()) {
      return {
        ok: false,
        cwd: resolvedCwd.cwd,
        executable: null,
        reason: `Verification command "${input.command.purpose}" uses cwd "${input.command.cwd ?? "."}" but that path is not a directory.`
      };
    }
  } catch {
    return {
      ok: false,
      cwd: resolvedCwd.cwd,
      executable: null,
      reason: `Verification command "${input.command.purpose}" uses cwd "${input.command.cwd ?? "."}" but that path is missing or unreadable.`
    };
  }

  const executable = extractVerificationCommandExecutable(input.command.command);
  if (!executable) {
    return {
      ok: false,
      cwd: resolvedCwd.cwd,
      executable: null,
      reason: `Verification command "${input.command.purpose}" does not expose a runnable executable token.`
    };
  }

  if (isPathLikeExecutable(executable)) {
    const resolvedExecutable = isAbsolute(executable)
      ? executable
      : resolve(resolvedCwd.cwd, executable);
    try {
      await access(resolvedExecutable, fsConstants.X_OK);
      return {
        ok: true,
        cwd: resolvedCwd.cwd,
        executable: resolvedExecutable
      };
    } catch {
      return {
        ok: false,
        cwd: resolvedCwd.cwd,
        executable: resolvedExecutable,
        reason: `Verification command "${input.command.purpose}" cannot execute "${executable}" from cwd "${relative(input.workspaceRoot, resolvedCwd.cwd) || "."}".`
      };
    }
  }

  if (await shellCanResolveExecutable(executable, resolvedCwd.cwd)) {
    return {
      ok: true,
      cwd: resolvedCwd.cwd,
      executable
    };
  }

  return {
    ok: false,
    cwd: resolvedCwd.cwd,
    executable,
    reason: `Verification command "${input.command.purpose}" cannot resolve executable "${executable}" from cwd "${relative(input.workspaceRoot, resolvedCwd.cwd) || "."}".`
  };
}

export function resolveVerificationCwd(
  workspaceRoot: string,
  command: VerificationCommand
):
  | {
      ok: true;
      cwd: string;
    }
  | {
      ok: false;
      reason: string;
    } {
  const cwd = command.cwd ? resolve(workspaceRoot, command.cwd) : workspaceRoot;
  const relativePath = relative(workspaceRoot, cwd);

  if (relativePath.startsWith("..") || relativePath === "") {
    if (relativePath === "" || cwd === workspaceRoot) {
      return {
        ok: true,
        cwd
      };
    }

    return {
      ok: false,
      reason: `Verification command "${command.purpose}" points outside the workspace root.`
    };
  }

  return {
    ok: true,
    cwd
  };
}

function extractVerificationCommandExecutable(command: string): string | null {
  const tokens = command.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];

  for (const token of tokens) {
    const normalizedToken = stripShellTokenQuotes(token);
    if (normalizedToken.length === 0) {
      continue;
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(normalizedToken)) {
      continue;
    }

    return normalizedToken;
  }

  return null;
}

function stripShellTokenQuotes(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }

  return token;
}

function isPathLikeExecutable(token: string): boolean {
  return isAbsolute(token) || token.includes("/");
}

function shellEscapeSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function shellCanResolveExecutable(executable: string, cwd: string): Promise<boolean> {
  const shell = await resolveVerificationShell();

  return await new Promise<boolean>((resolve) => {
    const child = spawn(
      shell,
      ["-lc", `command -v ${shellEscapeSingleQuoted(executable)} >/dev/null 2>&1`],
      {
        cwd,
        stdio: "ignore"
      }
    );
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function isSelfBootstrapVerificationCommand(command: string): boolean {
  const normalizedCommand = command.trim();

  return (
    /^pnpm\s+verify:self-bootstrap(?:\s|$)/u.test(normalizedCommand) ||
    /scripts\/verify-self-bootstrap\.ts(?:\s|$)/u.test(normalizedCommand) ||
    /self-bootstrap-sync-fixture\/emit-self-bootstrap-sync-evidence\.mjs(?:\s|$)/u.test(
      normalizedCommand
    )
  );
}

async function maybeSyncSelfBootstrapVerificationArtifacts(input: {
  command: string;
  stdoutFile: string;
  workspaceRoot: string;
  repoRoot: string;
  attemptPaths: AttemptPaths;
}): Promise<SyncedSelfBootstrapArtifacts | null> {
  if (!isSelfBootstrapVerificationCommand(input.command)) {
    return null;
  }

  const report = await readSelfBootstrapVerificationReport(input.stdoutFile);
  const syncedArtifacts = {} as SyncedSelfBootstrapArtifacts;

  for (const target of SELF_BOOTSTRAP_RUNTIME_SYNC_TARGETS) {
    const sourcePath = resolveReportedArtifactPath({
      repoRoot: input.repoRoot,
      workspaceRoot: input.workspaceRoot,
      report,
      key: target.reportKey,
      label: target.label
    });
    const targetPath = join(input.attemptPaths.artifactsDir, target.targetFileName);
    await cp(sourcePath, targetPath);
    syncedArtifacts[target.artifactKey] = targetPath;
  }

  return syncedArtifacts;
}

async function readSelfBootstrapVerificationReport(
  stdoutFile: string
): Promise<SelfBootstrapVerificationReport> {
  const raw = await readFile(stdoutFile, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("verify:self-bootstrap should emit a JSON object report");
  }

  return parsed as SelfBootstrapVerificationReport;
}

function resolveReportedArtifactPath(input: {
  repoRoot: string;
  workspaceRoot: string;
  report: SelfBootstrapVerificationReport;
  key: (typeof SELF_BOOTSTRAP_RUNTIME_SYNC_TARGETS)[number]["reportKey"];
  label: string;
}): string {
  const rawValue = input.report[input.key];

  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    throw new Error(`verify:self-bootstrap should expose ${input.label}`);
  }

  const resolvedPath = isAbsolute(rawValue)
    ? rawValue
    : resolve(input.workspaceRoot, rawValue);
  const relativeToRepoRoot = relative(input.repoRoot, resolvedPath);

  if (
    relativeToRepoRoot.startsWith("..") ||
    isAbsolute(relativeToRepoRoot)
  ) {
    throw new Error(`${input.label} should stay inside the git workspace root`);
  }

  return resolvedPath;
}

async function runVerificationCommand(input: {
  command: string;
  cwd: string;
  stdoutFile: string;
  stderrFile: string;
  timeoutMs: number;
}): Promise<{
  exitCode: number;
}> {
  const stdoutStream = createWriteStream(input.stdoutFile, { flags: "w" });
  const stderrStream = createWriteStream(input.stderrFile, { flags: "w" });

  try {
    const shellExecutable = await resolveVerificationShell();
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(shellExecutable, ["-lc", input.command], {
        cwd: input.cwd,
        stdio: ["ignore", "pipe", "pipe"]
      });

      const timer = setTimeout(() => {
        stderrStream.write(
          `AISA runtime verification timed out after ${input.timeoutMs}ms while running: ${input.command}\n`
        );
        child.kill("SIGTERM");
      }, input.timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdoutStream.write(chunk);
      });

      child.stderr.on("data", (chunk) => {
        stderrStream.write(chunk);
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });

    return {
      exitCode
    };
  } finally {
    await Promise.all([closeStream(stdoutStream), closeStream(stderrStream)]);
  }
}

async function closeStream(stream: {
  end: (callback?: () => void) => void;
  once: (event: string, listener: (error: Error) => void) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

async function resolveGitRepoRoot(workspaceRoot: string): Promise<string | null> {
  const result = await runGit(workspaceRoot, ["rev-parse", "--show-toplevel"]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function readGitHead(repoRoot: string): Promise<string | null> {
  const result = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function readGitStatus(repoRoot: string): Promise<string[]> {
  const result = await runGit(repoRoot, ["status", "--porcelain=v1", "--untracked=all"]);
  if (result.exitCode !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
}

function extractChangedFiles(statusLines: string[]): string[] {
  const changedFiles = new Set<string>();

  for (const line of statusLines) {
    const pathText = line.slice(3).trim();
    if (!pathText) {
      continue;
    }

    const normalizedPath = pathText.includes(" -> ")
      ? pathText.split(" -> ").at(-1) ?? pathText
      : pathText;
    changedFiles.add(normalizedPath);
  }

  return [...changedFiles].sort();
}

async function runGit(
  cwd: string,
  args: string[]
): Promise<{
  exitCode: number;
  stdout: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"]
    });
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout
      });
    });
  });
}
