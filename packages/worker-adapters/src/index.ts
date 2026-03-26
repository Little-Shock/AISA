import { createWriteStream, constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  realpath,
  readFile,
  readlink,
  symlink,
  writeFile
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type {
  Attempt,
  AttemptContract,
  Branch,
  ContextSnapshot,
  Goal,
  Run,
  WorkerWriteback
} from "@autoresearch/domain";
import {
  WorkerArtifactTypeValues,
  WorkerFindingTypeValues,
  WorkerWritebackSchema
} from "@autoresearch/domain";
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
}

export interface BranchExecutionResult {
  writeback: WorkerWriteback;
  reportMarkdown: string;
  exitCode: number;
}

const RESEARCH_ALLOWED_COMMANDS = [
  "awk",
  "basename",
  "cat",
  "cut",
  "dirname",
  "find",
  "git",
  "grep",
  "head",
  "jq",
  "ls",
  "nl",
  "readlink",
  "realpath",
  "rg",
  "sed",
  "sort",
  "stat",
  "tail",
  "uniq",
  "wc",
  "xargs"
] as const;

const RESEARCH_BLOCKED_COMMANDS = [
  "bun",
  "next",
  "node",
  "npm",
  "npx",
  "pnpm",
  "python",
  "python3",
  "tsx",
  "ts-node",
  "uv",
  "vite",
  "yarn"
] as const;

export interface ResearchShellGuard {
  binDir: string;
  zdotdir: string;
  env: NodeJS.ProcessEnv;
  allowedCommands: string[];
  blockedCommands: string[];
}

export function resolveSandboxForAttempt(
  sandbox: CodexCliConfig["sandbox"],
  attemptType: Attempt["attempt_type"]
): CodexCliConfig["sandbox"] {
  if (attemptType !== "execution") {
    return sandbox;
  }

  return sandbox === "read-only" ? "workspace-write" : sandbox;
}

export function buildAttemptModeRules(
  attemptType: Attempt["attempt_type"]
): string[] {
  if (attemptType === "execution") {
    return [
      "- You may modify files only within the provided workspace to complete the task.",
      "- Keep the change as small as possible and leave clear verification evidence.",
      "- Follow the replayable verification commands already locked into the attempt contract.",
      "- Do not claim tests or verification passed unless those contract commands would pass when the runtime replays them."
    ];
  }

  return [
    "- Work in read-only analysis mode. Do not modify files in the workspace.",
    "- Prefer file inspection and simple read-only shell commands over build or package-script execution.",
    "- Do not run package scripts, tsx, dev servers, or long-running processes during research.",
    "- The runtime exposes only a restricted read-only shell path during research, so package managers and script runners are blocked.",
    "- If you recommend execution next, include next_attempt_contract with replayable verification commands instead of vague advice."
  ];
}

export async function prepareResearchShellGuard(input: {
  artifactsDir: string;
  baseEnv: NodeJS.ProcessEnv;
}): Promise<ResearchShellGuard> {
  const guardRoot = join(input.artifactsDir, "research-shell");
  const binDir = join(guardRoot, "bin");
  const zdotdir = join(guardRoot, "zdotdir");
  const shellEnvFile = join(guardRoot, "shell-env.sh");
  const basePath = input.baseEnv.PATH ?? process.env.PATH ?? "";
  const allowedCommands: string[] = [];

  await mkdir(binDir, { recursive: true });
  await mkdir(zdotdir, { recursive: true });

  for (const command of RESEARCH_ALLOWED_COMMANDS) {
    const commandPath = await resolveCommandPath(command, basePath);
    if (!commandPath) {
      continue;
    }

    await ensureResearchShellCommandLink(join(binDir, command), commandPath);
    allowedCommands.push(command);
  }

  for (const command of RESEARCH_BLOCKED_COMMANDS) {
    const wrapperPath = join(binDir, command);
    await writeFile(
      wrapperPath,
      [
        "#!/bin/sh",
        `echo \"AISA research mode blocks ${command}. Use file inspection now and leave command execution for an execution attempt.\" >&2`,
        "exit 64"
      ].join("\n"),
      "utf8"
    );
    await chmod(wrapperPath, 0o755);
  }

  const shellEnv = [
    `export PATH="${binDir}"`,
    "export AISA_ATTEMPT_MODE=research"
  ].join("\n");

  await Promise.all([
    writeFile(shellEnvFile, `${shellEnv}\n`, "utf8"),
    writeFile(join(zdotdir, ".zshenv"), `${shellEnv}\n`, "utf8"),
    writeFile(join(zdotdir, ".zprofile"), `${shellEnv}\n`, "utf8"),
    writeFile(join(zdotdir, ".zshrc"), `${shellEnv}\n`, "utf8"),
    writeJsonFile(join(guardRoot, "policy.json"), {
      mode: "research",
      allowed_commands: allowedCommands,
      blocked_commands: [...RESEARCH_BLOCKED_COMMANDS]
    })
  ]);

  return {
    binDir,
    zdotdir,
    env: {
      ...input.baseEnv,
      ZDOTDIR: zdotdir,
      BASH_ENV: shellEnvFile,
      ENV: shellEnvFile,
      AISA_ATTEMPT_MODE: "research"
    },
    allowedCommands,
    blockedCommands: [...RESEARCH_BLOCKED_COMMANDS]
  };
}

