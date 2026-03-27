import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAttempt,
  createAttemptContract,
  createCurrentDecision,
  createAttemptRuntimeEvent,
  createAttemptRuntimeState,
  createRun,
  createRunJournalEntry,
  updateAttempt
} from "../packages/domain/src/index.ts";
import {
  appendRunJournal,
  appendAttemptRuntimeEvent,
  ensureWorkspace,
  listAttempts,
  resolveAttemptPaths,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptContract,
  saveAttemptContext,
  saveAttemptEvaluation,
  saveAttemptHeartbeat,
  saveAttemptReviewPacket,
  saveAttemptResult,
  saveAttemptRuntimeState,
  saveAttemptRuntimeVerification,
  saveCurrentDecision,
  saveRun
} from "../packages/state-store/src/index.ts";
import { buildServer } from "../apps/control-api/src/index.ts";

async function main(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-run-detail-api-"));
  const projectScopeDir = await mkdtemp(join(tmpdir(), "aisa-run-scope-"));
  const projectRoot = join(projectScopeDir, "project-a");
  await mkdir(projectRoot, { recursive: true });
  const resolvedRootDir = await realpath(rootDir);
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);

  const run = createRun({
    title: "Run detail API verification",
    description: "Ensure run detail exposes attempt evidence for self-bootstrap debugging.",
    success_criteria: ["Expose attempt result, evaluation, and runtime verification."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: projectRoot
  });
  const current = createCurrentDecision({
    run_id: run.id,
    run_status: "completed",
    latest_attempt_id: null,
    recommended_next_action: null,
    recommended_attempt_type: null,
    summary: "Run completed with persisted execution evidence."
  });
  const createdAttempt = createAttempt({
    run_id: run.id,
    attempt_type: "execution",
    worker: "fake-codex",
    objective: "Make a small backend change and verify it.",
    success_criteria: run.success_criteria,
    workspace_root: projectRoot
  });
  const attempt = updateAttempt(createdAttempt, {
    status: "completed",
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    input_context_ref: `runs/${run.id}/attempts/${createdAttempt.id}/context.json`
  });

  await saveRun(workspacePaths, run);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: current.run_id,
      run_status: current.run_status,
      latest_attempt_id: attempt.id,
      best_attempt_id: attempt.id,
      recommended_next_action: current.recommended_next_action,
      recommended_attempt_type: current.recommended_attempt_type,
      summary: current.summary
    })
  );
  await saveAttempt(workspacePaths, attempt);
  await saveAttemptContract(
    workspacePaths,
    createAttemptContract({
      attempt_id: attempt.id,
      run_id: run.id,
      attempt_type: "execution",
      objective: attempt.objective,
      success_criteria: attempt.success_criteria,
      required_evidence: [
        "git-visible workspace changes",
        "runtime replay success"
      ],
      expected_artifacts: ["artifacts/runtime.patch"],
      verification_plan: {
        commands: [
          {
            purpose: "replay runtime suite",
            command: "pnpm verify:runtime"
          }
        ]
      }
    })
  );
  const persistedContext = {
    contract: {
      title: "Run detail API verification"
    },
    current_decision: {
      summary: "Run completed with persisted execution evidence."
    },
    previous_attempts: [
      {
        id: "att_seeded123",
        status: "completed"
      }
    ]
  };
  await saveAttemptContext(workspacePaths, run.id, attempt.id, persistedContext);
  await saveAttemptResult(workspacePaths, run.id, attempt.id, {
    summary: "Execution left a replayable verification plan.",
    findings: [
      {
        type: "fact",
        content: "Updated the backend runtime path.",
        evidence: ["packages/orchestrator/src/index.ts"]
      }
    ],
    questions: [],
    recommended_next_steps: [],
    confidence: 0.84,
    verification_plan: {
      commands: [
        {
          purpose: "replay runtime suite",
          command: "pnpm verify:runtime"
        }
      ]
    },
    artifacts: [
      {
        type: "patch",
        path: "artifacts/runtime.patch"
      }
    ]
  });
  await saveAttemptEvaluation(workspacePaths, {
    attempt_id: attempt.id,
    run_id: run.id,
    goal_progress: 0.92,
    evidence_quality: 1,
    verification_status: "passed",
    recommendation: "complete",
    suggested_attempt_type: null,
    rationale: "runtime replay passed",
    missing_evidence: [],
    created_at: new Date().toISOString()
  });
  await saveAttemptRuntimeVerification(workspacePaths, {
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: "execution",
    status: "passed",
    repo_root: rootDir,
    git_head: "deadbeef",
    git_status: [" M packages/orchestrator/src/index.ts"],
    preexisting_git_status: [],
    new_git_status: [" M packages/orchestrator/src/index.ts"],
    changed_files: ["packages/orchestrator/src/index.ts"],
    failure_code: null,
    failure_reason: null,
    command_results: [
      {
        purpose: "replay runtime suite",
        command: "pnpm verify:runtime",
        cwd: rootDir,
        expected_exit_code: 0,
        exit_code: 0,
        passed: true,
        stdout_file: join(rootDir, "runs", run.id, "attempts", attempt.id, "artifacts", "runtime-verification", "command-01.stdout.log"),
        stderr_file: join(rootDir, "runs", run.id, "attempts", attempt.id, "artifacts", "runtime-verification", "command-01.stderr.log")
      }
    ],
    created_at: new Date().toISOString()
  });
  await saveAttemptRuntimeState(
    workspacePaths,
    createAttemptRuntimeState({
      attempt_id: attempt.id,
      run_id: run.id,
      running: false,
      phase: "completed",
      active_since: attempt.started_at,
      last_event_at: new Date().toISOString(),
      progress_text: "执行完成",
      recent_activities: [
        "会话已建立：sess_run_detail",
        "命令：pnpm verify:runtime"
      ],
      completed_steps: ["命令：pnpm verify:runtime"],
      process_content: ["先把运行态证据返回给控制 API。"],
      final_output: "{\"summary\":\"Execution left a replayable verification plan.\"}",
      session_id: "sess_run_detail",
      event_count: 2
    })
  );
  await appendAttemptRuntimeEvent(
    workspacePaths,
    createAttemptRuntimeEvent({
      attempt_id: attempt.id,
      run_id: run.id,
      seq: 1,
      type: "thread.started",
      summary: "会话已建立：sess_run_detail",
      payload: {
        thread_id: "sess_run_detail"
      }
    })
  );
  await appendAttemptRuntimeEvent(
    workspacePaths,
    createAttemptRuntimeEvent({
      attempt_id: attempt.id,
      run_id: run.id,
      seq: 2,
      type: "response_item",
      summary: "命令：pnpm verify:runtime",
      payload: {
        type: "local_shell_call",
        status: "completed",
        command: "pnpm verify:runtime"
      }
    })
  );
  await saveAttemptHeartbeat(workspacePaths, {
    attempt_id: attempt.id,
    run_id: run.id,
    owner_id: "control-api-test",
    status: "active",
    started_at: attempt.started_at ?? new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    released_at: null
  });
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
  for (const type of [
    "attempt.created",
    "attempt.started",
    "attempt.completed",
    "attempt.verification.passed",
    "attempt.checkpoint.created"
  ]) {
    await appendRunJournal(
      workspacePaths,
      createRunJournalEntry({
        run_id: run.id,
        attempt_id: attempt.id,
        type,
        payload:
          type === "attempt.checkpoint.created"
            ? {
                artifact_path: join(
                  rootDir,
                  "runs",
                  run.id,
                  "attempts",
                  attempt.id,
                  "artifacts",
                  "git-checkpoint.json"
                ),
                commit_message: `AISA checkpoint: ${run.id} ${attempt.id}`
              }
            : {}
      })
    );
  }

  const blockerCreatedAttempt = createAttempt({
    run_id: run.id,
    attempt_type: "execution",
    worker: "fake-codex",
    objective: "Surface blocker failure context for the run detail API.",
    success_criteria: ["Return the structured blocker reason."],
    workspace_root: projectRoot
  });
  const blockerAttempt = updateAttempt(blockerCreatedAttempt, {
    status: "stopped",
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString()
  });
  const blockerCreatedEntry = createRunJournalEntry({
    run_id: run.id,
    attempt_id: blockerAttempt.id,
    type: "attempt.created",
    payload: {
      attempt_type: blockerAttempt.attempt_type,
      objective: blockerAttempt.objective
    }
  });
  const blockerStartedEntry = createRunJournalEntry({
    run_id: run.id,
    attempt_id: blockerAttempt.id,
    type: "attempt.started",
    payload: {
      attempt_type: blockerAttempt.attempt_type
    }
  });
  const blockerRecoveryEntry = createRunJournalEntry({
    run_id: run.id,
    attempt_id: blockerAttempt.id,
    type: "attempt.recovery_required",
    payload: {
      message: "Blocked on missing human steer after a recovery-required execution."
    }
  });
  const blockerFailureContext = {
    message: String(blockerRecoveryEntry.payload.message),
    journal_event_id: blockerRecoveryEntry.id,
    journal_event_ts: blockerRecoveryEntry.ts
  };

  await saveAttempt(workspacePaths, blockerAttempt);
  await saveAttemptReviewPacket(workspacePaths, {
    run_id: run.id,
    attempt_id: blockerAttempt.id,
    attempt: blockerAttempt,
    attempt_contract: null,
    current_decision_snapshot: null,
    context: null,
    journal: [],
    failure_context: blockerFailureContext,
    result: null,
    evaluation: null,
    runtime_verification: null,
    artifact_manifest: [],
    generated_at: new Date().toISOString()
  });
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: blockerAttempt.id,
      best_attempt_id: attempt.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: blockerFailureContext.message,
      blocking_reason: blockerFailureContext.message,
      waiting_for_human: true
    })
  );
  for (const entry of [blockerCreatedEntry, blockerStartedEntry, blockerRecoveryEntry]) {
    await appendRunJournal(workspacePaths, entry);
  }

  const attemptPaths = resolveAttemptPaths(workspacePaths, run.id, attempt.id);
  await Promise.all([
    writeFile(attemptPaths.stdoutFile, "stdout tail line\n", "utf8"),
    writeFile(
      attemptPaths.stderrFile,
      "stderr tail line\nverification still visible\n",
      "utf8"
    )
  ]);

  const app = await buildServer({
    workspaceRoot: rootDir,
    startOrchestrator: false,
    allowedRunWorkspaceRoots: [rootDir, projectScopeDir]
  });

  try {
    const managedExternalRoot = join(projectScopeDir, "managed-project");
    await mkdir(managedExternalRoot, { recursive: true });
    const createManagedRunResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        title: "Managed external workspace",
        description: "Ensure control-api can lock a run to an explicitly allowed workspace.",
        success_criteria: ["create the run"],
        constraints: [],
        owner_id: "test-owner",
        workspace_root: managedExternalRoot
      }
    });
    assert.equal(createManagedRunResponse.statusCode, 201);
    const managedExternalRun = createManagedRunResponse.json() as {
      run: {
        workspace_root: string;
      };
    };
    assert.equal(
      managedExternalRun.run.workspace_root,
      await realpath(managedExternalRoot)
    );

    const outsideWorkspaceDir = await mkdtemp(join(tmpdir(), "aisa-run-outside-scope-"));
    const createBlockedRunResponse = await app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        title: "Blocked workspace root",
        description: "Ensure control-api rejects workspaces outside the allowed roots.",
        success_criteria: ["reject the run"],
        constraints: [],
        owner_id: "test-owner",
        workspace_root: outsideWorkspaceDir
      }
    });
    assert.equal(createBlockedRunResponse.statusCode, 400);
    assert.match(
      createBlockedRunResponse.body,
      /工作区超出允许范围/u
    );

    const selfBootstrapResponse = await app.inject({
      method: "POST",
      url: "/runs/self-bootstrap",
      payload: {
        launch: false,
        seed_steer: false
      }
    });
    assert.equal(selfBootstrapResponse.statusCode, 201);
    const selfBootstrap = selfBootstrapResponse.json() as {
      run: {
        workspace_root: string;
      };
    };
    assert.equal(selfBootstrap.run.workspace_root, resolvedRootDir);

    const blockedRun = createRun({
      title: "Blocked launch workspace",
      description: "Ensure launch refuses a run whose workspace escaped the allowed roots.",
      success_criteria: ["launch should fail"],
      constraints: [],
      owner_id: "test-owner",
      workspace_root: outsideWorkspaceDir
    });
    await saveRun(workspacePaths, blockedRun);
    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: blockedRun.id,
        run_status: "draft",
        summary: "Blocked launch fixture"
      })
    );
    const blockedLaunchResponse = await app.inject({
      method: "POST",
      url: `/runs/${blockedRun.id}/launch`
    });
    assert.equal(blockedLaunchResponse.statusCode, 400);
    assert.match(blockedLaunchResponse.body, /工作区超出允许范围/u);

    const response = await app.inject({
      method: "GET",
      url: `/runs/${run.id}`
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json() as {
      attempts: Array<{ id: string }>;
      attempt_details: Array<{
        attempt: { id: string; input_context_ref: string | null };
        contract: { required_evidence: string[] } | null;
        context: {
          contract: { title: string };
          current_decision: { summary: string };
          previous_attempts: Array<{ id: string; status: string }>;
        } | null;
        failure_context: {
          message: string;
          journal_event_id: string | null;
          journal_event_ts: string | null;
        } | null;
        result: { summary: string; verification_plan?: { commands: Array<{ command: string }> } } | null;
        evaluation: { verification_status: string } | null;
        runtime_verification: { status: string; changed_files: string[] } | null;
        runtime_state: {
          phase: string | null;
          session_id: string | null;
          event_count: number;
          recent_activities: string[];
        } | null;
        runtime_events: Array<{ type: string; summary: string }>;
        heartbeat: { status: string } | null;
        stdout_excerpt: string;
        stderr_excerpt: string;
        journal: Array<{ type: string }>;
      }>;
    };

    const completedDetail = payload.attempt_details.find(
      (detail) => detail.attempt.id === attempt.id
    );
    const blockerDetail = payload.attempt_details.find(
      (detail) => detail.attempt.id === blockerAttempt.id
    );

    assert.equal(payload.attempts.length, 2);
    assert.equal(payload.attempt_details.length, 2);
    assert.ok(completedDetail, "completed attempt detail should be returned");
    assert.ok(blockerDetail, "blocker attempt detail should be returned");
    assert.equal(
      completedDetail?.attempt.input_context_ref,
      `runs/${run.id}/attempts/${attempt.id}/context.json`
    );
    assert.deepEqual(completedDetail?.contract?.required_evidence, [
      "git-visible workspace changes",
      "runtime replay success"
    ]);
    assert.deepEqual(completedDetail?.context, persistedContext);
    assert.equal(
      completedDetail?.failure_context,
      null,
      "completed attempt should not fabricate a failure context"
    );
    assert.equal(
      completedDetail?.result?.verification_plan?.commands[0]?.command,
      "pnpm verify:runtime"
    );
    assert.equal(completedDetail?.evaluation?.verification_status, "passed");
    assert.equal(completedDetail?.runtime_verification?.status, "passed");
    assert.equal(completedDetail?.runtime_state?.phase, "completed");
    assert.equal(completedDetail?.runtime_state?.session_id, "sess_run_detail");
    assert.equal(completedDetail?.runtime_state?.event_count, 2);
    assert.deepEqual(completedDetail?.runtime_state?.recent_activities, [
      "会话已建立：sess_run_detail",
      "命令：pnpm verify:runtime"
    ]);
    assert.equal(completedDetail?.runtime_events.length, 2);
    assert.equal(completedDetail?.runtime_events[0]?.type, "thread.started");
    assert.equal(completedDetail?.runtime_events[1]?.summary, "命令：pnpm verify:runtime");
    assert.equal(completedDetail?.heartbeat?.status, "active");
    assert.deepEqual(completedDetail?.runtime_verification?.changed_files, [
      "packages/orchestrator/src/index.ts"
    ]);
    assert.deepEqual(
      completedDetail?.journal.map((entry) => entry.type),
      [
        "attempt.created",
        "attempt.started",
        "attempt.completed",
        "attempt.verification.passed",
        "attempt.checkpoint.created"
      ]
    );
    assert.equal(completedDetail?.stdout_excerpt, "stdout tail line");
    assert.ok(completedDetail?.stderr_excerpt.includes("verification still visible"));
    assert.equal(blockerDetail?.failure_context?.message, blockerFailureContext.message);
    assert.equal(
      blockerDetail?.failure_context?.journal_event_id,
      blockerFailureContext.journal_event_id
    );
    assert.equal(
      blockerDetail?.failure_context?.journal_event_ts,
      blockerFailureContext.journal_event_ts
    );
    assert.equal(blockerDetail?.context, null);
    assert.equal(blockerDetail?.result, null);
    assert.equal(blockerDetail?.runtime_verification, null);
    assert.equal(blockerDetail?.runtime_state, null);
    assert.deepEqual(blockerDetail?.runtime_events, []);
    assert.equal(blockerDetail?.heartbeat, null);
    assert.deepEqual(
      blockerDetail?.journal.map((entry) => entry.type),
      ["attempt.created", "attempt.started", "attempt.recovery_required"]
    );

    const runsResponse = await app.inject({
      method: "GET",
      url: "/runs"
    });
    assert.equal(runsResponse.statusCode, 200);
    const runsPayload = runsResponse.json() as {
      runs: Array<{
        run: { id: string };
        latest_attempt_runtime_state: { session_id: string | null } | null;
      }>;
    };
    const runSummary = runsPayload.runs.find((item) => item.run.id === run.id);
    assert.equal(runSummary?.latest_attempt_runtime_state, null);

    console.log(
      JSON.stringify(
        {
          run_id: run.id,
          completed_attempt_id: attempt.id,
          blocker_attempt_id: blockerAttempt.id,
          detail_fields: {
            has_contract: completedDetail?.contract !== null,
            has_context: completedDetail?.context !== null,
            has_result: completedDetail?.result !== null,
            has_evaluation: completedDetail?.evaluation !== null,
            has_runtime_verification:
              completedDetail?.runtime_verification !== null,
            completed_has_failure_context: completedDetail?.failure_context !== null,
            blocker_has_failure_context: blockerDetail?.failure_context !== null
          },
          input_context_ref: completedDetail?.attempt.input_context_ref,
          context_contract_title: completedDetail?.context?.contract.title,
          blocker_failure_message: blockerDetail?.failure_context?.message ?? null
        },
        null,
        2
      )
    );
  } finally {
    await app.close();
  }

  const idleRootDir = await mkdtemp(join(tmpdir(), "aisa-run-detail-api-idle-"));
  const idleWorkspacePaths = resolveWorkspacePaths(idleRootDir);
  await ensureWorkspace(idleWorkspacePaths);
  const idleRun = createRun({
    title: "Control API listen gate verification",
    description: "Ensure orchestrator stays idle until the HTTP server is actually listening.",
    success_criteria: ["Do not dispatch attempts before listen succeeds."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: idleRootDir
  });
  await saveRun(idleWorkspacePaths, idleRun);
  await saveCurrentDecision(
    idleWorkspacePaths,
    createCurrentDecision({
      run_id: idleRun.id,
      run_status: "running",
      recommended_next_action: "start_first_attempt",
      recommended_attempt_type: "research",
      summary: "Prepared to verify the listen gate."
    })
  );

  const idleApp = await buildServer({
    workspaceRoot: idleRootDir
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const idleAttempts = await listAttempts(idleWorkspacePaths, idleRun.id);
    assert.equal(
      idleAttempts.length,
      0,
      "orchestrator should stay idle until app.listen succeeds"
    );
  } finally {
    await idleApp.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
