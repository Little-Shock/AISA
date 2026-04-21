import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2] ?? "";
const provider = String(process.env.AISA_LLM_PROVIDER ?? "").trim().toLowerCase();
const model = readOptionalEnv("AISA_LLM_MODEL");
const reasoningEffort = readOptionalEnv("AISA_LLM_REASONING_EFFORT");
let stdinBuffer = "";

const STRUCTURED_JUDGMENT_SCHEMA = {
  type: "object",
  properties: {
    goal_progress: {
      type: "number",
      minimum: 0,
      maximum: 1
    },
    evidence_quality: {
      type: "number",
      minimum: 0,
      maximum: 1
    },
    verification_status: {
      type: "string",
      enum: ["passed", "failed", "not_applicable"]
    },
    recommendation: {
      type: "string",
      enum: ["continue", "wait_human", "complete", "retry"]
    },
    suggested_attempt_type: {
      anyOf: [
        {
          type: "string",
          enum: ["research", "execution"]
        },
        {
          type: "null"
        }
      ]
    },
    rationale: {
      type: "string"
    },
    missing_evidence: {
      type: "array",
      items: {
        type: "string"
      }
    }
  },
  required: [
    "goal_progress",
    "evidence_quality",
    "verification_status",
    "recommendation",
    "suggested_attempt_type",
    "rationale",
    "missing_evidence"
  ],
  additionalProperties: false
};

const JUDGE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    structured_judgment: STRUCTURED_JUDGMENT_SCHEMA
  },
  required: ["structured_judgment"],
  additionalProperties: false
};

const STRUCTURED_DECISION_SCHEMA = {
  type: "object",
  properties: {
    decision: {
      type: "string",
      enum: ["approve", "reject"]
    },
    rationale: {
      type: "string"
    },
    follow_up: {
      type: "array",
      items: {
        type: "string"
      }
    }
  },
  required: ["decision", "rationale", "follow_up"],
  additionalProperties: false
};

const LEADER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    structured_decision: STRUCTURED_DECISION_SCHEMA
  },
  required: ["structured_decision"],
  additionalProperties: false
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
});
process.stdin.on("end", () => {
  void main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
});

async function main() {
  if (!["reviewer", "synthesizer", "leader-approver"].includes(mode)) {
    throw new Error(
      'Usage: node scripts/llm-judge-cli.mjs <reviewer|synthesizer|leader-approver>'
    );
  }

  if (!provider || !["codex", "gemini"].includes(provider)) {
    throw new Error("AISA_LLM_PROVIDER must be set to codex or gemini.");
  }

  const payload = parseJson(stdinBuffer, "stdin payload");
  const prompt =
    mode === "reviewer"
      ? buildReviewerPrompt(payload)
      : mode === "synthesizer"
        ? buildSynthesizerPrompt(payload)
        : buildLeaderApproverPrompt(payload);
  const outputSchema = mode === "leader-approver" ? LEADER_OUTPUT_SCHEMA : JUDGE_OUTPUT_SCHEMA;
  const providerResult =
    provider === "codex"
      ? await runCodexJson({
          prompt,
          model,
          reasoningEffort,
          outputSchema
        })
      : await runGeminiJson({
          prompt,
          model
        });
  const response =
    mode === "leader-approver"
      ? {
          provider,
          model,
          reasoning_effort: reasoningEffort,
          provider_raw_output: providerResult.raw_output,
          tool_call_count: providerResult.toolCallCount,
          structured_decision: normalizeStructuredDecision(
            providerResult.parsed?.structured_decision
          )
        }
      : mode === "reviewer"
        ? {
            provider,
            model,
            provider_raw_output: providerResult.raw_output,
            tool_call_count: providerResult.toolCallCount,
            structured_judgment: normalizeStructuredJudgment(
              providerResult.parsed?.structured_judgment
            ),
            proposed_next_contract: payload?.result?.next_attempt_contract ?? null
          }
        : {
            provider,
            model,
            provider_raw_output: providerResult.raw_output,
            tool_call_count: providerResult.toolCallCount,
            structured_judgment: normalizeStructuredJudgment(
              providerResult.parsed?.structured_judgment
            )
          };

  process.stdout.write(JSON.stringify(response, null, 2));
}

