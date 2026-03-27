import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type RunWorkspaceScopePolicy = {
  allowedRoots: string[];
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
  | "attempt_workspace_outside_run_scope";

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
  runtimeRoot: string
): RunWorkspaceScopePolicy {
  return {
    allowedRoots: [normalizeExistingScopeRoot(runtimeRoot)]
  };
}

export async function createRunWorkspaceScopePolicy(input: {
  runtimeRoot: string;
  allowedRoots?: string[];
  envValue?: string;
}): Promise<RunWorkspaceScopePolicy> {
  const configuredRoots =
    input.allowedRoots && input.allowedRoots.length > 0
      ? input.allowedRoots
      : parseRunWorkspaceScopeRoots(input.envValue);
  const rawRoots =
    configuredRoots.length > 0 ? configuredRoots : [input.runtimeRoot];
  const normalizedRoots = await Promise.all(
    rawRoots.map(async (root) => normalizeScopeRoot(root))
  );

  return {
    allowedRoots: [...new Set(normalizedRoots)].sort(
      (left, right) => right.length - left.length || left.localeCompare(right)
    )
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
  attemptWorkspaceRoot: string;
  policy: RunWorkspaceScopePolicy;
}): Promise<void> {
  const [runLock, attemptLock] = await Promise.all([
    lockRunWorkspaceRoot(input.runWorkspaceRoot, input.policy),
    lockRunWorkspaceRoot(input.attemptWorkspaceRoot, input.policy)
  ]);

  if (isPathInsideScope(runLock.resolvedRoot, attemptLock.resolvedRoot)) {
    return;
  }

  throw new RunWorkspaceScopeError(
    "attempt_workspace_outside_run_scope",
    `Attempt 工作区超出当前 run 的工作区范围：${attemptLock.resolvedRoot} 不在 ${runLock.resolvedRoot} 内`,
    {
      run_workspace_root: runLock.resolvedRoot,
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
