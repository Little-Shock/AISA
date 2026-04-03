import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AttemptReviewPacketSchema,
  AttemptRuntimeVerificationSchema,
  EvaluatorCalibrationCaseSchema,
  EvaluatorCalibrationManifestSchema,
  createAttempt,
  createAttemptAdversarialVerification,
  createAttemptContract,
  createAttemptHandoffBundle,
  createAttemptPreflightEvaluation,
  createCurrentDecision,
  createRun,
  updateAttempt,
  type Attempt,
  type AttemptContract,
  type AttemptReviewPacket,
  type AttemptRuntimeVerification,
  type CurrentDecision,
  type Run
} from "../packages/domain/src/index.ts";
import {
  createDeterministicAttemptEvaluationSynthesizer,
  createHeuristicAttemptReviewer
} from "../packages/judge/src/index.ts";
import { Orchestrator, refreshRunMaintenancePlane } from "../packages/orchestrator/src/index.ts";
import {
  RUNTIME_RUN_LOOP_CALIBRATION_BUNDLE_REF,
  RUNTIME_RUN_LOOP_DATASET_VERSION,
  RUNTIME_RUN_LOOP_REVIEWER_PROMPT_VERSION,
  RUNTIME_RUN_LOOP_VERIFIER_PROMPT_VERSION,
  buildAttemptEvaluatorCalibrationSample
} from "../packages/orchestrator/src/evaluator-calibration.ts";
import {
  ensureWorkspace,
  getAttemptEvaluatorCalibrationSample,
  readJsonFile,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptContract,
  saveAttemptHandoffBundle,
  saveAttemptReviewPacket,
  saveAttemptRuntimeVerification,
  saveCurrentDecision,
  saveRun,
  type WorkspacePaths
} from "../packages/state-store/src/index.ts";
import { type WorkerAdapter } from "../packages/worker-adapters/src/index.ts";
import {
  cleanupTrackedVerifyTempDirs,
  createTrackedVerifyTempDir
} from "./verify-temp.ts";

type CaseResult = {
  id: string;
  status: "pass" | "fail";
  error?: string;
};

type ScriptResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type ExportSummary = {
  status: "ok";
  exported_case_ids: string[];
  manifest_entries: number;
  manifest_path: string;
};

type NoGitChangesFixture = {
  runtimeDataRoot: string;
  workspaceRoot: string;
  workspacePaths: WorkspacePaths;
  run: Run;
  attempt: Attempt;
  contract: AttemptContract;
  current: CurrentDecision;
  runtimeVerification: AttemptRuntimeVerification;
};

