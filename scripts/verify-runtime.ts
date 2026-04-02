import assert from "node:assert/strict";
import { spawn } from "node:child_process";

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

type WorkerAdapterReport = {
  research_shell_reentry: string;
  blocked_command_exit_code: number;
  runtime_event_stream: string;
  stalled_worker_guard: string;
  malformed_findings_guard: string;
  malformed_artifacts_guard: string;
  status: "passed";
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

type GovernanceReport = {
  suite: string;
  passed: number;
  failed: number;
  results: Array<{
    id: string;
    status: "pass" | "fail";
    error?: string;
  }>;
};

type PolicyRuntimeReport = {
  suite: string;
  passed: number;
  failed: number;
  results: Array<{
    id: string;
    status: "pass" | "fail";
    error?: string;
  }>;
};

type RunLoopReport = {
  suite: string;
  passed: number;
  failed: number;
  results: Array<{
    id: string;
    status: "pass" | "fail";
    error?: string;
  }>;
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
      [
        "--experimental-transform-types",
        "--loader",
        "./scripts/ts-runtime-loader.mjs",
        scriptPath
      ],
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

function runCommand(
  command: string,
  args: string[],
  extraEnv?: NodeJS.ProcessEnv
): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...extraEnv
      }
    });
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

function parseScriptJsonReport<T>(label: string, stdout: string): T {
  const trimmed = stdout.trim();

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const candidateIndices = Array.from(
      trimmed.matchAll(/(?:^|\n)(\{)/g),
      (match) => (match.index ?? 0) + match[0].length - 1
    ).reverse();

    for (const index of candidateIndices) {
      try {
        return JSON.parse(trimmed.slice(index)) as T;
      } catch {
        continue;
      }
    }
  }

  throw new SyntaxError(
    `${label} did not end with a parseable JSON report.\n\nstdout:\n${stdout}`
  );
}

async function assertRunLoopReplay(): Promise<RunLoopReport> {
  const result = await runTsxScript("scripts/verify-run-loop.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-run-loop.ts", result)
  );

  const report = parseScriptJsonReport<RunLoopReport>(
    "scripts/verify-run-loop.ts",
    result.stdout
  );
  const preflightFailClosedCase = report.results.find(
    (entry) => entry.id === "execution-missing-local-toolchain-blocks-dispatch"
  );
  assert.ok(
    preflightFailClosedCase,
    "run-loop 回归必须包含 execution-missing-local-toolchain-blocks-dispatch。"
  );
  assert.equal(
    preflightFailClosedCase.status,
    "pass",
    "execution preflight fail-closed smoke 必须通过。"
  );

  const shadowDispatchCase = report.results.find(
    (entry) => entry.id === "execution-unrunnable-verification-command-blocks-dispatch"
  );
  assert.ok(
    shadowDispatchCase,
    "run-loop 回归必须包含 execution-unrunnable-verification-command-blocks-dispatch。"
  );
  assert.equal(
    shadowDispatchCase.status,
    "pass",
    "shadow dispatch smoke 必须在 dispatch 前拦住坏的 verifier 命令。"
  );

  return report;
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

async function assertWorkingContextReplay(): Promise<void> {
  const result = await runTsxScript("scripts/verify-working-context.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-working-context.ts", result)
  );
}

async function assertMaintenancePlaneReplay(): Promise<void> {
  const result = await runTsxScript("scripts/verify-maintenance-plane.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-maintenance-plane.ts", result)
  );
}

async function assertDashboardControlSurfaceReplay(): Promise<void> {
  const result = await runCommand("pnpm", ["verify:dashboard-control-surface"]);
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("pnpm verify:dashboard-control-surface", result)
  );
}

async function assertDashboardRunSteerReplay(): Promise<void> {
  const result = await runCommand("pnpm", ["verify:dashboard-run-steer"]);
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("pnpm verify:dashboard-run-steer", result)
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

  return parseScriptJsonReport<VerifyDriveRunReport>(
    "scripts/verify-drive-run.ts",
    result.stdout
  );
}

async function assertRunAutonomyReplay(): Promise<RunAutonomyReport> {
  const result = await runTsxScript("scripts/verify-run-autonomy.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-run-autonomy.ts", result)
  );

  const report = parseScriptJsonReport<RunAutonomyReport>(
    "scripts/verify-run-autonomy.ts",
    result.stdout
  );
  const stalledResearchCase = report.results.find(
    (entry) => entry.id === "worker_stalled_research_retries_quickly"
  );

  assert.ok(
    stalledResearchCase,
    "run autonomy 回归必须包含 worker_stalled_research_retries_quickly。"
  );
  assert.equal(
    stalledResearchCase.status,
    "pass",
    "research stalled 回放必须通过。"
  );

  return report;
}

