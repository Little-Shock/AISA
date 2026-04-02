import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAttempt,
  createCurrentDecision,
  createRun,
  createRunJournalEntry,
  type Attempt,
  type Run,
  type WorkerWriteback
} from "../packages/domain/src/index.ts";
import {
  buildRuntimeWorkspaceScopeRoots,
  createRunWorkspaceScopePolicy,
  maybePromoteVerifiedCheckpoint,
  resolveRuntimeLayout,
  SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH,
  syncRuntimeLayoutHint,
  RunWorkspaceScopeError,
  type RuntimeRestartRequest
} from "../packages/orchestrator/src/index.ts";
import { buildServer } from "../apps/control-api/src/index.ts";
import { ensureRunManagedWorkspace } from "../packages/orchestrator/src/run-workspace.ts";
import {
  ensureWorkspace,
  getRun,
  listAttempts,
  listRunJournal,
  resolveAttemptPaths,
  resolveWorkspacePaths,
  saveCurrentDecision,
  saveRun
} from "../packages/state-store/src/index.ts";
import { driveRun } from "./drive-run.ts";

const REVIEWER_CONFIG_ENV = "AISA_REVIEWERS_JSON";
const SYNTHESIZER_CONFIG_ENV = "AISA_REVIEW_SYNTHESIZER_JSON";
const CLOSED_BASELINE_REVIEWERS_JSON = JSON.stringify([
  {
    kind: "heuristic",
    reviewer_id: "runtime-baseline-reviewer",
    role: "runtime_reviewer",
    adapter: "deterministic-heuristic",
    provider: "local",
    model: "baseline"
  }
]);
const CLOSED_BASELINE_SYNTHESIZER_JSON = JSON.stringify({
  kind: "deterministic"
});
const RUNTIME_MARKER_FILE = "packages/orchestrator/src/runtime-lane-marker.ts";

class RuntimeLaneAdapter {
  readonly type = "fake-codex";
  private researchPasses = 0;