type OrchestratorPrivateApi = {
  saveSettledAttemptState(input: {
    runId: string;
    attempt: Attempt;
    currentSnapshot: CurrentDecision | null;
    governanceSnapshot?: null;
  }): Promise<void>;
  ensureSettledAttemptReviewPackets(
    runId: string,
    current: CurrentDecision | null,
    attempts: Attempt[]
  ): Promise<void>;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function createNoopWorkerAdapter(): WorkerAdapter {
  return {
    type: "verify-noop",
    async runAttemptTask() {
      throw new Error("verify-evaluator-calibration should not dispatch worker tasks");
    }
  };
}

function createTestOrchestrator(workspacePaths: WorkspacePaths): Orchestrator {
  return new Orchestrator(workspacePaths, createNoopWorkerAdapter(), undefined, 1_500, {
    reviewers: [
      createHeuristicAttemptReviewer({
        reviewer_id: "verify-reviewer",
        role: "runtime_reviewer"
      })
    ],
    synthesizer: createDeterministicAttemptEvaluationSynthesizer()
  });
}

function getPrivateApi(orchestrator: Orchestrator): OrchestratorPrivateApi {
  return orchestrator as unknown as OrchestratorPrivateApi;
}

function buildNoGitChangesRuntimeVerification(input: {
  run: Run;
  attempt: Attempt;
  workspaceRoot: string;
}): AttemptRuntimeVerification {
  return AttemptRuntimeVerificationSchema.parse({
    attempt_id: input.attempt.id,
    run_id: input.run.id,
    attempt_type: input.attempt.attempt_type,
    status: "failed",
    verifier_kit: "repo",
    failure_class: "runtime_verification_failed",
    failure_policy_mode: "fail_closed",
    repo_root: input.workspaceRoot,
    git_head: null,
    git_status: [],
    preexisting_git_status: [],
    new_git_status: [],
    changed_files: [],
    failure_code: "no_git_changes",
    failure_reason: "Runtime verification saw no repo changes.",
    checks: [],
    command_results: [],
    synced_self_bootstrap_artifacts: null,
    created_at: new Date().toISOString()
  });
}

function buildReviewPacket(input: {
  run: Run;
  attempt: Attempt;
  contract: AttemptContract;
  current: CurrentDecision;
  runtimeVerification: AttemptRuntimeVerification | null;
  failureMessage: string;
}): AttemptReviewPacket {
  return AttemptReviewPacketSchema.parse({
    run_id: input.run.id,
    attempt_id: input.attempt.id,
    attempt: input.attempt,
    attempt_contract: input.contract,
    current_decision_snapshot: input.current,
    context: null,
    journal: [],
    failure_context: {
      message: input.failureMessage,
      journal_event_id: null,
      journal_event_ts: null
    },
    result: null,
    evaluation: null,
    runtime_verification: input.runtimeVerification,
    adversarial_verification: null,
    artifact_manifest: [],
    review_input_packet_ref: null,
    review_opinion_refs: [],
    synthesized_evaluation_ref: null,
    evaluation_synthesis_ref: null,
    generated_at: new Date().toISOString()
  });
}

async function createNoGitChangesFixture(label: string): Promise<NoGitChangesFixture> {
  const runtimeDataRoot = await createTrackedVerifyTempDir(`aisa-evaluator-calibration-${label}-`);
  const workspaceRoot = await createTrackedVerifyTempDir(`aisa-evaluator-workspace-${label}-`);
  const workspacePaths = resolveWorkspacePaths(runtimeDataRoot);
  await ensureWorkspace(workspacePaths);

  const run = createRun({
    title: `Evaluator calibration ${label}`,
    description: "Verify evaluator calibration artifacts for settled attempts.",
    success_criteria: ["Settled attempts should surface calibration samples."],
    constraints: [],
    owner_id: "verify-evaluator-calibration",
    workspace_root: workspaceRoot
  });
  const attempt = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "verify-worker",
      objective: "Leave a verified repository change.",
      success_criteria: ["Runtime verification should find a real repo change."],
      workspace_root: workspaceRoot
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );
  const contract = createAttemptContract({
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: "execution",
    objective: attempt.objective,
    success_criteria: attempt.success_criteria,
    required_evidence: ["Leave a verified repository change."],
    verifier_kit: "repo"
  });
  const current = createCurrentDecision({
    run_id: run.id,
    run_status: "waiting_steer",
    latest_attempt_id: attempt.id,
    best_attempt_id: attempt.id,
    recommended_next_action: "wait_for_human",
    recommended_attempt_type: "execution",
    summary: "Runtime verification blocked the execution after replay.",
    blocking_reason: "Runtime verification blocked the execution after replay.",
    waiting_for_human: true
  });
  const runtimeVerification = buildNoGitChangesRuntimeVerification({
    run,
    attempt,
    workspaceRoot
  });

  await saveRun(workspacePaths, run);
  await saveAttempt(workspacePaths, attempt);
  await saveAttemptContract(workspacePaths, contract);
  await saveCurrentDecision(workspacePaths, current);
  await saveAttemptRuntimeVerification(workspacePaths, runtimeVerification);

  return {
    runtimeDataRoot,
    workspaceRoot,
    workspacePaths,
    run,
    attempt,
    contract,
    current,
    runtimeVerification
  };
}

async function runTsxScript(scriptPath: string, args: string[]): Promise<ScriptResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--loader",
        "./scripts/ts-runtime-loader.mjs",
        scriptPath,
        ...args
      ],
      {
        cwd: repoRoot,
        env: process.env
      }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolvePromise({
        exitCode,
        stdout,
        stderr
      });
    });
  });
}

