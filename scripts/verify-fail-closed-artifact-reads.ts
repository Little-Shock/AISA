import assert from "node:assert/strict";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createAttachedProjectProfile,
  createRun
} from "../packages/domain/src/index.ts";
import { listEvents } from "../packages/event-log/src/index.ts";
import { assessExecutionVerificationToolchain } from "../packages/orchestrator/src/index.ts";
import { captureAttachedProjectCapabilitySnapshot } from "../packages/orchestrator/src/project-capability.ts";
import {
  ensureWorkspace,
  getAttachedProjectBaselineSnapshot,
  getContextBoard,
  getCurrentDecision,
  getPlanArtifacts,
  getRunReport,
  getWriteback,
  listAttemptRuntimeEvents,
  listAttachedProjectProfiles,
  listAttempts,
  listRunJournal,
  listRuns,
  resolveAttemptPaths,
  resolveBranchArtifactPaths,
  resolveGoalPaths,
  resolveProjectPaths,
  resolveRunPaths,
  resolveWorkspacePaths,
  saveRun,
  type WorkspacePaths
} from "../packages/state-store/src/index.ts";
import {
  cleanupTrackedVerifyTempDirs,
  createTrackedVerifyTempDir
} from "./verify-temp.ts";

type Scope = "state-store" | "event-log" | "orchestrator";

type VerifyCase = {
  id: string;
  scope: Scope;
  run: () => Promise<void>;
};

type VerifyCaseResult = {
  id: string;
  scope: Scope;
  status: "pass" | "fail";
  error?: string;
};

const ALL_SCOPES: Scope[] = ["state-store", "event-log", "orchestrator"];
const VERIFY_SCOPE_ENV = "AISA_VERIFY_FAIL_CLOSED_SCOPE";

function getRequestedScopes(): Set<Scope> {
  const raw = process.env[VERIFY_SCOPE_ENV]?.trim();
  if (!raw) {
    return new Set(ALL_SCOPES);
  }

  const scopes = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is Scope => ALL_SCOPES.includes(entry as Scope));

  if (scopes.length === 0) {
    throw new Error(
      `${VERIFY_SCOPE_ENV} must include one or more of: ${ALL_SCOPES.join(", ")}`
    );
  }

  return new Set(scopes);
}

async function createWorkspaceFixture(prefix: string): Promise<{
  rootDir: string;
  paths: WorkspacePaths;
}> {
  const rootDir = await createTrackedVerifyTempDir(prefix);
  const paths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(paths);
  return {
    rootDir,
    paths
  };
}

async function createRunFixture(paths: WorkspacePaths, workspaceRoot: string) {
  const run = createRun({
    title: "Fail closed verification fixture",
    description: "Verify damaged artifacts are not hidden as normal absence.",
    success_criteria: ["Verification fixture remains deterministic."],
    owner_id: "verify",
    workspace_root: workspaceRoot
  });
  await saveRun(paths, run);
  return run;
}

async function writeInvalidJson(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, "{\n", "utf8");
}

async function writeDirectoryAtFilePath(filePath: string): Promise<void> {
  await mkdir(filePath, { recursive: true });
}

