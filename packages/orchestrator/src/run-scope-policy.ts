import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { AttachedProjectWorkspaceScope, Run } from "@autoresearch/domain";
import type { LockedWorkspaceRoot, RunWorkspaceScopePolicy } from "./workspace-scope.js";

export function buildPersistedRunWorkspaceScope(
  lock: LockedWorkspaceRoot
): AttachedProjectWorkspaceScope {
  return {
    requested_root: lock.requestedRoot,
    resolved_root: lock.resolvedRoot,
    matched_scope_root: lock.matchedScopeRoot
  };
}

export function resolveRunScopeRoot(
  run: Pick<Run, "workspace_root" | "workspace_scope">
): string {
  return run.workspace_scope?.resolved_root ?? run.workspace_root;
}

export function createRunScopedWorkspacePolicy(input: {
  run: Pick<Run, "workspace_root" | "workspace_scope">;
  managedWorkspaceRoot: string;
}): RunWorkspaceScopePolicy {
  const runScopeRoot = normalizeScopeRoot(resolveRunScopeRoot(input.run));
  const managedWorkspaceRoot = normalizeScopeRoot(input.managedWorkspaceRoot);
  return {
    allowedRoots: [...new Set([runScopeRoot, managedWorkspaceRoot])].sort(
      (left, right) => right.length - left.length || left.localeCompare(right)
    ),
    managedWorkspaceRoot
  };
}

function normalizeScopeRoot(root: string): string {
  const resolvedRoot = resolve(root);
  try {
    return realpathSync.native(resolvedRoot);
  } catch {
    return resolvedRoot;
  }
}
