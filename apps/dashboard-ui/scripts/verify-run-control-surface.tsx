import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDefaultRunHarnessProfile } from "../../../packages/domain/src/index.ts";
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

const DEFAULT_EXECUTION_SLOT_BINDING =
  createDefaultRunHarnessProfile().slots.execution.binding;

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
      startOrchestrator: false,
      allowedProjectRoots: [workspaceRoot]
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
    assert.equal(runDetail.working_context?.version, 1);
    assert.ok(runDetail.working_context?.source_snapshot.current.ref?.endsWith("current.json"));
    assert.ok(
      runDetail.working_context?.source_snapshot.automation.ref?.endsWith("automation.json")
    );
    assert.ok(
      runDetail.working_context?.source_snapshot.latest_attempt.ref?.endsWith(
        `/attempts/${fixture.attempt_id}/meta.json`
      )
    );
    assert.equal(
      runDetail.working_context?.source_snapshot.latest_attempt.attempt_id,
      fixture.attempt_id
    );
    assert.equal(runDetail.automation?.mode, fixture.expected_automation_mode);
    assert.equal(runDetail.run.harness_profile.version, 3);
    assert.equal(
      runDetail.run.harness_profile.execution.default_verifier_kit,
      fixture.expected_verifier_kit
    );
    assert.equal(runDetail.run.harness_profile.gates.preflight_review.mode, "required");
    assert.equal(
      runDetail.run.harness_profile.gates.deterministic_runtime.mode,
      "required"
    );
    assert.equal(
      runDetail.run.harness_profile.gates.postflight_adversarial.mode,
      "required"
    );
    assert.equal(
      runDetail.run.harness_profile.slots.execution.binding,
      DEFAULT_EXECUTION_SLOT_BINDING
    );
    assert.equal(runDetail.harness_gates.preflight_review.mode, "required");
    assert.equal(runDetail.harness_gates.preflight_review.enforced, true);
    assert.equal(runDetail.harness_gates.preflight_review.phase, "dispatch");
    assert.equal(runDetail.harness_gates.deterministic_runtime.mode, "required");
    assert.equal(runDetail.harness_gates.deterministic_runtime.phase, "runtime");
    assert.equal(runDetail.harness_gates.postflight_adversarial.mode, "required");
    assert.equal(runDetail.harness_gates.postflight_adversarial.enforced, true);
    assert.equal(
      runDetail.harness_gates.postflight_adversarial.artifact_ref,
      "artifacts/adversarial-verification.json"
    );
    assert.equal(
      runDetail.harness_slots.execution.binding,
      runDetail.run.harness_profile.slots.execution.binding
    );
    assert.equal(
      runDetail.harness_slots.execution.expected_binding,
      DEFAULT_EXECUTION_SLOT_BINDING
    );
    assert.equal(runDetail.harness_slots.execution.binding_status, "aligned");
    assert.equal(runDetail.harness_slots.execution.permission_boundary, "workspace_write");
    assert.deepEqual(runDetail.harness_slots.execution.output_artifacts, [
      "result.json",
      "worker-declared artifacts under artifacts/"
    ]);
    assert.equal(runDetail.harness_slots.execution.failure_semantics, "fail_closed");
    assert.equal(
      runDetail.harness_slots.execution.default_verifier_kit,
      fixture.expected_verifier_kit
    );
    assert.equal(runDetail.harness_slots.preflight_review.permission_boundary, "read_only");
    assert.deepEqual(runDetail.harness_slots.preflight_review.output_artifacts, [
      "artifacts/preflight-evaluation.json"
    ]);
    assert.equal(runDetail.harness_slots.preflight_review.failure_semantics, "fail_closed");
    assert.equal(runDetail.default_verifier_kit_profile.kit, fixture.expected_verifier_kit);
    assert.equal(runDetail.default_verifier_kit_profile.title, "Web App Task");
    assert.equal(
      runDetail.default_verifier_kit_profile.command_policy,
      "contract_locked_commands"
    );
    assert.equal(
      runDetail.default_verifier_kit_profile.source,
      "run.harness_profile.execution.default_verifier_kit"
    );
    assert.equal(
      runDetail.effective_policy_bundle.verification_discipline.level,
      "deterministic_plus_adversarial"
    );
    assert.equal(runDetail.effective_policy_bundle.operator_brief.intensity, "standard");
    assert.equal(
      runDetail.effective_policy_bundle.maintenance_refresh.strategy,
      "live_recompute"
    );
    assert.equal(runDetail.effective_policy_bundle.recovery.settled_run, "handoff_first");
    assert.equal(runDetail.policy_runtime?.stage, fixture.expected_policy_stage);
    assert.equal(
      runDetail.policy_runtime?.approval_status,
      fixture.expected_policy_approval_status
    );
    assert.equal(
      runDetail.policy_runtime?.proposed_signature,
      fixture.expected_policy_signature
    );
    assert.equal(runDetail.policy_runtime_invalid_reason, null);
    assert.equal(runDetail.policy_activity[0]?.headline, fixture.expected_policy_activity_headline);
    assert.equal(
      runDetail.policy_activity[0]?.proposed_signature,
      fixture.expected_policy_signature
    );
    assert.equal(runDetail.failure_signal?.failure_class, fixture.expected_failure_class);
    assert.equal(runDetail.failure_signal?.failure_code, fixture.expected_failure_code);
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
    assert.equal(
      runDetail.latest_handoff_bundle?.failure_code,
      fixture.expected_failure_code
    );
    assert.equal(runDetail.run_brief?.headline, fixture.expected_run_brief_headline);
    assert.equal(runDetail.run_brief?.summary, fixture.expected_run_brief_summary);
    assert.equal(runDetail.run_brief_invalid_reason, null);
    assert.equal(runDetail.run_brief_degraded.is_degraded, true);
    assert.equal(
      runDetail.run_brief_degraded.reason_code,
      fixture.expected_run_brief_degraded_reason
    );
    assert.equal(
      runDetail.run_brief?.failure_signal?.failure_class,
      fixture.expected_failure_class
    );
    assert.equal(
      runDetail.run_brief?.failure_signal?.failure_code,
      fixture.expected_failure_code
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
    assert.equal(selectedRun?.run_brief_invalid_reason, null);
    assert.equal(selectedRun?.run_brief_degraded.is_degraded, true);
    assert.equal(
      selectedRun?.run_brief_degraded.reason_code,
      fixture.expected_run_brief_degraded_reason
    );
    assert.equal(selectedRun?.failure_signal?.failure_class, fixture.expected_failure_class);
    assert.equal(selectedRun?.failure_signal?.failure_code, fixture.expected_failure_code);
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
    assert.equal(
      selectedRun?.harness_slots.execution.default_verifier_kit,
      fixture.expected_verifier_kit
    );
    assert.equal(selectedRun?.harness_gates.preflight_review.mode, "required");
    assert.equal(selectedRun?.harness_gates.deterministic_runtime.enforced, true);
    assert.equal(selectedRun?.harness_gates.postflight_adversarial.phase, "postflight");
    assert.equal(selectedRun?.harness_slots.execution.binding_status, "aligned");
    assert.equal(
      selectedRun?.harness_slots.final_synthesis.permission_boundary,
      "control_plane_only"
    );
    assert.equal(selectedRun?.default_verifier_kit_profile.kit, fixture.expected_verifier_kit);
    assert.equal(
      selectedRun?.default_verifier_kit_profile.command_policy,
      "contract_locked_commands"
    );
    assert.equal(selectedRun?.effective_policy_bundle.operator_brief.intensity, "standard");
    assert.equal(
      selectedRun?.effective_policy_bundle.maintenance_refresh.strategy,
      "live_recompute"
    );
    assert.equal(selectedRun?.effective_policy_bundle.recovery.settled_run, "handoff_first");

    const selectedRunAttemptDetail =
      runDetail.attempt_details.find(
        (item) => item.attempt.id === runDetail.current?.latest_attempt_id
      ) ??
      runDetail.attempt_details.at(-1) ??
      null;
    assert.equal(
      selectedRunAttemptDetail?.effective_verifier_kit_profile?.kit,
      fixture.expected_verifier_kit
    );
    assert.equal(
      selectedRunAttemptDetail?.effective_verifier_kit_profile?.title,
      "Web App Task"
    );
    assert.equal(
      selectedRunAttemptDetail?.effective_verifier_kit_profile?.command_policy,
      "contract_locked_commands"
    );
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
    assert.match(overviewMarkup, /处理建议/);
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
    assert.match(overviewMarkup, /需要处理：是/);
    assert.match(overviewMarkup, /交接建议：需要处理/);
    assert.doesNotMatch(overviewMarkup, /等待人工：/);
    assert.match(overviewMarkup, /控制面真相/);
    assert.match(overviewMarkup, /维护平面输出/);
    assert.match(overviewMarkup, /信号来源/);
    assert.match(overviewMarkup, /建议先读/);
    assert.match(overviewMarkup, /执行审批待处理/);
    assert.match(overviewMarkup, /现场版本：v1/);
    assert.match(overviewMarkup, /现场来源水位/);
    assert.match(overviewMarkup, /current：.*current\.json/);
    assert.match(overviewMarkup, /automation：.*automation\.json/);
    assert.match(overviewMarkup, /latest attempt：.*meta\.json/);
    const handoffCalloutIndex = overviewMarkup.indexOf("先看交接说明");
    const preflightCalloutIndex = overviewMarkup.indexOf("先看发车前结果");
    const workingContextCalloutIndex = overviewMarkup.indexOf("先看现场记录");
    assert.ok(handoffCalloutIndex >= 0, "overview should render the handoff callout");
    assert.ok(preflightCalloutIndex >= 0, "overview should render the preflight callout");
    assert.ok(
      workingContextCalloutIndex >= 0,
      "overview should render the working-context callout"
    );
    assert.ok(
      handoffCalloutIndex < workingContextCalloutIndex,
      "handoff callout must stay ahead of working-context callout"
    );
    assert.ok(
      preflightCalloutIndex < workingContextCalloutIndex,
      "preflight callout must stay ahead of working-context callout"
    );

    const policyMarkup = renderToStaticMarkup(
      <RunPolicyPanel
        runDetail={runDetail}
        note=""
        onNoteChange={() => {}}
        onApprove={() => {}}
        onReject={() => {}}
        onEnableKillswitch={() => {}}
        onClearKillswitch={() => {}}
        approveBusy={false}
        rejectBusy={false}
        killswitchEnableBusy={false}
        killswitchClearBusy={false}
      />
    );
    assert.match(policyMarkup, /Policy Lane/);
    assert.match(policyMarkup, /批准 Execution/);
    assert.match(policyMarkup, /打回重规划/);
    assert.match(policyMarkup, /开启 Killswitch/);
    assert.match(policyMarkup, /清除 Killswitch/);
    assert.match(policyMarkup, /Harness Profile/);
    assert.match(policyMarkup, /Effective Policy Bundle/);
    assert.match(policyMarkup, /Preflight Gate/);
    assert.match(policyMarkup, /Deterministic Runtime Gate/);
    assert.match(policyMarkup, /Postflight Adversarial Gate/);
    assert.match(policyMarkup, /postflight adversarial gate：硬门/);
    assert.match(policyMarkup, /operator brief intensity: standard/);
    assert.match(policyMarkup, /maintenance refresh: live_recompute/);
    assert.match(policyMarkup, /settled recovery: handoff_first/);
    assert.match(policyMarkup, /待批执行契约/);
    assert.match(policyMarkup, /最近策略活动/);
    assert.match(
      policyMarkup,
      new RegExp(escapeRegExp(fixture.expected_policy_signature))
    );
    assert.match(
      policyMarkup,
      new RegExp(escapeRegExp(fixture.expected_policy_activity_headline))
    );
    assert.match(policyMarkup, /Registry Contract/);
    assert.match(
      policyMarkup,
      new RegExp(escapeRegExp(DEFAULT_EXECUTION_SLOT_BINDING))
    );
    assert.match(policyMarkup, /binding status: aligned/);
    assert.match(policyMarkup, /permission boundary: workspace_write/);
    assert.match(policyMarkup, /failure semantics: fail_closed/);
    assert.match(policyMarkup, /Output Artifacts/);
    assert.match(policyMarkup, /Default Verifier Kit/);
    assert.match(policyMarkup, /Web App Task/);
    assert.match(policyMarkup, /Contract Locked Commands/);
    assert.match(
      policyMarkup,
      new RegExp(escapeRegExp(`default verifier kit: ${fixture.expected_verifier_kit}`))
    );

    const verificationMarkup = renderToStaticMarkup(
      <RunVerificationPanel selectedRunAttemptDetail={selectedRunAttemptDetail} />
    );
    assert.match(verificationMarkup, /Verification Lane/);
    assert.match(verificationMarkup, /验证套件/);
    assert.match(verificationMarkup, /Verifier Kit Contract/);
    assert.match(verificationMarkup, /Web App Task/);
    assert.match(verificationMarkup, /Contract Locked Commands/);
    assert.match(
      verificationMarkup,
      /attempt_contract\.verifier_kit|run\.harness_profile\.execution\.default_verifier_kit/
    );
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
      /接球：需要人工/
    );
    assert.match(inboxMarkup, /需要处理/);
    assert.doesNotMatch(inboxMarkup, /交接建议：等待人工/);
    assert.match(
      inboxMarkup,
      /统一失败：preflight_blocked \(blocked_pnpm_verification_plan\)/
    );
    assert.match(
      inboxMarkup,
      /对抗门：required，未进入/
    );
    assert.match(
      inboxMarkup,
      new RegExp(escapeRegExp(`焦点：${fixture.expected_task_focus.slice(0, 18)}`))
    );
    assert.match(
      inboxMarkup,
      new RegExp(escapeRegExp(fixture.expected_preflight_failure_reason))
    );

    const attachedProjectRoot = join(workspaceRoot, "attached-node-project");
    await writeNodeProjectFixture(attachedProjectRoot);
    await initializeGitRepo(attachedProjectRoot);
    const attachProjectResponse = await app.inject({
      method: "POST",
      url: "/projects/attach",
      payload: {
        workspace_root: attachedProjectRoot,
        owner_id: "dashboard-project-owner"
      }
    });
    assert.equal(attachProjectResponse.statusCode, 201);
    const attachedProjectPayload = attachProjectResponse.json() as {
      project: {
        id: string;
        title: string;
      };
      recommended_stack_pack: {
        title: string;
      };
      capability_snapshot: {
        overall_status: string;
      };
    };
    assert.equal(attachedProjectPayload.capability_snapshot.overall_status, "degraded");
    const attachedRunCreateResponse = await app.inject({
      method: "POST",
      url: `/projects/${attachedProjectPayload.project.id}/runs`,
      payload: {
        owner_id: "dashboard-project-owner"
      }
    });
    assert.equal(attachedRunCreateResponse.statusCode, 201);
    const attachedRunCreatePayload = attachedRunCreateResponse.json() as {
      run: {
        id: string;
        attached_project_id: string | null;
        attached_project_stack_pack_id: string | null;
        attached_project_task_preset_id: string | null;
      };
    };
    assert.equal(
      attachedRunCreatePayload.run.attached_project_id,
      attachedProjectPayload.project.id
    );
    assert.equal(attachedRunCreatePayload.run.attached_project_stack_pack_id, "node_backend");
    assert.equal(attachedRunCreatePayload.run.attached_project_task_preset_id, "bugfix");
    const attachedDetailResponse = await app.inject({
      method: "GET",
      url: `/runs/${attachedRunCreatePayload.run.id}`
    });
    assert.equal(attachedDetailResponse.statusCode, 200);
    const attachedRunDetail = attachedDetailResponse.json() as RunDetail;
    assert.equal(
      attachedRunDetail.attached_project?.project.id,
      attachedProjectPayload.project.id
    );
    assert.equal(
      attachedRunDetail.attached_project?.recommended_stack_pack.id,
      "node_backend"
    );
    assert.equal(attachedRunDetail.recovery_guidance?.path, "first_attempt");
    const attachedRunsResponse = await app.inject({
      method: "GET",
      url: "/runs"
    });
    assert.equal(attachedRunsResponse.statusCode, 200);
    const attachedRunsPayload = attachedRunsResponse.json() as {
      runs: RunSummaryItem[];
    };
    const attachedSelectedRun =
      attachedRunsPayload.runs.find(
        (item) => item.run.id === attachedRunCreatePayload.run.id
      ) ?? null;
    assert.ok(attachedSelectedRun, "attached project run should appear in summary payload");
    const attachedOverviewMarkup = renderToStaticMarkup(
      <RunOverviewPanel
        runDetail={attachedRunDetail}
        selectedRun={attachedSelectedRun}
        selectedRunOperatorState={deriveRunOperatorState(attachedSelectedRun, nowTs)}
        selectedRunRuntimeState={null}
        selectedRunHeartbeat={null}
        selectedRunAttemptDetail={null}
        selectedRunCurrentUpdatedAt={attachedRunDetail.current?.updated_at ?? null}
        nowTs={nowTs}
        dataState="live"
        liveStatusText="自动刷新正常"
        liveAttemptText="当前没有进行中的尝试"
        refreshLabel="刷新"
        onRefresh={() => {}}
        lastSuccessAtLabel="刚刚"
      />
    );
    assert.match(attachedOverviewMarkup, /先看项目上下文/);
    assert.match(
      attachedOverviewMarkup,
      new RegExp(escapeRegExp(attachedProjectPayload.project.title))
    );
    assert.match(
      attachedOverviewMarkup,
      new RegExp(escapeRegExp(attachedProjectPayload.recommended_stack_pack.title))
    );
    assert.match(attachedOverviewMarkup, /Bugfix/);
    assert.match(attachedOverviewMarkup, /接入项目/);
    assert.match(attachedOverviewMarkup, /项目接入事实/);
    assert.match(attachedOverviewMarkup, /项目能力与恢复/);
    assert.match(attachedOverviewMarkup, /项目基线引用/);
    assert.match(attachedOverviewMarkup, /关键文件引用/);
    assert.match(attachedOverviewMarkup, /恢复路径：首次发车/);
    assert.match(attachedOverviewMarkup, /能力状态：降级/);
    assert.match(attachedOverviewMarkup, /package\.json/);
    assert.match(attachedOverviewMarkup, /capability-snapshot\.json/);

    console.log(
      JSON.stringify(
        {
          status: "passed",
          run_id: fixture.run_id,
          attached_project_run_id: attachedRunCreatePayload.run.id,
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

async function initializeGitRepo(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, ".gitignore"),
    ["runs/", "state/", "events/", "artifacts/", "reports/", "plans/"].join("\n") + "\n",
    "utf8"
  );
  await writeFile(join(rootDir, "README.md"), "# attached project fixture\n", "utf8");
  await runCommand(rootDir, ["git", "-C", rootDir, "init"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "config", "user.name", "AISA Verify"]);
  await runCommand(
    rootDir,
    ["git", "-C", rootDir, "config", "user.email", "aisa-verify@example.com"]
  );
  await runCommand(rootDir, ["git", "-C", rootDir, "add", "."]);
  await runCommand(rootDir, ["git", "-C", rootDir, "commit", "-m", "test: seed attached project"]);
}

async function writeNodeProjectFixture(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify(
      {
        name: "attached-node-project",
        private: true,
        packageManager: "pnpm@10.27.0",
        scripts: {
          build: "pnpm build",
          test: "pnpm test",
          dev: "pnpm dev"
        },
        devDependencies: {
          typescript: "^5.8.0"
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  await writeFile(join(rootDir, "tsconfig.json"), "{\n  \"compilerOptions\": {}\n}\n", "utf8");
  await writeFile(join(rootDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
}

async function runCommand(rootDir: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const [command, ...commandArgs] = args;
    const child = spawn(command!, commandArgs, {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${args.join(" ")} failed in ${rootDir} with exit code ${exitCode ?? "null"}.\n${stderr}`
        )
      );
    });
  });
}
