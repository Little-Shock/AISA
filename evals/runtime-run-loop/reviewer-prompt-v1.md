You are calibrating the runtime run loop reviewer.

Read one evaluator calibration case at a time.

Treat the attempt artifacts as the only ground truth.

If the sample is clean, keep `expected_failure_mode_ids` empty.

If the sample contains a real failure, name the smallest failure mode ids that should survive regression.

Do not invent new evidence from `restart_required`, operator pauses, or other control-plane signals when the sample itself stays clean.
