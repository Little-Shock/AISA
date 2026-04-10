import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { formatScriptFailure } from "../packages/orchestrator/src/script-result.ts";

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

type ExternalRepoMatrixReport = {
  suite: string;
  passed: number;
  failed: number;
  results: Array<{
    id: string;
    status: "pass" | "fail";
    project_type?: string;
    stack_pack_id?: string;
    task_preset_id?: string;
    capability_status?: string;
    recovery_path?: string;
    failure_mode?: string;
    notes?: string;
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

type JudgeEvalsReport = {
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
const RUN_LOOP_FILTER_ENV = "AISA_VERIFY_RUN_LOOP_FILTER";
const VERIFY_RUNTIME_SCOPE_ENV = "AISA_VERIFY_RUNTIME_SCOPE";
const SELF_BOOTSTRAP_HEALTH_SNAPSHOT_SCOPE =
  "self_bootstrap_health_snapshot";

function getRequestedRunLoopFilter(): string | null {
  const raw = process.env[RUN_LOOP_FILTER_ENV]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function getRequestedVerifyRuntimeScope(): string | null {
  const raw = process.env[VERIFY_RUNTIME_SCOPE_ENV]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

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

async function assertRunLoopReplay(filterOverride?: string | null): Promise<RunLoopReport> {
  const result = await runTsxScript(
    "scripts/verify-run-loop.ts",
    filterOverride
      ? {
          [RUN_LOOP_FILTER_ENV]: filterOverride
        }
      : undefined
  );
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-run-loop.ts", result)
  );

  const report = parseScriptJsonReport<RunLoopReport>(
    "scripts/verify-run-loop.ts",
    result.stdout
  );
  const requestedFilter = filterOverride ?? getRequestedRunLoopFilter();
  if (requestedFilter) {
    const normalizedRequestedFilter = requestedFilter.toLowerCase().replaceAll("-", "_");
    assert.ok(
      report.results.length > 0,
      `run-loop 过滤回放必须至少返回一条结果。filter=${requestedFilter}`
    );
    assert.ok(
      report.results.some((entry) => {
        const normalizedEntryId = entry.id.toLowerCase().replaceAll("-", "_");
        return (
          entry.id.includes(requestedFilter) ||
          normalizedEntryId.includes(normalizedRequestedFilter)
        );
      }),
      `run-loop 过滤回放必须包含 filter=${requestedFilter} 对应的 case。`
    );
    return report;
  }

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

  const blockedPnpmShadowDispatchCase = report.results.find(
    (entry) => entry.id === "execution-blocked-pnpm-verification-plan-blocks-dispatch"
  );
  assert.ok(
    blockedPnpmShadowDispatchCase,
    "run-loop 回归必须包含 execution-blocked-pnpm-verification-plan-blocks-dispatch。"
  );
  assert.equal(
    blockedPnpmShadowDispatchCase.status,
    "pass",
    "shadow dispatch smoke 必须在 dispatch 前拦住缺本地依赖的显式 pnpm 回放。"
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

  const attachedProjectDefaultsCase = report.results.find(
    (entry) => entry.id === "attached-project-pack-default-contract"
  );
  assert.ok(
    attachedProjectDefaultsCase,
    "run-loop 回归必须包含 attached-project-pack-default-contract。"
  );
  assert.equal(
    attachedProjectDefaultsCase.status,
    "pass",
    "attached project pack/preset 默认合同 smoke 必须通过。"
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

async function assertExternalRepoMatrixReplay(): Promise<ExternalRepoMatrixReport> {
  const result = await runTsxScript("scripts/verify-external-repo-matrix.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-external-repo-matrix.ts", result)
  );

  const report = parseScriptJsonReport<ExternalRepoMatrixReport>(
    "scripts/verify-external-repo-matrix.ts",
    result.stdout
  );
  assert.equal(report.failed, 0, "external repo matrix 回放不应该出现失败 case。");

  const expectedCases = [
    {
      id: "node_backend_attach_defaults",
      project_type: "node_repo",
      stack_pack_id: "node_backend",
      task_preset_id: "bugfix",
      recovery_path: "first_attempt",
      failure_mode: "missing_local_verifier_toolchain"
    },
    {
      id: "python_service_attach_defaults",
      project_type: "python_repo",
      stack_pack_id: "python_service",
      task_preset_id: "bugfix",
      recovery_path: "first_attempt",
      failure_mode: "bugfix_regression_unchecked"
    },
    {
      id: "go_service_attach_defaults",
      project_type: "go_repo",
      stack_pack_id: "go_service_cli",
      task_preset_id: "bugfix",
      recovery_path: "first_attempt",
      failure_mode: "bugfix_regression_unchecked"
    },
    {
      id: "repo_maintenance_attach_defaults",
      project_type: "generic_git_repo",
      stack_pack_id: "repo_maintenance",
      task_preset_id: "release_hardening",
      recovery_path: "first_attempt",
      failure_mode: "missing_replayable_verification_plan"
    }
  ] as const;

  for (const expectedCase of expectedCases) {
    const resultCase = report.results.find((entry) => entry.id === expectedCase.id);
    assert.ok(resultCase, `external repo matrix 必须包含 ${expectedCase.id}。`);
    assert.equal(resultCase.status, "pass", `${expectedCase.id} 必须通过。`);
    assert.equal(resultCase.project_type, expectedCase.project_type);
    assert.equal(resultCase.stack_pack_id, expectedCase.stack_pack_id);
    assert.equal(resultCase.task_preset_id, expectedCase.task_preset_id);
    assert.equal(resultCase.recovery_path, expectedCase.recovery_path);
    assert.equal(resultCase.failure_mode, expectedCase.failure_mode);
  }

  return report;
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

async function assertEvaluatorCalibrationReplay(): Promise<void> {
  const result = await runTsxScript("scripts/verify-evaluator-calibration.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-evaluator-calibration.ts", result)
  );
}

async function assertJudgeEvalsReplay(): Promise<JudgeEvalsReport> {
  const result = await runTsxScript("scripts/verify-judge-evals.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-judge-evals.ts", result)
  );

  const report = parseScriptJsonReport<JudgeEvalsReport>(
    "scripts/verify-judge-evals.ts",
    result.stdout
  );
  assert.equal(report.failed, 0, "judge/evals focused replay should not report failed cases.");
  return report;
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

async function assertFailurePolicyReplay(): Promise<void> {
  const result = await runTsxScript("scripts/verify-failure-policy.ts");
  assert.equal(
    result.exitCode,
    0,
    formatScriptFailure("scripts/verify-failure-policy.ts", result)
  );
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

async function runSelfBootstrapHealthSnapshotReplay(): Promise<{
  judgeEvals: JudgeEvalsReport;
  workerAdapter: WorkerAdapterReport;
  driveRun: VerifyDriveRunReport;
  runAutonomy: RunAutonomyReport;
  governance: GovernanceReport;
  policyRuntime: PolicyRuntimeReport;
  historyContractDrift: HistoryContractDriftReport;
}> {
  await assertRunLoopReplay("happy_path");
  const judgeEvals = await assertJudgeEvalsReplay();
  await assertEvaluatorCalibrationReplay();
  await assertControlApiSupervisorReplay();
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
  await assertFailurePolicyReplay();
  await assertHistoryContractDriftRepairReplay();
  const historyContractDrift = await assertHistoryContractDriftClean();

  return {
    judgeEvals,
    workerAdapter,
    driveRun,
    runAutonomy,
    governance,
    policyRuntime,
    historyContractDrift
  };
}

async function main(): Promise<void> {
  const requestedScope = getRequestedVerifyRuntimeScope();
  if (requestedScope === "run_loop_only") {
    await assertRunLoopReplay();
    console.log(
      JSON.stringify({
        summary: "runtime focused replay passed for run_loop_only scope.",
        scope: requestedScope,
        run_loop: {
          status: "passed"
        }
      })
    );
    return;
  }
  if (requestedScope === SELF_BOOTSTRAP_HEALTH_SNAPSHOT_SCOPE) {
    const scopedReport = await runSelfBootstrapHealthSnapshotReplay();
    console.log(
      JSON.stringify(
        {
          summary:
            "runtime focused replay passed for self_bootstrap_health_snapshot scope. recursive self-bootstrap entrypoints stayed excluded.",
          scope: requestedScope,
          skipped_suites: ["runtime_lanes", "run_detail_api", "self_bootstrap"],
          evaluator_calibration: {
            status: "passed"
          },
          judge_evals: {
            status: "passed",
            passed: scopedReport.judgeEvals.passed,
            failed: scopedReport.judgeEvals.failed
          },
          worker_adapter: {
            status: scopedReport.workerAdapter.status,
            research_shell_reentry:
              scopedReport.workerAdapter.research_shell_reentry,
            runtime_event_stream:
              scopedReport.workerAdapter.runtime_event_stream,
            stalled_worker_guard:
              scopedReport.workerAdapter.stalled_worker_guard,
            malformed_findings_guard:
              scopedReport.workerAdapter.malformed_findings_guard,
            malformed_artifacts_guard:
              scopedReport.workerAdapter.malformed_artifacts_guard
          },
          drive_run: {
            status: "passed",
            synced_self_bootstrap_artifacts:
              scopedReport.driveRun.synced_self_bootstrap_artifacts ?? null
          },
          run_autonomy: {
            status: "passed",
            passed: scopedReport.runAutonomy.passed,
            failed: scopedReport.runAutonomy.failed
          },
          governance: {
            status: "passed",
            passed: scopedReport.governance.passed,
            failed: scopedReport.governance.failed
          },
          policy_runtime: {
            status: "passed",
            passed: scopedReport.policyRuntime.passed,
            failed: scopedReport.policyRuntime.failed
          },
          history_contract_drift: {
            status: scopedReport.historyContractDrift.status,
            drift_count: scopedReport.historyContractDrift.drift_count
          }
        },
        null,
        2
      )
    );
    return;
  }

  await assertRunLoopReplay();
  const judgeEvals = await assertJudgeEvalsReplay();
  await assertEvaluatorCalibrationReplay();
  await assertControlApiSupervisorReplay();
  await assertRuntimeLaneReplay();
  await assertRunDetailApiReplay();
  const externalRepoMatrix = await assertExternalRepoMatrixReplay();
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
  await assertFailurePolicyReplay();
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
          ? "runtime 回放通过，主链、外部仓库矩阵、maintenance plane、working context、dashboard control surface 都通过，嵌套 self-bootstrap 回放已按防递归保护跳过，历史 contract 漂移修复与体检都通过了。"
          : "runtime 回放通过，主链、外部仓库矩阵、maintenance plane、working context、dashboard control surface、self-bootstrap 和历史 contract 漂移修复都通过了。",
        run_loop: {
          status: "passed"
        },
        evaluator_calibration: {
          status: "passed"
        },
        judge_evals: {
          status: "passed",
          passed: judgeEvals.passed,
          failed: judgeEvals.failed
        },
        control_api_supervisor: {
          status: "passed"
        },
        run_detail_api: {
          status: "passed"
        },
        external_repo_matrix: {
          status: "passed",
          passed: externalRepoMatrix.passed,
          failed: externalRepoMatrix.failed
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