function buildReviewerPrompt(reviewInputPacket) {
  return [
    "You are a strict AISA attempt reviewer.",
    "Read only the JSON packet from stdin context.",
    "Do not use tools.",
    "Do not invent evidence outside the packet.",
    "Return exactly one JSON object with this shape:",
    JSON.stringify(JUDGE_OUTPUT_SCHEMA, null, 2),
    "Guidance:",
    "- goal_progress and evidence_quality must be 0..1 numbers.",
    '- verification_status must be one of "passed", "failed", "not_applicable".',
    '- recommendation must be one of "continue", "wait_human", "complete", "retry".',
    '- suggested_attempt_type must be "research", "execution", or null.',
    "- rationale must be concise and grounded in the packet.",
    "- missing_evidence must list only concrete missing evidence.",
    "Review packet JSON:",
    JSON.stringify(reviewInputPacket, null, 2)
  ].join("\n\n");
}

function buildSynthesizerPrompt(synthesisPacket) {
  return [
    "You are the final AISA evaluation synthesizer.",
    "Read only the JSON packet from stdin context.",
    "Do not use tools.",
    "Do not invent evidence outside the packet or reviewer opinions.",
    "The deterministic base evaluation is the hard runtime gate. It will be enforced again after your output.",
    "Your job is to reconcile reviewer opinions into one final structured judgment.",
    "Return exactly one JSON object with this shape:",
    JSON.stringify(JUDGE_OUTPUT_SCHEMA, null, 2),
    "Guidance:",
    "- Keep rationale concise, specific, and tied to the packet and reviewer opinions.",
    "- missing_evidence should merge concrete gaps, not repeat generic filler.",
    "- suggested_attempt_type must reflect the next best move if the loop should continue.",
    "Synthesis packet JSON:",
    JSON.stringify(synthesisPacket, null, 2)
  ].join("\n\n");
}

function buildLeaderApproverPrompt(approvalPacket) {
  return [
    "You are a strict AISA leader approval lane.",
    "Read only the JSON packet from stdin context.",
    "Do not use tools.",
    "Do not invent evidence outside the packet.",
    "Default to reject if the plan is not bounded, replayable, or clearly justified.",
    "Return exactly one JSON object with this shape:",
    JSON.stringify(LEADER_OUTPUT_SCHEMA, null, 2),
    "Guidance:",
    '- decision must be "approve" or "reject".',
    "- rationale must be concise and grounded in the packet.",
    "- follow_up should list concrete next evidence gaps or execution cautions.",
    "Approval packet JSON:",
    JSON.stringify(approvalPacket, null, 2)
  ].join("\n\n");
}