async function ensureResearchShellCommandLink(
  linkPath: string,
  targetPath: string
): Promise<void> {
  try {
    await symlink(targetPath, linkPath);
    return;
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
  }

  const existingEntry = await lstat(linkPath);
  if (!existingEntry.isSymbolicLink()) {
    throw new Error(
      `Research shell guard expected ${linkPath} to stay a symlink. Remove the unexpected file before retrying.`
    );
  }

  const existingTarget = await readlink(linkPath);
  if (existingTarget !== targetPath) {
    throw new Error(
      `Research shell guard expected ${linkPath} to target ${targetPath}, found ${existingTarget}.`
    );
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
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

      child.stdout.on("data", (chunk) => {
        stdoutStream.write(chunk);
      });

      child.stderr.on("data", (chunk) => {
        stderrStream.write(chunk);
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        resolve(code ?? 1);
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });

    await Promise.all([closeStream(stdoutStream), closeStream(stderrStream)]);

    if (exitCode !== 0) {
      throw new Error(
        await buildCodexFailureMessage({
          stderrFile: branchPaths.stderrFile,
          defaultMessage: `Codex CLI exited with code ${exitCode} for branch ${branch.id}`
        })
      );
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
    attemptContract: AttemptContract;
    context: unknown;
    workspacePaths: WorkspacePaths;
  }): Promise<BranchExecutionResult> {
    const { run, attempt, attemptContract, context, workspacePaths } = input;
    const attemptPaths = resolveAttemptPaths(workspacePaths, run.id, attempt.id);
    const outputFile = join(attemptPaths.attemptDir, "codex-output.json");
    const promptFile = join(attemptPaths.attemptDir, "worker-prompt.md");
    const sandbox = resolveSandboxForAttempt(
      this.config.sandbox,
      attempt.attempt_type
    );

    await mkdir(attemptPaths.artifactsDir, { recursive: true });

    const prompt = buildCodexAttemptPrompt(run, attempt, attemptContract, context);
    await Promise.all([
      writeJsonFile(attemptPaths.contextFile, context),
      writeJsonFile(join(attemptPaths.attemptDir, "task-spec.json"), {
        run_id: run.id,
        attempt_id: attempt.id,
        attempt_type: attempt.attempt_type,
        workspace_root: attempt.workspace_root,
        objective: attempt.objective,
        success_criteria: attempt.success_criteria,
        attempt_contract: attemptContract
      }),
      writeTextFile(promptFile, prompt)
    ]);

    const args = [
      "exec",
      "-C",
      attempt.workspace_root,
      "-s",
      sandbox,
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
    let env: NodeJS.ProcessEnv = {
      ...process.env
    };

    if (attempt.attempt_type === "research") {
      env = (await prepareResearchShellGuard({
        artifactsDir: attemptPaths.artifactsDir,
        baseEnv: env
      })).env;
    }

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(this.config.command, args, {
        cwd: workspacePaths.rootDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false
      });

      child.stdout.on("data", (chunk) => {
        stdoutStream.write(chunk);
      });

      child.stderr.on("data", (chunk) => {
        stderrStream.write(chunk);
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        resolve(code ?? 1);
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });

    await Promise.all([closeStream(stdoutStream), closeStream(stderrStream)]);

    if (exitCode !== 0) {
      throw new Error(
        await buildCodexFailureMessage({
          stderrFile: attemptPaths.stderrFile,
          defaultMessage: `Codex CLI exited with code ${exitCode} for attempt ${attempt.id}`
        })
      );
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
    skipGitRepoCheck: env.CODEX_SKIP_GIT_REPO_CHECK !== "false"
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
    "- Write all user-facing natural language fields in concise Chinese.",
    "- Keep JSON keys, enum-like machine values, file paths, shell commands, and evidence strings stable when they must stay machine-readable.",
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
        summary: "简短摘要",
        findings: [
          {
            type: "fact",
            content: "你确认的事实",
            evidence: ["relative/path/or/command"]
          }
        ],
        questions: ["仍待确认的问题"],
        recommended_next_steps: ["最值得做的下一步"],
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
  attemptContract: AttemptContract,
  context: unknown
): string {
  const workerFindingTypes = formatQuotedValues(WorkerFindingTypeValues);
  const workerArtifactTypes = formatQuotedValues(WorkerArtifactTypeValues);
  const executionArtifactExample = {
    type: "patch",
    path: "runs/<run_id>/attempts/<attempt_id>/artifacts/diff.patch"
  };

  return [
    "You are a Codex CLI worker inside AISA.",
    "",
    "Rules:",
    ...buildAttemptModeRules(attempt.attempt_type),
    "- Use local repository evidence whenever possible.",
    "- If evidence is weak or missing, say so explicitly.",
    "- Write all user-facing natural language fields in concise Chinese.",
    "- Keep JSON keys, enum-like machine values, file paths, shell commands, and evidence strings stable when they must stay machine-readable.",
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
    "Attempt Contract:",
    JSON.stringify(attemptContract, null, 2),
    "",
    "Success Criteria:",
    ...attempt.success_criteria.map((criterion) => `- ${criterion}`),
    "",
    "Current Context:",
    JSON.stringify(context, null, 2),
    "",
    attempt.attempt_type === "execution"
      ? "The runtime will replay the commands already locked in the attempt contract and only trust those observed results."
      : null,
    attempt.attempt_type === "execution"
      ? "Do not replace the contract verification plan with a different one after execution starts."
      : null,
    attempt.attempt_type === "execution"
      ? `Allowed findings.type values: ${workerFindingTypes}. Do not invent values like "gap".`
      : null,
    attempt.attempt_type === "execution"
      ? `artifacts must be an array of objects with stable keys. Allowed artifacts[].type values: ${workerArtifactTypes}.`
      : null,
    attempt.attempt_type === "execution"
      ? `Copy this artifacts object shape when you have one: ${JSON.stringify(executionArtifactExample)}`
      : null,
    attempt.attempt_type === "execution"
      ? 'Do not return artifacts as plain strings like "artifacts/diff.patch".'
      : null,
    attempt.attempt_type === "research"
      ? "If you recommend execution next, include next_attempt_contract with replayable verification commands."
      : null,
    "",
    "Return JSON in this shape:",
    JSON.stringify(
      {
        summary: "简短摘要",
        findings: [
          {
            type: "fact",
            content: "你确认的事实",
            evidence: ["relative/path/or/command"]
          }
        ],
        questions: ["仍待确认的问题"],
        recommended_next_steps: ["最值得做的下一步"],
        confidence: 0.72,
        next_attempt_contract:
          attempt.attempt_type === "research"
            ? {
                attempt_type: "execution",
                objective: "做出最小且有价值的改动",
                success_criteria: ["留下可以工作的实现步骤"],
                required_evidence: [
                  "git-visible workspace changes",
                  "a replayable verification command that checks the changed behavior"
                ],
                forbidden_shortcuts: [
                  "do not claim success without runnable verification"
                ],
                expected_artifacts: ["changed files visible in git"],
                verification_plan: {
                  commands: [
                    {
                      purpose: "verify the changed behavior",
                      command: "pnpm verify:runtime"
                    }
                  ]
                }
              }
            : undefined,
        verification_plan:
          attempt.attempt_type === "execution"
            ? {
                commands: [
                  {
                    purpose: "verify the changed behavior",
                    command: "pnpm verify:runtime"
                  }
                ]
              }
            : undefined,
        artifacts:
          attempt.attempt_type === "execution" ? [executionArtifactExample] : []
      },
      null,
      2
    )
  ].join("\n");
}

function formatQuotedValues(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

function parseWritebackFromText(text: string): WorkerWriteback {
  const trimmed = text.trim();
  const candidate = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;

  return WorkerWritebackSchema.parse(JSON.parse(candidate));
}

async function resolveCommandPath(
  commandName: string,
  pathValue: string
): Promise<string | null> {
  for (const segment of pathValue.split(":")) {
    if (!segment) {
      continue;
    }

    const candidate = join(segment, commandName);
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      continue;
    }
  }

  return null;
}

async function closeStream(stream: {
  end: (callback?: () => void) => void;
  once: (event: string, listener: (error: Error) => void) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

async function buildCodexFailureMessage(input: {
  stderrFile: string;
  defaultMessage: string;
}): Promise<string> {
  const stderr = await readFile(input.stderrFile, "utf8").catch(() => "");
  const excerpt = summarizeCodexStderr(stderr);

  return excerpt ? `${input.defaultMessage}\n${excerpt}` : input.defaultMessage;
}

function summarizeCodexStderr(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  const ignoredPatterns = [
    /^deprecated:/i,
    /^mcp startup:/i,
    /^tokens used$/i,
    /^warning: no last agent message/i,
    /^reconnecting\.\.\./i
  ];
  const preferredPatterns = [
    /^ERROR:/i,
    /^Error:/,
    /unexpected status/i,
    /unauthorized/i,
    /forbidden/i,
    /invalid token/i,
    /listen EPERM/i,
    /AISA research mode blocks/i
  ];

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (ignoredPatterns.some((pattern) => pattern.test(line))) {
      continue;
    }

    if (preferredPatterns.some((pattern) => pattern.test(line))) {
      return `执行器错误输出：${line}`;
    }
  }

  let fallback: string | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (ignoredPatterns.some((pattern) => pattern.test(line))) {
      continue;
    }

    fallback = line;
    break;
  }

  return fallback ? `执行器错误输出：${fallback}` : null;
}

function buildBranchReportMarkdown(
  goal: Goal,
  branch: Branch,
  writeback: WorkerWriteback
): string {
  return [
    `# 分支报告：${branch.id}`,
    "",
    `- 目标：${goal.title}`,
    `- 假设：${branch.hypothesis}`,
    `- 任务：${branch.objective}`,
    `- 置信度：${writeback.confidence}`,
    "",
    "## 摘要",
    "",
    writeback.summary,
    "",
    "## 发现",
    "",
    ...(writeback.findings.length > 0
      ? writeback.findings.flatMap((finding) => [
          `- [${finding.type}] ${finding.content}`,
          ...finding.evidence.map((evidence) => `  - 证据：${evidence}`)
        ])
      : ["- 还没有记录发现。"]),
    "",
    "## 待确认问题",
    "",
    ...(writeback.questions.length > 0
      ? writeback.questions.map((question) => `- ${question}`)
      : ["- 暂无。"]),
    "",
    "## 建议的下一步",
    "",
    ...(writeback.recommended_next_steps.length > 0
      ? writeback.recommended_next_steps.map((step) => `- ${step}`)
      : ["- 暂无。"]),
    "",
    "## 回放验证计划",
    "",
    ...(writeback.verification_plan?.commands.length
      ? writeback.verification_plan.commands.map(
          (command) => `- ${command.purpose}：${command.command}`
        )
      : ["- 暂无。"])
  ].join("\n");
}

function buildAttemptReportMarkdown(
  run: Run,
  attempt: Attempt,
  writeback: WorkerWriteback
): string {
  return [
    `# 尝试报告：${attempt.id}`,
    "",
    `- 运行任务：${run.title}`,
    `- 类型：${attempt.attempt_type}`,
    `- 任务：${attempt.objective}`,
    `- 置信度：${writeback.confidence}`,
    "",
    "## 摘要",
    "",
    writeback.summary,
    "",
    "## 发现",
    "",
    ...(writeback.findings.length > 0
      ? writeback.findings.flatMap((finding) => [
          `- [${finding.type}] ${finding.content}`,
          ...finding.evidence.map((evidence) => `  - 证据：${evidence}`)
        ])
      : ["- 还没有记录发现。"]),
    "",
    "## 待确认问题",
    "",
    ...(writeback.questions.length > 0
      ? writeback.questions.map((question) => `- ${question}`)
      : ["- 暂无。"]),
    "",
    "## 建议的下一步",
    "",
    ...(writeback.recommended_next_steps.length > 0
      ? writeback.recommended_next_steps.map((step) => `- ${step}`)
      : ["- 暂无。"])
  ].join("\n");
}
