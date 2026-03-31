import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AttemptReviewPacketSchema,
  createAttempt,
  createAttemptContract,
  createCurrentDecision,
  createRun,
  updateAttempt
} from "../packages/domain/src/index.ts";
import {
  ensureWorkspace,
  getAttemptContract,
  getAttemptReviewPacket,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptContract,
  saveAttemptReviewPacket,
  saveRun
} from "../packages/state-store/src/index.ts";

type ScriptResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type DriftReport = {
  status: "ok" | "drift_detected";
  drift_count: number;
};

type RepairReport = {
  status: "noop" | "repaired" | "repair_incomplete";
  repaired_count: number;
  after: {
    drift_count: number;
  };
};

function resolveSourceRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function resolveRuntimeLoaderPath(sourceRoot: string): string {
  return join(sourceRoot, "scripts", "ts-runtime-loader.mjs");
}

function runTypeScriptScript(input: {
  cwd: string;
  sourceRoot: string;
  scriptPath: string;
}): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--loader",
        resolveRuntimeLoaderPath(input.sourceRoot),
        input.scriptPath
      ],
      {
        cwd: input.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function formatScriptFailure(label: string, result: ScriptResult): string {
  return [
    `${label} exit code: ${result.exitCode ?? "null"}`,
    result.stdout.trim().length > 0 ? `stdout:\n${result.stdout.trim()}` : "stdout:\n<empty>",
    result.stderr.trim().length > 0 ? `stderr:\n${result.stderr.trim()}` : "stderr:\n<empty>"
  ].join("\n\n");
}

function parseJsonStdout<T>(label: string, stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON stdout: ${reason}`);
  }
}

async function seedDriftedAttempt(rootDir: string): Promise<{
  runId: string;
  attemptId: string;
}> {
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);
  const run = createRun({
    title: "History contract drift repair fixture",
    description: "Repair one explicit settled execution drift.",
    success_criteria: ["repair drift"],
    constraints: ["do not hide drift"],
    owner_id: "test-owner",
    workspace_root: rootDir
  });
  await saveRun(workspacePaths, run);

  const attempt = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fixture-worker",
      objective: "new execution objective",
      success_criteria: ["new success criteria"],
      workspace_root: rootDir
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      result_ref: `runs/${run.id}/attempts/drift/result.json`,
      evaluation_ref: `runs/${run.id}/attempts/drift/evaluation.json`
    }
  );
  await saveAttempt(workspacePaths, attempt);

  const staleContract = createAttemptContract({
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: attempt.attempt_type,
    objective: "stale execution objective",
    success_criteria: ["stale success criteria"],
    required_evidence: ["leave evidence"],
    verification_plan: {
      commands: [
        {
          purpose: "fixture replay",
          command: "test -n history-drift"
        }
      ]
    }
  });
  await saveAttemptContract(workspacePaths, staleContract);

  await saveAttemptReviewPacket(
    workspacePaths,
    AttemptReviewPacketSchema.parse({
      run_id: run.id,
      attempt_id: attempt.id,
      attempt,
      attempt_contract: staleContract,
      current_decision_snapshot: createCurrentDecision({
        run_id: run.id,
        run_status: "waiting_steer",
        latest_attempt_id: attempt.id,
        recommended_next_action: "wait_for_human",
        recommended_attempt_type: "execution",
        summary: "fixture drift"
      }),
      context: null,
      journal: [],
      failure_context: null,
      result: null,
      evaluation: null,
      runtime_verification: null,
      artifact_manifest: [],
      review_input_packet_ref: null,
      review_opinion_refs: [],
      synthesized_evaluation_ref: null,
      generated_at: new Date().toISOString()
    })
  );

  return {
    runId: run.id,
    attemptId: attempt.id
  };
}

async function main(): Promise<void> {
  const sourceRoot = resolveSourceRoot();
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-history-contract-drift-"));
  const fixture = await seedDriftedAttempt(rootDir);

  const verifyBefore = await runTypeScriptScript({
    cwd: rootDir,
    sourceRoot,
    scriptPath: join(sourceRoot, "scripts", "verify-history-contract-drift.ts")
  });
  assert.equal(
    verifyBefore.exitCode,
    1,
    "drift check should fail before repair.\n\n" +
      formatScriptFailure("scripts/verify-history-contract-drift.ts", verifyBefore)
  );
  const beforeReport = parseJsonStdout<DriftReport>(
    "scripts/verify-history-contract-drift.ts",
    verifyBefore.stdout
  );
  assert.equal(beforeReport.status, "drift_detected");
  assert.equal(beforeReport.drift_count, 1);

  const repairResult = await runTypeScriptScript({
    cwd: rootDir,
    sourceRoot,
    scriptPath: join(sourceRoot, "scripts", "repair-history-contract-drift.ts")
  });
  assert.equal(
    repairResult.exitCode,
    0,
    formatScriptFailure("scripts/repair-history-contract-drift.ts", repairResult)
  );
  const repairReport = parseJsonStdout<RepairReport>(
    "scripts/repair-history-contract-drift.ts",
    repairResult.stdout
  );
  assert.equal(repairReport.status, "repaired");
  assert.equal(repairReport.repaired_count, 1);
  assert.equal(repairReport.after.drift_count, 0);

  const verifyAfter = await runTypeScriptScript({
    cwd: rootDir,
    sourceRoot,
    scriptPath: join(sourceRoot, "scripts", "verify-history-contract-drift.ts")
  });
  assert.equal(
    verifyAfter.exitCode,
    0,
    formatScriptFailure("scripts/verify-history-contract-drift.ts", verifyAfter)
  );
  const afterReport = parseJsonStdout<DriftReport>(
    "scripts/verify-history-contract-drift.ts",
    verifyAfter.stdout
  );
  assert.equal(afterReport.status, "ok");
  assert.equal(afterReport.drift_count, 0);

  const workspacePaths = resolveWorkspacePaths(rootDir);
  const repairedContract = await getAttemptContract(
    workspacePaths,
    fixture.runId,
    fixture.attemptId
  );
  const repairedReviewPacket = await getAttemptReviewPacket(
    workspacePaths,
    fixture.runId,
    fixture.attemptId
  );
  assert.equal(repairedContract?.objective, "new execution objective");
  assert.deepEqual(repairedContract?.success_criteria, ["new success criteria"]);
  assert.equal(
    repairedReviewPacket?.attempt_contract?.objective,
    "new execution objective"
  );
  assert.deepEqual(
    repairedReviewPacket?.attempt_contract?.success_criteria,
    ["new success criteria"]
  );

  console.log(
    JSON.stringify(
      {
        run_id: fixture.runId,
        attempt_id: fixture.attemptId,
        before_status: beforeReport.status,
        after_status: afterReport.status
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
