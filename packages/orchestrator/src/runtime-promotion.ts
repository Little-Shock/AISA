import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { Attempt, Run } from "@autoresearch/domain";
import type { AttemptPaths } from "@autoresearch/state-store";
import { writeJsonFile } from "@autoresearch/state-store";
import type { AttemptCheckpointOutcome } from "./git-checkpoint.js";
import type { RuntimeLayout } from "./runtime-layout.js";

const RUNTIME_PROMOTION_FILE_NAME = "runtime-promotion.json";

type RuntimePromotionBlockedReason =
  | "attempt_workspace_not_git_repo"
  | "dev_repo_not_git_repo"
  | "runtime_repo_not_git_repo"
  | "dev_repo_dirty"
  | "runtime_repo_dirty"
  | "dev_repo_fetch_failed"
  | "runtime_repo_fetch_failed"
  | "checkpoint_not_fast_forwardable_from_dev"
  | "checkpoint_not_fast_forwardable_from_runtime"
  | "dev_repo_update_failed"
  | "runtime_repo_update_failed";

type RuntimePromotionSkippedReason =
  | "not_execution"
  | "checkpoint_not_created"
  | "workspace_outside_dev_repo";

export type RuntimePromotionOutcome =
  | {
      status: "promoted";
      message: string;
      artifact_path: string;
      checkpoint_sha: string;
      dev_repo_root: string;
      runtime_repo_root: string;
      dev_repo_head_before: string | null;
      dev_repo_head_after: string | null;
      runtime_repo_head_before: string | null;
      runtime_repo_head_after: string | null;
      dev_repo_updated: boolean;
      runtime_repo_updated: boolean;
      restart_required: boolean;
    }
  | {
      status: "blocked";
      reason: RuntimePromotionBlockedReason;
      message: string;
      artifact_path: string;
      checkpoint_sha: string | null;
      dev_repo_root: string;
      runtime_repo_root: string;
      dev_repo_head_before: string | null;
      runtime_repo_head_before: string | null;
      dev_repo_status_before: string[];
      runtime_repo_status_before: string[];
    }
  | {
      status: "skipped";
      reason: RuntimePromotionSkippedReason;
      message: string;
      artifact_path: string;
      checkpoint_sha: string | null;
      dev_repo_root: string;
      runtime_repo_root: string;
    };

