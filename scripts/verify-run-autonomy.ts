import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAttempt,
  createAttemptContract,
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
  getCurrentDecision,
  listAttempts,
  listRunJournal,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptContract,
  saveAttemptResult,
  saveCurrentDecision,
  saveRun
} from "../packages/state-store/src/index.js";

type CaseResult = {
  id: string;
  status: "pass" | "fail";
  error?: string;
};

class AutoResumeExecutionAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (input.attempt.attempt_type !== "execution") {
      throw new Error("Failed execution should auto-resume through execution.");
    }

    await writeFile(
      join(input.run.workspace_root, "execution-change.md"),
      `execution change from ${input.attempt.id}\n`,
      "utf8"
    );

    return {
      writeback: {
        summary: "Execution retry fixed the blocker and left replayable verification evidence.",
        findings: [
          {
            type: "fact",
            content: "The execution retry wrote the intended workspace artifact.",
            evidence: ["execution-change.md"]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.88,
        artifacts: [{ type: "patch", path: "artifacts/diff.patch" }]
      },
      reportMarkdown: "# fake",
      exitCode: 0
    };
  }
}

class LowSignalResearchAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: { attempt: Attempt }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (input.attempt.attempt_type !== "research") {
      throw new Error("Expected an automatic research retry.");
    }

    return {
      writeback: {
        summary: "Still missing grounded proof for the next move.",
        findings: [
          {
            type: "hypothesis",
            content: "The answer might be elsewhere.",
            evidence: []
          }
        ],
        questions: ["Need stronger repository evidence."],
        recommended_next_steps: [],
        confidence: 0.25,
        artifacts: []
      },
      reportMarkdown: "# fake",
      exitCode: 0
    };
  }
}

class CheckpointExecutionAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (input.attempt.attempt_type !== "execution") {
      throw new Error("Checkpoint auto-resume should keep going through execution.");
    }

    assert.match(
      input.attempt.objective,
      /clean git workspace|提交现场|checkpoint/u
    );

    await writeFile(
      join(input.run.workspace_root, "execution-change.md"),
      `execution change from ${input.attempt.id}\n`,
      "utf8"
    );

    return {
      writeback: {
        summary: "Checkpoint blocker was handled inside execution and the run can keep moving.",
        findings: [
          {
            type: "fact",
            content: "The resumed execution left a replayable workspace change.",
            evidence: ["attempt.checkpoint.blocked", "execution-change.md"]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.8,
        artifacts: [{ type: "patch", path: "artifacts/diff.patch" }]
      },
      reportMarkdown: "# fake",
      exitCode: 0
    };
  }
}

class RecoveryExecutionAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (input.attempt.attempt_type !== "execution") {
      throw new Error("Recovery case should only dispatch execution.");
    }

    await writeFile(
      join(input.run.workspace_root, "execution-change.md"),
      `execution change from ${input.attempt.id}\n`,
      "utf8"
    );

    return {
      writeback: {
        summary: "Recovered execution completed and left verification evidence.",
        findings: [
          {
            type: "fact",
            content: "Patched the intended target after recovery.",
            evidence: ["execution-change.md"]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.9,
        artifacts: [{ type: "patch", path: "artifacts/diff.patch" }]
      },
      reportMarkdown: "# fake",
      exitCode: 0
    };
  }
}

class FastRetryExecutionAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (input.attempt.attempt_type !== "execution") {
      throw new Error("Rate-limited execution retry should stay in execution.");
    }

    await writeFile(
      join(input.run.workspace_root, "execution-change.md"),
      `execution change from ${input.attempt.id}\n`,
      "utf8"
    );

    return {
      writeback: {
        summary: "Provider recovered and the execution retry completed.",
        findings: [
          {
            type: "fact",
            content: "Execution retried after the transient provider limit.",
            evidence: ["execution-change.md"]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.86,
        artifacts: [{ type: "patch", path: "artifacts/diff.patch" }]
      },
      reportMarkdown: "# fake",
      exitCode: 0
    };
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(orchestrator: Orchestrator, iterations: number, delayMs = 40): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await orchestrator.tick();
    await wait(delayMs);
  }
}

