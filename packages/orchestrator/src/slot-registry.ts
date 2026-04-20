import {
  canonicalizeRunHarnessSlotBinding,
  resolveRunHarnessProfile,
  type ExecutionVerifierKit,
  type Run,
  type RunHarnessSlot,
  type RunHarnessSlotBinding
} from "@autoresearch/domain";
import { supportsRunHarnessSlotWorkerAdapterType } from "@autoresearch/worker-adapters";

export type RunHarnessSlotBindingStatus = "aligned" | "binding_mismatch";
export type RunHarnessSlotPermissionBoundary =
  | "read_only"
  | "workspace_write"
  | "control_plane_only";
export type RunHarnessSlotFailureSemantics = "fail_closed" | "fail_open";

export type RunHarnessSlotRegistryEntry = {
  slot: RunHarnessSlot;
  title: string;
  default_binding: RunHarnessSlotBinding;
  detail: string;
  input_contract: string[];
  permission_boundary: RunHarnessSlotPermissionBoundary;
  output_artifacts: string[];
  failure_semantics: RunHarnessSlotFailureSemantics;
};

export type RunHarnessSlotBindingView = {
  slot: RunHarnessSlot;
  title: string;
  binding: RunHarnessSlotBinding;
  expected_binding: RunHarnessSlotBinding;
  binding_status: RunHarnessSlotBindingStatus;
  binding_matches_registry: boolean;
  source: string;
  detail: string;
  input_contract: string[];
  permission_boundary: RunHarnessSlotPermissionBoundary;
  output_artifacts: string[];
  failure_semantics: RunHarnessSlotFailureSemantics;
};

export type RunHarnessSlotsView = {
  research_or_planning: RunHarnessSlotBindingView;
  execution: RunHarnessSlotBindingView & {
    default_verifier_kit: ExecutionVerifierKit;
  };
  preflight_review: RunHarnessSlotBindingView;
  postflight_review: RunHarnessSlotBindingView;
  final_synthesis: RunHarnessSlotBindingView;
};

export type RunHarnessSlotBindingResolution =
  | {
      ok: true;
      slot: RunHarnessSlot;
      binding: RunHarnessSlotBinding;
      expected_binding: RunHarnessSlotBinding;
      source: string;
      detail: string;
      failure_semantics: RunHarnessSlotFailureSemantics;
    }
  | {
      ok: false;
      slot: RunHarnessSlot;
      binding: RunHarnessSlotBinding;
      expected_binding: RunHarnessSlotBinding;
      source: string;
      detail: string;
      failure_semantics: RunHarnessSlotFailureSemantics;
      failure_reason: string;
    };

const RUN_HARNESS_SLOT_REGISTRY: Record<RunHarnessSlot, RunHarnessSlotRegistryEntry> = {
  research_or_planning: {
    slot: "research_or_planning",
    title: "Research Or Planning",
    default_binding: "research_worker",
    detail: "Read-only repository understanding, planning, and next-contract drafting.",
    input_contract: [
      "run summary and current decision snapshot",
      "workspace context and evidence refs",
      "current objective and success criteria"
    ],
    permission_boundary: "read_only",
    output_artifacts: ["result.json", "attempt_contract.json when execution is recommended"],
    failure_semantics: "fail_open"
  },
  execution: {
    slot: "execution",
    title: "Execution",
    default_binding: "execution_worker",
    detail: "Workspace-writing implementation step locked behind the attempt contract.",
    input_contract: [
      "attempt_contract.json with replayable verification commands",
      "attempt context and workspace root",
      "current run policy and approval state"
    ],
    permission_boundary: "workspace_write",
    output_artifacts: ["result.json", "worker-declared artifacts under artifacts/"],
    failure_semantics: "fail_closed"
  },
  preflight_review: {
    slot: "preflight_review",
    title: "Preflight Review",
    default_binding: "attempt_dispatch_preflight",
    detail: "Dispatch-time shadow check for contract readiness, toolchain, and live workspace state.",
    input_contract: [
      "attempt_contract.json",
      "workspace root and git checkpoint probe",
      "verification command readiness assessment"
    ],
    permission_boundary: "read_only",
    output_artifacts: ["artifacts/preflight-evaluation.json"],
    failure_semantics: "fail_closed"
  },
  postflight_review: {
    slot: "postflight_review",
    title: "Postflight Review",
    default_binding: "attempt_adversarial_verification",
    detail: "Clean read-only adversarial verifier after deterministic runtime verification passes.",
    input_contract: [
      "attempt_contract.json",
      "artifacts/runtime-verification.json",
      "execution worker result and declared artifacts"
    ],
    permission_boundary: "read_only",
    output_artifacts: ["artifacts/adversarial-verification.json"],
    failure_semantics: "fail_closed"
  },
  final_synthesis: {
    slot: "final_synthesis",
    title: "Final Synthesis",
    default_binding: "attempt_evaluation_synthesizer",
    detail: "Structured evaluation and handoff shaping for operator-facing truth surfaces.",
    input_contract: [
      "review packet and reviewer opinions",
      "runtime and adversarial verification artifacts",
      "handoff refs and current decision snapshot"
    ],
    permission_boundary: "control_plane_only",
    output_artifacts: [
      "evaluation.json",
      "review_opinions.ndjson",
      "artifacts/handoff_bundle.json"
    ],
    failure_semantics: "fail_closed"
  }
};

