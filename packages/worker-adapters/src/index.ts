import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type {
  Attempt,
  Branch,
  ContextSnapshot,
  Goal,
  Run,
  WorkerWriteback
} from "@autoresearch/domain";
import { WorkerWritebackSchema } from "@autoresearch/domain";
import type { WorkspacePaths } from "@autoresearch/state-store";
import {
  resolveAttemptPaths,
  resolveBranchArtifactPaths,
  writeJsonFile,
  writeTextFile
} from "@autoresearch/state-store";

export interface CodexCliConfig {
  command: string;
  model?: string;
  profile?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  skipGitRepoCheck: boolean;
  timeoutMs: number;
}

export interface BranchExecutionResult {
  writeback: WorkerWriteback;
  reportMarkdown: string;
  exitCode: number;
}

export class CodexCliWorkerAdapter {
  readonly type = "codex";

  constructor(private readonly config: CodexCliConfig) {}

  async runBranchTask(input: {
    goal: Goal;
    branch: Branch;
    contextSnapshot: ContextSnapshot;
    workspacePaths: WorkspacePaths;
  }): Promise<BranchExecutionResult> {
    const { goal, branch, contextSnapshot, workspacePaths } = input;
    const branchPaths = resolveBranchArtifactPaths(workspacePaths, goal.id, branch.id);
    const outputFile = join(branchPaths.branchDir, "codex-output.json");
    const promptFile = join(branchPaths.branchDir, "worker-prompt.md");

    await mkdir(branchPaths.outputDir, { recursive: true });

    const prompt = buildCodexWorkerPrompt(goal, branch, contextSnapshot, branchPaths.reportFile);
    await Promise.all([
      writeJsonFile(branchPaths.taskSpecFile, {
        goal_id: goal.id,
        branch_id: branch.id,
        workspace_root: goal.workspace_root,
        hypothesis: branch.hypothesis,
        objective: branch.objective,
        success_criteria: branch.success_criteria,
        context_snapshot_id: contextSnapshot.id
      }),
      writeTextFile(promptFile, prompt)
    ]);

    const args = [
      "exec",
      "-C",
      goal.workspace_root,
      "-s",
      this.config.sandbox,
      "--output-last-message",
      outputFile
    ];

    if (this.config.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }

    if (this.config.profile) {
      args.push("-p", this.config.profile);
    }

    if (this.config.model) {
      args.push("-m", this.config.model);
    }

    args.push("-");

    const stdoutStream = createWriteStream(branchPaths.stdoutFile, { flags: "a" });
    const stderrStream = createWriteStream(branchPaths.stderrFile, { flags: "a" });

    const env = {
      ...process.env
    };

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(this.config.command, args, {
        cwd: workspacePaths.rootDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, this.config.timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdoutStream.write(chunk);
      });

      child.stderr.on("data", (chunk) => {
        stderrStream.write(chunk);
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });

    stdoutStream.end();
    stderrStream.end();

    if (exitCode !== 0) {
      throw new Error(`Codex CLI exited with code ${exitCode} for branch ${branch.id}`);
    }

    const rawOutput = await readFile(outputFile, "utf8");
    const parsed = parseWritebackFromText(rawOutput);
    const reportMarkdown = buildBranchReportMarkdown(goal, branch, parsed);

    await Promise.all([
      writeJsonFile(branchPaths.writebackFile, parsed),
      writeTextFile(branchPaths.reportFile, reportMarkdown)
    ]);

    return {
      writeback: parsed,
      reportMarkdown,
      exitCode
    };
  }

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
    context: unknown;
    workspacePaths: WorkspacePaths;
  }): Promise<BranchExecutionResult> {
    const { run, attempt, context, workspacePaths } = input;
    const attemptPaths = resolveAttemptPaths(workspacePaths, run.id, attempt.id);
    const outputFile = join(attemptPaths.attemptDir, "codex-output.json");
    const promptFile = join(attemptPaths.attemptDir, "worker-prompt.md");

    await mkdir(attemptPaths.artifactsDir, { recursive: true });

    const prompt = buildCodexAttemptPrompt(run, attempt, context);
    await Promise.all([
      writeJsonFile(attemptPaths.contextFile, context),
      writeJsonFile(join(attemptPaths.attemptDir, "task-spec.json"), {
        run_id: run.id,
        attempt_id: attempt.id,
        attempt_type: attempt.attempt_type,
        workspace_root: attempt.workspace_root,
        objective: attempt.objective,
        success_criteria: attempt.success_criteria
      }),
      writeTextFile(promptFile, prompt)
    ]);

    const args = [
      "exec",
      "-C",
      attempt.workspace_root,
      "-s",
      this.config.sandbox,
      "--output-last-message",
      outputFile
    ];

    if (this.config.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }

    if (this.config.profile) {
      args.push("-p", this.config.profile);
    }

    if (this.config.model) {
      args.push("-m", this.config.model);
    }

    args.push("-");

    const stdoutStream = createWriteStream(attemptPaths.stdoutFile, { flags: "a" });
    const stderrStream = createWriteStream(attemptPaths.stderrFile, { flags: "a" });
    const env = {
      ...process.env
    };

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(this.config.command, args, {
        cwd: workspacePaths.rootDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, this.config.timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdoutStream.write(chunk);
      });

      child.stderr.on("data", (chunk) => {
        stderrStream.write(chunk);
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });

    stdoutStream.end();
    stderrStream.end();

    if (exitCode !== 0) {
      throw new Error(`Codex CLI exited with code ${exitCode} for attempt ${attempt.id}`);
    }

    const rawOutput = await readFile(outputFile, "utf8");
    const parsed = parseWritebackFromText(rawOutput);
    const reportMarkdown = buildAttemptReportMarkdown(run, attempt, parsed);

    await Promise.all([
      writeJsonFile(attemptPaths.resultFile, parsed),
      writeTextFile(join(attemptPaths.attemptDir, "report.md"), reportMarkdown)
    ]);

    return {
      writeback: parsed,
      reportMarkdown,
      exitCode
    };
  }
}

