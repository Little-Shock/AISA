import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

type AreaId =
  | "worker_writeback"
  | "verification_contract"
  | "artifact_context"
  | "promotion_lane"
  | "governance_reuse"
  | "adversarial_evidence"
  | "invariant_pack"
  | "roadmap_boundary"
  | "worker_liveness";

type ProbeKind = "bad_should_block" | "good_should_allow" | "allow_with_report";

type Probe = {
  id: string;
  area: AreaId;
  kind: ProbeKind;
  description: string;
  tags: string[];
};

type Strategy = {
  id: string;
  area: AreaId;
  label: string;
  blocks: string[];
  reports: string[];
  risks: string[];
  recommended?: true;
};

type ProbeOutcome = {
  probeId: string;
  status: "pass" | "fail";
  reason: string;
};

type StrategyResult = {
  strategy: Strategy;
  outcomes: ProbeOutcome[];
  passCount: number;
  failCount: number;
};

type AreaResult = {
  area: AreaId;
  results: StrategyResult[];
  recommended: StrategyResult;
};

type JournalObservation = {
  workerSchemaInvalid: number;
  verificationFailed: number;
  preflightFailed: number;
  attemptFailed: number;
  attemptStopped: number;
  adversarialMissingFocus: number;
  promotionBlocked: number;
  dispatchMissingArtifact: number;
  dispatchExcludedPlan: number;
};

