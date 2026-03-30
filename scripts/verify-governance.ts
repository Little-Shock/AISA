import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAttempt,
  createAttemptContract,
  createCurrentDecision,
  createRun,
  createRunGovernanceState,
  createRunJournalEntry,
  type Attempt,
  type Run,
  type WorkerWriteback
} from "../packages/domain/src/index.js";
import { maybeCreateVerifiedExecutionCheckpoint } from "../packages/orchestrator/src/git-checkpoint.js";
import {
  buildGovernanceCheckpointContext,
  buildGovernanceSignature
} from "../packages/orchestrator/src/governance.js";
import { Orchestrator } from "../packages/orchestrator/src/index.js";
import {
  appendRunJournal,
  ensureWorkspace,
  getCurrentDecision,
  getRunGovernanceState,
  listAttempts,
  listRunJournal,
  resolveAttemptPaths,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptContract,
  saveAttemptResult,
  saveCurrentDecision,
  saveRun,
  saveRunGovernanceState
} from "../packages/state-store/src/index.js";

type CaseResult = {
  id: string;
  status: "pass" | "fail";
  error?: string;
};

class GovernanceExecutionAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: {
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    assert.equal(
      input.attempt.attempt_type,
      "execution",
      "governance should keep the run on execution mainline"
    );
    await writeFile(
      join(input.attempt.workspace_root, "governance-execution.txt"),
      `execution by ${input.attempt.id}\n`,
      "utf8"
    );

