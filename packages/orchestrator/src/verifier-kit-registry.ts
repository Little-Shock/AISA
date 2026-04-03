import {
  resolveRunHarnessProfile,
  type AttemptAdversarialVerification,
  type AttemptContract,
  type AttemptRuntimeVerification,
  type ExecutionVerifierKit,
  type ExecutionVerifierKitCommandPolicy,
  type Run
} from "@autoresearch/domain";

export type ExecutionVerifierKitRegistryEntry = {
  kit: ExecutionVerifierKit;
  title: string;
  detail: string;
  command_policy: ExecutionVerifierKitCommandPolicy;
  preflight_expectations: string[];
  runtime_expectations: string[];
  adversarial_focus: string[];
};

export type ExecutionVerifierKitView = ExecutionVerifierKitRegistryEntry & {
  source: string;
};

const EXECUTION_VERIFIER_KIT_REGISTRY: Record<
  ExecutionVerifierKit,
  ExecutionVerifierKitRegistryEntry
> = {
  repo: {
    kit: "repo",
    title: "Repository Task",
    detail:
      "Repository-facing execution can infer replay from local workspace scripts when the repo toolchain is already present.",
    command_policy: "workspace_script_inference",
    preflight_expectations: [
      "Read package.json scripts before auto-inferring replay commands.",
      "Fail closed when repo-local node_modules are missing for inferred pnpm replay."
    ],
    runtime_expectations: [
      "Leave git-visible changed files tied to the execution objective.",
      "Replay deterministic workspace scripts or contract-locked commands from the repo root."
    ],
    adversarial_focus: [
      "Probe repo-local toolchain assumptions and replay drift.",
      "Check that the claimed implementation still survives a second pass in the same workspace."
    ]
  },
  web: {
    kit: "web",
    title: "Web App Task",
    detail:
      "Web execution must lock explicit browser, UI, or frontend replay commands into the contract instead of guessing them from workspace scripts.",
    command_policy: "contract_locked_commands",
    preflight_expectations: [
      "Require explicit browser, UI, or frontend replay commands in attempt_contract.json.",
      "Do not auto-infer generic repo scripts as a substitute for web acceptance coverage."
    ],
    runtime_expectations: [
      "Replay the contract-locked UI or frontend checks exactly as written.",
      "Leave artifacts that point at the visible surface or frontend state that changed."
    ],
    adversarial_focus: [
      "Probe broken interaction paths, stale render states, or missing user-visible evidence.",
      "Look for UI regressions that deterministic command replay did not spell out."
    ]
  },
  api: {
    kit: "api",
    title: "API Task",
    detail:
      "API execution must lock explicit service or HTTP replay commands into the contract and treat those requests as the acceptance boundary.",
    command_policy: "contract_locked_commands",
    preflight_expectations: [
      "Require explicit HTTP, service, or endpoint replay commands in attempt_contract.json.",
      "Do not auto-infer repo scripts as a stand-in for endpoint coverage."
    ],
    runtime_expectations: [
      "Replay the contract-locked API checks against the declared target.",
      "Leave artifacts that preserve the observed API behavior and failure boundary."
    ],
    adversarial_focus: [
      "Probe error paths, malformed input handling, and boundary responses.",
      "Check that the API contract still holds outside the single happy path."
    ]
  },
  cli: {
    kit: "cli",
    title: "CLI Task",
    detail:
      "CLI execution must lock explicit command invocations and expected exits into the contract instead of relying on repo-wide defaults.",
    command_policy: "contract_locked_commands",
    preflight_expectations: [
      "Require explicit CLI replay commands with stable cwd and exit expectations.",
      "Do not auto-infer repo scripts as a substitute for CLI acceptance behavior."
    ],
    runtime_expectations: [
      "Replay the contract-locked command-line invocations exactly as frozen before dispatch.",
      "Leave logs or artifacts that prove the CLI behavior matched the contract."
    ],
    adversarial_focus: [
      "Probe bad flags, missing arguments, and repeated invocation behavior.",
      "Check that the CLI still fails and recovers the way the contract expects."
    ]
  }
};

export function getExecutionVerifierKitRegistryEntry(
  kit: ExecutionVerifierKit
): ExecutionVerifierKitRegistryEntry {
  return EXECUTION_VERIFIER_KIT_REGISTRY[kit];
}

export function executionVerifierKitAllowsWorkspaceScriptInference(
  kit: ExecutionVerifierKit
): boolean {
  return getExecutionVerifierKitRegistryEntry(kit).command_policy === "workspace_script_inference";
}

export function describeExecutionVerifierKit(input: {
  kit: ExecutionVerifierKit;
  source: string;
}): ExecutionVerifierKitView {
  return {
    ...getExecutionVerifierKitRegistryEntry(input.kit),
    source: input.source
  };
}

export function describeRunDefaultVerifierKit(run: Run): ExecutionVerifierKitView {
  const harnessProfile = resolveRunHarnessProfile(run);

  return describeExecutionVerifierKit({
    kit: harnessProfile.execution.default_verifier_kit,
    source: "run.harness_profile.execution.default_verifier_kit"
  });
}

export function describeAttemptEffectiveVerifierKit(input: {
  attemptType: AttemptContract["attempt_type"];
  attemptContract?: Pick<AttemptContract, "attempt_type" | "verifier_kit"> | null;
  runtimeVerification?: Pick<AttemptRuntimeVerification, "verifier_kit"> | null;
  adversarialVerification?: Pick<AttemptAdversarialVerification, "verifier_kit"> | null;
  fallbackKit: ExecutionVerifierKit;
}): ExecutionVerifierKitView | null {
  if (input.attemptType !== "execution") {
    return null;
  }

  const sources = [
    {
      kit: input.attemptContract?.verifier_kit ?? null,
      source: "attempt_contract.verifier_kit"
    },
    {
      kit: input.runtimeVerification?.verifier_kit ?? null,
      source: "runtime_verification.verifier_kit"
    },
    {
      kit: input.adversarialVerification?.verifier_kit ?? null,
      source: "adversarial_verification.verifier_kit"
    }
  ];
  const selectedSource = sources.find((entry) => entry.kit !== null);

  return describeExecutionVerifierKit({
    kit: selectedSource?.kit ?? input.fallbackKit,
    source:
      selectedSource?.source ?? "run.harness_profile.execution.default_verifier_kit"
  });
}