const probes: Probe[] = [
  {
    id: "worker_string_array_rubric",
    area: "worker_writeback",
    kind: "bad_should_block",
    description: "Worker returns string arrays where WorkerWritebackSchema requires objects.",
    tags: ["invalid_schema", "freeform_contract"]
  },
  {
    id: "worker_null_contract",
    area: "worker_writeback",
    kind: "bad_should_block",
    description: "Worker returns null or undefined for required contract fields.",
    tags: ["invalid_schema", "missing_required"]
  },
  {
    id: "worker_valid_contract",
    area: "worker_writeback",
    kind: "good_should_allow",
    description: "Worker returns a complete structured contract with object-shaped rubrics.",
    tags: ["valid_schema", "structured_contract"]
  },
  {
    id: "direct_expected_failure_command",
    area: "verification_contract",
    kind: "bad_should_block",
    description: "Verification plan directly runs a product command that is expected to fail.",
    tags: ["expected_failure_direct", "verification_command"]
  },
  {
    id: "inline_node_e_command",
    area: "verification_contract",
    kind: "bad_should_block",
    description: "Verification command relies on inline node -e or shell-only parsing.",
    tags: ["shell_shape", "argv_unsafe"]
  },
  {
    id: "git_mutation_in_verifier",
    area: "verification_contract",
    kind: "bad_should_block",
    description: "Verification plan contains git mutation or destructive cleanup commands.",
    tags: ["repo_mutation", "dangerous_command"]
  },
  {
    id: "wrapped_negative_verifier",
    area: "verification_contract",
    kind: "good_should_allow",
    description: "A verifier asserts the expected failure and exits 0 when the failure is correct.",
    tags: ["verifier_wrapped_negative", "argv_safe"]
  },
  {
    id: "runtime_artifact_mentioned_as_context",
    area: "artifact_context",
    kind: "good_should_allow",
    description: "Steer text mentions artifacts/adversarial-verification.json as context, not as a required input.",
    tags: ["untyped_text_path", "runtime_artifact_context"]
  },
  {
    id: "explicit_missing_required_ref",
    area: "artifact_context",
    kind: "bad_should_block",
    description: "A candidate explicitly declares a missing artifact as required evidence.",
    tags: ["explicit_missing_ref", "missing_artifact"]
  },
  {
    id: "existing_committed_ref",
    area: "artifact_context",
    kind: "good_should_allow",
    description: "A candidate references a real committed artifact.",
    tags: ["explicit_existing_ref", "existing_artifact"]
  },
  {
    id: "runtime_dirty_source_clean",
    area: "promotion_lane",
    kind: "allow_with_report",
    description: "AISA runtime repo is dirty but the attached source repo is clean and verified.",
    tags: ["runtime_dirty", "source_clean"]
  },
  {
    id: "source_repo_dirty",
    area: "promotion_lane",
    kind: "bad_should_block",
    description: "Attached source repo has uncommitted changes at promotion time.",
    tags: ["source_dirty"]
  },
  {
    id: "exact_rejected_plan",
    area: "governance_reuse",
    kind: "bad_should_block",
    description: "Candidate repeats an exact objective that governance already excluded.",
    tags: ["excluded_plan_exact"]
  },
  {
    id: "paraphrased_rejected_contract",
    area: "governance_reuse",
    kind: "bad_should_block",
    description: "Candidate paraphrases a rejected contract while keeping the same failed structure.",
    tags: ["excluded_plan_paraphrase", "contract_hash_reuse"]
  },
  {
    id: "fixed_contract_new_base",
    area: "governance_reuse",
    kind: "good_should_allow",
    description: "Candidate uses a new base attempt and repairs the failed contract shape.",
    tags: ["new_base_attempt", "contract_repaired"]
  },
  {
    id: "real_repo_probe_missing_keywords",
    area: "adversarial_evidence",
    kind: "good_should_allow",
    description: "Evidence contains a real replay probe but does not include the old magic keywords.",
    tags: ["real_probe", "missing_focus_keyword"]
  },
  {
    id: "keyword_only_fake_probe",
    area: "adversarial_evidence",
    kind: "bad_should_block",
    description: "Evidence contains the magic keywords but no real command, assertion, or output.",
    tags: ["keyword_only", "missing_probe"]
  },
  {
    id: "bad_recipe_v02_acceptance",
    area: "invariant_pack",
    kind: "bad_should_block",
    description: "Recipe v0.2 validator accepts a step or artifact outside the declared boundary.",
    tags: ["recipe_boundary", "historical_m15a"]
  },
  {
    id: "completed_run_missing_ended_at",
    area: "invariant_pack",
    kind: "bad_should_block",
    description: "Comparison accepts a completed run manifest with missing ended_at.",
    tags: ["missing_required", "historical_m15c"]
  },
  {
    id: "symlink_escape_write",
    area: "invariant_pack",
    kind: "bad_should_block",
    description: "A user path inside the workspace resolves through a symlink outside the repo.",
    tags: ["symlink_escape", "path_boundary", "historical_m21a_m22a"]
  },
  {
    id: "valid_happy_probe",
    area: "invariant_pack",
    kind: "good_should_allow",
    description: "A valid milestone verifier still passes after the invariant pack is added.",
    tags: ["valid_milestone"]
  },
  {
    id: "allowed_m22a",
    area: "roadmap_boundary",
    kind: "good_should_allow",
    description: "A milestone listed in the approved queue is allowed to run.",
    tags: ["milestone_allowed"]
  },
  {
    id: "unapproved_m23",
    area: "roadmap_boundary",
    kind: "bad_should_block",
    description: "AISA tries to continue to M23 without an approved roadmap entry.",
    tags: ["milestone_unapproved"]
  },
  {
    id: "dead_worker_no_stdout",
    area: "worker_liveness",
    kind: "bad_should_block",
    description: "Worker produces no stdout, no child command remains, and no final output is written.",
    tags: ["worker_stall", "no_final_output"]
  },
  {
    id: "live_child_still_running",
    area: "worker_liveness",
    kind: "allow_with_report",
    description: "Worker has no recent stdout but still has a live child command to observe.",
    tags: ["worker_quiet", "live_child"]
  }
];

