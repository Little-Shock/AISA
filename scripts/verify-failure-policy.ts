import assert from "node:assert/strict";
import { createRunFailureSignal } from "../packages/domain/src/index.js";
import {
  getFailurePolicyMatrix,
  pickPrimaryFailureSignal
} from "../packages/orchestrator/src/failure-policy.js";

async function main(): Promise<void> {
  const matrix = getFailurePolicyMatrix();
  const coveredFailureClasses = matrix.map((entry) => entry.failure_class);
  const expectedFailureClasses = [
    "preflight_blocked",
    "runtime_verification_failed",
    "adversarial_verification_failed",
    "handoff_incomplete",
    "working_context_degraded",
    "run_brief_degraded"
  ] as const;

  assert.deepEqual(
    [...coveredFailureClasses].sort(),
    [...expectedFailureClasses].sort(),
    "failure policy matrix must cover every declared run failure class"
  );
  assert.equal(
    new Set(coveredFailureClasses).size,
    coveredFailureClasses.length,
    "failure policy matrix must not duplicate failure classes"
  );

  const byClass = new Map(matrix.map((entry) => [entry.failure_class, entry]));
  assert.equal(byClass.get("preflight_blocked")?.policy_mode, "fail_closed");
  assert.equal(byClass.get("runtime_verification_failed")?.policy_mode, "fail_closed");
  assert.equal(byClass.get("adversarial_verification_failed")?.policy_mode, "fail_closed");
  assert.equal(byClass.get("handoff_incomplete")?.policy_mode, "fail_closed");
  assert.equal(byClass.get("working_context_degraded")?.policy_mode, "soft_degrade");
  assert.equal(byClass.get("run_brief_degraded")?.policy_mode, "soft_degrade");

  const chosenSignal = pickPrimaryFailureSignal(
    createRunFailureSignal({
      failure_class: "working_context_degraded",
      policy_mode: "soft_degrade",
      source_kind: "working_context",
      source_ref: "runs/run_1/working-context.json",
      summary: "working context degraded"
    }),
    createRunFailureSignal({
      failure_class: "adversarial_verification_failed",
      policy_mode: "fail_closed",
      source_kind: "adversarial_verification",
      source_ref: "runs/run_1/attempts/att_1/artifacts/adversarial-verification.json",
      failure_code: "non_happy_path_failed",
      summary: "adversarial verification failed"
    })
  );

  assert.equal(
    chosenSignal?.failure_class,
    "adversarial_verification_failed",
    "pickPrimaryFailureSignal must prefer the stricter policy from the matrix"
  );

  console.log(
    JSON.stringify(
      {
        suite: "failure-policy",
        status: "passed",
        entries: matrix.length
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
