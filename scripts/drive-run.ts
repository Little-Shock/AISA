import {
  getCurrentDecision,
  getRun,
  listAttempts,
  resolveWorkspacePaths,
  type WorkspacePaths
} from "../packages/state-store/src/index.ts";
import {
  Orchestrator,
  type OrchestratorOptions
} from "../packages/orchestrator/src/index.ts";
import {
  CodexCliWorkerAdapter,
  loadCodexCliConfig,
  resolveSandboxForAttempt,
  type CodexCliConfig
} from "../packages/worker-adapters/src/index.ts";

export { resolveSandboxForAttempt } from "../packages/worker-adapters/src/index.ts";

type AttemptAdapter = Pick<CodexCliWorkerAdapter, "type" | "runAttemptTask">;

type CliOptions = {
  runId?: string;
  workspaceRoot?: string;
  pollIntervalMs: number;
  maxPolls: number;
  stopAfterCompletedAttempts: number | null;
  sandbox?: CodexCliConfig["sandbox"];
};

export type DriveRunStopReason =
  | "run_settled"
  | "completed_attempt_limit"
  | "max_polls_exhausted";

export interface DriveRunResult {
  run: Awaited<ReturnType<typeof getRun>>;
  current: Awaited<ReturnType<typeof getCurrentDecision>>;
  attempts: Awaited<ReturnType<typeof listAttempts>>;
  stopReason: DriveRunStopReason;
  pollCount: number;
  completedAttemptCount: number;
}

export function assertDriveRunReachedStableStop(
  result: Pick<DriveRunResult, "run" | "stopReason">
): void {
  if (result.stopReason === "max_polls_exhausted") {
    throw new Error(
      `Run ${result.run.id} did not reach a stable stop before the poll limit.`
    );
  }
}

export async function driveRun(input: {
  workspaceRoot: string;
  runId: string;
  adapter: AttemptAdapter;
  pollIntervalMs?: number;
  maxPolls?: number;
  stopAfterCompletedAttempts?: number | null;
  orchestratorOptions?: OrchestratorOptions;
}): Promise<DriveRunResult> {
  const workspacePaths = resolveWorkspacePaths(input.workspaceRoot);
  const orchestrator = new Orchestrator(
    workspacePaths,
    input.adapter as never,
    undefined,
    input.pollIntervalMs ?? 1500,
    input.orchestratorOptions
  );

  let latestSnapshot = await readRunSnapshot(workspacePaths, input.runId);
  const maxPolls = input.maxPolls ?? 120;
  const stopAfterCompletedAttempts = input.stopAfterCompletedAttempts ?? null;

  for (let pollCount = 1; pollCount <= maxPolls; pollCount += 1) {
    if (stopAfterCompletedAttempts !== null) {
      latestSnapshot = await readRunSnapshot(workspacePaths, input.runId);

      const completedAttemptCount = countCompletedAttempts(latestSnapshot.attempts);
      if (completedAttemptCount >= stopAfterCompletedAttempts) {
        return {
          ...latestSnapshot,
          stopReason: "completed_attempt_limit",
          pollCount,
          completedAttemptCount
        };
      }

      const hasRunningAttempt = latestSnapshot.attempts.some(
        (attempt) => attempt.status === "running"
      );
      if (hasRunningAttempt) {
        await sleep(input.pollIntervalMs ?? 1500);
        continue;
      }
    }

    await orchestrator.tick();
    await sleep(input.pollIntervalMs ?? 1500);
    latestSnapshot = await readRunSnapshot(workspacePaths, input.runId);

    const completedAttemptCount = countCompletedAttempts(latestSnapshot.attempts);
    if (
      stopAfterCompletedAttempts !== null &&
      completedAttemptCount >= stopAfterCompletedAttempts
    ) {
      return {
        ...latestSnapshot,
        stopReason: "completed_attempt_limit",
        pollCount,
        completedAttemptCount
      };
    }

    if (
      latestSnapshot.current &&
      (latestSnapshot.current.run_status !== "running" ||
        latestSnapshot.current.waiting_for_human)
    ) {
      return {
        ...latestSnapshot,
        stopReason: "run_settled",
        pollCount,
        completedAttemptCount
      };
    }
  }

  let latestSnapshotAfterDrain = latestSnapshot;
  let drainPollCount = 0;
  while (hasInFlightAttempts(latestSnapshotAfterDrain.attempts)) {
    drainPollCount += 1;
    await orchestrator.tick();
    await sleep(input.pollIntervalMs ?? 1500);
    latestSnapshotAfterDrain = await readRunSnapshot(workspacePaths, input.runId);

    const completedAttemptCount = countCompletedAttempts(latestSnapshotAfterDrain.attempts);
    if (
      latestSnapshotAfterDrain.current &&
      (latestSnapshotAfterDrain.current.run_status !== "running" ||
        latestSnapshotAfterDrain.current.waiting_for_human)
    ) {
      return {
        ...latestSnapshotAfterDrain,
        stopReason: "run_settled",
        pollCount: maxPolls + drainPollCount,
        completedAttemptCount
      };
    }

    if (
      stopAfterCompletedAttempts !== null &&
      completedAttemptCount >= stopAfterCompletedAttempts
    ) {
      return {
        ...latestSnapshotAfterDrain,
        stopReason: "completed_attempt_limit",
        pollCount: maxPolls + drainPollCount,
        completedAttemptCount
      };
    }
  }

  return {
    ...latestSnapshotAfterDrain,
    stopReason: "max_polls_exhausted",
    pollCount: maxPolls + drainPollCount,
    completedAttemptCount: countCompletedAttempts(latestSnapshotAfterDrain.attempts)
  };
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    pollIntervalMs: 1500,
    maxPolls: 120,
    stopAfterCompletedAttempts: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--run-id" && argv[index + 1]) {
      options.runId = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--workspace-root" && argv[index + 1]) {
      options.workspaceRoot = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--poll-interval-ms" && argv[index + 1]) {
      options.pollIntervalMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token === "--max-polls" && argv[index + 1]) {
      options.maxPolls = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token === "--stop-after-completed-attempts" && argv[index + 1]) {
      options.stopAfterCompletedAttempts = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token === "--sandbox" && argv[index + 1]) {
      options.sandbox = argv[index + 1] as CodexCliConfig["sandbox"];
      index += 1;
    }
  }

  return options;
}