const strategies: Strategy[] = [
  {
    id: "worker_prompt_only",
    area: "worker_writeback",
    label: "Prompt-only JSON wording",
    blocks: [],
    reports: ["invalid_schema"],
    risks: ["Known failures already bypassed prompt wording."]
  },
  {
    id: "worker_schema_gate",
    area: "worker_writeback",
    label: "Strict WorkerWritebackSchema gate",
    blocks: ["invalid_schema", "missing_required"],
    reports: [],
    risks: ["Still lets workers freely design weak but schema-valid contracts."]
  },
  {
    id: "worker_contract_builder",
    area: "worker_writeback",
    label: "Schema gate plus constrained contract builder",
    blocks: ["invalid_schema", "missing_required", "freeform_contract"],
    reports: [],
    risks: ["Higher implementation cost; needs migration for existing contract drafts."],
    recommended: true
  },
  {
    id: "verification_denylist",
    area: "verification_contract",
    label: "Dangerous command denylist",
    blocks: ["shell_shape", "repo_mutation", "dangerous_command"],
    reports: ["expected_failure_direct"],
    risks: ["Denylist can miss new shell shapes and expected-failure misuse."]
  },
  {
    id: "verification_argv_linter",
    area: "verification_contract",
    label: "Argv-only verification command linter",
    blocks: ["shell_shape", "argv_unsafe", "repo_mutation", "dangerous_command"],
    reports: ["expected_failure_direct"],
    risks: ["Still needs policy metadata to catch product commands that are supposed to fail."]
  },
  {
    id: "verification_wrapped_negative",
    area: "verification_contract",
    label: "Argv linter plus verifier-wrapped negative paths",
    blocks: [
      "shell_shape",
      "argv_unsafe",
      "repo_mutation",
      "dangerous_command",
      "expected_failure_direct"
    ],
    reports: [],
    risks: ["Requires writing focused verifier scripts for negative cases."],
    recommended: true
  },
  {
    id: "artifact_regex_current",
    area: "artifact_context",
    label: "Current regex extraction from free text",
    blocks: ["untyped_text_path", "missing_artifact"],
    reports: [],
    risks: ["Blocks prose that only mentions runtime artifacts as context."]
  },
  {
    id: "artifact_typed_refs",
    area: "artifact_context",
    label: "Typed context packet with explicit refs",
    blocks: ["explicit_missing_ref", "missing_artifact"],
    reports: ["untyped_text_path"],
    risks: ["Requires steer/context writers to split prose from required refs."],
    recommended: true
  },
  {
    id: "artifact_registry",
    area: "artifact_context",
    label: "Typed refs backed by artifact registry",
    blocks: ["explicit_missing_ref", "missing_artifact"],
    reports: ["untyped_text_path"],
    risks: ["Best long-term option, but needs registry integration."]
  },
  {
    id: "promotion_current_runtime_gate",
    area: "promotion_lane",
    label: "Current runtime dirty gate",
    blocks: ["runtime_dirty", "source_dirty"],
    reports: [],
    risks: ["Unrelated AISA runtime edits block verified attached-project promotion."]
  },
  {
    id: "promotion_dirty_allowlist",
    area: "promotion_lane",
    label: "Allowlist known runtime dirty files",
    blocks: ["source_dirty"],
    reports: ["runtime_dirty"],
    risks: ["Can hide real runtime damage behind a stale allowlist."]
  },
  {
    id: "promotion_isolated_lane",
    area: "promotion_lane",
    label: "Separate attached-source promotion lane from AISA runtime state",
    blocks: ["source_dirty"],
    reports: ["runtime_dirty"],
    risks: ["Needs clear operator UI so runtime dirty state remains visible."],
    recommended: true
  },
  {
    id: "governance_signature_only",
    area: "governance_reuse",
    label: "Exact normalized objective signature",
    blocks: ["excluded_plan_exact"],
    reports: [],
    risks: ["Misses paraphrased copies of the same rejected contract."]
  },
  {
    id: "governance_contract_hash",
    area: "governance_reuse",
    label: "Objective signature plus contract hash",
    blocks: ["excluded_plan_exact", "contract_hash_reuse"],
    reports: [],
    risks: ["Needs stable hashing of structured contract drafts."]
  },
  {
    id: "governance_lineage_ledger",
    area: "governance_reuse",
    label: "Rejection ledger with explicit base-attempt lineage",
    blocks: ["excluded_plan_exact", "excluded_plan_paraphrase", "contract_hash_reuse"],
    reports: [],
    risks: ["Requires repair steers to declare their base attempt."],
    recommended: true
  },
  {
    id: "adversarial_keyword_gate",
    area: "adversarial_evidence",
    label: "Keyword-based repo focus gate",
    blocks: ["missing_focus_keyword"],
    reports: [],
    risks: ["Rejects real probes without magic words and accepts keyword-only evidence."]
  },
  {
    id: "adversarial_structured_surface",
    area: "adversarial_evidence",
    label: "Structured target surface plus required probe evidence",
    blocks: ["keyword_only", "missing_probe"],
    reports: ["missing_focus_keyword"],
    risks: ["Requires evidence schema migration."],
    recommended: true
  },
  {
    id: "invariant_local_negative_cases",
    area: "invariant_pack",
    label: "Milestone-local negative cases only",
    blocks: [],
    reports: ["recipe_boundary", "missing_required", "symlink_escape"],
    risks: ["Historical bugs show local verifiers missed shared invariants."]
  },
  {
    id: "invariant_reusable_pack",
    area: "invariant_pack",
    label: "Reusable red-team invariant pack",
    blocks: ["recipe_boundary", "missing_required", "symlink_escape", "path_boundary"],
    reports: [],
    risks: ["Adds maintenance cost, but failures become reusable regression probes."],
    recommended: true
  },
  {
    id: "roadmap_steer_text",
    area: "roadmap_boundary",
    label: "Steer text says stop after milestone",
    blocks: [],
    reports: ["milestone_unapproved"],
    risks: ["Depends on worker obedience instead of a system gate."]
  },
  {
    id: "roadmap_manifest_gate",
    area: "roadmap_boundary",
    label: "Approved roadmap boundary manifest",
    blocks: ["milestone_unapproved"],
    reports: [],
    risks: ["Needs operators to update the manifest when approving a new queue."],
    recommended: true
  },
  {
    id: "liveness_timeout_only",
    area: "worker_liveness",
    label: "Timeout-only worker stall handling",
    blocks: ["worker_stall", "worker_quiet"],
    reports: [],
    risks: ["Cannot distinguish dead workers from long-running quiet child commands."]
  },
  {
    id: "liveness_heartbeat_snapshot",
    area: "worker_liveness",
    label: "Heartbeat plus child-process snapshot",
    blocks: ["worker_stall", "no_final_output"],
    reports: ["worker_quiet", "live_child"],
    risks: ["Needs adapters to expose child-command state."],
    recommended: true
  }
];

