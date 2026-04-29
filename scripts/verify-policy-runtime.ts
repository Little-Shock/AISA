import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAttempt,
  createAttemptContract,
  createCurrentDecision,
  createRun,
  createRunJournalEntry,
  createRunPolicyRuntime,
  updateAttempt,
  type Attempt,
  type Run,
  type WorkerWriteback
} from "../packages/domain/src/index.ts";
import { buildServer } from "../apps/control-api/src/index.ts";
import {
  createRunWorkspaceScopePolicy,
  Orchestrator
} from "../packages/orchestrator/src/index.ts";
import type {
  ExecutionPlanLeaderAdapter,
  ExecutionPlanLeaderDecision,
  ExecutionPlanLeaderPacket
} from "../packages/orchestrator/src/execution-plan-leader.ts";
import {
  appendRunJournal,
  ensureWorkspace,
  getCurrentDecision,
  getAttemptRuntimeVerification,
  getRunPolicyRuntime,
  listAttempts,
  listRunJournal,
  readRunPolicyRuntimeStrict,
  resolveRunPaths,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptContract,
  saveAttemptResult,
  saveCurrentDecision,
  saveRun,
  saveRunPolicyRuntime
} from "../packages/state-store/src/index.ts";
import {
  cleanupTrackedVerifyTempDirs,
  createTrackedVerifyTempDir
} from "./verify-temp.ts";

type CaseResult = {
  id: string;
  status: "pass" | "fail";
  error?: string;
};

class PolicyScenarioAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: {
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    if (input.attempt.attempt_type === "execution") {
      await writeFile(
        join(input.attempt.workspace_root, "approved-execution.txt"),
        `execution by ${input.attempt.id}\n`,
        "utf8"
      );
      await writePolicyAdversarialVerificationFixture(
        input.attempt.workspace_root,
        input.attempt.id
      );

      return {
        writeback: {
          summary: "Execution ran after approval.",
          findings: [
            {
              type: "fact",
              content: "Execution left the approved artifact.",
              evidence: ["approved-execution.txt"]
            }
          ],
          questions: [],
          recommended_next_steps: [],
          confidence: 0.92,
          artifacts: [
            {
              type: "patch",
              path: "approved-execution.txt"
            },
            {
              type: "test_result",
              path: "artifacts/adversarial-verification.json"
            }
          ]
        },
        reportMarkdown: "# execution approved",
        exitCode: 0
      };
    }

    await writeFile(
      join(input.attempt.workspace_root, "research-replan.txt"),
      `research by ${input.attempt.id}\n`,
      "utf8"
    );

    return {
      writeback: {
        summary: "Research replanned after rejection.",
        findings: [
          {
            type: "fact",
            content: "Research reopened the planning lane.",
            evidence: ["research-replan.txt"]
          }
        ],
        questions: ["Need a better execution proposal."],
        recommended_next_steps: ["Return with a smaller execution plan."],
        confidence: 0.61,
        artifacts: [
          {
            type: "report",
            path: "research-replan.txt"
          }
        ]
      },
      reportMarkdown: "# research replan",
      exitCode: 0
    };
  }
}