async function settleUntil(
  orchestrator: Orchestrator,
  input: {
    workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
    runId: string;
    predicate: (runStatus: string | null, waitingForHuman: boolean) => boolean;
    timeoutMs?: number;
    delayMs?: number;
  }
): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  const delayMs = input.delayMs ?? 80;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await orchestrator.tick();
    const current = await getCurrentDecision(input.workspacePaths, input.runId);
    if (input.predicate(current?.run_status ?? null, current?.waiting_for_human ?? false)) {
      return;
    }
    await wait(delayMs);
  }

  throw new Error(`Timed out while waiting for run ${input.runId} to reach the expected state.`);
}

async function settleUntilSnapshot(
  orchestrator: Orchestrator,
  input: {
    workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
    runId: string;
    predicate: (snapshot: {
      runStatus: string | null;
      waitingForHuman: boolean;
      attempts: Awaited<ReturnType<typeof listAttempts>>;
    }) => boolean;
    timeoutMs?: number;
    delayMs?: number;
  }
): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  const delayMs = input.delayMs ?? 80;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await orchestrator.tick();
    const [current, attempts] = await Promise.all([
      getCurrentDecision(input.workspacePaths, input.runId),
      listAttempts(input.workspacePaths, input.runId)
    ]);
    if (
      input.predicate({
        runStatus: current?.run_status ?? null,
        waitingForHuman: current?.waiting_for_human ?? false,
        attempts
      })
    ) {
      return;
    }
    await wait(delayMs);
  }

  throw new Error(`Timed out while waiting for run ${input.runId} to reach the expected snapshot.`);
}

async function bootstrapRun(title: string): Promise<{
  run: Run;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  rootDir: string;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), `aisa-autonomy-${title}-`));
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);

  const run = createRun({
    title,
    description: "Verify autonomous resume behavior",
    success_criteria: ["Produce the next valid move without defaulting to human wait."],
    constraints: [],
    owner_id: "test",
    workspace_root: rootDir
  });

  await saveRun(workspacePaths, run);
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
    workspacePaths,
    rootDir
  };
}

async function initializeGitRepo(rootDir: string): Promise<void> {
  await writeFile(
    join(rootDir, ".gitignore"),
    ["runs/", "state/", "events/", "artifacts/", "reports/", "plans/"].join("\n") + "\n",
    "utf8"
  );
  await writeFile(join(rootDir, "README.md"), "# autonomy verify\n", "utf8");
  await runCommand(rootDir, ["git", "-C", rootDir, "init"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "config", "user.name", "AISA Verify"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "config", "user.email", "aisa-verify@example.com"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "add", "."]);
  await runCommand(rootDir, ["git", "-C", rootDir, "commit", "-m", "test: seed autonomy repo"]);
}

