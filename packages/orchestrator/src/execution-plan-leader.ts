import { spawn } from "node:child_process";

export type ExecutionPlanLeaderPacket = {
  run_id: string;
  run_title: string;
  run_description: string;
  current_summary: string | null;
  current_blocking_reason: string | null;
  proposed_signature: string;
  proposed_attempt_type: "execution";
  proposed_objective: string;
  proposed_success_criteria: string[];
  permission_profile: "workspace_write";
  hook_policy: "enforce_runtime_contract";
  danger_mode: string;
  verifier_kit: string | null;
  verification_commands: string[];
  source_attempt_id: string | null;
  source_ref: string | null;
};

export type ExecutionPlanLeaderDecision = {
  decision: "approve" | "reject";
  rationale: string;
  follow_up: string[];
};

export interface ExecutionPlanLeaderAdapter {
  readonly actor: string;
  reviewExecutionPlan(input: {
    approvalPacket: ExecutionPlanLeaderPacket;
  }): Promise<{
    raw_output: string;
    structured_decision: ExecutionPlanLeaderDecision;
  }>;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_PROVIDER = "codex";
const DEFAULT_REASONING_EFFORT = "xhigh";
const DEFAULT_SCRIPT_URL = new URL("../../../scripts/llm-judge-cli.mjs", import.meta.url);

export function createCliExecutionPlanLeaderAdapter(): ExecutionPlanLeaderAdapter {
  const provider =
    readOptionalEnv("AISA_EXECUTION_LEADER_PROVIDER")?.toLowerCase() ?? DEFAULT_PROVIDER;
  const model = readOptionalEnv("AISA_EXECUTION_LEADER_MODEL");
  const reasoningEffort =
    readOptionalEnv("AISA_EXECUTION_LEADER_REASONING_EFFORT") ??
    DEFAULT_REASONING_EFFORT;
  const actor = [
    "leader-agent",
    provider,
    model ?? "default",
    reasoningEffort
  ].join("/");

  return {
    actor,
    async reviewExecutionPlan({ approvalPacket }) {
      const commandResult = await runCommand({
        command: "node",
        args: [DEFAULT_SCRIPT_URL.pathname, "leader-approver"],
        env: {
          ...process.env,
          AISA_LLM_PROVIDER: provider,
          ...(model ? { AISA_LLM_MODEL: model } : {}),
          ...(reasoningEffort
            ? { AISA_LLM_REASONING_EFFORT: reasoningEffort }
            : {})
        },
        stdin: JSON.stringify(approvalPacket, null, 2),
        timeoutMs: DEFAULT_TIMEOUT_MS
      });

      return {
        raw_output: commandResult.stdout,
        structured_decision: parseLeaderDecision(commandResult.stdout)
      };
    }
  };
}

async function runCommand(input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
}): Promise<{
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: process.cwd(),
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Leader approval command timed out after ${input.timeoutMs}ms.`));
    }, input.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if ((code ?? 1) !== 0) {
        reject(
          new Error(
            stderr.trim() ||
              `Leader approval command exited with code ${code ?? "unknown"}.`
          )
        );
        return;
      }

      resolve({
        stdout,
        stderr
      });
    });
    child.stdin.on("error", () => {
      // child may exit before stdin drains
    });
    child.stdin.end(input.stdin);
  });
}

function parseLeaderDecision(stdout: string): ExecutionPlanLeaderDecision {
  const parsed = parseJson(stdout, "leader approval output");
  if (!isRecord(parsed)) {
    throw new Error("Leader approval output must be an object.");
  }

  const decision = parsed.structured_decision;
  if (!isRecord(decision)) {
    throw new Error("Leader approval output must contain structured_decision.");
  }

  const normalizedDecision =
    decision.decision === "approve" || decision.decision === "reject"
      ? decision.decision
      : null;
  if (!normalizedDecision) {
    throw new Error('Leader approval decision must be "approve" or "reject".');
  }

  const rationale =
    typeof decision.rationale === "string" ? decision.rationale.trim() : "";
  if (!rationale) {
    throw new Error("Leader approval rationale must be a non-empty string.");
  }

  const rawFollowUp = decision.follow_up;
  const followUp = Array.isArray(rawFollowUp)
    ? rawFollowUp
        .filter((item: unknown): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];

  return {
    decision: normalizedDecision,
    rationale,
    follow_up: followUp
  };
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} must be valid JSON: ${reason}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readOptionalEnv(name: string): string | null {
  const value = process.env[name];
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
