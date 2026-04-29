import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAttemptContract,
  createAttempt,
  createAttachedProjectProfile,
  createDefaultRunHarnessProfile,
  createRunSteer,
  createCurrentDecision,
  createRun,
  createRunJournalEntry,
  updateRun,
  updateCurrentDecision,
  updateAttempt,
  updateRunPolicyRuntime,
  AttemptHandoffBundleSchema,
  WorkerWritebackSchema,
  type Attempt,
  type Run,
  type WorkerWriteback
} from "../packages/domain/src/index.js";
import {
  assessExecutionVerificationToolchain,
  Orchestrator
} from "../packages/orchestrator/src/index.js";
import { ensureRunManagedWorkspace } from "../packages/orchestrator/src/run-workspace.js";
import { createDefaultRunWorkspaceScopePolicy } from "../packages/orchestrator/src/workspace-scope.js";
import {
  buildCodexCliExecutionEffortConfigOverride,
  CODEX_CLI_EXECUTION_EFFORT_APPLIED_DETAIL,
  CodexCliWorkerAdapter,
  resolveCodexCliWorkerEffort,
  type AdversarialVerifierAdapter
} from "../packages/worker-adapters/src/index.js";
import { synthesizeAttemptEvaluation } from "../packages/judge/src/index.js";
import {
  appendRunJournal,
  ensureWorkspace,
  getAttemptHeartbeat,
  getAttemptContext,
  getAttemptEvaluation,
  getAttemptHandoffBundle,
  getAttemptAdversarialVerification,
  getAttemptEvaluationSynthesisRecord,
  getAttemptPreflightEvaluation,
  getAttemptReviewInputPacket,
  getAttemptReviewPacket,
  getAttemptRuntimeVerification,
  getCurrentDecision,
  getRun,
  getRunMailbox,
  getRunPolicyRuntime,
  listAttempts,
  listAttemptReviewOpinions,
  listRunJournal,
  resolveAttemptPaths,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptContract,
  saveAttachedProjectProfile,
  saveAttemptEvaluation,
  saveAttemptResult,
  saveAttemptRuntimeVerification,
  saveCurrentDecision,
  saveRun,
  saveRunPolicyRuntime,
  saveRunRuntimeHealthSnapshot,
  saveRunSteer
} from "../packages/state-store/src/index.js";

const REVIEWER_CONFIG_ENV = "AISA_REVIEWERS_JSON";
const SYNTHESIZER_CONFIG_ENV = "AISA_REVIEW_SYNTHESIZER_JSON";
const CLI_FIXTURE_TIMEOUT_MS = 15_000;
const VERIFY_RUN_LOOP_FILTER_ENV = "AISA_VERIFY_RUN_LOOP_FILTER";
const VERIFY_TEMP_ROOT_ENV = "AISA_VERIFY_TEMP_ROOT";
const VERIFY_KEEP_TEMP_ENV = "AISA_VERIFY_KEEP_TMP";
const CLI_REVIEWER_FAILURE_TIMEOUT_MS = 1_000;
const CLI_REVIEWER_RESPONSE_TIMEOUT_MS = 5_000;
const CLI_SYNTHESIZER_FAILURE_TIMEOUT_MS = 5_000;
const trackedVerifyTempDirs: string[] = [];
let verifyManagedWorkspaceRoot: string | null = null;

function shouldKeepVerifyTempDirs(): boolean {
  return process.env[VERIFY_KEEP_TEMP_ENV] === "1";
}

function getRequestedSmokeCaseFilter(): string | null {
  const raw = process.env[VERIFY_RUN_LOOP_FILTER_ENV]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

async function createVerifyTempDir(prefix: string): Promise<string> {
  const configuredRoot = process.env[VERIFY_TEMP_ROOT_ENV]?.trim();
  if (configuredRoot) {
    await mkdir(configuredRoot, { recursive: true });
  }
  const rootDir = await mkdtemp(join(configuredRoot || tmpdir(), prefix));
  if (!process.env.AISA_MANAGED_WORKSPACE_ROOT) {
    if (!verifyManagedWorkspaceRoot) {
      verifyManagedWorkspaceRoot = resolve(
        rootDir,
        "..",
        `.aisa-run-worktrees-${process.pid}`
      );
      await mkdir(verifyManagedWorkspaceRoot, { recursive: true });
      trackedVerifyTempDirs.push(verifyManagedWorkspaceRoot);
    }
    process.env.AISA_MANAGED_WORKSPACE_ROOT = verifyManagedWorkspaceRoot;
  }
  trackedVerifyTempDirs.push(rootDir);
  return rootDir;
}

async function cleanupTrackedVerifyTempDirs(): Promise<void> {
  if (shouldKeepVerifyTempDirs()) {
    return;
  }

  while (trackedVerifyTempDirs.length > 0) {
    const rootDir = trackedVerifyTempDirs.pop();
    if (!rootDir) {
      continue;
    }
    await rm(rootDir, {
      recursive: true,
      force: true,
      maxRetries: 3
    });
  }
}

type CliReviewerFailureMode = "invalid_json" | "nonzero_exit" | "timeout";
type CliSynthesizerFailureMode = "invalid_json" | "nonzero_exit";

type ScenarioDriver =
  | "happy_path"
  | "running_attempt_owned_elsewhere"
  | "research_stall"
  | "research_command_failure"
  | "attached_project_pack_default_contract"
  | "execution_verified_next_step_continues"
  | "execution_runtime_source_drift_requires_restart"
  | "execution_checkpoint_blocked_dirty_workspace"
  | "execution_dirty_workspace_without_new_changes_fails_verification"
  | "execution_missing_verification_plan"
  | "execution_missing_local_toolchain_blocks_dispatch"
  | "execution_workspace_not_git_repo_blocks_dispatch"
  | "execution_missing_verification_cwd_blocks_dispatch"
  | "execution_blocked_pnpm_verification_plan_blocks_dispatch"
  | "execution_unrunnable_verification_command_blocks_dispatch"
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
    attempt_type: string;
    attempt_status: string;
    attempt_started_at: string | null;
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
    snapshot_recommended_next_action: string | null;
    snapshot_blocking_reason: string | null;
    journal_count: number;
    has_failure_context: boolean;
    failure_message: string | null;
    has_result: boolean;
    has_evaluation: boolean;
    has_runtime_verification: boolean;
    has_adversarial_verification: boolean;
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
    has_adversarial_verification_artifact: boolean;
    adversarial_verification_artifact_exists: boolean;
    expected_input_context_ref: string;
    meta_input_context_ref: string | null;
    review_packet_attempt_input_context_ref: string | null;
    input_context_ref_matches_expected: boolean;
    runtime_verification_status: string | null;
    runtime_verification_failure_code: string | null;
    adversarial_verification_status: string | null;
    adversarial_verification_verdict: string | null;
    adversarial_verification_failure_code: string | null;
    evaluation_adversarial_verification_status: string | null;
    runtime_verification_preexisting_git_status: string[];
    runtime_verification_new_git_status: string[];
    runtime_verification_changed_files: string[];
    attempt_contract_stack_pack_id: string | null;
    attempt_contract_task_preset_id: string | null;
    attempt_contract_verifier_kit: string | null;
    attempt_contract_done_rubric_codes: string[];
    attempt_contract_failure_mode_codes: string[];
    attempt_contract_adversarial_verification_required: boolean;
    attempt_contract_has_verification_plan: boolean;
    attempt_contract_verification_commands: string[];
    has_preflight_artifact: boolean;
    preflight_artifact_exists: boolean;
    has_preflight_evaluation: boolean;
    preflight_evaluation_status: string | null;
    preflight_evaluation_failure_code: string | null;
    preflight_evaluation_failure_reason: string | null;
    handoff_bundle_path: string;
    has_handoff_bundle: boolean;
    handoff_bundle_matches_schema: boolean;
    handoff_bundle_schema_error: string | null;
    handoff_bundle_matches_attempt: boolean;
    handoff_bundle_has_contract: boolean;
    handoff_bundle_has_runtime_verification: boolean;
    handoff_bundle_has_adversarial_verification: boolean;
    handoff_bundle_failure_code: string | null;
    handoff_bundle_adversarial_failure_code: string | null;
    handoff_bundle_recommended_next_action: string | null;
    handoff_bundle_source_refs: {
      run_contract: string | null;
      attempt_meta: string | null;
      attempt_contract: string | null;
      current_decision: string | null;
      review_packet: string | null;
      runtime_verification: string | null;
      adversarial_verification: string | null;
    } | null;
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
  "adversarial_verification",
  "artifact_manifest",
  "generated_at"
] as const;

