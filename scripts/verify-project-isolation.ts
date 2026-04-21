import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildServer } from "../apps/control-api/src/index.ts";
import { createCurrentDecision, createRun } from "../packages/domain/src/index.ts";
import {
  ensureWorkspace,
  getRun,
  listRunJournal,
  resolveWorkspacePaths,
  saveCurrentDecision,
  saveRun
} from "../packages/state-store/src/index.ts";
import {
  buildPersistedRunWorkspaceScope
} from "../packages/orchestrator/src/index.ts";
import {
  cleanupTrackedVerifyTempDirs,
  createTrackedVerifyTempDir
} from "./verify-temp.ts";

async function main(): Promise<void> {
  try {
    const dataRootGuard = await verifyRuntimeDataRootGuardRejectsMismatchedProjectRoots();
    const persistedScope = await verifyRepairManagedWorkspaceUsesPersistedRunScope();

    console.log(
      JSON.stringify(
        {
          status: "passed",
          data_root_guard: dataRootGuard,
          persisted_scope: persistedScope
        },
        null,
        2
      )
    );
  } finally {
    await cleanupTrackedVerifyTempDirs();
  }
}

async function verifyRuntimeDataRootGuardRejectsMismatchedProjectRoots(): Promise<{
  failure_observed: true;
}> {
  const baseDir = await createTrackedVerifyTempDir("aisa-project-isolation-guard-");
  const runtimeRepoRoot = join(baseDir, "runtime-repo");
  const runtimeDataRoot = join(baseDir, "runtime-data");
  const managedWorkspaceRoot = join(baseDir, ".aisa-run-worktrees");
  const projectARoot = join(baseDir, "project-a");
  const projectBRoot = join(baseDir, "project-b");

  await createGitRepo(runtimeRepoRoot, "runtime");
  await mkdir(runtimeDataRoot, { recursive: true });
  await mkdir(managedWorkspaceRoot, { recursive: true });
  await mkdir(projectARoot, { recursive: true });
  await mkdir(projectBRoot, { recursive: true });

  const firstApp = await buildServer({
    startOrchestrator: false,
    runtimeRepoRoot,
    devRepoRoot: runtimeRepoRoot,
    runtimeDataRoot,
    managedWorkspaceRoot,
    allowedProjectRoots: [projectARoot]
  });
  await firstApp.close();

  await assert.rejects(
    () =>
      buildServer({
        startOrchestrator: false,
        runtimeRepoRoot,
        devRepoRoot: runtimeRepoRoot,
        runtimeDataRoot,
        managedWorkspaceRoot,
        allowedProjectRoots: [projectBRoot]
      }),
    /already claimed by an incompatible runtime workspace policy/u
  );

  return {
    failure_observed: true
  };
}

async function verifyRepairManagedWorkspaceUsesPersistedRunScope(): Promise<{
  managed_workspace_root: string;
}> {
  const baseDir = await createTrackedVerifyTempDir("aisa-project-isolation-scope-");
  const runtimeRepoRoot = join(baseDir, "runtime-repo");
  const externalRepoRoot = join(baseDir, "external-project");
  const runtimeDataRoot = join(baseDir, "runtime-data");
  const managedWorkspaceRoot = join(baseDir, ".aisa-run-worktrees");

  await createGitRepo(runtimeRepoRoot, "runtime");
  await createGitRepo(externalRepoRoot, "external");
  await mkdir(runtimeDataRoot, { recursive: true });
  await mkdir(managedWorkspaceRoot, { recursive: true });

  const app = await buildServer({
    startOrchestrator: false,
    runtimeRepoRoot,
    devRepoRoot: runtimeRepoRoot,
    runtimeDataRoot,
    managedWorkspaceRoot
  });

  try {
    const workspacePaths = resolveWorkspacePaths(runtimeDataRoot);
    await ensureWorkspace(workspacePaths);
    const resolvedExternalRoot = await realpath(externalRepoRoot);
    const resolvedManagedWorkspaceRoot = await realpath(managedWorkspaceRoot);
    const run = createRun({
      title: "Repair external workspace under persisted scope",
      description: "Persisted run scope should keep external project workspaces runnable even when global runtime roots do not include them.",
      success_criteria: ["Managed workspace repair succeeds without workspace_scope.blocked."],
      constraints: [],
      owner_id: "test-owner",
      workspace_root: resolvedExternalRoot,
      workspace_scope: buildPersistedRunWorkspaceScope({
        requestedRoot: resolvedExternalRoot,
        resolvedRoot: resolvedExternalRoot,
        matchedScopeRoot: resolvedExternalRoot
      })
    });
    const current = createCurrentDecision({
      run_id: run.id,
      run_status: "draft",
      summary: "Seeded external project run."
    });
    await saveRun(workspacePaths, run);
    await saveCurrentDecision(workspacePaths, current);

    const response = await app.inject({
      method: "POST",
      url: `/runs/${run.id}/repair-managed-workspace`
    });
    assert.equal(response.statusCode, 200, response.body);

    const payload = response.json() as {
      run: {
        managed_workspace_root: string | null;
      };
    };
    assert.ok(payload.run.managed_workspace_root, "managed workspace root should be created");
    assert.match(
      payload.run.managed_workspace_root!,
      new RegExp(`^${escapeRegExp(resolvedManagedWorkspaceRoot)}`)
    );

    const persistedRun = await getRun(workspacePaths, run.id);
    assert.equal(
      persistedRun.managed_workspace_root,
      payload.run.managed_workspace_root,
      "repair route should persist the managed workspace root"
    );

    const journal = await listRunJournal(workspacePaths, run.id);
    assert.ok(
      !journal.some((entry) => entry.type === "run.workspace_scope.blocked"),
      "persisted project scope should prevent workspace_scope blockers during repair"
    );

    return {
      managed_workspace_root: payload.run.managed_workspace_root!
    };
  } finally {
    await app.close();
  }
}

async function createGitRepo(rootDir: string, label: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(join(rootDir, "README.md"), `# ${label}\n`, "utf8");
  await runCommand(rootDir, ["git", "init"]);
  await runCommand(rootDir, ["git", "config", "user.name", "AISA Test"]);
  await runCommand(rootDir, ["git", "config", "user.email", "aisa-test@example.com"]);
  await runCommand(rootDir, ["git", "add", "."]);
  await runCommand(rootDir, ["git", "commit", "-m", `test: seed ${label}`]);
}

async function runCommand(
  cwd: string,
  args: string[]
): Promise<{
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolveResult, reject) => {
    const [command, ...commandArgs] = args;
    const child = spawn(command!, commandArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if ((code ?? 1) !== 0) {
        reject(new Error(stderr || `Command failed: ${args.join(" ")}`));
        return;
      }
      resolveResult({ stdout, stderr });
    });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
