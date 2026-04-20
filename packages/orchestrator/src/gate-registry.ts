import {
  resolveRunHarnessProfile,
  type Run,
  type RunHarnessGate,
  type RunHarnessGateMode
} from "@autoresearch/domain";

export type RunHarnessGatePhase = "dispatch" | "runtime" | "postflight";

export type RunHarnessGateRegistryEntry = {
  gate: RunHarnessGate;
  title: string;
  default_mode: "required";
  detail: string;
  phase: RunHarnessGatePhase;
  artifact_ref: string;
};

export type RunHarnessGateView = RunHarnessGateRegistryEntry & {
  mode: RunHarnessGateMode;
  enforced: boolean;
  source: string;
};

export type RunHarnessGatesView = {
  preflight_review: RunHarnessGateView;
  deterministic_runtime: RunHarnessGateView;
  postflight_adversarial: RunHarnessGateView;
};

const RUN_HARNESS_GATE_REGISTRY: Record<RunHarnessGate, RunHarnessGateRegistryEntry> = {
  preflight_review: {
    gate: "preflight_review",
    title: "Preflight Gate",
    default_mode: "required",
    detail:
      "Shadow-dispatch gate that validates the execution contract, toolchain, and git baseline before workspace write begins.",
    phase: "dispatch",
    artifact_ref: "artifacts/preflight-evaluation.json"
  },
  deterministic_runtime: {
    gate: "deterministic_runtime",
    title: "Deterministic Runtime Gate",
    default_mode: "required",
    detail:
      "Hard replay gate that reruns the locked verification commands and checks git-visible change after execution.",
    phase: "runtime",
    artifact_ref: "artifacts/runtime-verification.json"
  },
  postflight_adversarial: {
    gate: "postflight_adversarial",
    title: "Postflight Adversarial Gate",
    default_mode: "required",
    detail:
      "Clean read-only second gate after deterministic replay that produces a machine-readable adversarial verification artifact.",
    phase: "postflight",
    artifact_ref: "artifacts/adversarial-verification.json"
  }
};

function resolveGateMode(run: Run, gate: RunHarnessGate): RunHarnessGateMode {
  const harnessProfile = resolveRunHarnessProfile(run);

  switch (gate) {
    case "preflight_review":
      return harnessProfile.gates.preflight_review.mode;
    case "deterministic_runtime":
      return harnessProfile.gates.deterministic_runtime.mode;
    case "postflight_adversarial":
      return harnessProfile.gates.postflight_adversarial.mode;
  }
}

function buildGateView(run: Run, gate: RunHarnessGate): RunHarnessGateView {
  const entry = RUN_HARNESS_GATE_REGISTRY[gate];
  const mode = resolveGateMode(run, gate);

  return {
    ...entry,
    mode,
    enforced: mode === "required",
    source: `run.harness_profile.gates.${gate}.mode`
  };
}

export function describeRunHarnessGates(run: Run): RunHarnessGatesView {
  return {
    preflight_review: buildGateView(run, "preflight_review"),
    deterministic_runtime: buildGateView(run, "deterministic_runtime"),
    postflight_adversarial: buildGateView(run, "postflight_adversarial")
  };
}