function parseScriptJson<T>(stdout: string): T {
  return JSON.parse(stdout.trim()) as T;
}

async function verifyFreshSettledSampleSaved(): Promise<void> {
  const fixture = await createNoGitChangesFixture("fresh-settled");
  const orchestrator = createTestOrchestrator(fixture.workspacePaths);

  await getPrivateApi(orchestrator).saveSettledAttemptState({
    runId: fixture.run.id,
    attempt: fixture.attempt,
    currentSnapshot: fixture.current
  });

  const sample = await getAttemptEvaluatorCalibrationSample(
    fixture.workspacePaths,
    fixture.run.id,
    fixture.attempt.id
  );

  assert.ok(sample, "fresh settled attempt should persist a calibration sample");
  assert.equal(sample.failure_code, "no_git_changes");
  assert.deepEqual(
    sample.derived_failure_modes.map((mode) => mode.id),
    ["runtime.no_git_changes", "handoff.no_git_changes"]
  );
  assert.equal(
    sample.source_refs.runtime_verification,
    `runs/${fixture.run.id}/attempts/${fixture.attempt.id}/artifacts/runtime-verification.json`
  );
  assert.equal(
    sample.source_refs.handoff_bundle,
    `runs/${fixture.run.id}/attempts/${fixture.attempt.id}/artifacts/handoff_bundle.json`
  );
}

async function verifySettledBackfillRepairsMissingSample(): Promise<void> {
  const fixture = await createNoGitChangesFixture("backfill");
  const reviewPacket = buildReviewPacket({
    run: fixture.run,
    attempt: fixture.attempt,
    contract: fixture.contract,
    current: fixture.current,
    runtimeVerification: fixture.runtimeVerification,
    failureMessage: "Runtime verification stopped the settled execution."
  });
  const handoffBundle = createAttemptHandoffBundle({
    attempt: fixture.attempt,
    approved_attempt_contract: fixture.contract,
    current_decision_snapshot: fixture.current,
    failure_context: reviewPacket.failure_context,
    runtime_verification: fixture.runtimeVerification,
    source_refs: {
      run_contract: `runs/${fixture.run.id}/contract.json`,
      attempt_meta: `runs/${fixture.run.id}/attempts/${fixture.attempt.id}/meta.json`,
      attempt_contract: `runs/${fixture.run.id}/attempts/${fixture.attempt.id}/attempt_contract.json`,
      preflight_evaluation: null,
      current_decision: `runs/${fixture.run.id}/current.json`,
      review_packet: `runs/${fixture.run.id}/attempts/${fixture.attempt.id}/review_packet.json`,
      runtime_verification: `runs/${fixture.run.id}/attempts/${fixture.attempt.id}/artifacts/runtime-verification.json`,
      adversarial_verification: null
    }
  });
  await saveAttemptReviewPacket(fixture.workspacePaths, reviewPacket);
  await saveAttemptHandoffBundle(fixture.workspacePaths, handoffBundle);

  const orchestrator = createTestOrchestrator(fixture.workspacePaths);
  await getPrivateApi(orchestrator).ensureSettledAttemptReviewPackets(
    fixture.run.id,
    fixture.current,
    [fixture.attempt]
  );

  const sample = await getAttemptEvaluatorCalibrationSample(
    fixture.workspacePaths,
    fixture.run.id,
    fixture.attempt.id
  );

  assert.ok(sample, "backfill should repair missing calibration samples");
  assert.deepEqual(
    sample.derived_failure_modes.map((mode) => mode.id),
    ["runtime.no_git_changes", "handoff.no_git_changes"]
  );
}