async function writeExecutionWorkspacePackage(rootDir: string): Promise<void> {
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify(
      {
        name: "aisa-autonomy-temp",
        private: true,
        packageManager: "pnpm@10.27.0",
        scripts: {
          typecheck: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)"'
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
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

async function verifyFailedExecutionAutoResumes(): Promise<void> {
  const { run, workspacePaths, rootDir } = await bootstrapRun("failed-execution-auto-resume");
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);
  const failedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Apply the planned execution step.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  await saveAttempt(workspacePaths, failedExecution);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: failedExecution.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: "Execution failed and is waiting for steer.",
      blocking_reason: "Expected object, received string at artifacts[0]",
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedExecution.id,
      type: "attempt.failed",
      payload: {
        message: "Expected object, received string at artifacts[0]"
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new AutoResumeExecutionAdapter() as never,
    undefined,
    60_000,
    {
      waitingHumanAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await wait(40);
  await settleUntil(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: (runStatus) => runStatus === "completed",
    timeoutMs: 20_000,
    delayMs: 120
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, false, "run should auto resume");
  assert.equal(current.run_status, "completed", "run should finish after the resumed execution");
  assert.equal(current.recommended_next_action, null);
  assert.deepEqual(
    attempts.map((attempt) => attempt.attempt_type),
    ["execution", "execution"]
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["failed", "completed"]
  );
  assert.ok(
    journal.some((entry) => entry.type === "run.auto_resume.scheduled"),
    "expected an automatic resume event"
  );
  assert.ok(
    journal.some((entry) => entry.type === "attempt.verification.passed"),
    "resumed execution should pass runtime verification with the inferred contract"
  );
}

async function verifyRunLaunchResetsAutoResumeBudget(): Promise<void> {
  const { run, workspacePaths, rootDir } = await bootstrapRun(
    "run-launch-resets-auto-resume-budget"
  );
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);

  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.auto_resume.scheduled",
      payload: {
        cycle: 1,
        next_action: "retry_attempt",
        attempt_type: "research",
        reason: "failed_research_retry"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.auto_resume.exhausted",
      payload: {
        attempted_cycles: 1,
        message: "old exhaustion marker"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.launched",
      payload: {}
    })
  );

  const failedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Resume execution after a fresh launch.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  await saveAttempt(workspacePaths, failedExecution);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: failedExecution.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: "Execution failed after relaunch.",
      blocking_reason: "Expected object, received string at artifacts[0]",
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedExecution.id,
      type: "attempt.failed",
      payload: {
        message: "Expected object, received string at artifacts[0]"
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new AutoResumeExecutionAdapter() as never,
    undefined,
    60_000,
    {
      waitingHumanAutoResumeMs: 30,
      maxAutomaticResumeCycles: 1
    }
  );

  await wait(40);
  await settleUntil(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: (runStatus) => runStatus === "completed",
    timeoutMs: 15_000,
    delayMs: 120
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);
  const autoResumeScheduled = journal.filter(
    (entry) => entry.type === "run.auto_resume.scheduled"
  ).length;
  const autoResumeExhausted = journal.filter(
    (entry) => entry.type === "run.auto_resume.exhausted"
  ).length;

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, false, "fresh launch should reset exhausted budget");
  assert.equal(current.run_status, "completed");
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["failed", "completed"]
  );
  assert.equal(
    autoResumeScheduled,
    2,
    "expected the fresh launch to allow one new automatic resume on top of the old history"
  );
  assert.equal(autoResumeExhausted, 1, "old exhaustion marker should not be duplicated");
}

async function verifyRepeatedAutoResumeExhausts(): Promise<void> {
  const { run, workspacePaths } = await bootstrapRun("auto-resume-exhaustion");
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "running",
      recommended_next_action: "start_first_attempt",
      recommended_attempt_type: "research",
      summary: "Bootstrapped for repeated autonomy verification."
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new LowSignalResearchAdapter() as never,
    undefined,
    60_000,
    {
      waitingHumanAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await settle(orchestrator, 24);

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);
  const autoResumeScheduled = journal.filter(
    (entry) => entry.type === "run.auto_resume.scheduled"
  ).length;
  const autoResumeExhausted = journal.filter(
    (entry) => entry.type === "run.auto_resume.exhausted"
  ).length;

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, true, "run should eventually stop for human steer");
  assert.equal(current.run_status, "waiting_steer");
  assert.equal(current.recommended_next_action, "wait_for_human");
  assert.equal(autoResumeScheduled, 2, "expected two automatic resume rounds before retreat");
  assert.equal(autoResumeExhausted, 1, "expected a single exhaustion marker");
  assert.ok(
    current.blocking_reason?.includes("自动续跑已尝试 2 轮"),
    "current decision should explain that the automatic budget was exhausted"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.retreat"),
    "the exhaustion path should stop for human steer instead of retreating into more research"
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.attempt_type),
    ["research", "research", "research", "research"]
  );
  assert.ok(
    attempts.every((attempt) => attempt.status === "completed"),
    "all repeated research attempts should settle before the loop retreats"
  );
}

