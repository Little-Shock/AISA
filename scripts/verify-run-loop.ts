import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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
  updateRun,
  updateAttempt,
  WorkerWritebackSchema,
  type Attempt,
  type Run,
  type WorkerWriteback
} from "../packages/domain/src/index.js";
import {
  assessExecutionVerificationToolchain,
  Orchestrator
} from "../packages/orchestrator/src/index.js";
import {
  appendRunJournal,
  ensureWorkspace,
  getAttemptContext,
  getAttemptEvaluation,
  getAttemptReviewInputPacket,
  getAttemptReviewPacket,
  getCurrentDecision,
  getRun,
  listAttempts,
  listAttemptReviewOpinions,
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
  saveRunRuntimeHealthSnapshot,
  saveRunSteer
} from "../packages/state-store/src/index.js";

const REVIEWER_CONFIG_ENV = "AISA_REVIEWERS_JSON";
const CLI_REVIEWER_TIMEOUT_CASE_MS = 150;
const CLI_REVIEWER_PROCESS_FAILURE_TIMEOUT_MS = 1_500;

type CliReviewerFailureMode = "invalid_json" | "nonzero_exit" | "timeout";

type ScenarioDriver =
  | "happy_path"
  | "running_attempt_owned_elsewhere"
  | "research_stall"
  | "research_command_failure"
  | "execution_verified_next_step_continues"
  | "execution_runtime_source_drift_requires_restart"
  | "execution_checkpoint_blocked_dirty_workspace"
  | "execution_dirty_workspace_without_new_changes_fails_verification"
  | "execution_missing_verification_plan"
  | "execution_missing_local_toolchain_blocks_dispatch"
  | "execution_parse_failure"
  | "orphaned_running_attempt"
  | "execution_retry_after_recovery_preserves_contract"
  | "attempt_workspace_escapes_run_scope";

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
  run_workspace_root: string;
  managed_workspace_root: string | null;
  source_workspace_git_status: string[];
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
    matches_schema: boolean;
    schema_error: string | null;
    matches_run_id: boolean;
    matches_attempt_id: boolean;
    contract_objective_matches_attempt: boolean;
    contract_success_criteria_match_attempt: boolean;
    has_generated_at: boolean;
    has_attempt_contract: boolean;
    has_current_decision_snapshot: boolean;
    snapshot_blocking_reason: string | null;
    journal_count: number;
    has_failure_context: boolean;
    failure_message: string | null;
    has_result: boolean;
    has_evaluation: boolean;
    has_runtime_verification: boolean;
    artifact_manifest_count: number;
    has_meta_artifact: boolean;
    meta_artifact_exists: boolean;
    has_contract_artifact: boolean;
    contract_artifact_exists: boolean;
    has_context_artifact: boolean;
    context_artifact_exists: boolean;
    has_result_artifact: boolean;
    result_artifact_exists: boolean;
    has_evaluation_artifact: boolean;
    evaluation_artifact_exists: boolean;
    has_runtime_verification_artifact: boolean;
    runtime_verification_artifact_exists: boolean;
    expected_input_context_ref: string;
    meta_input_context_ref: string | null;
    review_packet_attempt_input_context_ref: string | null;
    input_context_ref_matches_expected: boolean;
    runtime_verification_status: string | null;
    runtime_verification_failure_code: string | null;
    runtime_verification_preexisting_git_status: string[];
    runtime_verification_new_git_status: string[];
    runtime_verification_changed_files: string[];
    attempt_contract_has_verification_plan: boolean;
    attempt_contract_verification_commands: string[];
    restart_required_message: string | null;
    restart_required_affected_files: string[];
  }>;
};

type PersistedPromptChainEvidence = {
  id: string;
  path: string;
  check: "must_include" | "must_not_include";
  value: string;
};

type PersistedPromptChainReport = {
  report_version: number;
  run_id: string;
  attempt_id: string;
  legacy_execution_attempt_id: string;
  post_restart_execution_attempt_id: string;
  guard_strings: {
    findings_guard: string;
    artifacts_guard: string;
    artifact_example: string;
    plain_string_guard: string;
  };
  restart_transition: {
    manual_recovery_event_id: string;
    run_launch_event_id: string;
    new_attempt_started_at: string;
  };
  evidence_chain: PersistedPromptChainEvidence[];
  replay_commands: Array<{
    purpose: string;
    command: string;
  }>;
};

type JournalEntryLite = {
  id: string;
  attempt_id: string | null;
  ts: string;
  type: string;
};

type JsonSchemaLite = {
  $schema?: string;
  title?: string;
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchemaLite>;
  items?: JsonSchemaLite;
  enum?: Array<string | number | boolean | null>;
  additionalProperties?: boolean;
};

const REVIEW_PACKET_TOP_LEVEL_REQUIRED = [
  "run_id",
  "attempt_id",
  "attempt",
  "attempt_contract",
  "current_decision_snapshot",
  "context",
  "journal",
  "failure_context",
  "result",
  "evaluation",
  "runtime_verification",
  "artifact_manifest",
  "generated_at"
] as const;

let reviewPacketSchemaCache: JsonSchemaLite | null = null;

function describeJsonType(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value === "object" ? "object" : typeof value;
}

function formatSchemaValue(value: string | number | boolean | null): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

function matchesSchemaType(expectedType: string, value: unknown): boolean {
  if (expectedType === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }

  return describeJsonType(value) === expectedType;
}

async function loadReviewPacketSchema(): Promise<JsonSchemaLite> {
  if (reviewPacketSchemaCache) {
    return reviewPacketSchemaCache;
  }

  const filePath = join(
    process.cwd(),
    "evals",
    "runtime-run-loop",
    "review-packet-schema.json"
  );
  const schema = JSON.parse(await readFile(filePath, "utf8")) as JsonSchemaLite;
  const schemaTypes = Array.isArray(schema.type) ? schema.type : [schema.type].filter(Boolean);

  assert.ok(
    schemaTypes.includes("object"),
    "review-packet-schema.json should describe an object payload"
  );

  for (const requiredKey of REVIEW_PACKET_TOP_LEVEL_REQUIRED) {
    assert.ok(
      schema.required?.includes(requiredKey),
      `review-packet-schema.json should require ${requiredKey}`
    );
    assert.ok(
      schema.properties?.[requiredKey],
      `review-packet-schema.json should describe ${requiredKey}`
    );
  }

  reviewPacketSchemaCache = schema;
  return schema;
}

function validateJsonSchemaLite(
  schema: JsonSchemaLite,
  value: unknown,
  path = "$"
): string | null {
  if (schema.enum && !schema.enum.some((candidate) => candidate === value)) {
    return `${path} should be one of ${schema.enum.map(formatSchemaValue).join(", ")}`;
  }

  const allowedTypes = schema.type
    ? Array.isArray(schema.type)
      ? schema.type
      : [schema.type]
    : [];

  if (allowedTypes.length > 0 && !allowedTypes.some((allowedType) => matchesSchemaType(allowedType, value))) {
    return `${path} should be ${allowedTypes.join(" | ")} but got ${describeJsonType(value)}`;
  }

  if (value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    if (!schema.items) {
      return null;
    }

    for (let index = 0; index < value.length; index += 1) {
      const error = validateJsonSchemaLite(schema.items, value[index], `${path}[${index}]`);
      if (error) {
        return error;
      }
    }

    return null;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;

    for (const requiredKey of schema.required ?? []) {
      if (!(requiredKey in record)) {
        return `${path}.${requiredKey} is required`;
      }
    }

    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (!(key in record)) {
        continue;
      }

      const error = validateJsonSchemaLite(propertySchema, record[key], `${path}.${key}`);
      if (error) {
        return error;
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!schema.properties?.[key]) {
          return `${path}.${key} is not allowed`;
        }
      }
    }
  }

  return null;
}