export async function maybePromoteVerifiedCheckpoint(input: {
  layout: RuntimeLayout;
  run: Run;
  attempt: Attempt;
  attemptPaths: AttemptPaths;
  checkpointOutcome: AttemptCheckpointOutcome;
}): Promise<RuntimePromotionOutcome> {
  const checkpointSha =
    input.checkpointOutcome.status === "created"
      ? input.checkpointOutcome.commit.sha
      : null;

  if (input.attempt.attempt_type !== "execution") {
    return await writePromotionArtifact(input.attemptPaths, {
      status: "skipped",
      reason: "not_execution",
      message: "Runtime promotion only applies to execution attempts.",
      checkpoint_sha: null,
      dev_repo_root: input.layout.devRepoRoot,
      runtime_repo_root: input.layout.runtimeRepoRoot
    });
  }

  if (input.checkpointOutcome.status !== "created") {
    return await writePromotionArtifact(input.attemptPaths, {
      status: "skipped",
      reason: "checkpoint_not_created",
      message:
        "Execution checkpoint was not created, so there is nothing to promote into the runtime lane.",
      checkpoint_sha: checkpointSha,
      dev_repo_root: input.layout.devRepoRoot,
      runtime_repo_root: input.layout.runtimeRepoRoot
    });
  }
  const createdCheckpointSha = input.checkpointOutcome.commit.sha;

  const attemptRepoRoot = await resolveGitRepoRoot(input.attempt.workspace_root);
  if (!attemptRepoRoot) {
    return await writePromotionArtifact(input.attemptPaths, {
      status: "blocked",
      reason: "attempt_workspace_not_git_repo",
      message:
        "Execution checkpoint exists, but the attempt workspace is no longer a readable git repository for promotion.",
      checkpoint_sha: createdCheckpointSha,
      dev_repo_root: input.layout.devRepoRoot,
      runtime_repo_root: input.layout.runtimeRepoRoot,
      dev_repo_head_before: null,
      runtime_repo_head_before: null,
      dev_repo_status_before: [],
      runtime_repo_status_before: []
    });
  }

  const runWorkspaceRepoRoot = await resolveGitRepoRoot(input.run.workspace_root);
  const devRepoRoot = await resolveGitRepoRoot(input.layout.devRepoRoot);
  const runtimeRepoRoot = await resolveGitRepoRoot(input.layout.runtimeRepoRoot);

  if (!devRepoRoot) {
    return await writePromotionArtifact(input.attemptPaths, {
      status: "blocked",
      reason: "dev_repo_not_git_repo",
      message: `Dev repo is not a readable git repository: ${input.layout.devRepoRoot}`,
      checkpoint_sha: createdCheckpointSha,
      dev_repo_root: input.layout.devRepoRoot,
      runtime_repo_root: input.layout.runtimeRepoRoot,
      dev_repo_head_before: null,
      runtime_repo_head_before: null,
      dev_repo_status_before: [],
      runtime_repo_status_before: []
    });
  }

  if (!runtimeRepoRoot) {
    return await writePromotionArtifact(input.attemptPaths, {
      status: "blocked",
      reason: "runtime_repo_not_git_repo",
      message: `Runtime repo is not a readable git repository: ${input.layout.runtimeRepoRoot}`,
      checkpoint_sha: createdCheckpointSha,
      dev_repo_root: devRepoRoot,
      runtime_repo_root: input.layout.runtimeRepoRoot,
      dev_repo_head_before: null,
      runtime_repo_head_before: null,
      dev_repo_status_before: [],
      runtime_repo_status_before: []
    });
  }

  if (!runWorkspaceRepoRoot || normalizePath(runWorkspaceRepoRoot) !== normalizePath(devRepoRoot)) {
    return await writePromotionArtifact(input.attemptPaths, {
      status: "skipped",
      reason: "workspace_outside_dev_repo",
      message:
        "Run workspace is outside the configured dev repo, so this checkpoint will not be promoted into the runtime lane.",
      checkpoint_sha: createdCheckpointSha,
      dev_repo_root: devRepoRoot,
      runtime_repo_root: runtimeRepoRoot
    });
  }

  const [devRepoHeadBefore, runtimeRepoHeadBefore, devRepoStatusBefore, runtimeRepoStatusBefore] =
    await Promise.all([
      readGitHead(devRepoRoot),
      readGitHead(runtimeRepoRoot),
      readGitStatus(devRepoRoot),
      normalizePath(devRepoRoot) === normalizePath(runtimeRepoRoot)
        ? Promise.resolve<string[]>([])
        : readGitStatus(runtimeRepoRoot)
    ]);

  if (devRepoStatusBefore.length > 0) {
    return await writePromotionArtifact(input.attemptPaths, {
      status: "blocked",
      reason: "dev_repo_dirty",
      message: [
        "Dev repo is dirty, so promotion refuses to rewrite it.",
        `Entries: ${devRepoStatusBefore.slice(0, 5).join("; ")}`
      ].join(" "),
      checkpoint_sha: createdCheckpointSha,
      dev_repo_root: devRepoRoot,
      runtime_repo_root: runtimeRepoRoot,
      dev_repo_head_before: devRepoHeadBefore,
      runtime_repo_head_before: runtimeRepoHeadBefore,
      dev_repo_status_before: devRepoStatusBefore,
      runtime_repo_status_before: runtimeRepoStatusBefore
    });
  }

  if (!devRepoHeadBefore) {
    return await writePromotionArtifact(input.attemptPaths, {
      status: "blocked",
      reason: "dev_repo_not_git_repo",
      message: `Dev repo has no readable HEAD: ${devRepoRoot}`,
      checkpoint_sha: createdCheckpointSha,
      dev_repo_root: devRepoRoot,
      runtime_repo_root: runtimeRepoRoot,
      dev_repo_head_before: null,
      runtime_repo_head_before: runtimeRepoHeadBefore,
      dev_repo_status_before: devRepoStatusBefore,
      runtime_repo_status_before: runtimeRepoStatusBefore
    });
  }

  if (!runtimeRepoHeadBefore) {
    return await writePromotionArtifact(input.attemptPaths, {
      status: "blocked",
      reason: "runtime_repo_not_git_repo",
      message: `Runtime repo has no readable HEAD: ${runtimeRepoRoot}`,
      checkpoint_sha: createdCheckpointSha,
      dev_repo_root: devRepoRoot,
      runtime_repo_root: runtimeRepoRoot,
      dev_repo_head_before: devRepoHeadBefore,
      runtime_repo_head_before: null,
      dev_repo_status_before: devRepoStatusBefore,
      runtime_repo_status_before: runtimeRepoStatusBefore
    });
  }

  const devFetchResult =
    normalizePath(attemptRepoRoot) === normalizePath(devRepoRoot)
      ? { exit_code: 0, stdout: "", stderr: "" }
      : await runGit(
          devRepoRoot,
          ["fetch", "--quiet", attemptRepoRoot, createdCheckpointSha],
          true
        );
  if (
    devFetchResult.exit_code !== 0 ||
    !(await gitCommitExists(devRepoRoot, createdCheckpointSha))
  ) {
    return await writePromotionArtifact(input.attemptPaths, {
      status: "blocked",
      reason: "dev_repo_fetch_failed",
      message: [
        `Dev repo could not import checkpoint ${createdCheckpointSha}.`,
        extractGitError(devFetchResult.stderr)
      ].join(" "),
      checkpoint_sha: createdCheckpointSha,
      dev_repo_root: devRepoRoot,
      runtime_repo_root: runtimeRepoRoot,
      dev_repo_head_before: devRepoHeadBefore,
      runtime_repo_head_before: runtimeRepoHeadBefore,
      dev_repo_status_before: devRepoStatusBefore,
      runtime_repo_status_before: runtimeRepoStatusBefore
    });
  }

  if (!(await gitIsAncestor(devRepoRoot, devRepoHeadBefore, createdCheckpointSha))) {
    return await writePromotionArtifact(input.attemptPaths, {
      status: "blocked",
      reason: "checkpoint_not_fast_forwardable_from_dev",
      message: [
        `Checkpoint ${createdCheckpointSha} is not a fast-forward from dev HEAD ${devRepoHeadBefore}.`,
        "Promotion will not rewrite dev history."
      ].join(" "),
      checkpoint_sha: createdCheckpointSha,
      dev_repo_root: devRepoRoot,
      runtime_repo_root: runtimeRepoRoot,
      dev_repo_head_before: devRepoHeadBefore,
      runtime_repo_head_before: runtimeRepoHeadBefore,
      dev_repo_status_before: devRepoStatusBefore,
      runtime_repo_status_before: runtimeRepoStatusBefore
    });
  }

  const runtimeSharesRepo = normalizePath(devRepoRoot) === normalizePath(runtimeRepoRoot);
  const attachedProjectUsesSeparateRuntime =
    input.run.attached_project_id !== null && !runtimeSharesRepo;
  const runtimeRepoSharesDevHistoryBefore =
    runtimeSharesRepo ||
    (!attachedProjectUsesSeparateRuntime &&
      (await gitCommitExists(runtimeRepoRoot, devRepoHeadBefore)) &&
      (await gitIsAncestor(runtimeRepoRoot, runtimeRepoHeadBefore, devRepoHeadBefore)));

  if (!runtimeSharesRepo && runtimeRepoSharesDevHistoryBefore) {
    if (runtimeRepoStatusBefore.length > 0) {
      return await writePromotionArtifact(input.attemptPaths, {
        status: "blocked",
        reason: "runtime_repo_dirty",
        message: [
          "Runtime repo is dirty, so promotion refuses to rewrite it.",
          `Entries: ${runtimeRepoStatusBefore.slice(0, 5).join("; ")}`
        ].join(" "),
        checkpoint_sha: createdCheckpointSha,
        dev_repo_root: devRepoRoot,
        runtime_repo_root: runtimeRepoRoot,
        dev_repo_head_before: devRepoHeadBefore,
        runtime_repo_head_before: runtimeRepoHeadBefore,
        dev_repo_status_before: devRepoStatusBefore,
        runtime_repo_status_before: runtimeRepoStatusBefore
      });
    }

    const runtimeFetchResult =
      normalizePath(attemptRepoRoot) === normalizePath(runtimeRepoRoot)
        ? { exit_code: 0, stdout: "", stderr: "" }
        : await runGit(
            runtimeRepoRoot,
            ["fetch", "--quiet", attemptRepoRoot, createdCheckpointSha],
            true
          );
    if (
      runtimeFetchResult.exit_code !== 0 ||
      !(await gitCommitExists(runtimeRepoRoot, createdCheckpointSha))
    ) {
      return await writePromotionArtifact(input.attemptPaths, {
        status: "blocked",
        reason: "runtime_repo_fetch_failed",
        message: [
          `Runtime repo could not import checkpoint ${createdCheckpointSha}.`,
          extractGitError(runtimeFetchResult.stderr)
        ].join(" "),
        checkpoint_sha: createdCheckpointSha,
        dev_repo_root: devRepoRoot,
        runtime_repo_root: runtimeRepoRoot,
        dev_repo_head_before: devRepoHeadBefore,
        runtime_repo_head_before: runtimeRepoHeadBefore,
        dev_repo_status_before: devRepoStatusBefore,
        runtime_repo_status_before: runtimeRepoStatusBefore
      });
    }

    if (
      !(await gitIsAncestor(runtimeRepoRoot, runtimeRepoHeadBefore, createdCheckpointSha))
    ) {
      return await writePromotionArtifact(input.attemptPaths, {
        status: "blocked",
        reason: "checkpoint_not_fast_forwardable_from_runtime",
        message: [
          `Checkpoint ${createdCheckpointSha} is not a fast-forward from runtime HEAD ${runtimeRepoHeadBefore}.`,
          "Promotion will not rewrite runtime history."
        ].join(" "),
        checkpoint_sha: createdCheckpointSha,
        dev_repo_root: devRepoRoot,
        runtime_repo_root: runtimeRepoRoot,
        dev_repo_head_before: devRepoHeadBefore,
        runtime_repo_head_before: runtimeRepoHeadBefore,
        dev_repo_status_before: devRepoStatusBefore,
        runtime_repo_status_before: runtimeRepoStatusBefore
      });
    }
  }

  let devRepoHeadAfter = devRepoHeadBefore;
  let devRepoUpdated = false;
  if (devRepoHeadBefore !== createdCheckpointSha) {
    const devUpdateResult = await runGit(
      devRepoRoot,
      ["merge", "--ff-only", createdCheckpointSha],
      true
    );
    if (devUpdateResult.exit_code !== 0) {
      return await writePromotionArtifact(input.attemptPaths, {
        status: "blocked",
        reason: "dev_repo_update_failed",
        message: [
          `Dev repo failed to fast-forward to checkpoint ${createdCheckpointSha}.`,
          extractGitError(devUpdateResult.stderr)
        ].join(" "),
        checkpoint_sha: createdCheckpointSha,
        dev_repo_root: devRepoRoot,
        runtime_repo_root: runtimeRepoRoot,
        dev_repo_head_before: devRepoHeadBefore,
        runtime_repo_head_before: runtimeRepoHeadBefore,
        dev_repo_status_before: devRepoStatusBefore,
        runtime_repo_status_before: runtimeRepoStatusBefore
      });
    }
    const updatedDevHead = await readGitHead(devRepoRoot);
    if (!updatedDevHead) {
      return await writePromotionArtifact(input.attemptPaths, {
        status: "blocked",
        reason: "dev_repo_update_failed",
        message: `Dev repo lost a readable HEAD after promoting checkpoint ${createdCheckpointSha}.`,
        checkpoint_sha: createdCheckpointSha,
        dev_repo_root: devRepoRoot,
        runtime_repo_root: runtimeRepoRoot,
        dev_repo_head_before: devRepoHeadBefore,
        runtime_repo_head_before: runtimeRepoHeadBefore,
        dev_repo_status_before: devRepoStatusBefore,
        runtime_repo_status_before: runtimeRepoStatusBefore
      });
    }
    devRepoHeadAfter = updatedDevHead;
    devRepoUpdated = true;
  }

  let runtimeRepoHeadAfter = runtimeRepoHeadBefore;
  let runtimeRepoUpdated = false;
  if (runtimeSharesRepo) {
    runtimeRepoHeadAfter = devRepoHeadAfter;
    runtimeRepoUpdated = devRepoUpdated;
  } else if (
    runtimeRepoSharesDevHistoryBefore &&
    runtimeRepoHeadBefore !== createdCheckpointSha
  ) {
    const runtimeUpdateResult = await runGit(
      runtimeRepoRoot,
      ["merge", "--ff-only", createdCheckpointSha],
      true
    );
    if (runtimeUpdateResult.exit_code !== 0) {
      return await writePromotionArtifact(input.attemptPaths, {
        status: "blocked",
        reason: "runtime_repo_update_failed",
        message: [
          `Runtime repo failed to fast-forward to checkpoint ${createdCheckpointSha}.`,
          extractGitError(runtimeUpdateResult.stderr)
        ].join(" "),
        checkpoint_sha: createdCheckpointSha,
        dev_repo_root: devRepoRoot,
        runtime_repo_root: runtimeRepoRoot,
        dev_repo_head_before: devRepoHeadBefore,
        runtime_repo_head_before: runtimeRepoHeadBefore,
        dev_repo_status_before: devRepoStatusBefore,
        runtime_repo_status_before: runtimeRepoStatusBefore
      });
    }
    const updatedRuntimeHead = await readGitHead(runtimeRepoRoot);
    if (!updatedRuntimeHead) {
      return await writePromotionArtifact(input.attemptPaths, {
        status: "blocked",
        reason: "runtime_repo_update_failed",
        message: `Runtime repo lost a readable HEAD after promoting checkpoint ${createdCheckpointSha}.`,
        checkpoint_sha: createdCheckpointSha,
        dev_repo_root: devRepoRoot,
        runtime_repo_root: runtimeRepoRoot,
        dev_repo_head_before: devRepoHeadBefore,
        runtime_repo_head_before: runtimeRepoHeadBefore,
        dev_repo_status_before: devRepoStatusBefore,
        runtime_repo_status_before: runtimeRepoStatusBefore
      });
    }
    runtimeRepoHeadAfter = updatedRuntimeHead;
    runtimeRepoUpdated = true;
  }

  return await writePromotionArtifact(input.attemptPaths, {
    status: "promoted",
    message: buildPromotionMessage({
      checkpointSha: createdCheckpointSha,
      runtimeRepoUpdated,
      runtimeSharesRepo,
      runtimeRepoSharesDevHistoryBefore
    }),
    checkpoint_sha: createdCheckpointSha,
    dev_repo_root: devRepoRoot,
    runtime_repo_root: runtimeRepoRoot,
    dev_repo_head_before: devRepoHeadBefore,
    dev_repo_head_after: devRepoHeadAfter,
    runtime_repo_head_before: runtimeRepoHeadBefore,
    runtime_repo_head_after: runtimeRepoHeadAfter,
    dev_repo_updated: devRepoUpdated,
    runtime_repo_updated: runtimeRepoUpdated,
    restart_required: runtimeRepoUpdated
  });
}