async function verifyCheckpointBlockerAutoResumesIntoExecution(): Promise<void> {
  const { run, workspacePaths, rootDir } = await bootstrapRun("checkpoint-blocker-auto-resume");
  await initializeGitRepo(rootDir);
  const completedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Leave a verified execution step.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  await saveAttempt(workspacePaths, completedExecution);
  await saveAttemptContract(
    workspacePaths,
    createAttemptContract({
      attempt_id: completedExecution.id,
      run_id: run.id,
      attempt_type: "execution",
      objective: completedExecution.objective,
      success_criteria: completedExecution.success_criteria,
      required_evidence: [
        "git-visible workspace changes",
        "a replayable verification command that checks the execution change"
      ],
      expected_artifacts: ["execution-change.md"],
      verification_plan: {
        commands: [
          {
            purpose: "confirm the execution change was written",
            command:
              "test -f execution-change.md && rg -n '^execution change from' execution-change.md"
          }
        ]
      }
    })
  );
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: completedExecution.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: "Checkpoint creation is blocked.",
      blocking_reason:
        "Execution auto-checkpoint requires a clean git workspace before the attempt starts.",
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.checkpoint.blocked",
      payload: {
        reason: "workspace_not_clean_before_execution",
        message:
          "Execution auto-checkpoint requires a clean git workspace before the attempt starts."
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new CheckpointExecutionAdapter() as never,
    undefined,
    60_000,
    {
      waitingHumanAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await wait(40);
  await settleUntil(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: (runStatus) => runStatus === "completed",
    timeoutMs: 10_000,
    delayMs: 80
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, false, "checkpoint blocker should auto-resume into execution");
  assert.equal(current.run_status, "completed");
  assert.equal(current.recommended_next_action, null);
  assert.deepEqual(
    attempts.map((attempt) => attempt.attempt_type),
    ["execution", "execution"]
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["completed", "completed"]
  );
  assert.ok(
    journal.some((entry) => entry.type === "run.auto_resume.scheduled"),
    "expected the checkpoint blocker to schedule automatic resume"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.blocked"),
    "checkpoint blocker should no longer hard-stop automatic resume"
  );
}

async function verifyRecoveryAutoResumesExecution(): Promise<void> {
  const { run, workspacePaths, rootDir } = await bootstrapRun("recovery-auto-resume");
  await initializeGitRepo(rootDir);

  const researchAttempt = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "research",
      worker: "fake-codex",
      objective: "Find the next execution move.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );
  const executionDraft = {
    attempt_type: "execution" as const,
    objective: "Apply the recovered execution step.",
    success_criteria: ["Leave a verified execution artifact in the workspace."],
    required_evidence: [
      "git-visible workspace changes",
      "a replayable verification command that checks the execution change"
    ],
    forbidden_shortcuts: ["do not claim success without replayable verification"],
    expected_artifacts: ["execution-change.md"],
    verification_plan: {
      commands: [
        {
          purpose: "confirm the execution change was written",
          command:
            "test -f execution-change.md && rg -n '^execution change from' execution-change.md"
        }
      ]
    }
  };
  const researchWriteback: WorkerWriteback = {
    summary: "Repository understanding is strong enough to resume execution.",
    findings: [
      {
        type: "fact",
        content: "Found the right file to patch",
        evidence: ["execution-change.md"]
      }
    ],
    questions: [],
    recommended_next_steps: ["Resume the execution step with the locked contract."],
    confidence: 0.84,
    next_attempt_contract: executionDraft,
    artifacts: []
  };

  await saveAttempt(workspacePaths, researchAttempt);
  await saveAttemptContract(
    workspacePaths,
    createAttemptContract({
      attempt_id: researchAttempt.id,
      run_id: run.id,
      attempt_type: "research",
      objective: researchAttempt.objective,
      success_criteria: researchAttempt.success_criteria,
      required_evidence: [
        "Ground findings in concrete files, commands, or artifacts.",
        "If execution is recommended, leave a replayable execution contract for the next attempt."
      ]
    })
  );
  await saveAttemptResult(workspacePaths, run.id, researchAttempt.id, researchWriteback);
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: researchAttempt.id,
      type: "attempt.created",
      payload: {
        attempt_type: researchAttempt.attempt_type,
        objective: researchAttempt.objective
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: researchAttempt.id,
      type: "attempt.started",
      payload: {
        attempt_type: researchAttempt.attempt_type
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: researchAttempt.id,
      type: "attempt.completed",
      payload: {
        recommendation: "continue",
        goal_progress: 0.62,
        suggested_attempt_type: "execution"
      }
    })
  );

  const orphanedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: executionDraft.objective,
      success_criteria: executionDraft.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "running",
      started_at: new Date().toISOString()
    }
  );

  await saveAttempt(workspacePaths, orphanedExecution);
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: orphanedExecution.id,
      type: "attempt.created",
      payload: {
        attempt_type: orphanedExecution.attempt_type,
        objective: orphanedExecution.objective
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: orphanedExecution.id,
      type: "attempt.started",
      payload: {
        attempt_type: orphanedExecution.attempt_type
      }
    })
  );
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "running",
      latest_attempt_id: orphanedExecution.id,
      recommended_next_action: "attempt_running",
      recommended_attempt_type: "execution",
      summary: "Execution was in flight before restart.",
      waiting_for_human: false
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new RecoveryExecutionAdapter() as never,
    undefined,
    60_000,
    {
      waitingHumanAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await orchestrator.tick();
  await wait(60);
  await settle(orchestrator, 18, 60);

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);

  assert.ok(current, "current decision must exist");
  assert.equal(current.run_status, "completed", "recovered execution should finish the run");
  assert.equal(current.waiting_for_human, false);
  assert.deepEqual(
    attempts.map((attempt) => attempt.attempt_type),
    ["research", "execution", "execution"]
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["completed", "stopped", "completed"]
  );
  assert.ok(
    journal.some((entry) => entry.type === "attempt.recovery_required"),
    "expected recovery journal entry"
  );
  assert.ok(
    journal.some((entry) => entry.type === "run.auto_resume.scheduled"),
    "expected automatic resume after recovery wait"
  );
}

