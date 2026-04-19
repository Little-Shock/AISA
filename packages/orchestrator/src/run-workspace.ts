import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { updateRun, type Run } from "@autoresearch/domain";
import {
  lockRunWorkspaceRoot,
  RunWorkspaceScopeError,
  type RunWorkspaceScopePolicy
} from "./workspace-scope.js";

const BASELINE_AUTHOR_NAME = "AISA";
const BASELINE_AUTHOR_EMAIL = "aisa@local";

type GitCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type ManagedWorkspaceRepairResult = {
  status: "repaired";
  run: Run;
  source_repo_root: string;
  source_head: string;
  previous_managed_workspace_root: string;
  previous_managed_repo_root: string;
  previous_managed_head: string;
  previous_managed_status: string[];
  archived_managed_workspace_root: string;
  archived_managed_repo_root: string;
  repaired_managed_workspace_root: string;
  repaired_managed_repo_root: string;
  repaired_managed_head: string;
};

const MANAGED_WORKSPACE_TRANSIENT_PATHS = ["node_modules"] as const;

export function isManagedWorkspaceTransientPath(relativePath: string): boolean {
  return MANAGED_WORKSPACE_TRANSIENT_PATHS.some(
    (transientPath) =>
      relativePath === transientPath ||
      relativePath.startsWith(`${transientPath}${"/"}`)
  );
}

export function buildManagedWorkspaceTransientExcludePathspecs(): string[] {
  return MANAGED_WORKSPACE_TRANSIENT_PATHS.map(
    (transientPath) => `:(exclude)${transientPath}`
  );
}

export function getEffectiveRunWorkspaceRoot(
  run: Pick<Run, "workspace_root" | "managed_workspace_root">
): string {
  return run.managed_workspace_root ?? run.workspace_root;
}

export async function ensureRunManagedWorkspace(input: {
  run: Run;
  policy: RunWorkspaceScopePolicy;
}): Promise<Run> {
  const sourceLock = await lockRunWorkspaceRoot(
    input.run.workspace_root,
    input.policy
  );
  const sourceWorkspaceRoot = sourceLock.resolvedRoot;
  const sourceRepoRoot = await resolveGitRepoRoot(sourceWorkspaceRoot);

  if (!sourceRepoRoot) {
    if (input.run.managed_workspace_root) {
      throw new RunWorkspaceScopeError(
        "managed_workspace_not_git_repo",
        `运行记录了隔离工作区，但源工作区不是 git 仓库：${sourceWorkspaceRoot}`,
        {
          workspace_root: sourceWorkspaceRoot,
          managed_workspace_root: input.run.managed_workspace_root
        }
      );
    }

    return updateRun(input.run, {
      workspace_root: sourceWorkspaceRoot,
      managed_workspace_root: null
    });
  }

  const workspaceSubpath = relative(sourceRepoRoot, sourceWorkspaceRoot);
  if (
    workspaceSubpath.startsWith("..") ||
    workspaceSubpath.startsWith(`..${"/"}`)
  ) {
    throw new RunWorkspaceScopeError(
      "managed_workspace_layout_invalid",
      `运行工作区不在源 git 仓库内，无法建立隔离 worktree：${sourceWorkspaceRoot}`,
      {
        workspace_root: sourceWorkspaceRoot,
        repo_root: sourceRepoRoot
      }
    );
  }

  if (input.run.managed_workspace_root) {
    const validatedManagedWorkspaceRoot = await validateManagedWorkspace({
      sourceRepoRoot,
      sourceWorkspaceRoot,
      managedWorkspaceRoot: input.run.managed_workspace_root,
      policy: input.policy
    });
    const managedRepoRoot = await resolveGitRepoRoot(validatedManagedWorkspaceRoot);
    if (!managedRepoRoot) {
      throw new RunWorkspaceScopeError(
        "managed_workspace_not_git_repo",
        `记录的隔离工作区不是 git worktree：${validatedManagedWorkspaceRoot}`,
        {
          managed_workspace_root: validatedManagedWorkspaceRoot
        }
      );
    }
    await synchronizeManagedWorkspaceWithSource({
      sourceRepoRoot,
      managedRepoRoot,
      managedWorkspaceRoot: validatedManagedWorkspaceRoot
    });
    await provisionManagedWorkspaceToolchain({
      sourceRepoRoot,
      managedRepoRoot
    });

    return updateRun(input.run, {
      workspace_root: sourceWorkspaceRoot,
      managed_workspace_root: validatedManagedWorkspaceRoot
    });
  }

  const worktreeRepoRoot = buildManagedWorktreeRepoRoot(
    input.policy.managedWorkspaceRoot,
    sourceRepoRoot,
    input.run.id
  );
  const managedWorkspaceRoot =
    workspaceSubpath.length === 0
      ? worktreeRepoRoot
      : join(worktreeRepoRoot, workspaceSubpath);

  const existingWorktree = await stat(worktreeRepoRoot).catch(() => null);
  if (existingWorktree) {
    await provisionManagedWorkspaceToolchain({
      sourceRepoRoot,
      managedRepoRoot: worktreeRepoRoot
    });
    const validatedManagedWorkspaceRoot = await validateManagedWorkspace({
      sourceRepoRoot,
      sourceWorkspaceRoot,
      managedWorkspaceRoot,
      expectedWorktreeRepoRoot: worktreeRepoRoot,
      policy: input.policy
    });

    return updateRun(input.run, {
      workspace_root: sourceWorkspaceRoot,
      managed_workspace_root: validatedManagedWorkspaceRoot
    });
  }

  await createManagedWorkspace({
    runId: input.run.id,
    sourceRepoRoot,
    worktreeRepoRoot
  });
  await provisionManagedWorkspaceToolchain({
    sourceRepoRoot,
    managedRepoRoot: worktreeRepoRoot
  });
  const validatedManagedWorkspaceRoot = await validateManagedWorkspace({
    sourceRepoRoot,
    sourceWorkspaceRoot,
    managedWorkspaceRoot,
    expectedWorktreeRepoRoot: worktreeRepoRoot,
    policy: input.policy
  });

  return updateRun(input.run, {
    workspace_root: sourceWorkspaceRoot,
    managed_workspace_root: validatedManagedWorkspaceRoot
  });
}

