import assert from "node:assert/strict";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAttempt,
  createAttemptAdversarialVerification,
  createAttemptContract,
  createAttemptHandoffBundle,
  createAttemptPreflightEvaluation,
  createRunAutomationControl,
  createCurrentDecision,
  createAttemptRuntimeEvent,
  createAttemptRuntimeState,
  createRun,
  createRunJournalEntry,
  createRunPolicyRuntime,
  updateAttempt
} from "../packages/domain/src/index.ts";
import {
  appendRunJournal,
  appendAttemptRuntimeEvent,
  ensureWorkspace,
  getCurrentDecision,
  getRunAutomationControl,
  getRunPolicyRuntime,
  listAttempts,
  resolveRunPaths,
  resolveAttemptPaths,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptContract,
  saveAttemptContext,
  saveAttemptAdversarialVerification,
  saveAttemptEvaluation,
  saveAttemptHeartbeat,
  saveAttemptHandoffBundle,
  saveAttemptPreflightEvaluation,
  saveAttemptReviewPacket,
  saveAttemptResult,
  saveAttemptRuntimeState,
  saveAttemptRuntimeVerification,
  saveCurrentDecision,
  saveRun,
  saveRunAutomationControl,
  saveRunPolicyRuntime,
  getRunRuntimeHealthSnapshot
} from "../packages/state-store/src/index.ts";
import { buildServer } from "../apps/control-api/src/index.ts";
import {
  createRunWorkspaceScopePolicy,
  Orchestrator,
  refreshRunOperatorSurface,
  SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH,
  SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME
} from "../packages/orchestrator/src/index.ts";
import { CODEX_CLI_EXECUTION_EFFORT_APPLIED_DETAIL } from "../packages/worker-adapters/src/index.ts";
import {
  cleanupTrackedVerifyTempDirs,
  createTrackedVerifyTempDir
} from "./verify-temp.ts";

type HarnessSlotPayload = {
  slot: string;
  title: string;
  binding: string;
  expected_binding: string;
  binding_status: string;
  binding_matches_registry: boolean;
  source: string;
  detail: string;
  input_contract: string[];
  permission_boundary: string;
  output_artifacts: string[];
  failure_semantics: string;
};

type HarnessSlotsPayload = {
  research_or_planning: HarnessSlotPayload;
  execution: HarnessSlotPayload & {
    default_verifier_kit: string;
  };
  preflight_review: HarnessSlotPayload;
  postflight_review: HarnessSlotPayload;
  final_synthesis: HarnessSlotPayload;
};

type HarnessGatePayload = {
  gate: string;
  title: string;
  mode: string;
  default_mode: string;
  phase: string;
  enforced: boolean;
  source: string;
  detail: string;
  artifact_ref: string;
};

type HarnessGatesPayload = {
  preflight_review: HarnessGatePayload;
  deterministic_runtime: HarnessGatePayload;
  postflight_adversarial: HarnessGatePayload;
};

type VerifierKitProfilePayload = {
  kit: string;
  title: string;
  detail: string;
  command_policy: string;
  preflight_expectations: string[];
  runtime_expectations: string[];
  adversarial_focus: string[];
  source: string;
};

type WorkingContextSourceSnapshotEntryPayload = {
  ref: string | null;
  updated_at: string | null;
};

type WorkingContextSourceSnapshotPayload = {
  current: WorkingContextSourceSnapshotEntryPayload;
  automation: WorkingContextSourceSnapshotEntryPayload;
  governance: WorkingContextSourceSnapshotEntryPayload;
  latest_attempt: WorkingContextSourceSnapshotEntryPayload & {
    attempt_id: string | null;
  };
  latest_steer: WorkingContextSourceSnapshotEntryPayload & {
    steer_id: string | null;
  };
};

type RunBriefDegradedPayload = {
  is_degraded: boolean;
  reason_code: string | null;
  summary: string | null;
  source_ref: string | null;
};

type EffectivePolicyBundlePayload = {
  profile_version: number;
  verification_discipline: {
    level: string;
    default_verifier_kit: string;
    command_policy: string;
    summary: string;
    source_refs: string[];
  };
  operator_brief: {
    intensity: string;
    evidence_ref_budget: number;
    summary_style: string;
    source: string;
    detail: string;
  };
  maintenance_refresh: {
    strategy: string;
    refreshes_on_read: boolean;
    source: string;
    detail: string;
  };
  recovery: {
    active_run: string;
    settled_run: string;
    auto_resume_from_settled_handoff: boolean;
    source: string;
    detail: string;
  };
};