async function validatePersistedReviewPacket(input: {
  reviewPacketFile: string;
}): Promise<{
  matchesSchema: boolean;
  schemaError: string | null;
}> {
  try {
    const [schema, rawReviewPacket] = await Promise.all([
      loadReviewPacketSchema(),
      readFile(input.reviewPacketFile, "utf8")
    ]);
    const parsed = JSON.parse(rawReviewPacket) as unknown;
    const schemaError = validateJsonSchemaLite(schema, parsed);

    return {
      matchesSchema: schemaError === null,
      schemaError
    };
  } catch (error) {
    return {
      matchesSchema: false,
      schemaError: error instanceof Error ? error.message : String(error)
    };
  }
}

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

    if (this.driver === "attempt_workspace_escapes_run_scope") {
      throw new Error("Workspace scope breach case must be blocked before worker dispatch.");
    }

    if (
      this.driver === "execution_missing_local_toolchain_blocks_dispatch" &&
      input.attempt.attempt_type === "execution"
    ) {
      throw new Error("Missing-toolchain case must be blocked before worker dispatch.");
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
      WorkerWritebackSchema.parse({
        summary: "坏 execution writeback 不该被吞掉。",
        findings: [
          {
            type: "fact",
            content: "留下了一个字符串 artifacts。",
            evidence: ["execution-change.md"]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.42,
        verification_plan: {
          commands: [
            {
              purpose: "confirm the malformed writeback case stays blocked",
              command: "test -n malformed-writeback"
            }
          ]
        },
        artifacts: ["artifacts/diff.patch"]
      });
    }

    if (this.driver === "research_command_failure" && input.attempt.attempt_type === "research") {
      throw new Error(
        "Research command failed under sandbox: listen EPERM while running tsx."
      );
    }

    if (
      [
        "happy_path",
        "execution_verified_next_step_continues",
        "execution_runtime_source_drift_requires_restart",
        "execution_checkpoint_blocked_dirty_workspace",
        "execution_missing_verification_plan",
        "execution_retry_after_recovery_preserves_contract"
      ].includes(this.driver) &&
      input.attempt.attempt_type === "execution"
    ) {
      if (this.driver === "execution_runtime_source_drift_requires_restart") {
        await writeFile(
          join(input.attempt.workspace_root, "packages", "orchestrator", "src", "index.ts"),
          `export const runtimeMarker = "${input.attempt.id}";\n`,
          "utf8"
        );
      } else {
        await writeFile(
          join(input.attempt.workspace_root, "execution-change.md"),
          `execution change from ${input.attempt.id}\n`,
          "utf8"
        );
      }
    }

    const writeback =
      this.driver === "happy_path" ||
      this.driver === "running_attempt_owned_elsewhere" ||
      this.driver === "execution_verified_next_step_continues" ||
      this.driver === "execution_runtime_source_drift_requires_restart" ||
      this.driver === "execution_parse_failure" ||
      this.driver === "execution_checkpoint_blocked_dirty_workspace" ||
      this.driver === "execution_dirty_workspace_without_new_changes_fails_verification" ||
      this.driver === "execution_missing_verification_plan" ||
      this.driver === "execution_missing_local_toolchain_blocks_dispatch" ||
      this.driver === "execution_retry_after_recovery_preserves_contract"
        ? this.buildHappyPathWriteback(input.attempt, nextCount)
        : this.buildStuckWriteback(nextCount);

    return {
      writeback,
      reportMarkdown: "# fake",
      exitCode: 0
    };
  }

  private buildHappyPathWriteback(attempt: Attempt, passNumber: number): WorkerWriteback {
    if (attempt.attempt_type === "research") {
      const expectedArtifact =
        this.driver === "execution_runtime_source_drift_requires_restart"
          ? "packages/orchestrator/src/index.ts"
          : "execution-change.md";
      const nextAttemptVerificationPlan =
        this.driver === "execution_missing_local_toolchain_blocks_dispatch"
          ? undefined
          : {
              commands: [
                {
                  purpose: "confirm the execution change was written",
                  command: this.buildExecutionVerificationCommand()
                }
              ]
            };
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
          expected_artifacts: [expectedArtifact],
          verification_plan: nextAttemptVerificationPlan
        },
        artifacts: []
      };
    }

    if (this.driver === "execution_runtime_source_drift_requires_restart") {
      return {
        summary: "Patched a live runtime source file and found the next execution move.",
        findings: [
          {
            type: "fact",
            content: "Updated the in-process runtime source",
            evidence: ["packages/orchestrator/src/index.ts"]
          }
        ],
        questions: [],
        recommended_next_steps: ["Resume the follow-up execution step after restart."],
        confidence: 0.86,
        artifacts: [{ type: "patch", path: "artifacts/diff.patch" }]
      };
    }

    if (this.driver === "execution_verified_next_step_continues" && passNumber === 2) {
      return {
        summary: "Executed the current step and surfaced the next concrete execution move.",
        findings: [
          {
            type: "fact",
            content: "Patched the target code path",
            evidence: ["src/app.ts", "npm test"]
          }
        ],
        questions: [],
        recommended_next_steps: ["Apply the next concrete execution step without reopening research."],
        confidence: 0.88,
        artifacts: [{ type: "patch", path: "artifacts/diff.patch" }]
      };
    }

    const verificationPlan =
      this.driver === "execution_missing_verification_plan"
        ? undefined
        : {
            commands: [
              {
                purpose: "confirm the execution change was written",
                command: this.buildExecutionVerificationCommand(attempt.id)
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

  private buildExecutionVerificationCommand(attemptId?: string): string {
    if (this.driver === "execution_dirty_workspace_without_new_changes_fails_verification") {
      return "test -f README.md && rg -n '^# temp runtime repo' README.md";
    }

    if (this.driver === "execution_runtime_source_drift_requires_restart") {
      const marker = attemptId ?? ".+";
      return `test -f packages/orchestrator/src/index.ts && rg -n '^export const runtimeMarker = "${marker}";$' packages/orchestrator/src/index.ts`;
    }

    if (!attemptId) {
      return 'test -f execution-change.md && rg -n "^execution change from" execution-change.md';
    }

    return `test -f execution-change.md && rg -n "^execution change from ${attemptId}$" execution-change.md`;
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

class ContextCaptureAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: {
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    return {
      writeback: {
        summary: `Captured context for ${input.attempt.id}.`,
        findings: [],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.4,
        artifacts: []
      },
      reportMarkdown: "# context capture",
      exitCode: 0
    };
  }
}

async function settle(input: {
  orchestrator: Orchestrator;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  runId: string;
  iterations: number;
}): Promise<void> {
  for (let index = 0; index < input.iterations; index += 1) {
    await input.orchestrator.tick();
    await sleep(50);
    await waitForRunningAttemptsToSettle(input.workspacePaths, input.runId);
    if (await isRunQuiescent(input.workspacePaths, input.runId)) {
      return;
    }
    await sleep(50);
  }
}

async function waitForRunningAttemptsToSettle(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string,
  timeoutMs = 1_500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const attempts = await listAttempts(workspacePaths, runId);
    if (!attempts.some((attempt) => attempt.status === "running")) {
      return;
    }
    await sleep(50);
  }
}

async function isRunQuiescent(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string
): Promise<boolean> {
  const [current, attempts] = await Promise.all([
    getCurrentDecision(workspacePaths, runId),
    listAttempts(workspacePaths, runId)
  ]);

  if (!current) {
    return true;
  }

  if (attempts.some((attempt) => ["created", "queued", "running"].includes(attempt.status))) {
    return false;
  }

  return current.run_status !== "running";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTemporaryEnv<T>(
  name: string,
  value: string,
  callback: () => Promise<T>
): Promise<T> {
  const previous = process.env[name];
  process.env[name] = value;

  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
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

async function assertRuntimeHealthSnapshotContextWiring(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-runtime-health-context-"));
  const { run, workspacePaths } = await bootstrapRun(
    rootDir,
    "runtime-health-context"
  );
  const createdAt = new Date().toISOString();

  await saveRunRuntimeHealthSnapshot(workspacePaths, {
    run_id: run.id,
    workspace_root: rootDir,
    evidence_root: process.cwd(),
    verify_runtime: {
      command: "pnpm verify:runtime",
      exit_code: 0,
      status: "passed",
      summary: "runtime 回放通过"
    },
    history_contract_drift: {
      command: "node --import tsx scripts/verify-history-contract-drift.ts",
      exit_code: 1,
      status: "drift_detected",
      summary: "4 个旧 execution attempt 仍有 contract 漂移。",
      scanned_run_count: 1,
      scanned_execution_attempt_count: 4,
      drift_count: 4,
      drifts: []
    },
    created_at: createdAt
  });
  await saveRunSteer(
    workspacePaths,
    createRunSteer({
      run_id: run.id,
      content: "优先读取 runtime 健康证据，再决定下一步。"
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new ContextCaptureAdapter() as never,
    undefined,
    60_000
  );
  await settle({
    orchestrator,
    workspacePaths,
    runId: run.id,
    iterations: 4
  });

  const attempts = await listAttempts(workspacePaths, run.id);
  assert.ok(
    attempts.length >= 1,
    "runtime_health_snapshot_context: expected at least one persisted attempt"
  );
  const context = (await getAttemptContext(
    workspacePaths,
    run.id,
    attempts[0]!.id
  )) as Record<string, unknown> | null;

  assert.ok(
    context && typeof context === "object",
    "runtime_health_snapshot_context: attempt context should be persisted"
  );
  assert.deepEqual(
    context?.runtime_health_snapshot,
    {
      path: `runs/${run.id}/artifacts/runtime-health-snapshot.json`,
      verify_runtime: {
        status: "passed",
        summary: "runtime 回放通过"
      },
      history_contract_drift: {
        status: "drift_detected",
        summary: "4 个旧 execution attempt 仍有 contract 漂移。",
        drift_count: 4
      },
      created_at: createdAt
    },
    "runtime_health_snapshot_context: attempt context should carry the run-level snapshot summary"
  );
}

async function assertMissingRuntimeHealthSnapshotDoesNotFabricateContext(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-missing-runtime-health-context-"));
  const { run, workspacePaths } = await bootstrapRun(
    rootDir,
    "missing-runtime-health-context"
  );

  await saveRunSteer(
    workspacePaths,
    createRunSteer({
      run_id: run.id,
      content: "如果没有 runtime 快照，不要造默认健康对象。"
    })
  );

  const orchestrator = new Orchestrator(
    workspacePaths,
    new ContextCaptureAdapter() as never,
    undefined,
    60_000
  );
  await settle({
    orchestrator,
    workspacePaths,
    runId: run.id,
    iterations: 4
  });

  const attempts = await listAttempts(workspacePaths, run.id);
  assert.ok(
    attempts.length >= 1,
    "missing_runtime_health_snapshot_context: expected at least one persisted attempt"
  );
  const context = (await getAttemptContext(
    workspacePaths,
    run.id,
    attempts[0]!.id
  )) as Record<string, unknown> | null;

  assert.ok(
    context && typeof context === "object",
    "missing_runtime_health_snapshot_context: attempt context should be persisted"
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(context, "runtime_health_snapshot"),
    false,
    "missing_runtime_health_snapshot_context: runtime should not fabricate a health snapshot field"
  );
}

async function assertExplicitPnpmVerificationPlanNeedsLocalNodeModules(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-explicit-pnpm-toolchain-"));
  await seedPackageJsonScriptsWithoutNodeModules(rootDir);

  const assessment = await assessExecutionVerificationToolchain({
    workspaceRoot: rootDir,
    verificationPlan: {
      commands: [
        {
          purpose: "typecheck the workspace after the change",
          command: "pnpm typecheck"
        },
        {
          purpose: "replay the runtime regression suite after the change",
          command: "pnpm verify:runtime"
        }
      ]
    }
  });

  assert.equal(
    assessment.has_package_json,
    true,
    "explicit_pnpm_verification_plan_needs_local_node_modules: package.json should be visible"
  );
  assert.equal(
    assessment.has_local_node_modules,
    false,
    "explicit_pnpm_verification_plan_needs_local_node_modules: fixture should stay without node_modules"
  );
  assert.deepEqual(
    assessment.inferred_pnpm_commands,
    ["pnpm typecheck", "pnpm verify:runtime"],
    "explicit_pnpm_verification_plan_needs_local_node_modules: default pnpm command inference should stay stable"
  );
  assert.deepEqual(
    assessment.blocked_pnpm_commands,
    ["pnpm typecheck", "pnpm verify:runtime"],
    "explicit_pnpm_verification_plan_needs_local_node_modules: explicit pnpm replay commands should be flagged"
  );
}

async function assertMultiReviewerPipelinePersistsOpinionsAndSynthesizesEvaluation(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-multi-reviewer-pipeline-"));
  await initializeGitRepo(rootDir, false);
  const { run, workspacePaths } = await bootstrapRun(rootDir, "multi-reviewer-pipeline");
  const reviewerConfigs = [
    {
      kind: "heuristic",
      reviewer_id: "principal-reviewer",
      role: "principal_reviewer",
      adapter: "deterministic-heuristic",
      provider: "mock-provider-a",
      model: "mock-model-a"
    },
    {
      kind: "cli",
      reviewer_id: "risk-reviewer",
      role: "risk_reviewer",
      adapter: "fixture-cli-reviewer",
      provider: "mock-provider-b",
      model: "mock-model-b",
      command: process.execPath,
      args: [join(process.cwd(), "scripts", "fixture-reviewer-cli.mjs")],
      cwd: process.cwd(),
      timeout_ms: 5_000
    }
  ];

  await withTemporaryEnv(REVIEWER_CONFIG_ENV, JSON.stringify(reviewerConfigs), async () => {
    const orchestrator = new Orchestrator(
      workspacePaths,
      new ScenarioAdapter("happy_path") as never,
      undefined,
      60_000
    );
    await settle({
      orchestrator,
      workspacePaths,
      runId: run.id,
      iterations: 2
    });
  });

  const attempts = await listAttempts(workspacePaths, run.id);
  const researchAttempt = attempts.find(
    (attempt) => attempt.attempt_type === "research" && attempt.status === "completed"
  );
  assert.ok(
    researchAttempt,
    "multi_reviewer_pipeline: expected one completed research attempt"
  );

  const expectedReviewInputPacketRef = `runs/${run.id}/attempts/${researchAttempt!.id}/review_input_packet.json`;
  const expectedEvaluationRef = `runs/${run.id}/attempts/${researchAttempt!.id}/evaluation.json`;
  const [reviewInputPacket, reviewOpinions, evaluation, reviewPacket, current] = await Promise.all([
    getAttemptReviewInputPacket(workspacePaths, run.id, researchAttempt!.id),
    listAttemptReviewOpinions(workspacePaths, run.id, researchAttempt!.id),
    getAttemptEvaluation(workspacePaths, run.id, researchAttempt!.id),
    getAttemptReviewPacket(workspacePaths, run.id, researchAttempt!.id),
    getCurrentDecision(workspacePaths, run.id)
  ]);

  assert.ok(
    reviewInputPacket,
    "multi_reviewer_pipeline: review_input_packet.json should be persisted"
  );
  assert.equal(
    reviewInputPacket?.runtime_verification?.status,
    "not_applicable",
    "multi_reviewer_pipeline: research review input packet should still carry deterministic runtime status"
  );
  assert.equal(
    reviewInputPacket?.attempt.id,
    researchAttempt!.id,
    "multi_reviewer_pipeline: review input packet should match the completed attempt"
  );

  const sortedOpinions = [...reviewOpinions].sort((left, right) =>
    left.reviewer.reviewer_id.localeCompare(right.reviewer.reviewer_id)
  );
  assert.equal(
    sortedOpinions.length,
    2,
    "multi_reviewer_pipeline: both reviewer opinions should be persisted"
  );
  assert.deepEqual(
    sortedOpinions.map((opinion) => opinion.reviewer.role),
    ["principal_reviewer", "risk_reviewer"],
    "multi_reviewer_pipeline: reviewer roles should stay persisted"
  );
  assert.deepEqual(
    sortedOpinions.map((opinion) => opinion.reviewer.provider),
    ["mock-provider-a", "mock-provider-b"],
    "multi_reviewer_pipeline: provider metadata should stay on opinions"
  );
  assert.deepEqual(
    sortedOpinions.map((opinion) => opinion.reviewer.model),
    ["mock-model-a", "mock-model-b"],
    "multi_reviewer_pipeline: model metadata should stay on opinions"
  );
  assert.deepEqual(
    sortedOpinions.map((opinion) => opinion.reviewer.adapter),
    ["deterministic-heuristic", "fixture-cli-reviewer"],
    "multi_reviewer_pipeline: configured reviewer adapters should stay persisted"
  );
  assert.ok(
    sortedOpinions.every((opinion) => opinion.review_input_packet_ref === expectedReviewInputPacketRef),
    "multi_reviewer_pipeline: every opinion should point back to the frozen review input packet"
  );
  assert.ok(
    sortedOpinions.every((opinion) =>
      opinion.input_refs.some(
        (ref) => ref.kind === "review_input_packet" && ref.path === expectedReviewInputPacketRef
      )
    ),
    "multi_reviewer_pipeline: reviewer input refs should include the frozen packet"
  );
  assert.ok(
    sortedOpinions.every(
      (opinion) => opinion.proposed_next_contract?.attempt_type === "execution"
    ),
    "multi_reviewer_pipeline: proposed next contract should be persisted per opinion"
  );
  const cliOpinion = sortedOpinions.find(
    (opinion) => opinion.reviewer.adapter === "fixture-cli-reviewer"
  );
  assert.ok(cliOpinion, "multi_reviewer_pipeline: expected one CLI reviewer opinion");
  const cliOutput = JSON.parse(cliOpinion!.raw_output) as {
    received_attempt_id?: string;
    structured_judgment?: {
      rationale?: string;
    };
  };
  assert.equal(
    cliOutput.received_attempt_id,
    researchAttempt!.id,
    "multi_reviewer_pipeline: CLI reviewer should receive the frozen review input packet"
  );
  assert.equal(
    cliOpinion?.structured_judgment.rationale,
    `cli reviewer checked ${researchAttempt!.id}`,
    "multi_reviewer_pipeline: CLI reviewer judgment should come from the external command"
  );

  assert.ok(evaluation, "multi_reviewer_pipeline: synthesized evaluation should be persisted");
  assert.equal(
    evaluation?.review_input_packet_ref,
    expectedReviewInputPacketRef,
    "multi_reviewer_pipeline: synthesized evaluation should reference the frozen input packet"
  );
  assert.equal(
    evaluation?.opinion_refs.length,
    2,
    "multi_reviewer_pipeline: synthesized evaluation should reference every opinion"
  );
  assert.equal(
    evaluation?.reviewer_count,
    2,
    "multi_reviewer_pipeline: synthesized evaluation should record reviewer count"
  );
  assert.equal(
    evaluation?.synthesis_strategy,
    "deterministic_consensus_v1",
    "multi_reviewer_pipeline: synthesized evaluation should record its merge strategy"
  );

  assert.ok(reviewPacket, "multi_reviewer_pipeline: review packet should still be persisted");
  assert.equal(
    reviewPacket?.review_input_packet_ref,
    expectedReviewInputPacketRef,
    "multi_reviewer_pipeline: review packet should expose the frozen packet ref"
  );
  assert.equal(
    reviewPacket?.synthesized_evaluation_ref,
    expectedEvaluationRef,
    "multi_reviewer_pipeline: review packet should expose the synthesized evaluation ref"
  );
  assert.equal(
    reviewPacket?.review_opinion_refs.length,
    2,
    "multi_reviewer_pipeline: review packet should expose both opinion refs"
  );
  assert.equal(
    reviewPacket?.artifact_manifest.filter((artifact) => artifact.kind === "review_opinion" && artifact.exists).length,
    2,
    "multi_reviewer_pipeline: artifact manifest should include both persisted opinions"
  );

  assert.equal(
    current?.recommended_next_action,
    "start_execution",
    "multi_reviewer_pipeline: loop should keep consuming a single synthesized evaluation"
  );
  assert.equal(
    current?.latest_attempt_id,
    researchAttempt!.id,
    "multi_reviewer_pipeline: current decision should still point at the settled attempt"
  );
}

function buildCliReviewerFailureMatcher(
  mode: CliReviewerFailureMode,
  timeoutMs: number
): RegExp {
  switch (mode) {
    case "invalid_json":
      return /opinion 落盘前失败：CLI reviewer .* returned invalid JSON/;
    case "nonzero_exit":
      return /opinion 落盘前失败：CLI reviewer command failed/;
    case "timeout":
      return new RegExp(`opinion 落盘前失败：CLI reviewer command timed out after ${timeoutMs}ms`);
  }
}

function getCliReviewerFailureTimeoutMs(mode: CliReviewerFailureMode): number {
  return mode === "timeout"
    ? CLI_REVIEWER_TIMEOUT_CASE_MS
    : CLI_REVIEWER_PROCESS_FAILURE_TIMEOUT_MS;
}

async function assertCliReviewerFailureBlocksOpinionPersistence(
  mode: CliReviewerFailureMode
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), `aisa-cli-reviewer-${mode}-`));
  await initializeGitRepo(rootDir, false);
  const { run, workspacePaths } = await bootstrapRun(rootDir, `cli-reviewer-${mode}`);
  const reviewerConfigs = [
    {
      kind: "heuristic",
      reviewer_id: "principal-reviewer",
      role: "principal_reviewer",
      adapter: "deterministic-heuristic"
    },
    {
      kind: "cli",
      reviewer_id: `${mode}-reviewer`,
      role: "runtime_reviewer",
      adapter: `inline-${mode}-reviewer`,
      command: process.execPath,
      args: [join(process.cwd(), "scripts", "fixture-reviewer-cli.mjs"), mode],
      cwd: process.cwd(),
      timeout_ms: getCliReviewerFailureTimeoutMs(mode)
    }
  ];

  await withTemporaryEnv(REVIEWER_CONFIG_ENV, JSON.stringify(reviewerConfigs), async () => {
    const orchestrator = new Orchestrator(
      workspacePaths,
      new ScenarioAdapter("happy_path") as never,
      undefined,
      60_000
    );
    await settle({
      orchestrator,
      workspacePaths,
      runId: run.id,
      iterations: 2
    });
  });

  const attempts = await listAttempts(workspacePaths, run.id);
  const failedResearchAttempt = attempts.find(
    (attempt) => attempt.attempt_type === "research" && attempt.status === "failed"
  );
  assert.ok(
    failedResearchAttempt,
    `cli_reviewer_${mode}: expected one failed research attempt`
  );

  const expectedReviewInputPacketRef = `runs/${run.id}/attempts/${failedResearchAttempt!.id}/review_input_packet.json`;
  const [reviewInputPacket, reviewOpinions, evaluation, reviewPacket, current] = await Promise.all([
    getAttemptReviewInputPacket(workspacePaths, run.id, failedResearchAttempt!.id),
    listAttemptReviewOpinions(workspacePaths, run.id, failedResearchAttempt!.id),
    getAttemptEvaluation(workspacePaths, run.id, failedResearchAttempt!.id),
    getAttemptReviewPacket(workspacePaths, run.id, failedResearchAttempt!.id),
    getCurrentDecision(workspacePaths, run.id)
  ]);

  assert.ok(
    reviewInputPacket,
    `cli_reviewer_${mode}: review_input_packet.json should still be persisted before the reviewer fails`
  );
  assert.equal(
    reviewInputPacket?.attempt.status,
    "completed",
    `cli_reviewer_${mode}: frozen review input packet should keep the pre-review completed status`
  );
  assert.ok(reviewPacket, `cli_reviewer_${mode}: review packet should still be persisted`);
  assert.equal(
    reviewPacket?.attempt.status,
    "failed",
    `cli_reviewer_${mode}: settled review packet should expose the failed attempt status`
  );
  assert.equal(
    reviewPacket?.review_input_packet_ref,
    expectedReviewInputPacketRef,
    `cli_reviewer_${mode}: review packet should still point at the frozen input packet`
  );
  assert.equal(
    reviewOpinions.length,
    0,
    `cli_reviewer_${mode}: no reviewer opinion should be persisted when one reviewer fails`
  );
  assert.equal(
    reviewPacket?.review_opinion_refs.length,
    0,
    `cli_reviewer_${mode}: review packet should not expose opinion refs after reviewer failure`
  );
  assert.equal(
    reviewPacket?.artifact_manifest.filter(
      (artifact) => artifact.kind === "review_opinion" && artifact.exists
    ).length,
    0,
    `cli_reviewer_${mode}: artifact manifest should stay free of review opinion files`
  );
  assert.equal(
    evaluation,
    null,
    `cli_reviewer_${mode}: synthesized evaluation should not be persisted after reviewer failure`
  );
  assert.equal(
    current?.recommended_next_action,
    "wait_for_human",
    `cli_reviewer_${mode}: loop should stop and wait for human recovery`
  );
  assert.equal(
    current?.latest_attempt_id,
    failedResearchAttempt!.id,
    `cli_reviewer_${mode}: current decision should point at the failed attempt`
  );
  assert.match(
    current?.blocking_reason ?? "",
    buildCliReviewerFailureMatcher(mode, getCliReviewerFailureTimeoutMs(mode)),
    `cli_reviewer_${mode}: blocking reason should expose the reviewer failure`
  );
  assert.match(
    reviewPacket?.failure_context?.message ?? "",
    buildCliReviewerFailureMatcher(mode, getCliReviewerFailureTimeoutMs(mode)),
    `cli_reviewer_${mode}: failure context should expose the reviewer failure`
  );
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
    preexisting_git_status: [],
    new_git_status: [],
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

async function seedAttemptWorkspaceEscapeCase(input: {
  rootDir: string;
  run: Run;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
}): Promise<void> {
  const runWorkspaceRoot = join(input.rootDir, "projects", "project-a");
  const escapedWorkspaceRoot = join(input.rootDir, "projects", "project-b");
  await mkdir(runWorkspaceRoot, { recursive: true });
  await mkdir(escapedWorkspaceRoot, { recursive: true });

  const scopedRun = updateRun(input.run, {
    workspace_root: runWorkspaceRoot
  });
  await saveRun(input.workspacePaths, scopedRun);

  const escapedAttempt = createAttempt({
    run_id: scopedRun.id,
    attempt_type: "execution",
    worker: "fake-codex",
    objective: "This attempt should be blocked before it can leave the run workspace.",
    success_criteria: scopedRun.success_criteria,
    workspace_root: escapedWorkspaceRoot
  });
  await saveAttempt(input.workspacePaths, escapedAttempt);
  await saveAttemptContract(
    input.workspacePaths,
    createAttemptContract({
      attempt_id: escapedAttempt.id,
      run_id: scopedRun.id,
      attempt_type: escapedAttempt.attempt_type,
      objective: escapedAttempt.objective,
      success_criteria: escapedAttempt.success_criteria,
      required_evidence: [
        "keep the attempt workspace inside the run workspace root"
      ],
      expected_artifacts: ["execution-change.md"],
      verification_plan: {
        commands: [
          {
            purpose: "confirm the execution change was written",
            command:
              'test -f execution-change.md && rg -n "^execution change from" execution-change.md'
          }
        ]
      }
    })
  );
  await saveCurrentDecision(
    input.workspacePaths,
    createCurrentDecision({
      run_id: scopedRun.id,
      run_status: "running",
      latest_attempt_id: escapedAttempt.id,
      recommended_next_action: "continue_execution",
      recommended_attempt_type: "execution",
      summary: "Prepared to verify run workspace boundaries."
    })
  );
  await appendRunJournal(
    input.workspacePaths,
    createRunJournalEntry({
      run_id: scopedRun.id,
      attempt_id: escapedAttempt.id,
      type: "attempt.created",
      payload: {
        attempt_type: escapedAttempt.attempt_type,
        objective: escapedAttempt.objective
      }
    })
  );
}

function parseYamlScalar(rawValue: string): unknown {
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return JSON.parse(
      rawValue.startsWith("'")
        ? `"${rawValue.slice(1, -1).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
        : rawValue
    );
  }

  if (rawValue === "true") {
    return true;
  }

  if (rawValue === "false") {
    return false;
  }

  if (rawValue === "null") {
    return null;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) {
    return Number(rawValue);
  }

  return rawValue;
}

function parseSimpleYaml(text: string): Record<string, unknown> {
  const lines = text
    .split(/\r?\n/)
    .map((line, index) => ({
      line: index + 1,
      indent: line.match(/^ */)?.[0].length ?? 0,
      content: line.trim()
    }))
    .filter((line) => line.content.length > 0 && !line.content.startsWith("#"));

  const root: Record<string, unknown> = {};
  const stack: Array<{
    indent: number;
    container: Record<string, unknown> | unknown[];
    type: "map" | "list";
  }> = [
    {
      indent: -1,
      container: root,
      type: "map"
    }
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    if (line.indent % 2 !== 0) {
      throw new Error(`Unsupported indentation on line ${line.line} in regression-gates.yaml`);
    }

    while (stack.length > 1 && line.indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1]!;

    if (line.content.startsWith("- ")) {
      if (parent.type !== "list") {
        throw new Error(`Unexpected list item on line ${line.line} in regression-gates.yaml`);
      }

      parent.container.push(parseYamlScalar(line.content.slice(2).trim()));
      continue;
    }

    const separatorIndex = line.content.indexOf(":");
    if (separatorIndex <= 0) {
      throw new Error(`Invalid YAML mapping on line ${line.line} in regression-gates.yaml`);
    }

    const key = line.content.slice(0, separatorIndex).trim();
    const rawValue = line.content.slice(separatorIndex + 1).trim();

    if (parent.type !== "map") {
      throw new Error(`Unexpected mapping on line ${line.line} in regression-gates.yaml`);
    }

    if (rawValue.length > 0) {
      parent.container[key] = parseYamlScalar(rawValue);
      continue;
    }

    const nextLine = lines[index + 1];
    const childContainer =
      nextLine && nextLine.indent > line.indent && nextLine.content.startsWith("- ")
        ? []
        : {};

    parent.container[key] = childContainer;
    stack.push({
      indent: line.indent,
      container: childContainer,
      type: Array.isArray(childContainer) ? "list" : "map"
    });
  }

  return root;
}

async function assertRegressionGatesParseable(): Promise<void> {
  const filePath = join(
    process.cwd(),
    "evals",
    "runtime-run-loop",
    "regression-gates.yaml"
  );
  const parsed = parseSimpleYaml(await readFile(filePath, "utf8"));
  const promotionRule =
    parsed.promotion_rule && typeof parsed.promotion_rule === "object"
      ? (parsed.promotion_rule as Record<string, unknown>)
      : null;
  const gates =
    parsed.gates && typeof parsed.gates === "object"
      ? (parsed.gates as Record<string, unknown>)
      : null;
  const smokeGate =
    gates?.smoke && typeof gates.smoke === "object"
      ? (gates.smoke as Record<string, unknown>)
      : null;

  assert.equal(parsed.version, 1, "regression-gates.yaml should keep version=1");
  assert.equal(
    promotionRule?.require_review_packet_schema_stable,
    true,
    "regression-gates.yaml should keep review packet stability gate enabled"
  );
  assert.equal(
    smokeGate?.required_pass_rate,
    1,
    "regression-gates.yaml should keep the smoke pass rate gate"
  );
}

async function loadSmokeCases(): Promise<ScenarioCase[]> {
  await assertRegressionGatesParseable();
  await loadReviewPacketSchema();
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

  if (scenario.driver === "execution_dirty_workspace_without_new_changes_fails_verification") {
    await initializeGitRepo(rootDir, true);
  }

  if (
    scenario.driver === "happy_path" ||
    scenario.driver === "execution_verified_next_step_continues" ||
    scenario.driver === "execution_runtime_source_drift_requires_restart" ||
    scenario.driver === "execution_missing_verification_plan" ||
    scenario.driver === "execution_retry_after_recovery_preserves_contract"
  ) {
    if (scenario.driver === "execution_runtime_source_drift_requires_restart") {
      await seedLiveRuntimeSourceFixture(rootDir);
    }
    await initializeGitRepo(rootDir, false);
  }

  if (scenario.driver === "execution_missing_local_toolchain_blocks_dispatch") {
    await seedPackageJsonScriptsWithoutNodeModules(rootDir);
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

  if (scenario.driver === "attempt_workspace_escapes_run_scope") {
    await seedAttemptWorkspaceEscapeCase({
      rootDir,
      run,
      workspacePaths
    });
  }

  const orchestrator = new Orchestrator(
    workspacePaths,
    new ScenarioAdapter(scenario.driver) as never,
    undefined,
    60_000
  );
  await settle({
    orchestrator,
    workspacePaths,
    runId: run.id,
    iterations: scenario.max_ticks
  });
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

async function seedPackageJsonScriptsWithoutNodeModules(rootDir: string): Promise<void> {
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify(
      {
        name: "missing-toolchain-workspace",
        private: true,
        scripts: {
          typecheck: "tsc --noEmit",
          "verify:runtime": "node --import tsx scripts/verify-runtime.ts"
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

async function seedLiveRuntimeSourceFixture(rootDir: string): Promise<void> {
  const runtimeDir = join(rootDir, "packages", "orchestrator", "src");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "index.ts"), 'export const runtimeMarker = "seed";\n', "utf8");
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

async function readGitStatusOrEmpty(rootDir: string): Promise<string[]> {
  const result = await runCommandCapture(rootDir, [
    "git",
    "-C",
    rootDir,
    "status",
    "--short"
  ]);
  if (result.exitCode !== 0) {
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

async function runCommandCapture(
  rootDir: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1
      });
    });
  });
}

function buildExpectedInputContextRef(runId: string, attemptId: string): string {
  return `runs/${runId}/attempts/${attemptId}/context.json`;
}

async function collectObservation(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string
): Promise<ScenarioObservation> {
  const run = await getRun(workspacePaths, runId);
  const attempts = await listAttempts(workspacePaths, runId);
  const current = await getCurrentDecision(workspacePaths, runId);
  const journal = await listRunJournal(workspacePaths, runId);
  const sourceWorkspaceGitStatus = await readGitStatusOrEmpty(run.workspace_root);
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
        const reviewPacketPath = resolveAttemptPaths(workspacePaths, runId, attempt.id).reviewPacketFile;
        const [reviewPacket, reviewPacketSchemaValidation] = await Promise.all([
          getAttemptReviewPacket(workspacePaths, runId, attempt.id),
          validatePersistedReviewPacket({
            reviewPacketFile: reviewPacketPath
          })
        ]);
        const artifactManifest = reviewPacket?.artifact_manifest ?? [];
        const artifactByKind = new Map(
          artifactManifest.map((artifact) => [artifact.kind, artifact] as const)
        );
        const metaArtifact = artifactByKind.get("attempt_meta") ?? null;
        const contractArtifact = artifactByKind.get("attempt_contract") ?? null;
        const contextArtifact = artifactByKind.get("attempt_context") ?? null;
        const resultArtifact = artifactByKind.get("attempt_result") ?? null;
        const evaluationArtifact = artifactByKind.get("attempt_evaluation") ?? null;
        const runtimeVerificationArtifact = artifactByKind.get("runtime_verification") ?? null;
        const expectedInputContextRef = buildExpectedInputContextRef(runId, attempt.id);
        const attemptContractVerificationCommands =
          reviewPacket?.attempt_contract?.verification_plan?.commands.map(
            (command) => command.command
          ) ?? [];
        const restartRequiredEntry = [...(reviewPacket?.journal ?? [])]
          .reverse()
          .find((entry) => entry.type === "attempt.restart_required");
        const restartRequiredPayload =
          restartRequiredEntry?.payload && typeof restartRequiredEntry.payload === "object"
            ? restartRequiredEntry.payload
            : null;
        const restartRequiredAffectedFiles = Array.isArray(
          restartRequiredPayload?.affected_files
        )
          ? restartRequiredPayload.affected_files.filter(
              (filePath): filePath is string => typeof filePath === "string"
            )
          : [];

        return {
          attempt_id: attempt.id,
          attempt_status: attempt.status,
          path: reviewPacketPath,
          has_packet: reviewPacket !== null,
          matches_schema: reviewPacketSchemaValidation.matchesSchema,
          schema_error: reviewPacketSchemaValidation.schemaError,
          matches_run_id: reviewPacket?.run_id === runId,
          matches_attempt_id:
            reviewPacket?.attempt_id === attempt.id && reviewPacket?.attempt.id === attempt.id,
          contract_objective_matches_attempt:
            reviewPacket?.attempt_contract?.objective === attempt.objective,
          contract_success_criteria_match_attempt:
            JSON.stringify(reviewPacket?.attempt_contract?.success_criteria ?? null) ===
            JSON.stringify(attempt.success_criteria),
          has_generated_at:
            typeof reviewPacket?.generated_at === "string" && reviewPacket.generated_at.length > 0,
          has_attempt_contract: reviewPacket?.attempt_contract !== null,
          has_current_decision_snapshot: reviewPacket?.current_decision_snapshot !== null,
          snapshot_blocking_reason: reviewPacket?.current_decision_snapshot?.blocking_reason ?? null,
          journal_count: reviewPacket?.journal.length ?? 0,
          has_failure_context: reviewPacket?.failure_context !== null,
          failure_message: reviewPacket?.failure_context?.message ?? null,
          has_result: reviewPacket?.result !== null,
          has_evaluation: reviewPacket?.evaluation !== null,
          has_runtime_verification: reviewPacket?.runtime_verification !== null,
          artifact_manifest_count: artifactManifest.length,
          has_meta_artifact: metaArtifact !== null,
          meta_artifact_exists: metaArtifact?.exists ?? false,
          has_contract_artifact: contractArtifact !== null,
          contract_artifact_exists: contractArtifact?.exists ?? false,
          has_context_artifact: contextArtifact !== null,
          context_artifact_exists: contextArtifact?.exists ?? false,
          has_result_artifact: resultArtifact !== null,
          result_artifact_exists: resultArtifact?.exists ?? false,
          has_evaluation_artifact: evaluationArtifact !== null,
          evaluation_artifact_exists: evaluationArtifact?.exists ?? false,
          has_runtime_verification_artifact: runtimeVerificationArtifact !== null,
          runtime_verification_artifact_exists: runtimeVerificationArtifact?.exists ?? false,
          expected_input_context_ref: expectedInputContextRef,
          meta_input_context_ref: attempt.input_context_ref,
          review_packet_attempt_input_context_ref:
            reviewPacket?.attempt.input_context_ref ?? null,
          input_context_ref_matches_expected:
            attempt.input_context_ref === expectedInputContextRef &&
            reviewPacket?.attempt.input_context_ref === expectedInputContextRef,
          runtime_verification_status: reviewPacket?.runtime_verification?.status ?? null,
          runtime_verification_failure_code:
            reviewPacket?.runtime_verification?.failure_code ?? null,
          runtime_verification_preexisting_git_status:
            reviewPacket?.runtime_verification?.preexisting_git_status ?? [],
          runtime_verification_new_git_status:
            reviewPacket?.runtime_verification?.new_git_status ?? [],
          runtime_verification_changed_files:
            reviewPacket?.runtime_verification?.changed_files ?? [],
          attempt_contract_has_verification_plan:
            reviewPacket?.attempt_contract?.verification_plan !== undefined,
          attempt_contract_verification_commands: attemptContractVerificationCommands,
          restart_required_message:
            typeof restartRequiredPayload?.message === "string"
              ? restartRequiredPayload.message
              : null,
          restart_required_affected_files: restartRequiredAffectedFiles
        };
      })
  );

  return {
    run_id: runId,
    run_workspace_root: run.workspace_root,
    managed_workspace_root: run.managed_workspace_root,
    source_workspace_git_status: sourceWorkspaceGitStatus,
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

  let blockerReasonCapturedInPacket = !scenario.expected.blocking_reason_includes;

  for (const reviewPacket of observation.review_packets) {
    assert.ok(reviewPacket.has_packet, `${scenario.id}: missing review packet for ${reviewPacket.attempt_id}`);
    assert.ok(
      reviewPacket.matches_schema,
      `${scenario.id}: review packet schema mismatch for ${reviewPacket.attempt_id}: ${reviewPacket.schema_error ?? "unknown"}`
    );
    assert.ok(
      reviewPacket.matches_run_id,
      `${scenario.id}: review packet run_id mismatch for ${reviewPacket.attempt_id}`
    );
    assert.ok(
      reviewPacket.matches_attempt_id,
      `${scenario.id}: review packet attempt metadata mismatch for ${reviewPacket.attempt_id}`
    );
    assert.ok(
      reviewPacket.contract_objective_matches_attempt,
      `${scenario.id}: attempt_contract objective drift for ${reviewPacket.attempt_id}`
    );
    assert.ok(
      reviewPacket.contract_success_criteria_match_attempt,
      `${scenario.id}: attempt_contract success_criteria drift for ${reviewPacket.attempt_id}`
    );
    assert.ok(
      reviewPacket.has_generated_at,
      `${scenario.id}: review packet missing generated_at for ${reviewPacket.attempt_id}`
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
    assert.ok(
      reviewPacket.has_meta_artifact && reviewPacket.meta_artifact_exists,
      `${scenario.id}: review packet missing attempt meta artifact for ${reviewPacket.attempt_id}`
    );
    assert.ok(
      reviewPacket.has_contract_artifact && reviewPacket.contract_artifact_exists,
      `${scenario.id}: review packet missing attempt contract artifact for ${reviewPacket.attempt_id}`
    );
    assert.ok(
      reviewPacket.has_context_artifact,
      `${scenario.id}: review packet missing attempt context manifest entry for ${reviewPacket.attempt_id}`
    );
    assert.ok(
      reviewPacket.has_result_artifact,
      `${scenario.id}: review packet missing result manifest entry for ${reviewPacket.attempt_id}`
    );
    assert.ok(
      reviewPacket.has_evaluation_artifact,
      `${scenario.id}: review packet missing evaluation manifest entry for ${reviewPacket.attempt_id}`
    );
    assert.ok(
      reviewPacket.has_runtime_verification_artifact,
      `${scenario.id}: review packet missing runtime verification manifest entry for ${reviewPacket.attempt_id}`
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
      assert.ok(
        reviewPacket.result_artifact_exists,
        `${scenario.id}: completed attempt missing persisted result artifact for ${reviewPacket.attempt_id}`
      );
      assert.ok(
        reviewPacket.evaluation_artifact_exists,
        `${scenario.id}: completed attempt missing persisted evaluation artifact for ${reviewPacket.attempt_id}`
      );
      assert.ok(
        reviewPacket.runtime_verification_artifact_exists,
        `${scenario.id}: completed attempt missing persisted runtime verification artifact for ${reviewPacket.attempt_id}`
      );
    } else {
      assert.ok(
        reviewPacket.journal_count > 0 || reviewPacket.has_failure_context,
        `${scenario.id}: blocker attempt missing journal and failure context for ${reviewPacket.attempt_id}`
      );
      assert.ok(
        reviewPacket.has_failure_context,
        `${scenario.id}: blocker attempt missing failure context for ${reviewPacket.attempt_id}`
      );
    }

    if (reviewPacket.context_artifact_exists) {
      assert.ok(
        reviewPacket.input_context_ref_matches_expected,
        `${scenario.id}: input_context_ref should point at ${reviewPacket.expected_input_context_ref} for ${reviewPacket.attempt_id}, got meta=${reviewPacket.meta_input_context_ref ?? "null"} review_packet=${reviewPacket.review_packet_attempt_input_context_ref ?? "null"}`
      );
    }

    if (
      scenario.expected.blocking_reason_includes &&
      (
        reviewPacket.snapshot_blocking_reason?.includes(
          scenario.expected.blocking_reason_includes
        ) ??
        false
      )
    ) {
      blockerReasonCapturedInPacket = true;
    }

    if (
      scenario.expected.blocking_reason_includes &&
      (
        reviewPacket.failure_message?.includes(scenario.expected.blocking_reason_includes) ??
        false
      )
    ) {
      blockerReasonCapturedInPacket = true;
    }
  }

  assert.ok(
    blockerReasonCapturedInPacket,
    `${scenario.id}: review packet should capture the blocking reason`
  );

  if (scenario.driver === "execution_checkpoint_blocked_dirty_workspace") {
    const executionPacket = observation.review_packets.find(
      (packet) => packet.runtime_verification_status === "passed"
    );
    assert.ok(
      executionPacket,
      `${scenario.id}: expected a completed execution review packet with runtime verification`
    );
    assert.ok(
      observation.managed_workspace_root,
      `${scenario.id}: expected the run to provision a managed workspace`
    );
    assert.notEqual(
      observation.managed_workspace_root,
      observation.run_workspace_root,
      `${scenario.id}: managed workspace should differ from the source workspace`
    );
    assert.ok(
      observation.source_workspace_git_status.includes(" M README.md"),
      `${scenario.id}: source workspace should stay dirty so the isolation is real`
    );
    assert.deepEqual(
      executionPacket.runtime_verification_preexisting_git_status,
      [],
      `${scenario.id}: runtime verification should start from a clean managed baseline`
    );
    assert.deepEqual(
      executionPacket.runtime_verification_new_git_status,
      ["?? execution-change.md"],
      `${scenario.id}: runtime verification should isolate the new git delta`
    );
    assert.deepEqual(
      executionPacket.runtime_verification_changed_files,
      ["execution-change.md"],
      `${scenario.id}: changed_files should only report the new delta`
    );
  }

  if (scenario.driver === "execution_dirty_workspace_without_new_changes_fails_verification") {
    const executionPacket = observation.review_packets.find(
      (packet) => packet.runtime_verification_status === "failed"
    );
    assert.ok(
      executionPacket,
      `${scenario.id}: expected a failed execution review packet with runtime verification`
    );
    assert.equal(
      executionPacket.runtime_verification_failure_code,
      "no_git_changes",
      `${scenario.id}: dirty workspace without new delta should fail as no_git_changes`
    );
    assert.ok(
      observation.source_workspace_git_status.includes(" M README.md"),
      `${scenario.id}: source workspace should stay dirty while managed verification runs elsewhere`
    );
    assert.deepEqual(
      executionPacket.runtime_verification_preexisting_git_status,
      [],
      `${scenario.id}: managed verification baseline should start clean`
    );
    assert.deepEqual(
      executionPacket.runtime_verification_new_git_status,
      [],
      `${scenario.id}: runtime verification should not invent a new git delta`
    );
    assert.deepEqual(
      executionPacket.runtime_verification_changed_files,
      [],
      `${scenario.id}: changed_files should stay empty when execution leaves no new delta`
    );
  }

  if (scenario.driver === "execution_runtime_source_drift_requires_restart") {
    const executionPacket = observation.review_packets.find(
      (packet) => packet.runtime_verification_status === "passed"
    );
    assert.ok(
      executionPacket,
      `${scenario.id}: expected a completed execution review packet with runtime verification`
    );
    assert.deepEqual(
      executionPacket.runtime_verification_changed_files,
      ["packages/orchestrator/src/index.ts"],
      `${scenario.id}: runtime verification should record the changed runtime source file`
    );
    assert.ok(
      executionPacket.restart_required_message?.includes("Restart before the next dispatch"),
      `${scenario.id}: review packet should record the restart-required message`
    );
    assert.deepEqual(
      executionPacket.restart_required_affected_files,
      ["packages/orchestrator/src/index.ts"],
      `${scenario.id}: review packet should record the affected runtime files`
    );
  }

  if (scenario.driver === "execution_missing_local_toolchain_blocks_dispatch") {
    const executionPacket = observation.review_packets.find(
      (packet) => packet.attempt_status === "failed"
    );
    assert.ok(
      executionPacket,
      `${scenario.id}: expected a failed execution review packet`
    );
    assert.equal(
      executionPacket.has_result,
      false,
      `${scenario.id}: execution should be blocked before any worker result is persisted`
    );
    assert.equal(
      executionPacket.has_evaluation,
      false,
      `${scenario.id}: execution should be blocked before evaluation`
    );
    assert.equal(
      executionPacket.has_runtime_verification,
      false,
      `${scenario.id}: execution should be blocked before runtime verification`
    );
    assert.equal(
      executionPacket.attempt_contract_has_verification_plan,
      false,
      `${scenario.id}: runtime should refuse to auto-generate a pnpm verification plan`
    );
    assert.deepEqual(
      executionPacket.attempt_contract_verification_commands,
      [],
      `${scenario.id}: execution attempt contract should stay free of inferred pnpm commands`
    );
  }
}

function parseNdjson<T>(text: string): T[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

async function assertPersistedPostRestartPromptChain(): Promise<void> {
  const rootDir = process.cwd();
  const reportPath = join(
    rootDir,
    "runs",
    "run_3374dc3f",
    "attempts",
    "att_cccd2297",
    "artifacts",
    "post-restart-prompt-chain.json"
  );
  const report = JSON.parse(
    await readFile(reportPath, "utf8")
  ) as PersistedPromptChainReport;

  assert.equal(report.report_version, 1, "post_restart_prompt_chain: report version must stay stable");
  assert.equal(report.run_id, "run_3374dc3f");
  assert.equal(report.attempt_id, "att_cccd2297");
  assert.equal(report.legacy_execution_attempt_id, "att_d62b75b4");
  assert.equal(report.post_restart_execution_attempt_id, "att_cccd2297");
  assert.deepEqual(
    report.replay_commands.map((command) => command.command),
    ["pnpm verify:worker-adapter", "pnpm verify:run-loop", "pnpm verify:run-autonomy"],
    "post_restart_prompt_chain: replay commands must stay aligned with the locked attempt contract"
  );

  for (const evidence of report.evidence_chain) {
    const text = await readFile(join(rootDir, evidence.path), "utf8");

    if (evidence.check === "must_include") {
      assert.ok(
        text.includes(evidence.value),
        `${evidence.id}: expected ${evidence.path} to include the recorded evidence`
      );
      continue;
    }

    assert.ok(
      !text.includes(evidence.value),
      `${evidence.id}: expected ${evidence.path} to stay free of the new guard text`
    );
  }

  const legacyPromptPath = join(
    rootDir,
    "runs",
    report.run_id,
    "attempts",
    report.legacy_execution_attempt_id,
    "worker-prompt.md"
  );
  const currentPromptPath = join(
    rootDir,
    "runs",
    report.run_id,
    "attempts",
    report.post_restart_execution_attempt_id,
    "worker-prompt.md"
  );
  const legacyPrompt = await readFile(legacyPromptPath, "utf8");
  const currentPrompt = await readFile(currentPromptPath, "utf8");
  const {
    findings_guard: findingsGuard,
    artifacts_guard: artifactsGuard,
    artifact_example: artifactExample,
    plain_string_guard: plainStringGuard
  } = report.guard_strings;

  assert.ok(
    !legacyPrompt.includes(findingsGuard) &&
      !legacyPrompt.includes(artifactsGuard) &&
      !legacyPrompt.includes(artifactExample) &&
      !legacyPrompt.includes(plainStringGuard),
    "post_restart_prompt_chain: legacy execution prompt should still show the missing guardrail state"
  );
  assert.ok(
    currentPrompt.includes(findingsGuard) &&
      currentPrompt.includes(artifactsGuard) &&
      currentPrompt.includes(artifactExample) &&
      currentPrompt.includes(plainStringGuard),
    "post_restart_prompt_chain: restarted execution prompt should include all artifact guardrails"
  );

  const currentMeta = JSON.parse(
    await readFile(
      join(rootDir, "runs", report.run_id, "attempts", report.attempt_id, "meta.json"),
      "utf8"
    )
  ) as {
    started_at: string | null;
  };
  assert.equal(
    currentMeta.started_at,
    report.restart_transition.new_attempt_started_at,
    "post_restart_prompt_chain: persisted meta should pin the restarted execution start time"
  );

  const journal = parseNdjson<JournalEntryLite>(
    await readFile(join(rootDir, "runs", report.run_id, "journal.ndjson"), "utf8")
  );
  const manualRecoveryIndex = journal.findIndex(
    (entry) => entry.id === report.restart_transition.manual_recovery_event_id
  );
  const runLaunchIndex = journal.findIndex(
    (entry) => entry.id === report.restart_transition.run_launch_event_id
  );
  const restartedAttemptStartIndex = journal.findIndex(
    (entry) => entry.attempt_id === report.attempt_id && entry.type === "attempt.started"
  );

  assert.ok(manualRecoveryIndex >= 0, "post_restart_prompt_chain: manual recovery event missing");
  assert.ok(runLaunchIndex > manualRecoveryIndex, "post_restart_prompt_chain: run launch must follow manual recovery");
  assert.ok(
    restartedAttemptStartIndex > runLaunchIndex,
    "post_restart_prompt_chain: restarted execution must start after the relaunch event"
  );
  assert.ok(
    new Date(journal[runLaunchIndex]!.ts).getTime() <=
      new Date(report.restart_transition.new_attempt_started_at).getTime(),
    "post_restart_prompt_chain: prompt evidence must come from the relaunched runtime"
  );
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

  try {
    await assertPersistedPostRestartPromptChain();
    results.push({
      id: "post_restart_prompt_chain",
      status: "pass"
    });
  } catch (error) {
    results.push({
      id: "post_restart_prompt_chain",
      status: "fail",
      error: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    await assertRuntimeHealthSnapshotContextWiring();
    results.push({
      id: "runtime_health_snapshot_context",
      status: "pass"
    });
  } catch (error) {
    results.push({
      id: "runtime_health_snapshot_context",
      status: "fail",
      error: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    await assertMissingRuntimeHealthSnapshotDoesNotFabricateContext();
    results.push({
      id: "missing_runtime_health_snapshot_context",
      status: "pass"
    });
  } catch (error) {
    results.push({
      id: "missing_runtime_health_snapshot_context",
      status: "fail",
      error: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    await assertExplicitPnpmVerificationPlanNeedsLocalNodeModules();
    results.push({
      id: "explicit_pnpm_verification_plan_needs_local_node_modules",
      status: "pass"
    });
  } catch (error) {
    results.push({
      id: "explicit_pnpm_verification_plan_needs_local_node_modules",
      status: "fail",
      error: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    await assertCliReviewerFailureBlocksOpinionPersistence("invalid_json");
    results.push({
      id: "cli_reviewer_invalid_json_blocks_opinion_persistence",
      status: "pass"
    });
  } catch (error) {
    results.push({
      id: "cli_reviewer_invalid_json_blocks_opinion_persistence",
      status: "fail",
      error: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    await assertCliReviewerFailureBlocksOpinionPersistence("nonzero_exit");
    results.push({
      id: "cli_reviewer_nonzero_exit_blocks_opinion_persistence",
      status: "pass"
    });
  } catch (error) {
    results.push({
      id: "cli_reviewer_nonzero_exit_blocks_opinion_persistence",
      status: "fail",
      error: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    await assertCliReviewerFailureBlocksOpinionPersistence("timeout");
    results.push({
      id: "cli_reviewer_timeout_blocks_opinion_persistence",
      status: "pass"
    });
  } catch (error) {
    results.push({
      id: "cli_reviewer_timeout_blocks_opinion_persistence",
      status: "fail",
      error: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    await assertMultiReviewerPipelinePersistsOpinionsAndSynthesizesEvaluation();
    results.push({
      id: "multi_reviewer_pipeline_persists_and_synthesizes",
      status: "pass"
    });
  } catch (error) {
    results.push({
      id: "multi_reviewer_pipeline_persists_and_synthesizes",
      status: "fail",
      error: error instanceof Error ? error.message : String(error)
    });
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