    return {
      writeback: {
        summary: "Execution stayed on the verified mainline and left replayable evidence.",
        findings: [
          {
            type: "fact",
            content: "Execution wrote the expected file.",
            evidence: ["governance-execution.txt"]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.92,
        artifacts: [{ type: "patch", path: "artifacts/diff.patch" }]
      },
      reportMarkdown: "# governance",
      exitCode: 0
    };
  }
}

async function bootstrapRun(title: string): Promise<{
  run: Run;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  rootDir: string;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), `aisa-governance-${title}-`));
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);

  const run = createRun({
    title,
    description: "Verify run governance behavior",
    success_criteria: ["Keep a single mainline and block repeated bad plans."],
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

  return { run, workspacePaths, rootDir };
}

async function initializeGitRepo(rootDir: string): Promise<void> {
  await writeFile(
    join(rootDir, ".gitignore"),
    ["runs/", "state/", "events/", "artifacts/", "reports/", "plans/"].join("\n") + "\n",
    "utf8"
  );
  await writeFile(join(rootDir, "README.md"), "# governance verify\n", "utf8");
  await runCommand(rootDir, ["git", "-C", rootDir, "init"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "config", "user.name", "AISA Verify"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "config", "user.email", "aisa-verify@example.com"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "add", "."]);
  await runCommand(rootDir, ["git", "-C", rootDir, "commit", "-m", "test: seed governance repo"]);
}

async function writeExecutionWorkspacePackage(rootDir: string): Promise<void> {
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify(
      {
        name: "aisa-governance-temp",
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
  await mkdir(join(rootDir, "node_modules"), { recursive: true });
  await writeFile(join(rootDir, "node_modules", ".placeholder"), "toolchain\n", "utf8");
}

async function runCommand(rootDir: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const [command, ...commandArgs] = args;
    const child = spawn(command!, commandArgs, {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if ((code ?? 1) !== 0) {
        reject(new Error(stderr || `Command failed: ${args.join(" ")}`));
        return;
      }

      resolve(stdout);
    });
  });
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 4_000
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function buildContinueResearchObjective(input: {
  runTitle: string;
  blockingReason: string;
  latestSummary: string;
}): string {
  return [
    `继续研究目标：${input.runTitle}`,
    `先怀疑并复核这个卡点：${input.blockingReason}`,
    `最新摘要：${input.latestSummary}`,
    "不要延续默认假设，优先找出为什么现有方向可能不成立。"
  ].join("\n");
}

async function verifyGovernancePreservesExecutionMainline(): Promise<void> {
  const { run, workspacePaths, rootDir } = await bootstrapRun("mainline");
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);

  const completedExecution = createAttempt({
    run_id: run.id,
    attempt_type: "execution",
    worker: "fake-codex",
    objective: "Implement the verified next step.",
    success_criteria: run.success_criteria,
    workspace_root: rootDir
  });
  completedExecution.status = "completed";
  completedExecution.started_at = completedExecution.created_at;
  completedExecution.ended_at = completedExecution.created_at;
  await saveAttempt(workspacePaths, completedExecution);
  await saveAttemptContract(
    workspacePaths,
    createAttemptContract({
      attempt_id: completedExecution.id,
      run_id: run.id,
      attempt_type: "execution",
      objective: completedExecution.objective,
      success_criteria: completedExecution.success_criteria,
      required_evidence: ["Leave a git-visible change."],
      verification_plan: {
        commands: [
          {
            purpose: "typecheck",
            command: 'node -e "process.exit(0)"'
          }
        ]
      }
    })
  );
  await saveAttemptResult(workspacePaths, run.id, completedExecution.id, {
    summary: "Execution succeeded and the next mainline step is clear.",
    findings: [
      {
        type: "fact",
        content: "Execution already converged on the right file change.",
        evidence: ["mainline.txt"]
      }
    ],
    questions: [],
    recommended_next_steps: ["Continue the verified execution mainline."],
    confidence: 0.9,
    artifacts: [{ type: "patch", path: "artifacts/diff.patch" }]
  });
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: completedExecution.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "research",
      summary: "Waiting for human.",
      blocking_reason: "Need skeptical re-check.",
      waiting_for_human: true
    })
  );
  await saveRunGovernanceState(
    workspacePaths,
    createRunGovernanceState({
      run_id: run.id,
      status: "ready_to_commit",
      active_problem_signature: buildGovernanceSignature("Need skeptical re-check."),
      active_problem_summary: "Need skeptical re-check.",
      mainline_signature: buildGovernanceSignature("Continue the verified execution mainline."),
      mainline_summary: "Continue the verified execution mainline.",
      mainline_attempt_type: "execution",
      mainline_attempt_id: completedExecution.id,
      next_allowed_actions: ["continue_execution", "wait_for_human", "apply_steer"],
      last_meaningful_progress_at: completedExecution.ended_at,
      last_meaningful_progress_attempt_id: completedExecution.id,
      context_summary: {
        headline: "Execution mainline is already verified.",
        progress_summary: "Execution succeeded and should keep moving.",
        blocker_summary: null,
        avoid_summary: []
      }
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new GovernanceExecutionAdapter() as never,
    undefined,
    50,
    {
      waitingHumanAutoResumeMs: 1,
      attemptHeartbeatIntervalMs: 20,
      attemptHeartbeatStaleMs: 200
    }
  );
  orchestrator.start();
  try {
    await waitFor(async () => (await listAttempts(workspacePaths, run.id)).length >= 2);
  } finally {
    orchestrator.stop();
  }

  const attempts = await listAttempts(workspacePaths, run.id);
  const newAttempts = attempts.filter((attempt) => attempt.id !== completedExecution.id);
  assert.equal(newAttempts.length, 1, "governance should create exactly one follow-up attempt");
  assert.equal(
    newAttempts[0]?.attempt_type,
    "execution",
    "governance should keep auto-resume on execution mainline"
  );
}

async function verifyExcludedPlanBlocksReuse(): Promise<void> {
  const { run, workspacePaths, rootDir } = await bootstrapRun("exclude");
  const latestAttempt = createAttempt({
    run_id: run.id,
    attempt_type: "research",
    worker: "fake-codex",
    objective: "Previous research attempt.",
    success_criteria: run.success_criteria,
    workspace_root: rootDir
  });
  latestAttempt.status = "completed";
  latestAttempt.started_at = latestAttempt.created_at;
  latestAttempt.ended_at = latestAttempt.created_at;
  await saveAttempt(workspacePaths, latestAttempt);
  await saveAttemptResult(workspacePaths, run.id, latestAttempt.id, {
    summary: "Need more evidence around the same blocker.",
    findings: [],
    questions: ["Still blocked."],
    recommended_next_steps: [],
    confidence: 0.2,
    artifacts: []
  });

  const blockingReason = "Repeated blocker still unresolved.";
  const objective = buildContinueResearchObjective({
    runTitle: run.title,
    blockingReason,
    latestSummary: "Need more evidence around the same blocker."
  });

  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "running",
      latest_attempt_id: latestAttempt.id,
      recommended_next_action: "continue_research",
      recommended_attempt_type: "research",
      summary: "Continue research.",
      blocking_reason: blockingReason,
      waiting_for_human: false
    })
  );
  await saveRunGovernanceState(
    workspacePaths,
    createRunGovernanceState({
      run_id: run.id,
      status: "active",
      excluded_plans: [
        {
          plan_signature: buildGovernanceSignature(objective)!,
          objective,
          reason: "This exact research plan already failed once.",
          source_attempt_id: latestAttempt.id,
          source_attempt_status: latestAttempt.status,
          evidence_refs: [],
          excluded_at: latestAttempt.ended_at ?? latestAttempt.updated_at
        }
      ],
      context_summary: {
        headline: "Previous failure should exclude the same plan.",
        progress_summary: null,
        blocker_summary: blockingReason,
        avoid_summary: [`不要再按这个目标继续：${objective}`]
      }
    })
  );

  const orchestrator = new Orchestrator(workspacePaths, new GovernanceExecutionAdapter() as never, undefined, 50);
  orchestrator.start();
  try {
    await waitFor(async () => {
      const current = await getCurrentDecision(workspacePaths, run.id);
      return current?.waiting_for_human === true;
    });
  } finally {
    orchestrator.stop();
  }

  const attempts = await listAttempts(workspacePaths, run.id);
  assert.equal(attempts.length, 1, "excluded plan should prevent a new attempt");
  const current = await getCurrentDecision(workspacePaths, run.id);
  assert.equal(current?.run_status, "waiting_steer");
  assert.match(current?.blocking_reason ?? "", /已证伪方案/u);
  const journal = await listRunJournal(workspacePaths, run.id);
  assert.ok(
    journal.some((entry) => entry.type === "run.governance.dispatch_blocked"),
    "dispatch blocker should be recorded in journal"
  );
}