  async runAttemptTask(input: {
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (input.attempt.attempt_type === "research") {
      this.researchPasses += 1;
      return {
        writeback: {
          summary: "Locked the next execution step behind a replayable contract.",
          findings: [
            {
              type: "fact",
              content: "The runtime lane can be promoted only after verification passes.",
              evidence: ["runtime lane plan"]
            }
          ],
          questions: [],
          recommended_next_steps: ["Run the execution step next."],
          confidence: 0.9,
          next_attempt_contract: {
            attempt_type: "execution",
            objective: "Update the runtime lane marker through the dev lane worktree.",
            success_criteria: [
              "Write a new runtime lane marker file that includes the execution attempt id."
            ],
            required_evidence: [
              "Leave git-visible changes in the managed workspace.",
              "Pass a replayable command that proves the marker file was updated."
            ],
            done_rubric: [
              {
                code: "git_change_recorded",
                description: "Leave a git-visible managed-workspace change."
              },
              {
                code: "verification_replay_passed",
                description: "Pass the locked replay command."
              }
            ],
            failure_modes: [
              {
                code: "missing_replayable_verification_plan",
                description: "Do not dispatch without replayable verification."
              },
              {
                code: "missing_local_verifier_toolchain",
                description: "Do not dispatch pnpm replay without local node_modules."
              }
            ],
            forbidden_shortcuts: [
              "Do not claim success without replaying the locked verification command."
            ],
            expected_artifacts: [RUNTIME_MARKER_FILE],
            verification_plan: {
              commands: [
                {
                  purpose: "confirm the runtime lane marker was updated",
                  command: `test -f ${RUNTIME_MARKER_FILE} && rg -n '^export const runtimeLaneMarker = \"att_.+\";$' ${RUNTIME_MARKER_FILE}`
                }
              ]
            }
          },
          artifacts: []
        },
        reportMarkdown: "# research",
        exitCode: 0
      };
    }

    await writeFile(
      join(input.attempt.workspace_root, RUNTIME_MARKER_FILE),
      `export const runtimeLaneMarker = "${input.attempt.id}";\n`,
      "utf8"
    );

    return {
      writeback: {
        summary: "Updated the runtime lane marker in the dev worktree.",
        findings: [
          {
            type: "fact",
            content: "The runtime lane marker now points to the execution attempt id.",
            evidence: [RUNTIME_MARKER_FILE]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.92,
        artifacts: []
      },
      reportMarkdown: "# execution",
      exitCode: 0
    };
  }
}

async function main(): Promise<void> {
  const previousReviewers = process.env[REVIEWER_CONFIG_ENV];
  const previousSynthesizer = process.env[SYNTHESIZER_CONFIG_ENV];
  process.env[REVIEWER_CONFIG_ENV] = CLOSED_BASELINE_REVIEWERS_JSON;
  process.env[SYNTHESIZER_CONFIG_ENV] = CLOSED_BASELINE_SYNTHESIZER_JSON;

  try {
    await verifyPersistedRuntimeLayoutHintRestoresSplitLaneWithoutEnv();
    await verifyCorruptRuntimeLayoutHintFailsClosed();
    await verifyManagedWorkspaceFastForwardsToCurrentDevHead();
    await verifyManagedWorkspaceRejectsDirtyStaleBaseline();
    await verifyRepairManagedWorkspaceRehomesDivergedHistory();
    await verifyControlApiUsesSeparateRuntimeLayout();
    const promotion = await verifyCheckpointPromotionUpdatesRuntimeRepo();
    const dirtyBlock = await verifyDirtyRuntimeRepoBlocksPromotion();

    console.log(
      JSON.stringify(
        {
          status: "passed",
          promotion,
          dirty_block: dirtyBlock
        },
        null,
        2
      )
    );
  } finally {
    restoreEnv(REVIEWER_CONFIG_ENV, previousReviewers);
    restoreEnv(SYNTHESIZER_CONFIG_ENV, previousSynthesizer);
  }
}

async function verifyPersistedRuntimeLayoutHintRestoresSplitLaneWithoutEnv(): Promise<void> {
  const layout = await createRuntimeLaneFixture("aisa-runtime-layout-hint-");
  syncRuntimeLayoutHint(layout.runtimeLayout);

  const resolved = resolveRuntimeLayout({
    repositoryRoot: layout.runtimeRepoRoot,
    env: {}
  });

  assert.equal(resolved.runtimeRepoRoot, layout.runtimeRepoRoot);
  assert.equal(resolved.devRepoRoot, layout.devRepoRoot);
  assert.equal(resolved.runtimeDataRoot, layout.runtimeDataRoot);
  assert.equal(resolved.managedWorkspaceRoot, layout.runtimeLayout.managedWorkspaceRoot);
}

async function verifyCorruptRuntimeLayoutHintFailsClosed(): Promise<void> {
  const layout = await createRuntimeLaneFixture("aisa-runtime-layout-hint-bad-");
  await mkdir(join(layout.runtimeRepoRoot, "artifacts"), { recursive: true });
  await writeFile(
    join(layout.runtimeRepoRoot, "artifacts", "runtime-layout.json"),
    JSON.stringify({
      version: 1,
      runtime_repo_root: "",
      dev_repo_root: layout.devRepoRoot,
      runtime_data_root: layout.runtimeDataRoot,
      managed_workspace_root: layout.runtimeLayout.managedWorkspaceRoot
    }),
    "utf8"
  );

  assert.throws(
    () =>
      resolveRuntimeLayout({
        repositoryRoot: layout.runtimeRepoRoot,
        env: {}
      }),
    /Runtime layout hint .* missing runtime_repo_root/
  );
}

async function verifyManagedWorkspaceFastForwardsToCurrentDevHead(): Promise<void> {
  const layout = await createRuntimeLaneFixture("aisa-runtime-managed-sync-");
  const policy = await createRunWorkspaceScopePolicy({
    runtimeRoot: layout.runtimeRepoRoot,
    allowedRoots: buildRuntimeWorkspaceScopeRoots(layout.runtimeLayout),
    managedWorkspaceRoot: layout.runtimeLayout.managedWorkspaceRoot
  });
  const run = createRun({
    title: "Managed workspace follows dev head",
    description:
      "Ensure a clean managed workspace rebases itself onto the latest dev head before the next execution attempt.",
    success_criteria: ["managed workspace head should match the latest dev head"],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: layout.devRepoRoot
  });

  const initialRun = await ensureRunManagedWorkspace({ run, policy });
  assert.ok(initialRun.managed_workspace_root, "managed workspace should be provisioned");
  const initialManagedHead = await readGitHead(initialRun.managed_workspace_root!);
  const initialDevHead = await readGitHead(layout.devRepoRoot);
  assert.equal(initialManagedHead, initialDevHead);

  await writeFile(join(layout.devRepoRoot, "README.md"), "# runtime lane seed\n\nadvance dev\n", "utf8");
  await runCommand(layout.devRepoRoot, ["git", "add", "README.md"]);
  await runCommand(layout.devRepoRoot, ["git", "commit", "-m", "test: advance dev head"]);
  const advancedDevHead = await readGitHead(layout.devRepoRoot);
  assert.notEqual(advancedDevHead, initialDevHead);

  const resyncedRun = await ensureRunManagedWorkspace({
    run: initialRun,
    policy
  });
  const managedHeadAfterSync = await readGitHead(resyncedRun.managed_workspace_root!);
  const managedStatusAfterSync = await readGitStatus(resyncedRun.managed_workspace_root!);

  assert.equal(
    managedHeadAfterSync,
    advancedDevHead,
    "clean managed workspace should fast-forward to the latest dev head"
  );
  assert.deepEqual(
    managedStatusAfterSync,
    [],
    "managed workspace should stay clean after fast-forwarding to dev"
  );
}

async function verifyManagedWorkspaceRejectsDirtyStaleBaseline(): Promise<void> {
  const layout = await createRuntimeLaneFixture("aisa-runtime-managed-stale-dirty-");
  const policy = await createRunWorkspaceScopePolicy({
    runtimeRoot: layout.runtimeRepoRoot,
    allowedRoots: buildRuntimeWorkspaceScopeRoots(layout.runtimeLayout),
    managedWorkspaceRoot: layout.runtimeLayout.managedWorkspaceRoot
  });
  const run = createRun({
    title: "Managed workspace blocks dirty stale baseline",
    description:
      "Ensure a dirty managed workspace that fell behind dev fails closed instead of silently continuing from the wrong base.",
    success_criteria: ["stale dirty managed workspace should be rejected"],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: layout.devRepoRoot
  });

  const initialRun = await ensureRunManagedWorkspace({ run, policy });
  assert.ok(initialRun.managed_workspace_root, "managed workspace should be provisioned");

  await writeFile(
    join(initialRun.managed_workspace_root!, "README.md"),
    "# runtime lane seed\n\ndirty local progress\n",
    "utf8"
  );

  await writeFile(join(layout.devRepoRoot, "README.md"), "# runtime lane seed\n\nadvance dev\n", "utf8");
  await runCommand(layout.devRepoRoot, ["git", "add", "README.md"]);
  await runCommand(layout.devRepoRoot, ["git", "commit", "-m", "test: advance dev head"]);

  await assert.rejects(
    () =>
      ensureRunManagedWorkspace({
        run: initialRun,
        policy
      }),
    (error: unknown) =>
      error instanceof RunWorkspaceScopeError &&
      error.code === "managed_workspace_stale_from_source" &&
      error.message.includes("落后于当前源仓库 HEAD"),
    "dirty stale managed workspace should fail closed with an explicit workspace error"
  );
}

async function verifyRepairManagedWorkspaceRehomesDivergedHistory(): Promise<void> {
  const layout = await createRuntimeLaneFixture("aisa-runtime-managed-repair-");
  const workspacePaths = resolveWorkspacePaths(layout.runtimeDataRoot);
  await ensureWorkspace(workspacePaths);
  const policy = await createRunWorkspaceScopePolicy({
    runtimeRoot: layout.runtimeRepoRoot,
    allowedRoots: buildRuntimeWorkspaceScopeRoots(layout.runtimeLayout),
    managedWorkspaceRoot: layout.runtimeLayout.managedWorkspaceRoot
  });
  const run = createRun({
    title: "Repair diverged managed workspace",
    description:
      "Ensure an explicit repair preserves the stale worktree as evidence and recreates the live worktree from the current dev head.",
    success_criteria: ["repair the diverged managed workspace without deleting the old evidence"],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: layout.devRepoRoot
  });
  const current = createCurrentDecision({
    run_id: run.id,
    run_status: "waiting_steer",
    recommended_next_action: "wait_for_human",
    recommended_attempt_type: "execution",
    waiting_for_human: true,
    summary: "Blocked on stale managed workspace."
  });
  await saveRun(workspacePaths, run);
  await saveCurrentDecision(workspacePaths, current);

  const initialRun = await ensureRunManagedWorkspace({ run, policy });
  await saveRun(workspacePaths, initialRun);
  assert.ok(initialRun.managed_workspace_root, "managed workspace should be provisioned");

  await writeFile(
    join(initialRun.managed_workspace_root, "README.md"),
    "# runtime lane seed\n\ncheckpoint branch\n",
    "utf8"
  );
  await runCommand(initialRun.managed_workspace_root, ["git", "add", "README.md"]);
  await runCommand(initialRun.managed_workspace_root, [
    "git",
    "commit",
    "-m",
    "test: checkpoint stale worktree"
  ]);
  const previousManagedHead = await readGitHead(initialRun.managed_workspace_root);
  assert.ok(previousManagedHead, "checkpoint head should be readable from the stale worktree");

  await writeFile(join(layout.devRepoRoot, "README.md"), "# runtime lane seed\n\ndev rewrite\n", "utf8");
  await runCommand(layout.devRepoRoot, ["git", "add", "README.md"]);
  await runCommand(layout.devRepoRoot, ["git", "commit", "-m", "test: rewrite dev head"]);
  const sourceHead = await readGitHead(layout.devRepoRoot);
  assert.ok(sourceHead, "dev head should be readable after the rewrite");

  await assert.rejects(
    () =>
      ensureRunManagedWorkspace({
        run: initialRun,
        policy
      }),
    (error: unknown) =>
      error instanceof RunWorkspaceScopeError &&
      error.code === "managed_workspace_stale_from_source" &&
      error.message.includes("已经偏离当前源仓库 HEAD"),
    "diverged managed workspace should fail closed before the repair route runs"
  );

  const app = await buildServer({
    startOrchestrator: false,
    runtimeRepoRoot: layout.runtimeRepoRoot,
    devRepoRoot: layout.devRepoRoot,
    runtimeDataRoot: layout.runtimeDataRoot,
    managedWorkspaceRoot: layout.runtimeLayout.managedWorkspaceRoot
  });

  try {
    const repairResponse = await app.inject({
      method: "POST",
      url: `/runs/${run.id}/repair-managed-workspace`
    });
    assert.equal(repairResponse.statusCode, 200, repairResponse.body);

    const repairPayload = repairResponse.json() as {
      run: Run;
      current: {
        run_status: string;
        waiting_for_human: boolean;
        summary: string | null;
      };
      repair: {
        status: string;
        source_head: string;
        previous_managed_head: string;
        archived_managed_workspace_root: string;
        repaired_managed_workspace_root: string;
        repaired_managed_head: string;
      };
    };

    assert.equal(repairPayload.repair.status, "repaired");
    assert.equal(repairPayload.repair.source_head, sourceHead);
    assert.equal(repairPayload.repair.previous_managed_head, previousManagedHead);
    assert.equal(
      repairPayload.repair.repaired_managed_workspace_root,
      initialRun.managed_workspace_root
    );
    assert.equal(repairPayload.run.managed_workspace_root, initialRun.managed_workspace_root);
    assert.equal(repairPayload.current.run_status, "waiting_steer");
    assert.equal(repairPayload.current.waiting_for_human, true);
    assert.ok(
      repairPayload.current.summary?.includes(
        repairPayload.repair.archived_managed_workspace_root
      ),
      "manual recovery summary should point to the archived stale worktree"
    );

    assert.equal(
      await readGitHead(repairPayload.repair.repaired_managed_workspace_root),
      sourceHead,
      "repaired live worktree should match the current dev head"
    );
    assert.equal(
      await readGitHead(repairPayload.repair.archived_managed_workspace_root),
      previousManagedHead,
      "archived worktree should preserve the stale checkpoint head"
    );
    assert.deepEqual(
      await readGitStatus(repairPayload.repair.repaired_managed_workspace_root),
      [],
      "repaired live worktree should be clean"
    );

    const repairedRun = await getRun(workspacePaths, run.id);
    assert.equal(repairedRun.managed_workspace_root, initialRun.managed_workspace_root);
    await ensureRunManagedWorkspace({
      run: repairedRun,
      policy
    });

    const journal = await listRunJournal(workspacePaths, run.id);
    assert.ok(
      journal.some(
        (entry) =>
          entry.type === "run.manual_recovery" &&
          entry.payload.action === "repair_managed_workspace" &&
          entry.payload.archived_managed_workspace_root ===
            repairPayload.repair.archived_managed_workspace_root
      ),
      "manual recovery journal should preserve the archived stale worktree path"
    );
  } finally {
    await app.close();
  }
}

async function verifyControlApiUsesSeparateRuntimeLayout(): Promise<void> {
  const layout = await createRuntimeLaneFixture("aisa-runtime-layout-");
  const app = await buildServer({
    startOrchestrator: false,
    runtimeRepoRoot: layout.runtimeRepoRoot,
    devRepoRoot: layout.devRepoRoot,
    runtimeDataRoot: layout.runtimeDataRoot,
    managedWorkspaceRoot: layout.runtimeLayout.managedWorkspaceRoot
  });

  try {
    const createRunResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        title: "Default workspace lane",
        description: "Ensure control-api defaults to the dev repo for new runs.",
        success_criteria: ["create the run"],
        constraints: [],
        owner_id: "test-owner"
      }
    });
    assert.equal(createRunResponse.statusCode, 201);
    const createdRunPayload = createRunResponse.json() as {
      run: {
        id: string;
        workspace_root: string;
      };
    };
    assert.equal(createdRunPayload.run.workspace_root, layout.devRepoRoot);
    await getRun(resolveWorkspacePaths(layout.runtimeDataRoot), createdRunPayload.run.id);

    const selfBootstrapResponse = await app.inject({
      method: "POST",
      url: "/runs/self-bootstrap",
      payload: {
        launch: false,
        seed_steer: false
      }
    });
    assert.equal(selfBootstrapResponse.statusCode, 201);
    const selfBootstrapPayload = selfBootstrapResponse.json() as {
      run: {
        id: string;
        workspace_root: string;
      };
    };
    assert.equal(selfBootstrapPayload.run.workspace_root, layout.devRepoRoot);
    await access(join(layout.runtimeDataRoot, "runs", selfBootstrapPayload.run.id, "current.json"));
    await assertPathMissing(join(layout.devRepoRoot, "runs", selfBootstrapPayload.run.id));

    const healthResponse = await app.inject({
      method: "GET",
      url: "/health"
    });
    assert.equal(healthResponse.statusCode, 200);
    const healthPayload = healthResponse.json() as {
      runtime_layout: {
        dev_repo_root: string;
        runtime_repo_root: string;
        runtime_data_root: string;
      };
    };
    assert.equal(healthPayload.runtime_layout.dev_repo_root, layout.devRepoRoot);
    assert.equal(healthPayload.runtime_layout.runtime_repo_root, layout.runtimeRepoRoot);
    assert.equal(healthPayload.runtime_layout.runtime_data_root, layout.runtimeDataRoot);
  } finally {
    await app.close();
  }
}

