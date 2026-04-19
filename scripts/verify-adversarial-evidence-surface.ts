import assert from "node:assert/strict";
import type { AttemptAdversarialVerification } from "../packages/domain/src/index.ts";
import { assessVerifierKitAdversarialFocus } from "../packages/orchestrator/src/index.ts";

type CaseResult = {
  id: string;
  status: "pass" | "fail";
  error?: string;
};

const neutralChecks: AttemptAdversarialVerification["checks"] = [
  {
    code: "non_happy_path",
    status: "passed",
    message: "The repeated probe stayed green."
  }
];

const neutralCommands: AttemptAdversarialVerification["commands"] = [
  {
    purpose: "run neutral probe",
    command: "node scripts/probe-neutral.mjs",
    cwd: "/tmp/aisa-neutral",
    exit_code: 0,
    status: "passed",
    output_ref: "/tmp/aisa-neutral/probe.out"
  }
];

async function verifyStructuredTargetSurfacePassesWithoutMagicKeywords(): Promise<void> {
  const assessment = assessVerifierKitAdversarialFocus({
    verifierKit: "repo",
    targetSurface: "repo",
    summary: "The repeated probe passed.",
    checks: neutralChecks,
    commands: neutralCommands
  });

  assert.equal(assessment.ok, true);
  assert.equal(assessment.check.status, "passed");
  assert.match(assessment.check.message, /target_surface repo/u);
}

async function verifyMismatchedTargetSurfaceFailsWithoutMagicKeywords(): Promise<void> {
  const assessment = assessVerifierKitAdversarialFocus({
    verifierKit: "repo",
    targetSurface: "api",
    summary: "The repeated probe passed.",
    checks: neutralChecks,
    commands: neutralCommands
  });

  assert.equal(assessment.ok, false);
  assert.equal(assessment.check.status, "failed");
  assert.match(assessment.check.message, /expected "repo"/u);
}

async function verifyMismatchedTargetSurfaceIsNotRescuedByKeywords(): Promise<void> {
  const assessment = assessVerifierKitAdversarialFocus({
    verifierKit: "repo",
    targetSurface: "api",
    summary: "The workspace replay changed the expected file.",
    checks: neutralChecks,
    commands: neutralCommands
  });

  assert.equal(assessment.ok, false);
  assert.equal(assessment.check.status, "failed");
  assert.match(assessment.check.message, /declared target_surface "api"/u);
}

async function verifyLegacyKeywordStillPasses(): Promise<void> {
  const assessment = assessVerifierKitAdversarialFocus({
    verifierKit: "repo",
    targetSurface: null,
    summary: "The workspace replay changed the expected file.",
    checks: neutralChecks,
    commands: neutralCommands
  });

  assert.equal(assessment.ok, true);
  assert.equal(assessment.check.status, "passed");
  assert.match(assessment.check.message, /keyword/u);
}

async function main(): Promise<void> {
  const cases = [
    {
      id: "structured_target_surface_passes_without_magic_keywords",
      run: verifyStructuredTargetSurfacePassesWithoutMagicKeywords
    },
    {
      id: "mismatched_target_surface_fails_without_magic_keywords",
      run: verifyMismatchedTargetSurfaceFailsWithoutMagicKeywords
    },
    {
      id: "mismatched_target_surface_is_not_rescued_by_keywords",
      run: verifyMismatchedTargetSurfaceIsNotRescuedByKeywords
    },
    {
      id: "legacy_keyword_still_passes",
      run: verifyLegacyKeywordStillPasses
    }
  ];
  const results: CaseResult[] = [];

  for (const testCase of cases) {
    try {
      await testCase.run();
      results.push({ id: testCase.id, status: "pass" });
    } catch (error) {
      results.push({
        id: testCase.id,
        status: "fail",
        error: error instanceof Error ? (error.stack ?? error.message) : String(error)
      });
    }
  }

  for (const result of results) {
    console.log(`${result.status.toUpperCase()} ${result.id}`);
    if (result.error) {
      console.log(result.error);
    }
  }

  const failures = results.filter((result) => result.status === "fail");
  if (failures.length > 0) {
    throw new Error(`${failures.length} adversarial evidence surface checks failed.`);
  }

  console.log("VERDICT: PASS");
}

await main();
