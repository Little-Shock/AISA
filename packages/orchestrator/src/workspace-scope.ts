import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type RunWorkspaceScopePolicy = {
  allowedRoots: string[];
  managedWorkspaceRoot: string;
};

export type LockedWorkspaceRoot = {
  requestedRoot: string;
  resolvedRoot: string;
  matchedScopeRoot: string;
};

type RunWorkspaceScopeErrorCode =
  | "workspace_missing"
  | "workspace_not_directory"
  | "workspace_outside_allowed_scope"
  | "attempt_workspace_outside_run_scope"
  | "managed_workspace_create_failed"
  | "managed_workspace_repair_failed"
  | "managed_workspace_not_git_repo"
  | "managed_workspace_layout_invalid"
  | "managed_workspace_stale_from_source";

export class RunWorkspaceScopeError extends Error {
  constructor(
    readonly code: RunWorkspaceScopeErrorCode,
    message: string,
    readonly details: Record<string, unknown>
  ) {
    super(message);
    this.name = "RunWorkspaceScopeError";
  }
}

export function parseRunWorkspaceScopeRoots(
  rawValue: string | undefined
): string[] {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function createDefaultRunWorkspaceScopePolicy(
  runtimeRoot: string,
  managedWorkspaceRootOverride?: string
): RunWorkspaceScopePolicy {
  const normalizedRuntimeRoot = normalizeExistingScopeRoot(runtimeRoot);
  const envManagedWorkspaceRoot = process.env.AISA_MANAGED_WORKSPACE_ROOT;
  const managedWorkspaceRoot = managedWorkspaceRootOverride
    ? normalizeExistingScopeRoot(managedWorkspaceRootOverride)
    : envManagedWorkspaceRoot
      ? normalizeExistingScopeRoot(envManagedWorkspaceRoot)
      : normalizeDerivedManagedWorkspaceRoot(normalizedRuntimeRoot);
  return {
    allowedRoots: sortScopeRoots([normalizedRuntimeRoot, managedWorkspaceRoot]),
    managedWorkspaceRoot
  };
}

export async function createRunWorkspaceScopePolicy(input: {
  runtimeRoot: string;
  allowedRoots?: string[];
  envValue?: string;
  managedWorkspaceRoot?: string;
}): Promise<RunWorkspaceScopePolicy> {
  const normalizedRuntimeRoot = await normalizeScopeRoot(input.runtimeRoot);
  const configuredRoots =
    input.allowedRoots && input.allowedRoots.length > 0
      ? input.allowedRoots
      : parseRunWorkspaceScopeRoots(input.envValue);
  const rawRoots =
    configuredRoots.length > 0 ? configuredRoots : [normalizedRuntimeRoot];
  const normalizedRoots = await Promise.all(
    rawRoots.map(async (root) => normalizeScopeRoot(root))
  );
  const managedWorkspaceRoot = input.managedWorkspaceRoot
    ? await normalizeScopeRoot(input.managedWorkspaceRoot)
    : normalizeDerivedManagedWorkspaceRoot(normalizedRuntimeRoot);

  return {
    allowedRoots: sortScopeRoots([...normalizedRoots, managedWorkspaceRoot]),
    managedWorkspaceRoot
  };
}

export async function lockRunWorkspaceRoot(
  workspaceRoot: string,
  policy: RunWorkspaceScopePolicy
): Promise<LockedWorkspaceRoot> {
  const requestedRoot = resolve(workspaceRoot);
  const stats = await stat(requestedRoot).catch(() => null);
  if (!stats) {
    throw new RunWorkspaceScopeError(
      "workspace_missing",
      `工作区不存在，无法锁定运行范围：${requestedRoot}`,
      {
        workspace_root: requestedRoot,
        allowed_roots: policy.allowedRoots
      }
    );
  }

  if (!stats.isDirectory()) {
    throw new RunWorkspaceScopeError(
      "workspace_not_directory",
      `工作区不是目录，无法锁定运行范围：${requestedRoot}`,
      {
        workspace_root: requestedRoot,
        allowed_roots: policy.allowedRoots
      }
    );
  }

  const resolvedRoot = await realpath(requestedRoot);
  const matchedScopeRoot = policy.allowedRoots.find((scopeRoot) =>
    isPathInsideScope(scopeRoot, resolvedRoot)
  );

  if (!matchedScopeRoot) {
    throw new RunWorkspaceScopeError(
      "workspace_outside_allowed_scope",
      `工作区超出允许范围：${resolvedRoot}。允许范围：${policy.allowedRoots.join("；")}`,
      {
        workspace_root: resolvedRoot,
        allowed_roots: policy.allowedRoots
      }
    );
  }

  return {
    requestedRoot,
    resolvedRoot,
    matchedScopeRoot
  };
}

export async function assertAttemptWorkspaceWithinRunScope(input: {
  runWorkspaceRoot: string;
  managedRunWorkspaceRoot?: string | null;
  attemptWorkspaceRoot: string;
  policy: RunWorkspaceScopePolicy;
}): Promise<void> {
  const [runLock, managedRunLock, attemptLock] = await Promise.all([
    lockRunWorkspaceRoot(input.runWorkspaceRoot, input.policy),
    input.managedRunWorkspaceRoot
      ? lockRunWorkspaceRoot(input.managedRunWorkspaceRoot, input.policy)
      : Promise.resolve(null),
    lockRunWorkspaceRoot(input.attemptWorkspaceRoot, input.policy)
  ]);

  const allowedRunScopes = [runLock.resolvedRoot];
  if (managedRunLock) {
    allowedRunScopes.push(managedRunLock.resolvedRoot);
  }

  if (
    allowedRunScopes.some((scopeRoot) =>
      isPathInsideScope(scopeRoot, attemptLock.resolvedRoot)
    )
  ) {
    return;
  }

  throw new RunWorkspaceScopeError(
    "attempt_workspace_outside_run_scope",
    `Attempt 工作区超出当前 run 的工作区范围：${attemptLock.resolvedRoot} 不在 ${allowedRunScopes.join(" 或 ")} 内`,
    {
      run_workspace_root: runLock.resolvedRoot,
      managed_run_workspace_root: managedRunLock?.resolvedRoot ?? null,
      attempt_workspace_root: attemptLock.resolvedRoot,
      allowed_roots: input.policy.allowedRoots
    }
  );
}

function isPathInsideScope(scopeRoot: string, candidatePath: string): boolean {
  const relativePath = relative(scopeRoot, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.startsWith(`..${"/"}`) && !isAbsolute(relativePath))
  );
}

async function normalizeScopeRoot(root: string): Promise<string> {
  const resolvedRoot = resolve(root);
  try {
    return await realpath(resolvedRoot);
  } catch {
    return resolvedRoot;
  }
}

function normalizeExistingScopeRoot(root: string): string {
  const resolvedRoot = resolve(root);
  try {
    return realpathSync.native(resolvedRoot);
  } catch {
    return resolvedRoot;
  }
}

function normalizeDerivedManagedWorkspaceRoot(runtimeRoot: string): string {
  return resolve(runtimeRoot, "..", ".aisa-run-worktrees");
}

function sortScopeRoots(roots: string[]): string[] {
  return [...new Set(roots)].sort(
    (left, right) => right.length - left.length || left.localeCompare(right)
  );
}
