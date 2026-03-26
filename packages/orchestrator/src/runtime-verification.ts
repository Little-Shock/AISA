import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, relative, resolve } from "node:path";
import {
  isExecutionAttemptContractReady,
  type AttemptContract,
  AttemptRuntimeVerificationSchema,
  type Attempt,
  type AttemptRuntimeVerification,
  type RuntimeVerificationFailureCode,
  type Run,
  type VerificationCommand,
  type VerificationCommandResult,
  type WorkerWriteback
} from "@autoresearch/domain";
import type { AttemptPaths } from "@autoresearch/state-store";
import { readJsonFile, writeJsonFile } from "@autoresearch/state-store";

export interface AttemptRuntimeVerificationOutcome {
  verification: AttemptRuntimeVerification;
  artifact_path: string;
}

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

export function detectLiveRuntimeSourceDrift(changedFiles: string[]): string[] {
  return [...new Set(changedFiles)]
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
      repo_root: null,
      git_head: null,
      git_status: [],
      preexisting_git_status: [],
      new_git_status: [],
      changed_files: [],
      failure_code: null,
      failure_reason: null,
      command_results: [],
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
  if (!isExecutionAttemptContractReady(attemptContract)) {
    return await buildFailedVerificationArtifact({
      run: input.run,
      attempt: input.attempt,
      attemptPaths: input.attemptPaths,
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
      created_at: new Date().toISOString()
    });
  }

  const gitStatusAfterExecution = await readGitStatus(repoRoot);
  const gitStatusDelta = buildGitStatusDelta({
    statusBefore: checkpointPreflight.status_before,
    statusAfter: gitStatusAfterExecution
  });

  if (gitStatusDelta.changedFiles.length === 0) {
    return await writeVerificationArtifact(input.attemptPaths, {
      attempt_id: input.attempt.id,
      run_id: input.run.id,
      attempt_type: input.attempt.attempt_type,
      status: "failed",
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
      created_at: new Date().toISOString()
    });
  }

  const verificationDir = join(input.attemptPaths.artifactsDir, "runtime-verification");
  await mkdir(verificationDir, { recursive: true });

  const commandResults: VerificationCommandResult[] = [];
  const commands = verificationPlan.commands;

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index]!;
    const resolvedCwd = resolveVerificationCwd(workspaceRoot, command);
    if (!resolvedCwd.ok) {
      return await writeVerificationArtifact(input.attemptPaths, {
        attempt_id: input.attempt.id,
        run_id: input.run.id,
        attempt_type: input.attempt.attempt_type,
        status: "failed",
        repo_root: repoRoot,
        git_head: gitHead,
        git_status: gitStatusAfterExecution,
        preexisting_git_status: gitStatusDelta.preexistingGitStatus,
        new_git_status: gitStatusDelta.newGitStatus,
        changed_files: gitStatusDelta.changedFiles,
        failure_code: "invalid_verification_plan",
        failure_reason: resolvedCwd.reason,
        command_results: commandResults,
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
      timeoutMs: input.timeoutMs ?? 300_000
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
      const currentGitStatusDelta = buildGitStatusDelta({
        statusBefore: checkpointPreflight.status_before,
        statusAfter: currentGitStatus
      });

      return await writeVerificationArtifact(input.attemptPaths, {
        attempt_id: input.attempt.id,
        run_id: input.run.id,
        attempt_type: input.attempt.attempt_type,
        status: "failed",
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
        created_at: new Date().toISOString()
      });
    }
  }

  const finalGitStatus = await readGitStatus(repoRoot);
  const finalGitStatusDelta = buildGitStatusDelta({
    statusBefore: checkpointPreflight.status_before,
    statusAfter: finalGitStatus
  });
  return await writeVerificationArtifact(input.attemptPaths, {
    attempt_id: input.attempt.id,
    run_id: input.run.id,
    attempt_type: input.attempt.attempt_type,
    status: "passed",
    repo_root: repoRoot,
    git_head: gitHead,
    git_status: finalGitStatus,
    preexisting_git_status: finalGitStatusDelta.preexistingGitStatus,
    new_git_status: finalGitStatusDelta.newGitStatus,
    changed_files: finalGitStatusDelta.changedFiles,
    failure_code: null,
    failure_reason: null,
    command_results: commandResults,
    created_at: new Date().toISOString()
  });
}

async function buildFailedVerificationArtifact(input: {
  run: Run;
  attempt: Attempt;
  attemptPaths: AttemptPaths;
  failureCode: RuntimeVerificationFailureCode;
  failureReason: string;
}): Promise<AttemptRuntimeVerificationOutcome> {
  return await writeVerificationArtifact(input.attemptPaths, {
    attempt_id: input.attempt.id,
    run_id: input.run.id,
    attempt_type: input.attempt.attempt_type,
    status: "failed",
    repo_root: null,
    git_head: null,
    git_status: [],
    preexisting_git_status: [],
    new_git_status: [],
    changed_files: [],
    failure_code: input.failureCode,
    failure_reason: input.failureReason,
    command_results: [],
    created_at: new Date().toISOString()
  });
}

async function writeVerificationArtifact(
  attemptPaths: AttemptPaths,
  verification: AttemptRuntimeVerification
): Promise<AttemptRuntimeVerificationOutcome> {
  const artifactPath = attemptPaths.runtimeVerificationFile;
  const parsed = AttemptRuntimeVerificationSchema.parse(verification);
  await writeJsonFile(artifactPath, parsed);
  return {
    verification: parsed,
    artifact_path: artifactPath
  };
}

async function readCheckpointPreflight(
  attemptPaths: AttemptPaths
): Promise<GitCheckpointPreflightArtifact | null> {
  try {
    return await readJsonFile<GitCheckpointPreflightArtifact>(
      join(attemptPaths.artifactsDir, CHECKPOINT_PREFLIGHT_FILE_NAME)
    );
  } catch {
    return null;
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

function resolveVerificationCwd(
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
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn("/bin/zsh", ["-lc", input.command], {
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
