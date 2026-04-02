import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  Attempt,
  AttemptAdversarialVerification,
  AttemptContract,
  AttemptHeartbeat,
  AttemptEvaluationSynthesisRecord,
  AttemptHandoffBundle,
  AttemptPreflightEvaluation,
  AttemptRuntimeEvent,
  AttemptRuntimeState,
  AttemptEvaluation,
  AttemptReviewInputPacket,
  AttemptReviewPacket,
  AttemptReviewerOpinion,
  AttemptRuntimeVerification,
  Branch,
  BranchSpec,
  ContextBoard,
  ContextSnapshot,
  CurrentDecision,
  EvalResult,
  EvalSpec,
  Goal,
  RunMaintenancePlane,
  RunPolicyRuntime,
  RunGovernanceState,
  RunAutomationControl,
  RunBrief,
  RunWorkingContext,
  RuntimeHealthSnapshot,
  Run,
  RunJournalEntry,
  RunSteer,
  Steer,
  WorkerRun,
  WorkerWriteback
} from "@autoresearch/domain";
import {
  AttemptSchema,
  AttemptAdversarialVerificationSchema,
  AttemptContractSchema,
  AttemptHeartbeatSchema,
  AttemptEvaluationSynthesisRecordSchema,
  AttemptHandoffBundleSchema,
  AttemptPreflightEvaluationSchema,
  AttemptRuntimeEventSchema,
  AttemptRuntimeStateSchema,
  AttemptEvaluationSchema,
  AttemptReviewInputPacketSchema,
  AttemptReviewPacketSchema,
  AttemptReviewerOpinionSchema,
  AttemptRuntimeVerificationSchema,
  BranchSchema,
  ContextBoardSchema,
  ContextSnapshotSchema,
  CurrentDecisionSchema,
  EvalResultSchema,
  GoalSchema,
  RunAutomationControlSchema,
  RunBriefSchema,
  RunPolicyRuntimeSchema,
  RunGovernanceStateSchema,
  RunMaintenancePlaneSchema,
  RunWorkingContextSchema,
  RuntimeHealthSnapshotSchema,
  RunJournalEntrySchema,
  RunSchema,
  RunSteerSchema,
  SteerSchema,
  WorkerRunSchema,
  WorkerWritebackSchema
} from "@autoresearch/domain";

export interface WorkspacePaths {
  rootDir: string;
  runsDir: string;
  plansDir: string;
  stateDir: string;
  eventsDir: string;
  artifactsDir: string;
  reportsDir: string;
}

export interface GoalPaths {
  goalDir: string;
  goalStateDir: string;
  branchesDir: string;
  workerRunsDir: string;
  steersDir: string;
  planDir: string;
  artifactDir: string;
  contextDir: string;
  contextSnapshotsDir: string;
  branchArtifactsDir: string;
  reportDir: string;
  reportHistoryDir: string;
  sharedFactsFile: string;
  openQuestionsFile: string;
  constraintsFile: string;
  currentReportFile: string;
}

export interface RunPaths {
  runDir: string;
  attemptsDir: string;
  steersDir: string;
  artifactsDir: string;
  contractFile: string;
  currentFile: string;
  automationFile: string;
  policyFile: string;
  runBriefFile: string;
  workingContextFile: string;
  governanceFile: string;
  maintenancePlaneFile: string;
  reportFile: string;
  journalFile: string;
  runtimeHealthSnapshotFile: string;
}

export interface AttemptPaths {
  attemptDir: string;
  metaFile: string;
  contractFile: string;
  contextFile: string;
  resultFile: string;
  evaluationFile: string;
  evaluationSynthesisFile: string;
  reviewInputPacketFile: string;
  reviewPacketFile: string;
  handoffBundleFile: string;
  reviewOpinionsDir: string;
  preflightEvaluationFile: string;
  runtimeVerificationFile: string;
  adversarialVerificationFile: string;
  heartbeatFile: string;
  runtimeStateFile: string;
  runtimeEventsFile: string;
  stdoutFile: string;
  stderrFile: string;
  artifactsDir: string;
}

export function resolveWorkspacePaths(rootDir: string): WorkspacePaths {
  return {
    rootDir,
    runsDir: join(rootDir, "runs"),
    plansDir: join(rootDir, "plans"),
    stateDir: join(rootDir, "state"),
    eventsDir: join(rootDir, "events"),
    artifactsDir: join(rootDir, "artifacts"),
    reportsDir: join(rootDir, "reports")
  };
}

export function resolveRunPaths(paths: WorkspacePaths, runId: string): RunPaths {
  const runDir = join(paths.runsDir, runId);

  return {
    runDir,
    attemptsDir: join(runDir, "attempts"),
    steersDir: join(runDir, "steers"),
    artifactsDir: join(runDir, "artifacts"),
    contractFile: join(runDir, "contract.json"),
    currentFile: join(runDir, "current.json"),
    automationFile: join(runDir, "automation.json"),
    policyFile: join(runDir, "policy-runtime.json"),
    runBriefFile: join(runDir, "run-brief.json"),
    workingContextFile: join(runDir, "working-context.json"),
    governanceFile: join(runDir, "governance.json"),
    maintenancePlaneFile: join(runDir, "artifacts", "maintenance-plane.json"),
    reportFile: join(runDir, "report.md"),
    journalFile: join(runDir, "journal.ndjson"),
    runtimeHealthSnapshotFile: join(
      runDir,
      "artifacts",
      "runtime-health-snapshot.json"
    )
  };
}

