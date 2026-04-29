# AISA Runtime Environment Roadmap

## Goal

Make every AISA run explain which environment owns which responsibility, and make the runtime refuse stale layout hints that can point a real repo at temporary test roots.

The target state is simple: an operator can open one run and see the source workspace, managed worktree, runtime data root, runtime code root, and latest attempt workspace without guessing.

## Why

The link-to-spec run exposed a real product gap. The implementation itself used the right separation, but the control surface did not explain it well.

AISA currently has several valid roots:

- runtime code repo, where AISA itself runs
- dev/source repo, where the target project changes land
- runtime data root, where runs, attempts, journals, and artifacts live
- managed worktree root, where isolated execution can happen
- outer caller workspace, such as the Discord workspace that started the job

That separation is useful. The problem is that it was implicit. Worse, a gitignored `artifacts/runtime-layout.json` could be written by tests with temporary paths and then read by later default startup. That creates the feeling that multiple environments are randomly participating in one task.

## Current Fix Line

P0 is to stop environment drift from slowing development.

Runtime layout hint persistence now needs to reject the dangerous shape where a persistent runtime repo points to temporary dev, data, or managed workspace roots. Temporary runtime repos used by tests can still persist and read their own hints, so the existing split-lane test model stays valid.

Run detail should expose a `workspace_context` surface. It must show the source workspace, effective workspace, managed workspace, latest attempt workspace, runtime repo, dev repo, runtime data root, and attached project repo when available.

The control API health endpoint already exposes runtime layout. Its tests should assert the managed workspace base root too, so future changes cannot silently hide one of the important roots.

## Roadmap

### R1 Environment Truth Surface

Expose the environment boundary in every operator-facing run detail payload and then consume it in dashboard.

Done means a user can inspect one run and distinguish source repo, runtime data, managed worktree, attempt workspace, and attached project repo without reading logs or knowing internals.

### R2 Hint Safety And Repair

Treat runtime layout hints as durable configuration only when their roots are durable. Test and self-bootstrap temporary roots must not pollute persistent runtime repos.

Done means stale temporary hints are ignored, malformed hints still fail closed, and verification proves both paths.

### R3 Finalization And Archive Semantics

After a run has promoted or completed verified work, make the managed worktree lifecycle explicit.

Done means the run can say whether its managed worktree is active, archived, repaired, or stale, and it never leaves the operator guessing why an old path still exists.

### R4 Commit-Then-Advance Risk Policy

When work is reversible but slightly risky, the default policy is checkpoint first, then continue. Waiting for a person is reserved for irreversible operations, missing credentials, legal/security boundary changes, or source-of-truth conflicts.

Done means AISA creates a recoverable checkpoint before risky local edits and keeps moving, rather than turning recoverable uncertainty into idle time.

### R5 Environment Contract In Tests

Add adversarial tests for transient layout pollution, bad hint parsing, split-lane recovery, run detail boundary payloads, and managed workspace repair visibility.

Done means future regressions cannot reintroduce silent path drift or hide the distinction between runtime, source, data, and worktree roots.

## Acceptance Criteria

AISA is done with this line when a fresh run and an old repaired run both show their environment boundaries clearly, temporary test roots cannot become durable runtime defaults, malformed durable hints still fail loudly, and risky but recoverable development continues after checkpointing instead of waiting for a human.