async function writeAdversarialVerificationFixture(
  workspaceRoot: string,
  attemptId: string,
  input: {
    summary?: string;
    checkCode?: string;
    checkMessage?: string;
    commandPurpose?: string;
    command?: string;
  } = {}
): Promise<void> {
  const adversarialDir = join(workspaceRoot, "artifacts", "adversarial");
  await mkdir(adversarialDir, { recursive: true });
  const outputRef = join(adversarialDir, `${attemptId}.txt`);
  await writeFile(outputRef, `adversarial probe passed for ${attemptId}\n`, "utf8");
  await writeFile(
    join(workspaceRoot, "artifacts", "adversarial-verification.json"),
    JSON.stringify(
      {
        summary:
          input.summary ??
          "Adversarial verification passed after deterministic replay.",
        verdict: "pass",
        checks: [
          {
            code: input.checkCode ?? "non_happy_path",
            status: "passed",
            message:
              input.checkMessage ?? "A non-happy-path probe stayed green."
          }
        ],
        commands: [
          {
            purpose: input.commandPurpose ?? "probe repeated execution output",
            command:
              input.command ??
              `test -f execution-change.md && rg -n "^execution change from ${attemptId}$" execution-change.md`,
            exit_code: 0,
            status: "passed",
            output_ref: "artifacts/adversarial/" + `${attemptId}.txt`
          }
        ],
        output_refs: ["artifacts/adversarial/" + `${attemptId}.txt`]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

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

async function validatePersistedHandoffBundle(input: {
  handoffBundleFile: string;
}): Promise<{
  matchesSchema: boolean;
  schemaError: string | null;
}> {
  try {
    const rawHandoffBundle = await readFile(input.handoffBundleFile, "utf8");
    const parsed = JSON.parse(rawHandoffBundle) as unknown;
    const validation = AttemptHandoffBundleSchema.safeParse(parsed);

    if (validation.success) {
      return {
        matchesSchema: true,
        schemaError: null
      };
    }

    return {
      matchesSchema: false,
      schemaError: validation.error.issues
        .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
        .join("; ")
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

    if (
      [
        "execution_workspace_not_git_repo_blocks_dispatch",
        "execution_missing_verification_cwd_blocks_dispatch",
        "execution_blocked_pnpm_verification_plan_blocks_dispatch",
        "execution_unrunnable_verification_command_blocks_dispatch"
      ].includes(this.driver) &&
      input.attempt.attempt_type === "execution"
    ) {
      throw new Error("Shadow dispatch case must be blocked before worker dispatch.");
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
        "attached_project_pack_default_contract",
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
      await writeAdversarialVerificationFixture(
        input.attempt.workspace_root,
        input.attempt.id
      );
    }

    const writeback =
      this.driver === "happy_path" ||
      this.driver === "attached_project_pack_default_contract" ||
      this.driver === "running_attempt_owned_elsewhere" ||
      this.driver === "execution_verified_next_step_continues" ||
      this.driver === "execution_runtime_source_drift_requires_restart" ||
      this.driver === "execution_parse_failure" ||
      this.driver === "execution_checkpoint_blocked_dirty_workspace" ||
      this.driver === "execution_dirty_workspace_without_new_changes_fails_verification" ||
      this.driver === "execution_missing_verification_plan" ||
      this.driver === "execution_missing_local_toolchain_blocks_dispatch" ||
      this.driver === "execution_workspace_not_git_repo_blocks_dispatch" ||
      this.driver === "execution_missing_verification_cwd_blocks_dispatch" ||
      this.driver === "execution_blocked_pnpm_verification_plan_blocks_dispatch" ||
      this.driver === "execution_unrunnable_verification_command_blocks_dispatch" ||
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
          : this.driver === "execution_blocked_pnpm_verification_plan_blocks_dispatch"
            ? {
                commands: [
                  {
                    purpose: "typecheck the workspace before dispatch",
                    command: "pnpm typecheck"
                  },
                  {
                    purpose: "replay the runtime regression suite before dispatch",
                    command: "pnpm verify:runtime"
                  }
                ]
              }
          : this.driver === "execution_missing_verification_cwd_blocks_dispatch"
            ? {
                commands: [
                  {
                    purpose: "probe a missing verification cwd before dispatch",
                    command: this.buildExecutionVerificationCommand(),
                    cwd: "missing-preflight-cwd"
                  }
                ]
              }
            : this.driver === "execution_unrunnable_verification_command_blocks_dispatch"
              ? {
                  commands: [
                    {
                      purpose: "probe a missing verifier binary before dispatch",
                      command: "shadow-dispatch-missing-binary --version"
                    }
                  ]
                }
          : {
              commands: [
                {
                  purpose: "confirm the execution change was written",
                  command: this.buildExecutionVerificationCommand()
                }
              ]
            };
      if (this.driver === "attached_project_pack_default_contract") {
        return {
          summary: "Attached project defaults are enough to start execution.",
          findings: [
            {
              type: "fact",
              content: "The attached project profile already provides replayable repo commands.",
              evidence: ["package.json", "scripts/test-ok.mjs", "scripts/build-ok.mjs"]
            }
          ],
          questions: [],
          recommended_next_steps: [
            "Use the attached project bugfix defaults instead of inventing a fresh execution contract."
          ],
          confidence: 0.84,
          artifacts: []
        };
      }
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
          adversarial_verification_required: true,
          done_rubric: [
            {
              code: "git_change_recorded",
              description: "Leave a git-visible workspace change."
            },
            {
              code: "verification_replay_passed",
              description: "Pass the locked replay command."
            },
            {
              code: "adversarial_verification_passed",
              description: "Pass the clean postflight adversarial verifier."
            }
          ],
          failure_modes: [
            {
              code: "missing_replayable_verification_plan",
              description: "Do not dispatch without replayable verification."
            },
            {
              code: "missing_local_verifier_toolchain",
              description: "Do not dispatch pnpm replay without local node_modules."
            },
            {
              code: "missing_adversarial_verification_artifact",
              description: "Do not treat execution as complete before clean postflight verification."
            }
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
      if (passNumber === 2) {
        return {
          summary: "Patched a runtime-like source file and queued one more concrete execution step.",
          findings: [
            {
              type: "fact",
              content: "Updated the runtime-like source path in the project workspace",
              evidence: ["packages/orchestrator/src/index.ts"]
            }
          ],
          questions: [],
          recommended_next_steps: ["Continue with the follow-up execution step."],
          confidence: 0.86,
          artifacts: [
            { type: "patch", path: "artifacts/diff.patch" },
            { type: "test_result", path: "artifacts/adversarial-verification.json" }
          ]
        };
      }

      return {
        summary: "Patched the runtime-like source file and left verification artifacts.",
        findings: [
          {
            type: "fact",
            content: "Updated the runtime-like source path in the project workspace",
            evidence: ["packages/orchestrator/src/index.ts"]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.86,
        verification_plan: {
          commands: [
            {
              purpose: "confirm the runtime-like source change was written",
              command: this.buildExecutionVerificationCommand(attempt.id)
            }
          ]
        },
        artifacts: [
          { type: "patch", path: "artifacts/diff.patch" },
          { type: "test_result", path: "artifacts/adversarial-verification.json" }
        ]
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
        artifacts: [
          { type: "patch", path: "artifacts/diff.patch" },
          { type: "test_result", path: "artifacts/adversarial-verification.json" }
        ]
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
      artifacts: [
        { type: "patch", path: "artifacts/diff.patch" },
        { type: "test_result", path: "artifacts/adversarial-verification.json" }
      ]
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
  readonly capturedCalls: Array<{
    attempt_id: string;
    attempt_type: Attempt["attempt_type"];
    context: unknown;
    worker_effort: unknown;
  }> = [];

  async runAttemptTask(input: {
    attempt: Attempt;
    context?: unknown;
    worker_effort?: unknown;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    this.capturedCalls.push({
      attempt_id: input.attempt.id,
      attempt_type: input.attempt.attempt_type,
      context: input.context ?? null,
      worker_effort: input.worker_effort ?? null
    });

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

class BlockingAdapter {
  readonly type = "fake-codex";
  readonly startedAttemptIds: string[] = [];
  private releaseResolver: (() => void) | null = null;
  private readonly releasePromise = new Promise<void>((resolve) => {
    this.releaseResolver = resolve;
  });

  release(): void {
    this.releaseResolver?.();
    this.releaseResolver = null;
  }

  async runAttemptTask(input: {
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    this.startedAttemptIds.push(input.attempt.id);
    await this.releasePromise;

    return {
      writeback: {
        summary: `Released blocked attempt ${input.attempt.id}.`,
        findings: [],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.5,
        artifacts: []
      },
      reportMarkdown: "# blocking adapter",
      exitCode: 0
    };
  }
}

class VerifierKitFixtureAdapter {
  readonly type = "fake-codex";

  constructor(
    private readonly input: {
      changedFileName: string;
      workerArtifacts: WorkerWriteback["artifacts"];
      adversarial: {
        summary: string;
        checkCode: string;
        checkMessage: string;
        commandPurpose: string;
      };
    }
  ) {}

  async runAttemptTask(input: {
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    await writeFile(
      join(input.attempt.workspace_root, this.input.changedFileName),
      `execution change from ${input.attempt.id}\n`,
      "utf8"
    );
    await writeAdversarialVerificationFixture(input.attempt.workspace_root, input.attempt.id, {
      summary: this.input.adversarial.summary,
      checkCode: this.input.adversarial.checkCode,
      checkMessage: this.input.adversarial.checkMessage,
      commandPurpose: this.input.adversarial.commandPurpose
    });

    return {
      writeback: {
        summary: "Executed the verifier-kit fixture.",
        findings: [
          {
            type: "fact",
            content: "Left a deterministic execution change.",
            evidence: [this.input.changedFileName]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.91,
        artifacts: this.input.workerArtifacts
      },
      reportMarkdown: "# verifier kit fixture",
      exitCode: 0
    };
  }
}

class CleanPostflightVerifierFixture implements AdversarialVerifierAdapter {
  readonly type = "fixture-clean-adversarial-verifier";

  async runAttemptAdversarialVerification(
    input: Parameters<AdversarialVerifierAdapter["runAttemptAdversarialVerification"]>[0]
  ): Promise<
    Awaited<ReturnType<AdversarialVerifierAdapter["runAttemptAdversarialVerification"]>>
  > {
    const verifierDir = join(input.attemptPaths.artifactsDir, "clean-postflight-fixture");
    await mkdir(verifierDir, { recursive: true });
    const stdoutFile = join(verifierDir, "stdout.log");
    const stderrFile = join(verifierDir, "stderr.log");
    const promptFile = join(verifierDir, "prompt.md");
    const rawOutputFile = join(verifierDir, "output.json");
    const sourceArtifactPath = join(verifierDir, "artifact.json");
    await Promise.all([
      writeFile(stdoutFile, `clean verifier checked ${input.attempt.id}\n`, "utf8"),
      writeFile(stderrFile, "", "utf8"),
      writeFile(promptFile, "fixture clean postflight verifier\n", "utf8")
    ]);
    const artifact = {
      target_surface: input.attemptContract.verifier_kit ?? "repo",
      summary: "Clean postflight verifier passed without using execution worker self-certification.",
      verdict: "pass",
      checks: [
        {
          code: "clean_context_probe",
          status: "passed",
          message: "The verifier used its own clean postflight artifact."
        }
      ],
      commands: [
        {
          purpose: "probe repo replay output from a clean verifier context",
          command: "test -n clean-postflight-verifier",
          cwd: input.attempt.workspace_root,
          exit_code: 0,
          status: "passed",
          output_ref: stdoutFile
        }
      ],
      output_refs: [stdoutFile]
    };
    await Promise.all([
      writeFile(sourceArtifactPath, JSON.stringify(artifact, null, 2) + "\n", "utf8"),
      writeFile(rawOutputFile, JSON.stringify(artifact, null, 2) + "\n", "utf8")
    ]);

    return {
      artifact,
      sourceArtifactPath,
      promptFile,
      rawOutputFile,
      stdoutFile,
      stderrFile
    };
  }
}

class NoSelfAdversarialExecutionFixtureAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: { attempt: Attempt }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    await writeFile(
      join(input.attempt.workspace_root, "repo-change.md"),
      `execution change from ${input.attempt.id}\n`,
      "utf8"
    );

    return {
      writeback: {
        summary: "Executed the change without self-certifying adversarial verification.",
        findings: [
          {
            type: "fact",
            content: "Left the deterministic execution change.",
            evidence: ["repo-change.md"]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.9,
        artifacts: [{ type: "patch", path: "artifacts/diff.patch" }]
      },
      reportMarkdown: "# no self adversarial",
      exitCode: 0
    };
  }
}

async function createCodexArgCaptureScript(input: {
  rootDir: string;
  fileName: string;
  argsFileName: string;
  jsonPayload: string;
}): Promise<{ scriptPath: string; argsPath: string }> {
  const scriptPath = join(input.rootDir, input.fileName);
  const argsPath = join(input.rootDir, input.argsFileName);
  const lines = [
    "#!/bin/sh",
    `ARGS_PATH=${JSON.stringify(argsPath)}`,
    ": > \"$ARGS_PATH\"",
    "for arg in \"$@\"; do",
    "  printf '%s\\n' \"$arg\" >> \"$ARGS_PATH\"",
    "done",
    "OUTPUT=\"\"",
    "SAW_JSON=0",
    "while [ \"$#\" -gt 0 ]; do",
    "  if [ \"$1\" = \"--json\" ]; then",
    "    SAW_JSON=1",
    "    shift",
    "    continue",
    "  fi",
    "  if [ \"$1\" = \"--output-last-message\" ]; then",
    "    OUTPUT=\"$2\"",
    "    shift 2",
    "    continue",
    "  fi",
    "  shift",
    "done",
    "cat >/dev/null",
    "if [ \"$SAW_JSON\" -ne 1 ]; then",
    "  echo \"missing --json\" >&2",
    "  exit 3",
    "fi",
    "if [ -z \"$OUTPUT\" ]; then",
    "  echo \"missing --output-last-message\" >&2",
    "  exit 2",
    "fi",
    "cat <<'EOF' > \"$OUTPUT\"",
    input.jsonPayload,
    "EOF",
    "exit 0"
  ];
  await writeFile(scriptPath, lines.join("\n"), "utf8");
  await chmod(scriptPath, 0o755);
  return {
    scriptPath,
    argsPath
  };
}

async function settle(input: {
  orchestrator: Orchestrator;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  runId: string;
  iterations: number;
  autoApprovePendingExecution?: boolean;
}): Promise<void> {
  for (let index = 0; index < input.iterations; index += 1) {
    await input.orchestrator.tick();
    await sleep(50);
    await waitForRunningAttemptsToSettle(input.workspacePaths, input.runId);
    if (
      input.autoApprovePendingExecution &&
      (await maybeApprovePendingExecutionPolicy({
        workspacePaths: input.workspacePaths,
        runId: input.runId
      }))
    ) {
      await sleep(50);
      continue;
    }
    if (await isRunQuiescent(input.workspacePaths, input.runId)) {
      return;
    }
    await sleep(50);
  }
}

function shouldAutoApprovePendingExecution(driver: ScenarioDriver): boolean {
  const autoApprovedDrivers = new Set<ScenarioDriver>([
    "happy_path",
    "attached_project_pack_default_contract",
    "execution_verified_next_step_continues",
    "execution_runtime_source_drift_requires_restart",
    "execution_checkpoint_blocked_dirty_workspace",
    "execution_dirty_workspace_without_new_changes_fails_verification",
    "execution_missing_verification_plan",
    "execution_missing_local_toolchain_blocks_dispatch",
    "execution_workspace_not_git_repo_blocks_dispatch",
    "execution_missing_verification_cwd_blocks_dispatch",
    "execution_blocked_pnpm_verification_plan_blocks_dispatch",
    "execution_unrunnable_verification_command_blocks_dispatch",
    "execution_parse_failure",
    "execution_retry_after_recovery_preserves_contract"
  ]);
  return autoApprovedDrivers.has(driver);
}

async function maybeApprovePendingExecutionPolicy(input: {
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  runId: string;
}): Promise<boolean> {
  const [current, policyRuntime] = await Promise.all([
    getCurrentDecision(input.workspacePaths, input.runId),
    getRunPolicyRuntime(input.workspacePaths, input.runId)
  ]);

  if (!current || !policyRuntime) {
    return false;
  }

  if (
    policyRuntime.approval_required !== true ||
    policyRuntime.approval_status !== "pending" ||
    policyRuntime.proposed_attempt_type !== "execution"
  ) {
    return false;
  }

  const approvedPolicy = updateRunPolicyRuntime(policyRuntime, {
    stage: "execution",
    approval_status: "approved",
    blocking_reason: null,
    last_decision: "approved",
    approval_decided_at: new Date().toISOString(),
    approval_actor: "verify-run-loop",
    approval_note:
      "Auto-approved by the smoke harness so execution downstream assertions can run."
  });
  const resumedCurrent = updateCurrentDecision(current, {
    run_status: "running",
    waiting_for_human: false,
    blocking_reason: null,
    recommended_next_action: "continue_execution",
    recommended_attempt_type: "execution",
    summary:
      "Execution plan approved by the smoke harness so downstream execution assertions can continue."
  });

  await Promise.all([
    saveRunPolicyRuntime(input.workspacePaths, approvedPolicy),
    saveCurrentDecision(input.workspacePaths, resumedCurrent)
  ]);
  await appendRunJournal(
    input.workspacePaths,
    createRunJournalEntry({
      run_id: input.runId,
      attempt_id: approvedPolicy.source_attempt_id,
      type: "run.policy.approved",
      payload: {
        actor: approvedPolicy.approval_actor,
        note: approvedPolicy.approval_note,
        proposed_signature: approvedPolicy.proposed_signature
      }
    })
  );

  return true;
}

async function waitForRunningAttemptsToSettle(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string,
  timeoutMs = 1_500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const attempts = await listAttempts(workspacePaths, runId);
    const hasRunningAttempt = attempts.some((attempt) => attempt.status === "running");
    const hasActiveHeartbeat = await hasActiveAttemptHeartbeats(
      workspacePaths,
      runId,
      attempts
    );
    if (!hasRunningAttempt && !hasActiveHeartbeat) {
      return;
    }
    await sleep(50);
  }
}

async function waitForRunCondition(input: {
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  runId: string;
  predicate: (snapshot: {
    current: Awaited<ReturnType<typeof getCurrentDecision>>;
    attempts: Awaited<ReturnType<typeof listAttempts>>;
  }) => boolean;
  timeoutMs?: number;
  failureMessage: string;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? 3_000);

  while (Date.now() < deadline) {
    const [current, attempts] = await Promise.all([
      getCurrentDecision(input.workspacePaths, input.runId),
      listAttempts(input.workspacePaths, input.runId)
    ]);

    if (
      input.predicate({
        current,
        attempts
      })
    ) {
      return;
    }

    await sleep(50);
  }

  throw new Error(input.failureMessage);
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

  if (await hasActiveAttemptHeartbeats(workspacePaths, runId, attempts)) {
    return false;
  }

  return current.run_status !== "running";
}

async function waitForAttemptActivityToDrain(input: {
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  runId: string;
  failureMessage: string;
  timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? 10_000);

  while (Date.now() < deadline) {
    const attempts = await listAttempts(input.workspacePaths, input.runId);
    const hasActiveAttempt = attempts.some((attempt) =>
      ["created", "queued", "running"].includes(attempt.status)
    );
    const hasActiveHeartbeat = await hasActiveAttemptHeartbeats(
      input.workspacePaths,
      input.runId,
      attempts
    );
    if (!hasActiveAttempt && !hasActiveHeartbeat) {
      return;
    }
    await sleep(50);
  }

  throw new Error(input.failureMessage);
}

async function hasActiveAttemptHeartbeats(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string,
  attempts: Awaited<ReturnType<typeof listAttempts>>
): Promise<boolean> {
  const heartbeats = await Promise.all(
    attempts.map((attempt) => getAttemptHeartbeat(workspacePaths, runId, attempt.id))
  );

  return heartbeats.some((heartbeat) => heartbeat?.status === "active");
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

async function seedCreatedExecutionAttempt(input: {
  run: Run;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  verifierKit: "repo" | "web" | "api" | "cli";
}): Promise<Attempt> {
  const attempt = createAttempt({
    run_id: input.run.id,
    attempt_type: "execution",
    worker: "fake-codex",
    objective: `Exercise ${input.verifierKit} verifier-kit execution behavior.`,
    success_criteria: ["Leave a verified execution step in the workspace."],
    workspace_root: input.run.workspace_root
  });
  const changedFileName =
    input.verifierKit === "web"
      ? "web-change.md"
      : input.verifierKit === "api"
        ? "api-change.md"
        : input.verifierKit === "cli"
          ? "cli-change.md"
          : "repo-change.md";
  await saveAttempt(input.workspacePaths, attempt);
  await saveAttemptContract(
    input.workspacePaths,
    createAttemptContract({
      attempt_id: attempt.id,
      run_id: input.run.id,
      attempt_type: "execution",
      objective: attempt.objective,
      success_criteria: attempt.success_criteria,
      required_evidence: ["Leave replayable execution evidence."],
      verifier_kit: input.verifierKit,
      verification_plan: {
        commands: [
          {
            purpose: "confirm the verifier-kit change was written",
            command: `test -f ${changedFileName} && rg -n "^execution change from ${attempt.id}$" ${changedFileName}`
          }
        ]
      }
    })
  );
  await saveCurrentDecision(
    input.workspacePaths,
    updateCurrentDecision(
      (await getCurrentDecision(input.workspacePaths, input.run.id)) ??
        createCurrentDecision({
          run_id: input.run.id,
          run_status: "running"
        }),
      {
        run_status: "running",
        latest_attempt_id: attempt.id,
        recommended_next_action: "continue_execution",
        recommended_attempt_type: "execution",
        summary: `Prepared ${input.verifierKit} verifier-kit execution attempt.`,
        waiting_for_human: false,
        blocking_reason: null
      }
    )
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

  return attempt;
}

async function runVerifierKitFixtureCase(input: {
  verifierKit: "repo" | "web" | "api" | "cli";
  workerArtifacts: WorkerWriteback["artifacts"];
  adversarial: {
    summary: string;
    checkCode: string;
    checkMessage: string;
    commandPurpose: string;
  };
}): Promise<{
  run: Run;
  attempt: Attempt;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
}> {
  const rootDir = await createVerifyTempDir(`aisa-verifier-kit-${input.verifierKit}-`);
  const bootstrapped = await bootstrapRun(rootDir, `verifier-kit-${input.verifierKit}`);
  const run = updateRun(bootstrapped.run, {
    harness_profile: {
      execution: {
        default_verifier_kit: input.verifierKit
      }
    }
  });
  await saveRun(bootstrapped.workspacePaths, run);
  await initializeGitRepo(rootDir, false);
  const attempt = await seedCreatedExecutionAttempt({
    run,
    workspacePaths: bootstrapped.workspacePaths,
    verifierKit: input.verifierKit
  });
  const orchestrator = new Orchestrator(
    bootstrapped.workspacePaths,
    new VerifierKitFixtureAdapter({
      changedFileName:
        input.verifierKit === "web"
          ? "web-change.md"
          : input.verifierKit === "api"
            ? "api-change.md"
            : input.verifierKit === "cli"
              ? "cli-change.md"
              : "repo-change.md",
      workerArtifacts: input.workerArtifacts,
      adversarial: input.adversarial
    }) as never,
    undefined,
    60_000
  );
  await orchestrator.tick();
  await waitForAttemptActivityToDrain({
    workspacePaths: bootstrapped.workspacePaths,
    runId: run.id,
    failureMessage: `verifier-kit ${input.verifierKit}: attempt activity did not settle`
  });

  return {
    run,
    attempt,
    workspacePaths: bootstrapped.workspacePaths
  };
}

async function assertRuntimeHealthSnapshotContextWiring(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-runtime-health-context-");
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
  const rootDir = await createVerifyTempDir("aisa-missing-runtime-health-context-");
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

async function assertExecutionHarnessEffortFlowsToDispatchContext(): Promise<void> {
  const defaultProfile = createDefaultRunHarnessProfile();
  assert.equal(
    defaultProfile.execution.effort,
    "high",
    "execution_harness_effort_context: default execution effort should be high"
  );

  const rootDir = await createVerifyTempDir("aisa-execution-effort-context-");
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);
  await initializeGitRepo(rootDir, false);

  const run = createRun({
    title: "execution-effort-context",
    description: "Verify execution effort is read from the run harness profile.",
    success_criteria: ["Expose execution effort in dispatch context."],
    constraints: [],
    owner_id: "test",
    workspace_root: rootDir,
    harness_profile: {
      execution: {
        effort: "high"
      }
    }
  });
  await saveRun(workspacePaths, run);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "running",
      recommended_next_action: "continue_execution",
      recommended_attempt_type: "execution",
      summary: "Bootstrapped for execution effort verification."
    })
  );
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

  const attempt = createAttempt({
    run_id: run.id,
    attempt_type: "execution",
    worker: "fake-codex",
    objective: "Verify execution effort wiring.",
    success_criteria: run.success_criteria,
    workspace_root: rootDir
  });
  await saveAttempt(workspacePaths, attempt);
  await saveAttemptContract(
    workspacePaths,
    createAttemptContract({
      attempt_id: attempt.id,
      run_id: run.id,
      attempt_type: attempt.attempt_type,
      objective: attempt.objective,
      success_criteria: attempt.success_criteria,
      required_evidence: ["Expose execution effort in context and adapter input."],
      expected_artifacts: ["runs/<run_id>/attempts/<attempt_id>/context.json"],
      verification_plan: {
        commands: [
          {
            purpose: "prove the test fixture reached runtime verification",
            command: "test -n execution-effort-context"
          }
        ]
      }
    })
  );
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "running",
      latest_attempt_id: attempt.id,
      recommended_next_action: "continue_execution",
      recommended_attempt_type: "execution",
      summary: "Prepared a pending execution attempt for effort verification."
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      attempt_id: attempt.id,
      type: "attempt.created",
      payload: {
        attempt_type: attempt.attempt_type,
        objective: attempt.objective
      }
    })
  );

  const adapter = new ContextCaptureAdapter();
  const orchestrator = new Orchestrator(
    workspacePaths,
    adapter as never,
    undefined,
    60_000,
    {
      reviewerConfigs: [
        {
          kind: "heuristic",
          reviewer_id: "heuristic-reviewer",
          role: "runtime_reviewer"
        }
      ],
      synthesizerConfig: {
        kind: "deterministic"
      }
    }
  );
  await settle({
    orchestrator,
    workspacePaths,
    runId: run.id,
    iterations: 4
  });

  assert.equal(
    adapter.capturedCalls.length,
    1,
    "execution_harness_effort_context: adapter should see exactly one execution dispatch"
  );
  assert.equal(
    adapter.capturedCalls[0]?.attempt_type,
    "execution",
    "execution_harness_effort_context: captured dispatch should stay on execution"
  );
  assert.deepEqual(adapter.capturedCalls[0]?.worker_effort, {
    requested_effort: "high",
    default_effort: "high",
    source: "run.harness_profile.execution.effort",
    status: "applied",
    applied: true,
    detail: CODEX_CLI_EXECUTION_EFFORT_APPLIED_DETAIL
  });

  const context = (await getAttemptContext(
    workspacePaths,
    run.id,
    attempt.id
  )) as Record<string, unknown> | null;
  assert.ok(
    context && typeof context === "object",
    "execution_harness_effort_context: persisted context should exist"
  );
  assert.deepEqual(context?.worker_effort, {
    execution: {
      requested_effort: "high",
      default_effort: "high",
      source: "run.harness_profile.execution.effort",
      status: "applied",
      applied: true,
      detail: CODEX_CLI_EXECUTION_EFFORT_APPLIED_DETAIL
    },
    reviewer: {
      requested_effort: "medium",
      default_effort: "medium",
      source: "run.harness_profile.reviewer.effort",
      status: "unsupported",
      applied: false,
      detail: "当前 reviewer 入口不是独立 CLI 模型调用，effort 只会保留为配置记录。"
    },
    synthesizer: {
      requested_effort: "medium",
      default_effort: "medium",
      source: "run.harness_profile.synthesizer.effort",
      status: "unsupported",
      applied: false,
      detail: "当前 synthesizer 入口不是独立 CLI 模型调用，effort 只会保留为配置记录。"
    }
  });
}

async function assertExecutionEffortNativeConfigReachesCodexCli(): Promise<void> {
  const defaultWorkerEffort = resolveCodexCliWorkerEffort();
  assert.equal(
    defaultWorkerEffort.requested_effort,
    "high",
    "execution_effort_native_config: default Codex worker effort should be high"
  );
  assert.equal(
    defaultWorkerEffort.default_effort,
    "high",
    "execution_effort_native_config: default Codex worker effort label should be high"
  );

  const rootDir = await createVerifyTempDir("aisa-execution-effort-native-");
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);

  const run = createRun({
    title: "execution-effort-native-config",
    description: "Verify execution effort reaches Codex CLI as a native config override.",
    success_criteria: ["Pass the requested effort through the CLI config override."],
    constraints: [],
    owner_id: "test",
    workspace_root: rootDir,
    harness_profile: {
      execution: {
        effort: "high"
      }
    }
  });
  const attempt = createAttempt({
    run_id: run.id,
    attempt_type: "execution",
    worker: "codex",
    objective: "Verify native execution effort passthrough.",
    success_criteria: run.success_criteria,
    workspace_root: rootDir
  });
  const attemptContract = createAttemptContract({
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: attempt.attempt_type,
    objective: attempt.objective,
    success_criteria: attempt.success_criteria,
    required_evidence: ["Pass the requested effort through the CLI config override."],
    expected_artifacts: ["runs/<run_id>/attempts/<attempt_id>/task-spec.json"],
    verification_plan: {
      commands: [
        {
          purpose: "prove the native effort fixture reached the worker adapter",
          command: "test -n execution-effort-native-config"
        }
      ]
    }
  });

  const { scriptPath, argsPath } = await createCodexArgCaptureScript({
    rootDir,
    fileName: "fake-codex-native-effort.sh",
    argsFileName: "fake-codex-native-effort.args.txt",
    jsonPayload: JSON.stringify(
      {
        summary: "native effort 已透传。",
        findings: [
          {
            type: "fact",
            content: "execution 槽位已经附带原生 effort 配置。",
            evidence: ["runs/<run_id>/attempts/<attempt_id>/task-spec.json"]
          }
        ],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.9,
        artifacts: [
          {
            type: "patch",
            path: "runs/<run_id>/attempts/<attempt_id>/artifacts/diff.patch"
          }
        ]
      },
      null,
      2
    )
  });
  const adapter = new CodexCliWorkerAdapter({
    command: scriptPath,
    sandbox: "workspace-write",
    skipGitRepoCheck: true
  });
  const workerEffort = resolveCodexCliWorkerEffort({
    requestedEffort: "high"
  });

  const result = await adapter.runAttemptTask({
    run,
    attempt,
    attemptContract,
    context: {},
    worker_effort: workerEffort,
    workspacePaths
  });

  assert.equal(
    result.writeback.summary,
    "native effort 已透传。",
    "execution_effort_native_config: fake Codex run should complete"
  );

  const capturedArgs = (await readFile(argsPath, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  const configFlagIndex = capturedArgs.indexOf("-c");
  assert.notEqual(
    configFlagIndex,
    -1,
    "execution_effort_native_config: adapter should pass -c"
  );
  assert.equal(
    capturedArgs[configFlagIndex + 1],
    buildCodexCliExecutionEffortConfigOverride("high"),
    "execution_effort_native_config: adapter should use the confirmed native config key"
  );

  const taskSpec = JSON.parse(
    await readFile(
      resolveAttemptPaths(workspacePaths, run.id, attempt.id).taskSpecFile,
      "utf8"
    )
  ) as {
    worker_effort: {
      requested_effort: string;
      status: string;
      applied: boolean;
      detail: string;
    };
  };
  assert.equal(
    taskSpec.worker_effort.requested_effort,
    "high",
    "execution_effort_native_config: task spec should keep the requested effort"
  );
  assert.equal(
    taskSpec.worker_effort.status,
    "applied",
    "execution_effort_native_config: task spec should mark execution effort as applied"
  );
  assert.equal(
    taskSpec.worker_effort.applied,
    true,
    "execution_effort_native_config: task spec should mark execution effort as applied"
  );
  assert.equal(
    taskSpec.worker_effort.detail,
    CODEX_CLI_EXECUTION_EFFORT_APPLIED_DETAIL,
    "execution_effort_native_config: task spec should explain the native CLI passthrough"
  );
}

async function assertCliJudgeEffortSettingsStayVisibleWhenUnsupported(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-judge-effort-visibility-");
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);

  const run = createRun({
    title: "judge-effort-visibility",
    description: "Verify reviewer and synthesizer effort stays machine-readable.",
    success_criteria: ["Expose reviewer and synthesizer effort even when unsupported."],
    constraints: [],
    owner_id: "test",
    workspace_root: rootDir,
    harness_profile: {
      reviewer: {
        effort: "low"
      },
      synthesizer: {
        effort: "high"
      }
    }
  });
  const orchestrator = new Orchestrator(
    workspacePaths,
    new ContextCaptureAdapter() as never,
    undefined,
    60_000,
    {
      reviewerConfigs: [
        {
          kind: "cli",
          reviewer_id: "cli-reviewer",
          role: "runtime_reviewer",
          command: process.execPath,
          args: ["-e", "process.exit(0)"]
        }
      ],
      synthesizerConfig: {
        kind: "cli",
        synthesizer_id: "cli-synth",
        role: "runtime_synthesizer",
        command: process.execPath,
        args: ["-e", "process.exit(0)"]
      }
    }
  );
  const workerEffort = orchestrator.describeRunWorkerEffort(run);

  assert.equal(workerEffort.reviewer.requested_effort, "low");
  assert.equal(workerEffort.reviewer.status, "unsupported");
  assert.match(
    workerEffort.reviewer.detail,
    /reviewer CLI 入口/u,
    "judge_effort_visibility: reviewer detail should explain the unsupported CLI transport"
  );
  assert.equal(workerEffort.synthesizer.requested_effort, "high");
  assert.equal(workerEffort.synthesizer.status, "unsupported");
  assert.match(
    workerEffort.synthesizer.detail,
    /synthesizer CLI 入口/u,
    "judge_effort_visibility: synthesizer detail should explain the unsupported CLI transport"
  );
}

async function assertExplicitPnpmVerificationPlanNeedsLocalNodeModules(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-explicit-pnpm-toolchain-");
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

async function assertRunHarnessPolicyBundleDefaults(): Promise<void> {
  const defaultProfile = createDefaultRunHarnessProfile();
  assert.equal(defaultProfile.version, 3);
  assert.equal(defaultProfile.execution.default_verifier_kit, "repo");
  assert.equal(defaultProfile.gates.preflight_review.mode, "required");
  assert.equal(defaultProfile.gates.deterministic_runtime.mode, "required");
  assert.equal(defaultProfile.gates.postflight_adversarial.mode, "required");
  assert.equal(defaultProfile.slots.research_or_planning.binding, "research_worker");
  assert.equal(defaultProfile.slots.execution.binding, "execution_worker");
  assert.equal(
    defaultProfile.slots.preflight_review.binding,
    "attempt_dispatch_preflight"
  );
  assert.equal(
    defaultProfile.slots.postflight_review.binding,
    "attempt_adversarial_verification"
  );
  assert.equal(
    defaultProfile.slots.final_synthesis.binding,
    "attempt_evaluation_synthesizer"
  );

  const rootDir = await createVerifyTempDir("aisa-harness-policy-bundle-");
  const { run } = await bootstrapRun(rootDir, "harness-policy-bundle");
  const configuredRun = updateRun(run, {
    harness_profile: {
      execution: {
        effort: "high",
        default_verifier_kit: "web"
      }
    }
  });
  const orchestrator = new Orchestrator(
    resolveWorkspacePaths(rootDir),
    new ContextCaptureAdapter() as never,
    undefined,
    60_000
  );
  const slots = orchestrator.describeRunHarnessSlots(configuredRun);
  const gates = orchestrator.describeRunHarnessGates(configuredRun);
  const effectivePolicy = orchestrator.describeRunEffectivePolicyBundle(configuredRun);

  assert.equal(slots.research_or_planning.expected_binding, "research_worker");
  assert.equal(slots.research_or_planning.binding_status, "aligned");
  assert.equal(slots.research_or_planning.permission_boundary, "read_only");
  assert.deepEqual(slots.research_or_planning.output_artifacts, [
    "result.json",
    "attempt_contract.json when execution is recommended"
  ]);
  assert.equal(slots.research_or_planning.failure_semantics, "fail_open");
  assert.equal(slots.execution.default_verifier_kit, "web");
  assert.equal(slots.execution.binding, "execution_worker");
  assert.equal(slots.execution.expected_binding, "execution_worker");
  assert.equal(slots.execution.binding_status, "aligned");
  assert.equal(slots.execution.permission_boundary, "workspace_write");
  assert.deepEqual(slots.execution.output_artifacts, [
    "result.json",
    "worker-declared artifacts under artifacts/"
  ]);
  assert.equal(slots.execution.failure_semantics, "fail_closed");
  assert.equal(slots.preflight_review.permission_boundary, "read_only");
  assert.deepEqual(slots.preflight_review.output_artifacts, [
    "artifacts/preflight-evaluation.json"
  ]);
  assert.equal(slots.preflight_review.failure_semantics, "fail_closed");
  assert.equal(slots.postflight_review.binding, "attempt_adversarial_verification");
  assert.equal(slots.postflight_review.permission_boundary, "read_only");
  assert.deepEqual(slots.postflight_review.output_artifacts, [
    "artifacts/adversarial-verification.json"
  ]);
  assert.equal(slots.postflight_review.failure_semantics, "fail_closed");
  assert.equal(slots.final_synthesis.permission_boundary, "control_plane_only");
  assert.deepEqual(slots.final_synthesis.output_artifacts, [
    "evaluation.json",
    "review_opinions.ndjson",
    "artifacts/handoff_bundle.json"
  ]);
  assert.equal(slots.final_synthesis.failure_semantics, "fail_closed");
  assert.equal(gates.preflight_review.mode, "required");
  assert.equal(gates.preflight_review.enforced, true);
  assert.equal(gates.preflight_review.source, "run.harness_profile.gates.preflight_review.mode");
  assert.equal(gates.deterministic_runtime.mode, "required");
  assert.equal(gates.deterministic_runtime.enforced, true);
  assert.equal(
    gates.deterministic_runtime.source,
    "run.harness_profile.gates.deterministic_runtime.mode"
  );
  assert.equal(gates.postflight_adversarial.mode, "required");
  assert.equal(gates.postflight_adversarial.enforced, true);
  assert.equal(
    gates.postflight_adversarial.source,
    "run.harness_profile.gates.postflight_adversarial.mode"
  );
  assert.equal(
    effectivePolicy.verification_discipline.level,
    "deterministic_plus_adversarial"
  );
  assert.equal(effectivePolicy.verification_discipline.default_verifier_kit, "web");
  assert.equal(
    effectivePolicy.verification_discipline.command_policy,
    "contract_locked_commands"
  );
  assert.equal(effectivePolicy.operator_brief.intensity, "standard");
  assert.equal(effectivePolicy.operator_brief.evidence_ref_budget, 6);
  assert.equal(effectivePolicy.maintenance_refresh.strategy, "live_recompute");
  assert.equal(effectivePolicy.maintenance_refresh.refreshes_on_read, true);
  assert.equal(effectivePolicy.recovery.active_run, "working_context_first");
  assert.equal(effectivePolicy.recovery.settled_run, "handoff_first");
  assert.equal(effectivePolicy.recovery.auto_resume_from_settled_handoff, true);

  const lowReviewerRun = updateRun(run, {
    harness_profile: {
      reviewer: {
        effort: "low"
      },
      synthesizer: {
        effort: "high"
      }
    }
  });
  const lowReviewerPolicy = orchestrator.describeRunEffectivePolicyBundle(lowReviewerRun);
  assert.equal(lowReviewerPolicy.operator_brief.intensity, "expanded");
  assert.equal(lowReviewerPolicy.operator_brief.evidence_ref_budget, 8);
  assert.equal(
    lowReviewerPolicy.maintenance_refresh.strategy,
    "saved_boundary_snapshot"
  );
  assert.equal(lowReviewerPolicy.maintenance_refresh.refreshes_on_read, false);
  assert.equal(lowReviewerPolicy.recovery.settled_run, "manual_only");
  assert.equal(lowReviewerPolicy.recovery.auto_resume_from_settled_handoff, false);
  assert.equal(
    lowReviewerPolicy.recovery.source,
    "run.harness_profile.reviewer.effort"
  );
}

async function assertRunHarnessLegacyBindingAliasRemainsAligned(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-harness-slot-legacy-alias-");
  const { run } = await bootstrapRun(rootDir, "harness-slot-legacy-alias");
  const aliasedRun = updateRun(run, {
    harness_profile: {
      slots: {
        research_or_planning: {
          binding: "codex_cli_research_worker"
        },
        execution: {
          binding: "codex_cli_execution_worker"
        }
      }
    }
  });
  const orchestrator = new Orchestrator(
    resolveWorkspacePaths(rootDir),
    new ContextCaptureAdapter() as never,
    undefined,
    60_000
  );
  const slots = orchestrator.describeRunHarnessSlots(aliasedRun);

  assert.equal(slots.research_or_planning.binding, "codex_cli_research_worker");
  assert.equal(slots.research_or_planning.expected_binding, "research_worker");
  assert.equal(slots.research_or_planning.binding_status, "aligned");
  assert.equal(slots.research_or_planning.binding_matches_registry, true);
  assert.equal(slots.execution.binding, "codex_cli_execution_worker");
  assert.equal(slots.execution.expected_binding, "execution_worker");
  assert.equal(slots.execution.binding_status, "aligned");
  assert.equal(slots.execution.binding_matches_registry, true);
}

async function assertRunHarnessSlotBindingMismatchDetection(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-harness-slot-mismatch-");
  const { run } = await bootstrapRun(rootDir, "harness-slot-mismatch");
  const mismatchedRun = updateRun(run, {
    harness_profile: {
      execution: {
        effort: "high",
        default_verifier_kit: "cli"
      },
      slots: {
        execution: {
          binding: "attempt_dispatch_preflight"
        }
      }
    }
  });
  const orchestrator = new Orchestrator(
    resolveWorkspacePaths(rootDir),
    new ContextCaptureAdapter() as never,
    undefined,
    60_000
  );
  const slots = orchestrator.describeRunHarnessSlots(mismatchedRun);

  assert.equal(slots.execution.binding, "attempt_dispatch_preflight");
  assert.equal(slots.execution.expected_binding, "execution_worker");
  assert.equal(slots.execution.binding_status, "binding_mismatch");
  assert.equal(slots.execution.binding_matches_registry, false);
  assert.equal(slots.execution.permission_boundary, "workspace_write");
  assert.equal(slots.execution.failure_semantics, "fail_closed");
  assert.equal(slots.execution.default_verifier_kit, "cli");
  assert.equal(slots.preflight_review.binding_status, "aligned");
}

async function assertRunHarnessExecutionSlotBindingBlocksDispatchDuringTick(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-harness-slot-dispatch-");
  const bootstrapped = await bootstrapRun(rootDir, "harness-slot-dispatch");
  const run = updateRun(bootstrapped.run, {
    harness_profile: {
      execution: {
        default_verifier_kit: "repo"
      },
      slots: {
        execution: {
          binding: "attempt_dispatch_preflight"
        }
      }
    }
  });
  await saveRun(bootstrapped.workspacePaths, run);
  await initializeGitRepo(rootDir, false);
  const attempt = await seedCreatedExecutionAttempt({
    run,
    workspacePaths: bootstrapped.workspacePaths,
    verifierKit: "repo"
  });
  const adapter = new ContextCaptureAdapter();
  const orchestrator = new Orchestrator(
    bootstrapped.workspacePaths,
    adapter as never,
    undefined,
    60_000
  );

  await orchestrator.tick();
  await waitForAttemptActivityToDrain({
    workspacePaths: bootstrapped.workspacePaths,
    runId: run.id,
    failureMessage: "slot binding dispatch blocker should settle after one failed attempt"
  });

  const [persistedAttempt, preflight, mailbox] = await Promise.all([
    listAttempts(bootstrapped.workspacePaths, run.id),
    getAttemptPreflightEvaluation(bootstrapped.workspacePaths, run.id, attempt.id),
    getRunMailbox(bootstrapped.workspacePaths, run.id)
  ]);

  assert.equal(
    adapter.capturedCalls.length,
    0,
    "run_harness_execution_slot_binding_blocks_dispatch_during_tick: worker dispatch must stay blocked when execution slot binding drifts"
  );
  assert.equal(
    persistedAttempt[0]?.status,
    "failed",
    "run_harness_execution_slot_binding_blocks_dispatch_during_tick: attempt should fail closed"
  );
  assert.equal(
    preflight?.failure_code,
    "slot_binding_mismatch",
    "run_harness_execution_slot_binding_blocks_dispatch_during_tick: preflight should record slot_binding_mismatch"
  );
  assert.ok(
    preflight?.checks.some(
      (check) =>
        check.code === "slot_execution_binding" &&
        check.status === "failed" &&
        check.message.includes("attempt_dispatch_preflight")
    ),
    "run_harness_execution_slot_binding_blocks_dispatch_during_tick: preflight should persist the failing execution slot check"
  );
  assert.ok(
    mailbox?.entries.some(
      (entry) =>
        entry.message_type === "handoff_ready" &&
        entry.thread_id === `handoff:${attempt.id}` &&
        entry.source_attempt_id === attempt.id
    ),
    "run_harness_execution_slot_binding_blocks_dispatch_during_tick: settled failure should still emit a structured handoff mailbox entry"
  );
}

async function assertApprovalRequestMailboxThreadCreated(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-mailbox-approval-");
  const { run, workspacePaths } = await bootstrapRun(rootDir, "mailbox-approval");
  await initializeGitRepo(rootDir, false);
  const orchestrator = new Orchestrator(
    workspacePaths,
    new ScenarioAdapter("happy_path") as never,
    undefined,
    60_000,
    {
      executionApprovalMode: "human"
    }
  );

  await settle({
    orchestrator,
    workspacePaths,
    runId: run.id,
    iterations: 3,
    autoApprovePendingExecution: false
  });
  await waitForAttemptActivityToDrain({
    workspacePaths,
    runId: run.id,
    failureMessage: "approval mailbox case should settle after research finishes"
  });

  const [policyRuntime, mailbox] = await Promise.all([
    getRunPolicyRuntime(workspacePaths, run.id),
    getRunMailbox(workspacePaths, run.id)
  ]);
  assert.equal(
    policyRuntime?.approval_status,
    "pending",
    "approval_request_mailbox_thread_created: research completion should leave a pending approval"
  );
  assert.ok(policyRuntime?.proposed_signature, "expected a proposed signature");
  assert.ok(
    mailbox?.entries.some(
      (entry) =>
        entry.message_type === "approval_request" &&
        entry.status === "open" &&
        entry.thread_id === `approval:${policyRuntime?.proposed_signature}` &&
        entry.required_action === "approve_execution_plan"
    ),
    "approval_request_mailbox_thread_created: pending execution approval should create an open approval mailbox thread"
  );
}

async function assertRunHarnessAdversarialGateProfileControlsContractAndPreflight(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-harness-adversarial-gate-");
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);
  await initializeGitRepo(rootDir, false);

  const run = createRun({
    title: "harness-adversarial-gate-profile",
    description: "Verify harness profile gates control execution contracts and preflight.",
    success_criteria: ["Postflight adversarial gate should follow the run harness profile."],
    constraints: [],
    owner_id: "test",
    workspace_root: rootDir,
    harness_profile: {
      gates: {
        postflight_adversarial: {
          mode: "disabled"
        }
      }
    }
  });
  const attempt = createAttempt({
    run_id: run.id,
    attempt_type: "execution",
    worker: "codex",
    objective: "Respect the run-level postflight adversarial gate mode.",
    success_criteria: ["The generated execution contract should align to the gate mode."],
    workspace_root: rootDir
  });
  const orchestrator = new Orchestrator(
    workspacePaths,
    new ContextCaptureAdapter() as never,
    undefined,
    60_000
  );
  const buildAttemptContract = (
    orchestrator as unknown as {
      buildAttemptContract: (
        run: Run,
        attempt: Attempt,
        nextExecutionDraft: null,
        reusableExecutionContract: null
      ) => Promise<ReturnType<typeof createAttemptContract>>;
    }
  ).buildAttemptContract.bind(orchestrator);
  const runAttemptDispatchPreflight = (
    orchestrator as unknown as {
      runAttemptDispatchPreflight: (input: {
        run: Run;
        runId: string;
        attempt: Attempt;
        attemptContract: ReturnType<typeof createAttemptContract>;
        attemptPaths: ReturnType<typeof resolveAttemptPaths>;
      }) => Promise<unknown>;
    }
  ).runAttemptDispatchPreflight.bind(orchestrator);

  const alignedContract = await buildAttemptContract(run, attempt, null, null);
  assert.equal(
    alignedContract.adversarial_verification_required,
    false,
    "run_harness_adversarial_gate_profile_controls_contract_and_preflight: generated execution contract should disable the adversarial requirement when the profile disables the gate"
  );

  const mismatchedContract = createAttemptContract({
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: "execution",
    objective: attempt.objective,
    success_criteria: attempt.success_criteria,
    required_evidence: ["Leave runnable replay evidence."],
    adversarial_verification_required: true,
    verification_plan: {
      commands: [
        {
          purpose: "prove the fixture command stays runnable",
          command: "node -e \"process.exit(0)\""
        }
      ]
    }
  });

  await assert.rejects(
    () =>
      runAttemptDispatchPreflight({
        run,
        runId: run.id,
        attempt,
        attemptContract: mismatchedContract,
        attemptPaths: resolveAttemptPaths(workspacePaths, run.id, attempt.id)
      }),
    /postflight adversarial.*disabled/i,
    "run_harness_adversarial_gate_profile_controls_contract_and_preflight: preflight should fail closed when attempt_contract.json drifts away from the run harness gate bundle"
  );

  const evaluation = await getAttemptPreflightEvaluation(workspacePaths, run.id, attempt.id);
  assert.equal(
    evaluation?.failure_code,
    "adversarial_gate_profile_mismatch",
    "run_harness_adversarial_gate_profile_controls_contract_and_preflight: preflight should persist a dedicated gate profile mismatch failure code"
  );
  assert.ok(
    evaluation?.checks.some(
      (check) =>
        check.code === "postflight_adversarial_gate_mode" &&
        check.status === "passed" &&
        check.message.includes("disabled")
    ),
    "run_harness_adversarial_gate_profile_controls_contract_and_preflight: preflight should persist the loaded gate mode as a structured check"
  );
}

async function assertVerifierKitScopesDefaultInference(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-verifier-kit-toolchain-");
  await seedPackageJsonScriptsWithoutNodeModules(rootDir);

  const repoAssessment = await assessExecutionVerificationToolchain({
    workspaceRoot: rootDir,
    verifierKit: "repo"
  });
  const apiAssessment = await assessExecutionVerificationToolchain({
    workspaceRoot: rootDir,
    verifierKit: "api"
  });

  assert.deepEqual(
    repoAssessment.inferred_pnpm_commands,
    ["pnpm typecheck", "pnpm verify:runtime"],
    "verifier_kit_scopes_default_inference: repo kit should keep default pnpm inference"
  );
  assert.deepEqual(
    apiAssessment.inferred_pnpm_commands,
    [],
    "verifier_kit_scopes_default_inference: non-repo kits should not auto-infer pnpm replay commands"
  );
  assert.equal(
    repoAssessment.verifier_kit,
    "repo",
    "verifier_kit_scopes_default_inference: repo assessment should persist the selected kit"
  );
  assert.equal(
    repoAssessment.command_policy,
    "workspace_script_inference",
    "verifier_kit_scopes_default_inference: repo assessment should expose workspace script inference"
  );
  assert.equal(
    apiAssessment.verifier_kit,
    "api",
    "verifier_kit_scopes_default_inference: api assessment should persist the selected kit"
  );
  assert.equal(
    apiAssessment.command_policy,
    "contract_locked_commands",
    "verifier_kit_scopes_default_inference: api assessment should expose contract locked commands"
  );

  const defaultExecutionContract = createAttemptContract({
    attempt_id: "att_verifier_default",
    run_id: "run_verifier_default",
    attempt_type: "execution",
    objective: "Keep verifier kit defaults stable.",
    success_criteria: ["Default execution contracts should stay on the repo kit."],
    required_evidence: ["Persist the chosen verifier kit."]
  });
  const explicitApiContract = createAttemptContract({
    attempt_id: "att_verifier_api",
    run_id: "run_verifier_api",
    attempt_type: "execution",
    objective: "Keep explicit verifier kit selections stable.",
    success_criteria: ["Explicit execution contracts should preserve the api kit."],
    required_evidence: ["Persist the chosen verifier kit."],
    verifier_kit: "api"
  });

  assert.equal(
    defaultExecutionContract.verifier_kit,
    "repo",
    "verifier_kit_scopes_default_inference: execution contracts should default to repo"
  );
  assert.equal(
    explicitApiContract.verifier_kit,
    "api",
    "verifier_kit_scopes_default_inference: explicit verifier kits should survive contract creation"
  );
}

async function assertVerifierKitRuntimeAndPostflightMatrix(): Promise<void> {
  const matrix = [
    {
      verifierKit: "repo" as const,
      workerArtifacts: [
        { type: "patch", path: "artifacts/diff.patch" },
        { type: "test_result", path: "artifacts/adversarial-verification.json" }
      ],
      adversarial: {
        summary: "Repo replay probe stayed green after the workspace change.",
        checkCode: "repo_replay_probe",
        checkMessage: "The repo replay stayed green.",
        commandPurpose: "probe repo replay output"
      }
    },
    {
      verifierKit: "web" as const,
      workerArtifacts: [
        { type: "patch", path: "artifacts/diff.patch" },
        { type: "screenshot", path: "artifacts/ui-state.png" },
        { type: "test_result", path: "artifacts/adversarial-verification.json" }
      ],
      adversarial: {
        summary: "UI interaction probe stayed green after the browser render check.",
        checkCode: "ui_interaction_probe",
        checkMessage: "The browser interaction path stayed green.",
        commandPurpose: "probe browser ui interaction output"
      }
    },
    {
      verifierKit: "api" as const,
      workerArtifacts: [
        { type: "patch", path: "artifacts/diff.patch" },
        { type: "command_result", path: "artifacts/http-response.log" },
        { type: "test_result", path: "artifacts/adversarial-verification.json" }
      ],
      adversarial: {
        summary: "API error-path probe stayed green across the endpoint response boundary.",
        checkCode: "api_error_path_probe",
        checkMessage: "The API error path stayed green.",
        commandPurpose: "probe api endpoint response output"
      }
    },
    {
      verifierKit: "cli" as const,
      workerArtifacts: [
        { type: "patch", path: "artifacts/diff.patch" },
        { type: "command_result", path: "artifacts/cli-output.log" },
        { type: "test_result", path: "artifacts/adversarial-verification.json" }
      ],
      adversarial: {
        summary: "CLI bad-flag probe kept stderr and exit behavior stable.",
        checkCode: "cli_bad_flag_probe",
        checkMessage: "The CLI bad-flag path stayed green.",
        commandPurpose: "probe cli flag stderr output"
      }
    }
  ];

  for (const scenario of matrix) {
    const { run, attempt, workspacePaths } = await runVerifierKitFixtureCase(scenario);
    const [runtimeVerification, adversarialVerification, handoffBundle] = await Promise.all([
      getAttemptRuntimeVerification(workspacePaths, run.id, attempt.id),
      getAttemptAdversarialVerification(workspacePaths, run.id, attempt.id),
      getAttemptHandoffBundle(workspacePaths, run.id, attempt.id)
    ]);

    assert.equal(
      runtimeVerification?.status,
      "passed",
      `verifier_kit_runtime_and_postflight_matrix: ${scenario.verifierKit} runtime verification should pass`
    );
    assert.ok(
      runtimeVerification?.checks.some(
        (check) =>
          check.code === "verifier_kit_runtime_expectations_loaded" &&
          check.status === "passed"
      ),
      `verifier_kit_runtime_and_postflight_matrix: ${scenario.verifierKit} should persist runtime expectation checks`
    );
    assert.ok(
      runtimeVerification?.checks.some(
        (check) =>
          check.code === "verifier_kit_evidence_present" &&
          check.status === "passed"
      ),
      `verifier_kit_runtime_and_postflight_matrix: ${scenario.verifierKit} should persist runtime evidence checks`
    );
    assert.equal(
      adversarialVerification?.status,
      "passed",
      `verifier_kit_runtime_and_postflight_matrix: ${scenario.verifierKit} adversarial verification should pass`
    );
    assert.ok(
      adversarialVerification?.checks.some(
        (check) =>
          check.code === "verifier_kit_focus_present" &&
          check.status === "passed"
      ),
      `verifier_kit_runtime_and_postflight_matrix: ${scenario.verifierKit} should persist postflight focus checks`
    );
    assert.equal(
      handoffBundle?.runtime_verification?.verifier_kit,
      scenario.verifierKit,
      `verifier_kit_runtime_and_postflight_matrix: ${scenario.verifierKit} handoff should carry the runtime verifier kit`
    );
    assert.equal(
      handoffBundle?.adversarial_verification?.verifier_kit,
      scenario.verifierKit,
      `verifier_kit_runtime_and_postflight_matrix: ${scenario.verifierKit} handoff should carry the adversarial verifier kit`
    );
  }
}

async function assertCleanPostflightVerifierDoesNotDependOnExecutionWorkerArtifact(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-clean-postflight-verifier-");
  const bootstrapped = await bootstrapRun(rootDir, "clean-postflight-verifier");
  await initializeGitRepo(rootDir, false);
  const attempt = await seedCreatedExecutionAttempt({
    run: bootstrapped.run,
    workspacePaths: bootstrapped.workspacePaths,
    verifierKit: "repo"
  });
  const orchestrator = new Orchestrator(
    bootstrapped.workspacePaths,
    new NoSelfAdversarialExecutionFixtureAdapter() as never,
    undefined,
    60_000,
    {
      adversarialVerifier: new CleanPostflightVerifierFixture()
    }
  );
  await orchestrator.tick();
  await waitForAttemptActivityToDrain({
    workspacePaths: bootstrapped.workspacePaths,
    runId: bootstrapped.run.id,
    failureMessage: "clean postflight verifier: attempt activity did not settle"
  });

  const [result, adversarialVerification] = await Promise.all([
    getAttemptReviewInputPacket(bootstrapped.workspacePaths, bootstrapped.run.id, attempt.id),
    getAttemptAdversarialVerification(bootstrapped.workspacePaths, bootstrapped.run.id, attempt.id)
  ]);

  assert.equal(
    adversarialVerification?.status,
    "passed",
    "clean_postflight_verifier_independent: clean verifier should pass the postflight gate"
  );
  assert.match(
    adversarialVerification?.source_artifact_path ?? "",
    /clean-postflight-fixture\/artifact\.json$/,
    "clean_postflight_verifier_independent: source artifact should come from the clean verifier"
  );
  assert.ok(
    !result?.result?.artifacts.some((artifact) =>
      artifact.path.endsWith("adversarial-verification.json")
    ),
    "clean_postflight_verifier_independent: execution worker writeback should not self-certify adversarial verification"
  );
  await assert.rejects(
    () => access(join(rootDir, "artifacts", "adversarial-verification.json")),
    /ENOENT/,
    "clean_postflight_verifier_independent: execution workspace should not contain a self-written adversarial artifact"
  );
}

async function assertVerifierKitSpecificFailuresFailClosed(): Promise<void> {
  const webMissingEvidence = await runVerifierKitFixtureCase({
    verifierKit: "web",
    workerArtifacts: [
      { type: "patch", path: "artifacts/diff.patch" },
      { type: "test_result", path: "artifacts/adversarial-verification.json" }
    ],
    adversarial: {
      summary: "UI interaction probe stayed green after the browser render check.",
      checkCode: "ui_interaction_probe",
      checkMessage: "The browser interaction path stayed green.",
      commandPurpose: "probe browser ui interaction output"
    }
  });
  const webRuntime = await getAttemptRuntimeVerification(
    webMissingEvidence.workspacePaths,
    webMissingEvidence.run.id,
    webMissingEvidence.attempt.id
  );
  assert.equal(
    webRuntime?.failure_code,
    "missing_verifier_kit_evidence",
    "verifier_kit_specific_failures_fail_closed: web tasks must fail when runtime evidence lacks screenshot/report/log artifacts"
  );
  assert.ok(
    webRuntime?.checks.some(
      (check) =>
        check.code === "verifier_kit_evidence_present" &&
        check.status === "failed"
    ),
    "verifier_kit_specific_failures_fail_closed: web runtime failure should explain the missing verifier-kit evidence"
  );

  const cliMissingFocus = await runVerifierKitFixtureCase({
    verifierKit: "cli",
    workerArtifacts: [
      { type: "patch", path: "artifacts/diff.patch" },
      { type: "command_result", path: "artifacts/cli-output.log" },
      { type: "test_result", path: "artifacts/adversarial-verification.json" }
    ],
    adversarial: {
      summary: "Non happy path probe stayed green.",
      checkCode: "generic_probe",
      checkMessage: "A generic probe stayed green.",
      commandPurpose: "probe repeated execution output"
    }
  });
  const cliAdversarial = await getAttemptAdversarialVerification(
    cliMissingFocus.workspacePaths,
    cliMissingFocus.run.id,
    cliMissingFocus.attempt.id
  );
  assert.equal(
    cliAdversarial?.failure_code,
    "missing_kit_focus",
    "verifier_kit_specific_failures_fail_closed: cli tasks must fail when adversarial evidence does not mention cli-specific focus"
  );
  assert.ok(
    cliAdversarial?.checks.some(
      (check) =>
        check.code === "verifier_kit_focus_present" &&
        check.status === "failed"
    ),
    "verifier_kit_specific_failures_fail_closed: cli postflight failure should persist the missing focus check"
  );
}

async function assertManagedWorkspaceInheritsLocalNodeModules(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-managed-workspace-node-modules-");
  await initializeGitRepo(rootDir, false);
  await seedPackageJsonScriptsWithoutNodeModules(rootDir);
  await mkdir(join(rootDir, "node_modules"), { recursive: true });
  await writeFile(join(rootDir, "node_modules", ".placeholder"), "toolchain\n", "utf8");

  const { run } = await bootstrapRun(rootDir, "managed-workspace-node-modules");
  const managedRun = await ensureRunManagedWorkspace({
    run,
    policy: createDefaultRunWorkspaceScopePolicy(rootDir)
  });

  assert.ok(
    managedRun.managed_workspace_root,
    "managed_workspace_inherits_local_node_modules: expected a managed workspace to be provisioned"
  );

  const assessment = await assessExecutionVerificationToolchain({
    workspaceRoot: managedRun.managed_workspace_root!,
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
    assessment.has_local_node_modules,
    true,
    "managed_workspace_inherits_local_node_modules: managed workspace should see local node_modules from the source repo"
  );

  const managedNodeModulesStat = await lstat(
    join(managedRun.managed_workspace_root!, "node_modules")
  );
  assert.equal(
    managedNodeModulesStat.isSymbolicLink(),
    true,
    "managed_workspace_inherits_local_node_modules: managed workspace should link the source node_modules instead of copying it"
  );

  await rm(join(managedRun.managed_workspace_root!, "node_modules"), {
    recursive: true,
    force: true
  });

  const resumedManagedRun = await ensureRunManagedWorkspace({
    run: managedRun,
    policy: createDefaultRunWorkspaceScopePolicy(rootDir)
  });
  const reprovisionedNodeModulesStat = await lstat(
    join(resumedManagedRun.managed_workspace_root!, "node_modules")
  );

  assert.equal(
    reprovisionedNodeModulesStat.isSymbolicLink(),
    true,
    "managed_workspace_inherits_local_node_modules: existing managed workspaces should reprovision the source node_modules link on resume"
  );
}

async function assertMultiReviewerPipelinePersistsOpinionsAndSynthesizesEvaluation(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-multi-reviewer-pipeline-");
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
      timeout_ms: CLI_FIXTURE_TIMEOUT_MS
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

  await waitForRunCondition({
    workspacePaths,
    runId: run.id,
    failureMessage:
      "multi_reviewer_pipeline: research attempt did not settle to the execution-ready state",
    predicate: ({ current, attempts }) =>
      current?.recommended_next_action === "start_execution" &&
      current.latest_attempt_id !== null &&
      attempts.some(
        (attempt) => attempt.attempt_type === "research" && attempt.status === "completed"
      )
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
  const [reviewInputPacket, reviewOpinions, evaluation, evaluationSynthesis, reviewPacket, current] = await Promise.all([
    getAttemptReviewInputPacket(workspacePaths, run.id, researchAttempt!.id),
    listAttemptReviewOpinions(workspacePaths, run.id, researchAttempt!.id),
    getAttemptEvaluation(workspacePaths, run.id, researchAttempt!.id),
    getAttemptEvaluationSynthesisRecord(workspacePaths, run.id, researchAttempt!.id),
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
  assert.equal(
    evaluation?.evaluation_synthesis_ref,
    null,
    "multi_reviewer_pipeline: deterministic synthesis should not claim a separate synthesis artifact"
  );
  assert.equal(
    evaluation?.synthesizer,
    null,
    "multi_reviewer_pipeline: deterministic synthesis should not claim a model synthesizer"
  );
  assert.equal(
    evaluationSynthesis,
    null,
    "multi_reviewer_pipeline: deterministic synthesis should not persist an evaluation_synthesis artifact"
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
    reviewPacket?.evaluation_synthesis_ref,
    null,
    "multi_reviewer_pipeline: deterministic synthesis should not expose an evaluation_synthesis ref"
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

async function assertCliSynthesizerPersistsArtifactAndFinalizesEvaluation(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-cli-synthesizer-pipeline-");
  await initializeGitRepo(rootDir, false);
  const { run, workspacePaths } = await bootstrapRun(rootDir, "cli-synthesizer-pipeline");
  const reviewerConfigs = [
    {
      kind: "heuristic",
      reviewer_id: "gemini-reviewer",
      role: "principal_reviewer",
      adapter: "deterministic-heuristic",
      provider: "gemini",
      model: "gemini-2.5-pro"
    },
    {
      kind: "cli",
      reviewer_id: "codex-reviewer",
      role: "risk_reviewer",
      adapter: "fixture-cli-reviewer",
      provider: "codex",
      model: "gpt-5.4",
      command: process.execPath,
      args: [join(process.cwd(), "scripts", "fixture-reviewer-cli.mjs")],
      cwd: process.cwd(),
      timeout_ms: CLI_FIXTURE_TIMEOUT_MS
    }
  ];
  const synthesizerConfig = {
    kind: "cli",
    synthesizer_id: "codex-synthesizer",
    role: "final_synthesizer",
    adapter: "fixture-cli-synthesizer",
    provider: "codex",
    model: "gpt-5.4",
    command: process.execPath,
    args: [join(process.cwd(), "scripts", "fixture-synthesizer-cli.mjs")],
    cwd: process.cwd(),
    timeout_ms: CLI_FIXTURE_TIMEOUT_MS
  };

  await withTemporaryEnv(REVIEWER_CONFIG_ENV, JSON.stringify(reviewerConfigs), async () => {
    await withTemporaryEnv(SYNTHESIZER_CONFIG_ENV, JSON.stringify(synthesizerConfig), async () => {
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
  });

  await waitForRunCondition({
    workspacePaths,
    runId: run.id,
    failureMessage:
      "cli_synthesizer_pipeline: research attempt did not settle to the execution-ready state",
    predicate: ({ current, attempts }) =>
      current?.recommended_next_action === "start_execution" &&
      current.latest_attempt_id !== null &&
      attempts.some(
        (attempt) => attempt.attempt_type === "research" && attempt.status === "completed"
      )
  });

  const attempts = await listAttempts(workspacePaths, run.id);
  const researchAttempt = attempts.find(
    (attempt) => attempt.attempt_type === "research" && attempt.status === "completed"
  );
  assert.ok(
    researchAttempt,
    "cli_synthesizer_pipeline: expected one completed research attempt"
  );

  const expectedReviewInputPacketRef = `runs/${run.id}/attempts/${researchAttempt!.id}/review_input_packet.json`;
  const expectedEvaluationRef = `runs/${run.id}/attempts/${researchAttempt!.id}/evaluation.json`;
  const expectedEvaluationSynthesisRef = `runs/${run.id}/attempts/${researchAttempt!.id}/evaluation_synthesis.json`;
  const [reviewOpinions, evaluation, evaluationSynthesis, reviewPacket, current] = await Promise.all([
    listAttemptReviewOpinions(workspacePaths, run.id, researchAttempt!.id),
    getAttemptEvaluation(workspacePaths, run.id, researchAttempt!.id),
    getAttemptEvaluationSynthesisRecord(workspacePaths, run.id, researchAttempt!.id),
    getAttemptReviewPacket(workspacePaths, run.id, researchAttempt!.id),
    getCurrentDecision(workspacePaths, run.id)
  ]);

  assert.equal(
    reviewOpinions.length,
    2,
    "cli_synthesizer_pipeline: both reviewer opinions should still be persisted before synthesis"
  );
  assert.ok(evaluation, "cli_synthesizer_pipeline: synthesized evaluation should be persisted");
  assert.equal(
    evaluation?.review_input_packet_ref,
    expectedReviewInputPacketRef,
    "cli_synthesizer_pipeline: evaluation should still reference the frozen input packet"
  );
  assert.equal(
    evaluation?.synthesis_strategy,
    "cli_synthesizer_v1",
    "cli_synthesizer_pipeline: evaluation should record the cli synthesizer strategy"
  );
  assert.equal(
    evaluation?.evaluation_synthesis_ref,
    expectedEvaluationSynthesisRef,
    "cli_synthesizer_pipeline: evaluation should point at the persisted synthesis artifact"
  );
  assert.equal(
    evaluation?.synthesizer?.synthesizer_id,
    "codex-synthesizer",
    "cli_synthesizer_pipeline: evaluation should record the synthesizer identity"
  );
  assert.equal(
    evaluation?.synthesizer?.provider,
    "codex",
    "cli_synthesizer_pipeline: evaluation should record the synthesizer provider"
  );
  assert.equal(
    evaluation?.synthesizer?.model,
    "gpt-5.4",
    "cli_synthesizer_pipeline: evaluation should record the synthesizer model"
  );
  assert.equal(
    evaluation?.goal_progress,
    0.91,
    "cli_synthesizer_pipeline: cli synthesis should drive the final goal_progress"
  );
  assert.equal(
    evaluation?.evidence_quality,
    0.87,
    "cli_synthesizer_pipeline: cli synthesis should drive the final evidence_quality"
  );
  assert.match(
    evaluation?.rationale ?? "",
    new RegExp(`cli synthesizer reconciled ${researchAttempt!.id}`),
    "cli_synthesizer_pipeline: cli synthesis rationale should survive in evaluation.json"
  );

  assert.ok(
    evaluationSynthesis,
    "cli_synthesizer_pipeline: evaluation_synthesis.json should be persisted"
  );
  assert.equal(
    evaluationSynthesis?.review_input_packet_ref,
    expectedReviewInputPacketRef,
    "cli_synthesizer_pipeline: synthesis artifact should point at the frozen input packet"
  );
  assert.deepEqual(
    evaluationSynthesis?.opinion_refs,
    reviewPacket?.review_opinion_refs ?? [],
    "cli_synthesizer_pipeline: synthesis artifact should point at every persisted opinion"
  );
  assert.equal(
    evaluationSynthesis?.synthesizer.synthesizer_id,
    "codex-synthesizer",
    "cli_synthesizer_pipeline: synthesis artifact should keep synthesizer identity"
  );
  const synthesisOutput = JSON.parse(evaluationSynthesis!.raw_output) as {
    received_attempt_id?: string;
    structured_judgment?: {
      rationale?: string;
    };
  };
  assert.equal(
    synthesisOutput.received_attempt_id,
    researchAttempt!.id,
    "cli_synthesizer_pipeline: cli synthesizer should receive the frozen synthesis packet"
  );
  assert.equal(
    synthesisOutput.structured_judgment?.rationale,
    `cli synthesizer reconciled ${researchAttempt!.id}`,
    "cli_synthesizer_pipeline: synthesis artifact should keep the cli synthesizer raw output"
  );

  assert.ok(reviewPacket, "cli_synthesizer_pipeline: review packet should still be persisted");
  assert.equal(
    reviewPacket?.synthesized_evaluation_ref,
    expectedEvaluationRef,
    "cli_synthesizer_pipeline: review packet should expose the final evaluation ref"
  );
  assert.equal(
    reviewPacket?.evaluation_synthesis_ref,
    expectedEvaluationSynthesisRef,
    "cli_synthesizer_pipeline: review packet should expose the synthesis artifact ref"
  );
  assert.equal(
    reviewPacket?.artifact_manifest.filter(
      (artifact) => artifact.kind === "evaluation_synthesis" && artifact.exists
    ).length,
    1,
    "cli_synthesizer_pipeline: artifact manifest should include the synthesis artifact"
  );

  assert.equal(
    current?.recommended_next_action,
    "start_execution",
    "cli_synthesizer_pipeline: loop should still consume the final synthesized evaluation"
  );
  assert.equal(
    current?.latest_attempt_id,
    researchAttempt!.id,
    "cli_synthesizer_pipeline: current decision should still point at the settled attempt"
  );
}

function buildCliSynthesizerFailureMatcher(
  mode: CliSynthesizerFailureMode,
  timeoutMs: number
): RegExp {
  switch (mode) {
    case "invalid_json":
      return /evaluation 落盘前失败：CLI synthesizer .* returned invalid JSON/;
    case "nonzero_exit":
      return /evaluation 落盘前失败：CLI command failed/;
    default:
      return new RegExp(`evaluation 落盘前失败：CLI command timed out after ${timeoutMs}ms`);
  }
}

type CliSynthesizerFailureCaseState = {
  run: Run;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  failedResearchAttempt: Attempt;
  reviewInputPacket: Awaited<ReturnType<typeof getAttemptReviewInputPacket>>;
  reviewOpinions: Awaited<ReturnType<typeof listAttemptReviewOpinions>>;
  evaluation: Awaited<ReturnType<typeof getAttemptEvaluation>>;
  evaluationSynthesis: Awaited<ReturnType<typeof getAttemptEvaluationSynthesisRecord>>;
  reviewPacket: Awaited<ReturnType<typeof getAttemptReviewPacket>>;
  current: Awaited<ReturnType<typeof getCurrentDecision>>;
};

async function runCliSynthesizerFailureCase(
  mode: CliSynthesizerFailureMode
): Promise<CliSynthesizerFailureCaseState> {
  const rootDir = await createVerifyTempDir(`aisa-cli-synthesizer-${mode}-`);
  await initializeGitRepo(rootDir, false);
  const { run, workspacePaths } = await bootstrapRun(rootDir, `cli-synthesizer-${mode}`);
  const reviewerConfigs = [
    {
      kind: "heuristic",
      reviewer_id: "principal-reviewer",
      role: "principal_reviewer",
      adapter: "deterministic-heuristic"
    }
  ];
  const synthesizerConfig = {
    kind: "cli",
    synthesizer_id: `${mode}-synthesizer`,
    role: "final_synthesizer",
    adapter: `inline-${mode}-synthesizer`,
    command: process.execPath,
    args: [join(process.cwd(), "scripts", "fixture-synthesizer-cli.mjs"), mode],
    cwd: process.cwd(),
    timeout_ms: CLI_SYNTHESIZER_FAILURE_TIMEOUT_MS
  };

  await withTemporaryEnv(REVIEWER_CONFIG_ENV, JSON.stringify(reviewerConfigs), async () => {
    await withTemporaryEnv(SYNTHESIZER_CONFIG_ENV, JSON.stringify(synthesizerConfig), async () => {
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
  });

  await waitForRunCondition({
    workspacePaths,
    runId: run.id,
    failureMessage: `cli_synthesizer_${mode}: expected a failed research attempt to settle`,
    predicate: ({ current, attempts }) =>
      current?.recommended_next_action === "wait_for_human" &&
      current.waiting_for_human === true &&
      attempts.some(
        (attempt) => attempt.attempt_type === "research" && attempt.status === "failed"
      )
  });

  const attempts = await listAttempts(workspacePaths, run.id);
  const failedResearchAttempt = attempts.find(
    (attempt) => attempt.attempt_type === "research" && attempt.status === "failed"
  );
  assert.ok(
    failedResearchAttempt,
    `cli_synthesizer_${mode}: expected one failed research attempt`
  );

  const [reviewInputPacket, reviewOpinions, evaluation, evaluationSynthesis, reviewPacket, current] =
    await Promise.all([
      getAttemptReviewInputPacket(workspacePaths, run.id, failedResearchAttempt!.id),
      listAttemptReviewOpinions(workspacePaths, run.id, failedResearchAttempt!.id),
      getAttemptEvaluation(workspacePaths, run.id, failedResearchAttempt!.id),
      getAttemptEvaluationSynthesisRecord(workspacePaths, run.id, failedResearchAttempt!.id),
      getAttemptReviewPacket(workspacePaths, run.id, failedResearchAttempt!.id),
      getCurrentDecision(workspacePaths, run.id)
    ]);

  return {
    run,
    workspacePaths,
    failedResearchAttempt: failedResearchAttempt!,
    reviewInputPacket,
    reviewOpinions,
    evaluation,
    evaluationSynthesis,
    reviewPacket,
    current
  };
}

async function assertCliSynthesizerFailureBlocksEvaluationPersistence(
  mode: CliSynthesizerFailureMode
): Promise<void> {
  const {
    run,
    failedResearchAttempt,
    reviewInputPacket,
    reviewOpinions,
    evaluation,
    evaluationSynthesis,
    reviewPacket,
    current
  } = await runCliSynthesizerFailureCase(mode);

  const expectedReviewInputPacketRef = `runs/${run.id}/attempts/${failedResearchAttempt.id}/review_input_packet.json`;

  assert.ok(
    reviewInputPacket,
    `cli_synthesizer_${mode}: review_input_packet.json should still be persisted before synthesis fails`
  );
  assert.equal(
    reviewInputPacket?.attempt.status,
    "completed",
    `cli_synthesizer_${mode}: frozen review input packet should keep the pre-synthesis completed status`
  );
  assert.equal(
    reviewOpinions.length,
    1,
    `cli_synthesizer_${mode}: reviewer opinions should stay persisted when synthesis fails`
  );
  assert.equal(
    evaluation,
    null,
    `cli_synthesizer_${mode}: evaluation.json should not be persisted after synthesizer failure`
  );
  assert.equal(
    evaluationSynthesis,
    null,
    `cli_synthesizer_${mode}: evaluation_synthesis.json should not be persisted after synthesizer failure`
  );
  assert.ok(reviewPacket, `cli_synthesizer_${mode}: review packet should still be persisted`);
  assert.equal(
    reviewPacket?.attempt.status,
    "failed",
    `cli_synthesizer_${mode}: settled review packet should expose the failed attempt status`
  );
  assert.equal(
    reviewPacket?.review_input_packet_ref,
    expectedReviewInputPacketRef,
    `cli_synthesizer_${mode}: review packet should still point at the frozen input packet`
  );
  assert.equal(
    reviewPacket?.review_opinion_refs.length,
    1,
    `cli_synthesizer_${mode}: review packet should keep persisted reviewer opinions`
  );
  assert.equal(
    reviewPacket?.synthesized_evaluation_ref,
    null,
    `cli_synthesizer_${mode}: review packet should not expose an evaluation ref after synthesis failure`
  );
  assert.equal(
    reviewPacket?.evaluation_synthesis_ref,
    null,
    `cli_synthesizer_${mode}: review packet should not expose an evaluation_synthesis ref after synthesis failure`
  );
  assert.equal(
    reviewPacket?.artifact_manifest.filter(
      (artifact) => artifact.kind === "review_opinion" && artifact.exists
    ).length,
    1,
    `cli_synthesizer_${mode}: artifact manifest should keep persisted reviewer opinions`
  );
  assert.equal(
    reviewPacket?.artifact_manifest.filter(
      (artifact) => artifact.kind === "evaluation_synthesis" && artifact.exists
    ).length,
    0,
    `cli_synthesizer_${mode}: artifact manifest should stay free of evaluation_synthesis files after failure`
  );
  assert.equal(
    current?.recommended_next_action,
    "wait_for_human",
    `cli_synthesizer_${mode}: loop should stop and wait for human recovery`
  );
  assert.match(
    current?.blocking_reason ?? "",
    buildCliSynthesizerFailureMatcher(mode, CLI_SYNTHESIZER_FAILURE_TIMEOUT_MS),
    `cli_synthesizer_${mode}: blocking reason should expose the synthesizer failure`
  );
  assert.match(
    reviewPacket?.failure_context?.message ?? "",
    buildCliSynthesizerFailureMatcher(mode, CLI_SYNTHESIZER_FAILURE_TIMEOUT_MS),
    `cli_synthesizer_${mode}: failure context should expose the synthesizer failure`
  );
}

async function assertCliSynthesizerCannotOverrideFailedRuntimeVerification(): Promise<void> {
  const run = createRun({
    goal_id: "goal_hard_gate",
    branch_id: null,
    title: "hard gate",
    description: "ensure failed runtime verification stays hard-gated",
    success_criteria: ["failed runtime verification stays hard-gated"],
    owner_id: "verify-run-loop",
    workspace_root: process.cwd()
  });
  const baseAttempt = createAttempt({
    run_id: run.id,
    attempt_type: "execution",
    worker: "codex",
    objective: "repair the runtime",
    success_criteria: ["verification should pass"],
    workspace_root: process.cwd()
  });
  const attempt = updateAttempt(baseAttempt, {
    status: "completed",
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString()
  });
  const attemptContract = createAttemptContract({
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: "execution",
    objective: attempt.objective,
    success_criteria: attempt.success_criteria,
    required_evidence: ["verification output"],
    verification_plan: {
      commands: [
        {
          purpose: "typecheck",
          command: "pnpm typecheck"
        }
      ]
    }
  });
  const reviewInputPacket = {
    run_id: run.id,
    attempt_id: attempt.id,
    attempt,
    attempt_contract: attemptContract,
    current_decision_snapshot: createCurrentDecision({
      run_id: run.id,
      run_status: "running",
      latest_attempt_id: attempt.id,
      recommended_next_action: "attempt_running",
      recommended_attempt_type: "execution",
      summary: "runtime failure under review"
    }),
    context: null,
    journal: [],
    failure_context: {
      message: "Verification failed.",
      journal_event_id: null,
      journal_event_ts: null
    },
    result: WorkerWritebackSchema.parse({
      summary: "Applied a patch but verification still failed.",
      findings: [
        {
          type: "fact",
          content: "Typecheck still fails.",
          evidence: ["pnpm typecheck => exit 1"]
        }
      ],
      questions: [],
      recommended_next_steps: ["inspect the failing typecheck output"],
      confidence: 0.71,
      artifacts: []
    }),
    runtime_verification: {
      attempt_id: attempt.id,
      run_id: run.id,
      attempt_type: "execution",
      status: "failed",
      repo_root: process.cwd(),
      git_head: "abc123",
      git_status: [" M packages/judge/src/index.ts"],
      preexisting_git_status: [],
      new_git_status: [" M packages/judge/src/index.ts"],
      changed_files: ["packages/judge/src/index.ts"],
      failure_code: "verification_command_failed",
      failure_reason: "Verification command failed for typecheck.",
      command_results: [
        {
          purpose: "typecheck",
          command: "pnpm typecheck",
          cwd: process.cwd(),
          expected_exit_code: 0,
          exit_code: 1,
          passed: false,
          stdout_file: "/tmp/typecheck.stdout",
          stderr_file: "/tmp/typecheck.stderr"
        }
      ],
      created_at: new Date().toISOString()
    },
    artifact_manifest: [],
    generated_at: new Date().toISOString()
  };
  const synthesis = await synthesizeAttemptEvaluation({
    reviewInputPacket,
    opinions: [],
    reviewInputPacketRef: `runs/${run.id}/attempts/${attempt.id}/review_input_packet.json`,
    opinionRefs: [],
    synthesizerConfig: {
      kind: "cli",
      synthesizer_id: "fixture-hard-gate",
      role: "final_synthesizer",
      adapter: "fixture-cli-synthesizer",
      command: process.execPath,
      args: [join(process.cwd(), "scripts", "fixture-synthesizer-cli.mjs")],
      cwd: process.cwd(),
      timeout_ms: CLI_FIXTURE_TIMEOUT_MS
    }
  });

  assert.equal(
    synthesis.evaluation.verification_status,
    "failed",
    "cli_synthesizer_hard_gate: failed runtime verification must remain failed after cli synthesis"
  );
  assert.equal(
    synthesis.evaluation.recommendation,
    "continue",
    "cli_synthesizer_hard_gate: verification_command_failed should keep the deterministic continue recommendation"
  );
  assert.equal(
    synthesis.evaluation.suggested_attempt_type,
    "research",
    "cli_synthesizer_hard_gate: verification_command_failed should keep the deterministic research retry suggestion"
  );
  assert.ok(
    synthesis.evaluation.goal_progress <= 0.34,
    "cli_synthesizer_hard_gate: failed runtime verification must keep goal_progress hard-capped"
  );
}

async function assertCliSynthesizerCannotOverrideFailedAdversarialVerification(): Promise<void> {
  const run = createRun({
    goal_id: "goal_adversarial_hard_gate",
    branch_id: null,
    title: "adversarial hard gate",
    description: "ensure failed adversarial verification stays hard-gated",
    success_criteria: ["failed adversarial verification stays hard-gated"],
    owner_id: "verify-run-loop",
    workspace_root: process.cwd()
  });
  const baseAttempt = createAttempt({
    run_id: run.id,
    attempt_type: "execution",
    worker: "codex",
    objective: "ship the guarded change",
    success_criteria: ["both verification gates should pass"],
    workspace_root: process.cwd()
  });
  const attempt = updateAttempt(baseAttempt, {
    status: "completed",
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString()
  });
  const attemptContract = createAttemptContract({
    attempt_id: attempt.id,
    run_id: run.id,
    attempt_type: "execution",
    objective: attempt.objective,
    success_criteria: attempt.success_criteria,
    required_evidence: ["deterministic replay", "adversarial verification output"],
    verification_plan: {
      commands: [
        {
          purpose: "typecheck",
          command: "pnpm typecheck"
        }
      ]
    }
  });
  const reviewInputPacket = {
    run_id: run.id,
    attempt_id: attempt.id,
    attempt,
    attempt_contract: attemptContract,
    current_decision_snapshot: createCurrentDecision({
      run_id: run.id,
      run_status: "running",
      latest_attempt_id: attempt.id,
      recommended_next_action: "attempt_running",
      recommended_attempt_type: "execution",
      summary: "adversarial failure under review"
    }),
    context: null,
    journal: [],
    failure_context: {
      message: "Adversarial verification failed.",
      journal_event_id: null,
      journal_event_ts: null
    },
    result: WorkerWritebackSchema.parse({
      summary: "Deterministic replay passed but adversarial verification found a hole.",
      findings: [
        {
          type: "fact",
          content: "The repeated command exposed a regression.",
          evidence: ["artifacts/adversarial-verification.json => verdict fail"]
        }
      ],
      questions: [],
      recommended_next_steps: ["repair the regression before calling the attempt complete"],
      confidence: 0.82,
      artifacts: [{ type: "test_result", path: "artifacts/adversarial-verification.json" }]
    }),
    runtime_verification: {
      attempt_id: attempt.id,
      run_id: run.id,
      attempt_type: "execution",
      status: "passed",
      repo_root: process.cwd(),
      git_head: "abc123",
      git_status: [" M packages/judge/src/index.ts"],
      preexisting_git_status: [],
      new_git_status: [" M packages/judge/src/index.ts"],
      changed_files: ["packages/judge/src/index.ts"],
      failure_code: null,
      failure_reason: null,
      command_results: [
        {
          purpose: "typecheck",
          command: "pnpm typecheck",
          cwd: process.cwd(),
          expected_exit_code: 0,
          exit_code: 0,
          passed: true,
          stdout_file: "/tmp/typecheck.stdout",
          stderr_file: "/tmp/typecheck.stderr"
        }
      ],
      created_at: new Date().toISOString()
    },
    adversarial_verification: {
      attempt_id: attempt.id,
      run_id: run.id,
      attempt_type: "execution",
      status: "failed",
      verdict: "fail",
      summary: "Adversarial verification found a reproducible regression.",
      failure_code: "verdict_fail",
      failure_reason: "Repeated execution corrupted the output.",
      checks: [
        {
          code: "repeat_probe",
          status: "failed",
          message: "Repeated execution corrupted the output."
        }
      ],
      commands: [
        {
          purpose: "repeat the command",
          command: "pnpm typecheck",
          cwd: process.cwd(),
          exit_code: 1,
          status: "failed",
          output_ref: "/tmp/adversarial.stdout"
        }
      ],
      output_refs: ["/tmp/adversarial.stdout"],
      source_artifact_path: "/tmp/adversarial-verification.json",
      created_at: new Date().toISOString()
    },
    artifact_manifest: [],
    generated_at: new Date().toISOString()
  };
  const synthesis = await synthesizeAttemptEvaluation({
    reviewInputPacket,
    opinions: [],
    reviewInputPacketRef: `runs/${run.id}/attempts/${attempt.id}/review_input_packet.json`,
    opinionRefs: [],
    synthesizerConfig: {
      kind: "cli",
      synthesizer_id: "fixture-adversarial-hard-gate",
      role: "final_synthesizer",
      adapter: "fixture-cli-synthesizer",
      command: process.execPath,
      args: [join(process.cwd(), "scripts", "fixture-synthesizer-cli.mjs")],
      cwd: process.cwd(),
      timeout_ms: CLI_FIXTURE_TIMEOUT_MS
    }
  });

  assert.equal(
    synthesis.evaluation.verification_status,
    "passed",
    "cli_synthesizer_adversarial_hard_gate: deterministic runtime verification should stay passed"
  );
  assert.equal(
    synthesis.evaluation.adversarial_verification_status,
    "failed",
    "cli_synthesizer_adversarial_hard_gate: failed adversarial verification must remain failed after cli synthesis"
  );
  assert.equal(
    synthesis.evaluation.recommendation,
    "wait_human",
    "cli_synthesizer_adversarial_hard_gate: failed adversarial verification must preserve the deterministic wait_human recommendation"
  );
  assert.equal(
    synthesis.evaluation.suggested_attempt_type,
    "execution",
    "cli_synthesizer_adversarial_hard_gate: failed adversarial verification should keep the deterministic execution retry suggestion"
  );
  assert.ok(
    synthesis.evaluation.goal_progress <= 0.74,
    "cli_synthesizer_adversarial_hard_gate: failed adversarial verification must keep goal_progress capped below the completion band"
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
      return /opinion 落盘前失败：CLI command failed/;
    case "timeout":
      return new RegExp(`opinion 落盘前失败：CLI command timed out after ${timeoutMs}ms`);
  }
}

type CliReviewerFailureCaseState = {
  run: Run;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  failedResearchAttempt: Attempt;
  reviewInputPacket: Awaited<ReturnType<typeof getAttemptReviewInputPacket>>;
  reviewOpinions: Awaited<ReturnType<typeof listAttemptReviewOpinions>>;
  evaluation: Awaited<ReturnType<typeof getAttemptEvaluation>>;
  reviewPacket: Awaited<ReturnType<typeof getAttemptReviewPacket>>;
  current: Awaited<ReturnType<typeof getCurrentDecision>>;
};

async function runCliReviewerFailureCase(
  mode: CliReviewerFailureMode
): Promise<CliReviewerFailureCaseState> {
  const rootDir = await createVerifyTempDir(`aisa-cli-reviewer-${mode}-`);
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
      timeout_ms:
        mode === "timeout"
          ? CLI_REVIEWER_FAILURE_TIMEOUT_MS
          : CLI_REVIEWER_RESPONSE_TIMEOUT_MS
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

  await waitForRunCondition({
    workspacePaths,
    runId: run.id,
    failureMessage: `cli_reviewer_${mode}: expected a failed research attempt to settle`,
    predicate: ({ current, attempts }) =>
      current?.recommended_next_action === "wait_for_human" &&
      current.waiting_for_human === true &&
      attempts.some(
        (attempt) => attempt.attempt_type === "research" && attempt.status === "failed"
      )
  });

  const attempts = await listAttempts(workspacePaths, run.id);
  const failedResearchAttempt = attempts.find(
    (attempt) => attempt.attempt_type === "research" && attempt.status === "failed"
  );
  assert.ok(
    failedResearchAttempt,
    `cli_reviewer_${mode}: expected one failed research attempt`
  );

  const [reviewInputPacket, reviewOpinions, evaluation, reviewPacket, current] = await Promise.all([
    getAttemptReviewInputPacket(workspacePaths, run.id, failedResearchAttempt!.id),
    listAttemptReviewOpinions(workspacePaths, run.id, failedResearchAttempt!.id),
    getAttemptEvaluation(workspacePaths, run.id, failedResearchAttempt!.id),
    getAttemptReviewPacket(workspacePaths, run.id, failedResearchAttempt!.id),
    getCurrentDecision(workspacePaths, run.id)
  ]);

  return {
    run,
    workspacePaths,
    failedResearchAttempt: failedResearchAttempt!,
    reviewInputPacket,
    reviewOpinions,
    evaluation,
    reviewPacket,
    current
  };
}

async function assertCliReviewerFailureBlocksOpinionPersistence(
  mode: CliReviewerFailureMode
): Promise<void> {
  const {
    run,
    failedResearchAttempt,
    reviewInputPacket,
    reviewOpinions,
    evaluation,
    reviewPacket,
    current
  } = await runCliReviewerFailureCase(mode);

  const expectedReviewInputPacketRef = `runs/${run.id}/attempts/${failedResearchAttempt.id}/review_input_packet.json`;
  const expectedResultRef = buildExpectedResultRef(run.id, failedResearchAttempt.id);

  assert.ok(
    reviewInputPacket,
    `cli_reviewer_${mode}: review_input_packet.json should still be persisted before the reviewer fails`
  );
  assert.equal(
    reviewInputPacket?.attempt.status,
    "completed",
    `cli_reviewer_${mode}: frozen review input packet should keep the pre-review completed status`
  );
  assert.equal(
    reviewInputPacket?.attempt.result_ref,
    expectedResultRef,
    `cli_reviewer_${mode}: frozen review input packet should keep result_ref`
  );
  assert.equal(
    failedResearchAttempt.result_ref,
    expectedResultRef,
    `cli_reviewer_${mode}: attempt meta should keep result_ref after reviewer failure`
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
    reviewPacket?.attempt.result_ref,
    expectedResultRef,
    `cli_reviewer_${mode}: settled review packet should preserve result_ref`
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
    buildCliReviewerFailureMatcher(mode, CLI_REVIEWER_FAILURE_TIMEOUT_MS),
    `cli_reviewer_${mode}: blocking reason should expose the reviewer failure`
  );
  assert.match(
    reviewPacket?.failure_context?.message ?? "",
    buildCliReviewerFailureMatcher(mode, CLI_REVIEWER_FAILURE_TIMEOUT_MS),
    `cli_reviewer_${mode}: failure context should expose the reviewer failure`
  );
}

async function assertCliReviewerFailureRecoveryRebuildsReviewPacketFromMetaAndResult(): Promise<void> {
  const {
    run,
    workspacePaths,
    failedResearchAttempt,
    reviewPacket
  } = await runCliReviewerFailureCase("invalid_json");
  const expectedResultRef = buildExpectedResultRef(run.id, failedResearchAttempt.id);
  const attemptPaths = resolveAttemptPaths(workspacePaths, run.id, failedResearchAttempt.id);

  assert.ok(
    reviewPacket?.result,
    "cli_reviewer_invalid_json_recovery_chain_rebuilds_from_meta_and_result: expected a persisted result before the rebuild"
  );

  await rm(attemptPaths.reviewPacketFile, { force: true });
  await rm(attemptPaths.reviewInputPacketFile, { force: true });

  const orchestrator = new Orchestrator(
    workspacePaths,
    new ScenarioAdapter("happy_path") as never,
    undefined,
    60_000
  );
  await orchestrator.tick();

  const rebuiltReviewPacket = await getAttemptReviewPacket(
    workspacePaths,
    run.id,
    failedResearchAttempt.id
  );
  assert.ok(
    rebuiltReviewPacket,
    "cli_reviewer_invalid_json_recovery_chain_rebuilds_from_meta_and_result: review packet should be rebuilt during recovery"
  );
  assert.equal(
    rebuiltReviewPacket?.review_input_packet_ref,
    null,
    "cli_reviewer_invalid_json_recovery_chain_rebuilds_from_meta_and_result: rebuild should not depend on a persisted review_input_packet.json"
  );
  assert.equal(
    rebuiltReviewPacket?.attempt.result_ref,
    expectedResultRef,
    "cli_reviewer_invalid_json_recovery_chain_rebuilds_from_meta_and_result: rebuilt review packet should recover result_ref from attempt meta"
  );
  assert.deepEqual(
    rebuiltReviewPacket?.result,
    reviewPacket?.result ?? null,
    "cli_reviewer_invalid_json_recovery_chain_rebuilds_from_meta_and_result: rebuilt review packet should recover the full result payload from result.json"
  );
  assert.equal(
    rebuiltReviewPacket?.artifact_manifest.filter(
      (artifact) => artifact.kind === "attempt_result" && artifact.exists
    ).length,
    1,
    "cli_reviewer_invalid_json_recovery_chain_rebuilds_from_meta_and_result: rebuilt review packet should keep the persisted result artifact"
  );
  assert.match(
    rebuiltReviewPacket?.failure_context?.message ?? "",
    buildCliReviewerFailureMatcher("invalid_json", CLI_REVIEWER_FAILURE_TIMEOUT_MS),
    "cli_reviewer_invalid_json_recovery_chain_rebuilds_from_meta_and_result: rebuilt review packet should keep the reviewer failure context"
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

function assertDefaultWorkspaceScopePolicyHonorsManagedWorkspaceEnv(): void {
  const runtimeRoot = resolve("/tmp", "aisa-scope-runtime-root");
  const managedWorkspaceRoot = resolve("/tmp", "aisa-scope-managed-root");
  const previous = process.env.AISA_MANAGED_WORKSPACE_ROOT;
  process.env.AISA_MANAGED_WORKSPACE_ROOT = managedWorkspaceRoot;

  try {
    const policy = createDefaultRunWorkspaceScopePolicy(runtimeRoot);
    assert.equal(
      policy.managedWorkspaceRoot,
      managedWorkspaceRoot,
      "default workspace scope policy should honor AISA_MANAGED_WORKSPACE_ROOT"
    );
    assert.ok(
      policy.allowedRoots.includes(managedWorkspaceRoot),
      "default workspace scope policy should allow the managed workspace override"
    );
  } finally {
    if (previous === undefined) {
      delete process.env.AISA_MANAGED_WORKSPACE_ROOT;
    } else {
      process.env.AISA_MANAGED_WORKSPACE_ROOT = previous;
    }
  }
}

async function loadSmokeCases(): Promise<ScenarioCase[]> {
  await assertRegressionGatesParseable();
  assertDefaultWorkspaceScopePolicyHonorsManagedWorkspaceEnv();
  await loadReviewPacketSchema();
  const smokeDir = join(process.cwd(), "evals", "runtime-run-loop", "datasets", "smoke");
  const entries = await readdir(smokeDir);
  const cases = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .map(async (entry) => JSON.parse(await readFile(join(smokeDir, entry), "utf8")) as ScenarioCase)
  );
  const filter = getRequestedSmokeCaseFilter();
  const filteredCases =
    filter === null
      ? cases
      : cases.filter(
          (scenario) => scenario.id.includes(filter) || scenario.driver === filter
        );

  assert.ok(cases.length > 0, "Expected at least one runtime smoke case.");
  assert.ok(
    filteredCases.length > 0,
    `No runtime smoke cases matched ${filter ?? "<all>"}.`
  );
  return filteredCases;
}

async function runCase(scenario: ScenarioCase): Promise<ScenarioObservation> {
  const rootDir = await createVerifyTempDir(`aisa-${scenario.id}-`);
  const bootstrapped = await bootstrapRun(rootDir, scenario.id);
  const { workspacePaths } = bootstrapped;
  let run = bootstrapped.run;

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
    scenario.driver === "execution_parse_failure" ||
    scenario.driver === "execution_missing_verification_cwd_blocks_dispatch" ||
    scenario.driver === "execution_unrunnable_verification_command_blocks_dispatch" ||
    scenario.driver === "execution_retry_after_recovery_preserves_contract"
  ) {
    if (scenario.driver === "execution_runtime_source_drift_requires_restart") {
      await seedLiveRuntimeSourceFixture(rootDir);
    }
    await initializeGitRepo(rootDir, false);
  }

  if (scenario.driver === "attached_project_pack_default_contract") {
    run = await seedAttachedProjectPackDefaultContractCase({
      rootDir,
      run,
      workspacePaths
    });
  }

  if (scenario.driver === "execution_missing_local_toolchain_blocks_dispatch") {
    await seedPackageJsonScriptsWithoutNodeModules(rootDir);
  }

  if (scenario.driver === "execution_blocked_pnpm_verification_plan_blocks_dispatch") {
    await seedPackageJsonScriptsWithoutNodeModules(rootDir);
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
    iterations: scenario.max_ticks,
    autoApprovePendingExecution: shouldAutoApprovePendingExecution(scenario.driver)
  });
  await waitForAttemptActivityToDrain({
    workspacePaths,
    runId: run.id,
    failureMessage: `${scenario.id}: active attempts did not drain before observation`
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
  await waitForRunningAttemptsToSettle(input.workspacePaths, input.run.id, 3_000);
  await waitForRunCondition({
    workspacePaths: input.workspacePaths,
    runId: input.run.id,
    failureMessage:
      "concurrent owner case did not settle to the post-research execution state",
    predicate: ({ current, attempts }) =>
      current?.run_status === "running" &&
      current.waiting_for_human === false &&
      current.recommended_next_action === "start_execution" &&
      attempts.some(
        (attempt) => attempt.attempt_type === "research" && attempt.status === "completed"
      )
  });

  const persistedRun = await getRun(input.workspacePaths, input.run.id);
  assert.equal(persistedRun.id, input.run.id, "concurrent owner case: persisted run missing");

  return collectObservation(input.workspacePaths, input.run.id);
}

async function assertConcurrentTickCallsCreateSingleAttempt(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-concurrent-tick-create-");
  const { run, workspacePaths } = await bootstrapRun(rootDir, "concurrent-tick-create");
  const orchestrator = new Orchestrator(
    workspacePaths,
    new ContextCaptureAdapter() as never,
    undefined,
    60_000
  );

  await Promise.all([orchestrator.tick(), orchestrator.tick(), orchestrator.tick()]);

  const [attempts, journal] = await Promise.all([
    listAttempts(workspacePaths, run.id),
    listRunJournal(workspacePaths, run.id)
  ]);
  assert.equal(attempts.length, 1, "concurrent tick calls should only create one attempt");
  assert.equal(
    journal.filter((entry) => entry.type === "attempt.created").length,
    1,
    "concurrent tick calls should only append one attempt.created entry"
  );
  await assertRunDispatchLeaseReleased(rootDir, run.id);
}

async function assertConcurrentOrchestratorsCreateSingleAttempt(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-concurrent-orch-create-");
  const { run, workspacePaths } = await bootstrapRun(rootDir, "concurrent-orch-create");
  const primary = new Orchestrator(
    workspacePaths,
    new ContextCaptureAdapter() as never,
    undefined,
    60_000
  );
  const secondary = new Orchestrator(
    workspacePaths,
    new ContextCaptureAdapter() as never,
    undefined,
    60_000
  );

  await Promise.all([primary.tick(), secondary.tick()]);

  const [attempts, journal] = await Promise.all([
    listAttempts(workspacePaths, run.id),
    listRunJournal(workspacePaths, run.id)
  ]);
  assert.equal(attempts.length, 1, "concurrent orchestrators should only create one attempt");
  assert.equal(
    journal.filter((entry) => entry.type === "attempt.created").length,
    1,
    "concurrent orchestrators should only append one attempt.created entry"
  );
  await assertRunDispatchLeaseReleased(rootDir, run.id);
}

async function seedCreatedResearchAttempt(input: {
  run: Run;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
}): Promise<Attempt> {
  const attempt = createAttempt({
    run_id: input.run.id,
    attempt_type: "research",
    worker: "fake-codex",
    objective: "Capture grounded repository context for the next step.",
    success_criteria: input.run.success_criteria,
    workspace_root: input.run.workspace_root
  });
  await saveAttempt(input.workspacePaths, attempt);
  await saveAttemptContract(
    input.workspacePaths,
    createAttemptContract({
      attempt_id: attempt.id,
      run_id: input.run.id,
      attempt_type: attempt.attempt_type,
      objective: attempt.objective,
      success_criteria: attempt.success_criteria,
      required_evidence: ["Ground the next step in repository evidence."],
      expected_artifacts: ["review_packet.json"]
    })
  );
  await saveCurrentDecision(
    input.workspacePaths,
    createCurrentDecision({
      run_id: input.run.id,
      run_status: "running",
      latest_attempt_id: attempt.id,
      recommended_next_action: "continue_research",
      recommended_attempt_type: "research",
      summary: "Prepared a pending research attempt for concurrent start verification."
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

  return attempt;
}

async function assertConcurrentOrchestratorsStartPendingAttemptOnce(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-concurrent-orch-start-");
  const { run, workspacePaths } = await bootstrapRun(rootDir, "concurrent-orch-start");
  const seededAttempt = await seedCreatedResearchAttempt({
    run,
    workspacePaths
  });
  const primary = new Orchestrator(
    workspacePaths,
    new ScenarioAdapter("running_attempt_owned_elsewhere") as never,
    undefined,
    60_000
  );
  const secondary = new Orchestrator(
    workspacePaths,
    new ScenarioAdapter("running_attempt_owned_elsewhere") as never,
    undefined,
    60_000
  );

  await Promise.all([primary.tick(), secondary.tick()]);
  await waitForAttemptToLeavePendingState(workspacePaths, run.id, seededAttempt.id, 3_000);
  await waitForRunningAttemptsToSettle(workspacePaths, run.id, 3_000);

  const [attempts, journal] = await Promise.all([
    listAttempts(workspacePaths, run.id),
    listRunJournal(workspacePaths, run.id)
  ]);
  assert.equal(attempts.length, 1, "concurrent orchestrators should not clone the pending attempt");
  assert.equal(
    journal.filter(
      (entry) => entry.attempt_id === seededAttempt.id && entry.type === "attempt.started"
    ).length,
    1,
    "concurrent orchestrators should only start the pending attempt once"
  );
  await assertRunDispatchLeaseReleased(rootDir, run.id);
}

async function assertGlobalAttemptConcurrencyLimitCapsParallelDispatch(): Promise<void> {
  const rootDir = await createVerifyTempDir("aisa-run-concurrency-limit-");
  const first = await bootstrapRun(rootDir, "run-concurrency-limit-a");
  const second = await bootstrapRun(rootDir, "run-concurrency-limit-b");
  const adapter = new BlockingAdapter();
  const orchestrator = new Orchestrator(
    first.workspacePaths,
    adapter as never,
    undefined,
    60_000,
    {
      maxConcurrentAttempts: 1
    }
  );

  await orchestrator.tick();
  await orchestrator.tick();
  let firstAttempts: Awaited<ReturnType<typeof listAttempts>> = [];
  let secondAttempts: Awaited<ReturnType<typeof listAttempts>> = [];
  let startedCount = 0;
  const dispatchDeadline = Date.now() + 3_000;

  while (Date.now() < dispatchDeadline) {
    const [nextFirstAttempts, nextSecondAttempts, firstJournal, secondJournal] =
      await Promise.all([
        listAttempts(first.workspacePaths, first.run.id),
        listAttempts(second.workspacePaths, second.run.id),
        listRunJournal(first.workspacePaths, first.run.id),
        listRunJournal(second.workspacePaths, second.run.id)
      ]);
    const statuses = [
      nextFirstAttempts[0]?.status ?? null,
      nextSecondAttempts[0]?.status ?? null
    ];
    startedCount =
      firstJournal.filter((entry) => entry.type === "attempt.started").length +
      secondJournal.filter((entry) => entry.type === "attempt.started").length;
    const pendingCount = statuses.filter((status) =>
      ["created", "queued"].includes(status ?? "")
    ).length;
    const dispatchedCount = statuses.filter((status) =>
      ["running", "completed"].includes(status ?? "")
    ).length;

    firstAttempts = nextFirstAttempts;
    secondAttempts = nextSecondAttempts;

    if (startedCount === 1 && pendingCount === 1 && dispatchedCount === 1) {
      break;
    }

    await sleep(50);
  }

  assert.equal(firstAttempts.length, 1, "first run should plan exactly one attempt");
  assert.equal(secondAttempts.length, 1, "second run should plan exactly one attempt");
  assert.equal(
    startedCount,
    1,
    "global attempt concurrency limit should only dispatch one run at a time"
  );
  assert.equal(
    [firstAttempts[0]?.status, secondAttempts[0]?.status].filter((status) =>
      ["created", "queued"].includes(status ?? "")
    ).length,
    1,
    "exactly one run should stay pending until the slot is released"
  );
  assert.equal(
    [firstAttempts[0]?.status, secondAttempts[0]?.status].filter((status) =>
      ["running", "completed"].includes(status ?? "")
    ).length,
    1,
    "exactly one run should consume the only dispatch slot"
  );

  adapter.release();
  await waitForRunningAttemptsToSettle(first.workspacePaths, first.run.id, 3_000);
  await assertRunDispatchLeaseReleased(rootDir, first.run.id);
  await assertRunDispatchLeaseReleased(rootDir, second.run.id);
}

async function waitForAttemptToLeavePendingState(
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>,
  runId: string,
  attemptId: string,
  timeoutMs = 1_500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const attempt = (await listAttempts(workspacePaths, runId)).find((item) => item.id === attemptId);
    if (!attempt) {
      throw new Error(`Attempt disappeared before dispatch check: ${attemptId}`);
    }

    if (!["created", "queued"].includes(attempt.status)) {
      return;
    }

    await sleep(25);
  }

  throw new Error(`Attempt stayed pending too long: ${attemptId}`);
}

async function assertRunDispatchLeaseReleased(
  workspaceRoot: string,
  runId: string
): Promise<void> {
  const leasePath = join(
    workspaceRoot,
    "runs",
    runId,
    "artifacts",
    "run-dispatch-lease.json"
  );
  try {
    await lstat(leasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  throw new Error(`Run dispatch lease should have been released: ${leasePath}`);
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

async function seedAttachedProjectPackDefaultContractCase(input: {
  rootDir: string;
  run: Run;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
}): Promise<Run> {
  await mkdir(join(input.rootDir, "scripts"), { recursive: true });
  await mkdir(join(input.rootDir, "node_modules"), { recursive: true });
  await writeFile(
    join(input.rootDir, "package.json"),
    JSON.stringify(
      {
        name: "attached-project-pack-default-contract",
        private: true,
        packageManager: "pnpm@10.27.0",
        scripts: {
          test: "node ./scripts/test-ok.mjs",
          build: "node ./scripts/build-ok.mjs"
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  await writeFile(join(input.rootDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await writeFile(
    join(input.rootDir, "scripts", "test-ok.mjs"),
    'console.log("test ok");\n',
    "utf8"
  );
  await writeFile(
    join(input.rootDir, "scripts", "build-ok.mjs"),
    'console.log("build ok");\n',
    "utf8"
  );
  await initializeGitRepo(input.rootDir, false);

  const project = createAttachedProjectProfile({
    id: "project_attached_pack_defaults",
    slug: "attached-project-pack-default-contract",
    title: "Attached project pack defaults",
    workspace_root: input.rootDir,
    repo_root: input.rootDir,
    repo_name: "attached-project-pack-default-contract",
    project_type: "node_repo",
    primary_language: "typescript",
    package_manager: "pnpm",
    manifest_files: ["package.json", "pnpm-lock.yaml"],
    detection_reasons: ["verify-run-loop fixture"],
    default_commands: {
      build: "pnpm build",
      test: "pnpm test"
    }
  });
  await saveAttachedProjectProfile(input.workspacePaths, project);

  const run = updateRun(input.run, {
    attached_project_id: project.id,
    attached_project_stack_pack_id: "node_backend",
    attached_project_task_preset_id: "bugfix",
    harness_profile: {
      execution: {
        default_verifier_kit: "api"
      }
    }
  });
  await saveRun(input.workspacePaths, run);

  return run;
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

function buildExpectedResultRef(runId: string, attemptId: string): string {
  return `runs/${runId}/attempts/${attemptId}/result.json`;
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
        const attemptPaths = resolveAttemptPaths(workspacePaths, runId, attempt.id);
        const reviewPacketPath = attemptPaths.reviewPacketFile;
        const handoffBundlePath = attemptPaths.handoffBundleFile;
        const [
          reviewPacket,
          handoffBundle,
          preflightEvaluation,
          reviewPacketSchemaValidation,
          handoffBundleSchemaValidation
        ] = await Promise.all([
          getAttemptReviewPacket(workspacePaths, runId, attempt.id),
          getAttemptHandoffBundle(workspacePaths, runId, attempt.id),
          getAttemptPreflightEvaluation(workspacePaths, runId, attempt.id),
          validatePersistedReviewPacket({
            reviewPacketFile: reviewPacketPath
          }),
          validatePersistedHandoffBundle({
            handoffBundleFile: handoffBundlePath
          })
        ]);
        const artifactManifest = reviewPacket?.artifact_manifest ?? [];
        const artifactByKind = new Map(
          artifactManifest.map((artifact) => [artifact.kind, artifact] as const)
        );
        const metaArtifact = artifactByKind.get("attempt_meta") ?? null;
        const contractArtifact = artifactByKind.get("attempt_contract") ?? null;
        const contextArtifact = artifactByKind.get("attempt_context") ?? null;
        const preflightArtifact = artifactByKind.get("preflight_evaluation") ?? null;
        const resultArtifact = artifactByKind.get("attempt_result") ?? null;
        const evaluationArtifact = artifactByKind.get("attempt_evaluation") ?? null;
        const runtimeVerificationArtifact = artifactByKind.get("runtime_verification") ?? null;
        const adversarialVerificationArtifact =
          artifactByKind.get("adversarial_verification") ?? null;
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
          attempt_type: attempt.attempt_type,
          attempt_status: attempt.status,
          attempt_started_at: attempt.started_at,
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
          snapshot_recommended_next_action:
            reviewPacket?.current_decision_snapshot?.recommended_next_action ?? null,
          snapshot_blocking_reason: reviewPacket?.current_decision_snapshot?.blocking_reason ?? null,
          journal_count: reviewPacket?.journal.length ?? 0,
          has_failure_context: reviewPacket?.failure_context !== null,
          failure_message: reviewPacket?.failure_context?.message ?? null,
          has_result: reviewPacket?.result !== null,
          has_evaluation: reviewPacket?.evaluation !== null,
          has_runtime_verification: reviewPacket?.runtime_verification !== null,
          has_adversarial_verification: reviewPacket?.adversarial_verification !== null,
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
          has_adversarial_verification_artifact: adversarialVerificationArtifact !== null,
          adversarial_verification_artifact_exists:
            adversarialVerificationArtifact?.exists ?? false,
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
          adversarial_verification_status:
            reviewPacket?.adversarial_verification?.status ?? null,
          adversarial_verification_verdict:
            reviewPacket?.adversarial_verification?.verdict ?? null,
          adversarial_verification_failure_code:
            reviewPacket?.adversarial_verification?.failure_code ?? null,
          evaluation_adversarial_verification_status:
            reviewPacket?.evaluation?.adversarial_verification_status ?? null,
          runtime_verification_preexisting_git_status:
            reviewPacket?.runtime_verification?.preexisting_git_status ?? [],
          runtime_verification_new_git_status:
            reviewPacket?.runtime_verification?.new_git_status ?? [],
          runtime_verification_changed_files:
            reviewPacket?.runtime_verification?.changed_files ?? [],
          attempt_contract_stack_pack_id:
            reviewPacket?.attempt_contract?.stack_pack_id ?? null,
          attempt_contract_task_preset_id:
            reviewPacket?.attempt_contract?.task_preset_id ?? null,
          attempt_contract_verifier_kit:
            reviewPacket?.attempt_contract?.verifier_kit ?? null,
          attempt_contract_done_rubric_codes:
            reviewPacket?.attempt_contract?.done_rubric.map((item) => item.code) ?? [],
          attempt_contract_failure_mode_codes:
            reviewPacket?.attempt_contract?.failure_modes.map((item) => item.code) ?? [],
          attempt_contract_adversarial_verification_required:
            reviewPacket?.attempt_contract?.adversarial_verification_required ?? false,
          attempt_contract_has_verification_plan:
            reviewPacket?.attempt_contract?.verification_plan !== undefined,
          attempt_contract_verification_commands: attemptContractVerificationCommands,
          has_preflight_artifact: preflightArtifact !== null,
          preflight_artifact_exists: preflightArtifact?.exists ?? false,
          has_preflight_evaluation: preflightEvaluation !== null,
          preflight_evaluation_status: preflightEvaluation?.status ?? null,
          preflight_evaluation_failure_code: preflightEvaluation?.failure_code ?? null,
          preflight_evaluation_failure_reason: preflightEvaluation?.failure_reason ?? null,
          handoff_bundle_path: handoffBundlePath,
          has_handoff_bundle: handoffBundle !== null,
          handoff_bundle_matches_schema: handoffBundleSchemaValidation.matchesSchema,
          handoff_bundle_schema_error: handoffBundleSchemaValidation.schemaError,
          handoff_bundle_matches_attempt:
            handoffBundle?.run_id === runId &&
            handoffBundle?.attempt_id === attempt.id &&
            handoffBundle?.attempt.id === attempt.id,
          handoff_bundle_has_contract: handoffBundle?.approved_attempt_contract !== null,
          handoff_bundle_has_runtime_verification:
            handoffBundle?.runtime_verification !== null,
          handoff_bundle_has_adversarial_verification:
            handoffBundle?.adversarial_verification !== null,
          handoff_bundle_failure_code: handoffBundle?.failure_code ?? null,
          handoff_bundle_adversarial_failure_code:
            handoffBundle?.adversarial_failure_code ?? null,
          handoff_bundle_recommended_next_action:
            handoffBundle?.recommended_next_action ?? null,
          handoff_bundle_source_refs: handoffBundle
            ? {
                run_contract: handoffBundle.source_refs.run_contract,
                attempt_meta: handoffBundle.source_refs.attempt_meta,
                attempt_contract: handoffBundle.source_refs.attempt_contract,
                current_decision: handoffBundle.source_refs.current_decision,
                review_packet: handoffBundle.source_refs.review_packet,
                runtime_verification: handoffBundle.source_refs.runtime_verification,
                adversarial_verification:
                  handoffBundle.source_refs.adversarial_verification
              }
            : null,
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
    assert.ok(
      reviewPacket.has_handoff_bundle,
      `${scenario.id}: missing handoff bundle for ${reviewPacket.attempt_id}`
    );
    assert.ok(
      reviewPacket.handoff_bundle_matches_schema,
      `${scenario.id}: handoff bundle schema mismatch for ${reviewPacket.attempt_id}: ${reviewPacket.handoff_bundle_schema_error ?? "unknown"}`
    );
    assert.ok(
      reviewPacket.handoff_bundle_matches_attempt,
      `${scenario.id}: handoff bundle attempt metadata mismatch for ${reviewPacket.attempt_id}`
    );
    assert.ok(
      reviewPacket.handoff_bundle_has_contract,
      `${scenario.id}: handoff bundle missing approved attempt contract for ${reviewPacket.attempt_id}`
    );
    assert.equal(
      reviewPacket.handoff_bundle_has_runtime_verification,
      reviewPacket.has_runtime_verification,
      `${scenario.id}: handoff bundle runtime verification should mirror review packet for ${reviewPacket.attempt_id}`
    );
    assert.equal(
      reviewPacket.handoff_bundle_has_adversarial_verification,
      reviewPacket.has_adversarial_verification,
      `${scenario.id}: handoff bundle adversarial verification should mirror review packet for ${reviewPacket.attempt_id}`
    );
    assert.equal(
      reviewPacket.handoff_bundle_failure_code,
      reviewPacket.adversarial_verification_failure_code ??
        reviewPacket.runtime_verification_failure_code ??
        reviewPacket.preflight_evaluation_failure_code,
      `${scenario.id}: handoff bundle failure code should mirror review packet for ${reviewPacket.attempt_id}`
    );
    assert.equal(
      reviewPacket.handoff_bundle_adversarial_failure_code,
      reviewPacket.adversarial_verification_failure_code,
      `${scenario.id}: handoff bundle adversarial failure code should mirror review packet for ${reviewPacket.attempt_id}`
    );
    assert.equal(
      reviewPacket.handoff_bundle_recommended_next_action,
      reviewPacket.snapshot_recommended_next_action,
      `${scenario.id}: handoff bundle next action should match snapshot for ${reviewPacket.attempt_id}`
    );
    assert.equal(
      reviewPacket.handoff_bundle_source_refs?.run_contract,
      `runs/${observation.run_id}/contract.json`,
      `${scenario.id}: handoff bundle should point at run contract for ${reviewPacket.attempt_id}`
    );
    assert.equal(
      reviewPacket.handoff_bundle_source_refs?.attempt_meta,
      `runs/${observation.run_id}/attempts/${reviewPacket.attempt_id}/meta.json`,
      `${scenario.id}: handoff bundle should point at attempt meta for ${reviewPacket.attempt_id}`
    );
    assert.equal(
      reviewPacket.handoff_bundle_source_refs?.attempt_contract,
      `runs/${observation.run_id}/attempts/${reviewPacket.attempt_id}/attempt_contract.json`,
      `${scenario.id}: handoff bundle should point at attempt contract for ${reviewPacket.attempt_id}`
    );
    assert.equal(
      reviewPacket.handoff_bundle_source_refs?.current_decision,
      `runs/${observation.run_id}/current.json`,
      `${scenario.id}: handoff bundle should point at current decision for ${reviewPacket.attempt_id}`
    );
    assert.equal(
      reviewPacket.handoff_bundle_source_refs?.review_packet,
      `runs/${observation.run_id}/attempts/${reviewPacket.attempt_id}/review_packet.json`,
      `${scenario.id}: handoff bundle should point at review packet for ${reviewPacket.attempt_id}`
    );
    assert.equal(
      reviewPacket.handoff_bundle_source_refs?.runtime_verification,
      reviewPacket.has_runtime_verification
        ? `runs/${observation.run_id}/attempts/${reviewPacket.attempt_id}/artifacts/runtime-verification.json`
        : null,
      `${scenario.id}: handoff bundle should point at runtime verification for ${reviewPacket.attempt_id}`
    );
    assert.equal(
      reviewPacket.handoff_bundle_source_refs?.adversarial_verification,
      reviewPacket.has_adversarial_verification
        ? `runs/${observation.run_id}/attempts/${reviewPacket.attempt_id}/artifacts/adversarial-verification.json`
        : null,
      `${scenario.id}: handoff bundle should point at adversarial verification for ${reviewPacket.attempt_id}`
    );
    if (reviewPacket.attempt_type === "execution" && reviewPacket.has_attempt_contract) {
      assert.equal(
        reviewPacket.attempt_contract_adversarial_verification_required,
        true,
        `${scenario.id}: execution attempt contract should explicitly require adversarial verification for ${reviewPacket.attempt_id}`
      );
      assert.ok(
        reviewPacket.attempt_contract_done_rubric_codes.includes(
          "adversarial_verification_passed"
        ),
        `${scenario.id}: execution contract should carry adversarial done_rubric for ${reviewPacket.attempt_id}`
      );
    }

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
      if (reviewPacket.attempt_type === "execution") {
        assert.ok(
          reviewPacket.has_adversarial_verification,
          `${scenario.id}: completed execution missing adversarial verification in review packet for ${reviewPacket.attempt_id}`
        );
        assert.ok(
          reviewPacket.has_adversarial_verification_artifact,
          `${scenario.id}: completed execution missing adversarial verification manifest entry for ${reviewPacket.attempt_id}`
        );
        assert.ok(
          reviewPacket.adversarial_verification_artifact_exists,
          `${scenario.id}: completed execution missing persisted adversarial verification artifact for ${reviewPacket.attempt_id}`
        );
        if (reviewPacket.runtime_verification_status === "passed") {
          assert.equal(
            reviewPacket.adversarial_verification_status,
            "passed",
            `${scenario.id}: completed execution should pass adversarial verification for ${reviewPacket.attempt_id}`
          );
          assert.equal(
            reviewPacket.adversarial_verification_verdict,
            "pass",
            `${scenario.id}: completed execution should persist a pass verdict for ${reviewPacket.attempt_id}`
          );
          assert.equal(
            reviewPacket.evaluation_adversarial_verification_status,
            "passed",
            `${scenario.id}: evaluation should mirror adversarial verification status for ${reviewPacket.attempt_id}`
          );
        } else {
          assert.equal(
            reviewPacket.adversarial_verification_status,
            "not_applicable",
            `${scenario.id}: adversarial verification should stay not_applicable when runtime verification fails for ${reviewPacket.attempt_id}`
          );
          assert.equal(
            reviewPacket.evaluation_adversarial_verification_status,
            "not_applicable",
            `${scenario.id}: evaluation should mirror the skipped adversarial verification state for ${reviewPacket.attempt_id}`
          );
        }
      }
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

  if (scenario.driver === "attached_project_pack_default_contract") {
    const executionPacket = observation.review_packets.find(
      (packet) =>
        packet.attempt_type === "execution" &&
        packet.attempt_status === "completed" &&
        packet.runtime_verification_status === "passed"
    );
    assert.ok(
      executionPacket,
      `${scenario.id}: expected a completed execution review packet`
    );
    assert.equal(
      executionPacket.attempt_contract_stack_pack_id,
      "node_backend",
      `${scenario.id}: execution contract should freeze the selected stack pack`
    );
    assert.equal(
      executionPacket.attempt_contract_task_preset_id,
      "bugfix",
      `${scenario.id}: execution contract should freeze the selected task preset`
    );
    assert.equal(
      executionPacket.attempt_contract_verifier_kit,
      "repo",
      `${scenario.id}: attached project defaults should override the run-level verifier fallback`
    );
    assert.deepEqual(
      executionPacket.attempt_contract_verification_commands,
      ["pnpm test", "pnpm build"],
      `${scenario.id}: execution contract should replay the attached project bugfix commands`
    );
    assert.ok(
      !executionPacket.attempt_contract_verification_commands.some((command) =>
        command.includes("execution-change.md")
      ),
      `${scenario.id}: execution contract should come from attached project defaults, not an inline research draft`
    );
    assert.ok(
      executionPacket.attempt_contract_done_rubric_codes.includes(
        "bugfix_boundary_replayed"
      ),
      `${scenario.id}: execution contract should include the bugfix-specific done rubric`
    );
    assert.ok(
      executionPacket.attempt_contract_failure_mode_codes.includes(
        "bugfix_regression_unchecked"
      ),
      `${scenario.id}: execution contract should include the bugfix-specific failure mode`
    );
  }

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
    assert.equal(
      executionPacket.restart_required_message,
      null,
      `${scenario.id}: project-local runtime-like paths must not fabricate a runtime restart blocker`
    );
    assert.deepEqual(
      executionPacket.restart_required_affected_files,
      [],
      `${scenario.id}: project-local runtime-like paths must not report live runtime restart files`
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
      executionPacket.has_preflight_artifact,
      true,
      `${scenario.id}: failed preflight should persist a preflight artifact`
    );
    assert.equal(
      executionPacket.preflight_artifact_exists,
      true,
      `${scenario.id}: persisted preflight artifact should exist`
    );
    assert.equal(
      executionPacket.has_preflight_evaluation,
      true,
      `${scenario.id}: failed preflight should persist a machine-readable evaluation`
    );
    assert.equal(
      executionPacket.attempt_started_at,
      null,
      `${scenario.id}: failed preflight should not stamp started_at`
    );
    assert.equal(
      executionPacket.preflight_evaluation_status,
      "failed",
      `${scenario.id}: execution preflight should fail closed`
    );
    assert.equal(
      executionPacket.preflight_evaluation_failure_code,
      "missing_contract_verification_plan",
      `${scenario.id}: missing local toolchain case should fail on missing replayable verification`
    );
    assert.ok(
      executionPacket.preflight_evaluation_failure_reason?.includes("no local node_modules"),
      `${scenario.id}: preflight failure reason should surface the missing local toolchain`
    );
    assert.ok(
      executionPacket.attempt_contract_done_rubric_codes.length > 0,
      `${scenario.id}: execution contract should carry done_rubric`
    );
    assert.ok(
      executionPacket.attempt_contract_failure_mode_codes.length > 0,
      `${scenario.id}: execution contract should carry failure_modes`
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

  if (scenario.driver === "execution_workspace_not_git_repo_blocks_dispatch") {
    const executionPacket = observation.review_packets.find(
      (packet) => packet.attempt_status === "failed"
    );
    assert.ok(executionPacket, `${scenario.id}: expected a failed execution review packet`);
    assert.equal(executionPacket.attempt_started_at, null);
    assert.equal(executionPacket.has_result, false);
    assert.equal(executionPacket.has_runtime_verification, false);
    assert.equal(executionPacket.has_preflight_evaluation, true);
    assert.equal(executionPacket.preflight_evaluation_status, "failed");
    assert.equal(executionPacket.preflight_evaluation_failure_code, "workspace_not_git_repo");
    assert.ok(
      executionPacket.preflight_evaluation_failure_reason?.includes("not a git repository"),
      `${scenario.id}: preflight should explain that no git baseline can be captured`
    );
  }

  if (scenario.driver === "execution_blocked_pnpm_verification_plan_blocks_dispatch") {
    const executionPacket = observation.review_packets.find(
      (packet) => packet.attempt_status === "failed"
    );
    assert.ok(executionPacket, `${scenario.id}: expected a failed execution review packet`);
    assert.equal(executionPacket.attempt_started_at, null);
    assert.equal(executionPacket.has_result, false);
    assert.equal(executionPacket.has_runtime_verification, false);
    assert.equal(executionPacket.has_preflight_evaluation, true);
    assert.equal(executionPacket.preflight_evaluation_status, "failed");
    assert.equal(
      executionPacket.preflight_evaluation_failure_code,
      "blocked_pnpm_verification_plan"
    );
    assert.ok(
      executionPacket.preflight_evaluation_failure_reason?.includes("asks runtime to replay"),
      `${scenario.id}: preflight should say the contract locked pnpm replay`
    );
    assert.ok(
      executionPacket.preflight_evaluation_failure_reason?.includes("no local node_modules"),
      `${scenario.id}: preflight should surface the missing local toolchain`
    );
    assert.equal(
      executionPacket.attempt_contract_has_verification_plan,
      true,
      `${scenario.id}: execution contract should keep its explicit verification plan`
    );
    assert.deepEqual(
      executionPacket.attempt_contract_verification_commands,
      ["pnpm typecheck", "pnpm verify:runtime"],
      `${scenario.id}: execution contract should preserve the explicit pnpm replay commands`
    );
    assert.equal(
      executionPacket.handoff_bundle_failure_code,
      "blocked_pnpm_verification_plan",
      `${scenario.id}: handoff bundle should surface the unified preflight failure code`
    );
  }

  if (scenario.driver === "execution_missing_verification_cwd_blocks_dispatch") {
    const executionPacket = observation.review_packets.find(
      (packet) => packet.attempt_status === "failed"
    );
    assert.ok(executionPacket, `${scenario.id}: expected a failed execution review packet`);
    assert.equal(executionPacket.attempt_started_at, null);
    assert.equal(executionPacket.has_result, false);
    assert.equal(executionPacket.has_runtime_verification, false);
    assert.equal(executionPacket.has_preflight_evaluation, true);
    assert.equal(executionPacket.preflight_evaluation_status, "failed");
    assert.equal(
      executionPacket.preflight_evaluation_failure_code,
      "verification_command_not_runnable"
    );
    assert.ok(
      executionPacket.preflight_evaluation_failure_reason?.includes("missing or unreadable"),
      `${scenario.id}: preflight should surface the missing verification cwd`
    );
  }

  if (scenario.driver === "execution_unrunnable_verification_command_blocks_dispatch") {
    const executionPacket = observation.review_packets.find(
      (packet) => packet.attempt_status === "failed"
    );
    assert.ok(executionPacket, `${scenario.id}: expected a failed execution review packet`);
    assert.equal(executionPacket.attempt_started_at, null);
    assert.equal(executionPacket.has_result, false);
    assert.equal(executionPacket.has_runtime_verification, false);
    assert.equal(executionPacket.has_preflight_evaluation, true);
    assert.equal(executionPacket.preflight_evaluation_status, "failed");
    assert.equal(
      executionPacket.preflight_evaluation_failure_code,
      "verification_command_not_runnable"
    );
    assert.ok(
      executionPacket.preflight_evaluation_failure_reason?.includes(
        "cannot resolve executable"
      ),
      `${scenario.id}: preflight should fail before dispatch when the verifier binary is missing`
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
  const runtimeDataRoot = resolve(
    process.cwd(),
    "testdata",
    "verify-run-loop",
    "post-restart-prompt-chain"
  );
  const reportPath = join(
    runtimeDataRoot,
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
    const text = await readFile(join(runtimeDataRoot, evidence.path), "utf8");

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
    runtimeDataRoot,
    "runs",
    report.run_id,
    "attempts",
    report.legacy_execution_attempt_id,
    "worker-prompt.md"
  );
  const currentPromptPath = join(
    runtimeDataRoot,
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
      join(runtimeDataRoot, "runs", report.run_id, "attempts", report.attempt_id, "meta.json"),
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
    await readFile(join(runtimeDataRoot, "runs", report.run_id, "journal.ndjson"), "utf8")
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
  const scenarioFilter = getRequestedSmokeCaseFilter();
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

  if (scenarioFilter === null) {
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
      await assertExecutionHarnessEffortFlowsToDispatchContext();
      results.push({
        id: "execution_harness_effort_context",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "execution_harness_effort_context",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertExecutionEffortNativeConfigReachesCodexCli();
      results.push({
        id: "execution_effort_native_config",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "execution_effort_native_config",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertCliJudgeEffortSettingsStayVisibleWhenUnsupported();
      results.push({
        id: "cli_judge_effort_visibility",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "cli_judge_effort_visibility",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertConcurrentTickCallsCreateSingleAttempt();
      results.push({
        id: "concurrent_tick_calls_create_single_attempt",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "concurrent_tick_calls_create_single_attempt",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertConcurrentOrchestratorsCreateSingleAttempt();
      results.push({
        id: "concurrent_orchestrators_create_single_attempt",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "concurrent_orchestrators_create_single_attempt",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertConcurrentOrchestratorsStartPendingAttemptOnce();
      results.push({
        id: "concurrent_orchestrators_start_pending_attempt_once",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "concurrent_orchestrators_start_pending_attempt_once",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertGlobalAttemptConcurrencyLimitCapsParallelDispatch();
      results.push({
        id: "global_attempt_concurrency_limit_caps_parallel_dispatch",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "global_attempt_concurrency_limit_caps_parallel_dispatch",
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
      await assertRunHarnessPolicyBundleDefaults();
      results.push({
        id: "run_harness_policy_bundle_defaults",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "run_harness_policy_bundle_defaults",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertRunHarnessSlotBindingMismatchDetection();
      results.push({
        id: "run_harness_slot_binding_mismatch_detection",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "run_harness_slot_binding_mismatch_detection",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertRunHarnessLegacyBindingAliasRemainsAligned();
      results.push({
        id: "run_harness_legacy_binding_alias_remains_aligned",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "run_harness_legacy_binding_alias_remains_aligned",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertRunHarnessExecutionSlotBindingBlocksDispatchDuringTick();
      results.push({
        id: "run_harness_execution_slot_binding_blocks_dispatch_during_tick",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "run_harness_execution_slot_binding_blocks_dispatch_during_tick",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertApprovalRequestMailboxThreadCreated();
      results.push({
        id: "approval_request_mailbox_thread_created",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "approval_request_mailbox_thread_created",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertRunHarnessAdversarialGateProfileControlsContractAndPreflight();
      results.push({
        id: "run_harness_adversarial_gate_profile_controls_contract_and_preflight",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "run_harness_adversarial_gate_profile_controls_contract_and_preflight",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertVerifierKitScopesDefaultInference();
      results.push({
        id: "verifier_kit_scopes_default_inference",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "verifier_kit_scopes_default_inference",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertVerifierKitRuntimeAndPostflightMatrix();
      results.push({
        id: "verifier_kit_runtime_and_postflight_matrix",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "verifier_kit_runtime_and_postflight_matrix",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertCleanPostflightVerifierDoesNotDependOnExecutionWorkerArtifact();
      results.push({
        id: "clean_postflight_verifier_does_not_depend_on_execution_worker_artifact",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "clean_postflight_verifier_does_not_depend_on_execution_worker_artifact",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertVerifierKitSpecificFailuresFailClosed();
      results.push({
        id: "verifier_kit_specific_failures_fail_closed",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "verifier_kit_specific_failures_fail_closed",
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
      await assertCliReviewerFailureRecoveryRebuildsReviewPacketFromMetaAndResult();
      results.push({
        id: "cli_reviewer_invalid_json_recovery_chain_rebuilds_from_meta_and_result",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "cli_reviewer_invalid_json_recovery_chain_rebuilds_from_meta_and_result",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertCliSynthesizerFailureBlocksEvaluationPersistence("invalid_json");
      results.push({
        id: "cli_synthesizer_invalid_json_blocks_evaluation_persistence",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "cli_synthesizer_invalid_json_blocks_evaluation_persistence",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertCliSynthesizerFailureBlocksEvaluationPersistence("nonzero_exit");
      results.push({
        id: "cli_synthesizer_nonzero_exit_blocks_evaluation_persistence",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "cli_synthesizer_nonzero_exit_blocks_evaluation_persistence",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertManagedWorkspaceInheritsLocalNodeModules();
      results.push({
        id: "managed_workspace_inherits_local_node_modules",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "managed_workspace_inherits_local_node_modules",
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

    try {
      await assertCliSynthesizerPersistsArtifactAndFinalizesEvaluation();
      results.push({
        id: "cli_synthesizer_persists_artifact_and_finalizes_evaluation",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "cli_synthesizer_persists_artifact_and_finalizes_evaluation",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertCliSynthesizerCannotOverrideFailedRuntimeVerification();
      results.push({
        id: "cli_synthesizer_hard_gate_preserves_failed_runtime_verification",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "cli_synthesizer_hard_gate_preserves_failed_runtime_verification",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await assertCliSynthesizerCannotOverrideFailedAdversarialVerification();
      results.push({
        id: "cli_synthesizer_hard_gate_preserves_failed_adversarial_verification",
        status: "pass"
      });
    } catch (error) {
      results.push({
        id: "cli_synthesizer_hard_gate_preserves_failed_adversarial_verification",
        status: "fail",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const failed = results.filter((result) => result.status === "fail");
  if (failed.length === 0) {
    await cleanupTrackedVerifyTempDirs();
  }
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