function strategyHandlesProbe(strategy: Strategy, probe: Probe): boolean {
  if (probe.kind === "bad_should_block") {
    return probe.tags.some((tag) => strategy.blocks.includes(tag));
  }

  if (probe.kind === "allow_with_report") {
    const blocked = probe.tags.some((tag) => strategy.blocks.includes(tag));
    const reported = probe.tags.some((tag) => strategy.reports.includes(tag));
    return !blocked && reported;
  }

  return !probe.tags.some((tag) => strategy.blocks.includes(tag));
}

function evaluateStrategy(strategy: Strategy, areaProbes: Probe[]): StrategyResult {
  const outcomes = areaProbes.map((probe): ProbeOutcome => {
    const passed = strategyHandlesProbe(strategy, probe);
    return {
      probeId: probe.id,
      status: passed ? "pass" : "fail",
      reason: passed
        ? `${strategy.id} handles ${probe.kind}.`
        : `${strategy.id} does not satisfy ${probe.kind} for tags: ${probe.tags.join(", ")}.`
    };
  });

  return {
    strategy,
    outcomes,
    passCount: outcomes.filter((outcome) => outcome.status === "pass").length,
    failCount: outcomes.filter((outcome) => outcome.status === "fail").length
  };
}

function evaluateAreas(): AreaResult[] {
  const areaIds = [...new Set(probes.map((probe) => probe.area))];
  return areaIds.map((area) => {
    const areaProbes = probes.filter((probe) => probe.area === area);
    const areaStrategies = strategies.filter((strategy) => strategy.area === area);
    const results = areaStrategies.map((strategy) => evaluateStrategy(strategy, areaProbes));
    const recommended = results.find((result) => result.strategy.recommended);
    assert.ok(recommended, `Area ${area} must declare a recommended strategy.`);
    assert.equal(
      recommended.failCount,
      0,
      `Recommended strategy for ${area} fails dry-run probes.`
    );
    return {
      area,
      results,
      recommended
    };
  });
}

async function fileExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue);
    return true;
  } catch {
    return false;
  }
}