export async function repairRunManagedWorkspace(input: {
  run: Run;
  policy: RunWorkspaceScopePolicy;
}): Promise<ManagedWorkspaceRepairResult> {
  const sourceLock = await lockRunWorkspaceRoot(
    input.run.workspace_root,
    input.policy
  );
  const sourceWorkspaceRoot = sourceLock.resolvedRoot;
  const sourceRepoRoot = await resolveGitRepoRoot(sourceWorkspaceRoot);

  if (!sourceRepoRoot) {
    throw new RunWorkspaceScopeError(
      "managed_workspace_repair_failed",
      `源工作区不是 git 仓库，不能重建隔离 worktree：${sourceWorkspaceRoot}`,
      {
        workspace_root: sourceWorkspaceRoot,
        managed_workspace_root: input.run.managed_workspace_root
      }
    );
  }

  if (!input.run.managed_workspace_root) {
    throw new RunWorkspaceScopeError(
      "managed_workspace_repair_failed",
      "运行没有记录隔离工作区，不能执行修复。",
      {
        workspace_root: sourceWorkspaceRoot,
        source_repo_root: sourceRepoRoot
      }
    );
  }

  const validatedManagedWorkspaceRoot = await validateManagedWorkspace({
    sourceRepoRoot,
    sourceWorkspaceRoot,
    managedWorkspaceRoot: input.run.managed_workspace_root,
    policy: input.policy
  });
  const managedRepoRoot = await resolveGitRepoRoot(validatedManagedWorkspaceRoot);
  if (!managedRepoRoot) {
    throw new RunWorkspaceScopeError(
      "managed_workspace_repair_failed",
      `记录的隔离工作区不是 git worktree：${validatedManagedWorkspaceRoot}`,
      {
        managed_workspace_root: validatedManagedWorkspaceRoot
      }
    );
  }

  const [sourceHead, previousManagedHead, previousManagedStatus] =
    await Promise.all([
      readRequiredGitHead(
        sourceRepoRoot,
        "无法读取源仓库 HEAD，不能重建隔离 worktree。",
        {
          source_repo_root: sourceRepoRoot
        }
      ),
      readRequiredGitHead(
        managedRepoRoot,
        "无法读取旧隔离 worktree HEAD，不能保留修复现场。",
        {
          managed_workspace_root: validatedManagedWorkspaceRoot,
          managed_repo_root: managedRepoRoot
        }
      ),
      readGitStatus(managedRepoRoot)
    ]);

  const workspaceSubpath = relative(sourceRepoRoot, sourceWorkspaceRoot);
  const archivedManagedRepoRoot =
    await allocateArchivedManagedRepoRoot(managedRepoRoot);
  const archivedManagedWorkspaceRoot =
    workspaceSubpath.length === 0
      ? archivedManagedRepoRoot
      : join(archivedManagedRepoRoot, workspaceSubpath);

  await moveManagedWorktree({
    sourceRepoRoot,
    managedRepoRoot,
    archivedManagedRepoRoot,
    managedWorkspaceRoot: validatedManagedWorkspaceRoot
  });

  await createManagedWorkspace({
    runId: input.run.id,
    sourceRepoRoot,
    worktreeRepoRoot: managedRepoRoot
  });
  await provisionManagedWorkspaceToolchain({
    sourceRepoRoot,
    managedRepoRoot
  });
  const repairedManagedWorkspaceRoot = await validateManagedWorkspace({
    sourceRepoRoot,
    sourceWorkspaceRoot,
    managedWorkspaceRoot:
      workspaceSubpath.length === 0
        ? managedRepoRoot
        : join(managedRepoRoot, workspaceSubpath),
    expectedWorktreeRepoRoot: managedRepoRoot,
    policy: input.policy
  });
  const repairedManagedHead = await readRequiredGitHead(
    managedRepoRoot,
    "无法读取新隔离 worktree HEAD，修复未完成。",
    {
      managed_workspace_root: repairedManagedWorkspaceRoot,
      managed_repo_root: managedRepoRoot
    }
  );

  return {
    status: "repaired",
    run: updateRun(input.run, {
      workspace_root: sourceWorkspaceRoot,
      managed_workspace_root: repairedManagedWorkspaceRoot
    }),
    source_repo_root: sourceRepoRoot,
    source_head: sourceHead,
    previous_managed_workspace_root: validatedManagedWorkspaceRoot,
    previous_managed_repo_root: managedRepoRoot,
    previous_managed_head: previousManagedHead,
    previous_managed_status: previousManagedStatus,
    archived_managed_workspace_root: archivedManagedWorkspaceRoot,
    archived_managed_repo_root: archivedManagedRepoRoot,
    repaired_managed_workspace_root: repairedManagedWorkspaceRoot,
    repaired_managed_repo_root: managedRepoRoot,
    repaired_managed_head: repairedManagedHead
  };
}

