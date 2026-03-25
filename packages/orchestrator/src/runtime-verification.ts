import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, relative, resolve } from "node:path";
import {
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
import { writeJsonFile } from "@autoresearch/state-store";

export interface AttemptRuntimeVerificationOutcome {
  verification: AttemptRuntimeVerification;
  artifact_path: string;
}

export async function runAttemptRuntimeVerification(input: {
  run: Run;
  attempt: Attempt;
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
      changed_files: [],
      failure_code: null,
      failure_reason: null,
      command_results: [],
      created_at: new Date().toISOString()
    });
  }

  if (!input.result.verification_plan) {
    return await buildFailedVerificationArtifact({
      run: input.run,
      attempt: input.attempt,
      attemptPaths: input.attemptPaths,
      failureCode: "missing_verification_plan",
      failureReason:
        "Execution result did not include a verification plan. Runtime verification only trusts commands it can replay itself."
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
  const gitStatusAfterExecution = await readGitStatus(repoRoot);
  const changedFilesAfterExecution = extractChangedFiles(gitStatusAfterExecution);

  if (changedFilesAfterExecution.length === 0) {
    return await writeVerificationArtifact(input.attemptPaths, {
      attempt_id: input.attempt.id,
      run_id: input.run.id,
      attempt_type: input.attempt.attempt_type,
      status: "failed",
      repo_root: repoRoot,
      git_head: gitHead,
      git_status: gitStatusAfterExecution,
      changed_files: changedFilesAfterExecution,
      failure_code: "no_git_changes",
      failure_reason:
        "Execution attempt finished without any git-visible workspace changes, so the runtime cannot treat it as a verified implementation step.",
      command_results: [],
      created_at: new Date().toISOString()
    });
  }

  const verificationDir = join(input.attemptPaths.artifactsDir, "runtime-verification");
  await mkdir(verificationDir, { recursive: true });

  const commandResults: VerificationCommandResult[] = [];
  const commands = input.result.verification_plan.commands;

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
        changed_files: changedFilesAfterExecution,
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
      return await writeVerificationArtifact(input.attemptPaths, {
        attempt_id: input.attempt.id,
        run_id: input.run.id,
        attempt_type: input.attempt.attempt_type,
        status: "failed",
        repo_root: repoRoot,
        git_head: gitHead,
        git_status: await readGitStatus(repoRoot),
        changed_files: extractChangedFiles(await readGitStatus(repoRoot)),
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
  return await writeVerificationArtifact(input.attemptPaths, {
    attempt_id: input.attempt.id,
    run_id: input.run.id,
    attempt_type: input.attempt.attempt_type,
    status: "passed",
    repo_root: repoRoot,
    git_head: gitHead,
    git_status: finalGitStatus,
    changed_files: extractChangedFiles(finalGitStatus),
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
