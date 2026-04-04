import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
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
import {
  appendRunJournal,
  ensureWorkspace,
  getCurrentDecision,
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
      waitingHumanAutoResumeMs: 60_000,
      attemptHeartbeatIntervalMs: 20,
      attemptHeartbeatStaleMs: 200
    }
  );
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

async function verifyExecutionPlanRequiresApproval(): Promise<void> {
  const { runtimeDataRoot, workspaceRoot, workspacePaths, run } =
    await bootstrapExecutionApprovalRun("pending-approval");
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths
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
    workspacePaths
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
    workspacePaths
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
    workspacePaths
  });
  await driveOrchestratorUntil({
    orchestrator: resumedOrchestrator,
    predicate: async () => (await listAttempts(workspacePaths, run.id)).length >= 2
  });

  const attempts = await listAttempts(workspacePaths, run.id);
  const latestAttempt = attempts.at(-1) ?? null;
  assert.equal(latestAttempt?.attempt_type, "execution");
}

async function verifyRejectRouteForcesResearchReplan(): Promise<void> {
  const { runtimeDataRoot, workspaceRoot, workspacePaths, run } =
    await bootstrapExecutionApprovalRun("reject-route");
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths
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
    workspacePaths
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
    workspacePaths: secondScenario.workspacePaths
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

async function verifyDangerousVerificationCommandsFailClosed(): Promise<void> {
  const {
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    run
  } = await bootstrapExecutionApprovalRun("dangerous-verification", {
    verificationPurpose: "dangerous replay that should be blocked",
    verificationCommand: "git reset --hard HEAD"
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

  const [attempts, current, policy, journal] = await Promise.all([
    listAttempts(workspacePaths, run.id),
    getCurrentDecision(workspacePaths, run.id),
    readRunPolicyRuntimeStrict(workspacePaths, run.id),
    listRunJournal(workspacePaths, run.id)
  ]);
  assert.equal(attempts.length, 1, "dangerous replay commands should stop before a new execution attempt is created");
  assert.equal(current?.waiting_for_human, true);
  assert.equal(current?.recommended_attempt_type, "research");
  assert.equal(policy.stage, "approval");
  assert.equal(policy.approval_status, "rejected");
  assert.equal(policy.danger_mode, "manual_only");
  assert.match(policy.blocking_reason ?? "", /destructive command/i);
  assert.ok(
    journal.some(
      (entry) =>
        entry.type === "run.policy.hook_evaluated" &&
        entry.payload.hook_status === "failed" &&
        entry.payload.dangerous_command === "git reset --hard HEAD"
    ),
    "dangerous replay guard should leave a structured hook event"
  );
}

async function verifyKillswitchRoutesGateLaunch(): Promise<void> {
  const { runtimeDataRoot, workspaceRoot, workspacePaths, run } =
    await bootstrapExecutionApprovalRun("killswitch-routes");
  const orchestrator = await createScenarioOrchestrator({
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths
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
    workspacePaths
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
      ["execution_requires_approval", verifyExecutionPlanRequiresApproval],
      [
        "pending_approval_blocks_launch_bypass",
        verifyLaunchBypassIsBlockedWhileApprovalPending
      ],
      ["approve_route_unlocks_execution", verifyApproveRouteUnlocksExecution],
      ["reject_route_forces_research_replan", verifyRejectRouteForcesResearchReplan],
      ["approve_and_reject_require_pending", verifyApproveAndRejectRequirePendingApproval],
      [
        "dangerous_verification_commands_fail_closed",
        verifyDangerousVerificationCommandsFailClosed
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