async function verifyMissingArtifactReferenceBlocksDispatch(): Promise<void> {
  const { run, workspacePaths, rootDir } = await bootstrapRun("missing-artifact");
  const latestAttempt = createAttempt({
    run_id: run.id,
    attempt_type: "research",
    worker: "fake-codex",
    objective: "Previous research attempt.",
    success_criteria: run.success_criteria,
    workspace_root: rootDir
  });
  latestAttempt.status = "completed";
  latestAttempt.started_at = latestAttempt.created_at;
  latestAttempt.ended_at = latestAttempt.created_at;
  await saveAttempt(workspacePaths, latestAttempt);
  await saveAttemptResult(workspacePaths, run.id, latestAttempt.id, {
    summary: "The previous context points to an artifact that no longer exists.",
    findings: [],
    questions: [],
    recommended_next_steps: [],
    confidence: 0.2,
    artifacts: []
  });

  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "running",
      latest_attempt_id: latestAttempt.id,
      recommended_next_action: "continue_research",
      recommended_attempt_type: "research",
      summary: "Continue research.",
      blocking_reason: `Re-check runs/${run.id}/attempts/att_missing/artifacts/current.json before planning.`,
      waiting_for_human: false
    })
  );

  const orchestrator = new Orchestrator(workspacePaths, new GovernanceExecutionAdapter() as never, undefined, 50);
  orchestrator.start();
  try {
    await waitFor(async () => {
      const current = await getCurrentDecision(workspacePaths, run.id);
      return current?.waiting_for_human === true;
    });
  } finally {
    orchestrator.stop();
  }

  const current = await getCurrentDecision(workspacePaths, run.id);
  assert.match(current?.blocking_reason ?? "", /不存在的工件/u);
  const governance = await getRunGovernanceState(workspacePaths, run.id);
  assert.ok(governance, "governance snapshot should be persisted");
  assert.equal(governance?.status, "blocked");
  assert.ok(
    governance?.excluded_plans.some((plan) => plan.reason.includes("missing artifacts")),
    "missing artifact objective should be excluded for future dispatches"
  );
}

