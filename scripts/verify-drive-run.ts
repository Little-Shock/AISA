import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAttempt,
  createAttemptContract,
  createAttemptRuntimeState,
  createCurrentDecision,
  createRun,
  createRunJournalEntry,
  createRunSteer,
  type Attempt,
  type Run,
  type WorkerWriteback
} from "../packages/domain/src/index.ts";
import {
  appendRunJournal,
  ensureWorkspace,
  getAttempt,
  getAttemptContract,
  getAttemptHeartbeat,
  getAttemptReviewPacket,
  getAttemptResult,
  getAttemptRuntimeState,
  getCurrentDecision,
  getAttemptRuntimeVerification,
  listAttempts,
  listRunJournal,
  resolveAttemptPaths,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptContract,
  saveCurrentDecision,
  saveAttemptRuntimeState,
  saveRun,
  saveRunSteer
} from "../packages/state-store/src/index.ts";
import { Orchestrator } from "../packages/orchestrator/src/index.ts";
import {
  captureAttemptCheckpointPreflight,
  maybeCreateVerifiedExecutionCheckpoint
} from "../packages/orchestrator/src/git-checkpoint.ts";
import { ensureRunManagedWorkspace } from "../packages/orchestrator/src/run-workspace.ts";
import { createDefaultRunWorkspaceScopePolicy } from "../packages/orchestrator/src/workspace-scope.ts";
import {
  SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME,
  SELF_BOOTSTRAP_NEXT_TASK_PROMOTION_ARTIFACT_FILE_NAME,
  SELF_BOOTSTRAP_NEXT_TASK_SOURCE_ASSET_SNAPSHOT_FILE_NAME
} from "../packages/orchestrator/src/self-bootstrap-next-task.js";
import {
  assertDriveRunReachedStableStop,
  driveRun,
  resolveSandboxForAttempt
} from "./drive-run.ts";
import {
  buildAttemptModeRules,
  prepareResearchShellGuard
} from "../packages/worker-adapters/src/index.ts";

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

type HostJudgeConfigSnapshot = {
  reviewersJson: string | undefined;
  synthesizerJson: string | undefined;
};

function assertClosedJudgeBaselineApplied(scriptName: string): void {
  assert.equal(
    process.env[REVIEWER_CONFIG_ENV],
    CLOSED_BASELINE_REVIEWERS_JSON,
    `${scriptName} must pin ${REVIEWER_CONFIG_ENV} to the closed runtime baseline.`
  );
  assert.equal(
    process.env[SYNTHESIZER_CONFIG_ENV],
    CLOSED_BASELINE_SYNTHESIZER_JSON,
    `${scriptName} must pin ${SYNTHESIZER_CONFIG_ENV} to the closed runtime baseline.`
  );
}

function assertHostJudgeConfigOverridden(
  scriptName: string,
  hostJudgeConfig: HostJudgeConfigSnapshot
): void {
  if (
    hostJudgeConfig.reviewersJson !== undefined &&
    hostJudgeConfig.reviewersJson !== CLOSED_BASELINE_REVIEWERS_JSON
  ) {
    assert.notEqual(
      process.env[REVIEWER_CONFIG_ENV],
      hostJudgeConfig.reviewersJson,
      `${scriptName} must not inherit the host ${REVIEWER_CONFIG_ENV}.`
    );
  }

  if (
    hostJudgeConfig.synthesizerJson !== undefined &&
    hostJudgeConfig.synthesizerJson !== CLOSED_BASELINE_SYNTHESIZER_JSON
  ) {
    assert.notEqual(
      process.env[SYNTHESIZER_CONFIG_ENV],
      hostJudgeConfig.synthesizerJson,
      `${scriptName} must not inherit the host ${SYNTHESIZER_CONFIG_ENV}.`
    );
  }
}

