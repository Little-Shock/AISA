# Failure-Mode Reviewer Prompt

You are reviewing `AISA run loop` for exactly one failure mode.

## Failure Mode

- `failure_mode_id`: `plan_order_invalid`
- `surface`: `planning`
- `question`: `Does the plan omit or misorder a critical workflow step before execution or promotion?`

## Task

Inspect the review packet. Decide whether this failure mode is present.

Use only these verdicts:

- `pass`
- `fail`
- `needs_human`

## Review Rules

1. Use evidence from the packet only.
2. Inspect the full trace when the failure depends on process.
3. If required evidence is missing, return `needs_human`.
4. Do not score style, tone, or unrelated quality issues.
5. Do not judge multiple failure modes.

## Output

Return exactly one JSON object:

```json
{
  "verdict": "pass",
  "failure_mode_id": "plan_order_invalid",
  "confidence": "high",
  "evidence": [
    "The workflow plan includes all required gates in the correct order."
  ],
  "rationale": "Short explanation tied to evidence only.",
  "remediation": "Add the missing step or fix the step order before allowing promotion."
}
```
