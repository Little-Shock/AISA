import assert from "node:assert/strict";

const { countRunsByFocusLens, runMatchesFocusLens } = await import(
  new URL("../apps/dashboard-ui/app/dashboard-helpers.ts", import.meta.url).href
);

const nowTs = Date.parse("2026-04-04T02:00:00.000Z");

function createBaseRun() {
  return {
    run: {
      id: "run_test",
      title: "test run",
      description: "verify helper behavior",
      workspace_root: "/tmp/aisa",
      harness_profile: {
        version: 1,
        execution: { effort: "medium", default_verifier_kit: "repo" },
        reviewer: { effort: "medium" },
        synthesizer: { effort: "medium" },
        gates: {
          preflight_review: { mode: "required" },
          deterministic_runtime: { mode: "required" },
          postflight_adversarial: { mode: "required" }
        },
        slots: {
          research_or_planning: { binding: "codex" },
          execution: { binding: "codex" },
          preflight_review: { binding: "codex" },
          postflight_review: { binding: "codex" },
          final_synthesis: { binding: "codex" }
        }
      },
      created_at: "2026-04-04T01:00:00.000Z"
    },
    current: {
      run_status: "completed",
      latest_attempt_id: "attempt_1",
      recommended_next_action: null,
      recommended_attempt_type: null,
      summary: "legacy summary",
      blocking_reason: null,
      waiting_for_human: false,
      updated_at: "2026-04-04T01:10:00.000Z"
    },
    automation: null,
    governance: null,
    policy_runtime: {
      run_id: "run_test",
      stage: "execution",
      approval_status: "approved",
      approval_required: false,
      proposed_signature: null,
      proposed_attempt_type: null,
      proposed_objective: null,
      proposed_success_criteria: [],
      permission_profile: "workspace_write",
      hook_policy: "default",
      danger_mode: "default",
      killswitch_active: false,
      killswitch_reason: null,
      blocking_reason: null,
      last_decision: null,
      approval_requested_at: null,
      approval_decided_at: null,
      approval_actor: null,
      approval_note: null,
      source_attempt_id: "attempt_1",
      source_ref: "policy-runtime/test.json",
      updated_at: "2026-04-04T01:10:00.000Z"
    },
    policy_runtime_ref: "policy-runtime/test.json",
    policy_runtime_invalid_reason: null,
    failure_signal: null,
    latest_preflight_evaluation: null,
    latest_preflight_evaluation_ref: null,
    latest_runtime_verification: null,
    latest_runtime_verification_ref: null,
    latest_adversarial_verification: null,
    latest_adversarial_verification_ref: null,
    latest_handoff_bundle: null,
    latest_handoff_bundle_ref: null,
    run_brief: null,
    run_brief_ref: null,
    run_brief_invalid_reason: null,
    run_brief_degraded: {
      is_degraded: false,
      reason_code: null,
      summary: null,
      source_ref: null
    },
    maintenance_plane: null,
    maintenance_plane_ref: null,
    working_context: null,
    working_context_ref: null,
    working_context_degraded: {
      is_degraded: false,
      reason_code: null,
      summary: null
    },
    run_health: {
      status: "healthy",
      summary: "healthy",
      likely_zombie: false,
      stale_after_ms: 20_000,
      latest_attempt_id: "attempt_1",
      latest_attempt_status: "completed",
      latest_activity_at: "2026-04-04T01:15:00.000Z",
      latest_activity_age_ms: 1_000,
      heartbeat_at: "2026-04-04T01:15:00.000Z",
      heartbeat_age_ms: 1_000
    },
    harness_gates: {
      preflight_review: {
        gate: "preflight_review",
        title: "preflight",
        mode: "required",
        default_mode: "required",
        phase: "dispatch",
        enforced: true,
        source: "test",
        detail: "test",
        artifact_ref: "artifact/preflight.json"
      },
      deterministic_runtime: {
        gate: "deterministic_runtime",
        title: "runtime",
        mode: "required",
        default_mode: "required",
        phase: "runtime",
        enforced: true,
        source: "test",
        detail: "test",
        artifact_ref: "artifact/runtime.json"
      },
      postflight_adversarial: {
        gate: "postflight_adversarial",
        title: "postflight",
        mode: "required",
        default_mode: "required",
        phase: "postflight",
        enforced: true,
        source: "test",
        detail: "test",
        artifact_ref: "artifact/postflight.json"
      }
    },
    harness_slots: {
      research_or_planning: {
        slot: "research_or_planning",
        title: "research",
        binding: "codex",
        expected_binding: "codex",
        binding_status: "aligned",
        binding_matches_registry: true,
        source: "test",
        detail: "test",
        input_contract: [],
        permission_boundary: "read_only",
        output_artifacts: [],
        failure_semantics: "fail_closed"
      },
      execution: {
        slot: "execution",
        title: "execution",
        binding: "codex",
        expected_binding: "codex",
        binding_status: "aligned",
        binding_matches_registry: true,
        source: "test",
        detail: "test",
        input_contract: [],
        permission_boundary: "workspace_write",
        output_artifacts: [],
        failure_semantics: "fail_closed",
        default_verifier_kit: "repo"
      },
      preflight_review: {
        slot: "preflight_review",
        title: "preflight",
        binding: "codex",
        expected_binding: "codex",
        binding_status: "aligned",
        binding_matches_registry: true,
        source: "test",
        detail: "test",
        input_contract: [],
        permission_boundary: "read_only",
        output_artifacts: [],
        failure_semantics: "fail_closed"
      },
      postflight_review: {
        slot: "postflight_review",
        title: "postflight",
        binding: "codex",
        expected_binding: "codex",
        binding_status: "aligned",
        binding_matches_registry: true,
        source: "test",
        detail: "test",
        input_contract: [],
        permission_boundary: "read_only",
        output_artifacts: [],
        failure_semantics: "fail_closed"
      },
      final_synthesis: {
        slot: "final_synthesis",
        title: "synthesis",
        binding: "codex",
        expected_binding: "codex",
        binding_status: "aligned",
        binding_matches_registry: true,
        source: "test",
        detail: "test",
        input_contract: [],
        permission_boundary: "read_only",
        output_artifacts: [],
        failure_semantics: "fail_closed"
      }
    },
    default_verifier_kit_profile: {
      kit: "repo",
      title: "repo",
      detail: "repo",
      command_policy: "contract_locked_commands",
      preflight_expectations: [],
      runtime_expectations: [],
      adversarial_focus: [],
      source: "test"
    },
    effective_policy_bundle: {
      profile_version: 1,
      verification_discipline: {
        level: "strict",
        default_verifier_kit: "repo",
        command_policy: "contract_locked_commands",
        summary: "test",
        source_refs: []
      },
      operator_brief: {
        intensity: "normal",
        evidence_ref_budget: 0,
        summary_style: "short",
        source: "test",
        detail: "test"
      },
      maintenance_refresh: {
        strategy: "manual",
        refreshes_on_read: false,
        source: "test",
        detail: "test"
      },
      recovery: {
        active_run: "manual",
        settled_run: "manual",
        auto_resume_from_settled_handoff: false,
        source: "test",
        detail: "test"
      }
    },
    attempt_count: 1,
    latest_attempt: {
      id: "attempt_1",
      attempt_type: "execution",
      status: "completed",
      worker: "codex",
      objective: "verify",
      created_at: "2026-04-04T01:05:00.000Z",
      started_at: "2026-04-04T01:06:00.000Z",
      ended_at: "2026-04-04T01:15:00.000Z"
    },
    latest_attempt_runtime_state: null,
    latest_attempt_heartbeat: null,
    task_focus: "legacy focus",
    verification_command_count: 0
  };
}

