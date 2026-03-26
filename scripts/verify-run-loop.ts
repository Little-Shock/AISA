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
  updateAttempt,
  WorkerWritebackSchema,
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
  | "execution_verified_next_step_continues"
  | "execution_runtime_source_drift_requires_restart"
  | "execution_checkpoint_blocked_dirty_workspace"
  | "execution_dirty_workspace_without_new_changes_fails_verification"
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
    matches_schema: boolean;
    schema_error: string | null;
    matches_run_id: boolean;
    matches_attempt_id: boolean;
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
    has_result_artifact: boolean;
    result_artifact_exists: boolean;
    has_evaluation_artifact: boolean;
    evaluation_artifact_exists: boolean;
    has_runtime_verification_artifact: boolean;
    runtime_verification_artifact_exists: boolean;
    runtime_verification_status: string | null;
    runtime_verification_failure_code: string | null;
    runtime_verification_preexisting_git_status: string[];
    runtime_verification_new_git_status: string[];
    runtime_verification_changed_files: string[];
    restart_required_message: string | null;
    restart_required_affected_files: string[];
  }>;
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
          join(input.run.workspace_root, "packages", "orchestrator", "src", "index.ts"),
          `export const runtimeMarker = "${input.attempt.id}";\n`,
          "utf8"
        );
      } else {
        await writeFile(
          join(input.run.workspace_root, "execution-change.md"),
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
          verification_plan: {
            commands: [
              {
                purpose: "confirm the execution change was written",
                command: this.buildExecutionVerificationCommand()
              }
            ]
          }
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
        const resultArtifact = artifactByKind.get("attempt_result") ?? null;
        const evaluationArtifact = artifactByKind.get("attempt_evaluation") ?? null;
        const runtimeVerificationArtifact = artifactByKind.get("runtime_verification") ?? null;
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
          has_result_artifact: resultArtifact !== null,
          result_artifact_exists: resultArtifact?.exists ?? false,
          has_evaluation_artifact: evaluationArtifact !== null,
          evaluation_artifact_exists: evaluationArtifact?.exists ?? false,
          has_runtime_verification_artifact: runtimeVerificationArtifact !== null,
          runtime_verification_artifact_exists: runtimeVerificationArtifact?.exists ?? false,
          runtime_verification_status: reviewPacket?.runtime_verification?.status ?? null,
          runtime_verification_failure_code:
            reviewPacket?.runtime_verification?.failure_code ?? null,
          runtime_verification_preexisting_git_status:
            reviewPacket?.runtime_verification?.preexisting_git_status ?? [],
          runtime_verification_new_git_status:
            reviewPacket?.runtime_verification?.new_git_status ?? [],
          runtime_verification_changed_files:
            reviewPacket?.runtime_verification?.changed_files ?? [],
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
      executionPacket.runtime_verification_preexisting_git_status.includes(" M README.md"),
      `${scenario.id}: runtime verification should keep the preexisting dirty baseline`
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
      executionPacket.runtime_verification_preexisting_git_status.includes(" M README.md"),
      `${scenario.id}: runtime verification should keep the dirty baseline`
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
