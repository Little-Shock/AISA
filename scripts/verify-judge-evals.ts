import assert from "node:assert/strict";
import { join } from "node:path";
import {
  AttemptReviewInputPacketSchema,
  AttemptReviewPacketSchema,
  AttemptRuntimeVerificationSchema,
  EvalSpecSchema,
  WorkerWritebackSchema,
  createAttempt,
  createAttemptAdversarialVerification,
  createAttemptContract,
  createBranch,
  createCurrentDecision,
  createGoal,
  createRun,
  updateAttempt,
  type Attempt,
  type AttemptAdversarialVerification,
  type AttemptContract,
  type AttemptReviewInputPacket,
  type AttemptReviewPacket,
  type AttemptRuntimeVerification,
  type CurrentDecision,
  type Run
} from "../packages/domain/src/index.ts";
import {
  createCliAttemptEvaluationSynthesizer,
  createCliAttemptReviewer,
  createDeterministicAttemptEvaluationSynthesizer,
  evaluateAttempt,
  evaluateBranch,
  runAttemptReviewerPipeline,
  synthesizeAttemptEvaluation
} from "../packages/judge/src/index.ts";

type CaseResult = {
  id: string;
  status: "pass" | "fail";
  error?: string;
};

const fixtureReviewerPath = join(process.cwd(), "scripts", "fixture-reviewer-cli.mjs");
const fixtureSynthesizerPath = join(process.cwd(), "scripts", "fixture-synthesizer-cli.mjs");
const reviewerTimeoutMs = 2_000;
const synthesizerTimeoutMs = 2_000;