async function assertWorkerAdapterReplay(): Promise<WorkerAdapterReport> {
  const result = await runTsxScript("scripts/verify-worker-adapter.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-worker-adapter.ts", result)
  );

  const report = parseScriptJsonReport<WorkerAdapterReport>(
    "scripts/verify-worker-adapter.ts",
    result.stdout
  );
  assert.equal(report.status, "passed", "worker adapter 回放应该明确回报 passed。");
  return report;
}

async function assertGovernanceReplay(): Promise<GovernanceReport> {
  const result = await runTsxScript("scripts/verify-governance.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-governance.ts", result)
  );

  return parseScriptJsonReport<GovernanceReport>(
    "scripts/verify-governance.ts",
    result.stdout
  );
}

async function assertPolicyRuntimeReplay(): Promise<PolicyRuntimeReport> {
  const result = await runTsxScript("scripts/verify-policy-runtime.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-policy-runtime.ts", result)
  );

  const report = parseScriptJsonReport<PolicyRuntimeReport>(
    "scripts/verify-policy-runtime.ts",
    result.stdout
  );
  const approvalCase = report.results.find(
    (entry) => entry.id === "execution_requires_approval"
  );
  assert.ok(
    approvalCase,
    "policy runtime 回归必须包含 execution_requires_approval。"
  );
  assert.equal(
    approvalCase.status,
    "pass",
    "execution approval gate 回放必须通过。"
  );

  return report;
}

async function assertRuntimeLaneReplay(): Promise<void> {
  const result = await runTsxScript("scripts/verify-runtime-lanes.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-runtime-lanes.ts", result)
  );
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

  const report = parseScriptJsonReport<HistoryContractDriftReport>(
    "scripts/verify-history-contract-drift.ts",
    result.stdout
  );
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

async function main(): Promise<void> {
  await assertRunLoopReplay();
  await assertControlApiSupervisorReplay();
  await assertRuntimeLaneReplay();
  await assertRunDetailApiReplay();
  await assertWorkingContextReplay();
  await assertMaintenancePlaneReplay();
  await assertDashboardControlSurfaceReplay();
  await assertDashboardRunSteerReplay();
  await assertRunStreamReplay();
  const workerAdapter = await assertWorkerAdapterReplay();
  const driveRun = await assertDriveRunReplay();
  const runAutonomy = await assertRunAutonomyReplay();
  const governance = await assertGovernanceReplay();
  const policyRuntime = await assertPolicyRuntimeReplay();
  const skipSelfBootstrapReplay = process.env[SKIP_SELF_BOOTSTRAP_ENV] === "1";

  if (!skipSelfBootstrapReplay) {
    await assertSelfBootstrapReplay();
  }
  await assertHistoryContractDriftRepairReplay();
  const report = await assertHistoryContractDriftClean();

  console.log(
    JSON.stringify(
      {
        summary: skipSelfBootstrapReplay
          ? "runtime 回放通过，主链、maintenance plane、working context、dashboard control surface 都通过，嵌套 self-bootstrap 回放已按防递归保护跳过，历史 contract 漂移修复与体检都通过了。"
          : "runtime 回放通过，主链、maintenance plane、working context、dashboard control surface、self-bootstrap 和历史 contract 漂移修复都通过了。",
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
        worker_adapter: {
          status: workerAdapter.status,
          research_shell_reentry: workerAdapter.research_shell_reentry,
          runtime_event_stream: workerAdapter.runtime_event_stream,
          stalled_worker_guard: workerAdapter.stalled_worker_guard,
          malformed_findings_guard: workerAdapter.malformed_findings_guard,
          malformed_artifacts_guard: workerAdapter.malformed_artifacts_guard
        },
        drive_run: {
          status: "passed",
          synced_self_bootstrap_artifacts:
            driveRun.synced_self_bootstrap_artifacts ?? null
        },
        run_autonomy: {
          status: "passed",
          passed: runAutonomy.passed,
          failed: runAutonomy.failed
        },
        governance: {
          status: "passed",
          passed: governance.passed,
          failed: governance.failed
        },
        policy_runtime: {
          status: "passed",
          passed: policyRuntime.passed,
          failed: policyRuntime.failed
        },
        self_bootstrap: skipSelfBootstrapReplay
          ? {
              status: "skipped_recursive_guard"
            }
          : {
              status: "passed"
            },
        history_contract_drift: {
          status: report.status,
          drift_count: report.drift_count,
          attempts: report.drifts.map(
            (entry) => `${entry.run_id}/${entry.attempt_id}`
          )
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
