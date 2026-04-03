import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeHealthSnapshot } from "@autoresearch/domain";

type ScriptResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type VerifyRuntimeReport = {
  summary: string;
};

type HistoryContractDriftReport = {
  status: "ok" | "drift_detected";
  summary: string;
  scanned_run_count: number;
  scanned_execution_attempt_count: number;
  drift_count: number;
  drifts: RuntimeHealthSnapshot["history_contract_drift"]["drifts"];
};

const SKIP_SELF_BOOTSTRAP_ENV = "AISA_VERIFY_RUNTIME_SKIP_SELF_BOOTSTRAP";
const VERIFY_RUNTIME_SCOPE_ENV = "AISA_VERIFY_RUNTIME_SCOPE";
const SELF_BOOTSTRAP_HEALTH_SNAPSHOT_SCOPE =
  "self_bootstrap_health_snapshot";
const DEFAULT_EVIDENCE_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);

function hasRuntimeHealthScripts(rootDir: string): boolean {
  return (
    existsSync(join(rootDir, "package.json")) &&
    existsSync(join(rootDir, "scripts", "ts-runtime-loader.mjs")) &&
    existsSync(join(rootDir, "scripts", "verify-runtime.ts")) &&
    existsSync(join(rootDir, "scripts", "verify-history-contract-drift.ts"))
  );
}

function resolveEvidenceRepoRoot(runtimeRepoRoot: string): string {
  const candidates = [
    runtimeRepoRoot,
    process.env.AISA_RUNTIME_REPO_ROOT,
    DEFAULT_EVIDENCE_REPO_ROOT
  ]
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => resolve(candidate));

  for (const candidate of new Set(candidates)) {
    if (hasRuntimeHealthScripts(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "bootstrap:self blocked because no runtime repo with verification scripts was found. " +
      `Checked: ${Array.from(new Set(candidates)).join(", ")}`
  );
}

function runTypeScriptScript(
  rootDir: string,
  scriptPath: string,
  extraEnv?: NodeJS.ProcessEnv
): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...extraEnv
    };

    for (const [key, value] of Object.entries(childEnv)) {
      if (value === undefined) {
        delete childEnv[key];
      }
    }

    const child = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--loader",
        join(rootDir, "scripts", "ts-runtime-loader.mjs"),
        join(rootDir, scriptPath)
      ],
      {
        cwd: rootDir,
        env: childEnv,
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

function parseJsonStdout<T>(label: string, stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON stdout: ${reason}`);
  }
}

export async function captureSelfBootstrapRuntimeHealthSnapshot(input: {
  runId: string;
  workspaceRoot: string;
  runtimeRepoRoot: string;
}): Promise<RuntimeHealthSnapshot> {
  const evidenceRepoRoot = resolveEvidenceRepoRoot(input.runtimeRepoRoot);
  const verifyRuntimeCommand =
    `${VERIFY_RUNTIME_SCOPE_ENV}=${SELF_BOOTSTRAP_HEALTH_SNAPSHOT_SCOPE} ` +
    "pnpm verify:runtime";
  const verifyRuntimeResult = await runTypeScriptScript(
    evidenceRepoRoot,
    "scripts/verify-runtime.ts",
    {
      [SKIP_SELF_BOOTSTRAP_ENV]: "1",
      [VERIFY_RUNTIME_SCOPE_ENV]: SELF_BOOTSTRAP_HEALTH_SNAPSHOT_SCOPE,
      AISA_DEV_REPO_ROOT: undefined,
      AISA_RUNTIME_DATA_ROOT: undefined,
      AISA_RUNTIME_REPO_ROOT: undefined,
      AISA_MANAGED_WORKSPACE_ROOT: undefined
    }
  );

  if (verifyRuntimeResult.exitCode !== 0) {
    throw new Error(
      `bootstrap:self blocked because ${verifyRuntimeCommand} failed.\n\n${formatScriptFailure(
        "scripts/verify-runtime.ts",
        verifyRuntimeResult
      )}`
    );
  }

  const verifyRuntimeReport = parseJsonStdout<VerifyRuntimeReport>(
    "scripts/verify-runtime.ts",
    verifyRuntimeResult.stdout
  );
  const historyContractDriftCommand =
    "node --experimental-transform-types --loader ./scripts/ts-runtime-loader.mjs scripts/verify-history-contract-drift.ts";
  const historyContractDriftResult = await runTypeScriptScript(
    evidenceRepoRoot,
    "scripts/verify-history-contract-drift.ts"
  );
  const historyContractDriftReport = parseJsonStdout<HistoryContractDriftReport>(
    "scripts/verify-history-contract-drift.ts",
    historyContractDriftResult.stdout
  );
  const historyExitCode = historyContractDriftResult.exitCode ?? 1;
  const historyLooksExpected =
    (historyExitCode === 0 && historyContractDriftReport.status === "ok") ||
    (historyExitCode === 1 &&
      historyContractDriftReport.status === "drift_detected");

  if (!historyLooksExpected) {
    throw new Error(
      "bootstrap:self blocked because history contract drift scan returned an unexpected result.\n\n" +
        formatScriptFailure(
          "scripts/verify-history-contract-drift.ts",
          historyContractDriftResult
        )
    );
  }

  return {
    run_id: input.runId,
    workspace_root: input.workspaceRoot,
    evidence_root: evidenceRepoRoot,
    verify_runtime: {
      command: verifyRuntimeCommand,
      exit_code: 0,
      status: "passed",
      summary: verifyRuntimeReport.summary
    },
    history_contract_drift: {
      command: historyContractDriftCommand,
      exit_code: historyExitCode,
      status: historyContractDriftReport.status,
      summary: historyContractDriftReport.summary,
      scanned_run_count: historyContractDriftReport.scanned_run_count,
      scanned_execution_attempt_count:
        historyContractDriftReport.scanned_execution_attempt_count,
      drift_count: historyContractDriftReport.drift_count,
      drifts: historyContractDriftReport.drifts
    },
    created_at: new Date().toISOString()
  };
}
