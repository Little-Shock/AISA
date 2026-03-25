# Eval Plan

## Target

- Name: `AISA run loop`
- Type: `workflow`

## Goal

Build a reusable runtime regression layer for `AISA run loop` that catches orchestration, recovery, artifact, and terminal-state failures before release.

## Scope

- In:
  - run lifecycle contract
  - deterministic runtime smoke cases
  - failure taxonomy for restart, artifact, and terminal-state bugs
  - regression gates for backend changes
- Out:
  - GUI polish
  - legacy goal or branch behavior unless it can break the run-centered path

## Required Inputs

- target source files
- representative runtime traces
- at least one real or reconstructed failure for each blocker mode
- a deterministic adapter profile for smoke cases

## Eval Assets

- `capability-contract.yaml`
- `failure-modes.yaml`
- `datasets/smoke/*.json`
- `review-packet-schema.json`
- `reports/suite-status.json`
- `scripts/verify-run-loop.ts`

## Dataset Plan

- smoke: 5 examples
- train: prompt drafting and taxonomy shaping
- dev: compare reviewers and thresholds
- test: held-out confirmation before promotion
- adversarial: targeted edge cases for severe failures

Current smoke set:

- `happy-path-run-completes.json`
- `repeated-research-pauses-for-steer.json`
- `research-command-failure-surfaces-blocking-state.json`
- `execution-parse-failure-surfaces-blocking-state.json`
- `orphaned-running-attempt-pauses-for-recovery.json`

## Checks

- deterministic run-status checks
- attempt type and attempt status sequence checks
- journal event count checks
- artifact and blocking-reason checks
- restart recovery checks

## Calibration

- start with deterministic smoke cases as the hard gate
- add human-labeled replay cases once execution verifier behavior gets richer
- reserve LLM judges for semantic outcome checks that cannot be decided from runtime evidence

## Regression

- rerun smoke on every material change
- rerun replay and adversarial sets before cutting a release candidate
- inspect clustered failures, not only aggregate metrics
- require blocker modes to stay at zero failures in smoke

## Open Questions

- When should persisted running attempts become resumable instead of always pausing?
- What is the smallest structured execution artifact schema that still gives trustworthy verification?
