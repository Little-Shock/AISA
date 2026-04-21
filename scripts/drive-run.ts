import {
  createRunJournalEntry,
  updateCurrentDecision,
  updateRunPolicyRuntime,
  type CurrentDecision
} from "../packages/domain/src/index.ts";
import {
  appendRunJournal,
  getAttemptHeartbeat,
  getCurrentDecision,
  getRun,
  getRunPolicyRuntime,
  listAttempts,
  resolveWorkspacePaths,
  saveCurrentDecision,
  saveRunPolicyRuntime,
  type WorkspacePaths
} from "../packages/state-store/src/index.ts";
import {
  assertRuntimeDataRootCompatible,
  Orchestrator,
  type OrchestratorOptions
} from "../packages/orchestrator/src/index.ts";
import {
  buildRuntimeWorkspaceScopeRoots,
  resolveRuntimeLayout
} from "../packages/orchestrator/src/runtime-layout.ts";
import {
  createRunWorkspaceScopePolicy,
  parseRunWorkspaceScopeRoots
} from "../packages/orchestrator/src/workspace-scope.ts";
import {
  createAdversarialVerifierAdapter,
  createExecutionWorkerAdapter,
  loadAdversarialVerifierAdapterConfig,
  loadExecutionWorkerAdapterConfig,
  resolveSandboxForAttempt,
  type AdversarialVerifierAdapter,
  type CodexCliConfig,
  type WorkerAdapter
} from "../packages/worker-adapters/src/index.ts";

export { resolveSandboxForAttempt } from "../packages/worker-adapters/src/index.ts";

