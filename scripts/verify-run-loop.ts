import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAttempt,
  createCurrentDecision,
  createRun,
  createRunJournalEntry,
  updateAttempt,
  type Attempt,
  type Run,
  type WorkerWriteback
} from "../packages/domain/src/index.js";
import { Orchestrator } from "../packages/orchestrator/src/index.js";
import {
  appendRunJournal,
  ensureWorkspace,
  getAttemptEvaluation,
  getCurrentDecision,
  getRun,
  listAttempts,
  listRunJournal,
  resolveWorkspacePaths,
  saveAttempt,
  saveCurrentDecision,
  saveRun
} from "../packages/state-store/src/index.js";

type ScenarioDriver =
  | "happy_path"
  | "running_attempt_owned_elsewhere"
  | "research_stall"
  | "research_command_failure"
  | "execution_checkpoint_blocked_dirty_workspace"
  | "execution_missing_verification_plan"
  | "execution_parse_failure"
  | "orphaned_running_attempt";

type ScenarioExpectation = {
  run_status: string;
  waiting_for_human: boolean;
  recommended_next_action: string | null;
  attempt_types: string[];
  attempt_statuses: string[];
  verification_statuses: string[];
  required_journal_types: string[];
  required_journal_counts: Record<string, number>;
  blocking_reason_includes?: string;
};

type ScenarioCase = {
  id: string;
  description: string;
  driver: ScenarioDriver;
  max_ticks: number;
  expected: ScenarioExpectation;
};

type ScenarioObservation = {
  run_id: string;
  run_status: string | null;
  waiting_for_human: boolean;
  recommended_next_action: string | null;
  attempt_types: string[];
  attempt_statuses: string[];
  verification_statuses: string[];
  journal_types: string[];
  journal_counts: Record<string, number>;
  blocking_reason: string | null;
};

class ScenarioAdapter {
  readonly type = "fake-codex";
  constructor(private readonly driver: ScenarioDriver) {}

  private readonly counts = new Map<string, number>();

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (this.driver === "orphaned_running_attempt") {
      throw new Error("Orphaned running attempt case must not dispatch adapter work.");
    }

    const key = input.run.id;
    const nextCount = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, nextCount);

    if (
      this.driver === "running_attempt_owned_elsewhere" &&
      input.attempt.attempt_type === "research"
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (this.driver === "execution_parse_failure" && input.attempt.attempt_type === "execution") {
      throw new Error("Expected object, received string at artifacts[0]");
    }

    if (this.driver === "research_command_failure" && input.attempt.attempt_type === "research") {
      throw new Error(
        "Research command failed under sandbox: listen EPERM while running tsx."
      );
    }

    if (
      [
        "happy_path",
        "execution_checkpoint_blocked_dirty_workspace",
        "execution_missing_verification_plan"
      ].includes(this.driver) &&
      input.attempt.attempt_type === "execution"
    ) {
      await writeFile(
        join(input.run.workspace_root, "execution-change.md"),
        `execution change from ${input.attempt.id}\n`,
        "utf8"
      );
    }

    const writeback =
      this.driver === "happy_path" ||
      this.driver === "running_attempt_owned_elsewhere" ||
      this.driver === "execution_parse_failure" ||
      this.driver === "execution_checkpoint_blocked_dirty_workspace" ||
      this.driver === "execution_missing_verification_plan"
        ? this.buildHappyPathWriteback(input.attempt)
        : this.buildStuckWriteback(nextCount);

    return {
      writeback,
      reportMarkdown: "# fake",
      exitCode: 0
    };
  }

  private buildHappyPathWriteback(attempt: Attempt): WorkerWriteback {
    if (attempt.attempt_type === "research") {
      return {
        summary: "Repository understanding is strong enough to start execution.",
        findings: [
          {
            type: "fact",
            content: "Found the right files",
            evidence: ["src/app.ts"]
          }
        ],
        questions: [],
        recommended_next_steps: ["Make the smallest useful change in the target file."],
        confidence: 0.82,
        next_attempt_contract: {
          attempt_type: "execution",
          objective: "Make the smallest useful change in the target file.",
          success_criteria: ["Leave a verified implementation step in the workspace."],
          required_evidence: [
            "git-visible workspace changes",
            "a replayable verification command that checks the execution change"
          ],
          forbidden_shortcuts: [
            "do not claim success without replayable verification"
          ],
          expected_artifacts: ["execution-change.md"],
          verification_plan: {
            commands: [
              {
                purpose: "confirm the execution change was written",
                command: `test -f execution-change.md && rg -n "^execution change from" execution-change.md`
              }
            ]
          }
        },
        artifacts: []
      };
    }

    const verificationPlan =
      this.driver === "execution_missing_verification_plan"
        ? undefined
        : {
            commands: [
              {
                purpose: "confirm the execution change was written",
                command: `test -f execution-change.md && rg -n "^execution change from ${attempt.id}$" execution-change.md`
              }
            ]
          };

    return {
      summary: "Executed the change and left verification artifacts.",
      findings: [
        {
          type: "fact",
          content: "Patched the target code path",
          evidence: ["src/app.ts", "npm test"]
        }
      ],
      questions: [],
      recommended_next_steps: [],
      confidence: 0.88,
      verification_plan: verificationPlan,
      artifacts: [{ type: "patch", path: "artifacts/diff.patch" }]
    };
  }

  private buildStuckWriteback(passNumber: number): WorkerWriteback {
    return {
      summary: `Research pass ${passNumber} still needs stronger evidence.`,
      findings: [
        {
          type: "hypothesis",
          content: "Might be in src/unknown.ts",
          evidence: []
        }
      ],
      questions: ["Need proof from the repository."],
      recommended_next_steps: [],
      confidence: 0.3,
      artifacts: []
    };
  }
}

