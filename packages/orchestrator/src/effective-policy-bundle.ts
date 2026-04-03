import {
  resolveRunHarnessProfile,
  type Run
} from "@autoresearch/domain";
import {
  describeRunHarnessGates,
  type RunHarnessGatesView
} from "./gate-registry.js";
import {
  describeRunDefaultVerifierKit,
  type ExecutionVerifierKitView
} from "./verifier-kit-registry.js";

export type RunEffectivePolicyVerificationLevel =
  | "deterministic_only"
  | "deterministic_plus_adversarial";
export type RunEffectivePolicyOperatorBriefIntensity =
  | "compact"
  | "standard"
  | "expanded";
export type RunEffectivePolicyOperatorBriefSummaryStyle =
  | "headline_only"
  | "headline_plus_focus"
  | "headline_focus_and_next_action";
export type RunEffectivePolicyMaintenanceRefreshStrategy =
  | "saved_boundary_snapshot"
  | "live_recompute";
export type RunEffectivePolicyActiveRecoveryMode = "working_context_first";
export type RunEffectivePolicySettledRecoveryMode = "manual_only" | "handoff_first";

export type RunEffectivePolicyBundleView = {
  profile_version: number;
  verification_discipline: {
    level: RunEffectivePolicyVerificationLevel;
    default_verifier_kit: ExecutionVerifierKitView["kit"];
    command_policy: ExecutionVerifierKitView["command_policy"];
    summary: string;
    source_refs: string[];
  };
  operator_brief: {
    intensity: RunEffectivePolicyOperatorBriefIntensity;
    evidence_ref_budget: number;
    summary_style: RunEffectivePolicyOperatorBriefSummaryStyle;
    source: string;
    detail: string;
  };
  maintenance_refresh: {
    strategy: RunEffectivePolicyMaintenanceRefreshStrategy;
    refreshes_on_read: boolean;
    source: string;
    detail: string;
  };
  recovery: {
    active_run: RunEffectivePolicyActiveRecoveryMode;
    settled_run: RunEffectivePolicySettledRecoveryMode;
    auto_resume_from_settled_handoff: boolean;
    source: string;
    detail: string;
  };
};

function buildVerificationDiscipline(input: {
  gates: RunHarnessGatesView;
  defaultVerifierKit: ExecutionVerifierKitView;
}): RunEffectivePolicyBundleView["verification_discipline"] {
  const postflightRequired = input.gates.postflight_adversarial.enforced;

  return {
    level: postflightRequired
      ? "deterministic_plus_adversarial"
      : "deterministic_only",
    default_verifier_kit: input.defaultVerifierKit.kit,
    command_policy: input.defaultVerifierKit.command_policy,
    summary: postflightRequired
      ? `${input.defaultVerifierKit.title} keeps preflight and deterministic runtime as hard gates, then requires the postflight adversarial gate as a second pass.`
      : `${input.defaultVerifierKit.title} keeps preflight and deterministic runtime as hard gates, while the postflight adversarial gate is disabled by profile.`,
    source_refs: [
      input.gates.preflight_review.source,
      input.gates.deterministic_runtime.source,
      input.gates.postflight_adversarial.source,
      input.defaultVerifierKit.source
    ]
  };
}

function buildOperatorBrief(
  run: Run
): RunEffectivePolicyBundleView["operator_brief"] {
  const effort = resolveRunHarnessProfile(run).synthesizer.effort;
  switch (effort) {
    case "low":
      return {
        intensity: "compact",
        evidence_ref_budget: 4,
        summary_style: "headline_only",
        source: "run.harness_profile.synthesizer.effort",
        detail:
          "Low synthesizer effort keeps the operator brief compact and headline-first."
      };
    case "high":
      return {
        intensity: "expanded",
        evidence_ref_budget: 8,
        summary_style: "headline_focus_and_next_action",
        source: "run.harness_profile.synthesizer.effort",
        detail:
          "High synthesizer effort expands the operator brief with focus and next-action context."
      };
    default:
      return {
        intensity: "standard",
        evidence_ref_budget: 6,
        summary_style: "headline_plus_focus",
        source: "run.harness_profile.synthesizer.effort",
        detail:
          "Medium synthesizer effort keeps the operator brief concise but still focus-aware."
      };
  }
}

function buildMaintenanceRefresh(
  run: Run
): RunEffectivePolicyBundleView["maintenance_refresh"] {
  const effort = resolveRunHarnessProfile(run).reviewer.effort;
  switch (effort) {
    case "low":
      return {
        strategy: "saved_boundary_snapshot",
        refreshes_on_read: false,
        source: "run.harness_profile.reviewer.effort",
        detail:
          "Low reviewer effort keeps maintenance reads on the saved boundary snapshot instead of live recompute."
      };
    case "high":
      return {
        strategy: "live_recompute",
        refreshes_on_read: true,
        source: "run.harness_profile.reviewer.effort",
        detail:
          "High reviewer effort keeps maintenance reads on live recompute so operator surfaces stay current."
      };
    default:
      return {
        strategy: "live_recompute",
        refreshes_on_read: true,
        source: "run.harness_profile.reviewer.effort",
        detail:
          "Medium reviewer effort keeps maintenance reads on live recompute at operator-facing boundaries."
      };
  }
}

function buildRecoveryPolicy(
  run: Run
): RunEffectivePolicyBundleView["recovery"] {
  const effort = resolveRunHarnessProfile(run).reviewer.effort;
  switch (effort) {
    case "low":
      return {
        active_run: "working_context_first",
        settled_run: "manual_only",
        auto_resume_from_settled_handoff: false,
        source: "run.harness_profile.reviewer.effort",
        detail:
          "Low reviewer effort keeps settled recovery on manual recovery instead of auto-resuming from handoff."
      };
    default:
      return {
        active_run: "working_context_first",
        settled_run: "handoff_first",
        auto_resume_from_settled_handoff: true,
        source: "run.harness_profile.reviewer.effort",
        detail:
          "Medium and high reviewer effort allow settled recovery to auto-resume from handoff after the hard gates pass."
      };
  }
}

export function describeRunEffectivePolicyBundle(
  run: Run
): RunEffectivePolicyBundleView {
  const harnessProfile = resolveRunHarnessProfile(run);
  const gates = describeRunHarnessGates(run);
  const defaultVerifierKit = describeRunDefaultVerifierKit(run);

  return {
    profile_version: harnessProfile.version,
    verification_discipline: buildVerificationDiscipline({
      gates,
      defaultVerifierKit
    }),
    operator_brief: buildOperatorBrief(run),
    maintenance_refresh: buildMaintenanceRefresh(run),
    recovery: buildRecoveryPolicy(run)
  };
}

