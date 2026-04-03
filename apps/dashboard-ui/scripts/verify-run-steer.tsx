import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSteerPanel } from "../app/run-detail-panels";
import type { RunDetail } from "../app/dashboard-types";
import {
  RUN_STEER_NEXT_PICKUP_VALUE,
  createRunSteerTargetOptions,
  defaultRunSteerAttemptId,
  normalizeRunSteerAttemptId
} from "../app/run-steer";

const fixtureNow = "2026-04-01T16:00:00.000Z";

const fixtureRunDetail: RunDetail = {
  run: {
    id: "run_fixture",
    title: "Run steer regression fixture",
    description: "Ensure next pickup steer stays selectable without crashing the UI.",
    workspace_root: "/tmp/aisa-fixture",
    owner_id: "fixture-owner",
    harness_profile: {
      version: 3,
      execution: {
        effort: "medium",
        default_verifier_kit: "repo"
      },
      reviewer: {
        effort: "medium"
      },
      synthesizer: {
        effort: "medium"
      },
      gates: {
        preflight_review: {
          mode: "required"
        },
        deterministic_runtime: {
          mode: "required"
        },
        postflight_adversarial: {
          mode: "required"
        }
      },
      slots: {
        research_or_planning: {
          binding: "codex_cli_research_worker"
        },
        execution: {
          binding: "codex_cli_execution_worker"
        },
        preflight_review: {
          binding: "attempt_dispatch_preflight"
        },
        postflight_review: {
          binding: "attempt_adversarial_verification"
        },
        final_synthesis: {
          binding: "attempt_evaluation_synthesizer"
        }
      }
    },
    success_criteria: ["Render the steer panel."],
    constraints: [],
    created_at: fixtureNow,
    updated_at: fixtureNow
  },
  current: {
    run_status: "waiting_steer",
    best_attempt_id: "att_fixture",
    latest_attempt_id: "att_fixture",
    recommended_next_action: "apply_steer",
    recommended_attempt_type: "execution",
    summary: "Use the next pickup sentinel when no specific attempt is targeted.",
    blocking_reason: null,
    waiting_for_human: true,
    updated_at: fixtureNow
  },
  automation: null,
  governance: null,
  policy_runtime: null,
  policy_runtime_ref: null,
  policy_runtime_invalid_reason: null,
  policy_activity: [],
  policy_activity_ref: null,
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
  maintenance_plane: null,
  maintenance_plane_ref: null,
  working_context: null,
  working_context_ref: null,
  working_context_degraded: {
    is_degraded: false,
    reason_code: null,
    summary: null
  },
  run_health: null,
  harness_gates: {
    preflight_review: {
      gate: "preflight_review",
      title: "Preflight Gate",
      mode: "required",
      default_mode: "required",
      phase: "dispatch",
      enforced: true,
      source: "run.harness_profile.gates.preflight_review.mode",
      detail: "Shadow dispatch gate before execution.",
      artifact_ref: "artifacts/preflight-evaluation.json"
    },
    deterministic_runtime: {
      gate: "deterministic_runtime",
      title: "Deterministic Runtime Gate",
      mode: "required",
      default_mode: "required",
      phase: "runtime",
      enforced: true,
      source: "run.harness_profile.gates.deterministic_runtime.mode",
      detail: "Replay locked deterministic verification after execution.",
      artifact_ref: "artifacts/runtime-verification.json"
    },
    postflight_adversarial: {
      gate: "postflight_adversarial",
      title: "Postflight Adversarial Gate",
      mode: "required",
      default_mode: "required",
      phase: "postflight",
      enforced: true,
      source: "run.harness_profile.gates.postflight_adversarial.mode",
      detail: "Read-only adversarial gate after deterministic replay.",
      artifact_ref: "artifacts/adversarial-verification.json"
    }
  },
  harness_slots: {
    research_or_planning: {
      slot: "research_or_planning",
      title: "Research Or Planning",
      binding: "codex_cli_research_worker",
      expected_binding: "codex_cli_research_worker",
      binding_status: "aligned",
      binding_matches_registry: true,
      source: "run.harness_profile.slots.research_or_planning.binding",
      detail: "Read-only research and planning.",
      input_contract: ["run summary"],
      permission_boundary: "read_only",
      output_artifacts: ["result.json"],
      failure_semantics: "fail_open"
    },
    execution: {
      slot: "execution",
      title: "Execution",
      binding: "codex_cli_execution_worker",
      expected_binding: "codex_cli_execution_worker",
      binding_status: "aligned",
      binding_matches_registry: true,
      source: "run.harness_profile.slots.execution.binding",
      detail: "Workspace-writing execution.",
      input_contract: ["attempt_contract.json"],
      permission_boundary: "workspace_write",
      output_artifacts: ["result.json"],
      failure_semantics: "fail_closed",
      default_verifier_kit: "repo"
    },
    preflight_review: {
      slot: "preflight_review",
      title: "Preflight Review",
      binding: "attempt_dispatch_preflight",
      expected_binding: "attempt_dispatch_preflight",
      binding_status: "aligned",
      binding_matches_registry: true,
      source: "run.harness_profile.slots.preflight_review.binding",
      detail: "Pre-dispatch gate.",
      input_contract: ["attempt_contract.json"],
      permission_boundary: "read_only",
      output_artifacts: ["artifacts/preflight-evaluation.json"],
      failure_semantics: "fail_closed"
    },
    postflight_review: {
      slot: "postflight_review",
      title: "Postflight Review",
      binding: "attempt_adversarial_verification",
      expected_binding: "attempt_adversarial_verification",
      binding_status: "aligned",
      binding_matches_registry: true,
      source: "run.harness_profile.slots.postflight_review.binding",
      detail: "Adversarial verification gate.",
      input_contract: ["artifacts/runtime-verification.json"],
      permission_boundary: "read_only",
      output_artifacts: ["artifacts/adversarial-verification.json"],
      failure_semantics: "fail_closed"
    },
    final_synthesis: {
      slot: "final_synthesis",
      title: "Final Synthesis",
      binding: "attempt_evaluation_synthesizer",
      expected_binding: "attempt_evaluation_synthesizer",
      binding_status: "aligned",
      binding_matches_registry: true,
      source: "run.harness_profile.slots.final_synthesis.binding",
      detail: "Final evaluation and handoff shaping.",
      input_contract: ["review packet"],
      permission_boundary: "control_plane_only",
      output_artifacts: ["evaluation.json"],
      failure_semantics: "fail_closed"
    }
  },
  default_verifier_kit_profile: {
    kit: "repo",
    title: "Repository Task",
    detail:
      "Repository-facing execution can infer replay from local workspace scripts when the repo toolchain is already present.",
    command_policy: "workspace_script_inference",
    preflight_expectations: ["Read package.json scripts before auto-inferring replay commands."],
    runtime_expectations: ["Replay deterministic workspace scripts or contract-locked commands from the repo root."],
    adversarial_focus: ["Probe repo-local toolchain assumptions and replay drift."],
    source: "run.harness_profile.execution.default_verifier_kit"
  },
  effective_policy_bundle: {
    profile_version: 3,
    verification_discipline: {
      level: "deterministic_plus_adversarial",
      default_verifier_kit: "repo",
      command_policy: "workspace_script_inference",
      summary: "Fixture profile keeps deterministic replay plus adversarial verification.",
      source_refs: [
        "run.harness_profile.gates.preflight_review.mode",
        "run.harness_profile.gates.deterministic_runtime.mode",
        "run.harness_profile.gates.postflight_adversarial.mode",
        "run.harness_profile.execution.default_verifier_kit"
      ]
    },
    operator_brief: {
      intensity: "standard",
      evidence_ref_budget: 6,
      summary_style: "headline_plus_focus",
      source: "run.harness_profile.synthesizer.effort",
      detail: "Fixture synthesizer effort keeps the brief concise but useful."
    },
    maintenance_refresh: {
      strategy: "live_recompute",
      refreshes_on_read: true,
      source: "run.harness_profile.reviewer.effort",
      detail: "Fixture reviewer effort keeps maintenance reads live."
    },
    recovery: {
      active_run: "working_context_first",
      settled_run: "handoff_first",
      auto_resume_from_settled_handoff: true,
      source: "run.harness_profile.reviewer.effort",
      detail: "Fixture reviewer effort allows settled handoff recovery."
    }
  },
  attempts: [
    {
      id: "att_fixture",
      attempt_type: "execution",
      status: "waiting_steer",
      worker: "codex",
      objective: "Render run steer panel.",
      success_criteria: ["No runtime crash."],
      workspace_root: "/tmp/aisa-fixture",
      created_at: fixtureNow,
      started_at: null,
      ended_at: null
    }
  ],
  attempt_details: [],
  steers: [
    {
      id: "steer_fixture",
      content: "Prefer the next pickup target when resuming the run.",
      status: "queued",
      attempt_id: null,
      created_at: fixtureNow
    }
  ],
  journal: [],
  report: ""
};

