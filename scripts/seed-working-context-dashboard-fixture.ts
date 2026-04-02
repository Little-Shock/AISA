import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAttempt,
  createAttemptAdversarialVerification,
  createAttemptContract,
  createAttemptHandoffBundle,
  createAttemptPreflightEvaluation,
  createCurrentDecision,
  createRun,
  createRunAutomationControl,
  createRunJournalEntry,
  createRunPolicyRuntime,
  updateAttempt
} from "../packages/domain/src/index.ts";
import {
  appendRunJournal,
  ensureWorkspace,
  resolveWorkspacePaths,
  saveAttemptAdversarialVerification,
  saveAttempt,
  saveAttemptContract,
  saveAttemptHandoffBundle,
  saveAttemptPreflightEvaluation,
  saveAttemptRuntimeVerification,
  saveCurrentDecision,
  saveRun,
  saveRunAutomationControl,
  saveRunPolicyRuntime
} from "../packages/state-store/src/index.ts";
import { refreshRunOperatorSurface } from "../packages/orchestrator/src/index.ts";

export type SeedWorkingContextDashboardFixtureResult = {
  runtime_data_root: string;
  run_id: string;
  attempt_id: string;
  expected_working_context_reason: "context_stale";
  expected_automation_mode: "manual_only";
  expected_failure_class: "preflight_blocked";
  expected_failure_policy_mode: "fail_closed";
  expected_run_brief_headline: string;
  expected_run_brief_summary: string;
  expected_preflight_failure_reason: string;
  expected_handoff_summary: string;
  expected_latest_runtime_status: "passed";
  expected_latest_adversarial_status: "passed";
  expected_verifier_kit: "web";
  expected_task_focus: string;
  expected_policy_stage: "approval";
  expected_policy_approval_status: "pending";
};