async function verifyRateLimitedExecutionRetriesQuickly(): Promise<void> {
  const { run, workspacePaths, rootDir } = await bootstrapRun("rate-limited-execution-retry");
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);

  const failedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Retry the same execution after a transient provider rate limit.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  await saveAttempt(workspacePaths, failedExecution);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: failedExecution.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: "Execution hit a transient provider limit.",
      blocking_reason: "ERROR: exceeded retry limit, last status: 429 Too Many Requests",
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedExecution.id,
      type: "attempt.failed",
      payload: {
        message: "ERROR: exceeded retry limit, last status: 429 Too Many Requests"
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new FastRetryExecutionAdapter() as never,
    undefined,
    60_000,
    {
      waitingHumanAutoResumeMs: 5_000,
      maxAutomaticResumeCycles: 2,
      providerRateLimitAutoResumeMs: 30,
      maxProviderRateLimitAutoResumeCycles: 4
    }
  );

  await wait(60);
  await settleUntil(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: (runStatus) => runStatus === "completed",
    timeoutMs: 15_000,
    delayMs: 120
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, false);
  assert.equal(current.run_status, "completed");
  assert.deepEqual(
    attempts.map((attempt) => attempt.attempt_type),
    ["execution", "execution"]
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["failed", "completed"]
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.auto_resume.scheduled" &&
        entry.payload.reason === "provider_rate_limited_retry_execution"
    ),
    "provider 429 should schedule a fast execution retry instead of waiting for human steer"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.blocked"),
    "provider 429 should not be treated as a manual blocker"
  );
}

