import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { prepareLocalWorkspaceDependencies } from "../packages/orchestrator/src/index.js";

type HistoryContractDrift = {
  run_id: string;
  attempt_id: string;
  status: string;
  objective_match: boolean;
  success_criteria_match: boolean;
  review_packet_present: boolean;
  review_packet_contract_matches_attempt: boolean;
  meta_file: string;
  contract_file: string;
  review_packet_file: string;
};

type HistoryContractDriftReport = {
  status: "ok" | "drift_detected";
  summary: string;
  scanned_run_count: number;
  scanned_execution_attempt_count: number;
  drift_count: number;
  drifts: HistoryContractDrift[];
  generated_at: string;
};

type SelectedNextExecutionPlanDrift = {
  run_id: string;
  status: "repairable" | "blocked";
  reason: string;
  message: string;
  current_file: string;
  source_attempt_id: string;
  source_result_ref: string;
  expected_source_result_ref: string;
  resolved_source_result_ref: string | null;
  source_result_file: string | null;
};

type SelectedNextExecutionPlanDriftReport = {
  status: "ok" | "drift_detected";
  summary: string;
  scanned_run_count: number;
  scanned_selected_next_execution_plan_count: number;
  drift_count: number;
  drifts: SelectedNextExecutionPlanDrift[];
  generated_at: string;
};

type RunAutonomyReport = {
  suite: string;
  passed: number;
  failed: number;
  results: Array<{
    id: string;
    status: "pass" | "fail";
    error?: string;
  }>;
};

type VerifyDriveRunReport = {
  run_id: string;
  first_stop_next_action: string | null;
  first_stop_blocking_reason: string | null;
  stop_reason: string;
  attempt_types: string[];
  research_attempt_count: number;
  execution_attempt_count: number;
  run_status: string | null;
  synced_self_bootstrap_artifacts?: {
    publication_artifact: string;
    source_asset_snapshot: string;
    published_active_entry: string;
  };
};

type ScriptResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

const SKIP_SELF_BOOTSTRAP_ENV = "AISA_VERIFY_RUNTIME_SKIP_SELF_BOOTSTRAP";

function runTsxScript(
  scriptPath: string,
  extraEnv?: NodeJS.ProcessEnv
): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "./scripts/local-tsx-loader.mjs", scriptPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...extraEnv
        }
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
      resolve({
        exitCode,
        stdout,
        stderr
      });
    });
  });
}

function formatScriptFailure(label: string, result: ScriptResult): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();

  return [
    `${label} exit code: ${result.exitCode ?? "null"}`,
    stdout.length > 0 ? `stdout:\n${stdout}` : "stdout:\n<empty>",
    stderr.length > 0 ? `stderr:\n${stderr}` : "stderr:\n<empty>"
  ].join("\n\n");
}

async function assertRunLoopReplay(): Promise<void> {
  const result = await runTsxScript("scripts/verify-run-loop.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-run-loop.ts", result)
  );
}

async function assertControlApiSupervisorReplay(): Promise<void> {
  const result = await runTsxScript("scripts/verify-control-api-supervisor.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-control-api-supervisor.ts", result)
  );
}

async function assertRunDetailApiReplay(): Promise<void> {
  const result = await runTsxScript("scripts/verify-run-detail-api.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-run-detail-api.ts", result)
  );
}

async function assertRunStreamReplay(): Promise<void> {
  const result = await runTsxScript("scripts/verify-run-stream.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-run-stream.ts", result)
  );
}

async function assertDriveRunReplay(): Promise<VerifyDriveRunReport> {
  const result = await runTsxScript("scripts/verify-drive-run.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-drive-run.ts", result)
  );

  return JSON.parse(result.stdout) as VerifyDriveRunReport;
}

async function assertRunAutonomyReplay(): Promise<RunAutonomyReport> {
  const result = await runTsxScript("scripts/verify-run-autonomy.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-run-autonomy.ts", result)
  );

  return JSON.parse(result.stdout) as RunAutonomyReport;
}

async function assertLocalDependencyPreparation(): Promise<void> {
  const manifest = await prepareLocalWorkspaceDependencies(process.cwd());
  assert.equal(
    manifest.status,
    "prepared",
    "local dependency prep should materialize control-api links in this workspace"
  );

  const fastifyModule = await import("fastify");
  const dotenvModule = await import("dotenv");
  const domainModule = await import("@autoresearch/domain");

  assert.equal(typeof fastifyModule.default, "function");
  assert.equal(typeof dotenvModule.config, "function");
  assert.ok("createRun" in domainModule, "workspace packages should resolve from local node_modules");
}