type AttemptAdapter = Pick<WorkerAdapter, "type" | "runAttemptTask">;

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
  adversarialVerifier?: AdversarialVerifierAdapter | null;
  repositoryRoot?: string;
  pollIntervalMs?: number;
  maxPolls?: number;
  stopAfterCompletedAttempts?: number | null;
  orchestratorOptions?: OrchestratorOptions;
  autoApprovePendingExecution?: boolean;
}): Promise<DriveRunResult> {
  const workspacePaths = resolveWorkspacePaths(input.workspaceRoot);
  const repositoryRoot = input.repositoryRoot ?? process.cwd();
  const runtimeLayout =
    input.orchestratorOptions?.runtimeLayout ??
    resolveRuntimeLayout({
      repositoryRoot,
      env: process.env
    });
  const runWorkspaceScopePolicy =
    input.orchestratorOptions?.runWorkspaceScopePolicy ??
    (await createRunWorkspaceScopePolicy({
      runtimeRoot: runtimeLayout.runtimeRepoRoot,
      allowedRoots: buildRuntimeWorkspaceScopeRoots(runtimeLayout, [
        ...parseRunWorkspaceScopeRoots(process.env.AISA_ALLOWED_WORKSPACE_ROOTS)
      ]),
      managedWorkspaceRoot: runtimeLayout.managedWorkspaceRoot
    }));
  await assertRuntimeDataRootCompatible({
    layout: runtimeLayout
  });
  const orchestrator = new Orchestrator(
    workspacePaths,
    input.adapter,
    undefined,
    input.pollIntervalMs ?? 1500,
    {
      ...input.orchestratorOptions,
      adversarialVerifier:
        input.adversarialVerifier ?? input.orchestratorOptions?.adversarialVerifier,
      runtimeLayout,
      runWorkspaceScopePolicy
    }
  );

  let latestSnapshot = await readRunSnapshot(workspacePaths, input.runId);
  const maxPolls = input.maxPolls ?? 120;
  const stopAfterCompletedAttempts = input.stopAfterCompletedAttempts ?? null;

  for (let pollCount = 1; pollCount <= maxPolls; pollCount += 1) {
    if (stopAfterCompletedAttempts !== null) {
      latestSnapshot = await readRunSnapshot(workspacePaths, input.runId);

      const completedAttemptCount = countCompletedAttempts(latestSnapshot.attempts);
      if (
        completedAttemptCount >= stopAfterCompletedAttempts &&
        !(await hasActiveAttemptHeartbeats(workspacePaths, input.runId, latestSnapshot.attempts))
      ) {
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

    await orchestrator.tick({ runId: input.runId });
    await sleep(input.pollIntervalMs ?? 1500);
    latestSnapshot = await readRunSnapshot(workspacePaths, input.runId);
    if (
      input.autoApprovePendingExecution &&
      (await maybeApprovePendingExecutionPolicy({
        workspacePaths,
        runId: input.runId,
        current: latestSnapshot.current
      }))
    ) {
      latestSnapshot = await readRunSnapshot(workspacePaths, input.runId);
    }

    const completedAttemptCount = countCompletedAttempts(latestSnapshot.attempts);
    if (
      stopAfterCompletedAttempts !== null &&
      completedAttemptCount >= stopAfterCompletedAttempts &&
      !(await hasActiveAttemptHeartbeats(workspacePaths, input.runId, latestSnapshot.attempts))
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
        latestSnapshot.current.waiting_for_human) &&
      !(await hasActiveAttemptHeartbeats(workspacePaths, input.runId, latestSnapshot.attempts))
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
  while (
    hasInFlightAttempts(latestSnapshotAfterDrain.attempts) ||
    (await hasActiveAttemptHeartbeats(
      workspacePaths,
      input.runId,
      latestSnapshotAfterDrain.attempts
    ))
  ) {
    drainPollCount += 1;
    await orchestrator.tick({ runId: input.runId });
    await sleep(input.pollIntervalMs ?? 1500);
    latestSnapshotAfterDrain = await readRunSnapshot(workspacePaths, input.runId);
    const hasActiveHeartbeats = await hasActiveAttemptHeartbeats(
      workspacePaths,
      input.runId,
      latestSnapshotAfterDrain.attempts
    );

    const completedAttemptCount = countCompletedAttempts(latestSnapshotAfterDrain.attempts);
    if (
      latestSnapshotAfterDrain.current &&
      (latestSnapshotAfterDrain.current.run_status !== "running" ||
        latestSnapshotAfterDrain.current.waiting_for_human) &&
      !hasActiveHeartbeats
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
      completedAttemptCount >= stopAfterCompletedAttempts &&
      !hasActiveHeartbeats
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

async function maybeApprovePendingExecutionPolicy(input: {
  workspacePaths: WorkspacePaths;
  runId: string;
  current: CurrentDecision | null;
}): Promise<boolean> {
  if (!input.current) {
    return false;
  }

  const policyRuntime = await getRunPolicyRuntime(input.workspacePaths, input.runId);
  if (!policyRuntime) {
    return false;
  }

  if (
    policyRuntime.approval_required !== true ||
    policyRuntime.approval_status !== "pending" ||
    policyRuntime.proposed_attempt_type !== "execution"
  ) {
    return false;
  }

  const approvedPolicy = updateRunPolicyRuntime(policyRuntime, {
    stage: "execution",
    approval_status: "approved",
    blocking_reason: null,
    last_decision: "approved",
    approval_decided_at: new Date().toISOString(),
    approval_actor: "drive-run",
    approval_note:
      "Auto-approved by the verification harness so execution downstream checks can continue."
  });
  const resumedCurrent = updateCurrentDecision(input.current, {
    run_status: "running",
    waiting_for_human: false,
    blocking_reason: null,
    recommended_next_action: "continue_execution",
    recommended_attempt_type: "execution",
    summary: input.current.summary
  });

  await Promise.all([
    saveRunPolicyRuntime(input.workspacePaths, approvedPolicy),
    saveCurrentDecision(input.workspacePaths, resumedCurrent)
  ]);
  await appendRunJournal(
    input.workspacePaths,
    createRunJournalEntry({
      run_id: input.runId,
      attempt_id: approvedPolicy.source_attempt_id,
      type: "run.policy.approved",
      payload: {
        actor: approvedPolicy.approval_actor,
        note: approvedPolicy.approval_note,
        proposed_signature: approvedPolicy.proposed_signature
      }
    })
  );

  return true;
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

async function hasActiveAttemptHeartbeats(
  workspacePaths: WorkspacePaths,
  runId: string,
  attempts: Awaited<ReturnType<typeof listAttempts>>
): Promise<boolean> {
  const heartbeats = await Promise.all(
    attempts.map((attempt) => getAttemptHeartbeat(workspacePaths, runId, attempt.id))
  );

  return heartbeats.some((heartbeat) => heartbeat?.status === "active");
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

  const adapterConfig = loadExecutionWorkerAdapterConfig(process.env);
  const adversarialVerifierConfig = loadAdversarialVerifierAdapterConfig(process.env);
  if (options.sandbox) {
    adapterConfig.sandbox = options.sandbox;
  }

  const result = await driveRun({
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    runId: options.runId,
    adapter: createExecutionWorkerAdapter(adapterConfig),
    adversarialVerifier: createAdversarialVerifierAdapter(adversarialVerifierConfig),
    repositoryRoot: process.cwd(),
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
