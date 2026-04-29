import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

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
  allowTransientRuntimeLayoutHint?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface RuntimeControlApiPaths {
  packageRoot: string;
  childEntry: string;
  supervisorEntry: string;
}

export interface SyncRuntimeLayoutHintOptions {
  allowTransientRoots?: boolean;
}

type PersistedRuntimeLayoutHint = {
  version: 1;
  runtime_repo_root: string;
  dev_repo_root: string;
  runtime_data_root: string;
  managed_workspace_root: string;
  written_at: string;
};

const RUNTIME_LAYOUT_HINT_VERSION = 1;
const RUNTIME_LAYOUT_HINT_RELATIVE_PATH = join("artifacts", "runtime-layout.json");
const ALLOW_TRANSIENT_RUNTIME_LAYOUT_HINT_ENV =
  "AISA_ALLOW_TRANSIENT_RUNTIME_LAYOUT_HINT";

export function resolveRuntimeLayout(
  options: ResolveRuntimeLayoutOptions
): RuntimeLayout {
  const env = options.env ?? process.env;
  const unifiedRoot = options.workspaceRoot
    ? normalizeRoot(options.workspaceRoot)
    : null;
  const repositoryRoot = normalizeRoot(options.repositoryRoot);
  const runtimeRepoRootHintCandidate = normalizeRoot(
    options.runtimeRepoRoot ??
      unifiedRoot ??
      env.AISA_RUNTIME_REPO_ROOT ??
      repositoryRoot
  );
  const persistedLayoutHint = readRuntimeLayoutHint(runtimeRepoRootHintCandidate, {
    allowTransientRoots:
      options.allowTransientRuntimeLayoutHint ??
      isTruthyEnv(env[ALLOW_TRANSIENT_RUNTIME_LAYOUT_HINT_ENV])
  });
  const runtimeRepoRoot = normalizeRoot(
    options.runtimeRepoRoot ??
      unifiedRoot ??
      env.AISA_RUNTIME_REPO_ROOT ??
      persistedLayoutHint?.runtimeRepoRoot ??
      repositoryRoot
  );
  const devRepoRoot = normalizeRoot(
    options.devRepoRoot ??
      unifiedRoot ??
      env.AISA_DEV_REPO_ROOT ??
      persistedLayoutHint?.devRepoRoot ??
      runtimeRepoRoot
  );
  const runtimeDataRoot = normalizeRoot(
    options.runtimeDataRoot ??
      unifiedRoot ??
      env.AISA_RUNTIME_DATA_ROOT ??
      persistedLayoutHint?.runtimeDataRoot ??
      runtimeRepoRoot
  );
  const managedWorkspaceRoot = normalizeRoot(
    options.managedWorkspaceRoot ??
      env.AISA_MANAGED_WORKSPACE_ROOT ??
      persistedLayoutHint?.managedWorkspaceRoot ??
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

export function syncRuntimeLayoutHint(
  layout: RuntimeLayout,
  options: SyncRuntimeLayoutHintOptions = {}
): void {
  if (!shouldPersistRuntimeLayoutHint(layout, options)) {
    return;
  }

  const hintPath = resolveRuntimeLayoutHintPath(layout.runtimeRepoRoot);
  mkdirSync(resolve(layout.runtimeRepoRoot, "artifacts"), { recursive: true });
  writeFileSync(
    hintPath,
    `${JSON.stringify(
      {
        version: RUNTIME_LAYOUT_HINT_VERSION,
        runtime_repo_root: layout.runtimeRepoRoot,
        dev_repo_root: layout.devRepoRoot,
        runtime_data_root: layout.runtimeDataRoot,
        managed_workspace_root: layout.managedWorkspaceRoot,
        written_at: new Date().toISOString()
      } satisfies PersistedRuntimeLayoutHint,
      null,
      2
    )}\n`,
    "utf8"
  );
}

function readRuntimeLayoutHint(
  runtimeRepoRoot: string,
  options: {
    allowTransientRoots: boolean;
  }
): {
  runtimeRepoRoot: string;
  devRepoRoot: string;
  runtimeDataRoot: string;
  managedWorkspaceRoot: string;
} | null {
  const hintPath = resolveRuntimeLayoutHintPath(runtimeRepoRoot);
  if (!existsSync(hintPath)) {
    return null;
  }

  const raw = readFileSync(hintPath, "utf8");
  let parsed: PersistedRuntimeLayoutHint;
  try {
    parsed = JSON.parse(raw) as PersistedRuntimeLayoutHint;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Runtime layout hint at ${hintPath} is invalid JSON: ${reason}`);
  }

  if (parsed.version !== RUNTIME_LAYOUT_HINT_VERSION) {
    throw new Error(
      `Runtime layout hint at ${hintPath} uses unsupported version ${String(parsed.version)}`
    );
  }

  const runtimeRepoRootFromHint = assertHintField(
    hintPath,
    "runtime_repo_root",
    parsed.runtime_repo_root
  );
  const devRepoRoot = assertHintField(hintPath, "dev_repo_root", parsed.dev_repo_root);
  const runtimeDataRoot = assertHintField(
    hintPath,
    "runtime_data_root",
    parsed.runtime_data_root
  );
  const managedWorkspaceRoot = assertHintField(
    hintPath,
    "managed_workspace_root",
    parsed.managed_workspace_root
  );

  const normalizedHintRepoRoot = normalizeRoot(runtimeRepoRootFromHint);
  if (normalizedHintRepoRoot !== runtimeRepoRoot) {
    throw new Error(
      `Runtime layout hint at ${hintPath} points to ${normalizedHintRepoRoot}, expected ${runtimeRepoRoot}`
    );
  }

  const hint = {
    runtimeRepoRoot: normalizedHintRepoRoot,
    devRepoRoot: normalizeRoot(devRepoRoot),
    runtimeDataRoot: normalizeRoot(runtimeDataRoot),
    managedWorkspaceRoot: normalizeRoot(managedWorkspaceRoot)
  };

  if (!options.allowTransientRoots && runtimeLayoutUsesExternalTransientRoots(hint)) {
    return null;
  }

  return hint;
}

function assertHintField(hintPath: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Runtime layout hint at ${hintPath} is missing ${field}`);
  }

  return value;
}

function resolveRuntimeLayoutHintPath(runtimeRepoRoot: string): string {
  return resolve(runtimeRepoRoot, RUNTIME_LAYOUT_HINT_RELATIVE_PATH);
}

function shouldPersistRuntimeLayoutHint(
  layout: RuntimeLayout,
  options: SyncRuntimeLayoutHintOptions
): boolean {
  const usesNonDefaultLayout =
    layout.devRepoRoot !== layout.runtimeRepoRoot ||
    layout.runtimeDataRoot !== layout.runtimeRepoRoot ||
    layout.managedWorkspaceRoot !==
      resolve(layout.runtimeDataRoot, "..", ".aisa-run-worktrees");

  if (!usesNonDefaultLayout) {
    return false;
  }

  const allowTransientRoots =
    options.allowTransientRoots ??
    isTruthyEnv(process.env[ALLOW_TRANSIENT_RUNTIME_LAYOUT_HINT_ENV]);

  return allowTransientRoots || !runtimeLayoutUsesExternalTransientRoots(layout);
}

function normalizeRoot(root: string): string {
  const resolvedRoot = resolve(root);
  try {
    return realpathSync.native(resolvedRoot);
  } catch {
    return resolvedRoot;
  }
}

function runtimeLayoutUsesExternalTransientRoots(layout: {
  runtimeRepoRoot: string;
  devRepoRoot: string;
  runtimeDataRoot: string;
  managedWorkspaceRoot: string;
}): boolean {
  if (isTransientRootPath(layout.runtimeRepoRoot)) {
    return false;
  }

  return [
    layout.devRepoRoot,
    layout.runtimeDataRoot,
    layout.managedWorkspaceRoot
  ].some((root) => isTransientRootPath(root));
}

function isTransientRootPath(pathValue: string): boolean {
  const normalizedPath = normalizeRoot(pathValue);
  return getTransientRootPrefixes().some((transientRoot) =>
    isPathInsideRoot(normalizedPath, transientRoot)
  );
}

function getTransientRootPrefixes(): string[] {
  return [
    tmpdir(),
    "/tmp",
    "/private/tmp",
    "/var/tmp",
    "/private/var/tmp",
    "/var/folders",
    "/private/var/folders"
  ]
    .map((root) => normalizeRoot(root))
    .filter((root, index, roots) => roots.indexOf(root) === index);
}

function isPathInsideRoot(pathValue: string, root: string): boolean {
  const relativePath = relative(root, pathValue);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "TRUE" || value === "yes";
}