async function runCodexJson(input) {
  const tempDir = await mkdtemp(join(tmpdir(), "aisa-codex-judge-"));
  const schemaFile = join(tempDir, "schema.json");
  const lastMessageFile = join(tempDir, "last-message.json");

  try {
    await writeFile(schemaFile, JSON.stringify(input.outputSchema), "utf8");
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-c",
      'approval_policy="never"',
      "--output-schema",
      schemaFile,
      "-o",
      lastMessageFile,
      "-"
    ];
    if (input.reasoningEffort) {
      args.splice(8, 0, "-c", `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`);
    }
    if (input.model) {
      args.splice(2, 0, "--model", input.model);
    }

    const commandResult = await runCommand({
      command: "codex",
      args,
      stdin: input.prompt
    });
    const lastMessage = await readFile(lastMessageFile, "utf8");
    const toolCallCount = countCodexToolCalls(commandResult.stdout);

    if (toolCallCount > 0) {
      throw new Error(`Codex judge unexpectedly used ${toolCallCount} tool call(s).`);
    }

    return {
      parsed: parseJson(lastMessage, "codex last message"),
      raw_output: commandResult.stdout,
      toolCallCount
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runGeminiJson(input) {
  const args = [
    "--yolo",
    "--output-format",
    "json",
    "-p",
    "Read the full stdin prompt and return exactly one JSON object."
  ];
  if (input.model) {
    args.splice(1, 0, "--model", input.model);
  }

  const commandResult = await runCommand({
    command: "gemini",
    args,
    stdin: input.prompt
  });
  const envelope = parseJson(commandResult.stdout, "gemini json envelope");
  const responseText = unwrapJsonEnvelopeResponse(envelope);
  const toolCallCount = Number(envelope?.stats?.tools?.totalCalls ?? 0);

  if (toolCallCount > 0) {
    throw new Error(`Gemini judge unexpectedly used ${toolCallCount} tool call(s).`);
  }

  return {
    parsed: parseJson(responseText, "gemini response"),
    raw_output: commandResult.stdout,
    toolCallCount
  };
}

async function runCommand(input) {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      if (exitCode !== 0 || signal) {
        reject(
          new Error(
            [
              `Command failed: ${[input.command, ...input.args].join(" ")}`,
              `exit_code=${exitCode ?? "null"}`,
              signal ? `signal=${signal}` : null,
              stdout.trim().length > 0 ? `stdout:\n${stdout.trim()}` : null,
              stderr.trim().length > 0 ? `stderr:\n${stderr.trim()}` : null
            ]
              .filter(Boolean)
              .join("\n\n")
          )
        );
        return;
      }

      resolve({
        stdout,
        stderr
      });
    });
    child.stdin.end(input.stdin);
  });
}

function countCodexToolCalls(stdout) {
  let count = 0;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const event = JSON.parse(trimmed);
      if (event?.type === "item.completed" && event?.item?.type !== "agent_message") {
        count += 1;
      }
    } catch {
      continue;
    }
  }

  return count;
}

function unwrapJsonEnvelopeResponse(envelope) {
  const response = typeof envelope?.response === "string" ? envelope.response.trim() : "";
  if (!response) {
    throw new Error("Gemini json envelope did not include a response string.");
  }

  const fencedMatch = response.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : response;
}

function normalizeStructuredJudgment(value) {
  if (!isRecord(value)) {
    throw new Error("structured_judgment must be a JSON object.");
  }

  const goalProgress = readNumber(value.goal_progress, "goal_progress");
  const evidenceQuality = readNumber(value.evidence_quality, "evidence_quality");
  const verificationStatus = readEnum(
    value.verification_status,
    "verification_status",
    ["passed", "failed", "not_applicable"]
  );
  const recommendation = readEnum(
    value.recommendation,
    "recommendation",
    ["continue", "wait_human", "complete", "retry"]
  );
  const suggestedAttemptType =
    value.suggested_attempt_type === null
      ? null
      : readEnum(
          value.suggested_attempt_type,
          "suggested_attempt_type",
          ["research", "execution"]
        );
  const rationale = readString(value.rationale, "rationale");
  const missingEvidence = readStringArray(value.missing_evidence, "missing_evidence");

  return {
    goal_progress: goalProgress,
    evidence_quality: evidenceQuality,
    verification_status: verificationStatus,
    recommendation,
    suggested_attempt_type: suggestedAttemptType,
    rationale,
    missing_evidence: missingEvidence
  };
}

function normalizeStructuredDecision(value) {
  if (!isRecord(value)) {
    throw new Error("structured_decision must be a JSON object.");
  }

  return {
    decision: readEnum(value.decision, "decision", ["approve", "reject"]),
    rationale: readString(value.rationale, "rationale"),
    follow_up: readStringArray(value.follow_up, "follow_up")
  };
}

function readNumber(value, key) {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
    throw new Error(`${key} must be a number between 0 and 1.`);
  }

  return value;
}

function readEnum(value, key, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${key} must be one of ${allowed.join(", ")}.`);
  }

  return value;
}

function readString(value, key) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }

  return value;
}

function readStringArray(value, key) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${key} must be an array of strings.`);
  }

  return value;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label}: ${reason}`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalEnv(key) {
  const value = String(process.env[key] ?? "").trim();
  return value.length > 0 ? value : null;
}
