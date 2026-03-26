import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAttemptContract,
  createAttempt,
  createRunSteer,
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
  getAttemptReviewPacket,
  getCurrentDecision,
  getRun,
  listAttempts,
  listRunJournal,
  resolveAttemptPaths,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptContract,
  saveAttemptEvaluation,
  saveAttemptResult,
  saveAttemptRuntimeVerification,
  saveCurrentDecision,
  saveRun,
  saveRunSteer
} from "../packages/state-store/src/index.js";

type ScenarioDriver =
  | "happy_path"
  | "running_attempt_owned_elsewhere"
  | "research_stall"
  | "research_command_failure"
  | "execution_checkpoint_blocked_dirty_workspace"
  | "execution_missing_verification_plan"
  | "execution_parse_failure"
  | "orphaned_running_attempt"
  | "execution_retry_after_recovery_preserves_contract";

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
  review_packets: Array<{
    attempt_id: string;
    attempt_status: string;
    path: string;
    has_packet: boolean;
    matches_run_id: boolean;
    matches_attempt_id: boolean;
    has_attempt_contract: boolean;
    has_current_decision_snapshot: boolean;
    journal_count: number;
    has_failure_context: boolean;
    has_result: boolean;
    has_evaluation: boolean;
    has_runtime_verification: boolean;
    artifact_manifest_count: number;
  }>;
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
        "execution_missing_verification_plan",
        "execution_retry_after_recovery_preserves_contract"
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
      this.driver === "execution_missing_verification_plan" ||
      this.driver === "execution_retry_after_recovery_preserves_contract"
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
  await saveAttemptContract(
    input.workspacePaths,
    createAttemptContract({
      attempt_id: attempt.id,
      run_id: input.run.id,
      attempt_type: attempt.attempt_type,
      objective: attempt.objective,
      success_criteria: attempt.success_criteria,
      required_evidence: ["Leave replayable verification evidence for the execution retry."],
      expected_artifacts: ["review_packet.json"],
      verification_plan: {
        commands: [
          {
            purpose: "placeholder orphaned attempt replay",
            command: "test -n orphaned-attempt"
          }
        ]
      }
    })
  );
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