async function synchronizeManagedWorkspaceWithSource(input: {
  sourceRepoRoot: string;
  managedRepoRoot: string;
  managedWorkspaceRoot: string;
}): Promise<void> {
  const [sourceHead, managedHead] = await Promise.all([
    readGitHead(input.sourceRepoRoot),
    readGitHead(input.managedRepoRoot)
  ]);

  if (!sourceHead || !managedHead || sourceHead === managedHead) {
    return;
  }

  const managedIsBehindSource = await isAncestorCommit(
    input.managedRepoRoot,
    managedHead,
    sourceHead
  );
  const sourceIsBehindManaged = await isAncestorCommit(
    input.managedRepoRoot,
    sourceHead,
    managedHead
  );

  if (managedIsBehindSource) {
    const managedStatus = await readGitStatus(input.managedRepoRoot);
    if (managedStatus.length > 0) {
      throw new RunWorkspaceScopeError(
        "managed_workspace_stale_from_source",
        `运行的隔离工作区落后于当前源仓库 HEAD，且含有未提交变更，不能自动同步：${input.managedWorkspaceRoot}`,
        {
          managed_workspace_root: input.managedWorkspaceRoot,
          source_repo_root: input.sourceRepoRoot,
          source_head: sourceHead,
          managed_head: managedHead,
          managed_status: managedStatus
        }
      );
    }

    const fastForwardResult = await runGit(input.managedRepoRoot, [
      "merge",
      "--ff-only",
      sourceHead
    ]);
    if (fastForwardResult.exitCode !== 0) {
      throw new RunWorkspaceScopeError(
        "managed_workspace_stale_from_source",
        `运行的隔离工作区落后于当前源仓库 HEAD，但无法自动快进：${extractGitError(fastForwardResult.stderr)}`,
        {
          managed_workspace_root: input.managedWorkspaceRoot,
          source_repo_root: input.sourceRepoRoot,
          source_head: sourceHead,
          managed_head: managedHead
        }
      );
    }

    return;
  }

  if (sourceIsBehindManaged) {
    return;
  }

  throw new RunWorkspaceScopeError(
    "managed_workspace_stale_from_source",
    `运行的隔离工作区已经偏离当前源仓库 HEAD，不能自动同步：${input.managedWorkspaceRoot}`,
    {
      managed_workspace_root: input.managedWorkspaceRoot,
      source_repo_root: input.sourceRepoRoot,
      source_head: sourceHead,
      managed_head: managedHead
    }
  );
}