async function settle(orchestrator: Orchestrator, iterations: number): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await orchestrator.tick();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function bootstrapRun(rootDir: string, title: string): Promise<{
  run: Run;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
}> {
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);

  const run = createRun({
    title,
    description: "Verify loop behavior",
    success_criteria: ["Produce a useful next decision"],
    constraints: [],
    owner_id: "test",
    workspace_root: rootDir
  });
  const current = createCurrentDecision({
    run_id: run.id,
    run_status: "running",
    recommended_next_action: "start_first_attempt",
    recommended_attempt_type: "research",
    summary: "Bootstrapped for verification."
  });

  await saveRun(workspacePaths, run);
  await saveCurrentDecision(workspacePaths, current);
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.created",
      payload: {
        title: run.title
      }
    })
  );

  return {
    run,
    workspacePaths
  };
}

async function seedOrphanedRunningAttempt(input: {
  run: Run;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
}): Promise<void> {
  const attempt = updateAttempt(
    createAttempt({
      run_id: input.run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Resume the last execution attempt after restart.",
      success_criteria: input.run.success_criteria,
      workspace_root: input.run.workspace_root
    }),
    {
      status: "running",
      started_at: new Date().toISOString()
    }
  );

  await saveAttempt(input.workspacePaths, attempt);
  await saveCurrentDecision(
    input.workspacePaths,
    createCurrentDecision({
      run_id: input.run.id,
      run_status: "running",
      latest_attempt_id: attempt.id,
      recommended_next_action: "attempt_running",
      recommended_attempt_type: "execution",
      summary: "Execution attempt was in flight before restart.",
      waiting_for_human: false
    })
  );
  await appendRunJournal(
    input.workspacePaths,
    createRunJournalEntry({
      run_id: input.run.id,
      attempt_id: attempt.id,
      type: "attempt.created",
      payload: {
        attempt_type: attempt.attempt_type,
        objective: attempt.objective
      }
    })
  );
  await appendRunJournal(
    input.workspacePaths,
    createRunJournalEntry({
      run_id: input.run.id,
      attempt_id: attempt.id,
      type: "attempt.started",
      payload: {
        attempt_type: attempt.attempt_type
      }
    })
  );
}

async function loadSmokeCases(): Promise<ScenarioCase[]> {
  const smokeDir = join(process.cwd(), "evals", "runtime-run-loop", "datasets", "smoke");
  const entries = await readdir(smokeDir);
  const cases = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map(async (entry) => JSON.parse(await readFile(join(smokeDir, entry), "utf8")) as ScenarioCase)
  );

  assert.ok(cases.length > 0, "Expected at least one runtime smoke case.");
  return cases;
}

async function runCase(scenario: ScenarioCase): Promise<ScenarioObservation> {
  const rootDir = await mkdtemp(join(tmpdir(), `aisa-${scenario.id}-`));
  const { run, workspacePaths } = await bootstrapRun(rootDir, scenario.id);

  if (scenario.driver === "running_attempt_owned_elsewhere") {
    return runConcurrentOwnerCase({ run, workspacePaths });
  }

  if (scenario.driver === "execution_checkpoint_blocked_dirty_workspace") {
    await initializeGitRepo(rootDir, true);
  }

  if (
    scenario.driver === "happy_path" ||
    scenario.driver === "execution_missing_verification_plan"
  ) {
    await initializeGitRepo(rootDir, false);
  }

  if (scenario.driver === "orphaned_running_attempt") {
    await seedOrphanedRunningAttempt({ run, workspacePaths });
  }

  const orchestrator = new Orchestrator(
    workspacePaths,
    new ScenarioAdapter(scenario.driver) as never,
    undefined,
    60_000
  );
  await settle(orchestrator, scenario.max_ticks);
  const persistedRun = await getRun(workspacePaths, run.id);

  assert.equal(persistedRun.id, run.id, `${scenario.id}: persisted run missing`);

  return collectObservation(workspacePaths, run.id);
}

async function runConcurrentOwnerCase(input: {
  run: Run;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
}): Promise<ScenarioObservation> {
  const primary = new Orchestrator(
    input.workspacePaths,
    new ScenarioAdapter("running_attempt_owned_elsewhere") as never,
    undefined,
    60_000
  );
  const secondary = new Orchestrator(
    input.workspacePaths,
    new ScenarioAdapter("running_attempt_owned_elsewhere") as never,
    undefined,
    60_000
  );

  await primary.tick();
  await primary.tick();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await secondary.tick();
  await new Promise((resolve) => setTimeout(resolve, 350));

  const persistedRun = await getRun(input.workspacePaths, input.run.id);
  assert.equal(persistedRun.id, input.run.id, "concurrent owner case: persisted run missing");

  return collectObservation(input.workspacePaths, input.run.id);
}

