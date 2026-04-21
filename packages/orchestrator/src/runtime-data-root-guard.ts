import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeLayout } from "./runtime-layout.js";
import type { RunWorkspaceScopePolicy } from "./workspace-scope.js";

type RuntimeDataRootGuardRecord = {
  version: 1;
  runtime_repo_root: string;
  dev_repo_root: string;
  managed_workspace_root: string;
  allowed_workspace_roots: string[];
  written_at: string;
};

const RUNTIME_DATA_ROOT_GUARD_FILE = join("artifacts", "runtime-data-root-guard.json");
const RUNTIME_DATA_ROOT_GUARD_VERSION = 1;

export class RuntimeDataRootGuardError extends Error {
  constructor(
    message: string,
    readonly details: {
      guardFile: string;
      expected: RuntimeDataRootGuardRecord;
      actual: RuntimeDataRootGuardRecord;
    }
  ) {
    super(message);
    this.name = "RuntimeDataRootGuardError";
  }
}

export async function assertRuntimeDataRootCompatible(input: {
  layout: RuntimeLayout;
  runWorkspaceScopePolicy: RunWorkspaceScopePolicy;
}): Promise<void> {
  const guardFile = join(input.layout.runtimeDataRoot, RUNTIME_DATA_ROOT_GUARD_FILE);
  const expected = buildRuntimeDataRootGuardRecord(input.layout, input.runWorkspaceScopePolicy);
  await mkdir(join(input.layout.runtimeDataRoot, "artifacts"), { recursive: true });

  const existingRaw = await readFile(guardFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (existingRaw === null) {
    await writeGuardRecord(guardFile, expected);
    return;
  }

  let actual: RuntimeDataRootGuardRecord;
  try {
    actual = JSON.parse(existingRaw) as RuntimeDataRootGuardRecord;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Runtime data root guard at ${guardFile} is invalid JSON: ${reason}`);
  }

  if (actual.version !== RUNTIME_DATA_ROOT_GUARD_VERSION) {
    throw new Error(
      `Runtime data root guard at ${guardFile} uses unsupported version ${String(actual.version)}`
    );
  }

  if (!runtimeDataRootGuardMatches(expected, actual)) {
    throw new RuntimeDataRootGuardError(
      `Runtime data root ${input.layout.runtimeDataRoot} is already claimed by an incompatible runtime workspace policy.`,
      {
        guardFile,
        expected,
        actual
      }
    );
  }
}

function buildRuntimeDataRootGuardRecord(
  layout: RuntimeLayout,
  runWorkspaceScopePolicy: RunWorkspaceScopePolicy
): RuntimeDataRootGuardRecord {
  return {
    version: RUNTIME_DATA_ROOT_GUARD_VERSION,
    runtime_repo_root: layout.runtimeRepoRoot,
    dev_repo_root: layout.devRepoRoot,
    managed_workspace_root: layout.managedWorkspaceRoot,
    allowed_workspace_roots: [...new Set(runWorkspaceScopePolicy.allowedRoots)].sort(
      (left, right) => right.length - left.length || left.localeCompare(right)
    ),
    written_at: new Date().toISOString()
  };
}

function runtimeDataRootGuardMatches(
  expected: RuntimeDataRootGuardRecord,
  actual: RuntimeDataRootGuardRecord
): boolean {
  return (
    expected.runtime_repo_root === actual.runtime_repo_root &&
    expected.dev_repo_root === actual.dev_repo_root &&
    expected.managed_workspace_root === actual.managed_workspace_root &&
    expected.allowed_workspace_roots.length === actual.allowed_workspace_roots.length &&
    expected.allowed_workspace_roots.every(
      (root, index) => root === actual.allowed_workspace_roots[index]
    )
  );
}

async function writeGuardRecord(
  guardFile: string,
  record: RuntimeDataRootGuardRecord
): Promise<void> {
  await writeFile(guardFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}