function main(): void {
  const options = createRunSteerTargetOptions(fixtureRunDetail.attempts);
  assert.equal(options[0]?.value, RUN_STEER_NEXT_PICKUP_VALUE);
  assert.equal(options[0]?.label, "应用到下一次 pickup");
  assert.ok(
    options.every((option) => option.value.length > 0),
    "run steer options should never include an empty select value"
  );
  assert.equal(defaultRunSteerAttemptId(null), RUN_STEER_NEXT_PICKUP_VALUE);
  assert.equal(normalizeRunSteerAttemptId(RUN_STEER_NEXT_PICKUP_VALUE), null);
  assert.equal(normalizeRunSteerAttemptId("att_fixture"), "att_fixture");

  const nextPickupMarkup = renderToStaticMarkup(
    <RunSteerPanel
      runDetail={fixtureRunDetail}
      selectedRunAttemptDetail={null}
      steerText="Keep going"
      steerAttemptId={RUN_STEER_NEXT_PICKUP_VALUE}
      onSteerTextChange={() => {}}
      onSteerAttemptChange={() => {}}
      onSubmit={() => {}}
      busy={false}
    />
  );
  assert.match(nextPickupMarkup, /Run Steer/);
  assert.match(nextPickupMarkup, /加入 Run Steer 队列/);

  const concreteAttemptMarkup = renderToStaticMarkup(
    <RunSteerPanel
      runDetail={fixtureRunDetail}
      selectedRunAttemptDetail={null}
      steerText="Keep going"
      steerAttemptId="att_fixture"
      onSteerTextChange={() => {}}
      onSteerAttemptChange={() => {}}
      onSubmit={() => {}}
      busy={false}
    />
  );
  assert.match(concreteAttemptMarkup, /Prefer the next pickup target when resuming the run\./);

  console.log(
    JSON.stringify(
      {
        status: "passed",
        next_pickup_value: RUN_STEER_NEXT_PICKUP_VALUE,
        option_count: options.length
      },
      null,
      2
    )
  );
}

main();