async function initializeGitRepo(rootDir: string, leaveDirty: boolean): Promise<void> {
  await writeFile(
    join(rootDir, ".gitignore"),
    ["runs/", "state/", "events/", "artifacts/", "reports/", "plans/"].join("\n") + "\n",
    "utf8"
  );
  await writeFile(join(rootDir, "README.md"), "# temp runtime repo\n", "utf8");
  await runCommand(rootDir, ["git", "-C", rootDir, "init"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "config", "user.name", "AISA Smoke"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "config", "user.email", "aisa-smoke@example.com"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "add", "."]);
  await runCommand(rootDir, ["git", "-C", rootDir, "commit", "-m", "test: seed runtime repo"]);

  if (leaveDirty) {
    await writeFile(join(rootDir, "README.md"), "# temp runtime repo\n\nleft dirty\n", "utf8");
  }
}

async function runCommand(rootDir: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const [command, ...commandArgs] = args;
    const child = spawn(command!, commandArgs, {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if ((code ?? 1) !== 0) {
        reject(new Error(stderr || `Command failed: ${args.join(" ")}`));
        return;
      }

      resolve();
    });
  });
}

async function collectObservation(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string
): Promise<ScenarioObservation> {
  const attempts = await listAttempts(workspacePaths, runId);
  const current = await getCurrentDecision(workspacePaths, runId);
  const journal = await listRunJournal(workspacePaths, runId);
  const verificationStatuses = (
    await Promise.all(
      attempts.map(async (attempt) => (await getAttemptEvaluation(workspacePaths, runId, attempt.id))?.verification_status ?? null)
    )
  ).filter((status): status is string => status !== null);
  const journalCounts = journal.reduce<Record<string, number>>((accumulator, entry) => {
    accumulator[entry.type] = (accumulator[entry.type] ?? 0) + 1;
    return accumulator;
  }, {});

  return {
    run_id: runId,
    run_status: current?.run_status ?? null,
    waiting_for_human: current?.waiting_for_human ?? false,
    recommended_next_action: current?.recommended_next_action ?? null,
    attempt_types: attempts.map((attempt) => attempt.attempt_type),
    attempt_statuses: attempts.map((attempt) => attempt.status),
    verification_statuses: verificationStatuses,
    journal_types: journal.map((entry) => entry.type),
    journal_counts: journalCounts,
    blocking_reason: current?.blocking_reason ?? null
  };
}

function assertCase(scenario: ScenarioCase, observation: ScenarioObservation): void {
  assert.equal(observation.run_status, scenario.expected.run_status, `${scenario.id}: run_status`);
  assert.equal(
    observation.waiting_for_human,
    scenario.expected.waiting_for_human,
    `${scenario.id}: waiting_for_human`
  );
  assert.equal(
    observation.recommended_next_action,
    scenario.expected.recommended_next_action,
    `${scenario.id}: recommended_next_action`
  );
  assert.deepEqual(
    observation.attempt_types,
    scenario.expected.attempt_types,
    `${scenario.id}: attempt_types`
  );
  assert.deepEqual(
    observation.attempt_statuses,
    scenario.expected.attempt_statuses,
    `${scenario.id}: attempt_statuses`
  );
  assert.deepEqual(
    observation.verification_statuses,
    scenario.expected.verification_statuses,
    `${scenario.id}: verification_statuses`
  );

  for (const journalType of scenario.expected.required_journal_types) {
    assert.ok(
      observation.journal_types.includes(journalType),
      `${scenario.id}: missing journal type ${journalType}`
    );
  }

  for (const [journalType, count] of Object.entries(scenario.expected.required_journal_counts)) {
    assert.equal(
      observation.journal_counts[journalType] ?? 0,
      count,
      `${scenario.id}: journal count for ${journalType}`
    );
  }

  if (scenario.expected.blocking_reason_includes) {
    assert.ok(
      observation.blocking_reason?.includes(scenario.expected.blocking_reason_includes),
      `${scenario.id}: blocking_reason`
    );
  }
}

async function main(): Promise<void> {
  const scenarios = await loadSmokeCases();
  const results: Array<{
    id: string;
    status: "pass" | "fail";
    observation?: ScenarioObservation;
    error?: string;
  }> = [];

  for (const scenario of scenarios) {
    try {
      const observation = await runCase(scenario);
      assertCase(scenario, observation);

      results.push({
        id: scenario.id,
        status: "pass",
        observation
      });
    } catch (error) {
      results.push({
        id: scenario.id,
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const failed = results.filter((result) => result.status === "fail");
  console.log(
    JSON.stringify(
      {
        suite: "runtime-run-loop-smoke",
        passed: results.length - failed.length,
        failed: failed.length,
        results
      },
      null,
      2
    )
  );

  assert.equal(failed.length, 0, "Runtime smoke suite failed.");
}

await main();