async function readRunSnapshot(
  workspacePaths: WorkspacePaths,
  runId: string
): Promise<Pick<DriveRunResult, "run" | "current" | "attempts">> {
  const [run, current, attempts] = await Promise.all([
    getRun(workspacePaths, runId),
    getCurrentDecision(workspacePaths, runId),
    listAttempts(workspacePaths, runId)
  ]);

  return {
    run,
    current,
    attempts
  };
}

function countCompletedAttempts(attempts: Awaited<ReturnType<typeof listAttempts>>): number {
  return attempts.filter((attempt) => attempt.status === "completed").length;
}

function hasInFlightAttempts(
  attempts: Awaited<ReturnType<typeof listAttempts>>
): boolean {
  return attempts.some((attempt) => ["created", "queued", "running"].includes(attempt.status));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.runId) {
    throw new Error("Missing required --run-id");
  }

  const adapterConfig = loadCodexCliConfig(process.env);
  if (options.sandbox) {
    adapterConfig.sandbox = options.sandbox;
  }

  const result = await driveRun({
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    runId: options.runId,
    adapter: new CodexCliWorkerAdapter(adapterConfig),
    pollIntervalMs: options.pollIntervalMs,
    maxPolls: options.maxPolls,
    stopAfterCompletedAttempts: options.stopAfterCompletedAttempts
  });
  const latestAttempt = result.attempts.at(-1) ?? null;
  const payload = {
    run_id: result.run.id,
    stop_reason: result.stopReason,
    poll_count: result.pollCount,
    completed_attempt_count: result.completedAttemptCount,
    run_status: result.current?.run_status ?? null,
    waiting_for_human: result.current?.waiting_for_human ?? false,
    recommended_next_action: result.current?.recommended_next_action ?? null,
    latest_attempt_id: latestAttempt?.id ?? null,
    latest_attempt_type: latestAttempt?.attempt_type ?? null,
    latest_attempt_status: latestAttempt?.status ?? null,
    blocking_reason: result.current?.blocking_reason ?? null
  };

  if (result.stopReason === "max_polls_exhausted") {
    console.error(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(payload, null, 2)
  );
}

const isDirectExecution = import.meta.url === `file://${process.argv[1]}`;

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