async function main(): Promise<void> {
  try {
  const rootDir = await createTrackedVerifyTempDir("aisa-run-detail-api-");
  const projectScopeDir = await createTrackedVerifyTempDir("aisa-run-scope-");
  const projectRoot = join(projectScopeDir, "project-a");
  const selfBootstrapSourceAssetPath = join(
    rootDir,
    "Codex",
    "fixture-self-bootstrap-next-task.json"
  );
  const selfBootstrapActiveEntryPath = join(
    rootDir,
    SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH
  );
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(rootDir, "Codex"), { recursive: true });
  const resolvedRootDir = await realpath(rootDir);
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);
  await Promise.all([
    writeFile(
      selfBootstrapSourceAssetPath,
      `${JSON.stringify(
        {
          recommended_next_attempt: {
            attempt_type: "execution",
            objective: "Fixture self-bootstrap execution contract.",
            success_criteria: ["Persist a runnable self-bootstrap execution contract."],
            required_evidence: ["Leave replayable validation evidence."],
            expected_artifacts: ["scripts/verify-run-detail-api.ts"],
            verification_plan: {
              commands: [
                {
                  purpose: "prove fixture self-bootstrap contract is replayable",
                  command: "pnpm verify:run-api"
                }
              ]
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    ),
    writeFile(
      selfBootstrapActiveEntryPath,
      `${JSON.stringify(
        {
          entry_type: "self_bootstrap_next_runtime_task_active",
          updated_at: "2026-04-01T00:00:00.000Z",
          source_anchor: {
            asset_path: "Codex/fixture-self-bootstrap-next-task.json",
            source_attempt_id: "fixture_attempt",
            payload_sha256: "fixture_payload_sha256",
            promoted_at: "2026-04-01T00:00:00.000Z"
          },
          title: "Fixture self-bootstrap next task",
          summary: "Keep the run detail API fixture aligned with real self-bootstrap semantics."
        },
        null,
        2
      )}\n`,
      "utf8"
    )
  ]);

  const run = createRun({
    title: "Run detail API verification",
    description: "Ensure run detail exposes attempt evidence for self-bootstrap debugging.",
    success_criteria: ["Expose attempt result, evaluation, and runtime verification."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: projectRoot,
    harness_profile: {
      execution: {
        effort: "high",
        default_verifier_kit: "api"
      },
      reviewer: {
        effort: "low"
      }
    }
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
  await saveRunPolicyRuntime(
    workspacePaths,
    createRunPolicyRuntime({
      run_id: run.id,
      stage: "execution",
      approval_status: "approved",
      approval_required: true,
      proposed_signature: "verify-run-detail-policy",
      proposed_attempt_type: "execution",
      proposed_objective: attempt.objective,
      proposed_success_criteria: attempt.success_criteria,
      permission_profile: "workspace_write",
      hook_policy: "enforce_runtime_contract",
      last_decision: "dispatch_ready",
      approval_actor: "verify-run-detail-api",
      source_attempt_id: attempt.id
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: attempt.id,
      type: "run.policy.hook_evaluated",
      payload: {
        proposed_signature: "verify-run-detail-policy",
        attempt_type: "execution",
        objective: attempt.objective,
        verifier_kit: "api",
        verification_commands: ["pnpm verify:runtime"],
        permission_profile: "workspace_write",
        hook_policy: "enforce_runtime_contract",
        danger_mode: "forbid",
        hook_key: "dangerous_verification_commands",
        hook_status: "passed",
        message: "Replay commands passed the destructive command guard.",
        source_ref: `runs/${run.id}/attempts/${attempt.id}/result.json`
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: attempt.id,
      type: "run.policy.approved",
      payload: {
        actor: "verify-run-detail-api",
        note: "Approved after replay-safe contract review.",
        proposed_signature: "verify-run-detail-policy",
        permission_profile: "workspace_write",
        hook_policy: "enforce_runtime_contract",
        danger_mode: "forbid",
        source_ref: `runs/${run.id}/attempts/${attempt.id}/result.json`
      }
    })
  );
  await saveAttempt(workspacePaths, attempt);
  const attemptContract = createAttemptContract({
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: "execution",
    objective: attempt.objective,
    success_criteria: attempt.success_criteria,
    verifier_kit: "api",
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
  });
  await saveAttemptContract(workspacePaths, attemptContract);
  const persistedContext = {
    contract: {
      title: "Run detail API verification"
    },
    current_decision: {
      summary: "Run completed with persisted execution evidence."
    },
    worker_effort: {
      execution: {
        requested_effort: "high",
        default_effort: "medium",
        source: "run.harness_profile.execution.effort",
        status: "applied",
        applied: true,
        detail: CODEX_CLI_EXECUTION_EFFORT_APPLIED_DETAIL
      },
      reviewer: {
        requested_effort: "low",
        default_effort: "medium",
        source: "run.harness_profile.reviewer.effort",
        status: "unsupported",
        applied: false,
        detail: "当前 reviewer 入口不是独立 CLI 模型调用，effort 只会保留为配置记录。"
      },
      synthesizer: {
        requested_effort: "medium",
        default_effort: "medium",
        source: "run.harness_profile.synthesizer.effort",
        status: "unsupported",
        applied: false,
        detail: "当前 synthesizer 入口不是独立 CLI 模型调用，effort 只会保留为配置记录。"
      }
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
    adversarial_verification_status: "passed",
    recommendation: "complete",
    suggested_attempt_type: null,
    rationale: "runtime replay passed",
    missing_evidence: [],
    created_at: new Date().toISOString()
  });
  const runtimeVerification = {
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: "execution",
    status: "passed",
    verifier_kit: "api",
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
  };
  await saveAttemptRuntimeVerification(workspacePaths, runtimeVerification);
  const adversarialOutputFile = join(
    rootDir,
    "artifacts",
    "adversarial",
    `${attempt.id}.txt`
  );
  await mkdir(join(rootDir, "artifacts", "adversarial"), { recursive: true });
  await writeFile(adversarialOutputFile, "adversarial probe passed\n", "utf8");
  const adversarialVerification = createAttemptAdversarialVerification({
    run_id: run.id,
    attempt_id: attempt.id,
    attempt_type: "execution",
    status: "passed",
    verifier_kit: "api",
    verdict: "pass",
    summary: "Adversarial verification passed after deterministic replay.",
    checks: [
      {
        code: "non_happy_path",
        status: "passed",
        message: "Probe stayed green on a non-happy path."
      }
    ],
    commands: [
      {
        purpose: "probe the persisted runtime patch",
        command: "pnpm verify:run-api",
        cwd: rootDir,
        exit_code: 0,
        status: "passed",
        output_ref: adversarialOutputFile
      }
    ],
    output_refs: [adversarialOutputFile],
    source_artifact_path: join(rootDir, "artifacts", "adversarial-verification.json")
  });
  await saveAttemptAdversarialVerification(workspacePaths, adversarialVerification);
  await saveAttemptPreflightEvaluation(
    workspacePaths,
    createAttemptPreflightEvaluation({
      run_id: run.id,
      attempt_id: attempt.id,
      attempt_type: "execution",
      status: "passed",
      contract: {
        has_required_evidence: true,
        requires_adversarial_verification: true,
        verifier_kit: "api",
        has_done_rubric: true,
        has_failure_modes: true,
        has_verification_plan: true,
        done_rubric_codes: attemptContract.done_rubric.map((item) => item.code),
        failure_mode_codes: attemptContract.failure_modes.map((item) => item.code),
        verification_commands:
          attemptContract.verification_plan?.commands.map((item) => item.command) ?? []
      },
      toolchain_assessment: {
        verifier_kit: "api",
        command_policy: "contract_locked_commands",
        has_package_json: true,
        has_local_node_modules: true,
        inferred_pnpm_commands: [],
        blocked_pnpm_commands: [],
        unrunnable_verification_commands: []
      },
      checks: [
        {
          code: "verifier_kit_policy_loaded",
          status: "passed",
          message:
            "API Task uses contract_locked_commands, so preflight requires explicit replay commands instead of auto-inferring workspace scripts."
        },
        {
          code: "verification_plan",
          status: "passed",
          message: "Contract kept replayable verification commands."
        }
      ]
    })
  );
  const handoffCurrentDecisionSnapshot = createCurrentDecision({
    run_id: current.run_id,
    run_status: current.run_status,
    best_attempt_id: attempt.id,
    latest_attempt_id: attempt.id,
    recommended_next_action: current.recommended_next_action,
    recommended_attempt_type: current.recommended_attempt_type,
    summary: "Execution left a replayable verification plan."
  });
  await saveAttemptHandoffBundle(
    workspacePaths,
    createAttemptHandoffBundle({
      attempt,
      approved_attempt_contract: attemptContract,
      current_decision_snapshot: handoffCurrentDecisionSnapshot,
      failure_context: null,
      runtime_verification: runtimeVerification,
      adversarial_verification: adversarialVerification,
      source_refs: {
        run_contract: `runs/${run.id}/contract.json`,
        attempt_meta: `runs/${run.id}/attempts/${attempt.id}/meta.json`,
        attempt_contract: `runs/${run.id}/attempts/${attempt.id}/attempt_contract.json`,
        preflight_evaluation: `runs/${run.id}/attempts/${attempt.id}/artifacts/preflight-evaluation.json`,
        current_decision: `runs/${run.id}/current.json`,
        review_packet: null,
        runtime_verification: `runs/${run.id}/attempts/${attempt.id}/artifacts/runtime-verification.json`,
        adversarial_verification: `runs/${run.id}/attempts/${attempt.id}/artifacts/adversarial-verification.json`
      }
    })
  );
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
    objective: "Surface preflight-blocked failure context for the run detail API.",
    success_criteria: ["Return the structured preflight blocker reason."],
    workspace_root: projectRoot
  });
  const blockerAttemptContract = createAttemptContract({
    attempt_id: blockerCreatedAttempt.id,
    run_id: run.id,
    attempt_type: "execution",
    objective: blockerCreatedAttempt.objective,
    success_criteria: blockerCreatedAttempt.success_criteria,
    required_evidence: [
      "git-visible workspace changes",
      "replayable verification output"
    ],
    adversarial_verification_required: true,
    verification_plan: {
      commands: [
        {
          purpose: "typecheck the workspace after the change",
          command: "pnpm typecheck"
        },
        {
          purpose: "replay the runtime regression suite after the change",
          command: "pnpm verify:runtime"
        }
      ]
    }
  });
  const blockerAttempt = updateAttempt(blockerCreatedAttempt, {
    status: "failed",
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
  const blockerPreflightFailureReason =
    "Execution attempt is blocked before dispatch because attempt_contract.json asks runtime to replay pnpm typecheck, pnpm verify:runtime, but the workspace has no local node_modules.";
  const blockerPreflight = createAttemptPreflightEvaluation({
    run_id: run.id,
    attempt_id: blockerAttempt.id,
    attempt_type: "execution",
    status: "failed",
    failure_code: "blocked_pnpm_verification_plan",
    failure_reason: blockerPreflightFailureReason
  });
  const blockerPreflightEntry = createRunJournalEntry({
    run_id: run.id,
    attempt_id: blockerAttempt.id,
    type: "attempt.preflight.failed",
    payload: {
      status: "failed",
      failure_code: blockerPreflight.failure_code,
      failure_reason: blockerPreflightFailureReason,
      artifact_path: "artifacts/preflight-evaluation.json"
    }
  });
  const blockerFailedEntry = createRunJournalEntry({
    run_id: run.id,
    attempt_id: blockerAttempt.id,
    type: "attempt.failed",
    payload: {
      message: blockerPreflightFailureReason
    }
  });
  const blockerFailureContext = {
    message: blockerPreflightFailureReason,
    journal_event_id: blockerPreflightEntry.id,
    journal_event_ts: blockerPreflightEntry.ts
  };
  const settledHandoffRecoveryBlockedMessage =
    "Low reviewer effort keeps settled handoff recovery in manual recovery mode, so automatic resume stays blocked.";

  await saveAttempt(workspacePaths, blockerAttempt);
  await saveAttemptContract(workspacePaths, blockerAttemptContract);
  await saveAttemptPreflightEvaluation(workspacePaths, blockerPreflight);
  await saveAttemptReviewPacket(workspacePaths, {
    run_id: run.id,
    attempt_id: blockerAttempt.id,
    attempt: blockerAttempt,
    attempt_contract: blockerAttemptContract,
    current_decision_snapshot: null,
    context: null,
    journal: [],
    failure_context: blockerFailureContext,
    result: null,
    evaluation: null,
    runtime_verification: null,
    adversarial_verification: null,
    artifact_manifest: [],
    generated_at: new Date().toISOString()
  });
  await saveAttemptHandoffBundle(
    workspacePaths,
    createAttemptHandoffBundle({
      attempt: blockerAttempt,
      approved_attempt_contract: blockerAttemptContract,
      preflight_evaluation: blockerPreflight,
      current_decision_snapshot: createCurrentDecision({
        run_id: run.id,
        run_status: "waiting_steer",
        latest_attempt_id: blockerAttempt.id,
        best_attempt_id: attempt.id,
        recommended_next_action: "wait_for_human",
        recommended_attempt_type: "execution",
        summary: blockerPreflightFailureReason,
        blocking_reason: blockerPreflightFailureReason,
        waiting_for_human: true
      }),
      failure_context: blockerFailureContext,
      source_refs: {
        run_contract: `runs/${run.id}/contract.json`,
        attempt_meta: `runs/${run.id}/attempts/${blockerAttempt.id}/meta.json`,
        attempt_contract: `runs/${run.id}/attempts/${blockerAttempt.id}/attempt_contract.json`,
        preflight_evaluation: `runs/${run.id}/attempts/${blockerAttempt.id}/artifacts/preflight-evaluation.json`,
        current_decision: `runs/${run.id}/current.json`,
        review_packet: `runs/${run.id}/attempts/${blockerAttempt.id}/review_packet.json`,
        runtime_verification: null,
        adversarial_verification: null
      }
    })
  );
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
  for (const entry of [blockerCreatedEntry, blockerPreflightEntry, blockerFailedEntry]) {
    await appendRunJournal(workspacePaths, entry);
  }
  await refreshRunOperatorSurface(workspacePaths, run.id);

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

    const outsideWorkspaceDir = await createTrackedVerifyTempDir(
      "aisa-run-outside-scope-"
    );
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
        id: string;
        workspace_root: string;
        harness_profile: {
          execution: {
            effort: string;
            default_verifier_kit: string;
          };
          reviewer: {
            effort: string;
          };
          synthesizer: {
            effort: string;
          };
          gates: {
            preflight_review: { mode: string };
            deterministic_runtime: { mode: string };
            postflight_adversarial: { mode: string };
          };
          version: number;
        };
      };
      active_next_task: string;
      active_next_task_snapshot: string;
      runtime_health_snapshot: string;
    };
    assert.equal(selfBootstrap.run.workspace_root, resolvedRootDir);
    assert.equal(selfBootstrap.run.harness_profile.version, 3);
    assert.equal(selfBootstrap.run.harness_profile.execution.effort, "high");
    assert.equal(
      selfBootstrap.run.harness_profile.execution.default_verifier_kit,
      "repo"
    );
    assert.equal(selfBootstrap.run.harness_profile.reviewer.effort, "medium");
    assert.equal(selfBootstrap.run.harness_profile.synthesizer.effort, "medium");
    assert.equal(selfBootstrap.run.harness_profile.gates.preflight_review.mode, "required");
    assert.equal(
      selfBootstrap.run.harness_profile.gates.deterministic_runtime.mode,
      "required"
    );
    assert.equal(
      selfBootstrap.run.harness_profile.gates.postflight_adversarial.mode,
      "required"
    );
    assert.equal(
      selfBootstrap.active_next_task,
      SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH
    );
    assert.ok(
      selfBootstrap.active_next_task_snapshot.endsWith(
        SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME
      )
    );
    assert.ok(
      selfBootstrap.runtime_health_snapshot.endsWith("runtime-health-snapshot.json")
    );
    const selfBootstrapRuntimeHealthSnapshot = await getRunRuntimeHealthSnapshot(
      workspacePaths,
      selfBootstrap.run.id
    );
    assert.ok(
      selfBootstrapRuntimeHealthSnapshot,
      "self-bootstrap route should persist a runtime health snapshot"
    );

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

    const resumableRun = createRun({
      title: "Resumable waiting run",
      description: "Ensure launch turns a waiting run back into an actionable run.",
      success_criteria: ["resume should create a new execution attempt"],
      constraints: [],
      owner_id: "test-owner",
      workspace_root: projectRoot
    });
    const failedResumableAttempt = updateAttempt(
      createAttempt({
        run_id: resumableRun.id,
        attempt_type: "execution",
        worker: "fake-codex",
        objective: "Retry the latest execution with the same contract.",
        success_criteria: resumableRun.success_criteria,
        workspace_root: projectRoot
      }),
      {
        status: "failed",
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString()
      }
    );
    await saveRun(workspacePaths, resumableRun);
    await saveAttempt(workspacePaths, failedResumableAttempt);
    await saveAttemptContract(
      workspacePaths,
      createAttemptContract({
        attempt_id: failedResumableAttempt.id,
        run_id: resumableRun.id,
        attempt_type: "execution",
        objective: failedResumableAttempt.objective,
        success_criteria: failedResumableAttempt.success_criteria,
        required_evidence: ["leave git-visible changes", "replay runtime verification"],
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
    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: resumableRun.id,
        run_status: "waiting_steer",
        latest_attempt_id: failedResumableAttempt.id,
        recommended_next_action: "wait_for_human",
        recommended_attempt_type: "execution",
        summary: "Paused after the last execution failed.",
        blocking_reason: "Need to retry the latest execution contract.",
        waiting_for_human: true
      })
    );
    await saveRunAutomationControl(
      workspacePaths,
      createRunAutomationControl({
        run_id: resumableRun.id,
        mode: "manual_only",
        reason_code: "manual_recovery",
        reason: "Operator must explicitly relaunch after reviewing the failed execution.",
        imposed_by: "control-api"
      })
    );
    const resumeResponse = await app.inject({
      method: "POST",
      url: `/runs/${resumableRun.id}/launch`
    });
    assert.equal(resumeResponse.statusCode, 200);
    const resumePayload = resumeResponse.json() as {
      current: {
        run_status: string;
        waiting_for_human: boolean;
        recommended_next_action: string | null;
        recommended_attempt_type: string | null;
      };
    };
    assert.equal(resumePayload.current.run_status, "running");
    assert.equal(resumePayload.current.waiting_for_human, false);
    assert.equal(
      resumePayload.current.recommended_next_action,
      "retry_attempt",
      "launch should turn wait_for_human into an actionable retry"
    );
    assert.equal(resumePayload.current.recommended_attempt_type, "execution");
    const resumeAutomation = await getRunAutomationControl(workspacePaths, resumableRun.id);
    assert.equal(
      resumeAutomation?.mode,
      "active",
      "manual launch should clear manual-only automation gates"
    );

    const launchRunWorkspaceScopePolicy = await createRunWorkspaceScopePolicy({
      runtimeRoot: rootDir,
      allowedRoots: [rootDir, projectScopeDir]
    });
    const launchOrchestrator = new Orchestrator(
      workspacePaths,
      {
        type: "fake-codex",
        async runAttemptTask() {
          throw new Error("launch resume verification should not dispatch worker execution");
        }
      } as never,
      undefined,
      60_000,
      {
        runWorkspaceScopePolicy: launchRunWorkspaceScopePolicy
      }
    );
    await launchOrchestrator.tick();
    const resumedAttempts = await listAttempts(workspacePaths, resumableRun.id);
    assert.equal(resumedAttempts.length, 1);
    const resumedCurrent = await getCurrentDecision(workspacePaths, resumableRun.id);
    assert.equal(resumedCurrent?.run_status, "waiting_steer");
    assert.equal(resumedCurrent?.waiting_for_human, true);
    const resumedPolicy = await getRunPolicyRuntime(workspacePaths, resumableRun.id);
    assert.equal(resumedPolicy?.stage, "approval");
    assert.equal(resumedPolicy?.approval_status, "pending");
    assert.equal(resumedPolicy?.proposed_attempt_type, "execution");

    const invalidPolicyRun = createRun({
      title: "Invalid policy surface verification",
      description: "Ensure unreadable policy runtime is surfaced instead of silently swallowed.",
      success_criteria: ["Expose the invalid policy state in run detail and summary."],
      constraints: [],
      owner_id: "test-owner",
      workspace_root: projectRoot
    });
    await saveRun(workspacePaths, invalidPolicyRun);
    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: invalidPolicyRun.id,
        run_status: "waiting_steer",
        summary: "Invalid policy should be surfaced."
      })
    );
    await writeFile(resolveRunPaths(workspacePaths, invalidPolicyRun.id).policyFile, "{\n", "utf8");
    await refreshRunOperatorSurface(workspacePaths, invalidPolicyRun.id);
    const invalidPolicyResponse = await app.inject({
      method: "GET",
      url: `/runs/${invalidPolicyRun.id}`
    });
    assert.equal(invalidPolicyResponse.statusCode, 200);
    const invalidPolicyPayload = invalidPolicyResponse.json() as {
      policy_runtime: null;
      policy_runtime_ref: string | null;
      policy_runtime_invalid_reason: string | null;
      maintenance_plane: {
        outputs: Array<{
          key: string;
          status: string;
          summary: string | null;
        }>;
        signal_sources: Array<{
          key: string;
          summary: string | null;
        }>;
      } | null;
    };
    assert.equal(invalidPolicyPayload.policy_runtime, null);
    assert.ok(invalidPolicyPayload.policy_runtime_ref?.endsWith("policy-runtime.json"));
    assert.match(invalidPolicyPayload.policy_runtime_invalid_reason ?? "", /policy|json|parse/i);
    assert.ok(
      invalidPolicyPayload.maintenance_plane?.outputs.some(
        (item) => item.key === "policy_runtime" && item.status === "degraded"
      )
    );
    assert.ok(
      invalidPolicyPayload.maintenance_plane?.signal_sources.some(
        (item) =>
          item.key === "policy_runtime" &&
          (item.summary ?? "").includes(
            invalidPolicyPayload.policy_runtime_invalid_reason ?? ""
          )
      )
    );
    const invalidSummaryResponse = await app.inject({
      method: "GET",
      url: "/runs"
    });
    assert.equal(invalidSummaryResponse.statusCode, 200);
    const invalidSummaryPayload = invalidSummaryResponse.json() as {
      runs: Array<{
        run: { id: string };
        policy_runtime_invalid_reason: string | null;
      }>;
    };
    const invalidRunSummary =
      invalidSummaryPayload.runs.find((item) => item.run.id === invalidPolicyRun.id) ?? null;
    assert.match(invalidRunSummary?.policy_runtime_invalid_reason ?? "", /policy|json|parse/i);

    const invalidRunBriefRun = createRun({
      title: "Invalid run brief surface verification",
      description: "Ensure unreadable run brief is surfaced instead of silently disappearing.",
      success_criteria: ["Expose the invalid run brief state in run detail and summary."],
      constraints: [],
      owner_id: "test-owner",
      workspace_root: projectRoot
    });
    await saveRun(workspacePaths, invalidRunBriefRun);
    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: invalidRunBriefRun.id,
        run_status: "waiting_steer",
        summary: "Invalid run brief should be surfaced.",
        blocking_reason: "Corrupted run brief should stay visible to the operator.",
        waiting_for_human: true
      })
    );
    await refreshRunOperatorSurface(workspacePaths, invalidRunBriefRun.id);
    await writeFile(
      resolveRunPaths(workspacePaths, invalidRunBriefRun.id).runBriefFile,
      "{\n",
      "utf8"
    );

    const writeFailedRunBriefRun = createRun({
      title: "Write failed run brief verification",
      description:
        "Ensure run brief refresh failures become a visible degraded control-plane surface.",
      success_criteria: ["Surface run.run_brief.refresh_failed in run detail and summary."],
      constraints: [],
      owner_id: "test-owner",
      workspace_root: projectRoot
    });
    await saveRun(workspacePaths, writeFailedRunBriefRun);
    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: writeFailedRunBriefRun.id,
        run_status: "waiting_steer",
        summary: "Broken run brief path should surface an explicit degraded state.",
        blocking_reason: "run brief path is broken and should not be hidden.",
        waiting_for_human: true
      })
    );
    const writeFailedRunBriefPaths = resolveRunPaths(workspacePaths, writeFailedRunBriefRun.id);
    await rm(writeFailedRunBriefPaths.runBriefFile, { force: true });
    await mkdir(writeFailedRunBriefPaths.runBriefFile, { recursive: true });
    await refreshRunOperatorSurface(workspacePaths, writeFailedRunBriefRun.id);

    const staleRun = createRun({
      title: "Stale run health verification",
      description: "Ensure control-api exposes zombie running attempts clearly.",
      success_criteria: ["Mark stale running attempts as degraded."],
      constraints: [],
      owner_id: "test-owner",
      workspace_root: projectRoot
    });
    const staleAttemptStartedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const staleAttempt = updateAttempt(
      createAttempt({
        run_id: staleRun.id,
        attempt_type: "research",
        worker: "fake-codex",
        objective: "Stay stale long enough to test health exposure.",
        success_criteria: staleRun.success_criteria,
        workspace_root: projectRoot
      }),
      {
        status: "running",
        started_at: staleAttemptStartedAt
      }
    );
    await saveRun(workspacePaths, staleRun);
    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: staleRun.id,
        run_status: "running",
        latest_attempt_id: staleAttempt.id,
        recommended_next_action: "attempt_running",
        recommended_attempt_type: "research",
        summary: "This run is intentionally left stale for health verification."
      })
    );
    await saveAttempt(workspacePaths, staleAttempt);
    await saveAttemptRuntimeState(
      workspacePaths,
      createAttemptRuntimeState({
        attempt_id: staleAttempt.id,
        run_id: staleRun.id,
        running: true,
        phase: "tool",
        active_since: staleAttemptStartedAt,
        last_event_at: staleAttemptStartedAt,
        progress_text: "stale",
        event_count: 1
      })
    );
    await saveAttemptHeartbeat(workspacePaths, {
      attempt_id: staleAttempt.id,
      run_id: staleRun.id,
      owner_id: "control-api-test",
      status: "active",
      started_at: staleAttemptStartedAt,
      heartbeat_at: staleAttemptStartedAt,
      released_at: null
    });

    const staleWorkingContextRun = createRun({
      title: "Stale working context verification",
      description: "Ensure control-api marks lagging working context explicitly.",
      success_criteria: ["Expose working_context_degraded when current outruns the snapshot."],
      constraints: [],
      owner_id: "test-owner",
      workspace_root: projectRoot
    });
    await saveRun(workspacePaths, staleWorkingContextRun);
    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: staleWorkingContextRun.id,
        run_status: "waiting_steer",
        recommended_next_action: "wait_for_human",
        summary: "Initial working context snapshot.",
        blocking_reason: "Initial working context snapshot.",
        waiting_for_human: true
      })
    );
    await refreshRunOperatorSurface(workspacePaths, staleWorkingContextRun.id);
    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: staleWorkingContextRun.id,
        run_status: "waiting_steer",
        recommended_next_action: "wait_for_human",
        summary: "Current decision moved after working context snapshot.",
        blocking_reason: "Current decision moved after working context snapshot.",
        waiting_for_human: true
      })
    );

    const writeFailedWorkingContextRun = createRun({
      title: "Write failed working context verification",
      description: "Ensure control-api marks failed working context writes explicitly.",
      success_criteria: ["Expose context_write_failed when working context refresh cannot persist."],
      constraints: [],
      owner_id: "test-owner",
      workspace_root: projectRoot
    });
    await saveRun(workspacePaths, writeFailedWorkingContextRun);
    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: writeFailedWorkingContextRun.id,
        run_status: "running",
        summary: "Write a healthy working context snapshot first."
      })
    );
    await refreshRunOperatorSurface(workspacePaths, writeFailedWorkingContextRun.id);
    const brokenWorkingContextPath = resolveRunPaths(
      workspacePaths,
      writeFailedWorkingContextRun.id
    ).workingContextFile;
    await rm(brokenWorkingContextPath, { force: true });
    await mkdir(brokenWorkingContextPath, { recursive: true });
    await saveCurrentDecision(
      workspacePaths,
      createCurrentDecision({
        run_id: writeFailedWorkingContextRun.id,
        run_status: "waiting_steer",
        recommended_next_action: "wait_for_human",
        summary: "Broken working context path should surface an explicit degraded state.",
        blocking_reason: "Broken working context path should surface an explicit degraded state.",
        waiting_for_human: true
      })
    );
    await refreshRunOperatorSurface(workspacePaths, writeFailedWorkingContextRun.id);

    const missingRunBriefRun = createRun({
      title: "Missing run brief fallback verification",
      description: "Failure signal should survive even when run-brief.json disappears.",
      success_criteria: ["Surface the blocker without depending on run-brief.json."],
      constraints: [],
      owner_id: "test-owner",
      workspace_root: rootDir
    });
    const missingRunBriefAttempt = createAttempt({
      run_id: missingRunBriefRun.id,
      attempt_type: "execution",
      worker: "codex",
      objective: "Prove the API still surfaces preflight blockers without a saved run brief.",
      success_criteria: ["Keep the top-level failure signal readable."],
      workspace_root: rootDir
    });
    const missingRunBriefContract = createAttemptContract({
      attempt_id: missingRunBriefAttempt.id,
      run_id: missingRunBriefRun.id,
      attempt_type: "execution",
      objective: missingRunBriefAttempt.objective,
      success_criteria: missingRunBriefAttempt.success_criteria,
      required_evidence: ["Surface a unified failure signal from persisted attempt evidence."]
    });
    const missingRunBriefFailureReason =
      "Preflight blocker should stay visible after run-brief.json is removed.";
    const missingRunBriefCurrent = createCurrentDecision({
      run_id: missingRunBriefRun.id,
      run_status: "waiting_steer",
      latest_attempt_id: missingRunBriefAttempt.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: "Top-level failure signal should not depend on a saved run brief.",
      blocking_reason: "run brief file is missing, but the blocker still exists.",
      waiting_for_human: true
    });
    const missingRunBriefPreflight = createAttemptPreflightEvaluation({
      run_id: missingRunBriefRun.id,
      attempt_id: missingRunBriefAttempt.id,
      attempt_type: "execution",
      status: "failed",
      failure_code: "blocked_pnpm_verification_plan",
      failure_reason: missingRunBriefFailureReason
    });
    await saveRun(workspacePaths, missingRunBriefRun);
    await saveAttempt(workspacePaths, missingRunBriefAttempt);
    await saveAttemptContract(workspacePaths, missingRunBriefContract);
    await saveCurrentDecision(workspacePaths, missingRunBriefCurrent);
    await saveAttemptPreflightEvaluation(workspacePaths, missingRunBriefPreflight);
    await saveAttemptHandoffBundle(
      workspacePaths,
      createAttemptHandoffBundle({
        attempt: missingRunBriefAttempt,
        approved_attempt_contract: missingRunBriefContract,
        preflight_evaluation: missingRunBriefPreflight,
        current_decision_snapshot: missingRunBriefCurrent,
        source_refs: {
          run_contract: `runs/${missingRunBriefRun.id}/contract.json`,
          attempt_meta: `runs/${missingRunBriefRun.id}/attempts/${missingRunBriefAttempt.id}/meta.json`,
          attempt_contract: `runs/${missingRunBriefRun.id}/attempts/${missingRunBriefAttempt.id}/attempt_contract.json`,
          preflight_evaluation: `runs/${missingRunBriefRun.id}/attempts/${missingRunBriefAttempt.id}/artifacts/preflight-evaluation.json`,
          current_decision: `runs/${missingRunBriefRun.id}/current.json`,
          review_packet: null,
          runtime_verification: null,
          adversarial_verification: null
        }
      })
    );
    await refreshRunOperatorSurface(workspacePaths, missingRunBriefRun.id);
    await rm(resolveRunPaths(workspacePaths, missingRunBriefRun.id).runBriefFile, {
      force: true
    });

    const response = await app.inject({
      method: "GET",
      url: `/runs/${run.id}`
    });
    const invalidRunBriefResponse = await app.inject({
      method: "GET",
      url: `/runs/${invalidRunBriefRun.id}`
    });
    const writeFailedRunBriefResponse = await app.inject({
      method: "GET",
      url: `/runs/${writeFailedRunBriefRun.id}`
    });
    const staleResponse = await app.inject({
      method: "GET",
      url: `/runs/${staleRun.id}`
    });
    const staleWorkingContextResponse = await app.inject({
      method: "GET",
      url: `/runs/${staleWorkingContextRun.id}`
    });
    const writeFailedWorkingContextResponse = await app.inject({
      method: "GET",
      url: `/runs/${writeFailedWorkingContextRun.id}`
    });
    const missingRunBriefResponse = await app.inject({
      method: "GET",
      url: `/runs/${missingRunBriefRun.id}`
    });

    assert.equal(response.statusCode, 200);
    assert.equal(invalidRunBriefResponse.statusCode, 200);
    assert.equal(writeFailedRunBriefResponse.statusCode, 200);
    assert.equal(staleResponse.statusCode, 200);
    assert.equal(staleWorkingContextResponse.statusCode, 200);
    assert.equal(writeFailedWorkingContextResponse.statusCode, 200);
    assert.equal(missingRunBriefResponse.statusCode, 200);
    const payload = response.json() as {
      run: {
        harness_profile: {
          version: number;
          execution: { effort: string; default_verifier_kit: string };
          reviewer: { effort: string };
          synthesizer: { effort: string };
          gates: {
            preflight_review: { mode: string };
            deterministic_runtime: { mode: string };
            postflight_adversarial: { mode: string };
          };
          slots: {
            research_or_planning: { binding: string };
            execution: { binding: string };
            preflight_review: { binding: string };
            postflight_review: { binding: string };
            final_synthesis: { binding: string };
          };
        };
      };
      harness_gates: HarnessGatesPayload;
      harness_slots: HarnessSlotsPayload;
      default_verifier_kit_profile: VerifierKitProfilePayload;
      effective_policy_bundle: EffectivePolicyBundlePayload;
      worker_effort: {
        execution: { requested_effort: string; status: string };
        reviewer: { requested_effort: string; status: string };
        synthesizer: { requested_effort: string; status: string };
      };
      automation: {
        mode: string;
        reason_code: string | null;
      } | null;
      policy_runtime: {
        stage: string;
        approval_status: string;
        proposed_signature: string | null;
        proposed_attempt_type: string | null;
        proposed_objective: string | null;
      } | null;
      policy_runtime_ref: string | null;
      policy_runtime_invalid_reason: string | null;
      policy_activity: Array<{
        kind: string;
        status: string;
        headline: string;
        proposed_signature: string | null;
      }>;
      policy_activity_ref: string | null;
      failure_signal: {
        failure_class: string;
        failure_code: string | null;
        policy_mode: string;
        summary: string;
      } | null;
      latest_preflight_evaluation: {
        attempt_id: string;
        status: string;
        failure_code: string | null;
        failure_reason: string | null;
        failure_class: string | null;
        contract: {
          verifier_kit: string | null;
        } | null;
        toolchain_assessment: {
          verifier_kit: string | null;
          command_policy: string | null;
        } | null;
        checks: Array<{
          code: string;
          status: string;
          message: string;
        }>;
      } | null;
      latest_preflight_evaluation_ref: string | null;
      latest_runtime_verification: {
        attempt_id: string;
        status: string;
        verifier_kit: string | null;
        failure_code: string | null;
        failure_reason: string | null;
        failure_class: string | null;
        changed_files: string[];
      } | null;
      latest_runtime_verification_ref: string | null;
      latest_adversarial_verification: {
        attempt_id: string;
        status: string;
        verifier_kit: string | null;
        verdict: string | null;
        failure_code: string | null;
        failure_reason: string | null;
        failure_class: string | null;
        output_refs: string[];
      } | null;
      latest_adversarial_verification_ref: string | null;
      latest_handoff_bundle: {
        attempt_id: string;
        summary: string | null;
        failure_class: string | null;
        failure_code: string | null;
        adversarial_failure_code: string | null;
        adversarial_verification: {
          status: string;
        } | null;
        source_refs: {
          preflight_evaluation: string | null;
          runtime_verification: string | null;
          adversarial_verification: string | null;
        };
      } | null;
      latest_handoff_bundle_ref: string | null;
      run_brief: {
        headline: string;
        summary: string;
        latest_attempt_id: string | null;
        primary_focus: string | null;
        failure_signal: {
          failure_class: string;
          failure_code: string | null;
          policy_mode: string;
          summary: string;
        } | null;
        evidence_refs: Array<{
          kind: string;
          ref: string;
        }>;
      } | null;
      run_brief_ref: string | null;
      run_brief_invalid_reason: string | null;
      run_brief_degraded: RunBriefDegradedPayload;
      maintenance_plane: {
        blocked_diagnosis: {
          status: string;
          summary: string | null;
          recommended_next_action: string | null;
        };
        outputs: Array<{
          key: string;
          plane: string;
          status: string;
          ref: string | null;
          summary: string | null;
        }>;
        signal_sources: Array<{
          key: string;
          plane: string;
          ref: string | null;
          summary: string | null;
        }>;
      } | null;
      maintenance_plane_ref: string | null;
      working_context: {
        version: number;
        plan_ref: string | null;
        current_focus: string | null;
        current_blocker: {
          code: string | null;
          summary: string;
          ref: string | null;
        } | null;
        recent_evidence_refs: Array<{
          kind: string;
          ref: string;
        }>;
        source_snapshot: WorkingContextSourceSnapshotPayload;
        source_attempt_id: string | null;
      } | null;
      working_context_ref: string | null;
      working_context_degraded: {
        is_degraded: boolean;
        reason_code: string | null;
      };
      run_health: {
        status: string;
      };
      attempts: Array<{ id: string }>;
      attempt_details: Array<{
        attempt: { id: string; input_context_ref: string | null };
        effective_verifier_kit_profile: VerifierKitProfilePayload | null;
        contract: {
          required_evidence: string[];
          adversarial_verification_required: boolean;
          verifier_kit: string | null;
        } | null;
        context: {
          contract: { title: string };
          current_decision: { summary: string };
          worker_effort: {
            execution: { requested_effort: string; status: string };
            reviewer: { requested_effort: string; status: string };
            synthesizer: { requested_effort: string; status: string };
          };
          previous_attempts: Array<{ id: string; status: string }>;
        } | null;
        failure_context: {
          message: string;
          journal_event_id: string | null;
          journal_event_ts: string | null;
        } | null;
        result: { summary: string; verification_plan?: { commands: Array<{ command: string }> } } | null;
        evaluation: {
          verification_status: string;
          adversarial_verification_status: string;
        } | null;
        runtime_verification: {
          status: string;
          verifier_kit: string | null;
          changed_files: string[];
        } | null;
        adversarial_verification: {
          status: string;
          verifier_kit: string | null;
          verdict: string | null;
          output_refs: string[];
        } | null;
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
    const invalidRunBriefPayload = invalidRunBriefResponse.json() as {
      failure_signal: {
        failure_class: string;
        failure_code: string | null;
        policy_mode: string;
        summary: string;
        source_ref: string | null;
      } | null;
      run_brief: null;
      run_brief_ref: string | null;
      run_brief_invalid_reason: string | null;
      run_brief_degraded: RunBriefDegradedPayload;
      maintenance_plane: {
        blocked_diagnosis: {
          status: string;
          summary: string | null;
          source_ref: string | null;
        };
        outputs: Array<{
          key: string;
          status: string;
          ref: string | null;
          summary: string | null;
        }>;
        signal_sources: Array<{
          key: string;
          ref: string | null;
          summary: string | null;
        }>;
      } | null;
    };
    const writeFailedRunBriefPayload = writeFailedRunBriefResponse.json() as {
      failure_signal: {
        failure_class: string;
        failure_code: string | null;
        policy_mode: string;
        summary: string;
        source_ref: string | null;
      } | null;
      run_brief: null;
      run_brief_ref: string | null;
      run_brief_invalid_reason: string | null;
      run_brief_degraded: RunBriefDegradedPayload;
      maintenance_plane: {
        blocked_diagnosis: {
          status: string;
          summary: string | null;
          source_ref: string | null;
        };
        outputs: Array<{
          key: string;
          status: string;
          ref: string | null;
          summary: string | null;
        }>;
        signal_sources: Array<{
          key: string;
          ref: string | null;
          summary: string | null;
        }>;
      } | null;
    };
    const stalePayload = staleResponse.json() as {
      run_health: {
        status: string;
        likely_zombie: boolean;
      };
      working_context: null;
      working_context_ref: string | null;
      working_context_degraded: {
        is_degraded: boolean;
        reason_code: string | null;
      };
    };
    const staleWorkingContextPayload = staleWorkingContextResponse.json() as {
      working_context: {
        version: number;
        current_focus: string | null;
        source_snapshot: WorkingContextSourceSnapshotPayload;
      } | null;
      working_context_ref: string | null;
      working_context_degraded: {
        is_degraded: boolean;
        reason_code: string | null;
        summary: string | null;
      };
    };
    const writeFailedWorkingContextPayload = writeFailedWorkingContextResponse.json() as {
      working_context: {
        version: number;
        current_focus: string | null;
        source_snapshot: WorkingContextSourceSnapshotPayload;
      } | null;
      working_context_ref: string | null;
      failure_signal: {
        failure_class: string;
        policy_mode: string;
        summary: string;
      } | null;
      working_context_degraded: {
        is_degraded: boolean;
        reason_code: string | null;
        summary: string | null;
      };
      run_brief: {
        headline: string;
        summary: string;
        failure_signal: {
          failure_class: string;
          failure_code: string | null;
          policy_mode: string;
          summary: string;
        } | null;
      } | null;
      run_brief_ref: string | null;
    };
    const missingRunBriefPayload = missingRunBriefResponse.json() as {
      failure_signal: {
        failure_class: string;
        failure_code: string | null;
        summary: string;
        source_ref: string | null;
      } | null;
      latest_preflight_evaluation: {
        attempt_id: string;
        failure_code: string | null;
        failure_reason: string | null;
      } | null;
      latest_preflight_evaluation_ref: string | null;
      latest_handoff_bundle: {
        attempt_id: string;
        failure_code: string | null;
      } | null;
      latest_handoff_bundle_ref: string | null;
      run_brief: null;
      run_brief_ref: null;
      maintenance_plane: {
        blocked_diagnosis: {
          status: string;
          summary: string | null;
          source_ref: string | null;
        };
        outputs: Array<{
          key: string;
          status: string;
          ref: string | null;
          summary: string | null;
        }>;
      } | null;
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
    assert.equal(
      completedDetail?.contract?.adversarial_verification_required,
      true
    );
    assert.equal(completedDetail?.contract?.verifier_kit, "api");
    assert.equal(completedDetail?.effective_verifier_kit_profile?.kit, "api");
    assert.equal(completedDetail?.effective_verifier_kit_profile?.title, "API Task");
    assert.equal(
      completedDetail?.effective_verifier_kit_profile?.command_policy,
      "contract_locked_commands"
    );
    assert.equal(
      completedDetail?.effective_verifier_kit_profile?.source,
      "attempt_contract.verifier_kit"
    );
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
    assert.equal(
      completedDetail?.evaluation?.adversarial_verification_status,
      "passed"
    );
    assert.equal(completedDetail?.runtime_verification?.status, "passed");
    assert.equal(completedDetail?.runtime_verification?.verifier_kit, "api");
    assert.equal(completedDetail?.adversarial_verification?.status, "passed");
    assert.equal(completedDetail?.adversarial_verification?.verifier_kit, "api");
    assert.equal(completedDetail?.adversarial_verification?.verdict, "pass");
    assert.equal(
      completedDetail?.adversarial_verification?.output_refs[0],
      adversarialOutputFile
    );
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
        "run.policy.hook_evaluated",
        "run.policy.approved",
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
    assert.equal(blockerDetail?.adversarial_verification, null);
    assert.equal(blockerDetail?.runtime_state, null);
    assert.deepEqual(blockerDetail?.runtime_events, []);
    assert.equal(blockerDetail?.heartbeat, null);
    assert.deepEqual(
      blockerDetail?.journal.map((entry) => entry.type),
      [
        "attempt.created",
        "attempt.preflight.failed",
        "attempt.failed",
        "run.auto_resume.blocked"
      ]
    );
    assert.equal(payload.run_health.status, "waiting_steer");
    assert.equal(payload.run.harness_profile.execution.effort, "high");
    assert.equal(payload.run.harness_profile.version, 3);
    assert.equal(payload.run.harness_profile.execution.default_verifier_kit, "api");
    assert.equal(payload.run.harness_profile.reviewer.effort, "low");
    assert.equal(payload.run.harness_profile.synthesizer.effort, "medium");
    assert.equal(payload.run.harness_profile.gates.preflight_review.mode, "required");
    assert.equal(payload.run.harness_profile.gates.deterministic_runtime.mode, "required");
    assert.equal(payload.run.harness_profile.gates.postflight_adversarial.mode, "required");
    assert.equal(
      payload.run.harness_profile.slots.execution.binding,
      "codex_cli_execution_worker"
    );
    assert.equal(
      payload.run.harness_profile.slots.postflight_review.binding,
      "attempt_adversarial_verification"
    );
    assert.equal(payload.harness_slots.execution.binding, "codex_cli_execution_worker");
    assert.equal(
      payload.harness_slots.execution.expected_binding,
      "codex_cli_execution_worker"
    );
    assert.equal(payload.harness_slots.execution.binding_status, "aligned");
    assert.equal(payload.harness_slots.execution.binding_matches_registry, true);
    assert.equal(payload.harness_slots.execution.permission_boundary, "workspace_write");
    assert.deepEqual(payload.harness_slots.execution.output_artifacts, [
      "result.json",
      "worker-declared artifacts under artifacts/"
    ]);
    assert.equal(payload.harness_slots.execution.failure_semantics, "fail_closed");
    assert.equal(payload.harness_gates.preflight_review.mode, "required");
    assert.equal(payload.harness_gates.preflight_review.enforced, true);
    assert.equal(payload.harness_gates.preflight_review.phase, "dispatch");
    assert.equal(
      payload.harness_gates.preflight_review.source,
      "run.harness_profile.gates.preflight_review.mode"
    );
    assert.equal(payload.harness_gates.deterministic_runtime.mode, "required");
    assert.equal(payload.harness_gates.deterministic_runtime.enforced, true);
    assert.equal(payload.harness_gates.deterministic_runtime.phase, "runtime");
    assert.equal(payload.harness_gates.postflight_adversarial.mode, "required");
    assert.equal(payload.harness_gates.postflight_adversarial.enforced, true);
    assert.equal(payload.harness_gates.postflight_adversarial.phase, "postflight");
    assert.equal(
      payload.harness_gates.postflight_adversarial.artifact_ref,
      "artifacts/adversarial-verification.json"
    );
    assert.equal(payload.harness_slots.execution.default_verifier_kit, "api");
    assert.equal(payload.default_verifier_kit_profile.kit, "api");
    assert.equal(payload.default_verifier_kit_profile.title, "API Task");
    assert.equal(
      payload.default_verifier_kit_profile.command_policy,
      "contract_locked_commands"
    );
    assert.equal(
      payload.default_verifier_kit_profile.source,
      "run.harness_profile.execution.default_verifier_kit"
    );
    assert.ok(
      payload.default_verifier_kit_profile.preflight_expectations.some((item) =>
        item.includes("HTTP")
      )
    );
    assert.equal(payload.harness_slots.preflight_review.permission_boundary, "read_only");
    assert.deepEqual(payload.harness_slots.preflight_review.output_artifacts, [
      "artifacts/preflight-evaluation.json"
    ]);
    assert.equal(payload.harness_slots.preflight_review.failure_semantics, "fail_closed");
    assert.equal(
      payload.harness_slots.final_synthesis.permission_boundary,
      "control_plane_only"
    );
    assert.equal(payload.effective_policy_bundle.profile_version, 3);
    assert.equal(
      payload.effective_policy_bundle.verification_discipline.level,
      "deterministic_plus_adversarial"
    );
    assert.equal(
      payload.effective_policy_bundle.verification_discipline.default_verifier_kit,
      "api"
    );
    assert.equal(
      payload.effective_policy_bundle.verification_discipline.command_policy,
      "contract_locked_commands"
    );
    assert.equal(payload.effective_policy_bundle.operator_brief.intensity, "standard");
    assert.equal(payload.effective_policy_bundle.operator_brief.evidence_ref_budget, 6);
    assert.equal(
      payload.effective_policy_bundle.maintenance_refresh.strategy,
      "saved_boundary_snapshot"
    );
    assert.equal(
      payload.effective_policy_bundle.maintenance_refresh.refreshes_on_read,
      false
    );
    assert.equal(
      payload.effective_policy_bundle.recovery.active_run,
      "working_context_first"
    );
    assert.equal(payload.effective_policy_bundle.recovery.settled_run, "manual_only");
    assert.equal(
      payload.effective_policy_bundle.recovery.auto_resume_from_settled_handoff,
      false
    );
    assert.ok(
      payload.harness_slots.execution.input_contract.includes(
        "attempt_contract.json with replayable verification commands"
      )
    );
    assert.equal(payload.worker_effort.execution.requested_effort, "high");
    assert.equal(payload.worker_effort.execution.status, "applied");
    assert.equal(payload.worker_effort.reviewer.requested_effort, "low");
    assert.equal(payload.worker_effort.reviewer.status, "unsupported");
    assert.equal(payload.worker_effort.synthesizer.requested_effort, "medium");
    assert.equal(payload.worker_effort.synthesizer.status, "unsupported");
    assert.equal(payload.automation?.mode, "manual_only");
    assert.equal(payload.automation?.reason_code, "automatic_resume_blocked");
    assert.equal(payload.policy_runtime?.stage, "execution");
    assert.equal(payload.policy_runtime?.approval_status, "approved");
    assert.equal(payload.policy_runtime?.proposed_signature, "verify-run-detail-policy");
    assert.equal(payload.policy_runtime?.proposed_attempt_type, "execution");
    assert.equal(payload.policy_runtime?.proposed_objective, attempt.objective);
    assert.ok(payload.policy_runtime_ref?.endsWith("policy-runtime.json"));
    assert.equal(payload.policy_runtime_invalid_reason, null);
    assert.equal(payload.policy_activity_ref, `runs/${run.id}/journal.ndjson`);
    assert.equal(payload.policy_activity[0]?.kind, "decision");
    assert.equal(payload.policy_activity[0]?.status, "approved");
    assert.equal(payload.policy_activity[0]?.headline, "Execution plan was approved.");
    assert.equal(
      payload.policy_activity[0]?.proposed_signature,
      "verify-run-detail-policy"
    );
    assert.equal(payload.policy_activity[1]?.kind, "hook");
    assert.equal(payload.policy_activity[1]?.status, "passed");
    assert.equal(payload.failure_signal?.failure_class, "preflight_blocked");
    assert.equal(
      payload.failure_signal?.failure_code,
      "blocked_pnpm_verification_plan"
    );
    assert.equal(payload.latest_preflight_evaluation?.attempt_id, blockerAttempt.id);
    assert.equal(payload.latest_preflight_evaluation?.status, "failed");
    assert.equal(payload.latest_preflight_evaluation?.failure_class, "preflight_blocked");
    assert.equal(
      payload.latest_preflight_evaluation?.failure_code,
      "blocked_pnpm_verification_plan"
    );
    assert.equal(
      payload.latest_preflight_evaluation?.failure_reason,
      blockerFailureContext.message
    );
    assert.ok(
      payload.latest_preflight_evaluation_ref?.endsWith("artifacts/preflight-evaluation.json")
    );
    assert.equal(payload.latest_runtime_verification?.attempt_id, attempt.id);
    assert.equal(payload.latest_runtime_verification?.status, "passed");
    assert.equal(payload.latest_runtime_verification?.verifier_kit, "api");
    assert.equal(payload.latest_runtime_verification?.failure_class, null);
    assert.deepEqual(payload.latest_runtime_verification?.changed_files, [
      "packages/orchestrator/src/index.ts"
    ]);
    assert.ok(
      payload.latest_runtime_verification_ref?.endsWith("artifacts/runtime-verification.json")
    );
    assert.equal(payload.latest_adversarial_verification?.attempt_id, attempt.id);
    assert.equal(payload.latest_adversarial_verification?.status, "passed");
    assert.equal(payload.latest_adversarial_verification?.verifier_kit, "api");
    assert.equal(payload.latest_adversarial_verification?.verdict, "pass");
    assert.equal(payload.latest_adversarial_verification?.failure_class, null);
    assert.deepEqual(payload.latest_adversarial_verification?.output_refs, [
      adversarialOutputFile
    ]);
    assert.ok(
      payload.latest_adversarial_verification_ref?.endsWith(
        "artifacts/adversarial-verification.json"
      )
    );
    assert.equal(payload.latest_handoff_bundle?.attempt_id, blockerAttempt.id);
    assert.equal(payload.latest_handoff_bundle?.failure_class, "preflight_blocked");
    assert.equal(
      payload.latest_handoff_bundle?.failure_code,
      "blocked_pnpm_verification_plan"
    );
    assert.equal(payload.latest_handoff_bundle?.adversarial_verification, null);
    assert.equal(payload.latest_handoff_bundle?.adversarial_failure_code, null);
    assert.equal(
      payload.latest_handoff_bundle?.summary,
      blockerFailureContext.message
    );
    assert.ok(
      payload.latest_handoff_bundle_ref?.endsWith("artifacts/handoff_bundle.json")
    );
    assert.ok(
      payload.latest_handoff_bundle?.source_refs.preflight_evaluation?.endsWith(
        "artifacts/preflight-evaluation.json"
      )
    );
    assert.equal(payload.latest_handoff_bundle?.source_refs.adversarial_verification, null);
    assert.equal(payload.run_brief?.latest_attempt_id, blockerAttempt.id);
    assert.equal(
      payload.run_brief?.headline,
      settledHandoffRecoveryBlockedMessage
    );
    assert.equal(payload.run_brief?.primary_focus, blockerAttempt.objective);
    assert.equal(payload.run_brief?.failure_signal?.failure_class, "preflight_blocked");
    assert.equal(
      payload.run_brief?.failure_signal?.failure_code,
      "blocked_pnpm_verification_plan"
    );
    assert.ok(payload.run_brief_ref?.endsWith("run-brief.json"));
    assert.equal(payload.run_brief_invalid_reason, null);
    assert.equal(payload.run_brief_degraded.is_degraded, false);
    assert.ok(payload.maintenance_plane_ref?.endsWith("artifacts/maintenance-plane.json"));
    assert.equal(payload.maintenance_plane?.blocked_diagnosis.status, "attention");
    assert.equal(
      payload.maintenance_plane?.blocked_diagnosis.summary,
      blockerFailureContext.message
    );
    assert.equal(
      payload.maintenance_plane?.blocked_diagnosis.recommended_next_action,
      "wait_for_human"
    );
    assert.ok(
      payload.maintenance_plane?.outputs.some(
        (item) => item.key === "run_brief" && item.plane === "maintenance"
      )
    );
    assert.ok(
      payload.maintenance_plane?.outputs.some(
        (item) => item.key === "policy_runtime" && item.plane === "maintenance"
      )
    );
    assert.ok(
      payload.maintenance_plane?.outputs.some(
        (item) => item.key === "effective_policy" && item.plane === "maintenance"
      )
    );
    assert.ok(
      payload.maintenance_plane?.outputs.some(
        (item) =>
          item.key === "verifier_summary" &&
          item.plane === "maintenance" &&
          item.status === "attention" &&
          item.ref?.endsWith("artifacts/preflight-evaluation.json") &&
          item.summary === blockerFailureContext.message
      )
    );
    assert.ok(
      payload.maintenance_plane?.signal_sources.some(
        (item) => item.key === "handoff_bundle" && item.plane === "mainline"
      )
    );
    assert.ok(
      payload.run_brief?.evidence_refs.some(
        (item) => item.kind === "handoff_bundle" && item.ref.endsWith("handoff_bundle.json")
      )
    );
    assert.equal(payload.working_context_degraded.is_degraded, false);
    assert.equal(payload.working_context?.version, 1);
    assert.equal(payload.working_context?.source_attempt_id, blockerAttempt.id);
    assert.equal(payload.working_context?.current_focus, blockerAttempt.objective);
    assert.equal(
      payload.working_context?.current_blocker?.summary,
      settledHandoffRecoveryBlockedMessage
    );
    assert.ok(payload.working_context?.source_snapshot.current.ref?.endsWith("current.json"));
    assert.ok(
      payload.working_context?.source_snapshot.automation.ref?.endsWith("automation.json")
    );
    assert.equal(
      payload.working_context?.source_snapshot.latest_attempt.attempt_id,
      blockerAttempt.id
    );
    assert.ok(
      payload.working_context?.source_snapshot.latest_attempt.ref?.endsWith(
        `/attempts/${blockerAttempt.id}/meta.json`
      )
    );
    assert.equal(
      payload.working_context?.plan_ref,
      `runs/${run.id}/attempts/${blockerAttempt.id}/attempt_contract.json`
    );
    assert.ok(payload.working_context_ref?.endsWith("working-context.json"));
    assert.ok(
      payload.working_context?.recent_evidence_refs.some(
        (item) => item.kind === "review_packet" && item.ref.endsWith("review_packet.json")
      )
    );
    assert.equal(stalePayload.run_health.status, "stale_running_attempt");
    assert.equal(stalePayload.run_health.likely_zombie, true);
    assert.equal(stalePayload.working_context, null);
    assert.equal(stalePayload.working_context_ref, null);
    assert.equal(stalePayload.working_context_degraded.is_degraded, true);
    assert.equal(stalePayload.working_context_degraded.reason_code, "context_missing");
    assert.equal(staleWorkingContextPayload.working_context_degraded.is_degraded, true);
    assert.equal(
      staleWorkingContextPayload.working_context_degraded.reason_code,
      "context_stale"
    );
    assert.equal(staleWorkingContextPayload.working_context?.version, 1);
    assert.ok(
      staleWorkingContextPayload.working_context?.source_snapshot.current.ref?.endsWith(
        "current.json"
      )
    );
    assert.ok(
      staleWorkingContextPayload.working_context_degraded.summary?.includes(
        `runs/${staleWorkingContextRun.id}/current.json`
      )
    );
    assert.ok(staleWorkingContextPayload.working_context_ref?.endsWith("working-context.json"));
    assert.equal(writeFailedWorkingContextPayload.working_context, null);
    assert.equal(writeFailedWorkingContextPayload.working_context_ref, null);
    assert.equal(
      writeFailedWorkingContextPayload.failure_signal?.failure_class,
      "working_context_degraded"
    );
    assert.equal(
      writeFailedWorkingContextPayload.failure_signal?.policy_mode,
      "soft_degrade"
    );
    assert.equal(writeFailedWorkingContextPayload.working_context_degraded.is_degraded, true);
    assert.equal(
      writeFailedWorkingContextPayload.working_context_degraded.reason_code,
      "context_write_failed"
    );
    assert.ok(
      writeFailedWorkingContextPayload.working_context_degraded.summary?.includes("写入失败")
    );
    assert.ok(writeFailedWorkingContextPayload.run_brief_ref?.endsWith("run-brief.json"));
    assert.equal(
      writeFailedWorkingContextPayload.run_brief?.headline,
      "Broken working context path should surface an explicit degraded state."
    );
    assert.equal(
      writeFailedWorkingContextPayload.run_brief?.failure_signal?.failure_class,
      "working_context_degraded"
    );
    assert.equal(invalidRunBriefPayload.run_brief, null);
    assert.ok(invalidRunBriefPayload.run_brief_ref?.endsWith("run-brief.json"));
    assert.match(
      invalidRunBriefPayload.run_brief_invalid_reason ?? "",
      /json|parse|unexpected end/i
    );
    assert.equal(invalidRunBriefPayload.run_brief_degraded.is_degraded, true);
    assert.equal(
      invalidRunBriefPayload.run_brief_degraded.reason_code,
      "run_brief_unreadable"
    );
    assert.equal(
      invalidRunBriefPayload.run_brief_degraded.summary,
      "run brief 文件不可读，控制面摘要已退化。"
    );
    assert.ok(
      invalidRunBriefPayload.run_brief_degraded.source_ref?.endsWith("run-brief.json")
    );
    assert.equal(
      invalidRunBriefPayload.failure_signal?.failure_class,
      "run_brief_degraded"
    );
    assert.equal(invalidRunBriefPayload.failure_signal?.policy_mode, "soft_degrade");
    assert.equal(
      invalidRunBriefPayload.failure_signal?.summary,
      "run brief 文件不可读，控制面摘要已退化。"
    );
    assert.ok(
      invalidRunBriefPayload.failure_signal?.source_ref?.endsWith("run-brief.json")
    );
    assert.equal(
      invalidRunBriefPayload.maintenance_plane?.blocked_diagnosis.summary,
      "run brief 文件不可读，控制面摘要已退化。"
    );
    assert.ok(
      invalidRunBriefPayload.maintenance_plane?.blocked_diagnosis.source_ref?.endsWith(
        "run-brief.json"
      )
    );
    assert.ok(
      invalidRunBriefPayload.maintenance_plane?.outputs.some(
        (item) =>
          item.key === "run_brief" &&
          item.status === "degraded" &&
          item.ref?.endsWith("run-brief.json") &&
          item.summary === "run brief 文件不可读，控制面摘要已退化。"
      )
    );
    assert.ok(
      invalidRunBriefPayload.maintenance_plane?.signal_sources.some(
        (item) =>
          item.key === "run_brief" &&
          item.ref?.endsWith("run-brief.json") &&
          item.summary === "run brief 文件不可读，控制面摘要已退化。"
      )
    );
    assert.equal(writeFailedRunBriefPayload.run_brief, null);
    assert.ok(writeFailedRunBriefPayload.run_brief_ref?.endsWith("run-brief.json"));
    assert.match(
      writeFailedRunBriefPayload.run_brief_invalid_reason ?? "",
      /EISDIR|directory/i
    );
    assert.equal(writeFailedRunBriefPayload.run_brief_degraded.is_degraded, true);
    assert.equal(
      writeFailedRunBriefPayload.run_brief_degraded.reason_code,
      "run_brief_write_failed"
    );
    assert.equal(
      writeFailedRunBriefPayload.run_brief_degraded.summary,
      "run brief 写入失败，控制面摘要已退化。"
    );
    assert.ok(
      writeFailedRunBriefPayload.run_brief_degraded.source_ref?.endsWith("run-brief.json")
    );
    assert.equal(
      writeFailedRunBriefPayload.failure_signal?.failure_class,
      "run_brief_degraded"
    );
    assert.equal(writeFailedRunBriefPayload.failure_signal?.policy_mode, "soft_degrade");
    assert.equal(
      writeFailedRunBriefPayload.failure_signal?.summary,
      "run brief 写入失败，控制面摘要已退化。"
    );
    assert.ok(
      writeFailedRunBriefPayload.failure_signal?.source_ref?.endsWith("run-brief.json")
    );
    assert.equal(
      writeFailedRunBriefPayload.maintenance_plane?.blocked_diagnosis.summary,
      "run brief 写入失败，控制面摘要已退化。"
    );
    assert.ok(
      writeFailedRunBriefPayload.maintenance_plane?.blocked_diagnosis.source_ref?.endsWith(
        "run-brief.json"
      )
    );
    assert.ok(
      writeFailedRunBriefPayload.maintenance_plane?.outputs.some(
        (item) =>
          item.key === "run_brief" &&
          item.status === "degraded" &&
          item.ref?.endsWith("run-brief.json") &&
          item.summary === "run brief 写入失败，控制面摘要已退化。"
      )
    );
    assert.ok(
      writeFailedRunBriefPayload.maintenance_plane?.signal_sources.some(
        (item) =>
          item.key === "run_brief" &&
          item.ref?.endsWith("run-brief.json") &&
          item.summary === "run brief 写入失败，控制面摘要已退化。"
      )
    );
    assert.equal(missingRunBriefPayload.run_brief, null);
    assert.equal(missingRunBriefPayload.run_brief_ref, null);
    assert.equal(
      missingRunBriefPayload.failure_signal?.failure_class,
      "preflight_blocked"
    );
    assert.equal(
      missingRunBriefPayload.failure_signal?.failure_code,
      "blocked_pnpm_verification_plan"
    );
    assert.equal(
      missingRunBriefPayload.failure_signal?.summary,
      missingRunBriefFailureReason
    );
    assert.ok(
      missingRunBriefPayload.failure_signal?.source_ref?.endsWith(
        "artifacts/preflight-evaluation.json"
      )
    );
    assert.equal(
      missingRunBriefPayload.latest_preflight_evaluation?.attempt_id,
      missingRunBriefAttempt.id
    );
    assert.equal(
      missingRunBriefPayload.latest_preflight_evaluation?.failure_code,
      "blocked_pnpm_verification_plan"
    );
    assert.equal(
      missingRunBriefPayload.latest_preflight_evaluation?.failure_reason,
      missingRunBriefFailureReason
    );
    assert.ok(
      missingRunBriefPayload.latest_preflight_evaluation_ref?.endsWith(
        "artifacts/preflight-evaluation.json"
      )
    );
    assert.equal(
      missingRunBriefPayload.latest_handoff_bundle?.attempt_id,
      missingRunBriefAttempt.id
    );
    assert.equal(
      missingRunBriefPayload.latest_handoff_bundle?.failure_code,
      "blocked_pnpm_verification_plan"
    );
    assert.ok(
      missingRunBriefPayload.latest_handoff_bundle_ref?.endsWith("artifacts/handoff_bundle.json")
    );
    assert.equal(
      missingRunBriefPayload.maintenance_plane?.blocked_diagnosis.status,
      "attention"
    );
    assert.equal(
      missingRunBriefPayload.maintenance_plane?.blocked_diagnosis.summary,
      missingRunBriefFailureReason
    );
    assert.ok(
      missingRunBriefPayload.maintenance_plane?.blocked_diagnosis.source_ref?.endsWith(
        "artifacts/preflight-evaluation.json"
      )
    );
    assert.ok(
      missingRunBriefPayload.maintenance_plane?.outputs.some(
        (item) => item.key === "run_brief" && item.status === "not_available"
      )
    );
    assert.ok(
      missingRunBriefPayload.maintenance_plane?.outputs.some(
        (item) =>
          item.key === "verifier_summary" &&
          item.status === "attention" &&
          item.ref?.endsWith("artifacts/preflight-evaluation.json") &&
          item.summary === missingRunBriefFailureReason
      )
    );

    const runsResponse = await app.inject({
      method: "GET",
      url: "/runs"
    });
    assert.equal(runsResponse.statusCode, 200);
    const runsPayload = runsResponse.json() as {
      runs: Array<{
        run: {
          id: string;
          harness_profile: {
            version: number;
            execution: { default_verifier_kit: string };
            gates: {
              postflight_adversarial: { mode: string };
            };
            slots: {
              execution: { binding: string };
            };
          };
        };
        harness_gates: HarnessGatesPayload;
        harness_slots: HarnessSlotsPayload;
        default_verifier_kit_profile: VerifierKitProfilePayload;
        effective_policy_bundle: EffectivePolicyBundlePayload;
        worker_effort: {
          execution: { requested_effort: string; status: string };
        };
        run_health: {
          status: string;
          likely_zombie: boolean;
        };
        working_context: {
          version: number;
          source_snapshot: WorkingContextSourceSnapshotPayload;
        } | null;
        working_context_ref: string | null;
        working_context_degraded: {
          is_degraded: boolean;
          reason_code: string | null;
        };
        failure_signal: {
          failure_class: string;
          policy_mode: string;
          summary: string;
        } | null;
        latest_preflight_evaluation: {
          attempt_id: string;
          status: string;
          failure_reason: string | null;
          failure_class: string | null;
          contract: {
            verifier_kit: string | null;
          } | null;
          toolchain_assessment: {
            verifier_kit: string | null;
            command_policy: string | null;
          } | null;
        } | null;
        latest_preflight_evaluation_ref: string | null;
        latest_runtime_verification: {
          attempt_id: string;
          status: string;
          verifier_kit: string | null;
          failure_reason: string | null;
          failure_class: string | null;
          changed_files: string[];
        } | null;
        latest_runtime_verification_ref: string | null;
        latest_adversarial_verification: {
          attempt_id: string;
          status: string;
          verifier_kit: string | null;
          verdict: string | null;
          failure_reason: string | null;
          failure_class: string | null;
          output_refs: string[];
        } | null;
        latest_adversarial_verification_ref: string | null;
        latest_handoff_bundle: {
          attempt_id: string;
          summary: string | null;
          adversarial_verification: {
            status: string;
          } | null;
          source_refs: {
            preflight_evaluation: string | null;
            adversarial_verification: string | null;
          };
        } | null;
        latest_handoff_bundle_ref: string | null;
        run_brief: {
          latest_attempt_id: string | null;
          headline: string;
          summary: string;
          primary_focus: string | null;
          failure_signal: {
            failure_class: string;
            policy_mode: string;
            summary: string;
          } | null;
        } | null;
        run_brief_ref: string | null;
        run_brief_invalid_reason: string | null;
        run_brief_degraded: RunBriefDegradedPayload;
        policy_runtime: {
          stage: string;
          approval_status: string;
        } | null;
        policy_runtime_ref: string | null;
        policy_runtime_invalid_reason: string | null;
        maintenance_plane: {
          blocked_diagnosis: {
            status: string;
            summary: string | null;
            source_ref: string | null;
          };
          outputs: Array<{
            key: string;
            plane: string;
            status: string;
            ref: string | null;
            summary: string | null;
          }>;
        } | null;
        maintenance_plane_ref: string | null;
        task_focus: string;
        latest_attempt_runtime_state: { session_id: string | null } | null;
      }>;
    };
    const runSummary = runsPayload.runs.find((item) => item.run.id === run.id);
    const invalidRunBriefSummary = runsPayload.runs.find(
      (item) => item.run.id === invalidRunBriefRun.id
    );
    const writeFailedRunBriefSummary = runsPayload.runs.find(
      (item) => item.run.id === writeFailedRunBriefRun.id
    );
    const missingRunBriefSummary = runsPayload.runs.find(
      (item) => item.run.id === missingRunBriefRun.id
    );
    assert.equal(runSummary?.run.harness_profile.version, 3);
    assert.equal(
      runSummary?.run.harness_profile.execution.default_verifier_kit,
      "api"
    );
    assert.equal(
      runSummary?.run.harness_profile.gates.postflight_adversarial.mode,
      "required"
    );
    assert.equal(
      runSummary?.run.harness_profile.slots.execution.binding,
      "codex_cli_execution_worker"
    );
    assert.equal(runSummary?.harness_gates.preflight_review.mode, "required");
    assert.equal(runSummary?.harness_gates.preflight_review.enforced, true);
    assert.equal(runSummary?.harness_gates.deterministic_runtime.phase, "runtime");
    assert.equal(
      runSummary?.harness_gates.postflight_adversarial.source,
      "run.harness_profile.gates.postflight_adversarial.mode"
    );
    assert.equal(runSummary?.harness_slots.execution.binding, "codex_cli_execution_worker");
    assert.equal(runSummary?.default_verifier_kit_profile.kit, "api");
    assert.equal(runSummary?.default_verifier_kit_profile.title, "API Task");
    assert.equal(
      runSummary?.default_verifier_kit_profile.command_policy,
      "contract_locked_commands"
    );
    assert.equal(
      runSummary?.default_verifier_kit_profile.source,
      "run.harness_profile.execution.default_verifier_kit"
    );
    assert.equal(
      runSummary?.harness_slots.execution.default_verifier_kit,
      "api"
    );
    assert.equal(runSummary?.harness_slots.execution.binding_status, "aligned");
    assert.equal(
      runSummary?.harness_slots.execution.permission_boundary,
      "workspace_write"
    );
    assert.equal(runSummary?.harness_slots.preflight_review.failure_semantics, "fail_closed");
    assert.deepEqual(runSummary?.harness_slots.preflight_review.output_artifacts, [
      "artifacts/preflight-evaluation.json"
    ]);
    assert.equal(
      runSummary?.harness_slots.final_synthesis.permission_boundary,
      "control_plane_only"
    );
    assert.equal(runSummary?.worker_effort.execution.requested_effort, "high");
    assert.equal(runSummary?.worker_effort.execution.status, "applied");
    assert.equal(runSummary?.latest_attempt_runtime_state, null);
    assert.equal(runSummary?.policy_runtime?.stage, "execution");
    assert.equal(runSummary?.policy_runtime?.approval_status, "approved");
    assert.ok(runSummary?.policy_runtime_ref?.endsWith("policy-runtime.json"));
    assert.equal(runSummary?.policy_runtime_invalid_reason, null);
    assert.equal(runSummary?.run_health.status, "waiting_steer");
    assert.equal(runSummary?.effective_policy_bundle.operator_brief.intensity, "standard");
    assert.equal(
      runSummary?.effective_policy_bundle.maintenance_refresh.strategy,
      "saved_boundary_snapshot"
    );
    assert.equal(runSummary?.effective_policy_bundle.recovery.settled_run, "manual_only");
    assert.equal(runSummary?.working_context_degraded.is_degraded, false);
    assert.equal(runSummary?.working_context?.version, 1);
    assert.ok(runSummary?.working_context?.source_snapshot.current.ref?.endsWith("current.json"));
    assert.equal(
      runSummary?.working_context?.source_snapshot.latest_attempt.attempt_id,
      blockerAttempt.id
    );
    assert.equal(runSummary?.failure_signal?.failure_class, "preflight_blocked");
    assert.equal(
      runSummary?.failure_signal?.failure_code,
      "blocked_pnpm_verification_plan"
    );
    assert.ok(runSummary?.working_context_ref?.endsWith("working-context.json"));
    assert.equal(runSummary?.latest_preflight_evaluation?.attempt_id, blockerAttempt.id);
    assert.equal(runSummary?.latest_preflight_evaluation?.status, "failed");
    assert.equal(runSummary?.latest_preflight_evaluation?.failure_class, "preflight_blocked");
    assert.equal(
      runSummary?.latest_preflight_evaluation?.failure_code,
      "blocked_pnpm_verification_plan"
    );
    assert.ok(
      runSummary?.latest_preflight_evaluation_ref?.endsWith("artifacts/preflight-evaluation.json")
    );
    assert.equal(runSummary?.latest_runtime_verification?.attempt_id, attempt.id);
    assert.equal(runSummary?.latest_runtime_verification?.status, "passed");
    assert.equal(runSummary?.latest_runtime_verification?.verifier_kit, "api");
    assert.equal(runSummary?.latest_runtime_verification?.failure_class, null);
    assert.deepEqual(runSummary?.latest_runtime_verification?.changed_files, [
      "packages/orchestrator/src/index.ts"
    ]);
    assert.ok(
      runSummary?.latest_runtime_verification_ref?.endsWith("artifacts/runtime-verification.json")
    );
    assert.equal(runSummary?.latest_adversarial_verification?.attempt_id, attempt.id);
    assert.equal(runSummary?.latest_adversarial_verification?.status, "passed");
    assert.equal(runSummary?.latest_adversarial_verification?.verifier_kit, "api");
    assert.equal(runSummary?.latest_adversarial_verification?.verdict, "pass");
    assert.equal(runSummary?.latest_adversarial_verification?.failure_class, null);
    assert.deepEqual(runSummary?.latest_adversarial_verification?.output_refs, [
      adversarialOutputFile
    ]);
    assert.ok(
      runSummary?.latest_adversarial_verification_ref?.endsWith(
        "artifacts/adversarial-verification.json"
      )
    );
    assert.equal(runSummary?.latest_handoff_bundle?.attempt_id, blockerAttempt.id);
    assert.equal(runSummary?.latest_handoff_bundle?.failure_class, "preflight_blocked");
    assert.equal(
      runSummary?.latest_handoff_bundle?.failure_code,
      "blocked_pnpm_verification_plan"
    );
    assert.equal(
      runSummary?.latest_handoff_bundle?.summary,
      blockerFailureContext.message
    );
    assert.ok(
      runSummary?.latest_handoff_bundle_ref?.endsWith("artifacts/handoff_bundle.json")
    );
    assert.ok(
      runSummary?.latest_handoff_bundle?.source_refs.preflight_evaluation?.endsWith(
        "artifacts/preflight-evaluation.json"
      )
    );
    assert.equal(runSummary?.latest_handoff_bundle?.source_refs.adversarial_verification, null);
    assert.equal(runSummary?.latest_handoff_bundle?.adversarial_verification, null);
    assert.equal(runSummary?.run_brief?.latest_attempt_id, blockerAttempt.id);
    assert.equal(runSummary?.run_brief?.headline, settledHandoffRecoveryBlockedMessage);
    assert.equal(runSummary?.run_brief?.summary, blockerFailureContext.message);
    assert.equal(runSummary?.run_brief?.primary_focus, blockerAttempt.objective);
    assert.equal(runSummary?.run_brief?.failure_signal?.failure_class, "preflight_blocked");
    assert.equal(
      runSummary?.run_brief?.failure_signal?.failure_code,
      "blocked_pnpm_verification_plan"
    );
    assert.ok(runSummary?.run_brief_ref?.endsWith("run-brief.json"));
    assert.equal(runSummary?.run_brief_invalid_reason, null);
    assert.equal(runSummary?.run_brief_degraded.is_degraded, false);
    assert.ok(runSummary?.maintenance_plane_ref?.endsWith("artifacts/maintenance-plane.json"));
    assert.equal(runSummary?.maintenance_plane?.blocked_diagnosis.status, "attention");
    assert.ok(
      runSummary?.maintenance_plane?.outputs.some(
        (item) => item.key === "run_brief" && item.plane === "maintenance"
      )
    );
    assert.ok(
      runSummary?.maintenance_plane?.outputs.some(
        (item) => item.key === "policy_runtime" && item.plane === "maintenance"
      )
    );
    assert.ok(
      runSummary?.maintenance_plane?.outputs.some(
        (item) =>
          item.key === "verifier_summary" &&
          item.plane === "maintenance" &&
          item.status === "attention" &&
          item.ref?.endsWith("artifacts/preflight-evaluation.json") &&
          item.summary === blockerFailureContext.message
      )
    );
    assert.equal(runSummary?.task_focus, blockerAttempt.objective);
    assert.equal(invalidRunBriefSummary?.run_brief, null);
    assert.ok(invalidRunBriefSummary?.run_brief_ref?.endsWith("run-brief.json"));
    assert.match(
      invalidRunBriefSummary?.run_brief_invalid_reason ?? "",
      /json|parse|unexpected end/i
    );
    assert.equal(invalidRunBriefSummary?.run_brief_degraded.is_degraded, true);
    assert.equal(
      invalidRunBriefSummary?.run_brief_degraded.reason_code,
      "run_brief_unreadable"
    );
    assert.equal(
      invalidRunBriefSummary?.failure_signal?.failure_class,
      "run_brief_degraded"
    );
    assert.equal(
      invalidRunBriefSummary?.failure_signal?.summary,
      "run brief 文件不可读，控制面摘要已退化。"
    );
    assert.ok(
      invalidRunBriefSummary?.maintenance_plane?.outputs.some(
        (item) =>
          item.key === "run_brief" &&
          item.plane === "maintenance" &&
          item.status === "degraded" &&
          item.summary === "run brief 文件不可读，控制面摘要已退化。"
      )
    );
    assert.equal(writeFailedRunBriefSummary?.run_brief, null);
    assert.ok(writeFailedRunBriefSummary?.run_brief_ref?.endsWith("run-brief.json"));
    assert.match(
      writeFailedRunBriefSummary?.run_brief_invalid_reason ?? "",
      /EISDIR|directory/i
    );
    assert.equal(writeFailedRunBriefSummary?.run_brief_degraded.is_degraded, true);
    assert.equal(
      writeFailedRunBriefSummary?.run_brief_degraded.reason_code,
      "run_brief_write_failed"
    );
    assert.equal(
      writeFailedRunBriefSummary?.failure_signal?.failure_class,
      "run_brief_degraded"
    );
    assert.equal(
      writeFailedRunBriefSummary?.failure_signal?.summary,
      "run brief 写入失败，控制面摘要已退化。"
    );
    assert.ok(
      writeFailedRunBriefSummary?.maintenance_plane?.outputs.some(
        (item) =>
          item.key === "run_brief" &&
          item.plane === "maintenance" &&
          item.status === "degraded" &&
          item.summary === "run brief 写入失败，控制面摘要已退化。"
      )
    );
    assert.equal(missingRunBriefSummary?.run_brief, null);
    assert.equal(missingRunBriefSummary?.run_brief_ref, null);
    assert.equal(
      missingRunBriefSummary?.failure_signal?.failure_class,
      "preflight_blocked"
    );
    assert.equal(
      missingRunBriefSummary?.failure_signal?.failure_code,
      "blocked_pnpm_verification_plan"
    );
    assert.equal(
      missingRunBriefSummary?.failure_signal?.summary,
      missingRunBriefFailureReason
    );
    assert.equal(
      missingRunBriefSummary?.latest_preflight_evaluation?.attempt_id,
      missingRunBriefAttempt.id
    );
    assert.equal(
      missingRunBriefSummary?.latest_handoff_bundle?.attempt_id,
      missingRunBriefAttempt.id
    );
    assert.ok(
      missingRunBriefSummary?.maintenance_plane?.outputs.some(
        (item) => item.key === "run_brief" && item.plane === "maintenance"
      )
    );
    assert.ok(
      missingRunBriefSummary?.maintenance_plane?.outputs.some(
        (item) =>
          item.key === "verifier_summary" &&
          item.plane === "maintenance" &&
          item.status === "attention" &&
          item.ref?.endsWith("artifacts/preflight-evaluation.json") &&
          item.summary === missingRunBriefFailureReason
      )
    );
    assert.equal(
      missingRunBriefSummary?.maintenance_plane?.blocked_diagnosis.summary,
      missingRunBriefFailureReason
    );
    assert.ok(
      missingRunBriefSummary?.maintenance_plane?.blocked_diagnosis.source_ref?.endsWith(
        "artifacts/preflight-evaluation.json"
      )
    );

    const healthResponse = await app.inject({
      method: "GET",
      url: "/health"
    });
    assert.equal(healthResponse.statusCode, 200);
    const healthPayload = healthResponse.json() as {
      status: string;
      execution_adapter: {
        type: string;
        command: string;
        model: string | null;
      };
      degraded_run_count: number;
      degraded_runs: Array<{
        run_id: string;
        latest_attempt_id: string | null;
        status: string;
      }>;
    };
    assert.equal(healthPayload.status, "degraded");
    assert.equal(healthPayload.execution_adapter.type, "codex");
    assert.equal(healthPayload.execution_adapter.command, "codex");
    assert.equal(healthPayload.execution_adapter.model, null);
    assert.equal(healthPayload.degraded_run_count, 1);
    assert.deepEqual(
      healthPayload.degraded_runs.map((runHealth) => ({
        run_id: runHealth.run_id,
        latest_attempt_id: runHealth.latest_attempt_id,
        status: runHealth.status
      })),
      [
      {
        run_id: staleRun.id,
        latest_attempt_id: staleAttempt.id,
        status: "stale_running_attempt"
      }
      ]
    );

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

  const idleRootDir = await createTrackedVerifyTempDir(
    "aisa-run-detail-api-idle-"
  );
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
  } finally {
    await cleanupTrackedVerifyTempDirs();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
