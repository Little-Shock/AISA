import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

type HistoryContractDriftBaseline = {
  run_id: string;
  drift_count: number;
  drifts: HistoryContractDrift[];
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
      ["--import", "tsx", scriptPath],
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

function normalizeDriftEntry(entry: HistoryContractDrift) {
  return {
    run_id: entry.run_id,
    attempt_id: entry.attempt_id,
    status: entry.status,
    objective_match: entry.objective_match,
    success_criteria_match: entry.success_criteria_match,
    review_packet_present: entry.review_packet_present,
    review_packet_contract_matches_attempt:
      entry.review_packet_contract_matches_attempt,
    meta_file: entry.meta_file,
    contract_file: entry.contract_file,
    review_packet_file: entry.review_packet_file
  };
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

async function assertHistoryContractDriftBaseline(): Promise<HistoryContractDriftReport> {
  const baselinePath = join(
    process.cwd(),
    "Codex",
    "2026-03-27-run_3374dc3f-contract-drift-baseline.json"
  );
  const baseline = JSON.parse(
    await readFile(baselinePath, "utf8")
  ) as HistoryContractDriftBaseline;
  const result = await runTsxScript("scripts/verify-history-contract-drift.ts");

  assert.equal(
    result.exitCode,
    1,
    "历史 contract 漂移体检应该先保持非零退出，直到旧现场被显式修复。\n\n" +
      formatScriptFailure("scripts/verify-history-contract-drift.ts", result)
  );

  const report = JSON.parse(result.stdout) as HistoryContractDriftReport;
  assert.equal(
    report.status,
    "drift_detected",
    "历史 contract 漂移体检应该明确回报 drift_detected。"
  );
  assert.equal(
    report.drift_count,
    baseline.drift_count,
    "历史 contract 漂移数量应该和锁定基线一致。"
  );
  assert.deepEqual(
    report.drifts.map(normalizeDriftEntry),
    baseline.drifts.map(normalizeDriftEntry),
    "历史 contract 漂移明细应该和锁定基线一致。"
  );

  return report;
}

async function main(): Promise<void> {
  await assertRunLoopReplay();
  await assertControlApiSupervisorReplay();
  await assertRunDetailApiReplay();
  await assertRunStreamReplay();
  const skipSelfBootstrapReplay = process.env[SKIP_SELF_BOOTSTRAP_ENV] === "1";

  if (!skipSelfBootstrapReplay) {
    await assertSelfBootstrapReplay();
  }
  const report = await assertHistoryContractDriftBaseline();

  console.log(
    JSON.stringify(
      {
        summary: skipSelfBootstrapReplay
          ? "runtime 回放通过，嵌套 self-bootstrap 回放已按防递归保护跳过，历史 contract 漂移体检也稳定锁住旧基线。"
          : "runtime 回放通过，self-bootstrap 主链和历史 contract 漂移体检都稳定锁住了。",
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
        self_bootstrap: skipSelfBootstrapReplay
          ? {
              status: "skipped_recursive_guard"
            }
          : {
              status: "passed"
            },
        history_contract_drift: {
          status: "expected_failure_confirmed",
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