export function resolveAttemptPaths(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): AttemptPaths {
  const attemptDir = join(resolveRunPaths(paths, runId).attemptsDir, attemptId);

  return {
    attemptDir,
    metaFile: join(attemptDir, "meta.json"),
    contractFile: join(attemptDir, "attempt_contract.json"),
    contextFile: join(attemptDir, "context.json"),
    resultFile: join(attemptDir, "result.json"),
    evaluationFile: join(attemptDir, "evaluation.json"),
    evaluationSynthesisFile: join(attemptDir, "evaluation_synthesis.json"),
    reviewInputPacketFile: join(attemptDir, "review_input_packet.json"),
    reviewPacketFile: join(attemptDir, "review_packet.json"),
    handoffBundleFile: join(attemptDir, "artifacts", "handoff_bundle.json"),
    reviewOpinionsDir: join(attemptDir, "review_opinions"),
    preflightEvaluationFile: join(attemptDir, "artifacts", "preflight-evaluation.json"),
    runtimeVerificationFile: join(attemptDir, "artifacts", "runtime-verification.json"),
    adversarialVerificationFile: join(
      attemptDir,
      "artifacts",
      "adversarial-verification.json"
    ),
    heartbeatFile: join(attemptDir, "artifacts", "heartbeat.json"),
    runtimeStateFile: join(attemptDir, "artifacts", "runtime-state.json"),
    runtimeEventsFile: join(attemptDir, "artifacts", "runtime-events.ndjson"),
    stdoutFile: join(attemptDir, "stdout.log"),
    stderrFile: join(attemptDir, "stderr.log"),
    artifactsDir: join(attemptDir, "artifacts")
  };
}

export function resolveGoalPaths(
  paths: WorkspacePaths,
  goalId: string
): GoalPaths {
  return {
    goalDir: join(paths.stateDir, "goals", goalId),
    goalStateDir: join(paths.stateDir, "goals", goalId),
    branchesDir: join(paths.stateDir, "goals", goalId, "branches"),
    workerRunsDir: join(paths.stateDir, "goals", goalId, "worker-runs"),
    steersDir: join(paths.stateDir, "goals", goalId, "steers"),
    planDir: join(paths.plansDir, "goals", goalId),
    artifactDir: join(paths.artifactsDir, "goals", goalId),
    contextDir: join(paths.artifactsDir, "goals", goalId, "context"),
    contextSnapshotsDir: join(paths.artifactsDir, "goals", goalId, "context", "snapshots"),
    branchArtifactsDir: join(paths.artifactsDir, "goals", goalId, "branches"),
    reportDir: join(paths.reportsDir, "goals", goalId),
    reportHistoryDir: join(paths.reportsDir, "goals", goalId, "history"),
    sharedFactsFile: join(paths.artifactsDir, "goals", goalId, "context", "shared_facts.md"),
    openQuestionsFile: join(paths.artifactsDir, "goals", goalId, "context", "open_questions.md"),
    constraintsFile: join(paths.artifactsDir, "goals", goalId, "context", "constraints.md"),
    currentReportFile: join(paths.reportsDir, "goals", goalId, "current.md")
  };
}

export function resolveBranchArtifactPaths(
  paths: WorkspacePaths,
  goalId: string,
  branchId: string
) {
  const goalPaths = resolveGoalPaths(paths, goalId);
  const branchDir = join(goalPaths.branchArtifactsDir, branchId);
  return {
    branchDir,
    outputDir: join(branchDir, "output"),
    stdoutFile: join(branchDir, "stdout.log"),
    stderrFile: join(branchDir, "stderr.log"),
    taskSpecFile: join(branchDir, "task-spec.json"),
    writebackFile: join(branchDir, "writeback.json"),
    reportFile: join(branchDir, "report.md"),
    evalFile: join(branchDir, "judge.json")
  };
}

export async function ensureWorkspace(paths: WorkspacePaths): Promise<void> {
  await Promise.all(
    [
      paths.runsDir,
      paths.plansDir,
      paths.stateDir,
      paths.eventsDir,
      paths.artifactsDir,
      paths.reportsDir,
      join(paths.stateDir, "goals"),
      join(paths.plansDir, "goals"),
      join(paths.eventsDir, "goals"),
      join(paths.artifactsDir, "goals"),
      join(paths.reportsDir, "goals")
    ].map((dir) => mkdir(dir, { recursive: true }))
  );
}

export async function ensureRunDirectories(
  paths: WorkspacePaths,
  runId: string
): Promise<RunPaths> {
  const runPaths = resolveRunPaths(paths, runId);

  await Promise.all(
    [
      runPaths.runDir,
      runPaths.attemptsDir,
      runPaths.steersDir,
      runPaths.artifactsDir
    ].map((dir) => mkdir(dir, { recursive: true }))
  );

  return runPaths;
}