async function seedWorkspacePackageJson(
  workspaceRoot: string,
  scripts?: Record<string, string>
): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    join(workspaceRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "fail-closed-fixture",
        private: true,
        scripts: scripts ?? {}
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function withInaccessibleNodeModules(
  workspaceRoot: string,
  callback: () => Promise<void>
): Promise<void> {
  const blockedParent = join(workspaceRoot, "blocked-node-modules-target");
  const blockedTarget = join(blockedParent, "deps");
  const symlinkPath = join(workspaceRoot, "node_modules");
  await mkdir(blockedTarget, { recursive: true });
  await symlink(blockedTarget, symlinkPath);
  await chmod(blockedParent, 0o000);

  try {
    await callback();
  } finally {
    await chmod(blockedParent, 0o755);
  }
}

function createNodeRepoProject(workspaceRoot: string) {
  return createAttachedProjectProfile({
    id: "proj-fail-closed",
    slug: "proj-fail-closed",
    title: "Fail closed project",
    workspace_root: workspaceRoot,
    repo_root: workspaceRoot,
    repo_name: "fail-closed-project",
    project_type: "node_repo",
    primary_language: "typescript",
    package_manager: "npm",
    default_commands: {
      install: "npm install",
      build: "npm run build",
      test: null,
      lint: null,
      start: null
    }
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

const cases: VerifyCase[] = [
  {
    id: "missing_current_decision_returns_null",
    scope: "state-store",
    run: async () => {
      const { paths, rootDir } = await createWorkspaceFixture(
        "aisa-fail-closed-current-missing-"
      );
      const run = await createRunFixture(paths, rootDir);

      assert.equal(await getCurrentDecision(paths, run.id), null);
    }
  },
  {
    id: "corrupt_current_decision_rejects",
    scope: "state-store",
    run: async () => {
      const { paths, rootDir } = await createWorkspaceFixture(
        "aisa-fail-closed-current-corrupt-"
      );
      const run = await createRunFixture(paths, rootDir);
      await writeInvalidJson(resolveRunPaths(paths, run.id).currentFile);

      await assert.rejects(async () => {
        await getCurrentDecision(paths, run.id);
      });
    }
  },
  {
    id: "list_runs_rejects_corrupt_contract",
    scope: "state-store",
    run: async () => {
      const { paths, rootDir } = await createWorkspaceFixture(
        "aisa-fail-closed-runs-corrupt-"
      );
      const run = await createRunFixture(paths, rootDir);
      await writeInvalidJson(resolveRunPaths(paths, run.id).contractFile);

      await assert.rejects(async () => {
        await listRuns(paths);
      });
    }
  },
  {
    id: "list_attached_projects_rejects_corrupt_profile",
    scope: "state-store",
    run: async () => {
      const { paths } = await createWorkspaceFixture(
        "aisa-fail-closed-projects-corrupt-"
      );
      const projectPaths = resolveProjectPaths(paths, "proj-corrupt");
      await writeInvalidJson(projectPaths.profileFile);

      await assert.rejects(async () => {
        await listAttachedProjectProfiles(paths);
      });
    }
  },
  {
    id: "attached_project_baseline_missing_returns_null",
    scope: "state-store",
    run: async () => {
      const { paths } = await createWorkspaceFixture(
        "aisa-fail-closed-baseline-missing-"
      );

      assert.equal(
        await getAttachedProjectBaselineSnapshot(paths, "proj-missing"),
        null
      );
    }
  },
  {
    id: "attached_project_baseline_corrupt_rejects",
    scope: "state-store",
    run: async () => {
      const { paths } = await createWorkspaceFixture(
        "aisa-fail-closed-baseline-corrupt-"
      );
      const projectPaths = resolveProjectPaths(paths, "proj-corrupt");
      await writeInvalidJson(projectPaths.baselineSnapshotFile);

      await assert.rejects(async () => {
        await getAttachedProjectBaselineSnapshot(paths, "proj-corrupt");
      });
    }
  },
  {
    id: "list_attempts_ignores_incomplete_directory",
    scope: "state-store",
    run: async () => {
      const { paths, rootDir } = await createWorkspaceFixture(
        "aisa-fail-closed-attempts-incomplete-"
      );
      const run = await createRunFixture(paths, rootDir);
      await mkdir(join(resolveRunPaths(paths, run.id).attemptsDir, "att-incomplete"), {
        recursive: true
      });

      assert.deepEqual(await listAttempts(paths, run.id), []);
    }
  },
  {
    id: "list_attempts_rejects_corrupt_meta",
    scope: "state-store",
    run: async () => {
      const { paths, rootDir } = await createWorkspaceFixture(
        "aisa-fail-closed-attempts-corrupt-"
      );
      const run = await createRunFixture(paths, rootDir);
      const attemptPaths = resolveAttemptPaths(paths, run.id, "att-corrupt");
      await writeInvalidJson(attemptPaths.metaFile);

      await assert.rejects(async () => {
        await listAttempts(paths, run.id);
      });
    }
  },
  {
    id: "runtime_events_missing_returns_empty",
    scope: "state-store",
    run: async () => {
      const { paths, rootDir } = await createWorkspaceFixture(
        "aisa-fail-closed-runtime-events-missing-"
      );
      const run = await createRunFixture(paths, rootDir);

      assert.deepEqual(
        await listAttemptRuntimeEvents(paths, run.id, "att-missing"),
        []
      );
    }
  },
  {
    id: "runtime_events_malformed_rejects",
    scope: "state-store",
    run: async () => {
      const { paths, rootDir } = await createWorkspaceFixture(
        "aisa-fail-closed-runtime-events-corrupt-"
      );
      const run = await createRunFixture(paths, rootDir);
      const attemptPaths = resolveAttemptPaths(paths, run.id, "att-corrupt");
      await mkdir(attemptPaths.artifactsDir, { recursive: true });
      await writeFile(attemptPaths.runtimeEventsFile, "not-json\n", "utf8");

      await assert.rejects(async () => {
        await listAttemptRuntimeEvents(paths, run.id, "att-corrupt");
      });
    }
  },
  {
    id: "run_journal_missing_returns_empty",
    scope: "state-store",
    run: async () => {
      const { paths, rootDir } = await createWorkspaceFixture(
        "aisa-fail-closed-journal-missing-"
      );
      const run = await createRunFixture(paths, rootDir);

      assert.deepEqual(await listRunJournal(paths, run.id), []);
    }
  },
  {
    id: "run_journal_malformed_rejects",
    scope: "state-store",
    run: async () => {
      const { paths, rootDir } = await createWorkspaceFixture(
        "aisa-fail-closed-journal-corrupt-"
      );
      const run = await createRunFixture(paths, rootDir);
      const runPaths = resolveRunPaths(paths, run.id);
      await mkdir(runPaths.runDir, { recursive: true });
      await writeFile(runPaths.journalFile, "not-json\n", "utf8");

      await assert.rejects(async () => {
        await listRunJournal(paths, run.id);
      });
    }
  },
  {
    id: "writeback_missing_returns_null",
    scope: "state-store",
    run: async () => {
      const { paths } = await createWorkspaceFixture(
        "aisa-fail-closed-writeback-missing-"
      );

      assert.equal(await getWriteback(paths, "goal-missing", "branch-missing"), null);
    }
  },
  {
    id: "writeback_corrupt_rejects",
    scope: "state-store",
    run: async () => {
      const { paths } = await createWorkspaceFixture(
        "aisa-fail-closed-writeback-corrupt-"
      );
      const branchPaths = resolveBranchArtifactPaths(paths, "goal-corrupt", "branch-corrupt");
      await writeInvalidJson(branchPaths.writebackFile);

      await assert.rejects(async () => {
        await getWriteback(paths, "goal-corrupt", "branch-corrupt");
      });
    }
  },
  {
    id: "run_report_missing_returns_empty",
    scope: "state-store",
    run: async () => {
      const { paths, rootDir } = await createWorkspaceFixture(
        "aisa-fail-closed-run-report-missing-"
      );
      const run = await createRunFixture(paths, rootDir);

      assert.equal(await getRunReport(paths, run.id), "");
    }
  },
  {
    id: "run_report_directory_rejects",
    scope: "state-store",
    run: async () => {
      const { paths, rootDir } = await createWorkspaceFixture(
        "aisa-fail-closed-run-report-directory-"
      );
      const run = await createRunFixture(paths, rootDir);
      const runPaths = resolveRunPaths(paths, run.id);
      await writeDirectoryAtFilePath(runPaths.reportFile);

      await assert.rejects(async () => {
        await getRunReport(paths, run.id);
      });
    }
  },
  {
    id: "plan_artifacts_missing_returns_null",
    scope: "state-store",
    run: async () => {
      const { paths } = await createWorkspaceFixture(
        "aisa-fail-closed-plan-missing-"
      );

      assert.equal(await getPlanArtifacts(paths, "goal-missing"), null);
    }
  },
  {
    id: "plan_artifacts_corrupt_rejects",
    scope: "state-store",
    run: async () => {
      const { paths } = await createWorkspaceFixture(
        "aisa-fail-closed-plan-corrupt-"
      );
      const goalPaths = resolveGoalPaths(paths, "goal-corrupt");
      await mkdir(goalPaths.planDir, { recursive: true });
      await writeFile(join(goalPaths.planDir, "plan.md"), "# plan\n", "utf8");
      await writeFile(
        join(goalPaths.planDir, "eval_spec.json"),
        `${JSON.stringify(
          {
            dimensions: ["quality"],
            keep_threshold: 0.8,
            rerun_threshold: 0.5
          },
          null,
          2
        )}\n`,
        "utf8"
      );
      await writeInvalidJson(join(goalPaths.planDir, "branch_specs.json"));

      await assert.rejects(async () => {
        await getPlanArtifacts(paths, "goal-corrupt");
      });
    }
  },
  {
    id: "context_board_missing_returns_empty",
    scope: "state-store",
    run: async () => {
      const { paths } = await createWorkspaceFixture(
        "aisa-fail-closed-context-missing-"
      );

      assert.deepEqual(await getContextBoard(paths, "goal-missing"), {
        shared_facts: [],
        open_questions: [],
        constraints: [],
        branch_notes: {}
      });
    }
  },
  {
    id: "context_board_directory_rejects",
    scope: "state-store",
    run: async () => {
      const { paths } = await createWorkspaceFixture(
        "aisa-fail-closed-context-directory-"
      );
      const goalPaths = resolveGoalPaths(paths, "goal-corrupt");
      await writeDirectoryAtFilePath(goalPaths.sharedFactsFile);

      await assert.rejects(async () => {
        await getContextBoard(paths, "goal-corrupt");
      });
    }
  },
  {
    id: "goal_events_missing_returns_empty",
    scope: "event-log",
    run: async () => {
      const { paths } = await createWorkspaceFixture(
        "aisa-fail-closed-events-missing-"
      );

      assert.deepEqual(await listEvents(paths, "goal-missing"), []);
    }
  },
  {
    id: "goal_events_malformed_rejects",
    scope: "event-log",
    run: async () => {
      const { paths } = await createWorkspaceFixture(
        "aisa-fail-closed-events-corrupt-"
      );
      const filePath = join(paths.eventsDir, "goals", "goal-corrupt.ndjson");
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, "not-json\n", "utf8");

      await assert.rejects(async () => {
        await listEvents(paths, "goal-corrupt");
      });
    }
  },
  {
    id: "toolchain_missing_package_json_reported_absent",
    scope: "orchestrator",
    run: async () => {
      const workspaceRoot = await createTrackedVerifyTempDir(
        "aisa-fail-closed-toolchain-no-package-"
      );
      await mkdir(workspaceRoot, { recursive: true });

      const assessment = await assessExecutionVerificationToolchain({
        workspaceRoot
      });

      assert.equal(assessment.has_package_json, false);
      assert.equal(assessment.has_local_node_modules, false);
      assert.deepEqual(assessment.inferred_pnpm_commands, []);
    }
  },
  {
    id: "toolchain_invalid_package_json_rejects",
    scope: "orchestrator",
    run: async () => {
      const workspaceRoot = await createTrackedVerifyTempDir(
        "aisa-fail-closed-toolchain-bad-package-"
      );
      await writeInvalidJson(join(workspaceRoot, "package.json"));

      await assert.rejects(async () => {
        await assessExecutionVerificationToolchain({
          workspaceRoot
        });
      });
    }
  },
  {
    id: "toolchain_missing_node_modules_reported_absent",
    scope: "orchestrator",
    run: async () => {
      const workspaceRoot = await createTrackedVerifyTempDir(
        "aisa-fail-closed-toolchain-no-modules-"
      );
      await seedWorkspacePackageJson(workspaceRoot, {
        typecheck: "tsc --noEmit",
        build: "npm run build"
      });

      const assessment = await assessExecutionVerificationToolchain({
        workspaceRoot
      });

      assert.equal(assessment.has_package_json, true);
      assert.equal(assessment.has_local_node_modules, false);
      assert.deepEqual(assessment.inferred_pnpm_commands, [
        "pnpm typecheck",
        "pnpm build"
      ]);
    }
  },
  {
    id: "toolchain_inaccessible_node_modules_rejects",
    scope: "orchestrator",
    run: async () => {
      const workspaceRoot = await createTrackedVerifyTempDir(
        "aisa-fail-closed-toolchain-blocked-modules-"
      );
      await seedWorkspacePackageJson(workspaceRoot, {
        typecheck: "tsc --noEmit"
      });

      await withInaccessibleNodeModules(workspaceRoot, async () => {
        await assert.rejects(async () => {
          await assessExecutionVerificationToolchain({
            workspaceRoot
          });
        });
      });
    }
  },
  {
    id: "project_capability_missing_node_modules_reported_blocked",
    scope: "orchestrator",
    run: async () => {
      const workspaceRoot = await createTrackedVerifyTempDir(
        "aisa-fail-closed-capability-no-modules-"
      );
      await mkdir(workspaceRoot, { recursive: true });
      const project = createNodeRepoProject(workspaceRoot);

      const snapshot = await captureAttachedProjectCapabilitySnapshot({
        project,
        policy: {
          allowedRoots: [workspaceRoot],
          managedWorkspaceRoot: join(workspaceRoot, ".aisa-managed")
        },
        executionAdapter: {
          type: "execution_worker",
          command: "node"
        }
      });

      assert.equal(snapshot.workspace_scope.within_allowed_scope, true);
      assert.equal(
        snapshot.verification_commands.find((entry) => entry.label === "build")?.status,
        "blocked"
      );
    }
  },
  {
    id: "project_capability_inaccessible_node_modules_rejects",
    scope: "orchestrator",
    run: async () => {
      const workspaceRoot = await createTrackedVerifyTempDir(
        "aisa-fail-closed-capability-blocked-modules-"
      );
      await mkdir(workspaceRoot, { recursive: true });
      const project = createNodeRepoProject(workspaceRoot);

      await withInaccessibleNodeModules(workspaceRoot, async () => {
        await assert.rejects(async () => {
          await captureAttachedProjectCapabilitySnapshot({
            project,
            policy: {
              allowedRoots: [workspaceRoot],
              managedWorkspaceRoot: join(workspaceRoot, ".aisa-managed")
            },
            executionAdapter: {
              type: "execution_worker",
              command: "node"
            }
          });
        });
      });
    }
  }
];

async function main(): Promise<void> {
  const requestedScopes = getRequestedScopes();
  const selectedCases = cases.filter((testCase) => requestedScopes.has(testCase.scope));
  const results: VerifyCaseResult[] = [];

  try {
    for (const testCase of selectedCases) {
      try {
        await testCase.run();
        results.push({
          id: testCase.id,
          scope: testCase.scope,
          status: "pass"
        });
      } catch (error) {
        results.push({
          id: testCase.id,
          scope: testCase.scope,
          status: "fail",
          error: formatError(error)
        });
      }
    }

    const failed = results.filter((result) => result.status === "fail");
    if (failed.length > 0) {
      console.error(
        JSON.stringify(
          {
            suite: "fail_closed_artifact_reads",
            requested_scopes: [...requestedScopes],
            passed: results.length - failed.length,
            failed: failed.length,
            results
          },
          null,
          2
        )
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      JSON.stringify(
        {
          suite: "fail_closed_artifact_reads",
          requested_scopes: [...requestedScopes],
          passed: results.length,
          failed: 0,
          results
        },
        null,
        2
      )
    );
  } finally {
    await cleanupTrackedVerifyTempDirs();
  }
}

void main();