export function loadCodexCliConfig(env: NodeJS.ProcessEnv): CodexCliConfig {
  return {
    command: env.CODEX_CLI_COMMAND ?? "codex",
    model: env.CODEX_MODEL,
    profile: env.CODEX_PROFILE,
    sandbox:
      (env.CODEX_SANDBOX as CodexCliConfig["sandbox"] | undefined) ?? "read-only",
    skipGitRepoCheck: env.CODEX_SKIP_GIT_REPO_CHECK !== "false",
    timeoutMs: Number(env.CODEX_TIMEOUT_MS ?? "900000")
  };
}

function buildCodexWorkerPrompt(
  goal: Goal,
  branch: Branch,
  snapshot: ContextSnapshot,
  reportFile: string
): string {
  return [
    "You are a Codex CLI worker inside AutoResearch Swarm Dashboard.",
    "",
    "Rules:",
    "- Work in read-only analysis mode. Do not modify files in the workspace.",
    "- Use local repository evidence whenever possible.",
    "- If evidence is weak or missing, say so explicitly.",
    "- Return only valid JSON with no markdown fences and no extra commentary.",
    "",
    "Goal:",
    `- Title: ${goal.title}`,
    `- Description: ${goal.description}`,
    `- Workspace Root: ${goal.workspace_root}`,
    "",
    "Branch:",
    `- Branch ID: ${branch.id}`,
    `- Hypothesis: ${branch.hypothesis}`,
    `- Objective: ${branch.objective}`,
    "",
    "Success Criteria:",
    ...branch.success_criteria.map((criterion) => `- ${criterion}`),
    "",
    "Current Context Snapshot:",
    JSON.stringify(snapshot, null, 2),
    "",
    "Deliverables:",
    `- A branch report will be generated by the control plane at ${reportFile}.`,
    "- You only need to return structured JSON in this shape:",
    JSON.stringify(
      {
        summary: "short summary",
        findings: [
          {
            type: "fact",
            content: "what you found",
            evidence: ["relative/path/or/command"]
          }
        ],
        questions: ["remaining open question"],
        recommended_next_steps: ["best next step"],
        confidence: 0.72,
        artifacts: []
      },
      null,
      2
    )
  ].join("\n");
}