function buildSlotView(
  run: Run,
  slot: RunHarnessSlot
): RunHarnessSlotBindingView {
  const harnessProfile = resolveRunHarnessProfile(run);
  const registryEntry = RUN_HARNESS_SLOT_REGISTRY[slot];
  const binding = harnessProfile.slots[slot].binding;
  const expectedBinding = registryEntry.default_binding;
  const bindingMatchesRegistry =
    canonicalizeRunHarnessSlotBinding(binding) === expectedBinding;

  return {
    slot,
    title: registryEntry.title,
    binding,
    expected_binding: expectedBinding,
    binding_status: bindingMatchesRegistry ? "aligned" : "binding_mismatch",
    binding_matches_registry: bindingMatchesRegistry,
    source: `run.harness_profile.slots.${slot}.binding`,
    detail: registryEntry.detail,
    input_contract: registryEntry.input_contract,
    permission_boundary: registryEntry.permission_boundary,
    output_artifacts: registryEntry.output_artifacts,
    failure_semantics: registryEntry.failure_semantics
  };
}

export function describeRunHarnessSlots(run: Run): RunHarnessSlotsView {
  const harnessProfile = resolveRunHarnessProfile(run);

  return {
    research_or_planning: buildSlotView(run, "research_or_planning"),
    execution: {
      ...buildSlotView(run, "execution"),
      default_verifier_kit: harnessProfile.execution.default_verifier_kit
    },
    preflight_review: buildSlotView(run, "preflight_review"),
    postflight_review: buildSlotView(run, "postflight_review"),
    final_synthesis: buildSlotView(run, "final_synthesis")
  };
}

export function getRunHarnessSlotRegistryEntry(
  slot: RunHarnessSlot
): RunHarnessSlotRegistryEntry {
  return RUN_HARNESS_SLOT_REGISTRY[slot];
}

export function resolveRunHarnessSlotBinding(input: {
  run: Run;
  slot: RunHarnessSlot;
  workerAdapterType?: string | null;
}): RunHarnessSlotBindingResolution {
  const view = buildSlotView(input.run, input.slot);
  if (!view.binding_matches_registry) {
    return {
      ok: false,
      slot: view.slot,
      binding: view.binding,
      expected_binding: view.expected_binding,
      source: view.source,
      detail: view.detail,
      failure_semantics: view.failure_semantics,
      failure_reason: [
        `Run harness slot ${view.slot} is bound to ${view.binding},`,
        `but this stage requires ${view.expected_binding}.`,
        "Dispatch failed closed before the slot could run."
      ].join(" ")
    };
  }

  if (
    !supportsRunHarnessSlotWorkerAdapterType({
      slot: input.slot,
      workerAdapterType: input.workerAdapterType
    })
  ) {
    return {
      ok: false,
      slot: view.slot,
      binding: view.binding,
      expected_binding: view.expected_binding,
      source: view.source,
      detail: view.detail,
      failure_semantics: view.failure_semantics,
      failure_reason: [
        `Run harness slot ${view.slot} is configured for ${view.binding},`,
        `but the active worker adapter is ${input.workerAdapterType ?? "missing"}.`,
        "Dispatch failed closed before the slot could run."
      ].join(" ")
    };
  }

  return {
    ok: true,
    slot: view.slot,
    binding: view.binding,
    expected_binding: view.expected_binding,
    source: view.source,
    detail: view.detail,
    failure_semantics: view.failure_semantics
  };
}
