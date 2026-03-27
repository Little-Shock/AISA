let input = "";
const mode = process.argv[2] ?? "success";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  try {
    const reviewInputPacket = JSON.parse(input);
    const proposedNextContract = reviewInputPacket?.result?.next_attempt_contract ?? null;
    const attemptId = reviewInputPacket?.attempt_id;

    if (typeof attemptId !== "string" || attemptId.length === 0) {
      throw new Error("review_input_packet.attempt_id is required");
    }

    if (mode === "invalid_json") {
      process.stdout.write("{not valid json");
      return;
    }

    if (mode === "nonzero_exit") {
      process.stderr.write("cli reviewer forced non-zero exit\n");
      process.exitCode = 17;
      return;
    }

    if (mode === "timeout") {
      setTimeout(() => {}, 10_000);
      return;
    }

    process.stdout.write(
      JSON.stringify(
        {
          received_attempt_id: attemptId,
          structured_judgment: {
            goal_progress: 0.58,
            evidence_quality: 0.74,
            verification_status: "not_applicable",
            recommendation: "continue",
            suggested_attempt_type: "execution",
            rationale: `cli reviewer checked ${attemptId}`,
            missing_evidence: ["Need runtime replay once execution lands."]
          },
          proposed_next_contract: proposedNextContract
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