export async function seedWorkingContextDashboardFixture(input: {
  runtimeDataRoot: string;
  workspaceRoot?: string;
}): Promise<SeedWorkingContextDashboardFixtureResult> {
  const runtimeDataRoot = resolve(input.runtimeDataRoot);
  const workspaceRoot = resolve(input.workspaceRoot ?? process.cwd());
  await mkdir(runtimeDataRoot, { recursive: true });
  const workspacePaths = resolveWorkspacePaths(runtimeDataRoot);
  await ensureWorkspace(workspacePaths);

  const run = createRun({
    title: "Working context degraded UI fixture",
    description: "Render a manual_only run with a stale working context snapshot and surfaced handoff evidence.",
    success_criteria: ["Show degraded working context and handoff-first control surface in run detail."],
    constraints: [],
    owner_id: "fixture-owner",
    workspace_root: workspaceRoot
  });
  const createdAttempt = createAttempt({
    run_id: run.id,
    attempt_type: "execution",
    worker: "codex",
    objective: "补齐 handoff-first 控制面，让 operator 一眼看到先读什么。",
    success_criteria: ["dashboard 首屏直接看到 run brief、handoff 和 preflight 结论。"],
    workspace_root: workspaceRoot
  });
  const attempt = updateAttempt(createdAttempt, {
    status: "failed",
    started_at: "2026-04-01T08:00:00.000Z",
    ended_at: "2026-04-01T08:12:00.000Z"
  });
  const previousExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "codex",
      objective: "先把 runtime replay 和 adversarial gate 的首屏信号接出来。",
      success_criteria: ["dashboard 直接暴露最近一次 runtime 和 adversarial gate 结果。"],
      workspace_root: workspaceRoot
    }),
    {
      status: "completed",
      created_at: "2026-04-01T06:00:00.000Z",
      started_at: "2026-04-01T06:00:00.000Z",
      ended_at: "2026-04-01T06:18:00.000Z",
      updated_at: "2026-04-01T06:18:00.000Z"
    }
  );
  const attemptContract = createAttemptContract({
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: "execution",
    objective: attempt.objective,
    success_criteria: attempt.success_criteria,
    verifier_kit: "web",
    required_evidence: [
      "把 preflight 结论暴露到 run detail 顶层",
      "把 handoff 摘要暴露到 dashboard 首屏"
    ],
    expected_artifacts: [
      "runs/<run_id>/run-brief.json",
      "runs/<run_id>/attempts/<attempt_id>/artifacts/handoff_bundle.json"
    ],
    verification_plan: {
      commands: [
        {
          purpose: "render dashboard control surface",
          command: "pnpm verify:dashboard-control-surface"
        }
      ]
    }
  });
  const initialCurrent = createCurrentDecision({
    run_id: run.id,
    run_status: "waiting_steer",
    best_attempt_id: attempt.id,
    latest_attempt_id: attempt.id,
    recommended_next_action: "wait_for_human",
    recommended_attempt_type: "execution",
    summary: "上一轮执行已经说明，operator 首屏必须直接给出 handoff 和 preflight 结论。",
    blocking_reason: "上一轮执行结束后，operator 仍然要翻 artifacts 才知道怎么继续。",
    waiting_for_human: true
  });
  const automationReason =
    "Operator must relaunch after reviewing the surfaced handoff and preflight evidence.";
  const preflightFailureReason =
    "下一轮执行前，先把 adversarial verification 接成第二道硬门。";

  await saveRun(workspacePaths, run);
  await saveAttempt(workspacePaths, previousExecution);
  await saveAttempt(workspacePaths, attempt);
  await saveAttemptContract(workspacePaths, attemptContract);
  await saveAttemptRuntimeVerification(workspacePaths, {
    attempt_id: previousExecution.id,
    run_id: run.id,
    attempt_type: "execution",
    status: "passed",
    verifier_kit: "web",
    repo_root: workspaceRoot,
    git_head: "fixture-head",
    git_status: [],
    preexisting_git_status: [],
    new_git_status: [" M packages/orchestrator/src/index.ts"],
    changed_files: ["packages/orchestrator/src/index.ts"],
    failure_class: null,
    failure_policy_mode: null,
    failure_code: null,
    failure_reason: null,
    command_results: [
      {
        purpose: "render dashboard control surface",
        command: "pnpm verify:dashboard-control-surface",
        cwd: workspaceRoot,
        expected_exit_code: 0,
        exit_code: 0,
        passed: true,
        stdout_file: `runs/${run.id}/attempts/${previousExecution.id}/artifacts/runtime-verification/stdout.log`,
        stderr_file: `runs/${run.id}/attempts/${previousExecution.id}/artifacts/runtime-verification/stderr.log`
      }
    ],
    created_at: "2026-04-01T06:18:30.000Z"
  });
  await saveAttemptAdversarialVerification(
    workspacePaths,
    createAttemptAdversarialVerification({
      run_id: run.id,
      attempt_id: previousExecution.id,
      attempt_type: "execution",
      status: "passed",
      verifier_kit: "web",
      verdict: "pass",
      summary: "Adversarial verification passed before the later preflight blocker.",
      checks: [
        {
          code: "non_happy_path",
          status: "passed",
          message: "The fixture kept a passing adversarial probe."
        }
      ],
      output_refs: ["artifacts/adversarial/fixture.txt"],
      source_artifact_path: `runs/${run.id}/attempts/${previousExecution.id}/artifacts/adversarial-verification.json`
    })
  );
  await saveCurrentDecision(workspacePaths, initialCurrent);
  await saveRunAutomationControl(
    workspacePaths,
    createRunAutomationControl({
      run_id: run.id,
      mode: "manual_only",
      reason_code: "manual_recovery",
      reason: automationReason,
      imposed_by: "fixture"
    })
  );
  await saveRunPolicyRuntime(
    workspacePaths,
    createRunPolicyRuntime({
      run_id: run.id,
      stage: "approval",
      approval_status: "pending",
      approval_required: true,
      proposed_signature: "fixture-policy-signature",
      proposed_attempt_type: "execution",
      proposed_objective: attempt.objective,
      proposed_success_criteria: attempt.success_criteria,
      permission_profile: "workspace_write",
      hook_policy: "enforce_runtime_contract",
      blocking_reason: "Execution plan is waiting for operator approval.",
      last_decision: "approval_requested",
      source_attempt_id: attempt.id
    })
  );
  const preflightEvaluation = createAttemptPreflightEvaluation({
    run_id: run.id,
    attempt_id: attempt.id,
    attempt_type: "execution",
    status: "failed",
    failure_code: "blocked_pnpm_verification_plan",
    failure_reason: preflightFailureReason,
    checks: [
      {
        code: "adversarial_gate",
        status: "failed",
        message: "缺少 adversarial verification 硬门，不能直接继续 execution。"
      }
    ]
  });
  await saveAttemptPreflightEvaluation(workspacePaths, preflightEvaluation);
  await saveAttemptHandoffBundle(
    workspacePaths,
    createAttemptHandoffBundle({
      attempt,
      approved_attempt_contract: attemptContract,
      preflight_evaluation: preflightEvaluation,
      current_decision_snapshot: initialCurrent,
      source_refs: {
        run_contract: `runs/${run.id}/contract.json`,
        attempt_meta: `runs/${run.id}/attempts/${attempt.id}/meta.json`,
        attempt_contract: `runs/${run.id}/attempts/${attempt.id}/attempt_contract.json`,
        preflight_evaluation: `runs/${run.id}/attempts/${attempt.id}/artifacts/preflight-evaluation.json`,
        current_decision: `runs/${run.id}/current.json`,
        review_packet: null,
        runtime_verification: null
      }
    })
  );
  await refreshRunOperatorSurface(workspacePaths, run.id);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      best_attempt_id: attempt.id,
      latest_attempt_id: attempt.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: "Current decision moved after the working context snapshot.",
      blocking_reason: "Current decision moved after the working context snapshot.",
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.created",
      payload: {
        title: run.title,
        fixture: "working-context-dashboard"
      }
    })
  );

  return {
    runtime_data_root: runtimeDataRoot,
    run_id: run.id,
    attempt_id: attempt.id,
    expected_working_context_reason: "context_stale",
    expected_automation_mode: "manual_only",
    expected_failure_class: "preflight_blocked",
    expected_failure_policy_mode: "fail_closed",
    expected_run_brief_headline: automationReason,
    expected_run_brief_summary: initialCurrent.summary,
    expected_preflight_failure_reason: preflightFailureReason,
    expected_handoff_summary: preflightFailureReason,
    expected_latest_runtime_status: "passed",
    expected_latest_adversarial_status: "passed",
    expected_verifier_kit: "web",
    expected_task_focus: attempt.objective,
    expected_policy_stage: "approval",
    expected_policy_approval_status: "pending"
  };
}

async function main(): Promise<void> {
  const runtimeDataRootArg = process.argv[2];
  if (!runtimeDataRootArg) {
    throw new Error("usage: seed-working-context-dashboard-fixture.ts <runtime-data-root> [workspace-root]");
  }

  const fixture = await seedWorkingContextDashboardFixture({
    runtimeDataRoot: runtimeDataRootArg,
    workspaceRoot: process.argv[3]
  });
  console.log(JSON.stringify(fixture, null, 2));
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
