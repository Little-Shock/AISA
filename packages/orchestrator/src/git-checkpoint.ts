import { spawn } from "node:child_process";
import { join, relative, resolve } from "node:path";
import type { Attempt, AttemptEvaluation, Run } from "@autoresearch/domain";
import type { AttemptPaths } from "@autoresearch/state-store";
import { writeJsonFile } from "@autoresearch/state-store";

export interface GitCheckpointPreflight {
  status: "ready" | "not_git_repo";
  repo_root: string | null;
  head_before: string | null;
  status_before: string[];
  created_at: string;
}

export type AttemptCheckpointOutcome =
  | {
      status: "created";
      message: string;
      artifact_path: string;
      commit: {
        sha: string;
        message: string;
        changed_files: string[];
      };
      includes_preexisting_changes: boolean;
      preexisting_status_before: string[];
    }
  | {
      status: "blocked";
      reason:
        | "workspace_not_clean_before_execution"
        | "git_add_failed"
        | "git_commit_failed";
      message: string;
      artifact_path: string;
    }
  | {
      status: "skipped";
      reason: "not_git_repo" | "verification_not_passed" | "no_changes";
      message: string;
      artifact_path: string;
    }
  | {
      status: "not_applicable";
      reason: "not_execution";
    };

const PREFLIGHT_FILE_NAME = "git-checkpoint-preflight.json";
const CHECKPOINT_FILE_NAME = "git-checkpoint.json";
const CHECKPOINT_AUTHOR_NAME = "AISA";
const CHECKPOINT_AUTHOR_EMAIL = "aisa@local";

export async function captureAttemptCheckpointPreflight(input: {
  attempt: Attempt;
  attemptPaths: AttemptPaths;
}): Promise<GitCheckpointPreflight | null> {
  if (input.attempt.attempt_type !== "execution") {
    return null;
  }

  const repoRoot = await resolveGitRepoRoot(input.attempt.workspace_root);
  if (!repoRoot) {
    const preflight: GitCheckpointPreflight = {
      status: "not_git_repo",
      repo_root: null,
      head_before: null,
      status_before: [],
      created_at: new Date().toISOString()
    };
    await writeJsonFile(join(input.attemptPaths.artifactsDir, PREFLIGHT_FILE_NAME), preflight);
    return preflight;
  }

  const [headBefore, statusBefore] = await Promise.all([
    readGitHead(repoRoot),
    readGitStatus(repoRoot)
  ]);

  const preflight: GitCheckpointPreflight = {
    status: "ready",
    repo_root: repoRoot,
    head_before: headBefore,
    status_before: statusBefore,
    created_at: new Date().toISOString()
  };
  await writeJsonFile(join(input.attemptPaths.artifactsDir, PREFLIGHT_FILE_NAME), preflight);
  return preflight;
}

export async function maybeCreateVerifiedExecutionCheckpoint(input: {
  run: Run;
  attempt: Attempt;
  evaluation: AttemptEvaluation;
  attemptPaths: AttemptPaths;
  preflight: GitCheckpointPreflight | null;
}): Promise<AttemptCheckpointOutcome> {
  if (input.attempt.attempt_type !== "execution") {
    return {
      status: "not_applicable",
      reason: "not_execution"
    };
  }

  if (input.evaluation.verification_status !== "passed") {
    return await writeCheckpointArtifact(input.attemptPaths, {
      status: "skipped",
      reason: "verification_not_passed",
      message: "Execution did not reach passed verification, so no auto-checkpoint was created."
    });
  }

  if (!input.preflight || input.preflight.status !== "ready" || !input.preflight.repo_root) {
    return await writeCheckpointArtifact(input.attemptPaths, {
      status: "skipped",
      reason: "not_git_repo",
      message: "Workspace is not a git repository, so execution auto-checkpoint is not available."
    });
  }

  const canAbsorbPreexistingManagedWorkspaceChanges =
    input.preflight.status_before.length > 0 &&
    isManagedWorkspaceCheckpoint({
      run: input.run,
      attempt: input.attempt
    });

  if (
    input.preflight.status_before.length > 0 &&
    !canAbsorbPreexistingManagedWorkspaceChanges
  ) {
    return await writeCheckpointArtifact(input.attemptPaths, {
      status: "blocked",
      reason: "workspace_not_clean_before_execution",
      message: [
        "Execution auto-checkpoint requires a clean git workspace before the attempt starts.",
        `Preexisting changes: ${input.preflight.status_before.slice(0, 5).join("; ")}`
      ].join(" ")
    });
  }

  const statusAfter = await readGitStatus(input.preflight.repo_root);
  if (statusAfter.length === 0) {
    return await writeCheckpointArtifact(input.attemptPaths, {
      status: "skipped",
      reason: "no_changes",
      message: "Execution finished with verification evidence but produced no git-visible workspace changes."
    });
  }

  const subject = buildCheckpointCommitSubject(input.run, input.attempt);
  const body = buildCheckpointCommitBody(
    input.run,
    input.attempt,
    input.evaluation,
    canAbsorbPreexistingManagedWorkspaceChanges
      ? input.preflight.status_before
      : []
  );
  const commitEnv = {
    GIT_AUTHOR_NAME: CHECKPOINT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: CHECKPOINT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: CHECKPOINT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: CHECKPOINT_AUTHOR_EMAIL
  };

  const addResult = await runGit(
    input.preflight.repo_root,
    ["add", "-A"],
    commitEnv,
    true
  );
  if (addResult.exit_code !== 0) {
    return await writeCheckpointArtifact(input.attemptPaths, {
      status: "blocked",
      reason: "git_add_failed",
      message: `Failed to stage execution changes for auto-checkpoint. ${extractGitError(addResult.stderr)}`
    });
  }

  const commitResult = await runGit(
    input.preflight.repo_root,
    ["commit", "-m", subject, "-m", body],
    commitEnv,
    true
  );
  if (commitResult.exit_code !== 0) {
    return await writeCheckpointArtifact(input.attemptPaths, {
      status: "blocked",
      reason: "git_commit_failed",
      message: `Failed to create execution auto-checkpoint. ${extractGitError(commitResult.stderr)}`
    });
  }

  const [headAfter, changedFiles] = await Promise.all([
    readGitHead(input.preflight.repo_root),
    readGitCommitFiles(input.preflight.repo_root, "HEAD")
  ]);

  return await writeCheckpointArtifact(input.attemptPaths, {
    status: "created",
    message: canAbsorbPreexistingManagedWorkspaceChanges
      ? [
          `Created execution auto-checkpoint ${headAfter}.`,
          `Absorbed ${input.preflight.status_before.length} preexisting managed-workspace change entries into this catch-up checkpoint.`
        ].join(" ")
      : `Created execution auto-checkpoint ${headAfter}.`,
    commit: {
      sha: headAfter ?? "unknown",
      message: subject,
      changed_files: changedFiles
    },
    includes_preexisting_changes: canAbsorbPreexistingManagedWorkspaceChanges,
    preexisting_status_before: input.preflight.status_before
  });
}

