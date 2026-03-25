import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
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
  | "research_stall"
  | "research_command_failure"
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

    if (this.driver === "execution_parse_failure" && input.attempt.attempt_type === "execution") {
      throw new Error("Expected object, received string at artifacts[0]");
    }

    if (this.driver === "research_command_failure" && input.attempt.attempt_type === "research") {
      throw new Error(
        "Research command failed under sandbox: listen EPERM while running tsx."
      );
    }

    const writeback =
      this.driver === "happy_path" || this.driver === "execution_parse_failure"
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
        artifacts: []
      };
    }

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