function buildPromotionMessage(input: {
  checkpointSha: string;
  runtimeRepoUpdated: boolean;
  runtimeSharesRepo: boolean;
  runtimeRepoSharesDevHistoryBefore: boolean;
}): string {
  if (!input.runtimeSharesRepo && !input.runtimeRepoSharesDevHistoryBefore) {
    return `Promoted checkpoint ${input.checkpointSha} into the attached dev repo only. Runtime repo history is separate, so no runtime restart is required.`;
  }

  if (!input.runtimeRepoUpdated) {
    return `Checkpoint ${input.checkpointSha} already matches the runtime lane. No runtime restart is required.`;
  }

  if (input.runtimeSharesRepo) {
    return `Promoted checkpoint ${input.checkpointSha} into the live runtime repo and marked the runtime for restart.`;
  }

  return `Promoted checkpoint ${input.checkpointSha} from the dev lane into the runtime repo and marked the runtime for restart.`;
}

async function writePromotionArtifact(
  attemptPaths: AttemptPaths,
  payload:
    | Omit<Extract<RuntimePromotionOutcome, { status: "promoted" }>, "artifact_path">
    | Omit<Extract<RuntimePromotionOutcome, { status: "blocked" }>, "artifact_path">
    | Omit<Extract<RuntimePromotionOutcome, { status: "skipped" }>, "artifact_path">
): Promise<RuntimePromotionOutcome> {
  const artifactPath = join(attemptPaths.artifactsDir, RUNTIME_PROMOTION_FILE_NAME);
  await writeJsonFile(artifactPath, {
    ...payload,
    created_at: new Date().toISOString()
  });

  return {
    ...payload,
    artifact_path: artifactPath
  } as RuntimePromotionOutcome;
}