export async function ensureAttemptDirectories(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): Promise<AttemptPaths> {
  const attemptPaths = resolveAttemptPaths(paths, runId, attemptId);

  await Promise.all(
    [attemptPaths.attemptDir, attemptPaths.artifactsDir, attemptPaths.reviewOpinionsDir].map((dir) =>
      mkdir(dir, { recursive: true })
    )
  );

  return attemptPaths;
}

export async function ensureGoalDirectories(
  paths: WorkspacePaths,
  goalId: string
): Promise<GoalPaths> {
  const goalPaths = resolveGoalPaths(paths, goalId);

  await Promise.all(
    [
      goalPaths.goalDir,
      goalPaths.branchesDir,
      goalPaths.workerRunsDir,
      goalPaths.steersDir,
      goalPaths.planDir,
      goalPaths.artifactDir,
      goalPaths.contextDir,
      goalPaths.contextSnapshotsDir,
      join(goalPaths.contextDir, "branch_notes"),
      goalPaths.branchArtifactsDir,
      goalPaths.reportDir,
      goalPaths.reportHistoryDir
    ].map((dir) => mkdir(dir, { recursive: true }))
  );

  return goalPaths;
}

export async function writeJsonFile(
  filePath: string,
  value: unknown
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFileAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextFile(
  filePath: string,
  value: string
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFileAtomically(filePath, value.endsWith("\n") ? value : `${value}\n`);
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function writeFileAtomically(filePath: string, value: string): Promise<void> {
  const tempFilePath = join(
    dirname(filePath),
    `.${basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`
  );

  try {
    await writeFile(tempFilePath, value, "utf8");
    await rename(tempFilePath, filePath);
  } catch (error) {
    await unlink(tempFilePath).catch(() => undefined);
    throw error;
  }
}

export async function saveGoal(
  paths: WorkspacePaths,
  goal: Goal
): Promise<void> {
  await ensureWorkspace(paths);
  const goalPaths = await ensureGoalDirectories(paths, goal.id);
  await writeJsonFile(join(goalPaths.goalDir, "goal.json"), goal);
}

export async function getGoal(
  paths: WorkspacePaths,
  goalId: string
): Promise<Goal> {
  const goal = await readJsonFile<Goal>(
    join(paths.stateDir, "goals", goalId, "goal.json")
  );
  return GoalSchema.parse(goal);
}

export async function listGoals(paths: WorkspacePaths): Promise<Goal[]> {
  await ensureWorkspace(paths);
  const goalsRoot = join(paths.stateDir, "goals");
  const entries = await readdir(goalsRoot, { withFileTypes: true });
  const goals: Goal[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const goal = await getGoal(paths, entry.name);
      goals.push(goal);
    } catch {
      // Ignore incomplete directories during early-stage development.
    }
  }

  return goals.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

async function listJsonFiles<T>(
  dirPath: string,
  parser: (value: unknown) => T
): Promise<T[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const result: T[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const value = await readJsonFile<unknown>(join(dirPath, entry.name));
      result.push(parser(value));
    }

    return result;
  } catch {
    return [];
  }
}

export async function saveRun(paths: WorkspacePaths, run: Run): Promise<void> {
  await ensureWorkspace(paths);
  const runPaths = await ensureRunDirectories(paths, run.id);
  await writeJsonFile(runPaths.contractFile, run);
}

export async function getRun(paths: WorkspacePaths, runId: string): Promise<Run> {
  const run = await readJsonFile<Run>(resolveRunPaths(paths, runId).contractFile);
  return RunSchema.parse(run);
}

export async function listRuns(paths: WorkspacePaths): Promise<Run[]> {
  await ensureWorkspace(paths);
  const entries = await readdir(paths.runsDir, { withFileTypes: true });
  const runs: Run[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      runs.push(await getRun(paths, entry.name));
    } catch {
      // Ignore incomplete run directories while the new storage is being introduced.
    }
  }

  return runs.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function saveCurrentDecision(
  paths: WorkspacePaths,
  currentDecision: CurrentDecision
): Promise<void> {
  const runPaths = await ensureRunDirectories(paths, currentDecision.run_id);
  await writeJsonFile(runPaths.currentFile, currentDecision);
}

export async function getCurrentDecision(
  paths: WorkspacePaths,
  runId: string
): Promise<CurrentDecision | null> {
  try {
    const currentDecision = await readJsonFile<CurrentDecision>(
      resolveRunPaths(paths, runId).currentFile
    );
    return CurrentDecisionSchema.parse(currentDecision);
  } catch {
    return null;
  }
}

export async function saveRunAutomationControl(
  paths: WorkspacePaths,
  automationControl: RunAutomationControl
): Promise<void> {
  const runPaths = await ensureRunDirectories(paths, automationControl.run_id);
  await writeJsonFile(runPaths.automationFile, automationControl);
}

export async function getRunAutomationControl(
  paths: WorkspacePaths,
  runId: string
): Promise<RunAutomationControl | null> {
  try {
    const automationControl = await readJsonFile<RunAutomationControl>(
      resolveRunPaths(paths, runId).automationFile
    );
    return RunAutomationControlSchema.parse(automationControl);
  } catch {
    return null;
  }
}

export async function saveRunWorkingContext(
  paths: WorkspacePaths,
  workingContext: RunWorkingContext
): Promise<void> {
  const runPaths = await ensureRunDirectories(paths, workingContext.run_id);
  await writeJsonFile(runPaths.workingContextFile, workingContext);
}

export async function saveRunBrief(
  paths: WorkspacePaths,
  runBrief: RunBrief
): Promise<void> {
  const runPaths = await ensureRunDirectories(paths, runBrief.run_id);
  await writeJsonFile(runPaths.runBriefFile, runBrief);
}

export async function getRunBrief(
  paths: WorkspacePaths,
  runId: string
): Promise<RunBrief | null> {
  try {
    const runBrief = await readJsonFile<RunBrief>(resolveRunPaths(paths, runId).runBriefFile);
    return RunBriefSchema.parse(runBrief);
  } catch {
    return null;
  }
}

export async function getRunWorkingContext(
  paths: WorkspacePaths,
  runId: string
): Promise<RunWorkingContext | null> {
  try {
    const workingContext = await readJsonFile<RunWorkingContext>(
      resolveRunPaths(paths, runId).workingContextFile
    );
    return RunWorkingContextSchema.parse(workingContext);
  } catch {
    return null;
  }
}

export async function saveRunGovernanceState(
  paths: WorkspacePaths,
  governanceState: RunGovernanceState
): Promise<void> {
  const runPaths = await ensureRunDirectories(paths, governanceState.run_id);
  await writeJsonFile(runPaths.governanceFile, governanceState);
}

export async function saveRunPolicyRuntime(
  paths: WorkspacePaths,
  policyRuntime: RunPolicyRuntime
): Promise<void> {
  const runPaths = await ensureRunDirectories(paths, policyRuntime.run_id);
  await writeJsonFile(runPaths.policyFile, policyRuntime);
}

export async function getRunPolicyRuntime(
  paths: WorkspacePaths,
  runId: string
): Promise<RunPolicyRuntime | null> {
  try {
    const policyRuntime = await readJsonFile<RunPolicyRuntime>(
      resolveRunPaths(paths, runId).policyFile
    );
    return RunPolicyRuntimeSchema.parse(policyRuntime);
  } catch {
    return null;
  }
}

export async function readRunPolicyRuntimeStrict(
  paths: WorkspacePaths,
  runId: string
): Promise<RunPolicyRuntime> {
  const policyRuntime = await readJsonFile<RunPolicyRuntime>(
    resolveRunPaths(paths, runId).policyFile
  );
  return RunPolicyRuntimeSchema.parse(policyRuntime);
}

export async function getRunGovernanceState(
  paths: WorkspacePaths,
  runId: string
): Promise<RunGovernanceState | null> {
  try {
    const governanceState = await readJsonFile<RunGovernanceState>(
      resolveRunPaths(paths, runId).governanceFile
    );
    return RunGovernanceStateSchema.parse(governanceState);
  } catch {
    return null;
  }
}

export async function saveRunMaintenancePlane(
  paths: WorkspacePaths,
  maintenancePlane: RunMaintenancePlane
): Promise<void> {
  const runPaths = await ensureRunDirectories(paths, maintenancePlane.run_id);
  await writeJsonFile(runPaths.maintenancePlaneFile, maintenancePlane);
}

export async function getRunMaintenancePlane(
  paths: WorkspacePaths,
  runId: string
): Promise<RunMaintenancePlane | null> {
  try {
    const maintenancePlane = await readJsonFile<RunMaintenancePlane>(
      resolveRunPaths(paths, runId).maintenancePlaneFile
    );
    return RunMaintenancePlaneSchema.parse(maintenancePlane);
  } catch {
    return null;
  }
}

export async function saveAttempt(
  paths: WorkspacePaths,
  attempt: Attempt
): Promise<void> {
  const attemptPaths = await ensureAttemptDirectories(paths, attempt.run_id, attempt.id);
  await writeJsonFile(attemptPaths.metaFile, attempt);
}

export async function saveAttemptContract(
  paths: WorkspacePaths,
  contract: AttemptContract
): Promise<void> {
  const attemptPaths = await ensureAttemptDirectories(
    paths,
    contract.run_id,
    contract.attempt_id
  );
  await writeJsonFile(attemptPaths.contractFile, contract);
}

export async function getAttempt(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): Promise<Attempt> {
  const attempt = await readJsonFile<Attempt>(resolveAttemptPaths(paths, runId, attemptId).metaFile);
  return AttemptSchema.parse(attempt);
}

export async function getAttemptContract(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): Promise<AttemptContract | null> {
  try {
    const contract = await readJsonFile<AttemptContract>(
      resolveAttemptPaths(paths, runId, attemptId).contractFile
    );
    return AttemptContractSchema.parse(contract);
  } catch {
    return null;
  }
}

export async function listAttempts(
  paths: WorkspacePaths,
  runId: string
): Promise<Attempt[]> {
  const attemptsDir = resolveRunPaths(paths, runId).attemptsDir;
  const attempts: Attempt[] = [];

  try {
    const entries = await readdir(attemptsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      try {
        attempts.push(await getAttempt(paths, runId, entry.name));
      } catch {
        // Ignore incomplete attempt directories during writes.
      }
    }
  } catch {
    return [];
  }

  return attempts.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function saveAttemptContext(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string,
  context: unknown
): Promise<void> {
  const attemptPaths = await ensureAttemptDirectories(paths, runId, attemptId);
  await writeJsonFile(attemptPaths.contextFile, context);
}

export async function getAttemptContext(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): Promise<unknown | null> {
  try {
    return await readJsonFile<unknown>(resolveAttemptPaths(paths, runId, attemptId).contextFile);
  } catch {
    return null;
  }
}

export async function saveAttemptHeartbeat(
  paths: WorkspacePaths,
  heartbeat: AttemptHeartbeat
): Promise<void> {
  const attemptPaths = await ensureAttemptDirectories(
    paths,
    heartbeat.run_id,
    heartbeat.attempt_id
  );
  await writeJsonFile(attemptPaths.heartbeatFile, heartbeat);
}

export async function getAttemptHeartbeat(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): Promise<AttemptHeartbeat | null> {
  try {
    const heartbeat = await readJsonFile<AttemptHeartbeat>(
      resolveAttemptPaths(paths, runId, attemptId).heartbeatFile
    );
    return AttemptHeartbeatSchema.parse(heartbeat);
  } catch {
    return null;
  }
}

export async function saveAttemptRuntimeState(
  paths: WorkspacePaths,
  state: AttemptRuntimeState
): Promise<void> {
  const attemptPaths = await ensureAttemptDirectories(paths, state.run_id, state.attempt_id);
  await writeJsonFile(attemptPaths.runtimeStateFile, state);
}

export async function getAttemptRuntimeState(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): Promise<AttemptRuntimeState | null> {
  try {
    const state = await readJsonFile<AttemptRuntimeState>(
      resolveAttemptPaths(paths, runId, attemptId).runtimeStateFile
    );
    return AttemptRuntimeStateSchema.parse(state);
  } catch {
    return null;
  }
}

export async function appendAttemptRuntimeEvent(
  paths: WorkspacePaths,
  event: AttemptRuntimeEvent
): Promise<void> {
  const attemptPaths = await ensureAttemptDirectories(paths, event.run_id, event.attempt_id);
  await appendFile(attemptPaths.runtimeEventsFile, `${JSON.stringify(event)}\n`, "utf8");
}

export async function listAttemptRuntimeEvents(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string,
  limit?: number
): Promise<AttemptRuntimeEvent[]> {
  try {
    const raw = await readFile(
      resolveAttemptPaths(paths, runId, attemptId).runtimeEventsFile,
      "utf8"
    );
    const parsed = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => AttemptRuntimeEventSchema.parse(JSON.parse(line)))
      .sort((a, b) => a.seq - b.seq);

    if (typeof limit === "number" && limit > 0 && parsed.length > limit) {
      return parsed.slice(-limit);
    }

    return parsed;
  } catch {
    return [];
  }
}

export async function saveAttemptResult(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string,
  result: WorkerWriteback
): Promise<void> {
  const attemptPaths = await ensureAttemptDirectories(paths, runId, attemptId);
  await writeJsonFile(attemptPaths.resultFile, result);
}

export async function getAttemptResult(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): Promise<WorkerWriteback | null> {
  try {
    const result = await readJsonFile<WorkerWriteback>(
      resolveAttemptPaths(paths, runId, attemptId).resultFile
    );
    return WorkerWritebackSchema.parse(result);
  } catch {
    return null;
  }
}

export async function saveAttemptEvaluation(
  paths: WorkspacePaths,
  evaluation: AttemptEvaluation
): Promise<void> {
  const attemptPaths = await ensureAttemptDirectories(
    paths,
    evaluation.run_id,
    evaluation.attempt_id
  );
  await writeJsonFile(attemptPaths.evaluationFile, evaluation);
}

export async function saveAttemptEvaluationSynthesisRecord(
  paths: WorkspacePaths,
  synthesisRecord: AttemptEvaluationSynthesisRecord
): Promise<void> {
  const attemptPaths = await ensureAttemptDirectories(
    paths,
    synthesisRecord.run_id,
    synthesisRecord.attempt_id
  );
  await writeJsonFile(attemptPaths.evaluationSynthesisFile, synthesisRecord);
}

export async function saveAttemptReviewInputPacket(
  paths: WorkspacePaths,
  reviewInputPacket: AttemptReviewInputPacket
): Promise<void> {
  const attemptPaths = await ensureAttemptDirectories(
    paths,
    reviewInputPacket.run_id,
    reviewInputPacket.attempt_id
  );
  await writeJsonFile(attemptPaths.reviewInputPacketFile, reviewInputPacket);
}

export async function saveAttemptReviewPacket(
  paths: WorkspacePaths,
  reviewPacket: AttemptReviewPacket
): Promise<void> {
  const attemptPaths = await ensureAttemptDirectories(
    paths,
    reviewPacket.run_id,
    reviewPacket.attempt_id
  );
  await writeJsonFile(attemptPaths.reviewPacketFile, reviewPacket);
}

export async function saveAttemptHandoffBundle(
  paths: WorkspacePaths,
  handoffBundle: AttemptHandoffBundle
): Promise<void> {
  const attemptPaths = await ensureAttemptDirectories(
    paths,
    handoffBundle.run_id,
    handoffBundle.attempt_id
  );
  await writeJsonFile(attemptPaths.handoffBundleFile, handoffBundle);
}

export async function saveAttemptReviewOpinion(
  paths: WorkspacePaths,
  opinion: AttemptReviewerOpinion
): Promise<void> {
  const attemptPaths = await ensureAttemptDirectories(
    paths,
    opinion.run_id,
    opinion.attempt_id
  );
  await writeJsonFile(join(attemptPaths.reviewOpinionsDir, `${opinion.opinion_id}.json`), opinion);
}

export async function saveAttemptPreflightEvaluation(
  paths: WorkspacePaths,
  evaluation: AttemptPreflightEvaluation
): Promise<void> {
  const attemptPaths = await ensureAttemptDirectories(
    paths,
    evaluation.run_id,
    evaluation.attempt_id
  );
  await writeJsonFile(attemptPaths.preflightEvaluationFile, evaluation);
}

export async function saveAttemptRuntimeVerification(
  paths: WorkspacePaths,
  verification: AttemptRuntimeVerification
): Promise<void> {
  const attemptPaths = await ensureAttemptDirectories(
    paths,
    verification.run_id,
    verification.attempt_id
  );
  await writeJsonFile(attemptPaths.runtimeVerificationFile, verification);
}

export async function saveAttemptAdversarialVerification(
  paths: WorkspacePaths,
  verification: AttemptAdversarialVerification
): Promise<void> {
  const attemptPaths = await ensureAttemptDirectories(
    paths,
    verification.run_id,
    verification.attempt_id
  );
  await writeJsonFile(attemptPaths.adversarialVerificationFile, verification);
}

export async function getAttemptEvaluation(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): Promise<AttemptEvaluation | null> {
  try {
    const evaluation = await readJsonFile<AttemptEvaluation>(
      resolveAttemptPaths(paths, runId, attemptId).evaluationFile
    );
    return AttemptEvaluationSchema.parse(evaluation);
  } catch {
    return null;
  }
}

export async function getAttemptEvaluationSynthesisRecord(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): Promise<AttemptEvaluationSynthesisRecord | null> {
  try {
    const synthesisRecord = await readJsonFile<AttemptEvaluationSynthesisRecord>(
      resolveAttemptPaths(paths, runId, attemptId).evaluationSynthesisFile
    );
    return AttemptEvaluationSynthesisRecordSchema.parse(synthesisRecord);
  } catch {
    return null;
  }
}

export async function getAttemptReviewInputPacket(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): Promise<AttemptReviewInputPacket | null> {
  try {
    const reviewInputPacket = await readJsonFile<AttemptReviewInputPacket>(
      resolveAttemptPaths(paths, runId, attemptId).reviewInputPacketFile
    );
    return AttemptReviewInputPacketSchema.parse(reviewInputPacket);
  } catch {
    return null;
  }
}

export async function getAttemptReviewPacket(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): Promise<AttemptReviewPacket | null> {
  try {
    const reviewPacket = await readJsonFile<AttemptReviewPacket>(
      resolveAttemptPaths(paths, runId, attemptId).reviewPacketFile
    );
    return AttemptReviewPacketSchema.parse(reviewPacket);
  } catch {
    return null;
  }
}

export async function getAttemptHandoffBundle(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): Promise<AttemptHandoffBundle | null> {
  try {
    const handoffBundle = await readJsonFile<AttemptHandoffBundle>(
      resolveAttemptPaths(paths, runId, attemptId).handoffBundleFile
    );
    return AttemptHandoffBundleSchema.parse(handoffBundle);
  } catch {
    return null;
  }
}

export async function listAttemptReviewOpinions(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): Promise<AttemptReviewerOpinion[]> {
  const attemptPaths = resolveAttemptPaths(paths, runId, attemptId);
  const opinions = await listJsonFiles(attemptPaths.reviewOpinionsDir, (value) =>
    AttemptReviewerOpinionSchema.parse(value)
  );

  return opinions.sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export async function getAttemptPreflightEvaluation(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): Promise<AttemptPreflightEvaluation | null> {
  try {
    const evaluation = await readJsonFile<AttemptPreflightEvaluation>(
      resolveAttemptPaths(paths, runId, attemptId).preflightEvaluationFile
    );
    return AttemptPreflightEvaluationSchema.parse(evaluation);
  } catch {
    return null;
  }
}

export async function getAttemptRuntimeVerification(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): Promise<AttemptRuntimeVerification | null> {
  try {
    const verification = await readJsonFile<AttemptRuntimeVerification>(
      resolveAttemptPaths(paths, runId, attemptId).runtimeVerificationFile
    );
    return AttemptRuntimeVerificationSchema.parse(verification);
  } catch {
    return null;
  }
}

export async function getAttemptAdversarialVerification(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string
): Promise<AttemptAdversarialVerification | null> {
  try {
    const verification = await readJsonFile<AttemptAdversarialVerification>(
      resolveAttemptPaths(paths, runId, attemptId).adversarialVerificationFile
    );
    return AttemptAdversarialVerificationSchema.parse(verification);
  } catch {
    return null;
  }
}

export async function getAttemptLogExcerpt(
  paths: WorkspacePaths,
  runId: string,
  attemptId: string,
  stream: "stdout" | "stderr",
  maxChars = 4000
): Promise<string> {
  const attemptPaths = resolveAttemptPaths(paths, runId, attemptId);
  const filePath = stream === "stdout" ? attemptPaths.stdoutFile : attemptPaths.stderrFile;

  try {
    const raw = await readFile(filePath, "utf8");
    const trimmed = raw.trimEnd();
    if (trimmed.length <= maxChars) {
      return trimmed;
    }

    return trimmed.slice(-maxChars);
  } catch {
    return "";
  }
}

export async function saveRunSteer(
  paths: WorkspacePaths,
  runSteer: RunSteer
): Promise<void> {
  const runPaths = await ensureRunDirectories(paths, runSteer.run_id);
  await writeJsonFile(join(runPaths.steersDir, `${runSteer.id}.json`), runSteer);
}

export async function listRunSteers(
  paths: WorkspacePaths,
  runId: string
): Promise<RunSteer[]> {
  const steers = await listJsonFiles(resolveRunPaths(paths, runId).steersDir, (value) =>
    RunSteerSchema.parse(value)
  );

  return steers.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function appendRunJournal(
  paths: WorkspacePaths,
  entry: RunJournalEntry
): Promise<void> {
  const runPaths = await ensureRunDirectories(paths, entry.run_id);
  await appendFile(runPaths.journalFile, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function listRunJournal(
  paths: WorkspacePaths,
  runId: string
): Promise<RunJournalEntry[]> {
  try {
    const raw = await readFile(resolveRunPaths(paths, runId).journalFile, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => RunJournalEntrySchema.parse(JSON.parse(line)))
      .sort((a, b) => a.ts.localeCompare(b.ts));
  } catch {
    return [];
  }
}

export async function saveRunReport(
  paths: WorkspacePaths,
  runId: string,
  markdown: string
): Promise<void> {
  const runPaths = await ensureRunDirectories(paths, runId);
  await writeTextFile(runPaths.reportFile, markdown);
}

export async function getRunReport(
  paths: WorkspacePaths,
  runId: string
): Promise<string> {
  try {
    return await readFile(resolveRunPaths(paths, runId).reportFile, "utf8");
  } catch {
    return "";
  }
}

export async function saveRunRuntimeHealthSnapshot(
  paths: WorkspacePaths,
  snapshot: RuntimeHealthSnapshot
): Promise<void> {
  const runPaths = await ensureRunDirectories(paths, snapshot.run_id);
  await writeJsonFile(runPaths.runtimeHealthSnapshotFile, snapshot);
}

export async function getRunRuntimeHealthSnapshot(
  paths: WorkspacePaths,
  runId: string
): Promise<RuntimeHealthSnapshot | null> {
  try {
    const snapshot = await readJsonFile<RuntimeHealthSnapshot>(
      resolveRunPaths(paths, runId).runtimeHealthSnapshotFile
    );
    return RuntimeHealthSnapshotSchema.parse(snapshot);
  } catch {
    return null;
  }
}

export async function savePlanArtifacts(
  paths: WorkspacePaths,
  goalId: string,
  planMarkdown: string,
  branchSpecs: BranchSpec[],
  evalSpec: EvalSpec
): Promise<void> {
  const goalPaths = await ensureGoalDirectories(paths, goalId);
  await Promise.all([
    writeTextFile(join(goalPaths.planDir, "plan.md"), planMarkdown),
    writeJsonFile(join(goalPaths.planDir, "branch_specs.json"), branchSpecs),
    writeJsonFile(join(goalPaths.planDir, "eval_spec.json"), evalSpec)
  ]);
}

export async function getPlanArtifacts(
  paths: WorkspacePaths,
  goalId: string
): Promise<{
  planMarkdown: string;
  branchSpecs: BranchSpec[];
  evalSpec: EvalSpec;
} | null> {
  const goalPaths = resolveGoalPaths(paths, goalId);

  try {
    const [planMarkdown, branchSpecs, evalSpec] = await Promise.all([
      readFile(join(goalPaths.planDir, "plan.md"), "utf8"),
      readJsonFile<BranchSpec[]>(join(goalPaths.planDir, "branch_specs.json")),
      readJsonFile<EvalSpec>(join(goalPaths.planDir, "eval_spec.json"))
    ]);

    return { planMarkdown, branchSpecs, evalSpec };
  } catch {
    return null;
  }
}

export async function saveBranch(
  paths: WorkspacePaths,
  branch: Branch
): Promise<void> {
  const goalPaths = await ensureGoalDirectories(paths, branch.goal_id);
  await writeJsonFile(join(goalPaths.branchesDir, `${branch.id}.json`), branch);
}

export async function getBranch(
  paths: WorkspacePaths,
  goalId: string,
  branchId: string
): Promise<Branch> {
  const branch = await readJsonFile<Branch>(
    join(paths.stateDir, "goals", goalId, "branches", `${branchId}.json`)
  );
  return BranchSchema.parse(branch);
}

export async function listBranches(
  paths: WorkspacePaths,
  goalId: string
): Promise<Branch[]> {
  return listJsonFiles(join(paths.stateDir, "goals", goalId, "branches"), (value) =>
    BranchSchema.parse(value)
  );
}

export async function saveWorkerRun(
  paths: WorkspacePaths,
  run: WorkerRun
): Promise<void> {
  const goalPaths = await ensureGoalDirectories(paths, run.goal_id);
  await writeJsonFile(join(goalPaths.workerRunsDir, `${run.id}.json`), run);
}

export async function listWorkerRuns(
  paths: WorkspacePaths,
  goalId: string
): Promise<WorkerRun[]> {
  return listJsonFiles(join(paths.stateDir, "goals", goalId, "worker-runs"), (value) =>
    WorkerRunSchema.parse(value)
  );
}

export async function saveSteer(
  paths: WorkspacePaths,
  steer: Steer
): Promise<void> {
  const goalPaths = await ensureGoalDirectories(paths, steer.goal_id);
  await writeJsonFile(join(goalPaths.steersDir, `${steer.id}.json`), steer);
}

export async function listSteers(
  paths: WorkspacePaths,
  goalId: string
): Promise<Steer[]> {
  return listJsonFiles(join(paths.stateDir, "goals", goalId, "steers"), (value) =>
    SteerSchema.parse(value)
  );
}

export async function saveContextBoard(
  paths: WorkspacePaths,
  goalId: string,
  board: ContextBoard
): Promise<void> {
  const goalPaths = await ensureGoalDirectories(paths, goalId);

  await Promise.all([
    writeTextFile(goalPaths.sharedFactsFile, board.shared_facts.join("\n")),
    writeTextFile(goalPaths.openQuestionsFile, board.open_questions.join("\n")),
    writeTextFile(goalPaths.constraintsFile, board.constraints.join("\n")),
    ...Object.entries<string>(board.branch_notes).map(([branchId, note]) =>
      writeTextFile(join(goalPaths.contextDir, "branch_notes", `${branchId}.md`), note)
    )
  ]);
}

export async function getContextBoard(
  paths: WorkspacePaths,
  goalId: string
): Promise<ContextBoard> {
  const goalPaths = resolveGoalPaths(paths, goalId);

  const readLines = async (filePath: string) => {
    try {
      return (await readFile(filePath, "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  const notesDir = join(goalPaths.contextDir, "branch_notes");
  const branchNotes: Record<string, string> = {};

  try {
    const entries = await readdir(notesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      branchNotes[entry.name.replace(/\.md$/, "")] = await readFile(
        join(notesDir, entry.name),
        "utf8"
      );
    }
  } catch {
    // ignore
  }

  return ContextBoardSchema.parse({
    shared_facts: await readLines(goalPaths.sharedFactsFile),
    open_questions: await readLines(goalPaths.openQuestionsFile),
    constraints: await readLines(goalPaths.constraintsFile),
    branch_notes: branchNotes
  });
}

export async function saveContextSnapshot(
  paths: WorkspacePaths,
  snapshot: ContextSnapshot
): Promise<void> {
  const goalPaths = await ensureGoalDirectories(paths, snapshot.goal_id);
  await writeJsonFile(
    join(goalPaths.contextSnapshotsDir, `${snapshot.id}.json`),
    snapshot
  );
}

export async function saveWriteback(
  paths: WorkspacePaths,
  goalId: string,
  branchId: string,
  writeback: WorkerWriteback
): Promise<void> {
  const branchPaths = resolveBranchArtifactPaths(paths, goalId, branchId);
  await mkdir(branchPaths.branchDir, { recursive: true });
  await writeJsonFile(branchPaths.writebackFile, writeback);
}

export async function getWriteback(
  paths: WorkspacePaths,
  goalId: string,
  branchId: string
): Promise<WorkerWriteback | null> {
  const branchPaths = resolveBranchArtifactPaths(paths, goalId, branchId);
  try {
    const writeback = await readJsonFile<WorkerWriteback>(branchPaths.writebackFile);
    return WorkerWritebackSchema.parse(writeback);
  } catch {
    return null;
  }
}

export async function saveEvalResult(
  paths: WorkspacePaths,
  evalResult: EvalResult
): Promise<void> {
  const branchPaths = resolveBranchArtifactPaths(
    paths,
    evalResult.goal_id,
    evalResult.branch_id
  );
  await writeJsonFile(branchPaths.evalFile, evalResult);
}

export async function getEvalResult(
  paths: WorkspacePaths,
  goalId: string,
  branchId: string
): Promise<EvalResult | null> {
  const branchPaths = resolveBranchArtifactPaths(paths, goalId, branchId);
  try {
    const evalResult = await readJsonFile<EvalResult>(branchPaths.evalFile);
    return EvalResultSchema.parse(evalResult);
  } catch {
    return null;
  }
}

export async function saveReport(
  paths: WorkspacePaths,
  goalId: string,
  markdown: string
): Promise<void> {
  const goalPaths = await ensureGoalDirectories(paths, goalId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await Promise.all([
    writeTextFile(goalPaths.currentReportFile, markdown),
    writeTextFile(join(goalPaths.reportHistoryDir, `${stamp}.md`), markdown)
  ]);
}

export async function getReport(
  paths: WorkspacePaths,
  goalId: string
): Promise<string> {
  const goalPaths = resolveGoalPaths(paths, goalId);
  try {
    return await readFile(goalPaths.currentReportFile, "utf8");
  } catch {
    return "";
  }
}