async function verifyPreflightFailureModeDerived(): Promise<void> {
  const run = createRun({
    title: "Preflight calibration case",
    description: "Preflight failures should survive calibration derivation.",
    success_criteria: ["Surface preflight failure modes."],
    constraints: [],
    owner_id: "verify-evaluator-calibration",
    workspace_root: "/tmp/preflight-calibration"
  });
  const attempt = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "verify-worker",
      objective: "Replay the verification plan.",
      success_criteria: ["Replay the verification plan."],
      workspace_root: "/tmp/preflight-calibration"
    }),
    {
      status: "failed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );
  const preflight = createAttemptPreflightEvaluation({
    run_id: run.id,
    attempt_id: attempt.id,
    attempt_type: "execution",
    status: "failed",
    failure_code: "blocked_pnpm_verification_plan",
    failure_reason: "Preflight blocked an explicit pnpm replay plan with no local node_modules."
  });

  const sample = buildAttemptEvaluatorCalibrationSample({
    attempt,
    preflightEvaluation: preflight,
    preflightEvaluationRef: `runs/${run.id}/attempts/${attempt.id}/artifacts/preflight-evaluation.json`
  });

  assert.equal(sample.failure_code, "blocked_pnpm_verification_plan");
  assert.deepEqual(
    sample.derived_failure_modes.map((mode) => mode.id),
    ["preflight.blocked_pnpm_verification_plan"]
  );
}

async function verifyAdversarialFailureModeDerived(): Promise<void> {
  const run = createRun({
    title: "Adversarial calibration case",
    description: "Adversarial failures should survive calibration derivation.",
    success_criteria: ["Surface adversarial failure modes."],
    constraints: [],
    owner_id: "verify-evaluator-calibration",
    workspace_root: "/tmp/adversarial-calibration"
  });
  const attempt = updateAttempt(
    createAttempt({
      run_id: run.id,
      attempt_type: "execution",
      worker: "verify-worker",
      objective: "Leave a verified artifact.",
      success_criteria: ["Leave a verified artifact."],
      workspace_root: "/tmp/adversarial-calibration"
    }),
    {
      status: "completed",
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString()
    }
  );
  const contract = createAttemptContract({
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: "execution",
    objective: attempt.objective,
    success_criteria: attempt.success_criteria,
    required_evidence: ["Leave a verified artifact."],
    verifier_kit: "repo"
  });
  const current = createCurrentDecision({
    run_id: run.id,
    run_status: "waiting_steer",
    latest_attempt_id: attempt.id,
    best_attempt_id: attempt.id,
    recommended_next_action: "wait_for_human",
    recommended_attempt_type: "execution",
    summary: "Adversarial verification blocked the execution.",
    blocking_reason: "Adversarial verification blocked the execution.",
    waiting_for_human: true
  });
  const adversarial = createAttemptAdversarialVerification({
    run_id: run.id,
    attempt_id: attempt.id,
    attempt_type: "execution",
    status: "failed",
    verifier_kit: "repo",
    verdict: "fail",
    failure_code: "verdict_fail",
    failure_reason: "Adversarial verification returned a failing verdict."
  });
  const handoffBundle = createAttemptHandoffBundle({
    attempt,
    approved_attempt_contract: contract,
    current_decision_snapshot: current,
    failure_context: {
      message: "Adversarial verification returned a failing verdict.",
      journal_event_id: null,
      journal_event_ts: null
    },
    adversarial_verification: adversarial,
    source_refs: {
      run_contract: `runs/${run.id}/contract.json`,
      attempt_meta: `runs/${run.id}/attempts/${attempt.id}/meta.json`,
      attempt_contract: `runs/${run.id}/attempts/${attempt.id}/attempt_contract.json`,
      preflight_evaluation: null,
      current_decision: `runs/${run.id}/current.json`,
      review_packet: `runs/${run.id}/attempts/${attempt.id}/review_packet.json`,
      runtime_verification: null,
      adversarial_verification: `runs/${run.id}/attempts/${attempt.id}/artifacts/adversarial-verification.json`
    }
  });

  const sample = buildAttemptEvaluatorCalibrationSample({
    attempt,
    adversarialVerification: adversarial,
    adversarialVerificationRef: `runs/${run.id}/attempts/${attempt.id}/artifacts/adversarial-verification.json`,
    handoffBundle,
    handoffBundleRef: `runs/${run.id}/attempts/${attempt.id}/artifacts/handoff_bundle.json`
  });

  assert.equal(sample.failure_code, "verdict_fail");
  assert.deepEqual(
    sample.derived_failure_modes.map((mode) => mode.id),
    ["adversarial.verdict_fail", "handoff.verdict_fail"]
  );
}