function buildCodexAttemptPrompt(
  run: Run,
  attempt: Attempt,
  context: unknown
): string {
  const modeLine =
    attempt.attempt_type === "execution"
      ? "- You may modify files only within the provided workspace to complete the task."
      : "- Work in read-only analysis mode. Do not modify files in the workspace.";

  return [
    "You are a Codex CLI worker inside AISA.",
    "",
    "Rules:",
    modeLine,
    "- Use local repository evidence whenever possible.",
    "- If evidence is weak or missing, say so explicitly.",
    "- Return only valid JSON with no markdown fences and no extra commentary.",
    "",
    "Run:",
    `- Title: ${run.title}`,
    `- Description: ${run.description}`,
    `- Workspace Root: ${run.workspace_root}`,
    "",
    "Attempt:",
    `- Attempt ID: ${attempt.id}`,
    `- Type: ${attempt.attempt_type}`,
    `- Objective: ${attempt.objective}`,
    "",
    "Success Criteria:",
    ...attempt.success_criteria.map((criterion) => `- ${criterion}`),
    "",
    "Current Context:",
    JSON.stringify(context, null, 2),
    "",
    "Return JSON in this shape:",
    JSON.stringify(
      {
        summary: "short summary",
        findings: [
          {
            type: "fact",
            content: "what you found",
            evidence: ["relative/path/or/command"]
          }
        ],
        questions: ["remaining open question"],
        recommended_next_steps: ["best next step"],
        confidence: 0.72,
        artifacts: []
      },
      null,
      2
    )
  ].join("\n");
}

function parseWritebackFromText(text: string): WorkerWriteback {
  const trimmed = text.trim();
  const candidate = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;

  return WorkerWritebackSchema.parse(JSON.parse(candidate));
}

function buildBranchReportMarkdown(
  goal: Goal,
  branch: Branch,
  writeback: WorkerWriteback
): string {
  return [
    `# Branch Report: ${branch.id}`,
    "",
    `- Goal: ${goal.title}`,
    `- Hypothesis: ${branch.hypothesis}`,
    `- Objective: ${branch.objective}`,
    `- Confidence: ${writeback.confidence}`,
    "",
    "## Summary",
    "",
    writeback.summary,
    "",
    "## Findings",
    "",
    ...(writeback.findings.length > 0
      ? writeback.findings.flatMap((finding) => [
          `- [${finding.type}] ${finding.content}`,
          ...finding.evidence.map((evidence) => `  - evidence: ${evidence}`)
        ])
      : ["- No findings recorded."]),
    "",
    "## Open Questions",
    "",
    ...(writeback.questions.length > 0
      ? writeback.questions.map((question) => `- ${question}`)
      : ["- None."]),
    "",
    "## Recommended Next Steps",
    "",
    ...(writeback.recommended_next_steps.length > 0
      ? writeback.recommended_next_steps.map((step) => `- ${step}`)
      : ["- None."])
  ].join("\n");
}

function buildAttemptReportMarkdown(
  run: Run,
  attempt: Attempt,
  writeback: WorkerWriteback
): string {
  return [
    `# Attempt Report: ${attempt.id}`,
    "",
    `- Run: ${run.title}`,
    `- Type: ${attempt.attempt_type}`,
    `- Objective: ${attempt.objective}`,
    `- Confidence: ${writeback.confidence}`,
    "",
    "## Summary",
    "",
    writeback.summary,
    "",
    "## Findings",
    "",
    ...(writeback.findings.length > 0
      ? writeback.findings.flatMap((finding) => [
          `- [${finding.type}] ${finding.content}`,
          ...finding.evidence.map((evidence) => `  - evidence: ${evidence}`)
        ])
      : ["- No findings recorded."]),
    "",
    "## Open Questions",
    "",
    ...(writeback.questions.length > 0
      ? writeback.questions.map((question) => `- ${question}`)
      : ["- None."]),
    "",
    "## Recommended Next Steps",
    "",
    ...(writeback.recommended_next_steps.length > 0
      ? writeback.recommended_next_steps.map((step) => `- ${step}`)
      : ["- None."])
  ].join("\n");
}