async function verifyCheckpointIncludesGovernanceContext(): Promise<void> {
  const { run, workspacePaths, rootDir } = await bootstrapRun("checkpoint-context");
  await writeExecutionWorkspacePackage(rootDir);
  await initializeGitRepo(rootDir);

  const attempt = createAttempt({
    run_id: run.id,
    attempt_type: "execution",
    worker: "fake-codex",
    objective: "Create a governed checkpoint.",
    success_criteria: run.success_criteria,
    workspace_root: rootDir
  });
  await saveAttempt(workspacePaths, attempt);
  const attemptPaths = resolveAttemptPaths(workspacePaths, run.id, attempt.id);
  await writeFile(join(rootDir, "checkpoint-note.txt"), "checkpoint\n", "utf8");
  const preflight = {
    status: "ready" as const,
    repo_root: rootDir,
    head_before: (await runCommand(rootDir, ["git", "-C", rootDir, "rev-parse", "HEAD"])).trim(),
    status_before: [],
    created_at: new Date().toISOString()
  };

  const governance = createRunGovernanceState({
    run_id: run.id,
    status: "ready_to_commit",
    mainline_signature: buildGovernanceSignature("Continue governed execution."),
    mainline_summary: "Continue governed execution.",
    mainline_attempt_type: "execution",
    context_summary: {
      headline: "Checkpoint should carry governance context.",
      progress_summary: "Execution is ready for checkpoint.",
      blocker_summary: null,
      avoid_summary: ["不要再回到旧的研究分叉。"]
    }
  });
  const outcome = await maybeCreateVerifiedExecutionCheckpoint({
    run,
    attempt,
    evaluation: {
      attempt_id: attempt.id,
      run_id: run.id,
      goal_progress: 0.9,
      evidence_quality: 0.9,
      verification_status: "passed",
      recommendation: "continue",
      suggested_attempt_type: "execution",
      rationale: "passed",
      missing_evidence: [],
      review_input_packet_ref: null,
      opinion_refs: [],
      evaluation_synthesis_ref: null,
      synthesis_strategy: "test",
      synthesizer: null,
      reviewer_count: 0,
      created_at: new Date().toISOString()
    },
    attemptPaths,
    preflight,
    governanceContextLines: buildGovernanceCheckpointContext(governance)
  });

  assert.equal(outcome.status, "created");
  const commitBody = await runCommand(rootDir, [
    "git",
    "-C",
    rootDir,
    "show",
    "-s",
    "--format=%B",
    "HEAD"
  ]);
  assert.match(commitBody, /Governance:/u);
  assert.match(commitBody, /Continue governed execution/u);
}

async function main(): Promise<void> {
  const cases: Array<{
    id: string;
    run: () => Promise<void>;
  }> = [
    {
      id: "governance_preserves_execution_mainline",
      run: verifyGovernancePreservesExecutionMainline
    },
    {
      id: "excluded_plan_blocks_reuse",
      run: verifyExcludedPlanBlocksReuse
    },
    {
      id: "missing_artifact_reference_blocks_dispatch",
      run: verifyMissingArtifactReferenceBlocksDispatch
    },
    {
      id: "checkpoint_includes_governance_context",
      run: verifyCheckpointIncludesGovernanceContext
    }
  ];

  const results: CaseResult[] = [];
  for (const testCase of cases) {
    try {
      await testCase.run();
      results.push({
        id: testCase.id,
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: testCase.id,
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const failed = results.filter((item) => item.status === "fail");
  if (failed.length > 0) {
    console.error(JSON.stringify({ suite: "verify-governance", failed }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        suite: "verify-governance",
        passed: results.length,
        failed: 0,
        results
      },
      null,
      2
    )
  );
}

void main();