async function assertSelfBootstrapReplay(): Promise<void> {
  const result = await runTsxScript("scripts/verify-self-bootstrap.ts", {
    [SKIP_SELF_BOOTSTRAP_ENV]: "1"
  });
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-self-bootstrap.ts", result)
  );
}

async function assertHistoryContractDriftRepairReplay(): Promise<void> {
  const result = await runTsxScript("scripts/verify-history-contract-drift-repair.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-history-contract-drift-repair.ts", result)
  );
}

async function assertHistoryContractDriftClean(): Promise<HistoryContractDriftReport> {
  const result = await runTsxScript("scripts/verify-history-contract-drift.ts");

  assert.equal(
    result.exitCode,
    0,
    "历史 contract 漂移体检应该已经回到零漂移。\n\n" +
      formatScriptFailure("scripts/verify-history-contract-drift.ts", result)
  );

  const report = JSON.parse(result.stdout) as HistoryContractDriftReport;
  assert.equal(
    report.status,
    "ok",
    "历史 contract 漂移体检应该明确回报 ok。"
  );
  assert.equal(
    report.drift_count,
    0,
    "历史 contract 漂移数量应该已经归零。"
  );

  return report;
}

async function assertSelectedNextExecutionPlanDriftClean(): Promise<SelectedNextExecutionPlanDriftReport> {
  const result = await runTsxScript("scripts/verify-selected-next-execution-plan-drift.ts");

  assert.equal(
    result.exitCode,
    0,
    "selected_next_execution_plan 漂移体检应该已经归零。\n\n" +
      formatScriptFailure("scripts/verify-selected-next-execution-plan-drift.ts", result)
  );

  const report = JSON.parse(result.stdout) as SelectedNextExecutionPlanDriftReport;
  assert.equal(
    report.status,
    "ok",
    "selected_next_execution_plan 漂移体检应该明确回报 ok。"
  );
  assert.equal(
    report.drift_count,
    0,
    "selected_next_execution_plan 漂移数量应该已经归零。"
  );

  return report;
}

async function main(): Promise<void> {
  await assertLocalDependencyPreparation();
  await assertRunLoopReplay();
  await assertControlApiSupervisorReplay();
  await assertRunDetailApiReplay();
  await assertRunStreamReplay();
  const driveRun = await assertDriveRunReplay();
  const runAutonomy = await assertRunAutonomyReplay();
  const skipSelfBootstrapReplay = process.env[SKIP_SELF_BOOTSTRAP_ENV] === "1";

  if (!skipSelfBootstrapReplay) {
    await assertSelfBootstrapReplay();
  }
  await assertHistoryContractDriftRepairReplay();
  const historyContractDrift = await assertHistoryContractDriftClean();
  const selectedNextExecutionPlanDrift =
    await assertSelectedNextExecutionPlanDriftClean();

  console.log(
    JSON.stringify(
      {
        summary: skipSelfBootstrapReplay
          ? "runtime 回放通过，drive-run、run autonomy 主链通过，嵌套 self-bootstrap 回放已按防递归保护跳过，历史 contract 漂移修复与体检都通过了。"
          : "runtime 回放通过，drive-run、run autonomy、self-bootstrap 主链和历史 contract 漂移修复都通过了。",
        run_loop: {
          status: "passed"
        },
        control_api_supervisor: {
          status: "passed"
        },
        run_detail_api: {
          status: "passed"
        },
        run_stream: {
          status: "passed"
        },
        drive_run: {
          status: "passed",
          synced_self_bootstrap_artifacts:
            driveRun.synced_self_bootstrap_artifacts ?? null
        },
        local_dependency_prep: {
          status: "passed"
        },
        run_autonomy: {
          status: "passed",
          passed: runAutonomy.passed,
          failed: runAutonomy.failed
        },
        self_bootstrap: skipSelfBootstrapReplay
          ? {
              status: "skipped_recursive_guard"
            }
          : {
              status: "passed"
            },
        history_contract_drift: {
          status: historyContractDrift.status,
          drift_count: historyContractDrift.drift_count,
          attempts: historyContractDrift.drifts.map(
            (entry) => `${entry.run_id}/${entry.attempt_id}`
          )
        },
        selected_next_execution_plan_drift: {
          status: selectedNextExecutionPlanDrift.status,
          drift_count: selectedNextExecutionPlanDrift.drift_count,
          runs: selectedNextExecutionPlanDrift.drifts.map((entry) => entry.run_id)
        }
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