function buildCheckpointCommitSubject(run: Run, attempt: Attempt): string {
  return `AISA checkpoint: ${run.id} ${attempt.id}`;
}

function buildCheckpointCommitBody(
  run: Run,
  attempt: Attempt,
  evaluation: AttemptEvaluation,
  preexistingStatusBefore: string[]
): string {
  const lines = [
    `Run: ${run.title}`,
    `Run ID: ${run.id}`,
    `Attempt ID: ${attempt.id}`,
    `Verification: ${evaluation.verification_status}`,
    `Goal Progress: ${evaluation.goal_progress.toFixed(2)}`
  ];

  if (preexistingStatusBefore.length > 0) {
    lines.push(
      `Managed Workspace Catch-up: true`,
      `Preexisting Status Entries: ${preexistingStatusBefore.length}`,
      `Preexisting Status Before: ${preexistingStatusBefore.slice(0, 10).join("; ")}`
    );
  }

  return lines.join("\n");
}

function isManagedWorkspaceCheckpoint(input: {
  run: Run;
  attempt: Attempt;
}): boolean {
  if (!input.run.managed_workspace_root) {
    return false;
  }

  const managedWorkspaceRoot = resolve(input.run.managed_workspace_root);
  const attemptWorkspaceRoot = resolve(input.attempt.workspace_root);
  const relativePath = relative(managedWorkspaceRoot, attemptWorkspaceRoot);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.startsWith(`..${"/"}`))
  );
}

async function resolveGitRepoRoot(workspaceRoot: string): Promise<string | null> {
  const result = await runGit(workspaceRoot, ["rev-parse", "--show-toplevel"], {}, true);
  return result.exit_code === 0 ? result.stdout.trim() : null;
}

async function readGitHead(repoRoot: string): Promise<string | null> {
  const result = await runGit(repoRoot, ["rev-parse", "HEAD"], {}, true);
  return result.exit_code === 0 ? result.stdout.trim() : null;
}

async function readGitStatus(repoRoot: string): Promise<string[]> {
  const result = await runGit(
    repoRoot,
    ["status", "--porcelain=v1", "--untracked=all"],
    {},
    true
  );

  if (result.exit_code !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
}

async function readGitCommitFiles(repoRoot: string, revision: string): Promise<string[]> {
  const result = await runGit(
    repoRoot,
    ["show", "--pretty=format:", "--name-only", revision],
    {},
    true
  );

  if (result.exit_code !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function writeCheckpointArtifact(
  attemptPaths: AttemptPaths,
  payload:
    | {
        status: "created";
        message: string;
        commit: {
          sha: string;
          message: string;
          changed_files: string[];
        };
        includes_preexisting_changes: boolean;
        preexisting_status_before: string[];
      }
    | {
        status: "blocked";
        reason: "workspace_not_clean_before_execution" | "git_add_failed" | "git_commit_failed";
        message: string;
      }
    | {
        status: "skipped";
        reason: "not_git_repo" | "verification_not_passed" | "no_changes";
        message: string;
      }
): Promise<AttemptCheckpointOutcome> {
  const artifactPath = join(attemptPaths.artifactsDir, CHECKPOINT_FILE_NAME);
  const document = {
    ...payload,
    created_at: new Date().toISOString()
  };

  await writeJsonFile(artifactPath, document);

  if (payload.status === "created") {
    return {
      status: "created",
      message: payload.message,
      artifact_path: artifactPath,
      commit: payload.commit,
      includes_preexisting_changes: payload.includes_preexisting_changes,
      preexisting_status_before: payload.preexisting_status_before
    };
  }

  return {
    ...payload,
    artifact_path: artifactPath
  };
}

async function runGit(
  cwd: string,
  args: string[],
  envOverrides: NodeJS.ProcessEnv,
  allowFailure: boolean
): Promise<{
  exit_code: number;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        ...envOverrides
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (!allowFailure && exitCode !== 0) {
        reject(new Error(stderr || `git ${args.join(" ")} failed`));
        return;
      }

      resolve({
        exit_code: exitCode,
        stdout,
        stderr
      });
    });
  });
}

function extractGitError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.at(-1) ?? "Git returned a non-zero exit status.";
}
