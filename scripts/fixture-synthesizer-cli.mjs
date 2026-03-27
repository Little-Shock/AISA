let input = "";
const mode = process.argv[2] ?? "success";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  try {
    const synthesisPacket = JSON.parse(input);
    const attemptId = synthesisPacket?.review_input_packet?.attempt_id;

    if (typeof attemptId !== "string" || attemptId.length === 0) {
      throw new Error("review_input_packet.attempt_id is required");
    }

    if (mode === "invalid_json") {
      process.stdout.write("{not valid json");
      return;
    }

    if (mode === "nonzero_exit") {
      process.stderr.write("cli synthesizer forced non-zero exit\n");
      process.exitCode = 23;
      return;
    }

    process.stdout.write(
      JSON.stringify(
        {
          received_attempt_id: attemptId,
          structured_judgment: {
            goal_progress: 0.91,
            evidence_quality: 0.87,
            verification_status:
              synthesisPacket?.deterministic_base_evaluation?.verification_status ??
              "not_applicable",
            recommendation: "continue",
            suggested_attempt_type: "execution",
            rationale: `cli synthesizer reconciled ${attemptId}`,
            missing_evidence: ["Need execution replay after implementation lands."]
          }
        },
        null,
        2
      )
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
});
