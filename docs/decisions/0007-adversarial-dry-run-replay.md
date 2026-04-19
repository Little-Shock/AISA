# 0007 Adversarial Dry-Run Replay

## Background

AISA run `run_4a37ff46` exposed repeated orchestration failures that were not caused by one business repository bug. The recurring classes were worker writeback schema drift, unsafe verification contracts, untyped artifact references, runtime promotion blocked by unrelated AISA dirty files, rejected-plan reuse, brittle adversarial evidence wording, missing reusable invariant probes, roadmap overrun risk, and weak worker liveness diagnosis.

## Decision

Add a dry-run strategy comparison script before changing the production run loop. The script turns these historical failure classes into deterministic adversarial probes and compares lightweight, medium, and stronger mitigation strategies for each problem area.

The first implementation is `scripts/verify-adversarial-dry-run.ts`, exposed through `pnpm verify:adversarial-dry-run`.

The first production hardening step from that comparison is structured adversarial focus evidence. `AttemptAdversarialVerification` now accepts optional `target_surface`, and `pnpm verify:adversarial-evidence-surface` verifies that a real adversarial artifact can declare the target surface without relying on magic wording such as `repo`, `git`, `workspace`, `replay`, or `change`. A mismatched `target_surface` fails even if the text contains legacy keywords, so bad structure cannot be rescued by prose.

The script is intentionally read-only. It does not mutate run state, business repositories, or AISA runtime files. When `AISA_ADVERSARIAL_REPLAY_RUN_DIR` points to a real run directory, it also reads `journal.ndjson` and reports observed counts for the relevant failure classes.

## Why This Shape

The next changes should be chosen by replay evidence instead of intuition. A dry-run harness lets the team compare candidate guardrails without prematurely rewriting the orchestrator.

The recommended strategy set must pass every probe before it is considered ready for production implementation. A weaker strategy may remain visible in the report, but it must show which historical probes it misses.

## Follow-Up Direction

The current recommended bundle is:

- constrain worker writeback through schema gates and a contract builder
- lint verification as argv-only and wrap negative paths in verifiers
- split prose from typed artifact references
- separate attached-source promotion from AISA runtime dirtiness
- track rejected-plan lineage with contract hashes
- replace keyword-only adversarial evidence with structured target-surface evidence
- maintain reusable red-team invariant packs
- gate roadmap boundaries with an approved manifest
- diagnose worker stalls through heartbeat and child-process snapshots

Each production change should add a focused verifier that uses the relevant probes from this dry-run script as regression coverage.
