import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Branch,
  BranchSpec,
  ContextBoard,
  ContextSnapshot,
  EvalResult,
  EvalSpec,
  Goal,
  Steer,
  WorkerRun,
  WorkerWriteback
} from "@autoresearch/domain";
import {
  BranchSchema,
  ContextBoardSchema,
  ContextSnapshotSchema,
  EvalResultSchema,
  GoalSchema,
  SteerSchema,
  WorkerRunSchema,
  WorkerWritebackSchema
} from "@autoresearch/domain";

export interface WorkspacePaths {
  rootDir: string;
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

export function resolveWorkspacePaths(rootDir: string): WorkspacePaths {
  return {
    rootDir,
    plansDir: join(rootDir, "plans"),
    stateDir: join(rootDir, "state"),
    eventsDir: join(rootDir, "events"),
    artifactsDir: join(rootDir, "artifacts"),
    reportsDir: join(rootDir, "reports")
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
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeTextFile(
  filePath: string,
  value: string
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
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
    ...Object.entries(board.branch_notes).map(([branchId, note]) =>
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
