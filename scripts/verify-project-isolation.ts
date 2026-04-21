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
    const dataRootGuard = await verifyRuntimeDataRootGuardRejectsMismatchedRuntimeLayout();
    const registryScope = await verifyAttachedProjectRegistryOwnsExecutionScope();
    const persistedScope = await verifyRepairManagedWorkspaceUsesPersistedRunScope();

    console.log(
      JSON.stringify(
        {
          status: "passed",
          data_root_guard: dataRootGuard,
          registry_scope: registryScope,
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

async function verifyRuntimeDataRootGuardRejectsMismatchedRuntimeLayout(): Promise<{
  failure_observed: true;
}> {
  const baseDir = await createTrackedVerifyTempDir("aisa-project-isolation-guard-");
  const runtimeRepoRoot = join(baseDir, "runtime-repo");
  const devRepoRootA = join(baseDir, "dev-repo-a");
  const devRepoRootB = join(baseDir, "dev-repo-b");
  const runtimeDataRoot = join(baseDir, "runtime-data");
  const managedWorkspaceRoot = join(baseDir, ".aisa-run-worktrees");

  await createGitRepo(runtimeRepoRoot, "runtime");
  await createGitRepo(devRepoRootA, "dev-a");
  await createGitRepo(devRepoRootB, "dev-b");
  await mkdir(runtimeDataRoot, { recursive: true });
  await mkdir(managedWorkspaceRoot, { recursive: true });

  const firstApp = await buildServer({
    startOrchestrator: false,
    runtimeRepoRoot,
    devRepoRoot: devRepoRootA,
    runtimeDataRoot,
    managedWorkspaceRoot
  });
  await firstApp.close();

  await assert.rejects(
    () =>
      buildServer({
        startOrchestrator: false,
        runtimeRepoRoot,
        devRepoRoot: devRepoRootB,
        runtimeDataRoot,
        managedWorkspaceRoot
      }),
    /already claimed by an incompatible runtime workspace policy/u
  );

  return {
    failure_observed: true
  };
}

async function verifyAttachedProjectRegistryOwnsExecutionScope(): Promise<{
  attached_project_run_survived_restart: true;
  unattached_project_blocked: true;
  live_runtime_workspace_blocked: true;
}> {
  const baseDir = await createTrackedVerifyTempDir("aisa-project-isolation-registry-");
  const runtimeRepoRoot = join(baseDir, "runtime-repo");
  const devRepoRoot = join(baseDir, "dev-repo");
  const runtimeDataRoot = join(baseDir, "runtime-data");
  const managedWorkspaceRoot = join(baseDir, ".aisa-run-worktrees");
  const projectScopeA = join(baseDir, "project-scope-a");
  const projectScopeB = join(baseDir, "project-scope-b");
  const attachedProjectARoot = join(projectScopeA, "attached-project-a");
  const attachedProjectBRoot = join(projectScopeB, "attached-project-b");
  const unattachedProjectRoot = join(projectScopeB, "unattached-project");

  await createGitRepo(runtimeRepoRoot, "runtime");
  await createGitRepo(devRepoRoot, "dev");
  await createGitRepo(attachedProjectARoot, "attached-a");
  await createGitRepo(attachedProjectBRoot, "attached-b");
  await createGitRepo(unattachedProjectRoot, "unattached");
  await mkdir(runtimeDataRoot, { recursive: true });
  await mkdir(managedWorkspaceRoot, { recursive: true });

  const firstApp = await buildServer({
    startOrchestrator: false,
    runtimeRepoRoot,
    devRepoRoot,
    runtimeDataRoot,
    managedWorkspaceRoot,
    allowedProjectRoots: [projectScopeA]
  });

  let attachedProjectId: string;
  try {
    const attachProjectAResponse = await firstApp.inject({
      method: "POST",
      url: "/projects/attach",
      payload: {
        workspace_root: attachedProjectARoot
      }
    });
    assert.equal(attachProjectAResponse.statusCode, 201, attachProjectAResponse.body);
    attachedProjectId = (attachProjectAResponse.json() as {
      project: {
        id: string;
      };
    }).project.id;
  } finally {
    await firstApp.close();
  }

  const secondApp = await buildServer({
    startOrchestrator: false,
    runtimeRepoRoot,
    devRepoRoot,
    runtimeDataRoot,
    managedWorkspaceRoot,
    allowedProjectRoots: [projectScopeB]
  });

  try {
    const projectsResponse = await secondApp.inject({
      method: "GET",
      url: "/projects"
    });
    assert.equal(projectsResponse.statusCode, 200, projectsResponse.body);
    assert.ok(
      (projectsResponse.json() as {
        projects: Array<{
          project: {
            id: string;
          };
        }>;
      }).projects.some((entry) => entry.project.id === attachedProjectId),
      "previously attached project should remain visible after restart"
    );

    const inheritedRunResponse = await secondApp.inject({
      method: "POST",
      url: "/runs",
      payload: {
        title: "Use attached project registry scope",
        description: "Previously attached projects should stay runnable even when the attach allowlist changes.",
        success_criteria: ["create the run"],
        constraints: [],
        owner_id: "test-owner",
        workspace_root: attachedProjectARoot
      }
    });
    assert.equal(inheritedRunResponse.statusCode, 201, inheritedRunResponse.body);
    assert.equal(
      (inheritedRunResponse.json() as {
        run: {
          workspace_root: string;
        };
      }).run.workspace_root,
      await realpath(attachedProjectARoot)
    );

    const blockedUnattachedResponse = await secondApp.inject({
      method: "POST",
      url: "/runs",
      payload: {
        title: "Reject unattached project root",
        description: "Project attach admission must not leak into ordinary run scope.",
        success_criteria: ["reject the run"],
        constraints: [],
        owner_id: "test-owner",
        workspace_root: unattachedProjectRoot
      }
    });
    assert.equal(blockedUnattachedResponse.statusCode, 400);
    assert.match(blockedUnattachedResponse.body, /允许范围/u);

    const attachProjectBResponse = await secondApp.inject({
      method: "POST",
      url: "/projects/attach",
      payload: {
        workspace_root: attachedProjectBRoot
      }
    });
    assert.equal(attachProjectBResponse.statusCode, 201, attachProjectBResponse.body);

    const defaultRunResponse = await secondApp.inject({
      method: "POST",
      url: "/runs",
      payload: {
        title: "Default dev run",
        description: "Ordinary runs should default to the dev repo, not the live runtime repo.",
        success_criteria: ["create the run"],
        constraints: [],
        owner_id: "test-owner"
      }
    });
    assert.equal(defaultRunResponse.statusCode, 201, defaultRunResponse.body);
    assert.equal(
      (defaultRunResponse.json() as {
        run: {
          workspace_root: string;
        };
      }).run.workspace_root,
      await realpath(devRepoRoot)
    );

    const runtimeWorkspaceResponse = await secondApp.inject({
      method: "POST",
      url: "/runs",
      payload: {
        title: "Reject live runtime workspace",
        description: "Live runtime repo must stay outside ordinary run creation.",
        success_criteria: ["reject the run"],
        constraints: [],
        owner_id: "test-owner",
        workspace_root: runtimeRepoRoot
      }
    });
    assert.equal(runtimeWorkspaceResponse.statusCode, 400);
    assert.match(runtimeWorkspaceResponse.body, /允许范围/u);

    return {
      attached_project_run_survived_restart: true,
      unattached_project_blocked: true,
      live_runtime_workspace_blocked: true
    };
  } finally {
    await secondApp.close();
  }
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
