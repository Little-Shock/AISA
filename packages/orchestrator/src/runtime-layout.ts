import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export interface RuntimeLayout {
  repositoryRoot: string;
  runtimeRepoRoot: string;
  devRepoRoot: string;
  runtimeDataRoot: string;
  managedWorkspaceRoot: string;
}

export interface ResolveRuntimeLayoutOptions {
  repositoryRoot: string;
  workspaceRoot?: string;
  runtimeRepoRoot?: string;
  devRepoRoot?: string;
  runtimeDataRoot?: string;
  managedWorkspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RuntimeControlApiPaths {
  packageRoot: string;
  childEntry: string;
  supervisorEntry: string;
}

export function resolveRuntimeLayout(
  options: ResolveRuntimeLayoutOptions
): RuntimeLayout {
  const env = options.env ?? process.env;
  const unifiedRoot = options.workspaceRoot
    ? normalizeRoot(options.workspaceRoot)
    : null;
  const repositoryRoot = normalizeRoot(options.repositoryRoot);
  const runtimeRepoRoot = normalizeRoot(
    options.runtimeRepoRoot ??
      unifiedRoot ??
      env.AISA_RUNTIME_REPO_ROOT ??
      repositoryRoot
  );
  const devRepoRoot = normalizeRoot(
    options.devRepoRoot ??
      unifiedRoot ??
      env.AISA_DEV_REPO_ROOT ??
      runtimeRepoRoot
  );
  const runtimeDataRoot = normalizeRoot(
    options.runtimeDataRoot ??
      unifiedRoot ??
      env.AISA_RUNTIME_DATA_ROOT ??
      runtimeRepoRoot
  );
  const managedWorkspaceRoot = normalizeRoot(
    options.managedWorkspaceRoot ??
      env.AISA_MANAGED_WORKSPACE_ROOT ??
      resolve(runtimeDataRoot, "..", ".aisa-run-worktrees")
  );

  return {
    repositoryRoot,
    runtimeRepoRoot,
    devRepoRoot,
    runtimeDataRoot,
    managedWorkspaceRoot
  };
}

export function buildRuntimeWorkspaceScopeRoots(
  layout: RuntimeLayout,
  extraRoots: string[] = []
): string[] {
  return [...new Set([layout.runtimeRepoRoot, layout.devRepoRoot, ...extraRoots])]
    .map((root) => normalizeRoot(root))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

export function resolveRuntimeControlApiPaths(
  layout: RuntimeLayout
): RuntimeControlApiPaths {
  const packageRoot = resolve(layout.runtimeRepoRoot, "apps", "control-api");
  return {
    packageRoot,
    childEntry: join(packageRoot, "src", "index.ts"),
    supervisorEntry: join(packageRoot, "src", "supervisor.ts")
  };
}

function normalizeRoot(root: string): string {
  const resolvedRoot = resolve(root);
  try {
    return realpathSync.native(resolvedRoot);
  } catch {
    return resolvedRoot;
  }
}