async function readJsonLines(pathValue: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(pathValue, "utf8");
  return raw
    .split(/\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function payloadOf(row: Record<string, unknown>): Record<string, unknown> {
  const payload = row.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

async function observeJournal(runDir: string): Promise<JournalObservation | null> {
  const journalPath = join(runDir, "journal.ndjson");
  if (!(await fileExists(journalPath))) {
    return null;
  }

  const rows = await readJsonLines(journalPath);
  const observation: JournalObservation = {
    workerSchemaInvalid: 0,
    verificationFailed: 0,
    preflightFailed: 0,
    attemptFailed: 0,
    attemptStopped: 0,
    adversarialMissingFocus: 0,
    promotionBlocked: 0,
    dispatchMissingArtifact: 0,
    dispatchExcludedPlan: 0
  };

  for (const row of rows) {
    const type = String(row.type ?? "");
    const payload = payloadOf(row);
    if (type === "attempt.failed") {
      observation.attemptFailed += 1;
      if (payload.code === "worker_output_schema_invalid") {
        observation.workerSchemaInvalid += 1;
      }
    }
    if (type === "attempt.verification.failed") {
      observation.verificationFailed += 1;
    }
    if (type === "attempt.preflight.failed") {
      observation.preflightFailed += 1;
    }
    if (type === "attempt.stopped") {
      observation.attemptStopped += 1;
    }
    if (
      type === "attempt.adversarial_verification.failed" &&
      payload.failure_code === "missing_kit_focus"
    ) {
      observation.adversarialMissingFocus += 1;
    }
    if (type === "attempt.runtime.promotion.blocked") {
      observation.promotionBlocked += 1;
    }
    if (type === "run.governance.dispatch_blocked") {
      if (payload.reason === "missing_artifact_reference") {
        observation.dispatchMissingArtifact += 1;
      }
      if (payload.reason === "excluded_plan_reused") {
        observation.dispatchExcludedPlan += 1;
      }
    }
  }

  return observation;
}

function formatArea(area: AreaResult): string[] {
  const lines: string[] = [];
  lines.push(`\n[${area.area}] recommended=${area.recommended.strategy.id}`);

  for (const result of area.results) {
    const status = result.failCount === 0 ? "PASS" : "FAIL";
    lines.push(
      `  ${status} ${result.strategy.id}: ${result.passCount}/${result.outcomes.length} probes`
    );
    if (result.failCount > 0) {
      const failed = result.outcomes
        .filter((outcome) => outcome.status === "fail")
        .map((outcome) => outcome.probeId)
        .join(", ");
      lines.push(`    missed: ${failed}`);
    }
    if (result.strategy.risks.length > 0) {
      lines.push(`    risk: ${result.strategy.risks.join(" ")}`);
    }
  }

  return lines;
}

function formatObservation(observation: JournalObservation | null, runDir: string | null): string[] {
  if (!runDir) {
    return ["No AISA_ADVERSARIAL_REPLAY_RUN_DIR provided; using synthetic probes only."];
  }
  if (!observation) {
    return [`No readable journal.ndjson found at ${runDir}; using synthetic probes only.`];
  }

  return [
    `Observed run: ${runDir}`,
    `  attempt_failed=${observation.attemptFailed}`,
    `  worker_schema_invalid=${observation.workerSchemaInvalid}`,
    `  verification_failed=${observation.verificationFailed}`,
    `  preflight_failed=${observation.preflightFailed}`,
    `  attempt_stopped=${observation.attemptStopped}`,
    `  adversarial_missing_focus=${observation.adversarialMissingFocus}`,
    `  promotion_blocked=${observation.promotionBlocked}`,
    `  dispatch_missing_artifact=${observation.dispatchMissingArtifact}`,
    `  dispatch_excluded_plan=${observation.dispatchExcludedPlan}`
  ];
}

async function main(): Promise<void> {
  const runDir = process.env.AISA_ADVERSARIAL_REPLAY_RUN_DIR?.trim() || null;
  const observation = runDir ? await observeJournal(runDir) : null;
  const areas = evaluateAreas();

  const recommendedFailures = areas.flatMap((area) =>
    area.recommended.outcomes.filter((outcome) => outcome.status === "fail")
  );
  assert.deepEqual(recommendedFailures, []);

  const lines = [
    "AISA adversarial dry-run strategy comparison",
    ...formatObservation(observation, runDir),
    ...areas.flatMap(formatArea),
    "",
    "VERDICT: PASS"
  ];
  console.log(lines.join("\n"));
}

await main();