async function createManagedWorkspace(input: {
  runId: string;
  sourceRepoRoot: string;
  worktreeRepoRoot: string;
}): Promise<void> {
  await mkdir(dirname(input.worktreeRepoRoot), { recursive: true });

  const worktreeResult = await runGit(input.sourceRepoRoot, [
    "worktree",
    "add",
    "--detach",
    input.worktreeRepoRoot,
    "HEAD"
  ]);
  if (worktreeResult.exitCode !== 0) {
    throw new RunWorkspaceScopeError(
      "managed_workspace_create_failed",
      `无法创建 run 隔离 worktree：${extractGitError(worktreeResult.stderr)}`,
      {
        source_repo_root: input.sourceRepoRoot,
        managed_workspace_root: input.worktreeRepoRoot
      }
    );
  }

  const trackedDiffResult = await runGit(input.sourceRepoRoot, [
    "diff",
    "--binary",
    "HEAD"
  ]);
  if (trackedDiffResult.exitCode !== 0) {
    throw new RunWorkspaceScopeError(
      "managed_workspace_create_failed",
      `无法读取源仓库当前快照：${extractGitError(trackedDiffResult.stderr)}`,
      {
        source_repo_root: input.sourceRepoRoot
      }
    );
  }

  if (trackedDiffResult.stdout.length > 0) {
    const applyResult = await runGit(
      input.worktreeRepoRoot,
      ["apply", "--binary", "--index", "-"],
      {},
      trackedDiffResult.stdout
    );
    if (applyResult.exitCode !== 0) {
      throw new RunWorkspaceScopeError(
        "managed_workspace_create_failed",
        `无法把源仓库变更同步到 run worktree：${extractGitError(applyResult.stderr)}`,
        {
          source_repo_root: input.sourceRepoRoot,
          managed_workspace_root: input.worktreeRepoRoot
        }
      );
    }
  }

  const untrackedPaths = await listUntrackedPaths(input.sourceRepoRoot);
  for (const relativePath of untrackedPaths) {
    if (isManagedWorkspaceTransientPath(relativePath)) {
      continue;
    }
    const sourcePath = join(input.sourceRepoRoot, relativePath);
    const destinationPath = join(input.worktreeRepoRoot, relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(sourcePath, destinationPath, {
      recursive: true,
      force: true
    });
  }

  const statusBeforeBaselineCommit = await readGitStatus(input.worktreeRepoRoot);
  if (statusBeforeBaselineCommit.length === 0) {
    return;
  }

  const addResult = await runGit(input.worktreeRepoRoot, ["add", "-A"]);
  if (addResult.exitCode !== 0) {
    throw new RunWorkspaceScopeError(
      "managed_workspace_create_failed",
      `无法暂存 run worktree 基线快照：${extractGitError(addResult.stderr)}`,
      {
        managed_workspace_root: input.worktreeRepoRoot
      }
    );
  }

  const commitResult = await runGit(
    input.worktreeRepoRoot,
    ["commit", "-m", `AISA baseline: ${input.runId}`],
    {
      GIT_AUTHOR_NAME: BASELINE_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: BASELINE_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: BASELINE_AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: BASELINE_AUTHOR_EMAIL
    }
  );
  if (commitResult.exitCode !== 0) {
    throw new RunWorkspaceScopeError(
      "managed_workspace_create_failed",
      `无法提交 run worktree 基线快照：${extractGitError(commitResult.stderr)}`,
      {
        managed_workspace_root: input.worktreeRepoRoot
      }
    );
  }
}

async function provisionManagedWorkspaceToolchain(input: {
  sourceRepoRoot: string;
  managedRepoRoot: string;
}): Promise<void> {
  await ensureManagedWorkspaceTransientPathsIgnored(input.managedRepoRoot);

  const sourceNodeModulesPath = join(input.sourceRepoRoot, "node_modules");
  const sourceNodeModulesStat = await stat(sourceNodeModulesPath).catch(() => null);
  if (!sourceNodeModulesStat?.isDirectory()) {
    return;
  }

  const managedNodeModulesPath = join(input.managedRepoRoot, "node_modules");
  const managedNodeModulesStat = await lstat(managedNodeModulesPath).catch(() => null);
  if (managedNodeModulesStat) {
    return;
  }

  await symlink(sourceNodeModulesPath, managedNodeModulesPath, "dir");
}

async function ensureManagedWorkspaceTransientPathsIgnored(
  managedRepoRoot: string
): Promise<void> {
  const excludeFilePath = await resolveGitPath(managedRepoRoot, "info/exclude");
  if (!excludeFilePath) {
    return;
  }

  const existingContent = await readFile(excludeFilePath, "utf8").catch(() => "");
  const existingLines = new Set(
    existingContent
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  const missingEntries = MANAGED_WORKSPACE_TRANSIENT_PATHS.filter(
    (transientPath) => !existingLines.has(transientPath)
  );
  if (missingEntries.length === 0) {
    return;
  }

  await mkdir(dirname(excludeFilePath), { recursive: true });
  const nextContent =
    existingContent.length === 0
      ? `${missingEntries.join("\n")}\n`
      : `${existingContent}${existingContent.endsWith("\n") ? "" : "\n"}${missingEntries.join("\n")}\n`;
  await writeFile(excludeFilePath, nextContent, "utf8");
}

async function validateManagedWorkspace(input: {
  sourceRepoRoot: string;
  sourceWorkspaceRoot: string;
  managedWorkspaceRoot: string;
  expectedWorktreeRepoRoot?: string;
  policy: RunWorkspaceScopePolicy;
}): Promise<string> {
  const managedLock = await lockRunWorkspaceRoot(
    input.managedWorkspaceRoot,
    input.policy
  );
  const managedRepoRoot = await resolveGitRepoRoot(managedLock.resolvedRoot);
  if (!managedRepoRoot) {
    throw new RunWorkspaceScopeError(
      "managed_workspace_not_git_repo",
      `记录的隔离工作区不是 git worktree：${managedLock.resolvedRoot}`,
      {
        managed_workspace_root: managedLock.resolvedRoot
      }
    );
  }

  if (
    input.expectedWorktreeRepoRoot &&
    resolve(managedRepoRoot) !== resolve(input.expectedWorktreeRepoRoot)
  ) {
    throw new RunWorkspaceScopeError(
      "managed_workspace_layout_invalid",
      `记录的隔离 worktree 根目录不匹配：${managedRepoRoot}`,
      {
        managed_workspace_root: managedLock.resolvedRoot,
        expected_worktree_repo_root: input.expectedWorktreeRepoRoot,
        actual_worktree_repo_root: managedRepoRoot
      }
    );
  }

  const workspaceSubpath = relative(
    input.sourceRepoRoot,
    input.sourceWorkspaceRoot
  );
  const expectedManagedWorkspaceRoot =
    workspaceSubpath.length === 0
      ? managedRepoRoot
      : join(managedRepoRoot, workspaceSubpath);
  if (resolve(expectedManagedWorkspaceRoot) !== managedLock.resolvedRoot) {
    throw new RunWorkspaceScopeError(
      "managed_workspace_layout_invalid",
      `记录的隔离工作区路径与源工作区子路径不匹配：${managedLock.resolvedRoot}`,
      {
        managed_workspace_root: managedLock.resolvedRoot,
        expected_managed_workspace_root: expectedManagedWorkspaceRoot,
        source_workspace_root: input.sourceWorkspaceRoot,
        source_repo_root: input.sourceRepoRoot
      }
    );
  }

  return managedLock.resolvedRoot;
}

function buildManagedWorktreeRepoRoot(
  managedWorkspaceBaseRoot: string,
  sourceRepoRoot: string,
  runId: string
): string {
  const sourceRepoHash = createHash("sha1")
    .update(sourceRepoRoot)
    .digest("hex")
    .slice(0, 8);

  return join(
    managedWorkspaceBaseRoot,
    `${basename(sourceRepoRoot)}-${sourceRepoHash}`,
    runId
  );
}

async function listUntrackedPaths(repoRoot: string): Promise<string[]> {
  const result = await runGit(repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z"
  ]);
  if (result.exitCode !== 0) {
    throw new RunWorkspaceScopeError(
      "managed_workspace_create_failed",
      `无法列出源仓库未跟踪文件：${extractGitError(result.stderr)}`,
      {
        source_repo_root: repoRoot
      }
    );
  }

  return result.stdout
    .split("\0")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function resolveGitRepoRoot(workspaceRoot: string): Promise<string | null> {
  const result = await runGit(workspaceRoot, ["rev-parse", "--show-toplevel"]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function resolveGitPath(
  workspaceRoot: string,
  relativeGitPath: string
): Promise<string | null> {
  const result = await runGit(workspaceRoot, ["rev-parse", "--git-path", relativeGitPath]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function readRequiredGitHead(
  repoRoot: string,
  message: string,
  details: Record<string, unknown>
): Promise<string> {
  const head = await readGitHead(repoRoot);
  if (head) {
    return head;
  }

  throw new RunWorkspaceScopeError(
    "managed_workspace_repair_failed",
    message,
    details
  );
}

async function allocateArchivedManagedRepoRoot(
  managedRepoRoot: string
): Promise<string> {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  const baseArchiveRoot = `${managedRepoRoot}--archived-${timestamp}`;
  let candidate = baseArchiveRoot;
  let suffix = 2;

  while (await stat(candidate).catch(() => null)) {
    candidate = `${baseArchiveRoot}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

async function moveManagedWorktree(input: {
  sourceRepoRoot: string;
  managedRepoRoot: string;
  archivedManagedRepoRoot: string;
  managedWorkspaceRoot: string;
}): Promise<void> {
  await mkdir(dirname(input.archivedManagedRepoRoot), { recursive: true });
  const moveResult = await runGit(input.sourceRepoRoot, [
    "worktree",
    "move",
    input.managedRepoRoot,
    input.archivedManagedRepoRoot
  ]);
  if (moveResult.exitCode === 0) {
    return;
  }

  throw new RunWorkspaceScopeError(
    "managed_workspace_repair_failed",
    `无法归档旧隔离 worktree：${extractGitError(moveResult.stderr)}`,
    {
      source_repo_root: input.sourceRepoRoot,
      managed_workspace_root: input.managedWorkspaceRoot,
      managed_repo_root: input.managedRepoRoot,
      archived_managed_repo_root: input.archivedManagedRepoRoot
    }
  );
}

async function readGitStatus(repoRoot: string): Promise<string[]> {
  const result = await runGit(repoRoot, ["status", "--short"]);
  if (result.exitCode !== 0) {
    throw new RunWorkspaceScopeError(
      "managed_workspace_create_failed",
      `无法读取 worktree git 状态：${extractGitError(result.stderr)}`,
      {
        repo_root: repoRoot
      }
    );
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

async function readGitHead(repoRoot: string): Promise<string | null> {
  const result = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function isAncestorCommit(
  repoRoot: string,
  ancestorSha: string,
  descendantSha: string
): Promise<boolean> {
  const result = await runGit(repoRoot, [
    "merge-base",
    "--is-ancestor",
    ancestorSha,
    descendantSha
  ]);
  return result.exitCode === 0;
}

async function runGit(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  stdin = ""
): Promise<GitCommandResult> {
  return await new Promise<GitCommandResult>((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", args, {
        cwd,
        env: {
          ...process.env,
          ...env
        },
        stdio: [stdin.length > 0 ? "pipe" : "ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolvePromise({
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    if (!child.stdout || !child.stderr) {
      reject(new Error(`git ${args.join(" ")} output pipe unavailable`));
      return;
    }

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolvePromise({
        stdout,
        stderr: error.message,
        exitCode: 1
      });
    });
    child.on("close", (code) => {
      resolvePromise({
        stdout,
        stderr,
        exitCode: code ?? 1
      });
    });

    if (stdin.length > 0) {
      if (!child.stdin) {
        reject(new Error(`git ${args.join(" ")} stdin pipe unavailable`));
        return;
      }
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

function extractGitError(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > 0 ? trimmed : "git 命令失败";
}