async function resolveGitRepoRoot(workspaceRoot: string): Promise<string | null> {
  const result = await runGit(workspaceRoot, ["rev-parse", "--show-toplevel"], true);
  return result.exit_code === 0 ? normalizePath(result.stdout.trim()) : null;
}

async function readGitHead(repoRoot: string): Promise<string | null> {
  const result = await runGit(repoRoot, ["rev-parse", "HEAD"], true);
  return result.exit_code === 0 ? result.stdout.trim() : null;
}

async function readGitStatus(repoRoot: string): Promise<string[]> {
  const result = await runGit(
    repoRoot,
    ["status", "--porcelain=v1", "--untracked=all"],
    true
  );
  if (result.exit_code !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

async function gitCommitExists(repoRoot: string, commitSha: string): Promise<boolean> {
  const result = await runGit(
    repoRoot,
    ["cat-file", "-e", `${commitSha}^{commit}`],
    true
  );
  return result.exit_code === 0;
}

async function gitIsAncestor(
  repoRoot: string,
  ancestorSha: string,
  descendantSha: string
): Promise<boolean> {
  const result = await runGit(
    repoRoot,
    ["merge-base", "--is-ancestor", ancestorSha, descendantSha],
    true
  );
  return result.exit_code === 0;
}

async function runGit(
  cwd: string,
  args: string[],
  allowFailure: boolean
): Promise<{
  exit_code: number;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
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

      resolveResult({
        exit_code: exitCode,
        stdout,
        stderr
      });
    });
  });
}

function normalizePath(pathValue: string): string {
  const resolvedPath = resolve(pathValue);
  return resolvedPath;
}

function extractGitError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.at(-1) ?? "Git returned a non-zero exit status.";
}