function createCompletedAttempt(input: {
  run: Run;
  attemptType: "research" | "execution";
  objective: string;
  successCriteria: string[];
}): Attempt {
  return updateAttempt(
    createAttempt({
      run_id: input.run.id,
      attempt_type: input.attemptType,
      worker: "verify-judge-evals",
      objective: input.objective,
      success_criteria: input.successCriteria,
      workspace_root: input.run.workspace_root
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );
}

function createExecutionRuntimeVerification(input: {
  run: Run;
  attempt: Attempt;
  status: "passed" | "failed";
  failureCode?: AttemptRuntimeVerification["failure_code"];
  failureReason?: string | null;
  changedFiles?: string[];
  commandExitCode?: number;
}): AttemptRuntimeVerification {
  const changedFiles = input.changedFiles ?? ["packages/judge/src/index.ts"];
  const passed = input.status === "passed";

  return AttemptRuntimeVerificationSchema.parse({
    attempt_id: input.attempt.id,
    run_id: input.run.id,
    attempt_type: input.attempt.attempt_type,
    status: input.status,
    verifier_kit: "repo",
    failure_class: passed ? null : "runtime_verification_failed",
    failure_policy_mode: passed ? null : "fail_closed",
    repo_root: input.run.workspace_root,
    git_head: "deadbeef",
    git_status: changedFiles.map((file) => ` M ${file}`),
    preexisting_git_status: [],
    new_git_status: changedFiles.map((file) => ` M ${file}`),
    changed_files: changedFiles,
    failure_code: passed ? null : (input.failureCode ?? "verification_command_failed"),
    failure_reason:
      passed ? null : (input.failureReason ?? "Verification command failed for typecheck."),
    checks: [],
    command_results: [
      {
        purpose: "typecheck",
        command: "pnpm typecheck",
        cwd: input.run.workspace_root,
        expected_exit_code: 0,
        exit_code:
          input.commandExitCode ?? (passed ? 0 : 1),
        passed,
        stdout_file: "/tmp/verify-judge-evals.stdout",
        stderr_file: "/tmp/verify-judge-evals.stderr"
      }
    ],
    synced_self_bootstrap_artifacts: null,
    created_at: new Date().toISOString()
  });
}

function createReviewInputPacket(input: {
  run: Run;
  attempt: Attempt;
  attemptContract: AttemptContract;
  current: CurrentDecision;
  result: AttemptReviewPacket["result"];
  runtimeVerification: AttemptRuntimeVerification | null;
  adversarialVerification?: AttemptAdversarialVerification | null;
  failureMessage?: string;
}): AttemptReviewInputPacket {
  return AttemptReviewInputPacketSchema.parse({
    run_id: input.run.id,
    attempt_id: input.attempt.id,
    attempt: input.attempt,
    attempt_contract: input.attemptContract,
    current_decision_snapshot: input.current,
    context: null,
    journal: [],
    failure_context: input.failureMessage
      ? {
          message: input.failureMessage,
          journal_event_id: null,
          journal_event_ts: null
        }
      : null,
    result: input.result,
    runtime_verification: input.runtimeVerification,
    adversarial_verification: input.adversarialVerification ?? null,
    artifact_manifest: [],
    generated_at: new Date().toISOString()
  });
}

function createReviewPacket(input: {
  reviewInputPacket: AttemptReviewInputPacket;
}): AttemptReviewPacket {
  return AttemptReviewPacketSchema.parse({
    ...input.reviewInputPacket,
    evaluation: null,
    review_input_packet_ref: null,
    review_opinion_refs: [],
    synthesized_evaluation_ref: null,
    evaluation_synthesis_ref: null
  });
}

function createResearchReviewInputPacket(): AttemptReviewInputPacket {
  const run = createRun({
    title: "judge research readiness",
    description: "verify research evaluation paths",
    success_criteria: ["research attempts should gate execution handoff"],
    constraints: [],
    owner_id: "verify-judge-evals",
    workspace_root: process.cwd()
  });
  const attempt = createCompletedAttempt({
    run,
    attemptType: "research",
    objective: "Map the change surface before implementation.",
    successCriteria: ["Produce a replayable execution contract."]
  });
  const attemptContract = createAttemptContract({
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: "research",
    objective: attempt.objective,
    success_criteria: attempt.success_criteria,
    required_evidence: ["reasoned findings", "next execution plan"]
  });
  const current = createCurrentDecision({
    run_id: run.id,
    run_status: "running",
    latest_attempt_id: attempt.id,
    best_attempt_id: attempt.id,
    recommended_next_action: "wait_for_human",
    recommended_attempt_type: "research",
    summary: "Research findings landed.",
    waiting_for_human: true
  });

  return createReviewInputPacket({
    run,
    attempt,
    attemptContract,
    current,
    result: WorkerWritebackSchema.parse({
      summary: "Mapped the failure and sketched the next execution attempt.",
      findings: [
        {
          type: "fact",
          content: "The runtime gate is failing on a stale shell assumption.",
          evidence: ["scripts/verify-worker-adapter.ts"]
        },
        {
          type: "risk",
          content: "The execution handoff is incomplete without a replayable verifier command.",
          evidence: ["attempt_contract.verification_plan missing"]
        }
      ],
      questions: [],
      recommended_next_steps: ["Start an execution attempt once the replay plan is complete."],
      confidence: 0.73,
      next_attempt_contract: {
        attempt_type: "execution",
        objective: "Patch the shell portability gate.",
        success_criteria: ["Replayable verifier commands should pass."],
        required_evidence: ["typecheck output"],
        done_rubric: [
          {
            code: "runtime_replay_passed",
            description: "Replayable verifier commands pass in the workspace."
          }
        ],
        failure_modes: [
          {
            code: "verification_command_failed",
            description: "The replay command still fails."
          }
        ],
        verification_plan: {
          commands: [
            {
              purpose: "typecheck",
              command: "pnpm typecheck"
            }
          ]
        }
      },
      artifacts: [{ type: "report", path: "artifacts/research-summary.md" }]
    }),
    runtimeVerification: AttemptRuntimeVerificationSchema.parse({
      attempt_id: attempt.id,
      run_id: run.id,
      attempt_type: attempt.attempt_type,
      status: "not_applicable",
      verifier_kit: null,
      failure_class: null,
      failure_policy_mode: null,
      repo_root: null,
      git_head: null,
      git_status: [],
      preexisting_git_status: [],
      new_git_status: [],
      changed_files: [],
      failure_code: null,
      failure_reason: null,
      checks: [],
      command_results: [],
      synced_self_bootstrap_artifacts: null,
      created_at: new Date().toISOString()
    })
  });
}

function createExecutionReviewPacket(input: {
  runtimeStatus: "passed" | "failed";
  adversarialStatus?: "passed" | "failed" | "missing";
  failureCode?: AttemptRuntimeVerification["failure_code"];
}): AttemptReviewPacket {
  const run = createRun({
    title: "judge execution gate",
    description: "verify execution evaluation hard gates",
    success_criteria: ["judge keeps failed gates closed"],
    constraints: [],
    owner_id: "verify-judge-evals",
    workspace_root: process.cwd()
  });
  const attempt = createCompletedAttempt({
    run,
    attemptType: "execution",
    objective: "Ship the guarded patch.",
    successCriteria: ["Runtime replay and adversarial verification should pass."]
  });
  const attemptContract = createAttemptContract({
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: "execution",
    objective: attempt.objective,
    success_criteria: attempt.success_criteria,
    required_evidence: ["runtime replay output", "adversarial verification artifact"],
    adversarial_verification_required: true,
    verification_plan: {
      commands: [
        {
          purpose: "typecheck",
          command: "pnpm typecheck"
        }
      ]
    }
  });
  const current = createCurrentDecision({
    run_id: run.id,
    run_status: "running",
    latest_attempt_id: attempt.id,
    best_attempt_id: attempt.id,
    recommended_next_action: "attempt_running",
    recommended_attempt_type: "execution",
    summary: "Execution under review."
  });
  const runtimeVerification = createExecutionRuntimeVerification({
    run,
    attempt,
    status: input.runtimeStatus,
    failureCode: input.failureCode
  });
  const adversarialVerification =
    input.runtimeStatus !== "passed" || input.adversarialStatus === "missing"
      ? null
      : createAttemptAdversarialVerification({
          run_id: run.id,
          attempt_id: attempt.id,
          attempt_type: attempt.attempt_type,
          status: input.adversarialStatus ?? "passed",
          verifier_kit: "repo",
          verdict: input.adversarialStatus === "failed" ? "fail" : "pass",
          summary:
            input.adversarialStatus === "failed"
              ? "Adversarial replay found a regression."
              : "Adversarial replay stayed clean.",
          failure_code:
            input.adversarialStatus === "failed" ? "verdict_fail" : null,
          failure_reason:
            input.adversarialStatus === "failed"
              ? "Repeated execution corrupted the output."
              : null,
          checks: [
            {
              code: "repeat_probe",
              status: input.adversarialStatus === "failed" ? "failed" : "passed",
              message:
                input.adversarialStatus === "failed"
                  ? "Repeated execution corrupted the output."
                  : "Repeated execution preserved the output."
            }
          ],
          commands: [
            {
              purpose: "repeat the command",
              command: "pnpm typecheck",
              cwd: run.workspace_root,
              exit_code: input.adversarialStatus === "failed" ? 1 : 0,
              status: input.adversarialStatus === "failed" ? "failed" : "passed",
              output_ref: "/tmp/verify-judge-evals.adversarial.stdout"
            }
          ],
          output_refs: ["/tmp/verify-judge-evals.adversarial.stdout"],
          source_artifact_path: "/tmp/adversarial-verification.json"
        });

  const result = WorkerWritebackSchema.parse({
    summary:
      input.runtimeStatus === "failed"
        ? "Applied the patch, but runtime replay still fails."
        : input.adversarialStatus === "failed"
          ? "Runtime replay passed, but the adversarial probe broke the output."
          : "Runtime replay and adversarial verification both passed.",
    findings: [
      {
        type: "fact",
        content:
          input.runtimeStatus === "failed"
            ? "Typecheck is still failing."
            : "The guarded path is implemented.",
        evidence:
          input.runtimeStatus === "failed"
            ? ["pnpm typecheck => exit 1"]
            : ["packages/judge/src/index.ts"]
      }
    ],
    questions: [],
    recommended_next_steps:
      input.runtimeStatus === "failed" || input.adversarialStatus === "failed"
        ? ["Repair the failing path before declaring the attempt complete."]
        : [],
    confidence: input.runtimeStatus === "failed" ? 0.68 : 0.84,
    artifacts:
      input.runtimeStatus === "passed" && input.adversarialStatus !== "missing"
        ? [{ type: "test_result", path: "artifacts/adversarial-verification.json" }]
        : []
  });

  return createReviewPacket({
    reviewInputPacket: createReviewInputPacket({
      run,
      attempt,
      attemptContract,
      current,
      result,
      runtimeVerification,
      adversarialVerification,
      failureMessage:
        input.runtimeStatus === "failed"
          ? "Runtime verification failed."
          : input.adversarialStatus === "failed"
            ? "Adversarial verification failed."
            : undefined
    })
  });
}

async function verifyBranchThresholds(): Promise<void> {
  const goal = createGoal({
    title: "judge branch score",
    description: "verify branch threshold handling",
    success_criteria: ["keep/rerun boundaries stay stable"],
    constraints: [],
    owner_id: "verify-judge-evals",
    workspace_root: process.cwd()
  });
  const branch = createBranch(
    goal.id,
    {
      id: "branch-judge-thresholds",
      hypothesis: "More grounded findings should keep the branch.",
      objective: "Score branch output.",
      success_criteria: ["score should stay above the keep threshold"],
      assigned_worker: "verify-judge-evals"
    },
    "context-judge-thresholds"
  );
  const evalSpec = EvalSpecSchema.parse({
    dimensions: ["relevance", "evidence_quality", "actionability", "cost_efficiency"],
    keep_threshold: 0.7,
    rerun_threshold: 0.3
  });

  const keepResult = evaluateBranch({
    goal,
    branch,
    evalSpec,
    writeback: WorkerWritebackSchema.parse({
      summary: "Strong, grounded findings with clear next steps.",
      findings: [
        { type: "fact", content: "A", evidence: ["a.ts"] },
        { type: "fact", content: "B", evidence: ["b.ts"] },
        { type: "risk", content: "C", evidence: ["c.ts"] },
        { type: "hypothesis", content: "D", evidence: ["d.ts"] }
      ],
      questions: [],
      recommended_next_steps: ["Ship the patch."],
      confidence: 0.9,
      artifacts: []
    })
  });
  const rerunResult = evaluateBranch({
    goal,
    branch,
    evalSpec,
    writeback: WorkerWritebackSchema.parse({
      summary: "Thin output without grounded evidence.",
      findings: [],
      questions: ["q1", "q2", "q3", "q4"],
      recommended_next_steps: [],
      confidence: 0.1,
      artifacts: []
    })
  });

  assert.equal(keepResult.recommendation, "keep");
  assert.ok(keepResult.score >= evalSpec.keep_threshold);
  assert.equal(rerunResult.recommendation, "rerun");
  assert.ok(rerunResult.score <= evalSpec.rerun_threshold);
}

async function verifyResearchEvaluationRequiresReplayableContract(): Promise<void> {
  const reviewPacket = createReviewPacket({
    reviewInputPacket: createResearchReviewInputPacket()
  });
  const evaluation = evaluateAttempt({ reviewPacket });

  assert.equal(evaluation.verification_status, "not_applicable");
  assert.equal(evaluation.adversarial_verification_status, "not_applicable");
  assert.equal(evaluation.recommendation, "continue");
  assert.equal(evaluation.suggested_attempt_type, "execution");
  assert.ok(
    !evaluation.missing_evidence.some((entry) =>
      entry.includes("Need a replayable execution contract")
    )
  );
}

async function verifyRuntimeFailureStaysHardGated(): Promise<void> {
  const reviewPacket = createExecutionReviewPacket({
    runtimeStatus: "failed",
    failureCode: "verification_command_failed"
  });
  const evaluation = evaluateAttempt({ reviewPacket });

  assert.equal(evaluation.verification_status, "failed");
  assert.equal(evaluation.adversarial_verification_status, "not_applicable");
  assert.equal(evaluation.recommendation, "continue");
  assert.equal(evaluation.suggested_attempt_type, "research");
  assert.ok(evaluation.goal_progress <= 0.34);
  assert.ok(
    evaluation.missing_evidence.some((entry) =>
      entry.includes("Verification command failed")
    )
  );
}

async function verifyMissingAdversarialArtifactStaysHardGated(): Promise<void> {
  const reviewPacket = createExecutionReviewPacket({
    runtimeStatus: "passed",
    adversarialStatus: "missing"
  });
  const evaluation = evaluateAttempt({ reviewPacket });

  assert.equal(evaluation.verification_status, "passed");
  assert.equal(evaluation.adversarial_verification_status, "failed");
  assert.equal(evaluation.recommendation, "wait_human");
  assert.equal(evaluation.suggested_attempt_type, "execution");
  assert.ok(evaluation.goal_progress <= 0.74);
  assert.ok(
    evaluation.missing_evidence.some((entry) =>
      entry.includes("Need a machine-readable adversarial verification artifact")
    )
  );
}

async function verifyCliReviewerPipeline(): Promise<void> {
  const reviewInputPacket = createResearchReviewInputPacket();
  const reviewer = createCliAttemptReviewer({
    kind: "cli",
    reviewer_id: "fixture-reviewer",
    role: "risk_reviewer",
    adapter: "fixture-cli-reviewer",
    provider: "codex",
    model: "gpt-5.4",
    command: process.execPath,
    args: [fixtureReviewerPath],
    cwd: process.cwd(),
    timeout_ms: reviewerTimeoutMs
  });
  const opinions = await runAttemptReviewerPipeline({
    reviewInputPacket,
    reviewers: [reviewer],
    reviewInputPacketRef: `runs/${reviewInputPacket.run_id}/attempts/${reviewInputPacket.attempt_id}/review_input_packet.json`,
    inputRefs: [
      {
        kind: "review_input_packet",
        path: `runs/${reviewInputPacket.run_id}/attempts/${reviewInputPacket.attempt_id}/review_input_packet.json`
      }
    ]
  });

  assert.equal(opinions.length, 1);
  assert.equal(opinions[0]?.reviewer.reviewer_id, "fixture-reviewer");
  assert.equal(
    opinions[0]?.structured_judgment.rationale,
    `cli reviewer checked ${reviewInputPacket.attempt_id}`
  );
  assert.equal(
    opinions[0]?.proposed_next_contract?.attempt_type,
    "execution"
  );
}

async function verifyCliReviewerInvalidJsonFailsClosed(): Promise<void> {
  const reviewer = createCliAttemptReviewer({
    kind: "cli",
    reviewer_id: "fixture-reviewer-invalid-json",
    role: "risk_reviewer",
    adapter: "fixture-cli-reviewer",
    command: process.execPath,
    args: [fixtureReviewerPath, "invalid_json"],
    cwd: process.cwd(),
    timeout_ms: reviewerTimeoutMs
  });

  await assert.rejects(
    () =>
      reviewer.reviewAttempt({
        reviewInputPacket: createResearchReviewInputPacket()
      }),
    /invalid JSON/i
  );
}

async function verifyCliSynthesizerPersistsExplicitSynthesis(): Promise<void> {
  const reviewInputPacket = createResearchReviewInputPacket();
  const reviewerOpinions = await runAttemptReviewerPipeline({
    reviewInputPacket,
    reviewers: [
      createCliAttemptReviewer({
        kind: "cli",
        reviewer_id: "fixture-reviewer",
        role: "risk_reviewer",
        adapter: "fixture-cli-reviewer",
        command: process.execPath,
        args: [fixtureReviewerPath],
        cwd: process.cwd(),
        timeout_ms: reviewerTimeoutMs
      })
    ],
    reviewInputPacketRef: `runs/${reviewInputPacket.run_id}/attempts/${reviewInputPacket.attempt_id}/review_input_packet.json`,
    inputRefs: []
  });
  const synthesizer = createCliAttemptEvaluationSynthesizer({
    kind: "cli",
    synthesizer_id: "fixture-synthesizer",
    role: "final_synthesizer",
    adapter: "fixture-cli-synthesizer",
    provider: "codex",
    model: "gpt-5.4",
    command: process.execPath,
    args: [fixtureSynthesizerPath],
    cwd: process.cwd(),
    timeout_ms: synthesizerTimeoutMs
  });
  const outcome = await synthesizeAttemptEvaluation({
    reviewInputPacket,
    opinions: reviewerOpinions,
    reviewInputPacketRef: `runs/${reviewInputPacket.run_id}/attempts/${reviewInputPacket.attempt_id}/review_input_packet.json`,
    opinionRefs: reviewerOpinions.map((opinion) => `opinions/${opinion.opinion_id}.json`),
    synthesizer
  });

  assert.equal(outcome.evaluation.reviewer_count, 1);
  assert.equal(outcome.evaluation.synthesis_strategy, "cli_synthesizer_v1");
  assert.equal(outcome.evaluation.synthesizer?.synthesizer_id, "fixture-synthesizer");
  assert.equal(outcome.synthesisRecord?.synthesizer.synthesizer_id, "fixture-synthesizer");
  assert.equal(outcome.evaluation.recommendation, "continue");
}

async function verifyCliSynthesizerInvalidJsonFailsClosed(): Promise<void> {
  await assert.rejects(
    () =>
      createCliAttemptEvaluationSynthesizer({
        kind: "cli",
        synthesizer_id: "fixture-synthesizer-invalid-json",
        role: "final_synthesizer",
        adapter: "fixture-cli-synthesizer",
        command: process.execPath,
        args: [fixtureSynthesizerPath, "invalid_json"],
        cwd: process.cwd(),
        timeout_ms: synthesizerTimeoutMs
      }).synthesizeEvaluation({
        reviewInputPacket: createResearchReviewInputPacket(),
        reviewInputPacketRef: "runs/test/review_input_packet.json",
        opinions: [],
        opinionRefs: [],
        deterministicBaseEvaluation: evaluateAttempt({
          reviewPacket: createReviewPacket({
            reviewInputPacket: createResearchReviewInputPacket()
          })
        })
      }),
    /invalid JSON/i
  );
}

async function verifyCliSynthesizerCannotOverrideFailedAdversarialVerification(): Promise<void> {
  const reviewPacket = createExecutionReviewPacket({
    runtimeStatus: "passed",
    adversarialStatus: "failed"
  });
  const deterministicBaseEvaluation = evaluateAttempt({ reviewPacket });
  const outcome = await createDeterministicAttemptEvaluationSynthesizer().synthesizeEvaluation({
    reviewInputPacket: reviewPacket,
    reviewInputPacketRef: `runs/${reviewPacket.run_id}/attempts/${reviewPacket.attempt_id}/review_input_packet.json`,
    opinions: [],
    opinionRefs: [],
    deterministicBaseEvaluation
  });
  assert.equal(outcome.structured_judgment.adversarial_verification_status, "failed");

  const synthesis = await synthesizeAttemptEvaluation({
    reviewInputPacket: reviewPacket,
    opinions: [],
    reviewInputPacketRef: `runs/${reviewPacket.run_id}/attempts/${reviewPacket.attempt_id}/review_input_packet.json`,
    opinionRefs: [],
    synthesizerConfig: {
      kind: "cli",
      synthesizer_id: "fixture-adversarial-hard-gate",
      role: "final_synthesizer",
      adapter: "fixture-cli-synthesizer",
      command: process.execPath,
      args: [fixtureSynthesizerPath],
      cwd: process.cwd(),
      timeout_ms: synthesizerTimeoutMs
    }
  });

  assert.equal(synthesis.evaluation.verification_status, "passed");
  assert.equal(synthesis.evaluation.adversarial_verification_status, "failed");
  assert.equal(synthesis.evaluation.recommendation, "wait_human");
  assert.equal(synthesis.evaluation.suggested_attempt_type, "execution");
  assert.ok(synthesis.evaluation.goal_progress <= 0.74);
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
  const results: CaseResult[] = [];
  results.push(await runCase("branch_thresholds", verifyBranchThresholds));
  results.push(
    await runCase(
      "research_evaluation_requires_replayable_contract",
      verifyResearchEvaluationRequiresReplayableContract
    )
  );
  results.push(
    await runCase("execution_runtime_failure_hard_gate", verifyRuntimeFailureStaysHardGated)
  );
  results.push(
    await runCase(
      "execution_missing_adversarial_artifact_hard_gate",
      verifyMissingAdversarialArtifactStaysHardGated
    )
  );
  results.push(await runCase("cli_reviewer_pipeline", verifyCliReviewerPipeline));
  results.push(
    await runCase("cli_reviewer_invalid_json_fail_closed", verifyCliReviewerInvalidJsonFailsClosed)
  );
  results.push(
    await runCase(
      "cli_synthesizer_persists_explicit_synthesis",
      verifyCliSynthesizerPersistsExplicitSynthesis
    )
  );
  results.push(
    await runCase(
      "cli_synthesizer_invalid_json_fail_closed",
      verifyCliSynthesizerInvalidJsonFailsClosed
    )
  );
  results.push(
    await runCase(
      "cli_synthesizer_preserves_failed_adversarial_verification",
      verifyCliSynthesizerCannotOverrideFailedAdversarialVerification
    )
  );

  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.length - passed;

  console.log(
    JSON.stringify(
      {
        suite: "judge_evals",
        passed,
        failed,
        results
      },
      null,
      2
    )
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
