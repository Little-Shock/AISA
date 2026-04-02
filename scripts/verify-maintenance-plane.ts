import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAttempt,
  createAttemptContract,
  createAttemptHandoffBundle,
  createAttemptPreflightEvaluation,
  createCurrentDecision,
  createRun
} from "../packages/domain/src/index.ts";
import {
  readRunMaintenancePlaneView,
  refreshRunMaintenancePlane
} from "../packages/orchestrator/src/index.ts";
import {
  ensureWorkspace,
  getCurrentDecision,
  getRunMaintenancePlane,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptContract,
  saveAttemptHandoffBundle,
  saveAttemptPreflightEvaluation,
  saveCurrentDecision,
  saveRun
} from "../packages/state-store/src/index.ts";

async function main(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-maintenance-plane-"));
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);

  const run = createRun({
    title: "Maintenance plane verification",
    description: "Prove maintenance outputs stay side-channel and never rewrite current decision.",
    success_criteria: ["Refresh maintenance outputs without mutating current decision."],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: rootDir
  });
  const attempt = createAttempt({
    run_id: run.id,
    attempt_type: "execution",
    worker: "codex",
    objective: "Surface maintenance-plane status for a blocked run.",
    success_criteria: ["Operator can separate mainline truth from maintenance outputs."],
    workspace_root: rootDir
  });
  const attemptContract = createAttemptContract({
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: "execution",
    objective: attempt.objective,
    success_criteria: attempt.success_criteria,
    required_evidence: ["Write maintenance-plane.json without touching current.json."],
    expected_artifacts: ["runs/<run_id>/artifacts/maintenance-plane.json"]
  });
  const current = createCurrentDecision({
    run_id: run.id,
    run_status: "waiting_steer",
    latest_attempt_id: attempt.id,
    best_attempt_id: attempt.id,
    recommended_next_action: "wait_for_human",
    recommended_attempt_type: "execution",
    summary: "Execution is blocked until maintenance outputs are visible.",
    blocking_reason: "Operator still cannot tell which signals come from mainline and which come from maintenance.",
    waiting_for_human: true
  });
  const preflight = createAttemptPreflightEvaluation({
    run_id: run.id,
    attempt_id: attempt.id,
    attempt_type: "execution",
    status: "failed",
    failure_code: "blocked_pnpm_verification_plan",
    failure_reason: "Preflight stopped this execution before dispatch."
  });

  await saveRun(workspacePaths, run);
  await saveAttempt(workspacePaths, attempt);
  await saveAttemptContract(workspacePaths, attemptContract);
  await saveCurrentDecision(workspacePaths, current);
  await saveAttemptPreflightEvaluation(workspacePaths, preflight);
  await saveAttemptHandoffBundle(
    workspacePaths,
    createAttemptHandoffBundle({
      attempt,
      approved_attempt_contract: attemptContract,
      preflight_evaluation: preflight,
      current_decision_snapshot: current,
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

  const before = await getCurrentDecision(workspacePaths, run.id);
  const maintenancePlane = await refreshRunMaintenancePlane(workspacePaths, run.id, {
    staleAfterMs: 60_000
  });
  const after = await getCurrentDecision(workspacePaths, run.id);
  const savedMaintenancePlane = await getRunMaintenancePlane(workspacePaths, run.id);

  assert.deepEqual(after, before, "maintenance refresh must not rewrite current decision");
  assert.ok(savedMaintenancePlane, "maintenance plane artifact should be written");
  assert.equal(maintenancePlane.blocked_diagnosis.status, "attention");
  assert.equal(
    maintenancePlane.blocked_diagnosis.summary,
    current.blocking_reason
  );
  assert.ok(
    maintenancePlane.outputs.some(
      (item) => item.key === "run_brief" && item.plane === "maintenance"
    )
  );
  assert.ok(
    maintenancePlane.outputs.some(
      (item) => item.key === "working_context" && item.status === "ready"
    )
  );
  assert.ok(
    maintenancePlane.signal_sources.some(
      (item) => item.key === "current_decision" && item.plane === "mainline"
    )
  );
  assert.ok(
    maintenancePlane.signal_sources.some(
      (item) => item.key === "run_brief" && item.plane === "maintenance"
    )
  );

  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: attempt.id,
      best_attempt_id: attempt.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: "Current decision moved after the maintenance refresh.",
      blocking_reason: "Current decision moved after the maintenance refresh.",
      waiting_for_human: true
    })
  );
  const staleView = await readRunMaintenancePlaneView(workspacePaths, run.id, {
    staleAfterMs: 60_000
  });
  const workingContextOutput =
    staleView.maintenance_plane?.outputs.find((item) => item.key === "working_context") ?? null;
  assert.equal(
    workingContextOutput?.status,
    "degraded",
    "maintenance view should surface stale working context without rewriting mainline state"
  );

  console.log(
    JSON.stringify(
      {
        status: "passed",
        run_id: run.id,
        attempt_id: attempt.id,
        blocked_diagnosis: maintenancePlane.blocked_diagnosis.status,
        maintenance_plane_ref: `runs/${run.id}/artifacts/maintenance-plane.json`,
        working_context_after_current_move: workingContextOutput?.status ?? null
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
