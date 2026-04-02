import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAttempt,
  createAttemptContract,
  createAttemptHandoffBundle,
  createAttemptPreflightEvaluation,
  createCurrentDecision,
  createRun,
  createRunAutomationControl,
  createRunJournalEntry,
  updateAttempt
} from "../packages/domain/src/index.ts";
import {
  appendRunJournal,
  ensureWorkspace,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptContract,
  saveAttemptHandoffBundle,
  saveAttemptPreflightEvaluation,
  saveCurrentDecision,
  saveRun,
  saveRunAutomationControl
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
  expected_task_focus: string;
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
  const attemptContract = createAttemptContract({
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: "execution",
    objective: attempt.objective,
    success_criteria: attempt.success_criteria,
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
  await saveAttempt(workspacePaths, attempt);
  await saveAttemptContract(workspacePaths, attemptContract);
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
    expected_task_focus: attempt.objective
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
