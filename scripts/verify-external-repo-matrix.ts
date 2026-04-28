import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { buildServer } from "../apps/control-api/src/index.ts";
import {
  ensureWorkspace,
  resolveWorkspacePaths
} from "../packages/state-store/src/index.ts";
import {
  initializeGitRepo,
  writeGenericRepoFixture,
  writeGoProjectFixture,
  writeNodeProjectFixture,
  writePythonProjectFixture
} from "./verify-attached-project-fixtures.ts";
import {
  cleanupTrackedVerifyTempDirs,
  createTrackedVerifyTempDir
} from "./verify-temp.ts";

type ExternalRepoMatrixCaseResult = {
  id: string;
  status: "pass" | "fail";
  project_type?: string;
  stack_pack_id?: string;
  task_preset_id?: string;
  capability_status?: string;
  recovery_path?: string;
  failure_mode?: string;
  notes?: string;
  error?: string;
};

type ExternalRepoMatrixReport = {
  suite: "external_repo_matrix";
  passed: number;
  failed: number;
  results: ExternalRepoMatrixCaseResult[];
};

type AttachedProjectPayload = {
  project: {
    id: string;
    project_type: string;
  };
  capability_snapshot: {
    overall_status: string;
    toolchain: {
      go: {
        available: boolean;
        version: string | null;
      };
    };
    launch_readiness: {
      research: {
        status: string;
      };
      execution: {
        status: string;
        blocking_reasons: Array<{
          code: string;
        }>;
      };
    };
  };
  recommended_stack_pack: {
    id: string;
    default_task_preset_id: string;
    default_verifier_kit: string;
  };
  task_preset_recommendations: Array<{
    id: string;
    recommended: boolean;
  }>;
  default_task_preset_id: string;
  execution_contract_preview: {
    stack_pack_id: string | null;
    task_preset_id: string | null;
    verifier_kit: string | null;
    verification_plan?: {
      commands: Array<{
        command: string;
      }>;
    };
    done_rubric: Array<{
      code: string;
    }>;
    failure_modes: Array<{
      code: string;
    }>;
  };
};

type AttachedProjectRunPayload = {
  run: {
    id: string;
    attached_project_id: string | null;
    attached_project_stack_pack_id: string | null;
    attached_project_task_preset_id: string | null;
    harness_profile: {
      execution: {
        default_verifier_kit: string;
      };
    };
  };
  attached_project: {
    execution_contract_preview: {
      stack_pack_id: string | null;
      task_preset_id: string | null;
    };
  };
};

type RunDetailPayload = {
  attached_project: {
    project: {
      id: string;
    };
    recommended_stack_pack: {
      id: string;
    };
    capability_snapshot: {
      overall_status: string;
    } | null;
  } | null;
  recovery_guidance: {
    path: string;
    project_status: string;
  };
};

type ExternalRepoCaseDefinition = {
  id: string;
  repoDirName: string;
  writeFixture: (rootDir: string) => Promise<void>;
  expectedProjectType: string;
  expectedStackPackId: string;
  expectedTaskPresetId: string;
  expectedVerifierKit: string;
  expectedVerificationCommands: string[];
  probe: (payload: AttachedProjectPayload) => {
    failureMode: string;
    notes: string;
  };
  extraProbe?: (app: Awaited<ReturnType<typeof buildServer>>, projectId: string) => Promise<void>;
};

const HOST_HAS_GO = commandWorks("go", ["version"]);

async function main(): Promise<void> {
  const report = await runSuite();
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.failed, 0, "external repo matrix 回放必须全部通过。");
}

