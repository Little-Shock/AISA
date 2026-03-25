import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAttempt,
  createCurrentDecision,
  createRun,
  createRunJournalEntry,
  updateAttempt
} from "../packages/domain/src/index.ts";
import {
  appendRunJournal,
  ensureWorkspace,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptEvaluation,
  saveAttemptResult,
  saveAttemptRuntimeVerification,
  saveCurrentDecision,
  saveRun
} from "../packages/state-store/src/index.ts";
import { buildServer } from "../apps/control-api/src/index.ts";

async function main(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-run-detail-api-"));
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);

  const run = createRun({
    title: "Run detail API verification",
    description: "Ensure run detail exposes attempt evidence for self-bootstrap debugging.",
    success_criteria: ["Expose attempt result, evaluation, and runtime verification."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: rootDir
  });
  const current = createCurrentDecision({
    run_id: run.id,
    run_status: "completed",
    latest_attempt_id: null,
    recommended_next_action: null,
    recommended_attempt_type: null,
    summary: "Run completed with persisted execution evidence."
  });
  const attempt = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Make a small backend change and verify it.",
      success_criteria: run.success_criteria,
      workspace_root: rootDir
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

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

  const app = await buildServer({
    workspaceRoot: rootDir,
    startOrchestrator: false
  });

  try {
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
    assert.equal(selfBootstrap.run.workspace_root, rootDir);

    const response = await app.inject({
      method: "GET",
      url: `/runs/${run.id}`
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json() as {
      attempts: Array<{ id: string }>;
      attempt_details: Array<{
        attempt: { id: string };
        result: { summary: string; verification_plan?: { commands: Array<{ command: string }> } } | null;
        evaluation: { verification_status: string } | null;
        runtime_verification: { status: string; changed_files: string[] } | null;
        journal: Array<{ type: string }>;
      }>;
    };

    assert.equal(payload.attempts.length, 1);
    assert.equal(payload.attempt_details.length, 1);
    assert.equal(payload.attempt_details[0]?.attempt.id, attempt.id);
    assert.equal(
      payload.attempt_details[0]?.result?.verification_plan?.commands[0]?.command,
      "pnpm verify:runtime"
    );
    assert.equal(payload.attempt_details[0]?.evaluation?.verification_status, "passed");
    assert.equal(payload.attempt_details[0]?.runtime_verification?.status, "passed");
    assert.deepEqual(payload.attempt_details[0]?.runtime_verification?.changed_files, [
      "packages/orchestrator/src/index.ts"
    ]);
    assert.deepEqual(
      payload.attempt_details[0]?.journal.map((entry) => entry.type),
      [
        "attempt.created",
        "attempt.started",
        "attempt.completed",
        "attempt.verification.passed",
        "attempt.checkpoint.created"
      ]
    );

    console.log(
      JSON.stringify(
        {
          run_id: run.id,
          attempt_id: attempt.id,
          detail_fields: {
            has_result: payload.attempt_details[0]?.result !== null,
            has_evaluation: payload.attempt_details[0]?.evaluation !== null,
            has_runtime_verification:
              payload.attempt_details[0]?.runtime_verification !== null
          }
        },
        null,
        2
      )
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
