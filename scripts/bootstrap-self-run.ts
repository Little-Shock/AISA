import { spawn } from "node:child_process";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCurrentDecision,
  createRun,
  createRunJournalEntry,
  createRunSteer,
  updateCurrentDecision,
  type RuntimeHealthSnapshot
} from "../packages/domain/src/index.ts";
import { buildSelfBootstrapRunTemplate } from "../packages/planner/src/index.ts";
import { resolveRuntimeLayout } from "../packages/orchestrator/src/index.ts";
import {
  appendRunJournal,
  ensureWorkspace,
  resolveRunPaths,
  resolveWorkspacePaths,
  saveCurrentDecision,
  saveRun,
  saveRunRuntimeHealthSnapshot,
  saveRunSteer
} from "../packages/state-store/src/index.ts";

type CliOptions = {
  ownerId?: string;
  focus?: string;
  launch: boolean;
  seedSteer: boolean;
};

type ScriptResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

const SKIP_SELF_BOOTSTRAP_ENV = "AISA_VERIFY_RUNTIME_SKIP_SELF_BOOTSTRAP";

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

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    launch: true,
    seedSteer: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--owner" && argv[index + 1]) {
      options.ownerId = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--focus" && argv[index + 1]) {
      options.focus = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--no-launch") {
      options.launch = false;
      continue;
    }

    if (token === "--no-steer") {
      options.seedSteer = false;
    }
  }

  return options;
}

function resolveSourceRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function runTsxScript(
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
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: rootDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"]
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

function parseJsonStdout<T>(label: string, stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON stdout: ${reason}`);
  }
}

async function captureRuntimeHealthSnapshot(input: {
  runId: string;
  workspaceRoot: string;
  evidenceRoot: string;
}): Promise<RuntimeHealthSnapshot> {
  const verifyRuntimeCommand = "pnpm verify:runtime";
  const verifyRuntimeResult = await runTsxScript(
    input.evidenceRoot,
    "scripts/verify-runtime.ts",
    {
      [SKIP_SELF_BOOTSTRAP_ENV]: "1",
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
  const historyContractDriftCommand = "node --import tsx scripts/verify-history-contract-drift.ts";
  const historyContractDriftResult = await runTsxScript(
    input.evidenceRoot,
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
    evidence_root: input.evidenceRoot,
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

async function main(): Promise<void> {
  const sourceRoot = resolveSourceRoot();
  const runtimeLayout = resolveRuntimeLayout({
    repositoryRoot: sourceRoot,
    env: process.env
  });
  const workspacePaths = resolveWorkspacePaths(runtimeLayout.runtimeDataRoot);
  await ensureWorkspace(workspacePaths);

  const options = parseArgs(process.argv.slice(2));
  const baseTemplate = buildSelfBootstrapRunTemplate({
    workspaceRoot: runtimeLayout.devRepoRoot,
    ownerId: options.ownerId,
    focus: options.focus
  });
  const run = createRun(baseTemplate.runInput);
  let current = createCurrentDecision({
    run_id: run.id,
    run_status: "draft",
    summary: "Self-bootstrap run created. Waiting to launch."
  });

  await saveRun(workspacePaths, run);
  const runtimeHealthSnapshot = await captureRuntimeHealthSnapshot({
    runId: run.id,
    workspaceRoot: runtimeLayout.devRepoRoot,
    evidenceRoot: runtimeLayout.runtimeRepoRoot
  });
  await saveRunRuntimeHealthSnapshot(workspacePaths, runtimeHealthSnapshot);
  await saveCurrentDecision(workspacePaths, current);
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.created",
      payload: {
        title: run.title,
        owner_id: run.owner_id,
        template: "self-bootstrap"
      }
    })
  );
  const runPaths = resolveRunPaths(workspacePaths, run.id);
  const runtimeHealthSnapshotPath = runPaths.runtimeHealthSnapshotFile;
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.runtime_health_snapshot.captured",
      payload: {
        path: runtimeHealthSnapshotPath,
        verify_runtime_status: runtimeHealthSnapshot.verify_runtime.status,
        history_contract_drift_status:
          runtimeHealthSnapshot.history_contract_drift.status,
        drift_count: runtimeHealthSnapshot.history_contract_drift.drift_count
      }
    })
  );
  const template = buildSelfBootstrapRunTemplate({
    workspaceRoot: runtimeLayout.devRepoRoot,
    ownerId: options.ownerId,
    focus: options.focus,
    runtimeHealthSnapshot: {
      path: runtimeHealthSnapshotPath,
      snapshot: runtimeHealthSnapshot
    }
  });

  let steerId: string | null = null;
  if (options.seedSteer) {
    const runSteer = createRunSteer({
      run_id: run.id,
      content: template.initialSteer
    });
    steerId = runSteer.id;
    await saveRunSteer(workspacePaths, runSteer);
    await appendRunJournal(
      workspacePaths,
      createRunJournalEntry({
        run_id: run.id,
        attempt_id: null,
        type: "run.steer.queued",
        payload: {
          content: runSteer.content,
          template: "self-bootstrap"
        }
      })
    );
  }

  if (options.launch) {
    current = updateCurrentDecision(current, {
      run_status: "running",
      waiting_for_human: false,
      blocking_reason: null,
      recommended_next_action: "start_first_attempt",
      recommended_attempt_type: "research",
      summary: "Self-bootstrap run launched. Loop will create the first attempt."
    });
    await saveCurrentDecision(workspacePaths, current);
    await appendRunJournal(
      workspacePaths,
      createRunJournalEntry({
        run_id: run.id,
        type: "run.launched",
        payload: {
          template: "self-bootstrap"
        }
      })
    );
  }

  console.log(
    JSON.stringify(
      {
        run_id: run.id,
        current_status: current.run_status,
        workspace_root: run.workspace_root,
        steer_id: steerId,
        launched: options.launch,
        template: "self-bootstrap",
        runtime_health_snapshot: runtimeHealthSnapshotPath
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