function main(): void {
  const waitingHuman = {
    ...createBaseRun(),
    run_brief: {
      run_id: "run_test",
      status: "blocked",
      headline: "Need human decision",
      summary: "run brief summary",
      failure_signal: null,
      blocker_summary: "approve next execution",
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      waiting_for_human: true,
      automation_mode: "manual_only",
      latest_attempt_id: "attempt_1",
      primary_focus: "human approval",
      evidence_refs: [],
      updated_at: "2026-04-04T01:20:00.000Z"
    }
  };

  const runtimeRisk = {
    ...createBaseRun(),
    current: {
      ...createBaseRun().current,
      run_status: "running",
      updated_at: "2026-04-04T01:40:00.000Z"
    },
    latest_attempt: {
      ...createBaseRun().latest_attempt,
      status: "running",
      started_at: "2026-04-04T01:20:00.000Z",
      ended_at: null
    },
    latest_attempt_runtime_state: {
      running: true,
      phase: "tool",
      active_since: "2026-04-04T01:20:00.000Z",
      last_event_at: "2026-04-04T01:21:00.000Z",
      progress_text: "tool crashed",
      recent_activities: [],
      completed_steps: [],
      process_content: [],
      final_output: null,
      error: "toolchain missing",
      session_id: "sess_1",
      event_count: 2,
      updated_at: "2026-04-04T01:21:00.000Z"
    },
    latest_attempt_heartbeat: {
      status: "running",
      started_at: "2026-04-04T01:20:00.000Z",
      heartbeat_at: "2026-04-04T01:21:00.000Z",
      released_at: null
    }
  };

  const replayGap = {
    ...createBaseRun(),
    latest_attempt: {
      ...createBaseRun().latest_attempt,
      attempt_type: "execution"
    },
    verification_command_count: 0
  };

  const runs = [waitingHuman, runtimeRisk, replayGap];

  assert.equal(runMatchesFocusLens(waitingHuman, "waiting_human", nowTs), true);
  assert.equal(runMatchesFocusLens(runtimeRisk, "runtime_fault", nowTs), true);
  assert.equal(runMatchesFocusLens(replayGap, "replay_gap", nowTs), true);
  assert.equal(countRunsByFocusLens(runs, "waiting_human", nowTs), 1);
  assert.equal(countRunsByFocusLens(runs, "runtime_fault", nowTs), 1);
  assert.equal(countRunsByFocusLens(runs, "replay_gap", nowTs), 3);

  console.log(
    JSON.stringify(
      {
        status: "passed",
        waiting_human: countRunsByFocusLens(runs, "waiting_human", nowTs),
        runtime_fault: countRunsByFocusLens(runs, "runtime_fault", nowTs),
        replay_gap: countRunsByFocusLens(runs, "replay_gap", nowTs)
      },
      null,
      2
    )
  );
}

main();