async function runSuite(): Promise<ExternalRepoMatrixReport> {
  const rootDir = await createTrackedVerifyTempDir("aisa-external-repo-matrix-");
  const projectScopeDir = await createTrackedVerifyTempDir("aisa-external-repo-scope-");
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);

  const app = await buildServer({
    workspaceRoot: rootDir,
    startOrchestrator: false,
    allowedRunWorkspaceRoots: [rootDir, projectScopeDir],
    allowedProjectRoots: [projectScopeDir]
  });

  const results: ExternalRepoMatrixCaseResult[] = [];

  try {
    const cases: ExternalRepoCaseDefinition[] = [
      {
        id: "node_backend_attach_defaults",
        repoDirName: "node-backend",
        writeFixture: writeNodeProjectFixture,
        expectedProjectType: "node_repo",
        expectedStackPackId: "node_backend",
        expectedTaskPresetId: "bugfix",
        expectedVerifierKit: "repo",
        expectedVerificationCommands: ["pnpm test", "pnpm build"],
        probe: (payload) => {
          assert.equal(payload.capability_snapshot.overall_status, "degraded");
          assert.equal(
            payload.capability_snapshot.launch_readiness.research.status,
            "ready"
          );
          assert.equal(
            payload.capability_snapshot.launch_readiness.execution.status,
            "blocked"
          );
          assert.ok(
            payload.capability_snapshot.launch_readiness.execution.blocking_reasons.some(
              (reason) => reason.code === "missing_local_verifier_toolchain"
            ),
            "node backend should stay fail-closed when node_modules is absent"
          );
          assert.ok(
            payload.execution_contract_preview.failure_modes.some(
              (mode) => mode.code === "bugfix_regression_unchecked"
            )
          );

          return {
            failureMode: "missing_local_verifier_toolchain",
            notes: "Attach succeeds, but execution stays blocked until repo-local verifier deps exist."
          };
        }
      },
      {
        id: "python_service_attach_defaults",
        repoDirName: "python-service",
        writeFixture: writePythonProjectFixture,
        expectedProjectType: "python_repo",
        expectedStackPackId: "python_service",
        expectedTaskPresetId: "bugfix",
        expectedVerifierKit: "cli",
        expectedVerificationCommands: ["pytest", "python -m build"],
        probe: (payload) => {
          assert.equal(
            payload.capability_snapshot.launch_readiness.research.status,
            "ready"
          );
          assert.ok(
            payload.execution_contract_preview.done_rubric.some(
              (item) => item.code === "bugfix_boundary_replayed"
            )
          );
          assert.ok(
            payload.execution_contract_preview.failure_modes.some(
              (mode) => mode.code === "bugfix_regression_unchecked"
            )
          );

          return {
            failureMode: "bugfix_regression_unchecked",
            notes: "Python service defaults to explicit CLI replay rather than implicit environment trust."
          };
        }
      },
      {
        id: "go_service_attach_defaults",
        repoDirName: "go-service",
        writeFixture: writeGoProjectFixture,
        expectedProjectType: "go_repo",
        expectedStackPackId: "go_service_cli",
        expectedTaskPresetId: "bugfix",
        expectedVerifierKit: "cli",
        expectedVerificationCommands: ["go test ./...", "go build ./..."],
        probe: (payload) => {
          assert.equal(
            payload.capability_snapshot.launch_readiness.research.status,
            "ready"
          );
          if (HOST_HAS_GO) {
            assert.equal(payload.capability_snapshot.toolchain.go.available, true);
            assert.match(payload.capability_snapshot.toolchain.go.version ?? "", /^go version /u);
            assert.equal(
              payload.capability_snapshot.launch_readiness.execution.status,
              "ready"
            );
          }
          assert.ok(
            payload.execution_contract_preview.done_rubric.some(
              (item) => item.code === "bugfix_boundary_replayed"
            )
          );
          assert.ok(
            payload.execution_contract_preview.failure_modes.some(
              (mode) => mode.code === "bugfix_regression_unchecked"
            )
          );

          return {
            failureMode: "bugfix_regression_unchecked",
            notes: "Go repos default to replayable CLI checks, not ad hoc local judgment."
          };
        }
      },
      {
        id: "repo_maintenance_attach_defaults",
        repoDirName: "repo-maintenance",
        writeFixture: writeGenericRepoFixture,
        expectedProjectType: "generic_git_repo",
        expectedStackPackId: "repo_maintenance",
        expectedTaskPresetId: "release_hardening",
        expectedVerifierKit: "repo",
        expectedVerificationCommands: [],
        probe: (payload) => {
          assert.equal(
            payload.capability_snapshot.launch_readiness.research.status,
            "ready"
          );
          assert.equal(
            payload.execution_contract_preview.verification_plan,
            undefined
          );
          assert.ok(
            payload.execution_contract_preview.failure_modes.some(
              (mode) => mode.code === "missing_replayable_verification_plan"
            )
          );
          assert.ok(
            payload.execution_contract_preview.failure_modes.some(
              (mode) => mode.code === "release_gate_unchecked"
            )
          );

          return {
            failureMode: "missing_replayable_verification_plan",
            notes: "Generic repos can attach cleanly, but execution still fails closed until replay commands exist."
          };
        },
        extraProbe: async (appInstance, projectId) => {
          const invalidPresetResponse = await appInstance.inject({
            method: "POST",
            url: `/projects/${projectId}/runs`,
            payload: {
              stack_pack_id: "repo_maintenance",
              task_preset_id: "api_change"
            }
          });
          assert.equal(invalidPresetResponse.statusCode, 400);
          assert.match(
            invalidPresetResponse.body,
            /not supported by attached project stack pack/u
          );
        }
      }
    ];

    for (const definition of cases) {
      try {
        results.push(await runCase(app, projectScopeDir, definition));
      } catch (error) {
        results.push({
          id: definition.id,
          status: "fail",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } finally {
    await app.close();
    await cleanupTrackedVerifyTempDirs();
  }

  return {
    suite: "external_repo_matrix",
    passed: results.filter((result) => result.status === "pass").length,
    failed: results.filter((result) => result.status === "fail").length,
    results
  };
}

async function runCase(
  app: Awaited<ReturnType<typeof buildServer>>,
  projectScopeDir: string,
  definition: ExternalRepoCaseDefinition
): Promise<ExternalRepoMatrixCaseResult> {
  const rootDir = join(projectScopeDir, definition.repoDirName);
  await definition.writeFixture(rootDir);
  await initializeGitRepo(rootDir);

  const attachResponse = await app.inject({
    method: "POST",
    url: "/projects/attach",
    payload: {
      workspace_root: rootDir,
      owner_id: `${definition.id}-owner`
    }
  });
  assert.equal(attachResponse.statusCode, 201, attachResponse.body);

  const attachedProject = attachResponse.json() as AttachedProjectPayload;
  assert.equal(attachedProject.project.project_type, definition.expectedProjectType);
  assert.equal(
    attachedProject.recommended_stack_pack.id,
    definition.expectedStackPackId
  );
  assert.equal(
    attachedProject.recommended_stack_pack.default_task_preset_id,
    definition.expectedTaskPresetId
  );
  assert.equal(
    attachedProject.recommended_stack_pack.default_verifier_kit,
    definition.expectedVerifierKit
  );
  assert.equal(
    attachedProject.default_task_preset_id,
    definition.expectedTaskPresetId
  );
  assert.equal(
    attachedProject.execution_contract_preview.stack_pack_id,
    definition.expectedStackPackId
  );
  assert.equal(
    attachedProject.execution_contract_preview.task_preset_id,
    definition.expectedTaskPresetId
  );
  assert.equal(
    attachedProject.execution_contract_preview.verifier_kit,
    definition.expectedVerifierKit
  );
  assert.deepEqual(
    attachedProject.execution_contract_preview.verification_plan?.commands.map(
      (command) => command.command
    ) ?? [],
    definition.expectedVerificationCommands
  );
  assert.deepEqual(
    attachedProject.task_preset_recommendations
      .filter((preset) => preset.recommended)
      .map((preset) => preset.id),
    [definition.expectedTaskPresetId]
  );

  const probeOutcome = definition.probe(attachedProject);

  const createRunResponse = await app.inject({
    method: "POST",
    url: `/projects/${attachedProject.project.id}/runs`,
    payload: {
      owner_id: `${definition.id}-run-owner`
    }
  });
  assert.equal(createRunResponse.statusCode, 201, createRunResponse.body);

  const createdRun = createRunResponse.json() as AttachedProjectRunPayload;
  assert.equal(createdRun.run.attached_project_id, attachedProject.project.id);
  assert.equal(
    createdRun.run.attached_project_stack_pack_id,
    definition.expectedStackPackId
  );
  assert.equal(
    createdRun.run.attached_project_task_preset_id,
    definition.expectedTaskPresetId
  );
  assert.equal(
    createdRun.run.harness_profile.execution.default_verifier_kit,
    definition.expectedVerifierKit
  );
  assert.equal(
    createdRun.attached_project.execution_contract_preview.stack_pack_id,
    definition.expectedStackPackId
  );
  assert.equal(
    createdRun.attached_project.execution_contract_preview.task_preset_id,
    definition.expectedTaskPresetId
  );

  const runDetailResponse = await app.inject({
    method: "GET",
    url: `/runs/${createdRun.run.id}`
  });
  assert.equal(runDetailResponse.statusCode, 200, runDetailResponse.body);

  const runDetail = runDetailResponse.json() as RunDetailPayload;
  assert.equal(runDetail.attached_project?.project.id, attachedProject.project.id);
  assert.equal(
    runDetail.attached_project?.recommended_stack_pack.id,
    definition.expectedStackPackId
  );
  assert.equal(
    runDetail.attached_project?.capability_snapshot?.overall_status,
    attachedProject.capability_snapshot.overall_status
  );
  assert.equal(runDetail.recovery_guidance.path, "first_attempt");
  assert.equal(
    runDetail.recovery_guidance.project_status,
    attachedProject.capability_snapshot.overall_status
  );

  if (definition.extraProbe) {
    await definition.extraProbe(app, attachedProject.project.id);
  }

  return {
    id: definition.id,
    status: "pass",
    project_type: attachedProject.project.project_type,
    stack_pack_id: attachedProject.recommended_stack_pack.id,
    task_preset_id: attachedProject.default_task_preset_id,
    capability_status: attachedProject.capability_snapshot.overall_status,
    recovery_path: runDetail.recovery_guidance.path,
    failure_mode: probeOutcome.failureMode,
    notes: probeOutcome.notes
  };
}

function commandWorks(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, {
    stdio: "ignore"
  });
  return result.status === 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
