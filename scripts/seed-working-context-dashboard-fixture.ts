import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createCurrentDecision,
  createRun,
  createRunAutomationControl,
  createRunJournalEntry,
  createRunWorkingContext
} from "../packages/domain/src/index.ts";
import {
  appendRunJournal,
  ensureWorkspace,
  resolveWorkspacePaths,
  saveCurrentDecision,
  saveRun,
  saveRunAutomationControl,
  saveRunWorkingContext
} from "../packages/state-store/src/index.ts";

async function main(): Promise<void> {
  const runtimeDataRootArg = process.argv[2];
  if (!runtimeDataRootArg) {
    throw new Error("usage: seed-working-context-dashboard-fixture.ts <runtime-data-root> [workspace-root]");
  }

  const runtimeDataRoot = resolve(runtimeDataRootArg);
  const workspaceRoot = resolve(process.argv[3] ?? process.cwd());
  await mkdir(runtimeDataRoot, { recursive: true });
  const workspacePaths = resolveWorkspacePaths(runtimeDataRoot);
  await ensureWorkspace(workspacePaths);

  const run = createRun({
    title: "Working context degraded UI fixture",
    description: "Render a manual_only run with a stale working context snapshot.",
    success_criteria: ["Show degraded working context and automation status in run detail."],
    constraints: [],
    owner_id: "fixture-owner",
    workspace_root: workspaceRoot
  });

  await saveRun(workspacePaths, run);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      recommended_next_action: "wait_for_human",
      summary: "Initial working context snapshot for dashboard verification.",
      blocking_reason: "Initial working context snapshot for dashboard verification.",
      waiting_for_human: true
    })
  );
  await saveRunAutomationControl(
    workspacePaths,
    createRunAutomationControl({
      run_id: run.id,
      mode: "manual_only",
      reason_code: "manual_recovery",
      reason: "Operator must relaunch after reviewing the stale working context fixture.",
      imposed_by: "fixture"
    })
  );
  await saveRunWorkingContext(
    workspacePaths,
    createRunWorkingContext({
      run_id: run.id,
      plan_ref: `runs/${run.id}/contract.json`,
      active_task_refs: [
        {
          task_id: "task_fixture",
          title: "Render the stale working context banner.",
          source_ref: `runs/${run.id}/working-context.json`
        }
      ],
      recent_evidence_refs: [
        {
          kind: "review_packet",
          ref: `runs/${run.id}/attempts/att_fixture/review_packet.json`,
          note: "fixture evidence ref"
        }
      ],
      current_focus: "Show degraded working context and manual_only state in the dashboard.",
      current_blocker: {
        code: "manual_recovery",
        summary: "Operator must relaunch after reviewing the stale working context fixture.",
        ref: `runs/${run.id}/automation.json`
      },
      next_operator_attention: "Confirm the degraded banner and automation banner both render.",
      automation: {
        mode: "manual_only",
        reason_code: "manual_recovery"
      },
      source_attempt_id: null
    })
  );
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      recommended_next_action: "wait_for_human",
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

  console.log(
    JSON.stringify(
      {
        runtime_data_root: runtimeDataRoot,
        run_id: run.id,
        expected_working_context_reason: "context_stale",
        expected_automation_mode: "manual_only"
      },
      null,
      2
    )
  );
}

await main();