class ProgressingAdapter {
  readonly type = "fake-codex";
  private researchPassCount = 0;

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (input.attempt.attempt_type === "research") {
      this.researchPassCount += 1;

      if (this.researchPassCount === 1) {
        return {
          writeback: {
            summary:
              "Research found the next concrete backend step but is still missing a replayable execution contract.",
            findings: [
              {
                type: "fact",
                content: "Runtime loop can now be driven locally.",
                evidence: ["scripts/drive-run.ts"]
              }
            ],
            questions: [],
            recommended_next_steps: ["Implement the smallest execution change next."],
            confidence: 0.8,
            artifacts: []
          },
          reportMarkdown: "# research",
          exitCode: 0
        };
      }

      if (this.researchPassCount === 2) {
        return {
          writeback: {
            summary:
              "Research locked the next execution step behind a replayable execution contract.",
            findings: [
              {
                type: "fact",
                content: "The next execution step is grounded and replayable.",
                evidence: ["scripts/verify-drive-run.ts", "execution-note.md"]
              }
            ],
            questions: [],
            recommended_next_steps: ["Implement the smallest execution change next."],
            confidence: 0.84,
            next_attempt_contract: {
              attempt_type: "execution",
              objective: "Implement the smallest execution change next.",
              success_criteria: [
                "Write execution-note.md and leave replayable verification evidence."
              ],
              required_evidence: [
                "Leave git-visible workspace changes tied to the objective.",
                "Pass a replayable verification command that proves execution-note.md was written."
              ],
              done_rubric: [
                {
                  code: "git_change_recorded",
                  description: "Leave a git-visible workspace change."
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
                "Do not claim execution success without replaying the locked verification command."
              ],
              expected_artifacts: ["execution-note.md"],
              verification_plan: {
                commands: [
                  {
                    purpose: "confirm the execution note was written",
                    command: 'test -f execution-note.md && rg -n "^checkpointed by att_" execution-note.md'
                  },
                  {
                    purpose: "emit preserved self-bootstrap publication evidence",
                    command:
                      "node artifacts/self-bootstrap-sync-fixture/emit-self-bootstrap-sync-evidence.mjs"
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

      throw new Error("Unexpected extra research pass in verify-drive-run.");
    }

    assert.equal(
      this.researchPassCount,
      2,
      "execution should only start after research leaves a replayable contract"
    );

    await writeFile(
      join(input.attempt.workspace_root, "execution-note.md"),
      `checkpointed by ${input.attempt.id}\n`,
      "utf8"
    );
    const selfBootstrapFixtureDir = join(
      input.attempt.workspace_root,
      "artifacts",
      "self-bootstrap-sync-fixture"
    );
    await mkdir(selfBootstrapFixtureDir, { recursive: true });

    await writeFile(
      join(
        selfBootstrapFixtureDir,
        "self-bootstrap-next-task-promotion.preserved.json"
      ),
      JSON.stringify(
        {
          status: "passed",
          command:
            "pnpm promote:self-bootstrap-next-task -- Codex/2026-03-29-self-bootstrap-next-runtime-task-att_fixture.json",
          source_asset:
            "Codex/2026-03-29-self-bootstrap-next-runtime-task-att_fixture.json"
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    await writeFile(
      join(
        selfBootstrapFixtureDir,
        SELF_BOOTSTRAP_NEXT_TASK_SOURCE_ASSET_SNAPSHOT_FILE_NAME
      ),
      JSON.stringify(
        {
          attempt_id: input.attempt.id,
          title: "同步当前 execution attempt 的 self-bootstrap 证据",
          summary: "fixture source asset snapshot"
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    await writeFile(
      join(
        selfBootstrapFixtureDir,
        SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME
      ),
      JSON.stringify(
        {
          entry_type: "self_bootstrap_next_runtime_task_active",
          source_anchor: {
            asset_path:
              "Codex/2026-03-29-self-bootstrap-next-runtime-task-att_fixture.json",
            source_attempt_id: input.attempt.id
          }
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    await writeFile(
      join(
        selfBootstrapFixtureDir,
        "emit-self-bootstrap-sync-evidence.mjs"
      ),
      [
        'import { resolve } from "node:path";',
        "const fixtureDir = resolve(process.cwd(), \"artifacts\", \"self-bootstrap-sync-fixture\");",
        "console.log(JSON.stringify({",
        '  retained_publication_artifact: resolve(fixtureDir, "self-bootstrap-next-task-promotion.preserved.json"),',
        `  retained_source_asset_snapshot: resolve(fixtureDir, "${SELF_BOOTSTRAP_NEXT_TASK_SOURCE_ASSET_SNAPSHOT_FILE_NAME}"),`,
        `  retained_published_active_entry: resolve(fixtureDir, "${SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME}")`,
        "}, null, 2));"
      ].join("\n") + "\n",
      "utf8"
    );

    return {
      writeback: {
        summary: "Execution finished with a verification artifact.",
        findings: [
          {
            type: "fact",
            content: "Execution completed and left traceable evidence.",
            evidence: ["execution-note.md"]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.86,
        artifacts: [
          {
            type: "patch",
            path: "artifacts/demo.patch"
          }
        ]
      },
      reportMarkdown: "# execution",
      exitCode: 0
    };
  }
}

class CompletedRuntimeStateExecutionAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
    workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    await writeFile(
      join(input.attempt.workspace_root, "execution-note.md"),
      `checkpointed by ${input.attempt.id}\n`,
      "utf8"
    );
    await saveAttemptRuntimeState(
      input.workspacePaths,
      createAttemptRuntimeState({
        run_id: input.run.id,
        attempt_id: input.attempt.id,
        running: false,
        phase: "completed",
        active_since: input.attempt.started_at ?? new Date().toISOString(),
        last_event_at: new Date().toISOString(),
        progress_text: "执行完成",
        final_output: "execution-note.md written"
      })
    );

    return {
      writeback: {
        summary: "Execution finished and left replayable evidence.",
        findings: [
          {
            type: "fact",
            content: "The execution note was written before runtime verification started.",
            evidence: ["execution-note.md"]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.88,
        artifacts: []
      },
      reportMarkdown: "# execution",
      exitCode: 0
    };
  }
}

class DelayedResearchAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    await sleep(200);

    return {
      writeback: {
        summary: "Research finished after a short delay and still needs another round.",
        findings: [
          {
            type: "fact",
            content: "The repository needs more runtime analysis before execution.",
            evidence: ["scripts/verify-drive-run.ts"]
          }
        ],
        questions: [],
        recommended_next_steps: ["Keep researching the runtime gap."],
        confidence: 0.62,
        artifacts: []
      },
      reportMarkdown: "# delayed research",
      exitCode: 0
    };
  }
}

async function withTemporaryEnv<T>(
  name: string,
  value: string,
  callback: () => Promise<T>
): Promise<T> {
  const previous = process.env[name];
  process.env[name] = value;

  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

async function withClosedJudgeBaseline<T>(
  callback: (hostJudgeConfig: HostJudgeConfigSnapshot) => Promise<T>
): Promise<T> {
  const hostJudgeConfig: HostJudgeConfigSnapshot = {
    reviewersJson: process.env[REVIEWER_CONFIG_ENV],
    synthesizerJson: process.env[SYNTHESIZER_CONFIG_ENV]
  };

  return await withTemporaryEnv(REVIEWER_CONFIG_ENV, CLOSED_BASELINE_REVIEWERS_JSON, async () =>
    await withTemporaryEnv(
      SYNTHESIZER_CONFIG_ENV,
      CLOSED_BASELINE_SYNTHESIZER_JSON,
      async () => await callback(hostJudgeConfig)
    )
  );
}

async function main(hostJudgeConfig: HostJudgeConfigSnapshot): Promise<void> {
  assertClosedJudgeBaselineApplied("verify-drive-run");
  assertHostJudgeConfigOverridden("verify-drive-run", hostJudgeConfig);
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-drive-run-"));
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);
  await initializeGitRepo(rootDir);
  await verifyManagedWorkspaceCheckpointCatchesUpDirtyBaseline();
  await verifyExecutionAttemptRuntimeStateTransitionsAcrossVerification();
  await verifyDriveRunDoesNotLeaveRunningAttemptBehind();

  const run = createRun({
    title: "Drive a self-bootstrap run locally",
    description: "Verify the local driver can advance a run to the next stable decision.",
    success_criteria: ["Advance from research to execution-ready state."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: rootDir
  });
  const current = createCurrentDecision({
    run_id: run.id,
    run_status: "running",
    recommended_next_action: "start_first_attempt",
    recommended_attempt_type: "research",
    summary: "Bootstrapped for local driver verification."
  });
  const steer = createRunSteer({
    run_id: run.id,
    content: "Stay on backend/runtime work and stop once the next step is clear."
  });

  await saveRun(workspacePaths, run);
  await saveCurrentDecision(workspacePaths, current);
  await saveRunSteer(workspacePaths, steer);
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.created",
      payload: {
        title: run.title
      }
    })
  );

  const adapter = new ProgressingAdapter();
  const firstStableStop = await settleFirstResearchAttempt({
    workspacePaths,
    runId: run.id,
    adapter
  });

  assert.equal(
    firstStableStop.current?.run_status,
    "running"
  );
  assert.equal(
    firstStableStop.current?.recommended_next_action,
    "continue_research",
    "research without a replayable contract must keep the loop in research"
  );
  assert.equal(
    firstStableStop.current?.recommended_attempt_type,
    "research",
    "missing execution contract should block execution dispatch"
  );
  assert.match(
    firstStableStop.current?.blocking_reason ?? "",
    /Need a replayable execution contract before the loop can start an execution attempt\./,
    "first stop should explain that execution is blocked on a replayable contract"
  );
  assert.deepEqual(
    firstStableStop.attempts.map((attempt) => attempt.attempt_type),
    ["research"],
    "local drive-run should not create an execution attempt before the contract is ready"
  );

  const secondStop = await driveRun({
    workspaceRoot: rootDir,
    runId: run.id,
    adapter: adapter as never,
    pollIntervalMs: 50,
    maxPolls: 200
  });

  const checkpointEntry = await waitForCheckpointEntry(workspacePaths, run.id);
  const persistedCurrent = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const orderedAttempts = [...attempts].sort((left, right) =>
    left.created_at.localeCompare(right.created_at)
  );
  const executionAttempts = attempts.filter((attempt) => attempt.attempt_type === "execution");
  const researchAttempts = orderedAttempts.filter((attempt) => attempt.attempt_type === "research");
  const [firstResearchAttempt, secondResearchAttempt] = researchAttempts;
  assert.ok(firstResearchAttempt, "first research attempt should be persisted");
  assert.ok(secondResearchAttempt, "second research attempt should persist the execution contract");
  const executionAttempt = attempts.find((attempt) => attempt.id === checkpointEntry.attempt_id);
  assert.ok(executionAttempt, "checkpoint entry should point to a persisted attempt");
  assert.equal(executionAttempt.attempt_type, "execution");
  const [
    firstResearchResult,
    secondResearchResult,
    executionAttemptContract,
    executionAttemptReviewPacket
  ] = await Promise.all([
    getAttemptResult(workspacePaths, run.id, firstResearchAttempt.id),
    getAttemptResult(workspacePaths, run.id, secondResearchAttempt.id),
    getAttemptContract(workspacePaths, run.id, executionAttempt.id),
    getAttemptReviewPacket(workspacePaths, run.id, executionAttempt.id)
  ]);
  const runtimeVerification = await getAttemptRuntimeVerification(
    workspacePaths,
    run.id,
    executionAttempt.id
  );
  const executionAttemptPaths = resolveAttemptPaths(
    workspacePaths,
    run.id,
    executionAttempt.id
  );
  assert.ok(runtimeVerification, "execution attempt should persist runtime verification evidence");
  assert.equal(
    firstResearchResult?.next_attempt_contract,
    undefined,
    "first research attempt should not leave an execution contract"
  );
  assert.ok(
    secondResearchResult?.next_attempt_contract,
    "second research attempt should leave a replayable execution contract"
  );
  assert.equal(secondResearchResult?.next_attempt_contract?.attempt_type, "execution");
  assert.ok(executionAttemptContract, "execution attempt should persist the promoted contract");
  assert.equal(
    executionAttempt.objective,
    secondResearchResult?.next_attempt_contract?.objective,
    "execution should consume the research-provided contract objective"
  );
  assert.deepEqual(
    executionAttemptContract?.verification_plan,
    secondResearchResult?.next_attempt_contract?.verification_plan,
    "execution should keep the replayable verification plan from research"
  );
  const checkpointArtifact = String(checkpointEntry.payload.artifact_path);
  await waitForFile(checkpointArtifact);
  const checkpoint = JSON.parse(await readFile(checkpointArtifact, "utf8")) as {
    status: string;
    commit: {
      sha: string;
      message: string;
      changed_files: string[];
    };
  };
  const executionWorkspaceRoot = executionAttempt.workspace_root;
  const latestCommitSubject = (
    await runCommand(executionWorkspaceRoot, [
      "git",
      "-C",
      executionWorkspaceRoot,
      "log",
      "-1",
      "--format=%s"
    ])
  ).stdout.trim();
  const gitStatusAfterCheckpoint = (
    await runCommand(executionWorkspaceRoot, [
      "git",
      "-C",
      executionWorkspaceRoot,
      "status",
      "--porcelain=v1"
    ])
  ).stdout.trim();
  assert.equal(secondStop.stopReason, "run_settled");
  assert.doesNotThrow(() => assertDriveRunReachedStableStop(secondStop));
  assert.equal(persistedCurrent?.run_status, "waiting_steer");
  assert.equal(persistedCurrent?.waiting_for_human, true);
  assert.equal(persistedCurrent?.recommended_next_action, "wait_for_human");
  assert.match(
    persistedCurrent?.blocking_reason ?? "",
    /Promoted checkpoint/u
  );
  assert.equal(executionAttempts.length, 1);
  assert.equal(researchAttempts.length, 2);
  assert.ok(
    attempts.every((attempt) => attempt.status === "completed"),
    "all recorded attempts should be completed by the settled stop"
  );
  assert.equal(runtimeVerification.status, "passed");
  assert.equal(runtimeVerification.command_results.length, 2);
  assert.deepEqual(runtimeVerification.changed_files, ["execution-note.md"]);
  assert.equal(checkpointEntry.attempt_id, executionAttempt.id);
  assert.equal(checkpoint.status, "created");
  assert.equal(latestCommitSubject, checkpoint.commit.message);
  assert.equal(gitStatusAfterCheckpoint, "");
  assert.match(checkpoint.commit.message, new RegExp(run.id));
  assert.match(checkpoint.commit.message, new RegExp(executionAttempt.id));
  assert.deepEqual(checkpoint.commit.changed_files, ["execution-note.md"]);
  assert.equal(
    runtimeVerification.command_results[1]?.command,
    "node artifacts/self-bootstrap-sync-fixture/emit-self-bootstrap-sync-evidence.mjs"
  );

  const retainedFixtureDir = join(
    executionWorkspaceRoot,
    "artifacts",
    "self-bootstrap-sync-fixture"
  );
  const syncedPublicationArtifactPath = join(
    executionAttemptPaths.artifactsDir,
    SELF_BOOTSTRAP_NEXT_TASK_PROMOTION_ARTIFACT_FILE_NAME
  );
  const syncedSourceAssetSnapshotPath = join(
    executionAttemptPaths.artifactsDir,
    SELF_BOOTSTRAP_NEXT_TASK_SOURCE_ASSET_SNAPSHOT_FILE_NAME
  );
  const syncedPublishedActiveEntryPath = join(
    executionAttemptPaths.artifactsDir,
    SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME
  );
  const syncedPublicationArtifactRelativePath =
    `artifacts/${SELF_BOOTSTRAP_NEXT_TASK_PROMOTION_ARTIFACT_FILE_NAME}`;
  const syncedSourceAssetSnapshotRelativePath =
    `artifacts/${SELF_BOOTSTRAP_NEXT_TASK_SOURCE_ASSET_SNAPSHOT_FILE_NAME}`;
  const syncedPublishedActiveEntryRelativePath =
    `artifacts/${SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME}`;

  assert.deepEqual(runtimeVerification.synced_self_bootstrap_artifacts, {
    publication_artifact: syncedPublicationArtifactPath,
    source_asset_snapshot: syncedSourceAssetSnapshotPath,
    published_active_entry: syncedPublishedActiveEntryPath
  });
  assert.ok(
    executionAttemptReviewPacket,
    "execution attempt should persist a settled review packet"
  );
  assert.deepEqual(
    executionAttemptReviewPacket?.runtime_verification?.synced_self_bootstrap_artifacts,
    runtimeVerification.synced_self_bootstrap_artifacts,
    "execution review packet should retain the synced self-bootstrap artifact paths"
  );
  assert.ok(
    executionAttemptReviewPacket?.artifact_manifest.some(
      (artifact) =>
        artifact.kind ===
          "attempt.runtime_verification.self_bootstrap.publication_artifact" &&
        artifact.path === syncedPublicationArtifactRelativePath &&
        artifact.exists
    ),
    "execution review packet should expose the synced publication artifact"
  );
  assert.ok(
    executionAttemptReviewPacket?.artifact_manifest.some(
      (artifact) =>
        artifact.kind ===
          "attempt.runtime_verification.self_bootstrap.source_asset_snapshot" &&
        artifact.path === syncedSourceAssetSnapshotRelativePath &&
        artifact.exists
    ),
    "execution review packet should expose the synced source asset snapshot"
  );
  assert.ok(
    executionAttemptReviewPacket?.artifact_manifest.some(
      (artifact) =>
        artifact.kind ===
          "attempt.runtime_verification.self_bootstrap.published_active_entry" &&
        artifact.path === syncedPublishedActiveEntryRelativePath &&
        artifact.exists
    ),
    "execution review packet should expose the synced active entry snapshot"
  );
  assert.equal(
    await readFile(syncedPublicationArtifactPath, "utf8"),
    await readFile(
      join(retainedFixtureDir, "self-bootstrap-next-task-promotion.preserved.json"),
      "utf8"
    ),
    "runtime verification should sync the preserved publication artifact into the execution attempt"
  );
  assert.equal(
    await readFile(syncedSourceAssetSnapshotPath, "utf8"),
    await readFile(
      join(retainedFixtureDir, SELF_BOOTSTRAP_NEXT_TASK_SOURCE_ASSET_SNAPSHOT_FILE_NAME),
      "utf8"
    ),
    "runtime verification should sync the preserved source asset snapshot into the execution attempt"
  );
  assert.equal(
    await readFile(syncedPublishedActiveEntryPath, "utf8"),
    await readFile(
      join(retainedFixtureDir, SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME),
      "utf8"
    ),
    "runtime verification should sync the preserved active entry snapshot into the execution attempt"
  );

  assert.equal(resolveSandboxForAttempt("read-only", "research"), "read-only");
  assert.equal(resolveSandboxForAttempt("read-only", "execution"), "workspace-write");
  assert.equal(
    resolveSandboxForAttempt("danger-full-access", "execution"),
    "danger-full-access"
  );
  assert.throws(
    () =>
      assertDriveRunReachedStableStop({
        run,
        stopReason: "max_polls_exhausted"
      }),
    /did not reach a stable stop/
  );

  const researchRules = buildAttemptModeRules("research");
  const executionRules = buildAttemptModeRules("execution");
  assert.ok(
    researchRules.some((line) => line.includes("Do not run package scripts, tsx")),
    "research mode should forbid heavy script execution"
  );
  assert.ok(
    researchRules.some((line) =>
      line.includes("next_attempt_contract with replayable verification commands")
    ),
    "research mode should require a replayable contract before execution"
  );
  assert.ok(
    executionRules.some((line) => line.includes("You may modify files")),
    "execution mode should allow workspace changes"
  );

  const shellGuard = await prepareResearchShellGuard({
    artifactsDir: join(rootDir, "guard-check"),
    baseEnv: process.env
  });
  assert.ok(shellGuard.allowedCommands.includes("rg"));
  assert.ok(shellGuard.blockedCommands.includes("pnpm"));

  const blockedShell = await runShell(shellGuard.env, "pnpm --version");
  assert.equal(blockedShell.exitCode, 64);
  assert.match(blockedShell.stderr, /AISA research mode blocks pnpm/);

  const allowedShell = await runShell(
    shellGuard.env,
    "command -v rg >/dev/null && rg --version >/dev/null"
  );
  assert.equal(allowedShell.exitCode, 0);

  console.log(
    JSON.stringify(
      {
        run_id: run.id,
        first_stop_next_action: firstStableStop.current?.recommended_next_action ?? null,
        first_stop_blocking_reason: firstStableStop.current?.blocking_reason ?? null,
        stop_reason: secondStop.stopReason,
        attempt_types: attempts.map((attempt) => attempt.attempt_type),
        research_attempt_count: researchAttempts.length,
        execution_attempt_count: executionAttempts.length,
        run_status: persistedCurrent?.run_status ?? null,
        synced_self_bootstrap_artifacts: {
          publication_artifact: syncedPublicationArtifactPath,
          source_asset_snapshot: syncedSourceAssetSnapshotPath,
          published_active_entry: syncedPublishedActiveEntryPath
        }
      },
      null,
      2
    )
  );
}

async function verifyManagedWorkspaceCheckpointCatchesUpDirtyBaseline(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-managed-checkpoint-"));
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);
  await initializeGitRepo(rootDir);

  const seededRun = createRun({
    title: "Managed workspace checkpoint catch-up",
    description:
      "Verify a managed run workspace can checkpoint verified progress even when it starts dirty.",
    success_criteria: ["Create a checkpoint that absorbs preexisting managed-workspace changes."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: rootDir
  });
  const managedRun = await ensureRunManagedWorkspace({
    run: seededRun,
    policy: createDefaultRunWorkspaceScopePolicy(rootDir)
  });
  assert.ok(
    managedRun.managed_workspace_root,
    "managed workspace checkpoint test should provision an isolated worktree"
  );
  await saveRun(workspacePaths, managedRun);

  const attempt = createAttempt({
    run_id: managedRun.id,
    attempt_type: "execution",
    worker: "fake-codex",
    objective: "Checkpoint the managed workspace after verification passes.",
    success_criteria: ["Create a checkpoint commit that leaves the worktree clean."],
    workspace_root: managedRun.managed_workspace_root
  });
  await saveAttempt(workspacePaths, attempt);

  const attemptPaths = resolveAttemptPaths(workspacePaths, managedRun.id, attempt.id);
  await writeFile(
    join(managedRun.managed_workspace_root, "preexisting-note.md"),
    "left dirty from a prior verified attempt\n",
    "utf8"
  );

  const preflight = await captureAttemptCheckpointPreflight({
    attempt,
    attemptPaths
  });
  assert.equal(preflight?.status, "ready");
  assert.ok(
    preflight?.status_before.some((line) => line.includes("preexisting-note.md")),
    "managed workspace preflight should capture the preexisting dirty file"
  );

  await writeFile(
    join(managedRun.managed_workspace_root, "execution-note.md"),
    `checkpointed by ${attempt.id}\n`,
    "utf8"
  );

  const checkpointOutcome = await maybeCreateVerifiedExecutionCheckpoint({
    run: managedRun,
    attempt,
    evaluation: {
      attempt_id: attempt.id,
      run_id: managedRun.id,
      goal_progress: 0.9,
      evidence_quality: 0.9,
      verification_status: "passed",
      recommendation: "continue",
      suggested_attempt_type: "execution",
      rationale: "Verification passed and should create a checkpoint.",
      missing_evidence: [],
      review_input_packet_ref: null,
      opinion_refs: [],
      evaluation_synthesis_ref: null,
      synthesis_strategy: "legacy_single_judge",
      synthesizer: null,
      reviewer_count: 0,
      created_at: new Date().toISOString()
    },
    attemptPaths,
    preflight
  });

  assert.equal(
    checkpointOutcome.status,
    "created",
    "managed workspaces should checkpoint verified progress instead of staying blocked forever"
  );

  const checkpoint = JSON.parse(await readFile(checkpointOutcome.artifact_path, "utf8")) as {
    status: string;
    message: string;
    includes_preexisting_changes?: boolean;
    preexisting_status_before?: string[];
    commit: {
      changed_files: string[];
    };
  };
  const gitStatusAfterCheckpoint = (
    await runCommand(managedRun.managed_workspace_root, [
      "git",
      "-C",
      managedRun.managed_workspace_root,
      "status",
      "--porcelain=v1"
    ])
  ).stdout.trim();

  assert.equal(checkpoint.status, "created");
  assert.equal(gitStatusAfterCheckpoint, "");
  assert.equal(
    checkpoint.includes_preexisting_changes,
    true,
    "checkpoint artifact should record that it absorbed preexisting managed-workspace changes"
  );
  assert.ok(
    checkpoint.preexisting_status_before?.some((line) => line.includes("preexisting-note.md")),
    "checkpoint artifact should preserve the preflight dirty status"
  );
  assert.deepEqual(
    [...checkpoint.commit.changed_files].sort(),
    ["execution-note.md", "preexisting-note.md"],
    "catch-up checkpoint should commit both the carried-over dirty file and the new execution delta"
  );
}

async function verifyExecutionAttemptRuntimeStateTransitionsAcrossVerification(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-runtime-state-verifying-"));
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);
  await initializeGitRepo(rootDir);

  const run = createRun({
    title: "Keep execution runtime state truthful during verification",
    description:
      "Verify execution attempts switch back to a running verifying state after the worker already marked itself completed.",
    success_criteria: ["Show verifying while runtime replay is still running."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: rootDir
  });
  const current = createCurrentDecision({
    run_id: run.id,
    run_status: "running",
    recommended_next_action: "attempt_running",
    recommended_attempt_type: "execution",
    summary: "Dispatching an execution attempt for runtime-state verification."
  });
  const attempt = createAttempt({
    run_id: run.id,
    attempt_type: "execution",
    worker: "fake-codex",
    objective: "Write a visible execution note and replay runtime verification.",
    success_criteria: ["Leave git-visible changes and survive runtime replay."],
    workspace_root: rootDir
  });
  const attemptContract = createAttemptContract({
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: "execution",
    objective: attempt.objective,
    success_criteria: attempt.success_criteria,
    required_evidence: [
      "Leave a git-visible workspace change tied to the execution objective.",
      "Replay the locked verification command before claiming completion."
    ],
    forbidden_shortcuts: [
      "Do not leave the runtime state at completed while runtime verification is still running."
    ],
    expected_artifacts: ["execution-note.md"],
    verification_plan: {
      commands: [
        {
          purpose: "keep runtime verification alive long enough to observe the phase handoff",
          command: 'node -e "setTimeout(() => process.exit(0), 1200)"'
        }
      ]
    }
  });

  await saveRun(workspacePaths, run);
  await saveCurrentDecision(workspacePaths, current);
  await saveAttempt(workspacePaths, attempt);
  await saveAttemptContract(workspacePaths, attemptContract);

  const orchestrator = new Orchestrator(
    workspacePaths,
    new CompletedRuntimeStateExecutionAdapter() as never,
    undefined,
    10
  );

  await orchestrator.tick();

  const verifyingState = await waitForAttemptRuntimeState(
    workspacePaths,
    run.id,
    attempt.id,
    (state) => state?.phase === "verifying" && state.running,
    4_000
  );
  const runningAttempt = await getAttempt(workspacePaths, run.id, attempt.id);

  assert.equal(
    verifyingState?.phase,
    "verifying",
    "runtime state should expose the verification phase instead of staying completed"
  );
  assert.equal(verifyingState?.running, true);
  assert.equal(verifyingState?.progress_text, "运行时回放中");
  assert.equal(runningAttempt.status, "running");

  await waitForAttemptCompletion(workspacePaths, run.id, attempt.id, 8_000);

  const completedState = await waitForAttemptRuntimeState(
    workspacePaths,
    run.id,
    attempt.id,
    (state) => state?.phase === "completed" && state.running === false,
    4_000
  );
  const runtimeVerification = await getAttemptRuntimeVerification(
    workspacePaths,
    run.id,
    attempt.id
  );

  assert.equal(completedState?.phase, "completed");
  assert.equal(completedState?.running, false);
  assert.equal(runtimeVerification?.status, "passed");
}

async function verifyDriveRunDoesNotLeaveRunningAttemptBehind(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-drive-run-drain-"));
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);
  await initializeGitRepo(rootDir);

  const run = createRun({
    title: "Drain running attempt before returning",
    description: "Verify drive-run does not exit while it still owns an active attempt.",
    success_criteria: ["Do not leave a running attempt behind when poll budget is exhausted."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: rootDir
  });
  const current = createCurrentDecision({
    run_id: run.id,
    run_status: "running",
    recommended_next_action: "start_first_attempt",
    recommended_attempt_type: "research",
    summary: "Start a delayed research attempt."
  });

  await saveRun(workspacePaths, run);
  await saveCurrentDecision(workspacePaths, current);

  const result = await driveRun({
    workspaceRoot: rootDir,
    runId: run.id,
    adapter: new DelayedResearchAdapter() as never,
    pollIntervalMs: 10,
    maxPolls: 1
  });

  const attempts = await listAttempts(workspacePaths, run.id);
  const latestAttempt = attempts.at(-1) ?? null;
  assert.ok(latestAttempt, "drive-run drain test should persist a research attempt");
  assert.ok(
    ["max_polls_exhausted", "run_settled"].includes(result.stopReason),
    `drain path should only stop after the active attempt settles, got ${result.stopReason}`
  );
  assert.notEqual(
    latestAttempt?.status,
    "running",
    "drive-run must not leave a running attempt behind after it returns"
  );
  const heartbeat = latestAttempt
    ? await getAttemptHeartbeat(workspacePaths, run.id, latestAttempt.id)
    : null;
  assert.equal(
    heartbeat?.status,
    "released",
    "drive-run must release the active heartbeat before it returns"
  );
}

async function settleFirstResearchAttempt(input: {
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  runId: string;
  adapter: ProgressingAdapter;
}): Promise<{
  current: Awaited<ReturnType<typeof getCurrentDecision>>;
  attempts: Awaited<ReturnType<typeof listAttempts>>;
}> {
  const orchestrator = new Orchestrator(
    input.workspacePaths,
    input.adapter as never,
    undefined,
    10
  );

  await orchestrator.tick();
  const [createdAttempt] = await listAttempts(input.workspacePaths, input.runId);
  assert.ok(createdAttempt, "first research attempt should be created on the first tick");
  assert.equal(createdAttempt.attempt_type, "research");

  await orchestrator.tick();
  await waitForAttemptCompletion(input.workspacePaths, input.runId, createdAttempt.id);
  const current = await waitForStableDecisionForAttempt(
    input.workspacePaths,
    input.runId,
    createdAttempt.id
  );
  const attempts = await listAttempts(input.workspacePaths, input.runId);

  return {
    current,
    attempts
  };
}

async function runShell(
  env: NodeJS.ProcessEnv,
  command: string
): Promise<{
  exitCode: number;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/zsh", ["-lc", command], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stderr
      });
    });
  });
}

async function initializeGitRepo(rootDir: string): Promise<void> {
  await writeFile(
    join(rootDir, ".gitignore"),
    ["runs/", "state/", "events/", "artifacts/", "reports/", "plans/"].join("\n") + "\n",
    "utf8"
  );
  await writeFile(join(rootDir, "README.md"), "# temp repo\n", "utf8");

  await runCommand(rootDir, ["git", "-C", rootDir, "init"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "config", "user.name", "AISA Test"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "config", "user.email", "aisa-test@example.com"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "add", "."]);
  await runCommand(rootDir, ["git", "-C", rootDir, "commit", "-m", "test: seed repo"]);
}

async function runCommand(
  cwd: string,
  args: string[]
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const [command, ...commandArgs] = args;
    const child = spawn(command!, commandArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        reject(new Error(stderr || `Command failed: ${args.join(" ")}`));
        return;
      }

      resolve({
        exitCode,
        stdout,
        stderr
      });
    });
  });
}

async function waitForCheckpointEntry(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string
) {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const journal = await listRunJournal(workspacePaths, runId);
    const checkpointEntry = journal.find((entry) => entry.type === "attempt.checkpoint.created");

    if (checkpointEntry) {
      return checkpointEntry;
    }

    await sleep(10);
  }

  throw new Error(`Timed out waiting for checkpoint journal entry for run ${runId}`);
}

async function waitForAttemptCompletion(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string,
  attemptId: string,
  timeoutMs = 1_500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const attempts = await listAttempts(workspacePaths, runId);
    const attempt = attempts.find((candidate) => candidate.id === attemptId);

    if (attempt?.status === "completed") {
      return;
    }

    if (attempt && ["failed", "stopped"].includes(attempt.status)) {
      throw new Error(`Attempt ${attemptId} settled unexpectedly with status ${attempt.status}`);
    }

    await sleep(10);
  }

  throw new Error(`Timed out waiting for attempt ${attemptId} to complete`);
}

async function waitForAttemptRuntimeState(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string,
  attemptId: string,
  predicate: (
    state: Awaited<ReturnType<typeof getAttemptRuntimeState>>
  ) => boolean,
  timeoutMs = 1_500
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await getAttemptRuntimeState(workspacePaths, runId, attemptId);

    if (predicate(state)) {
      return state;
    }

    await sleep(10);
  }

  throw new Error(`Timed out waiting for runtime state for attempt ${attemptId}`);
}

async function waitForStableDecisionForAttempt(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string,
  attemptId: string
) {
  const deadline = Date.now() + 1_500;

  while (Date.now() < deadline) {
    const current = await getCurrentDecision(workspacePaths, runId);
    if (
      current?.latest_attempt_id === attemptId &&
      current.recommended_next_action !== "attempt_running"
    ) {
      return current;
    }

    await sleep(10);
  }

  throw new Error(`Timed out waiting for stable decision after attempt ${attemptId}`);
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 1500;

  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await sleep(10);
    }
  }

  throw new Error(`Timed out waiting for file ${filePath}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

withClosedJudgeBaseline(main).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
