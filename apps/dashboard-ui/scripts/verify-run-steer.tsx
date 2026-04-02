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
  failure_signal: null,
  latest_preflight_evaluation: null,
  latest_preflight_evaluation_ref: null,
  latest_handoff_bundle: null,
  latest_handoff_bundle_ref: null,
  run_brief: null,
  run_brief_ref: null,
  working_context: null,
  working_context_ref: null,
  working_context_degraded: {
    is_degraded: false,
    reason_code: null,
    summary: null
  },
  run_health: null,
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