async function writePolicyAdversarialVerificationFixture(
  workspaceRoot: string,
  attemptId: string
): Promise<void> {
  const artifactDir = join(workspaceRoot, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    join(artifactDir, "adversarial-verification.json"),
    JSON.stringify(
      {
        target_surface: "repo",
        summary: `Policy verification adversarial fixture passed for ${attemptId}.`,
        verdict: "pass",
        checks: [
          {
            code: "policy_fixture_postflight",
            status: "passed",
            message: "Execution left a replayable artifact and postflight evidence."
          }
        ],
        commands: [
          {
            purpose: "confirm approved execution artifact",
            command: "test -f approved-execution.txt",
            exit_code: 0,
            status: "passed",
            output_ref: "approved-execution.txt"
          }
        ],
        output_refs: ["approved-execution.txt"]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
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

async function initializeGitRepo(rootDir: string): Promise<void> {
  await writeFile(join(rootDir, "README.md"), "# policy runtime\n", "utf8");
  await runCommand(rootDir, ["git", "-C", rootDir, "init"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "config", "user.name", "AISA Verify"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "config", "user.email", "aisa-verify@example.com"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "add", "README.md"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "commit", "-m", "test: seed repo"]);
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000
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

async function driveOrchestratorUntil(input: {
  orchestrator: Orchestrator;
  predicate: () => Promise<boolean>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 20_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await input.predicate()) {
      return;
    }

    await input.orchestrator.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out after ${timeoutMs}ms while driving orchestrator`);
}

async function bootstrapExecutionApprovalRun(
  title: string,
  options?: {
    verificationCommand?: string;
    verificationPurpose?: string;
  }
): Promise<{
  runtimeDataRoot: string;
  workspaceRoot: string;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  run: Run;
  latestAttempt: Attempt;
}> {
  const runtimeDataRoot = await createTrackedVerifyTempDir(
    `aisa-policy-runtime-${title}-`
  );
  const workspaceRoot = await createTrackedVerifyTempDir(
    `aisa-policy-workspace-${title}-`
  );
  const workspacePaths = resolveWorkspacePaths(runtimeDataRoot);
  await ensureWorkspace(workspacePaths);
  await initializeGitRepo(workspaceRoot);

  const run = createRun({
    title,
    description: "Verify policy runtime approval gating for execution attempts.",
    success_criteria: ["Execution should require approval before dispatch."],
    constraints: [],
    owner_id: "policy-verify",
    workspace_root: workspaceRoot
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

  const researchAttempt = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "research",
      worker: "fake-codex",
      objective: "Inspect the repository and propose the next execution step.",
      success_criteria: run.success_criteria,
      workspace_root: workspaceRoot
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );
  await saveAttempt(workspacePaths, researchAttempt);
  await saveAttemptContract(
    workspacePaths,
    createAttemptContract({
      attempt_id: researchAttempt.id,
      run_id: run.id,
      attempt_type: "research",
      objective: researchAttempt.objective,
      success_criteria: researchAttempt.success_criteria,
      required_evidence: ["Leave repository evidence for the next step."]
    })
  );
  await saveAttemptResult(workspacePaths, run.id, researchAttempt.id, {
    summary: "Research found a concrete execution plan.",
    findings: [
      {
        type: "fact",
        content: "The repository is ready for a small execution step.",
        evidence: ["README.md"]
      }
    ],
    questions: [],
    recommended_next_steps: ["Write the approved execution artifact."],
    confidence: 0.84,
    next_attempt_contract: {
      attempt_type: "execution",
      objective: "Write the approved execution artifact.",
      success_criteria: ["Leave a verified execution artifact in the workspace."],
      required_evidence: ["git-visible workspace changes", "a replayable verification command"],
      adversarial_verification_required: true,
      done_rubric: [
        {
          code: "git_change_recorded",
          description: "Leave a git-visible workspace change."
        },
        {
          code: "verification_replay_passed",
          description: "Pass the replayable verification command."
        }
      ],
      failure_modes: [
        {
          code: "missing_replayable_verification_plan",
          description: "Do not dispatch without replayable verification."
        }
      ],
      expected_artifacts: ["approved-execution.txt"],
      verification_plan: {
        commands: [
          {
            purpose:
              options?.verificationPurpose ?? "confirm the approved artifact exists",
            command: options?.verificationCommand ?? "test -f approved-execution.txt"
          }
        ]
      }
    },
    artifacts: [
      {
        type: "report",
        path: "README.md"
      }
    ]
  });
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "running",
      latest_attempt_id: researchAttempt.id,
      best_attempt_id: researchAttempt.id,
      recommended_next_action: "continue_execution",
      recommended_attempt_type: "execution",
      summary: "Research is done. The next step is execution.",
      waiting_for_human: false
    })
  );

  return {
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    run,
    latestAttempt: researchAttempt
  };
}

async function createScenarioOrchestrator(input: {
  runtimeDataRoot: string;
  workspaceRoot: string;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  executionApprovalMode?: "auto" | "human" | "leader";
  executionPlanLeader?: ExecutionPlanLeaderAdapter | null;
}): Promise<Orchestrator> {
  const runWorkspaceScopePolicy = await createRunWorkspaceScopePolicy({
    runtimeRoot: input.runtimeDataRoot,
    allowedRoots: [input.runtimeDataRoot, input.workspaceRoot]
  });

  return new Orchestrator(
    input.workspacePaths,
    new PolicyScenarioAdapter() as never,
    undefined,
    50,
    {
      runWorkspaceScopePolicy,
      executionApprovalMode: input.executionApprovalMode,
      executionPlanLeader: input.executionPlanLeader,
      waitingHumanAutoResumeMs: 60_000,
      attemptHeartbeatIntervalMs: 20,
      attemptHeartbeatStaleMs: 200
    }
  );
}

function createStaticLeaderAdapter(input: {
  actor: string;
  decision: ExecutionPlanLeaderDecision;
  packets?: ExecutionPlanLeaderPacket[];
}): ExecutionPlanLeaderAdapter {
  return {
    actor: input.actor,
    async reviewExecutionPlan({ approvalPacket }) {
      input.packets?.push(approvalPacket);
      return {
        raw_output: JSON.stringify(
          {
            structured_decision: input.decision
          },
          null,
          2
        ),
        structured_decision: input.decision
      };
    }
  };
}

function createFailingLeaderAdapter(actor = "leader-fixture"): ExecutionPlanLeaderAdapter {
  return {
    actor,
    async reviewExecutionPlan() {
      throw new Error("leader lane crashed");
    }
  };
}

async function waitForPendingApproval(
  orchestrator: Orchestrator,
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string
): Promise<void> {
  await driveOrchestratorUntil({
    orchestrator,
    predicate: async () => {
      const [current, policy, journal] = await Promise.all([
        getCurrentDecision(workspacePaths, runId),
        getRunPolicyRuntime(workspacePaths, runId),
        listRunJournal(workspacePaths, runId)
      ]);
      return (
        current?.waiting_for_human === true &&
        current.run_status === "waiting_steer" &&
        policy?.approval_status === "pending" &&
        journal.some((entry) => entry.type === "run.policy.approval_requested")
      );
    }
  });
}

async function verifyExecutionAutoDispatchesByDefault(): Promise<void> {
  const { runtimeDataRoot, workspaceRoot, workspacePaths, run } =
    await bootstrapExecutionApprovalRun("auto-dispatch-default");
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths
  });

  await driveOrchestratorUntil({
    orchestrator,
    predicate: async () =>
      (await listAttempts(workspacePaths, run.id)).some(
        (attempt) => attempt.attempt_type === "execution" && attempt.status === "completed"
      )
  });

  const [attempts, current, policy, journal] = await Promise.all([
    listAttempts(workspacePaths, run.id),
    getCurrentDecision(workspacePaths, run.id),
    readRunPolicyRuntimeStrict(workspacePaths, run.id),
    listRunJournal(workspacePaths, run.id)
  ]);
  assert.equal(
    attempts.some((attempt) => attempt.attempt_type === "execution"),
    true,
    "default execution policy should dispatch without manual approval"
  );
  assert.equal(policy.approval_required, false);
  assert.equal(policy.approval_status, "not_required");
  assert.ok(
    !journal.some((entry) => entry.type === "run.policy.approval_requested"),
    "default execution policy should not queue leader approval"
  );
}

async function verifyLeaderApprovalDispatchesWithoutHumanStop(): Promise<void> {
  const packets: ExecutionPlanLeaderPacket[] = [];
  const { runtimeDataRoot, workspaceRoot, workspacePaths, run } =
    await bootstrapExecutionApprovalRun("leader-approval-dispatch");
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    executionApprovalMode: "leader",
    executionPlanLeader: createStaticLeaderAdapter({
      actor: "leader-fixture",
      packets,
      decision: {
        decision: "approve",
        rationale: "Replay plan is bounded and execution is ready.",
        follow_up: ["Keep the replay contract unchanged."]
      }
    })
  });

  await driveOrchestratorUntil({
    orchestrator,
    predicate: async () =>
      (await listAttempts(workspacePaths, run.id)).some(
        (attempt) => attempt.attempt_type === "execution" && attempt.status === "completed"
      )
  });

  const journal = await listRunJournal(workspacePaths, run.id);
  assert.equal(packets.length > 0, true, "leader lane should receive an approval packet");
  assert.equal(packets[0]?.proposed_attempt_type, "execution");
  assert.equal(packets[0]?.permission_profile, "workspace_write");
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.policy.approved" && entry.payload.actor === "leader-fixture"
    ),
    "leader lane approval should be recorded"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.policy.approval_requested"),
    "leader lane should not fall back to human approval"
  );
}

async function verifyLeaderRejectionAutoReplansResearch(): Promise<void> {
  const { runtimeDataRoot, workspaceRoot, workspacePaths, run } =
    await bootstrapExecutionApprovalRun("leader-rejection-replan");
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    executionApprovalMode: "leader",
    executionPlanLeader: createStaticLeaderAdapter({
      actor: "leader-fixture",
      decision: {
        decision: "reject",
        rationale: "Need a smaller execution step.",
        follow_up: ["Collect more repository evidence before execution."]
      }
    })
  });

  await driveOrchestratorUntil({
    orchestrator,
    predicate: async () =>
      (await listAttempts(workspacePaths, run.id)).filter(
        (attempt) => attempt.attempt_type === "research" && attempt.status === "completed"
      ).length >= 2
  });

  const [attempts, journal] = await Promise.all([
    listAttempts(workspacePaths, run.id),
    listRunJournal(workspacePaths, run.id)
  ]);
  const followupResearchAttempts = attempts.filter(
    (attempt) => attempt.attempt_type === "research"
  );
  assert.equal(
    followupResearchAttempts.length >= 2,
    true,
    "leader rejection should trigger a new research loop instead of stalling"
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.policy.rejected" && entry.payload.actor === "leader-fixture"
    ),
    "leader rejection should be recorded"
  );
  assert.ok(
    !journal.some((entry) => entry.type === "run.policy.approval_requested"),
    "leader rejection should stay off the human approval lane"
  );
}

async function verifyLeaderReviewFailureFailsClosed(): Promise<void> {
  const { runtimeDataRoot, workspaceRoot, workspacePaths, run } =
    await bootstrapExecutionApprovalRun("leader-review-failure");
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    executionApprovalMode: "leader",
    executionPlanLeader: createFailingLeaderAdapter()
  });

  await driveOrchestratorUntil({
    orchestrator,
    predicate: async () => {
      const current = await getCurrentDecision(workspacePaths, run.id);
      return current?.waiting_for_human === true;
    }
  });

  const [attempts, current] = await Promise.all([
    listAttempts(workspacePaths, run.id),
    getCurrentDecision(workspacePaths, run.id)
  ]);
  assert.equal(attempts.length, 1, "broken leader lane must not auto-dispatch execution");
  assert.match(current?.blocking_reason ?? "", /leader review failed/i);
}

async function verifyExecutionPlanRequiresApproval(): Promise<void> {
  const { runtimeDataRoot, workspaceRoot, workspacePaths, run } =
    await bootstrapExecutionApprovalRun("pending-approval");
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    executionApprovalMode: "human"
  });
  await waitForPendingApproval(orchestrator, workspacePaths, run.id);

  const [attempts, current, policy, journal] = await Promise.all([
    listAttempts(workspacePaths, run.id),
    getCurrentDecision(workspacePaths, run.id),
    readRunPolicyRuntimeStrict(workspacePaths, run.id),
    listRunJournal(workspacePaths, run.id)
  ]);
  assert.equal(attempts.length, 1, "execution attempt should not be created before approval");
  assert.equal(current?.waiting_for_human, true);
  assert.equal(policy.stage, "approval");
  assert.equal(policy.approval_status, "pending");
  assert.equal(policy.approval_required, true);
  assert.equal(policy.proposed_attempt_type, "execution");
  assert.equal(policy.permission_profile, "workspace_write");
  assert.equal(policy.hook_policy, "enforce_runtime_contract");
  assert.ok(
    journal.some((entry) => entry.type === "run.policy.approval_requested"),
    "pending approval should be recorded in journal"
  );
}

async function verifyLaunchBypassIsBlockedWhileApprovalPending(): Promise<void> {
  const { runtimeDataRoot, workspaceRoot, workspacePaths, run } =
    await bootstrapExecutionApprovalRun("launch-blocked");
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    executionApprovalMode: "human"
  });
  await waitForPendingApproval(orchestrator, workspacePaths, run.id);

  const app = await buildServer({
    runtimeDataRoot,
    workspaceRoot,
    startOrchestrator: false
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/runs/${run.id}/launch`
    });
    assert.equal(response.statusCode, 409);
  } finally {
    await app.close();
  }
}

async function verifyApproveRouteUnlocksExecution(): Promise<void> {
  const { runtimeDataRoot, workspaceRoot, workspacePaths, run } =
    await bootstrapExecutionApprovalRun("approve-route");
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    executionApprovalMode: "human"
  });
  await waitForPendingApproval(orchestrator, workspacePaths, run.id);

  const app = await buildServer({
    runtimeDataRoot,
    workspaceRoot,
    startOrchestrator: false
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/runs/${run.id}/policy/approve`,
      payload: {
        actor: "policy-verifier",
        note: "Execution plan is approved."
      }
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json() as {
      current: {
        run_status: string;
        waiting_for_human: boolean;
      };
      policy_runtime: {
        approval_status: string;
        stage: string;
        approval_actor: string | null;
      };
    };
    assert.equal(payload.current.run_status, "running");
    assert.equal(payload.current.waiting_for_human, false);
    assert.equal(payload.policy_runtime.approval_status, "approved");
    assert.equal(payload.policy_runtime.stage, "execution");
    assert.equal(payload.policy_runtime.approval_actor, "policy-verifier");
  } finally {
    await app.close();
  }

  const resumedOrchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    executionApprovalMode: "human"
  });
  await driveOrchestratorUntil({
    orchestrator: resumedOrchestrator,
    predicate: async () =>
      (await listAttempts(workspacePaths, run.id)).some(
        (attempt) => attempt.attempt_type === "execution" && attempt.status === "completed"
      )
  });

  const attempts = await listAttempts(workspacePaths, run.id);
  const latestAttempt = attempts.at(-1) ?? null;
  assert.equal(latestAttempt?.attempt_type, "execution");
  assert.equal(latestAttempt?.status, "completed");

  const consumedPolicy = await readRunPolicyRuntimeStrict(workspacePaths, run.id);
  assert.equal(consumedPolicy.stage, "planning");
  assert.equal(consumedPolicy.approval_status, "not_required");
  assert.equal(consumedPolicy.approval_required, false);
  assert.equal(consumedPolicy.proposed_attempt_type, null);
  assert.equal(consumedPolicy.last_decision, "execution_consumed");
  assert.equal(consumedPolicy.source_attempt_id, latestAttempt?.id);

  await resumedOrchestrator.tick();
  const attemptsAfterExtraTick = await listAttempts(workspacePaths, run.id);
  assert.equal(
    attemptsAfterExtraTick.length,
    attempts.length,
    "consumed approved execution policy should not dispatch a duplicate execution attempt"
  );
}

async function verifyRejectRouteForcesResearchReplan(): Promise<void> {
  const { runtimeDataRoot, workspaceRoot, workspacePaths, run } =
    await bootstrapExecutionApprovalRun("reject-route");
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    executionApprovalMode: "human"
  });
  await waitForPendingApproval(orchestrator, workspacePaths, run.id);

  const app = await buildServer({
    runtimeDataRoot,
    workspaceRoot,
    startOrchestrator: false
  });
  try {
    const rejectResponse = await app.inject({
      method: "POST",
      url: `/runs/${run.id}/policy/reject`,
      payload: {
        actor: "policy-verifier",
        note: "Need more evidence before execution."
      }
    });
    assert.equal(rejectResponse.statusCode, 200);
    const rejectPayload = rejectResponse.json() as {
      current: {
        run_status: string;
        waiting_for_human: boolean;
        recommended_attempt_type: string | null;
      };
      policy_runtime: {
        approval_status: string;
      };
    };
    assert.equal(rejectPayload.current.run_status, "waiting_steer");
    assert.equal(rejectPayload.current.waiting_for_human, true);
    assert.equal(rejectPayload.current.recommended_attempt_type, "research");
    assert.equal(rejectPayload.policy_runtime.approval_status, "rejected");

    const launchResponse = await app.inject({
      method: "POST",
      url: `/runs/${run.id}/launch`
    });
    assert.equal(launchResponse.statusCode, 200);
    const launchPayload = launchResponse.json() as {
      current: {
        run_status: string;
        recommended_attempt_type: string | null;
      };
    };
    assert.equal(launchPayload.current.run_status, "running");
    assert.equal(launchPayload.current.recommended_attempt_type, "research");
  } finally {
    await app.close();
  }
}

async function verifyApproveAndRejectRequirePendingApproval(): Promise<void> {
  const { runtimeDataRoot, workspaceRoot, workspacePaths, run } =
    await bootstrapExecutionApprovalRun("pending-only-routes");
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    executionApprovalMode: "human"
  });
  await waitForPendingApproval(orchestrator, workspacePaths, run.id);

  const app = await buildServer({
    runtimeDataRoot,
    workspaceRoot,
    startOrchestrator: false
  });
  try {
    const rejectResponse = await app.inject({
      method: "POST",
      url: `/runs/${run.id}/policy/reject`,
      payload: {
        actor: "policy-verifier",
        note: "Need more evidence before execution."
      }
    });
    assert.equal(rejectResponse.statusCode, 200);

    const approveAfterReject = await app.inject({
      method: "POST",
      url: `/runs/${run.id}/policy/approve`,
      payload: {
        actor: "policy-verifier",
        note: "This should stay blocked."
      }
    });
    assert.equal(approveAfterReject.statusCode, 409);
    assert.match(approveAfterReject.body, /pending/i);
  } finally {
    await app.close();
  }

  const secondScenario = await bootstrapExecutionApprovalRun("approved-cannot-reject");
  const secondOrchestrator = await createScenarioOrchestrator({
    runtimeDataRoot: secondScenario.runtimeDataRoot,
    workspaceRoot: secondScenario.workspaceRoot,
    workspacePaths: secondScenario.workspacePaths,
    executionApprovalMode: "human"
  });
  await waitForPendingApproval(
    secondOrchestrator,
    secondScenario.workspacePaths,
    secondScenario.run.id
  );

  const secondApp = await buildServer({
    runtimeDataRoot: secondScenario.runtimeDataRoot,
    workspaceRoot: secondScenario.workspaceRoot,
    startOrchestrator: false
  });
  try {
    const approveResponse = await secondApp.inject({
      method: "POST",
      url: `/runs/${secondScenario.run.id}/policy/approve`,
      payload: {
        actor: "policy-verifier",
        note: "Execution plan is approved."
      }
    });
    assert.equal(approveResponse.statusCode, 200);

    const rejectAfterApprove = await secondApp.inject({
      method: "POST",
      url: `/runs/${secondScenario.run.id}/policy/reject`,
      payload: {
        actor: "policy-verifier",
        note: "This should not revert the approved plan."
      }
    });
    assert.equal(rejectAfterApprove.statusCode, 409);
    assert.match(rejectAfterApprove.body, /pending/i);
  } finally {
    await secondApp.close();
  }
}

async function verifyDangerousVerificationCommandsCheckpointThenAdvance(): Promise<void> {
  const {
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    run
  } = await bootstrapExecutionApprovalRun("dangerous-verification", {
    verificationPurpose: "dangerous replay should reset only to a safety checkpoint",
    verificationCommand: "git reset --hard HEAD && test -f approved-execution.txt"
  });
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths
  });
  await driveOrchestratorUntil({
    orchestrator,
    predicate: async () => {
      const [attempts, current] = await Promise.all([
        listAttempts(workspacePaths, run.id),
        getCurrentDecision(workspacePaths, run.id)
      ]);
      return attempts.some(
        (attempt) => attempt.attempt_type === "execution" && attempt.status === "completed"
      ) && current?.waiting_for_human === false;
    }
  });

  const [attempts, current, policy, journal] = await Promise.all([
    listAttempts(workspacePaths, run.id),
    getCurrentDecision(workspacePaths, run.id),
    readRunPolicyRuntimeStrict(workspacePaths, run.id),
    listRunJournal(workspacePaths, run.id)
  ]);
  const executionAttempt = attempts.find((attempt) => attempt.attempt_type === "execution");
  assert.ok(executionAttempt, "dangerous replay should still dispatch execution");
  const headSubject = await runCommand(executionAttempt.workspace_root, [
    "git",
    "-C",
    executionAttempt.workspace_root,
    "log",
    "-1",
    "--format=%s"
  ]);
  assert.equal(executionAttempt.status, "completed");
  assert.equal(current?.waiting_for_human, false);
  assert.notEqual(current?.recommended_next_action, "wait_for_human");
  assert.equal(policy.approval_status, "not_required");
  assert.notEqual(policy.danger_mode, "manual_only");
  assert.match(headSubject, /^AISA safety checkpoint:/);
  const runtimeVerification = await getAttemptRuntimeVerification(
    workspacePaths,
    run.id,
    executionAttempt.id
  );
  assert.equal(runtimeVerification?.status, "passed");
  assert.ok(
    runtimeVerification?.changed_files.includes("approved-execution.txt"),
    "safety checkpoint should preserve the execution artifact through destructive replay"
  );
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.policy.hook_evaluated" &&
        entry.payload.hook_status === "passed" &&
        entry.payload.dangerous_command ===
          "git reset --hard HEAD && test -f approved-execution.txt"
    ),
    "dangerous replay guard should record checkpoint-before-advance handling"
  );
}

async function verifyReplaySafeTmpCleanupCanEnterApproval(): Promise<void> {
  const { runtimeDataRoot, workspaceRoot, workspacePaths, run } =
    await bootstrapExecutionApprovalRun("tmp-cleanup-approval", {
      verificationPurpose: "clean deterministic replay temp dirs before checking output",
      verificationCommand:
        "rm -rf /tmp/aisa-policy-runtime-replay-a /tmp/aisa-policy-runtime-replay-b && test -f approved-execution.txt"
    });
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    executionApprovalMode: "human"
  });
  await waitForPendingApproval(orchestrator, workspacePaths, run.id);

  const [attempts, current, policy, journal] = await Promise.all([
    listAttempts(workspacePaths, run.id),
    getCurrentDecision(workspacePaths, run.id),
    readRunPolicyRuntimeStrict(workspacePaths, run.id),
    listRunJournal(workspacePaths, run.id)
  ]);
  assert.equal(attempts.length, 1, "safe temp cleanup should still stop before approval");
  assert.equal(current?.waiting_for_human, true);
  assert.equal(policy.stage, "approval");
  assert.equal(policy.approval_status, "pending");
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.policy.hook_evaluated" &&
        entry.payload.hook_status === "passed" &&
        entry.payload.hook_key === "dangerous_verification_commands"
    ),
    "safe temp cleanup should leave a passed dangerous-command hook"
  );
}

async function verifyUnsafeRmCleanupStillFailsClosed(): Promise<void> {
  const unsafeCommands = [
    "rm -rf /tmp && test -f approved-execution.txt",
    "rm -rf /tmp/aisa-policy-runtime-replay-* && test -f approved-execution.txt",
    "rm -rf /tmp/aisa-policy-runtime-replay-a /Users/atou/not-owned-by-run && test -f approved-execution.txt",
    "rm -rf /tmp/../Users/atou/not-owned-by-run && test -f approved-execution.txt",
    "rm -rf /tmp/aisa-policy-runtime-replay\\-a && test -f approved-execution.txt"
  ];

  for (const [index, verificationCommand] of unsafeCommands.entries()) {
    const {
      runtimeDataRoot,
      workspaceRoot,
      workspacePaths,
      run
    } = await bootstrapExecutionApprovalRun(`unsafe-rm-${index}`, {
      verificationPurpose: "unsafe cleanup must be blocked",
      verificationCommand
    });
    const orchestrator = await createScenarioOrchestrator({
      runtimeDataRoot,
      workspaceRoot,
      workspacePaths
    });
    await driveOrchestratorUntil({
      orchestrator,
      predicate: async () => {
        const policy = await getRunPolicyRuntime(workspacePaths, run.id);
        return policy?.last_decision === "dangerous_rule_blocked";
      }
    });

    const [attempts, current, policy] = await Promise.all([
      listAttempts(workspacePaths, run.id),
      getCurrentDecision(workspacePaths, run.id),
      readRunPolicyRuntimeStrict(workspacePaths, run.id)
    ]);
    assert.equal(attempts.length, 1, "unsafe rm cleanup should stop before execution attempt");
    assert.equal(current?.waiting_for_human, true);
    assert.equal(policy.approval_status, "rejected");
    assert.equal(policy.last_decision, "dangerous_rule_blocked");
    assert.match(policy.blocking_reason ?? "", /destructive command/i);
  }
}

async function verifyUncheckpointableGitResetStillFailsClosed(): Promise<void> {
  const {
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    run
  } = await bootstrapExecutionApprovalRun("uncheckpointable-git-reset", {
    verificationPurpose: "unsafe git reset target must still be blocked",
    verificationCommand: "git reset --hard HEAD~1 && test -f approved-execution.txt"
  });
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths
  });
  await driveOrchestratorUntil({
    orchestrator,
    predicate: async () => {
      const policy = await getRunPolicyRuntime(workspacePaths, run.id);
      return policy?.last_decision === "dangerous_rule_blocked";
    }
  });

  const [attempts, current, policy] = await Promise.all([
    listAttempts(workspacePaths, run.id),
    getCurrentDecision(workspacePaths, run.id),
    readRunPolicyRuntimeStrict(workspacePaths, run.id)
  ]);
  assert.equal(
    attempts.length,
    1,
    "uncheckpointable git reset should stop before execution attempt"
  );
  assert.equal(current?.waiting_for_human, true);
  assert.equal(policy.approval_status, "rejected");
  assert.equal(policy.last_decision, "dangerous_rule_blocked");
  assert.match(policy.blocking_reason ?? "", /git reset --hard HEAD~1/i);
}

async function verifyKillswitchRoutesGateLaunch(): Promise<void> {
  const { runtimeDataRoot, workspaceRoot, workspacePaths, run } =
    await bootstrapExecutionApprovalRun("killswitch-routes");
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    executionApprovalMode: "human"
  });
  await waitForPendingApproval(orchestrator, workspacePaths, run.id);

  const app = await buildServer({
    runtimeDataRoot,
    workspaceRoot,
    startOrchestrator: false
  });
  try {
    const approveResponse = await app.inject({
      method: "POST",
      url: `/runs/${run.id}/policy/approve`,
      payload: {
        actor: "policy-verifier",
        note: "Execution plan is approved."
      }
    });
    assert.equal(approveResponse.statusCode, 200);

    const enableResponse = await app.inject({
      method: "POST",
      url: `/runs/${run.id}/policy/killswitch/enable`,
      payload: {
        actor: "policy-verifier",
        reason: "Manual stop for policy review."
      }
    });
    assert.equal(enableResponse.statusCode, 200);
    const enabledPayload = enableResponse.json() as {
      policy_runtime: {
        killswitch_active: boolean;
        killswitch_reason: string | null;
      };
    };
    assert.equal(enabledPayload.policy_runtime.killswitch_active, true);
    assert.equal(
      enabledPayload.policy_runtime.killswitch_reason,
      "Manual stop for policy review."
    );

    const blockedLaunch = await app.inject({
      method: "POST",
      url: `/runs/${run.id}/launch`
    });
    assert.equal(blockedLaunch.statusCode, 409);
    assert.match(blockedLaunch.body, /Manual stop for policy review/i);

    const clearResponse = await app.inject({
      method: "POST",
      url: `/runs/${run.id}/policy/killswitch/clear`,
      payload: {
        actor: "policy-verifier",
        note: "Resume normal policy dispatch."
      }
    });
    assert.equal(clearResponse.statusCode, 200);
    const clearedPayload = clearResponse.json() as {
      current: {
        summary: string;
        recommended_attempt_type: string | null;
      };
      policy_runtime: {
        killswitch_active: boolean;
      };
      recovery: {
        path: string;
        handoff_bundle_ref: string | null;
      };
    };
    assert.equal(clearedPayload.policy_runtime.killswitch_active, false);
    assert.equal(clearedPayload.current.recommended_attempt_type, "execution");
    assert.equal(clearedPayload.recovery.path, "approved_execution_plan");
    assert.match(clearedPayload.current.summary, /approved execution plan/i);

    const launchResponse = await app.inject({
      method: "POST",
      url: `/runs/${run.id}/launch`
    });
    assert.equal(launchResponse.statusCode, 200);
    const launchPayload = launchResponse.json() as {
      current: {
        summary: string;
        recommended_attempt_type: string | null;
      };
      recovery: {
        path: string;
        handoff_bundle_ref: string | null;
      };
    };
    assert.equal(launchPayload.current.recommended_attempt_type, "execution");
    assert.equal(launchPayload.recovery.path, "approved_execution_plan");
    assert.match(launchPayload.current.summary, /approved execution plan/i);
  } finally {
    await app.close();
  }
}

async function verifyLaunchWithoutHandoffUsesDegradedRecovery(): Promise<void> {
  const runtimeDataRoot = await createTrackedVerifyTempDir(
    "aisa-policy-runtime-degraded-launch-"
  );
  const workspaceRoot = await createTrackedVerifyTempDir(
    "aisa-policy-workspace-degraded-launch-"
  );
  const workspacePaths = resolveWorkspacePaths(runtimeDataRoot);
  await ensureWorkspace(workspacePaths);
  await initializeGitRepo(workspaceRoot);

  const run = createRun({
    title: "Launch degrades without handoff",
    description:
      "Ensure manual relaunch enters an explicit degraded rebuild path when the latest settled attempt has no handoff bundle.",
    success_criteria: ["Relaunch should prefer degraded research recovery over silent execution fallback."],
    constraints: [],
    owner_id: "policy-verify",
    workspace_root: workspaceRoot
  });
  const failedExecution = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "fake-codex",
      objective: "Leave a settled attempt without a handoff bundle.",
      success_criteria: run.success_criteria,
      workspace_root: workspaceRoot
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );
  const degradedMessage =
    "Execution failed before writing a settled handoff bundle, so relaunch must rebuild from degraded evidence.";

  await saveRun(workspacePaths, run);
  await saveAttempt(workspacePaths, failedExecution);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "waiting_steer",
      latest_attempt_id: failedExecution.id,
      recommended_next_action: "wait_for_human",
      recommended_attempt_type: "execution",
      summary: degradedMessage,
      blocking_reason: degradedMessage,
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
        message: degradedMessage
      }
    })
  );

  const app = await buildServer({
    runtimeDataRoot,
    workspaceRoot,
    startOrchestrator: false
  });
  try {
    const launchResponse = await app.inject({
      method: "POST",
      url: `/runs/${run.id}/launch`
    });
    assert.equal(launchResponse.statusCode, 200);
    const launchPayload = launchResponse.json() as {
      current: {
        run_status: string;
        recommended_next_action: string | null;
        recommended_attempt_type: string | null;
        summary: string;
        blocking_reason: string | null;
      };
      recovery: {
        path: string;
        handoff_bundle_ref: string | null;
      };
    };
    assert.equal(launchPayload.current.run_status, "running");
    assert.equal(launchPayload.current.recommended_attempt_type, "research");
    assert.equal(launchPayload.current.recommended_next_action, "continue_research");
    assert.equal(launchPayload.recovery.path, "degraded_rebuild");
    assert.equal(launchPayload.recovery.handoff_bundle_ref, null);
    assert.match(launchPayload.current.summary, /degraded evidence/i);
    assert.match(launchPayload.current.blocking_reason ?? "", /handoff bundle/i);

    const journal = await listRunJournal(workspacePaths, run.id);
    const launchedEntry = journal.find((entry) => entry.type === "run.launched");
    assert.ok(launchedEntry, "launch should record the explicit degraded recovery path");
    assert.equal(launchedEntry?.payload.recovery_path, "degraded_rebuild");
    assert.equal(launchedEntry?.payload.handoff_bundle_ref ?? null, null);
  } finally {
    await app.close();
  }
}

async function verifyCorruptPolicyFailsClosed(): Promise<void> {
  const { runtimeDataRoot, workspaceRoot, workspacePaths, run } =
    await bootstrapExecutionApprovalRun("corrupt-policy");
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    executionApprovalMode: "human"
  });
  await waitForPendingApproval(orchestrator, workspacePaths, run.id);

  const app = await buildServer({
    runtimeDataRoot,
    workspaceRoot,
    startOrchestrator: false
  });
  try {
    const approveResponse = await app.inject({
      method: "POST",
      url: `/runs/${run.id}/policy/approve`,
      payload: {
        actor: "policy-verifier",
        note: "Approve first, then break the file."
      }
    });
    assert.equal(approveResponse.statusCode, 200);
  } finally {
    await app.close();
  }

  await writeFile(resolveRunPaths(workspacePaths, run.id).policyFile, "{\n", "utf8");

  const resumedOrchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths
  });
  await driveOrchestratorUntil({
    orchestrator: resumedOrchestrator,
    predicate: async () => {
      const current = await getCurrentDecision(workspacePaths, run.id);
      return current?.waiting_for_human === true;
    }
  });

  const attempts = await listAttempts(workspacePaths, run.id);
  const current = await getCurrentDecision(workspacePaths, run.id);
  assert.equal(attempts.length, 1, "corrupt policy should block execution dispatch");
  assert.match(current?.blocking_reason ?? "", /policy/i);
}

async function verifyKillswitchFailsClosed(): Promise<void> {
  const { runtimeDataRoot, workspaceRoot, workspacePaths, run, latestAttempt } =
    await bootstrapExecutionApprovalRun("killswitch");
  await saveRunPolicyRuntime(
    workspacePaths,
    createRunPolicyRuntime({
      run_id: run.id,
      stage: "execution",
      approval_status: "approved",
      approval_required: true,
      proposed_signature: "approved-killswitch-proposal",
      proposed_attempt_type: "execution",
      proposed_objective: "Write the approved execution artifact.",
      proposed_success_criteria: ["Leave a verified execution artifact in the workspace."],
      permission_profile: "workspace_write",
      hook_policy: "enforce_runtime_contract",
      killswitch_active: true,
      killswitch_reason: "manual stop for dangerous execution",
      source_attempt_id: latestAttempt.id
    })
  );

  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths
  });
  await driveOrchestratorUntil({
    orchestrator,
    predicate: async () => {
      const current = await getCurrentDecision(workspacePaths, run.id);
      return current?.waiting_for_human === true;
    }
  });

  const attempts = await listAttempts(workspacePaths, run.id);
  const current = await getCurrentDecision(workspacePaths, run.id);
  assert.equal(attempts.length, 1, "killswitch should block execution dispatch");
  assert.match(current?.blocking_reason ?? "", /killswitch|manual stop/i);
}

async function runCase(id: string, fn: () => Promise<void>): Promise<CaseResult> {
  try {
    await fn();
    return {
      id,
      status: "pass"
    };
  } catch (error) {
    return {
      id,
      status: "fail",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function main(): Promise<void> {
  try {
    const cases: Array<[string, () => Promise<void>]> = [
      ["execution_auto_dispatches_by_default", verifyExecutionAutoDispatchesByDefault],
      [
        "leader_approval_dispatches_without_human_stop",
        verifyLeaderApprovalDispatchesWithoutHumanStop
      ],
      ["leader_rejection_auto_replans_research", verifyLeaderRejectionAutoReplansResearch],
      ["leader_review_failure_fails_closed", verifyLeaderReviewFailureFailsClosed],
      ["execution_requires_approval", verifyExecutionPlanRequiresApproval],
      [
        "pending_approval_blocks_launch_bypass",
        verifyLaunchBypassIsBlockedWhileApprovalPending
      ],
      ["approve_route_unlocks_execution", verifyApproveRouteUnlocksExecution],
      ["reject_route_forces_research_replan", verifyRejectRouteForcesResearchReplan],
      ["approve_and_reject_require_pending", verifyApproveAndRejectRequirePendingApproval],
      [
        "dangerous_verification_commands_checkpoint_then_advance",
        verifyDangerousVerificationCommandsCheckpointThenAdvance
      ],
      [
        "replay_safe_tmp_cleanup_can_enter_approval",
        verifyReplaySafeTmpCleanupCanEnterApproval
      ],
      [
        "unsafe_rm_cleanup_still_fails_closed",
        verifyUnsafeRmCleanupStillFailsClosed
      ],
      [
        "uncheckpointable_git_reset_still_fails_closed",
        verifyUncheckpointableGitResetStillFailsClosed
      ],
      ["killswitch_routes_gate_launch", verifyKillswitchRoutesGateLaunch],
      [
        "launch_without_handoff_uses_degraded_recovery",
        verifyLaunchWithoutHandoffUsesDegradedRecovery
      ],
      ["corrupt_policy_fails_closed", verifyCorruptPolicyFailsClosed],
      ["killswitch_fails_closed", verifyKillswitchFailsClosed]
    ];
    const results: CaseResult[] = [];

    for (const [id, fn] of cases) {
      results.push(await runCase(id, fn));
    }

    const passed = results.filter((result) => result.status === "pass").length;
    const failed = results.length - passed;

    if (failed > 0) {
      throw new Error(
        results
          .filter((result) => result.status === "fail")
          .map((result) => `${result.id}: ${result.error}`)
          .join("\n")
      );
    }

    console.log(
      JSON.stringify(
        {
          suite: "policy-runtime",
          passed,
          failed,
          results
        },
        null,
        2
      )
    );
  } finally {
    await cleanupTrackedVerifyTempDirs();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