async function verifyRateLimitedResearchRetriesQuickly(): Promise<void> {
  const { run, workspacePaths } = await bootstrapRun("rate-limited-research-retry");

  const failedResearch = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "research",
      worker: "fake-codex",
      objective: "Retry the same research after a transient provider rate limit.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  await saveAttempt(workspacePaths, failedResearch);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: failedResearch.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "research",
      summary: "Research hit a transient provider limit.",
      blocking_reason: "ERROR: exceeded retry limit, last status: 429 Too Many Requests",
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: failedResearch.id,
      type: "attempt.failed",
      payload: {
        message: "ERROR: exceeded retry limit, last status: 429 Too Many Requests"
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new LowSignalResearchAdapter() as never,
    undefined,
    60_000,
    {
      waitingHumanAutoResumeMs: 5_000,
      maxAutomaticResumeCycles: 2,
      providerRateLimitAutoResumeMs: 30,
      maxProviderRateLimitAutoResumeCycles: 4
    }
  );

  await wait(60);
  await settleUntilSnapshot(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: ({ attempts }) => attempts[1]?.status === "completed",
    timeoutMs: 2_000,
    delayMs: 80
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);

  assert.ok(current, "current decision must exist");
  assert.deepEqual(
    attempts.slice(0, 2).map((attempt) => attempt.attempt_type),
    ["research", "research"]
  );
  assert.deepEqual(
    attempts.slice(0, 2).map((attempt) => attempt.status),
    ["failed", "completed"]
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.auto_resume.scheduled" &&
        entry.payload.reason === "provider_rate_limited_retry_research"
    ),
    "provider 429 should schedule a fast research retry instead of blocking on human steer"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.blocked"),
    "provider 429 should not be treated as a manual blocker"
  );
}

async function verifyRuntimeSourceDriftBlocksAutoResume(): Promise<void> {
  const { run, workspacePaths, rootDir } = await bootstrapRun(
    "runtime-source-drift-blocks-auto-resume"
  );
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);

  const orchestrator = new Orchestrator(
    workspacePaths,
    new RecoveryExecutionAdapter() as never,
    undefined,
    60_000,
    {
      waitingHumanAutoResumeMs: 30,
      runtimeSourceDriftAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  const completedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Resume the next execution step after restart.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  const restartMessage = [
    "Execution changed live runtime source files already loaded by the in-process control-api/orchestrator.",
    "Restart before the next dispatch. Affected files: packages/orchestrator/src/index.ts"
  ].join(" ");

  await saveAttempt(workspacePaths, completedExecution);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: completedExecution.id,
      recommended_next_action: "continue_execution",
      recommended_attempt_type: "execution",
      summary: restartMessage,
      blocking_reason: restartMessage,
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.completed",
      payload: {
        recommendation: "continue",
        goal_progress: 0.75,
        suggested_attempt_type: "execution"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.restart_required",
      payload: {
        reason: "runtime_source_drift",
        message: restartMessage,
        affected_files: ["packages/orchestrator/src/index.ts"]
      }
    })
  );

  await wait(40);
  await settle(orchestrator, 6, 80);

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, true);
  assert.equal(current.run_status, "waiting_steer");
  assert.equal(current.recommended_next_action, "continue_execution");
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["completed"]
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.auto_resume.scheduled"),
    "runtime source drift should not auto-schedule the next attempt"
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.auto_resume.blocked" &&
        entry.payload.reason === "runtime_source_drift"
    ),
    "runtime source drift should leave an explicit automatic-resume blocker"
  );
}