async function seedExecutionRetryAfterRecoveryCase(input: {
  run: Run;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  driver: ScenarioDriver;
}): Promise<void> {
  const researchAttempt = updateAttempt(
    createAttempt({
      run_id: input.run.id,
      attempt_type: "research",
      worker: "fake-codex",
      objective: "Find the next execution step and leave a replayable contract.",
      success_criteria: input.run.success_criteria,
      workspace_root: input.run.workspace_root
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  await saveAttempt(input.workspacePaths, researchAttempt);
  await saveAttemptContract(
    input.workspacePaths,
    createAttemptContract({
      attempt_id: researchAttempt.id,
      run_id: input.run.id,
      attempt_type: researchAttempt.attempt_type,
      objective: researchAttempt.objective,
      success_criteria: researchAttempt.success_criteria,
      required_evidence: [
        "Ground findings in concrete files, commands, or artifacts.",
        "If execution is recommended, leave a replayable execution contract for the next attempt."
      ],
      expected_artifacts: ["review_packet.json"]
    })
  );
  const researchWriteback = (
    await new ScenarioAdapter(input.driver).runAttemptTask({
      run: input.run,
      attempt: researchAttempt
    })
  ).writeback;
  await saveAttemptResult(
    input.workspacePaths,
    input.run.id,
    researchAttempt.id,
    researchWriteback
  );
  await saveAttemptEvaluation(input.workspacePaths, {
    attempt_id: researchAttempt.id,
    run_id: input.run.id,
    goal_progress: 0.62,
    evidence_quality: 1,
    verification_status: "not_applicable",
    recommendation: "continue",
    suggested_attempt_type: "execution",
    rationale: "seeded research result is strong enough to hand off to execution",
    missing_evidence: [],
    created_at: new Date().toISOString()
  });
  await saveAttemptRuntimeVerification(input.workspacePaths, {
    attempt_id: researchAttempt.id,
    run_id: input.run.id,
    attempt_type: researchAttempt.attempt_type,
    status: "not_applicable",
    repo_root: null,
    git_head: null,
    git_status: [],
    changed_files: [],
    failure_code: null,
    failure_reason: null,
    command_results: [],
    created_at: new Date().toISOString()
  });
  await appendRunJournal(
    input.workspacePaths,
    createRunJournalEntry({
      run_id: input.run.id,
      attempt_id: researchAttempt.id,
      type: "attempt.created",
      payload: {
        attempt_type: researchAttempt.attempt_type,
        objective: researchAttempt.objective
      }
    })
  );
  await appendRunJournal(
    input.workspacePaths,
    createRunJournalEntry({
      run_id: input.run.id,
      attempt_id: researchAttempt.id,
      type: "attempt.started",
      payload: {
        attempt_type: researchAttempt.attempt_type
      }
    })
  );
  await appendRunJournal(
    input.workspacePaths,
    createRunJournalEntry({
      run_id: input.run.id,
      attempt_id: researchAttempt.id,
      type: "attempt.completed",
      payload: {
        recommendation: "continue",
        goal_progress: 0.62,
        suggested_attempt_type: "execution"
      }
    })
  );

  const stoppedExecutionAttempt = updateAttempt(
    createAttempt({
      run_id: input.run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective:
        researchWriteback.next_attempt_contract?.objective ??
        "Retry the previously planned execution step.",
      success_criteria:
        researchWriteback.next_attempt_contract?.success_criteria ??
        input.run.success_criteria,
      workspace_root: input.run.workspace_root
    }),
    {
      status: "stopped",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  await saveAttempt(input.workspacePaths, stoppedExecutionAttempt);
  await saveAttemptContract(
    input.workspacePaths,
    createAttemptContract({
      attempt_id: stoppedExecutionAttempt.id,
      run_id: input.run.id,
      attempt_type: stoppedExecutionAttempt.attempt_type,
      objective: stoppedExecutionAttempt.objective,
      success_criteria: stoppedExecutionAttempt.success_criteria,
      required_evidence:
        researchWriteback.next_attempt_contract?.required_evidence ?? [
          "git-visible workspace changes",
          "a replayable verification command that checks the execution change"
        ],
      forbidden_shortcuts:
        researchWriteback.next_attempt_contract?.forbidden_shortcuts ?? [],
      expected_artifacts:
        researchWriteback.next_attempt_contract?.expected_artifacts ?? ["execution-change.md"],
      verification_plan: researchWriteback.next_attempt_contract?.verification_plan
    })
  );
  await appendRunJournal(
    input.workspacePaths,
    createRunJournalEntry({
      run_id: input.run.id,
      attempt_id: stoppedExecutionAttempt.id,
      type: "attempt.created",
      payload: {
        attempt_type: stoppedExecutionAttempt.attempt_type,
        objective: stoppedExecutionAttempt.objective
      }
    })
  );
  await appendRunJournal(
    input.workspacePaths,
    createRunJournalEntry({
      run_id: input.run.id,
      attempt_id: stoppedExecutionAttempt.id,
      type: "attempt.started",
      payload: {
        attempt_type: stoppedExecutionAttempt.attempt_type
      }
    })
  );

  const runSteer = createRunSteer({
    run_id: input.run.id,
    content:
      "Retry the same execution step after recovery. Keep the original replayable verification contract."
  });
  await saveRunSteer(input.workspacePaths, runSteer);

  await saveCurrentDecision(
    input.workspacePaths,
    createCurrentDecision({
      run_id: input.run.id,
      run_status: "running",
      latest_attempt_id: stoppedExecutionAttempt.id,
      recommended_next_action: "apply_steer",
      recommended_attempt_type: "execution",
      summary: "Steer queued. Loop will use it in the next attempt.",
      waiting_for_human: false
    })
  );
  await appendRunJournal(
    input.workspacePaths,
    createRunJournalEntry({
      run_id: input.run.id,
      type: "run.steer.queued",
      payload: {
        content: runSteer.content
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
    scenario.driver === "execution_missing_verification_plan" ||
    scenario.driver === "execution_retry_after_recovery_preserves_contract"
  ) {
    await initializeGitRepo(rootDir, false);
  }

  if (scenario.driver === "orphaned_running_attempt") {
    await seedOrphanedRunningAttempt({ run, workspacePaths });
  }

  if (scenario.driver === "execution_retry_after_recovery_preserves_contract") {
    await seedExecutionRetryAfterRecoveryCase({
      run,
      workspacePaths,
      driver: scenario.driver
    });
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
  const reviewPackets = await Promise.all(
    attempts
      .filter((attempt) => ["completed", "failed", "stopped"].includes(attempt.status))
      .map(async (attempt) => {
        const reviewPacket = await getAttemptReviewPacket(workspacePaths, runId, attempt.id);
        return {
          attempt_id: attempt.id,
          attempt_status: attempt.status,
          path: resolveAttemptPaths(workspacePaths, runId, attempt.id).reviewPacketFile,
          has_packet: reviewPacket !== null,
          matches_run_id: reviewPacket?.run_id === runId,
          matches_attempt_id:
            reviewPacket?.attempt_id === attempt.id && reviewPacket?.attempt.id === attempt.id,
          has_attempt_contract: reviewPacket?.attempt_contract !== null,
          has_current_decision_snapshot: reviewPacket?.current_decision_snapshot !== null,
          journal_count: reviewPacket?.journal.length ?? 0,
          has_failure_context: reviewPacket?.failure_context !== null,
          has_result: reviewPacket?.result !== null,
          has_evaluation: reviewPacket?.evaluation !== null,
          has_runtime_verification: reviewPacket?.runtime_verification !== null,
          artifact_manifest_count: reviewPacket?.artifact_manifest.length ?? 0
        };
      })
  );

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
    blocking_reason: current?.blocking_reason ?? null,
    review_packets: reviewPackets
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

  assert.equal(
    observation.review_packets.length,
    observation.attempt_statuses.filter((status) =>
      ["completed", "failed", "stopped"].includes(status)
    ).length,
    `${scenario.id}: settled attempts should all persist review packets`
  );

  for (const reviewPacket of observation.review_packets) {
    assert.ok(reviewPacket.has_packet, `${scenario.id}: missing review packet for ${reviewPacket.attempt_id}`);
    assert.ok(
      reviewPacket.matches_run_id,
      `${scenario.id}: review packet run_id mismatch for ${reviewPacket.attempt_id}`
    );
    assert.ok(
      reviewPacket.matches_attempt_id,
      `${scenario.id}: review packet attempt metadata mismatch for ${reviewPacket.attempt_id}`
    );
    assert.ok(
      reviewPacket.has_attempt_contract,
      `${scenario.id}: review packet missing attempt contract for ${reviewPacket.attempt_id}`
    );
    assert.ok(
      reviewPacket.has_current_decision_snapshot,
      `${scenario.id}: review packet missing current decision snapshot for ${reviewPacket.attempt_id}`
    );
    assert.ok(
      reviewPacket.artifact_manifest_count > 0,
      `${scenario.id}: review packet missing artifact manifest for ${reviewPacket.attempt_id}`
    );

    if (reviewPacket.attempt_status === "completed") {
      assert.ok(
        reviewPacket.has_result,
        `${scenario.id}: completed attempt missing result in review packet for ${reviewPacket.attempt_id}`
      );
      assert.ok(
        reviewPacket.has_evaluation,
        `${scenario.id}: completed attempt missing evaluation in review packet for ${reviewPacket.attempt_id}`
      );
      assert.ok(
        reviewPacket.has_runtime_verification,
        `${scenario.id}: completed attempt missing runtime verification in review packet for ${reviewPacket.attempt_id}`
      );
    } else {
      assert.ok(
        reviewPacket.journal_count > 0 || reviewPacket.has_failure_context,
        `${scenario.id}: blocker attempt missing journal and failure context for ${reviewPacket.attempt_id}`
      );
    }
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