async function verifyCheckpointPromotionUpdatesRuntimeRepo(): Promise<{
  runtime_repo_head: string;
  promoted_attempt_id: string;
}> {
  const layout = await createRuntimeLaneFixture("aisa-runtime-promotion-");
  const workspacePaths = resolveWorkspacePaths(layout.runtimeDataRoot);
  await ensureWorkspace(workspacePaths);

  const run = createRun({
    title: "Promote verified checkpoint into runtime repo",
    description: "Ensure verified self-bootstrap output promotes from dev to runtime before restart.",
    success_criteria: ["Promote the verified checkpoint and request runtime restart."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: layout.devRepoRoot
  });
  const current = createCurrentDecision({
    run_id: run.id,
    run_status: "running",
    recommended_next_action: "start_first_attempt",
    recommended_attempt_type: "research",
    summary: "Start the lane promotion verification run."
  });

  await saveRun(workspacePaths, run);
  await saveCurrentDecision(workspacePaths, current);
  await appendSeedRunJournal(workspacePaths, run);
  const runWorkspaceScopePolicy = await createRunWorkspaceScopePolicy({
    runtimeRoot: layout.runtimeRepoRoot,
    allowedRoots: buildRuntimeWorkspaceScopeRoots(layout.runtimeLayout),
    managedWorkspaceRoot: layout.runtimeLayout.managedWorkspaceRoot
  });

  const restartRequests: RuntimeRestartRequest[] = [];
  const driveResult = await driveRun({
    workspaceRoot: layout.runtimeDataRoot,
    runId: run.id,
    adapter: new RuntimeLaneAdapter() as never,
    pollIntervalMs: 20,
    maxPolls: 240,
    stopAfterCompletedAttempts: 2,
    autoApprovePendingExecution: true,
    orchestratorOptions: {
      runtimeLayout: layout.runtimeLayout,
      runWorkspaceScopePolicy,
      requestRuntimeRestart: (request) => {
        restartRequests.push(request);
      }
    }
  });

  const attempts = await listAttempts(workspacePaths, run.id);
  const executionAttempt = attempts.find((attempt) => attempt.attempt_type === "execution");
  assert.ok(
    executionAttempt,
    `execution attempt should be persisted.\n\n${JSON.stringify(
      {
        stop_reason: driveResult.stopReason,
        completed_attempt_count: driveResult.completedAttemptCount,
        current: driveResult.current,
        attempts
      },
      null,
      2
    )}`
  );
  assert.equal(executionAttempt?.status, "completed");
  assert.equal(driveResult.completedAttemptCount, 2);
  await waitForRestartRequests(restartRequests, 1, 2_000);

  const journal = await listRunJournal(workspacePaths, run.id);
  assert.ok(
    journal.some((entry) => entry.type === "attempt.runtime.promoted"),
    "run journal should record the runtime promotion"
  );

  assert.equal(restartRequests.length, 1, "promotion should request exactly one runtime restart");
  assert.equal(restartRequests[0]?.reason, "runtime_promotion");
  assert.equal(restartRequests[0]?.affectedFiles.length, 0);

  const devMarker = await readFile(join(layout.devRepoRoot, RUNTIME_MARKER_FILE), "utf8");
  const runtimeMarker = await readFile(join(layout.runtimeRepoRoot, RUNTIME_MARKER_FILE), "utf8");
  assert.equal(runtimeMarker, devMarker, "runtime repo should match the promoted dev repo file");
  assert.match(runtimeMarker, new RegExp(executionAttempt.id));

  const [devHead, runtimeHead, devStatus, runtimeStatus] = await Promise.all([
    readGitHead(layout.devRepoRoot),
    readGitHead(layout.runtimeRepoRoot),
    readGitStatus(layout.devRepoRoot),
    readGitStatus(layout.runtimeRepoRoot)
  ]);
  assert.equal(runtimeHead, devHead, "runtime repo head should match the promoted dev head");
  assert.equal(restartRequests[0]?.promotedSha, runtimeHead);
  assert.deepEqual(devStatus, [], "dev repo should stay clean after promotion");
  assert.deepEqual(runtimeStatus, [], "runtime repo should stay clean after promotion");

  return {
    runtime_repo_head: runtimeHead ?? "unknown",
    promoted_attempt_id: executionAttempt.id
  };
}

async function verifyDirtyRuntimeRepoBlocksPromotion(): Promise<{
  blocked_reason: string;
}> {
  const layout = await createRuntimeLaneFixture("aisa-runtime-dirty-block-");
  const workspacePaths = resolveWorkspacePaths(layout.runtimeDataRoot);
  await ensureWorkspace(workspacePaths);

  const run = createRun({
    title: "Block promotion on dirty runtime repo",
    description: "Ensure promotion fails closed when the runtime repo is dirty.",
    success_criteria: ["Block promotion and keep both repos unchanged."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: layout.devRepoRoot
  });
  const attempt = createAttempt({
    run_id: run.id,
    attempt_type: "execution",
    objective: "Promote an already verified checkpoint.",
    success_criteria: ["Block promotion before either repo head moves."],
    status: "completed",
    workspace_root: layout.attemptWorktreeRoot,
    worker: "fake-codex",
    branch_id: null
  });
  await saveRun(workspacePaths, run);
  const attemptPaths = resolveAttemptPaths(workspacePaths, run.id, attempt.id);
  await mkdir(attemptPaths.artifactsDir, { recursive: true });

  await writeFile(
    join(layout.attemptWorktreeRoot, RUNTIME_MARKER_FILE),
    `export const runtimeLaneMarker = "${attempt.id}";\n`,
    "utf8"
  );
  await runCommand(layout.attemptWorktreeRoot, ["git", "add", "-A"]);
  await runCommand(layout.attemptWorktreeRoot, [
    "git",
    "commit",
    "-m",
    `test: checkpoint ${attempt.id}`
  ]);

  const checkpointSha = await readGitHead(layout.attemptWorktreeRoot);
  assert.ok(checkpointSha, "checkpoint sha should be readable from the attempt worktree");

  const devHeadBefore = await readGitHead(layout.devRepoRoot);
  const runtimeHeadBefore = await readGitHead(layout.runtimeRepoRoot);
  await writeFile(
    join(layout.runtimeRepoRoot, "README.md"),
    "# runtime repo dirty\n",
    "utf8"
  );

  const outcome = await maybePromoteVerifiedCheckpoint({
    layout: layout.runtimeLayout,
    run,
    attempt,
    attemptPaths,
    checkpointOutcome: {
      status: "created",
      message: `Created execution auto-checkpoint ${checkpointSha}.`,
      artifact_path: join(attemptPaths.artifactsDir, "git-checkpoint.json"),
      commit: {
        sha: checkpointSha,
        message: `test: checkpoint ${attempt.id}`,
        changed_files: [RUNTIME_MARKER_FILE]
      },
      includes_preexisting_changes: false,
      preexisting_status_before: []
    }
  });

  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.reason, "runtime_repo_dirty");
  assert.equal(await readGitHead(layout.devRepoRoot), devHeadBefore);
  assert.equal(await readGitHead(layout.runtimeRepoRoot), runtimeHeadBefore);

  return {
    blocked_reason: outcome.reason
  };
}

async function createRuntimeLaneFixture(prefix: string): Promise<{
  devRepoRoot: string;
  runtimeRepoRoot: string;
  runtimeDataRoot: string;
  attemptWorktreeRoot: string;
  runtimeLayout: ReturnType<typeof resolveRuntimeLayout>;
}> {
  const baseDir = await mkdtemp(join(tmpdir(), prefix));
  const seedRepoRoot = join(baseDir, "seed-repo");
  const devRepoRoot = join(baseDir, "dev-repo");
  const runtimeRepoRoot = join(baseDir, "runtime-repo");
  const runtimeDataRoot = join(baseDir, "runtime-data");
  const attemptWorktreeRoot = join(baseDir, "attempt-worktree");
  const managedWorkspaceRoot = join(baseDir, ".aisa-run-worktrees");

  await createSeedRepo(seedRepoRoot);
  await cloneRepo(seedRepoRoot, devRepoRoot);
  await cloneRepo(seedRepoRoot, runtimeRepoRoot);
  await mkdir(runtimeDataRoot, { recursive: true });
  await mkdir(managedWorkspaceRoot, { recursive: true });
  await runCommand(devRepoRoot, ["git", "worktree", "add", "--detach", attemptWorktreeRoot, "HEAD"]);
  const runtimeLayout = resolveRuntimeLayout({
    repositoryRoot: devRepoRoot,
    devRepoRoot,
    runtimeRepoRoot,
    runtimeDataRoot,
    managedWorkspaceRoot
  });

  return {
    devRepoRoot: runtimeLayout.devRepoRoot,
    runtimeRepoRoot: runtimeLayout.runtimeRepoRoot,
    runtimeDataRoot: runtimeLayout.runtimeDataRoot,
    attemptWorktreeRoot: await realpath(attemptWorktreeRoot),
    runtimeLayout
  };
}

async function createSeedRepo(rootDir: string): Promise<void> {
  await mkdir(join(rootDir, "packages", "orchestrator", "src"), { recursive: true });
  await mkdir(join(rootDir, "Codex"), { recursive: true });
  await writeFile(
    join(rootDir, ".gitignore"),
    ["runs/", "state/", "events/", "artifacts/", "reports/", "plans/"].join("\n") + "\n",
    "utf8"
  );
  await writeFile(join(rootDir, "README.md"), "# runtime lane seed\n", "utf8");
  await writeFile(
    join(rootDir, RUNTIME_MARKER_FILE),
    'export const runtimeLaneMarker = "seed";\n',
    "utf8"
  );
  await writeFile(
    join(rootDir, "Codex", "fixture-self-bootstrap-next-task.json"),
    `${JSON.stringify(
      {
        recommended_next_attempt: {
          attempt_type: "execution",
          objective: "Keep runtime lane self-bootstrap fixtures aligned with the live control-api contract.",
          success_criteria: [
            "Persist a runnable self-bootstrap execution contract in the runtime lane fixture."
          ],
          required_evidence: ["Leave replayable runtime-lane verification evidence."],
          expected_artifacts: [RUNTIME_MARKER_FILE],
          verification_plan: {
            commands: [
              {
                purpose: "prove runtime-lane self-bootstrap fixtures stay runnable",
                command: "pnpm verify:runtime-lanes"
              }
            ]
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    join(rootDir, SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH),
    `${JSON.stringify(
      {
        entry_type: "self_bootstrap_next_runtime_task_active",
        updated_at: "2026-04-01T00:00:00.000Z",
        source_anchor: {
          asset_path: "Codex/fixture-self-bootstrap-next-task.json",
          source_attempt_id: "fixture_runtime_lane_attempt",
          payload_sha256: "fixture_runtime_lane_payload_sha256",
          promoted_at: "2026-04-01T00:00:00.000Z"
        },
        title: "Runtime lane fixture self-bootstrap task",
        summary: "Keep runtime lane fixtures compatible with the self-bootstrap entry contract."
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await runCommand(rootDir, ["git", "init"]);
  await configureRepoUser(rootDir);
  await runCommand(rootDir, ["git", "add", "."]);
  await runCommand(rootDir, ["git", "commit", "-m", "test: seed runtime lane repo"]);
}

async function cloneRepo(sourceRoot: string, targetRoot: string): Promise<void> {
  await runCommand(process.cwd(), ["git", "clone", sourceRoot, targetRoot]);
  await configureRepoUser(targetRoot);
}

async function configureRepoUser(repoRoot: string): Promise<void> {
  await runCommand(repoRoot, ["git", "config", "user.name", "AISA Test"]);
  await runCommand(repoRoot, ["git", "config", "user.email", "aisa-test@example.com"]);
}

async function appendSeedRunJournal(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  run: Run
): Promise<void> {
  const journalFile = join(workspacePaths.runsDir, run.id, "journal.ndjson");
  await mkdir(join(workspacePaths.runsDir, run.id), { recursive: true });
  await writeFile(
    journalFile,
    `${JSON.stringify(
      createRunJournalEntry({
        run_id: run.id,
        type: "run.created",
        payload: {
          title: run.title
        }
      })
    )}\n`,
    "utf8"
  );
}

async function assertPathMissing(pathValue: string): Promise<void> {
  try {
    await access(pathValue);
  } catch {
    return;
  }

  throw new Error(`Path should not exist: ${pathValue}`);
}

async function readGitHead(repoRoot: string): Promise<string | null> {
  const result = await runCommandAllowFailure(repoRoot, ["git", "rev-parse", "HEAD"]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function readGitStatus(repoRoot: string): Promise<string[]> {
  const result = await runCommandAllowFailure(repoRoot, [
    "git",
    "status",
    "--porcelain=v1",
    "--untracked=all"
  ]);
  if (result.exitCode !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

async function runCommand(
  cwd: string,
  args: string[]
): Promise<{
  stdout: string;
  stderr: string;
}> {
  const result = await runCommandAllowFailure(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Command failed: ${args.join(" ")}`);
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}

async function runCommandAllowFailure(
  cwd: string,
  args: string[]
): Promise<{
  exitCode: number;
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
      resolveResult({
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function waitForRestartRequests(
  restartRequests: RuntimeRestartRequest[],
  expectedCount: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (restartRequests.length >= expectedCount) {
      return;
    }
    await sleep(25);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
