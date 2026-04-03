import assert from "node:assert/strict";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildServer } from "../../control-api/src/index.ts";
import { deriveRunOperatorState } from "../app/dashboard-helpers";
import type { RunDetail, RunSummaryItem } from "../app/dashboard-types";
import {
  RunOverviewPanel,
  RunPolicyPanel,
  RunVerificationPanel
} from "../app/run-detail-panels";
import { RunInboxPanel } from "../app/run-inbox";
import { seedWorkingContextDashboardFixture } from "../../../scripts/seed-working-context-dashboard-fixture.ts";
import {
  cleanupTrackedVerifyTempDirs,
  createTrackedVerifyTempDir
} from "../../../scripts/verify-temp.ts";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main(): Promise<void> {
  try {
    const runtimeDataRoot = await createTrackedVerifyTempDir(
      "aisa-dashboard-control-surface-"
    );
    const workspaceRoot = await createTrackedVerifyTempDir(
      "aisa-dashboard-control-workspace-"
    );
    const fixture = await seedWorkingContextDashboardFixture({
      runtimeDataRoot,
      workspaceRoot
    });
    const app = await buildServer({
      runtimeDataRoot,
      workspaceRoot,
      startOrchestrator: false
    });

    try {
    const detailResponse = await app.inject({
      method: "GET",
      url: `/runs/${fixture.run_id}`
    });
    assert.equal(detailResponse.statusCode, 200);
    const runDetail = detailResponse.json() as RunDetail;

    const runsResponse = await app.inject({
      method: "GET",
      url: "/runs"
    });
    assert.equal(runsResponse.statusCode, 200);
    const runsPayload = runsResponse.json() as {
      runs: RunSummaryItem[];
    };
    const selectedRun =
      runsPayload.runs.find((item) => item.run.id === fixture.run_id) ?? null;
    assert.ok(selectedRun, "summary payload should include the seeded run");

    assert.equal(
      runDetail.working_context_degraded.reason_code,
      fixture.expected_working_context_reason
    );
    assert.equal(runDetail.automation?.mode, fixture.expected_automation_mode);
    assert.equal(
      runDetail.run.harness_profile.execution.default_verifier_kit,
      fixture.expected_verifier_kit
    );
    assert.equal(
      runDetail.run.harness_profile.slots.execution.binding,
      "codex_cli_execution_worker"
    );
    assert.equal(runDetail.policy_runtime?.stage, fixture.expected_policy_stage);
    assert.equal(
      runDetail.policy_runtime?.approval_status,
      fixture.expected_policy_approval_status
    );
    assert.equal(runDetail.failure_signal?.failure_class, fixture.expected_failure_class);
    assert.equal(
      runDetail.failure_signal?.policy_mode,
      fixture.expected_failure_policy_mode
    );
    assert.equal(
      runDetail.latest_preflight_evaluation?.failure_reason,
      fixture.expected_preflight_failure_reason
    );
    assert.equal(
      runDetail.latest_preflight_evaluation?.failure_class,
      fixture.expected_failure_class
    );
    assert.equal(
      runDetail.latest_runtime_verification?.status,
      fixture.expected_latest_runtime_status
    );
    assert.equal(
      runDetail.latest_runtime_verification?.verifier_kit,
      fixture.expected_verifier_kit
    );
    assert.equal(
      runDetail.latest_adversarial_verification?.status,
      fixture.expected_latest_adversarial_status
    );
    assert.equal(
      runDetail.latest_adversarial_verification?.verifier_kit,
      fixture.expected_verifier_kit
    );
    assert.equal(runDetail.latest_handoff_bundle?.summary, fixture.expected_handoff_summary);
    assert.equal(
      runDetail.latest_handoff_bundle?.failure_class,
      fixture.expected_failure_class
    );
    assert.equal(runDetail.run_brief?.headline, fixture.expected_run_brief_headline);
    assert.equal(runDetail.run_brief?.summary, fixture.expected_run_brief_summary);
    assert.equal(
      runDetail.run_brief?.failure_signal?.failure_class,
      fixture.expected_failure_class
    );
    assert.equal(runDetail.maintenance_plane?.blocked_diagnosis.status, "attention");
    assert.ok(
      runDetail.maintenance_plane?.outputs.some(
        (item) => item.key === "run_brief" && item.plane === "maintenance"
      )
    );
    assert.ok(
      runDetail.maintenance_plane?.signal_sources.some(
        (item) => item.key === "handoff_bundle" && item.plane === "mainline"
      )
    );
    assert.equal(selectedRun?.task_focus, fixture.expected_task_focus);
    assert.equal(selectedRun?.failure_signal?.failure_class, fixture.expected_failure_class);
    assert.equal(
      selectedRun?.latest_runtime_verification?.status,
      fixture.expected_latest_runtime_status
    );
    assert.equal(
      selectedRun?.latest_runtime_verification?.verifier_kit,
      fixture.expected_verifier_kit
    );
    assert.equal(
      selectedRun?.latest_adversarial_verification?.status,
      fixture.expected_latest_adversarial_status
    );
    assert.equal(
      selectedRun?.latest_adversarial_verification?.verifier_kit,
      fixture.expected_verifier_kit
    );
    assert.equal(selectedRun?.maintenance_plane?.blocked_diagnosis.status, "attention");
    assert.equal(
      selectedRun?.policy_runtime?.approval_status,
      fixture.expected_policy_approval_status
    );

    const selectedRunAttemptDetail =
      runDetail.attempt_details.find(
        (item) => item.attempt.id === runDetail.current?.latest_attempt_id
      ) ??
      runDetail.attempt_details.at(-1) ??
      null;
    const nowTs = Date.now();
    const overviewMarkup = renderToStaticMarkup(
      <RunOverviewPanel
        runDetail={runDetail}
        selectedRun={selectedRun!}
        selectedRunOperatorState={deriveRunOperatorState(selectedRun!, nowTs)}
        selectedRunRuntimeState={selectedRunAttemptDetail?.runtime_state ?? null}
        selectedRunHeartbeat={selectedRunAttemptDetail?.heartbeat ?? null}
        selectedRunAttemptDetail={selectedRunAttemptDetail}
        selectedRunCurrentUpdatedAt={runDetail.current?.updated_at ?? null}
        nowTs={nowTs}
        dataState="live"
        liveStatusText="自动刷新正常"
        liveAttemptText="最近一次尝试已停下"
        refreshLabel="刷新"
        onRefresh={() => {}}
        lastSuccessAtLabel="刚刚"
      />
    );
    assert.match(overviewMarkup, /Run Brief/);
    assert.match(
      overviewMarkup,
      new RegExp(escapeRegExp(fixture.expected_run_brief_headline))
    );
    assert.match(
      overviewMarkup,
      new RegExp(escapeRegExp(fixture.expected_handoff_summary))
    );
    assert.match(
      overviewMarkup,
      new RegExp(escapeRegExp(fixture.expected_preflight_failure_reason))
    );
    assert.match(overviewMarkup, /统一失败信号/);
    assert.match(overviewMarkup, /preflight_blocked/);
    assert.match(overviewMarkup, /runtime replay：通过/);
    assert.match(overviewMarkup, /adversarial gate：通过/);
    assert.match(overviewMarkup, /控制面真相/);
    assert.match(overviewMarkup, /维护平面输出/);
    assert.match(overviewMarkup, /信号来源/);
    assert.match(overviewMarkup, /建议先读/);
    assert.match(overviewMarkup, /执行审批待处理/);

    const policyMarkup = renderToStaticMarkup(
      <RunPolicyPanel
        runDetail={runDetail}
        note=""
        onNoteChange={() => {}}
        onApprove={() => {}}
        onReject={() => {}}
        approveBusy={false}
        rejectBusy={false}
      />
    );
    assert.match(policyMarkup, /Policy Lane/);
    assert.match(policyMarkup, /批准 Execution/);
    assert.match(policyMarkup, /打回重规划/);
    assert.match(policyMarkup, /Harness 槽位/);
    assert.match(policyMarkup, /codex_cli_execution_worker/);
    assert.match(
      policyMarkup,
      new RegExp(escapeRegExp(`默认 verifier kit ${fixture.expected_verifier_kit}`))
    );

    const verificationMarkup = renderToStaticMarkup(
      <RunVerificationPanel selectedRunAttemptDetail={selectedRunAttemptDetail} />
    );
    assert.match(verificationMarkup, /Verification Lane/);
    assert.match(verificationMarkup, /验证套件/);
    assert.match(
      verificationMarkup,
      new RegExp(escapeRegExp(fixture.expected_verifier_kit))
    );

    const inboxMarkup = renderToStaticMarkup(
      <RunInboxPanel
        runs={runsPayload.runs}
        nowTs={nowTs}
        selectedRunId={fixture.run_id}
        activeFilter="all"
        focusLens="all"
        onFilterChange={() => {}}
        onFocusLensChange={() => {}}
        onSelectRun={() => {}}
      />
    );
    assert.match(
      inboxMarkup,
      new RegExp(escapeRegExp(fixture.expected_run_brief_headline))
    );
    assert.match(
      inboxMarkup,
      new RegExp(escapeRegExp(fixture.expected_run_brief_summary))
    );
    assert.match(
      inboxMarkup,
      new RegExp(escapeRegExp(fixture.expected_preflight_failure_reason))
    );

    console.log(
      JSON.stringify(
        {
          status: "passed",
          run_id: fixture.run_id,
          attempt_id: fixture.attempt_id,
          working_context_reason: runDetail.working_context_degraded.reason_code,
          run_brief_headline: runDetail.run_brief?.headline ?? null,
          preflight_failure_reason:
            runDetail.latest_preflight_evaluation?.failure_reason ?? null
        },
        null,
        2
      )
    );
    } finally {
      await app.close();
    }
  } finally {
    await cleanupTrackedVerifyTempDirs();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