async function verifyRuntimeSourceDriftAutoResumesAfterRestart(): Promise<void> {
  const { run, workspacePaths, rootDir } = await bootstrapRun(
    "runtime-source-drift-auto-resumes-after-restart"
  );
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);

  const completedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Resume execution after the runtime restarts.",
      success_criteria: run.success_criteria,
      workspace_root: run.workspace_root
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );

  const restartMessage = [
    "Execution changed live runtime source files already loaded by the in-process control-api/orchestrator.",
    "Restart before the next dispatch. Affected files: packages/orchestrator/src/index.ts"
  ].join(" ");

  await saveAttempt(workspacePaths, completedExecution);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: completedExecution.id,
      recommended_next_action: "continue_execution",
      recommended_attempt_type: "execution",
      summary: restartMessage,
      blocking_reason: restartMessage,
      waiting_for_human: true
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.completed",
      payload: {
        recommendation: "continue",
        goal_progress: 0.75,
        suggested_attempt_type: "execution"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: completedExecution.id,
      type: "attempt.restart_required",
      payload: {
        reason: "runtime_source_drift",
        message: restartMessage,
        affected_files: ["packages/orchestrator/src/index.ts"]
      }
    })
  );

  await wait(40);

  const orchestrator = new Orchestrator(
    workspacePaths,
    new RecoveryExecutionAdapter() as never,
    undefined,
    60_000,
    {
      waitingHumanAutoResumeMs: 30,
      runtimeSourceDriftAutoResumeMs: 30,
      maxAutomaticResumeCycles: 2
    }
  );

  await settleUntil(orchestrator, {
    workspacePaths,
    runId: run.id,
    predicate: (runStatus) => runStatus === "completed",
    timeoutMs: 20_000,
    delayMs: 120
  });

  const current = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);

  assert.ok(current, "current decision must exist");
  assert.equal(current.waiting_for_human, false);
  assert.equal(current.run_status, "completed");
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["completed", "completed"]
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.auto_resume.scheduled" &&
        entry.payload.reason === "runtime_restarted_continue_execution"
    ),
    "runtime source drift should auto-resume quickly after a fresh restart"
  );
  assert.ok(
    journal.some((entry) => entry.type === "attempt.verification.passed"),
    "resumed execution should still pass runtime verification after restart"
  );
}

async function main(): Promise<void> {
  const checks: Array<{ id: string; run: () => Promise<void> }> = [
    {
      id: "failed_execution_auto_resumes",
      run: verifyFailedExecutionAutoResumes
    },
    {
      id: "run_launch_resets_auto_resume_budget",
      run: verifyRunLaunchResetsAutoResumeBudget
    },
    {
      id: "repeated_auto_resume_exhausts",
      run: verifyRepeatedAutoResumeExhausts
    },
    {
      id: "checkpoint_blocker_auto_resumes_execution",
      run: verifyCheckpointBlockerAutoResumesIntoExecution
    },
    {
      id: "rate_limited_execution_retries_quickly",
      run: verifyRateLimitedExecutionRetriesQuickly
    },
    {
      id: "rate_limited_research_retries_quickly",
      run: verifyRateLimitedResearchRetriesQuickly
    },
    {
      id: "runtime_source_drift_blocks_auto_resume",
      run: verifyRuntimeSourceDriftBlocksAutoResume
    },
    {
      id: "runtime_source_drift_auto_resumes_after_restart",
      run: verifyRuntimeSourceDriftAutoResumesAfterRestart
    },
    {
      id: "recovery_auto_resumes_execution",
      run: verifyRecoveryAutoResumesExecution
    }
  ];
  const results: CaseResult[] = [];

  for (const check of checks) {
    try {
      await check.run();
      results.push({
        id: check.id,
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: check.id,
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const failed = results.filter((result) => result.status === "fail");
  console.log(
    JSON.stringify(
      {
        suite: "run-autonomy",
        passed: results.length - failed.length,
        failed: failed.length,
        results
      },
      null,
      2
    )
  );

  assert.equal(failed.length, 0, "Run autonomy verification failed.");
}

await main();
