# Reviewer Spec

## Target

- Name: `AISA run loop`
- Type: `workflow`

## Purpose

Review one failure mode at a time for `AISA run loop`. The reviewer must inspect the full review packet, cite concrete evidence, and return a structured verdict.

## Allowed Verdicts

- `pass`
- `fail`
- `needs_human`

Do not assign numeric scores.

## Input Contract

The reviewer receives one review packet that contains:

- the user request or task prompt
- the selected target
- the full trace when process matters
- the final output
- artifact contents or a manifest
- target metadata

The reviewer must fail closed when required evidence is missing.

## Review Procedure

1. Confirm the packet has the evidence required for the failure mode.
2. Inspect only the assigned failure mode.
3. Use direct evidence from the packet.
4. If the packet is ambiguous, return `needs_human`.
5. Produce one structured result and stop.

## Output Schema

Return exactly one JSON object with these keys:

```json
{
  "verdict": "pass",
  "failure_mode_id": "outcome_goal_not_met",
  "confidence": "high",
  "evidence": [
    "trace step 7 skipped validation",
    "final output omitted the required schema field"
  ],
  "rationale": "Short explanation tied to evidence only.",
  "remediation": "Concrete next fix or next human check."
}
```

## Guardrails

- Never grade multiple failure modes in one pass.
- Never infer success from a confident tone in the final answer.
- Prefer `needs_human` over guessing.
- Quote or paraphrase evidence from the packet, not prior expectations.

## Calibration Notes

- Maintain separate train, dev, and test sets.
- Track TPR, TNR, and abstention rate.
- Recalibrate after target, trace, or prompt changes.