async function verifyMaintenancePlaneReadsCalibrationSample(): Promise<void> {
  const fixture = await createNoGitChangesFixture("maintenance-plane");
  const orchestrator = createTestOrchestrator(fixture.workspacePaths);

  await getPrivateApi(orchestrator).saveSettledAttemptState({
    runId: fixture.run.id,
    attempt: fixture.attempt,
    currentSnapshot: fixture.current
  });

  const maintenancePlane = await refreshRunMaintenancePlane(
    fixture.workspacePaths,
    fixture.run.id,
    {
      staleAfterMs: 60_000
    }
  );

  const output =
    maintenancePlane.outputs.find((item) => item.key === "evaluator_calibration") ?? null;
  const source =
    maintenancePlane.signal_sources.find((item) => item.key === "evaluator_calibration") ??
    null;

  assert.ok(output, "maintenance plane should expose evaluator calibration output");
  assert.equal(output.status, "attention");
  assert.ok(
    output.ref?.endsWith("artifacts/evaluator-calibration-sample.json"),
    "maintenance plane should point at the persisted sample"
  );
  assert.ok(source, "maintenance plane should expose evaluator calibration as a signal source");
}

async function verifyExportManifestAndFixedRegressions(): Promise<void> {
  const fixture = await createNoGitChangesFixture("export");
  const orchestrator = createTestOrchestrator(fixture.workspacePaths);

  await getPrivateApi(orchestrator).saveSettledAttemptState({
    runId: fixture.run.id,
    attempt: fixture.attempt,
    currentSnapshot: fixture.current
  });

  const outputRoot = await createTrackedVerifyTempDir("aisa-evaluator-export-output-");
  const exportArgs = [
    "--workspace-root",
    fixture.runtimeDataRoot,
    "--output-root",
    outputRoot,
    "--run-id",
    fixture.run.id,
    "--attempt-id",
    fixture.attempt.id
  ];

  const firstExport = await runTsxScript("scripts/export-evaluator-calibration.ts", exportArgs);
  assert.equal(
    firstExport.exitCode,
    0,
    `export script failed\nstdout:\n${firstExport.stdout}\nstderr:\n${firstExport.stderr}`
  );

  const secondExport = await runTsxScript("scripts/export-evaluator-calibration.ts", exportArgs);
  assert.equal(
    secondExport.exitCode,
    0,
    `export script should stay idempotent on a repeated run\nstdout:\n${secondExport.stdout}\nstderr:\n${secondExport.stderr}`
  );

  const missingExport = await runTsxScript("scripts/export-evaluator-calibration.ts", [
    "--workspace-root",
    fixture.runtimeDataRoot,
    "--output-root",
    outputRoot,
    "--run-id",
    fixture.run.id,
    "--attempt-id",
    "att_missing"
  ]);
  assert.notEqual(
    missingExport.exitCode,
    0,
    "export script should fail closed when the sample target does not exist"
  );

  const exportSummary = parseScriptJson<ExportSummary>(firstExport.stdout);
  assert.equal(exportSummary.status, "ok");
  assert.deepEqual(exportSummary.exported_case_ids, [`online-cal_${fixture.attempt.id}`]);
  assert.equal(exportSummary.manifest_entries, 1);

  const manifestPath = join(
    outputRoot,
    "evals",
    "runtime-run-loop",
    "datasets",
    "calibration",
    "online-samples",
    "manifest.json"
  );
  const manifest = EvaluatorCalibrationManifestSchema.parse(
    await readJsonFile(manifestPath)
  );
  assert.equal(manifest.bundle_ref, RUNTIME_RUN_LOOP_CALIBRATION_BUNDLE_REF);
  assert.equal(manifest.entries.length, 1);

  const casePath = join(outputRoot, manifest.entries[0]!.path);
  const onlineCase = EvaluatorCalibrationCaseSchema.parse(await readJsonFile(casePath));
  assert.equal(onlineCase.label, "online_failure");
  assert.deepEqual(onlineCase.expected_failure_mode_ids, [
    "runtime.no_git_changes",
    "handoff.no_git_changes"
  ]);
  assert.equal(
    onlineCase.sample.calibration_bundle.reviewer_prompt_version,
    RUNTIME_RUN_LOOP_REVIEWER_PROMPT_VERSION
  );
  assert.equal(
    onlineCase.sample.calibration_bundle.verifier_prompt_version,
    RUNTIME_RUN_LOOP_VERIFIER_PROMPT_VERSION
  );
  assert.equal(
    onlineCase.sample.calibration_bundle.dataset_version,
    RUNTIME_RUN_LOOP_DATASET_VERSION
  );

  const bundle = (await readJsonFile(join(repoRoot, RUNTIME_RUN_LOOP_CALIBRATION_BUNDLE_REF))) as {
    bundle_ref: string;
    reviewer_prompt: { version: string; path: string };
    verifier_prompt: { version: string; path: string };
    dataset: { version: string; online_manifest_path: string; fixed_regression_paths: string[] };
  };
  assert.equal(bundle.bundle_ref, RUNTIME_RUN_LOOP_CALIBRATION_BUNDLE_REF);
  assert.equal(bundle.reviewer_prompt.version, RUNTIME_RUN_LOOP_REVIEWER_PROMPT_VERSION);
  assert.equal(bundle.verifier_prompt.version, RUNTIME_RUN_LOOP_VERIFIER_PROMPT_VERSION);
  assert.equal(bundle.dataset.version, RUNTIME_RUN_LOOP_DATASET_VERSION);
  assert.equal(
    bundle.dataset.online_manifest_path,
    "evals/runtime-run-loop/datasets/calibration/online-samples/manifest.json"
  );
  assert.equal(bundle.dataset.fixed_regression_paths.length, 2);

  const reviewerPrompt = await readFile(join(repoRoot, bundle.reviewer_prompt.path), "utf8");
  const verifierPrompt = await readFile(join(repoRoot, bundle.verifier_prompt.path), "utf8");
  assert.ok(reviewerPrompt.trim().length > 0, "reviewer prompt should not be empty");
  assert.ok(verifierPrompt.trim().length > 0, "verifier prompt should not be empty");

  const fixedCases = await Promise.all(
    bundle.dataset.fixed_regression_paths.map(async (caseRelativePath) =>
      EvaluatorCalibrationCaseSchema.parse(
        await readJsonFile(join(repoRoot, caseRelativePath))
      )
    )
  );
  const falsePositiveCase = fixedCases.find((item) => item.label === "false_positive") ?? null;
  const falseNegativeCase = fixedCases.find((item) => item.label === "false_negative") ?? null;

  assert.ok(falsePositiveCase, "bundle should include a fixed false positive regression case");
  assert.ok(falseNegativeCase, "bundle should include a fixed false negative regression case");
  assert.deepEqual(falsePositiveCase?.expected_failure_mode_ids ?? [], []);
  assert.deepEqual(falseNegativeCase?.expected_failure_mode_ids ?? [], [
    "adversarial.verdict_fail",
    "handoff.verdict_fail"
  ]);
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
    const results: CaseResult[] = [];
    results.push(await runCase("fresh_settled_sample_saved", verifyFreshSettledSampleSaved));
    results.push(
      await runCase(
        "settled_backfill_repairs_missing_sample",
        verifySettledBackfillRepairsMissingSample
      )
    );
    results.push(
      await runCase("preflight_failure_mode_derived", verifyPreflightFailureModeDerived)
    );
    results.push(
      await runCase("adversarial_failure_mode_derived", verifyAdversarialFailureModeDerived)
    );
    results.push(
      await runCase(
        "maintenance_plane_reads_calibration_sample",
        verifyMaintenancePlaneReadsCalibrationSample
      )
    );
    results.push(
      await runCase("export_manifest_and_fixed_regressions", verifyExportManifestAndFixedRegressions)
    );
    const passed = results.filter((result) => result.status === "pass").length;
    const failed = results.length - passed;

    if (failed > 0) {
      console.log(
        JSON.stringify(
          {
            suite: "evaluator_calibration",
            passed,
            failed,
            results
          },
          null,
          2
        )
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      JSON.stringify(
        {
          suite: "evaluator_calibration",
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
