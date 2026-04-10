import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createAttachedProjectCapabilitySnapshot,
  type AttachedProjectCapabilityCommandCheck,
  type AttachedProjectCapabilityReason,
  type AttachedProjectCapabilitySnapshot,
  type AttachedProjectCapabilityTool,
  type AttachedProjectProfile
} from "@autoresearch/domain";
import type { RunWorkspaceScopePolicy } from "./workspace-scope.js";

type WorkerAdapterCapabilityInput = {
  type: string;
  command: string;
  model?: string | null;
};

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export async function captureAttachedProjectCapabilitySnapshot(input: {
  project: AttachedProjectProfile;
  policy: RunWorkspaceScopePolicy;
  executionAdapter: WorkerAdapterCapabilityInput;
}): Promise<AttachedProjectCapabilitySnapshot> {
  const workerAdapter = await describeWorkerAdapterCapability(
    input.executionAdapter
  );
  const toolchain = await describeToolchainCapability(input.project);
  const verificationCommands = await describeVerificationCommandCapability(
    input.project,
    toolchain
  );
  const blockingReasons: AttachedProjectCapabilityReason[] = [];
  const researchBlockingReasons: AttachedProjectCapabilityReason[] = [];
  const executionBlockingReasons: AttachedProjectCapabilityReason[] = [];

  if (!workerAdapter.available) {
    researchBlockingReasons.push(...workerAdapter.blocking_reasons);
    executionBlockingReasons.push(...workerAdapter.blocking_reasons);
  }

  if (!toolchain.git.available) {
    const reason = buildReason(
      "git_unavailable",
      "Git is unavailable, so AISA cannot safely manage this project workspace."
    );
    researchBlockingReasons.push(reason);
    executionBlockingReasons.push(reason);
  }

  for (const tool of Object.values(toolchain) as AttachedProjectCapabilityTool[]) {
    if (!tool.required || tool.available || !tool.reason) {
      continue;
    }

    executionBlockingReasons.push(
      buildReason("missing_local_verifier_toolchain", tool.reason)
    );
  }

  for (const commandCheck of verificationCommands) {
    if (commandCheck.status === "blocked" && commandCheck.reason_code) {
      executionBlockingReasons.push(
        buildReason(commandCheck.reason_code, commandCheck.summary)
      );
    }
  }

  blockingReasons.push(...dedupeReasons(researchBlockingReasons, executionBlockingReasons));
  const overallStatus =
    blockingReasons.length > 0
      ? researchBlockingReasons.length > 0
        ? "blocked"
        : "degraded"
      : "ready";

  return createAttachedProjectCapabilitySnapshot({
    project_id: input.project.id,
    workspace_root: input.project.workspace_root,
    overall_status: overallStatus,
    blocking_reasons: blockingReasons,
    workspace_scope: {
      within_allowed_scope: input.policy.allowedRoots.some((scopeRoot) =>
        input.project.workspace_root === scopeRoot ||
        input.project.workspace_root.startsWith(`${scopeRoot}/`)
      ),
      matched_scope_root:
        input.policy.allowedRoots.find((scopeRoot) =>
          input.project.workspace_root === scopeRoot ||
          input.project.workspace_root.startsWith(`${scopeRoot}/`)
        ) ?? null,
      summary: `Workspace is attached at ${input.project.workspace_root}.`
    },
    worker_adapter: workerAdapter,
    toolchain,
    verification_commands: verificationCommands,
    launch_readiness: {
      research: {
        attempt_type: "research",
        status: researchBlockingReasons.length > 0 ? "blocked" : "ready",
        summary:
          researchBlockingReasons.length > 0
            ? researchBlockingReasons.map((reason) => reason.message).join(" ")
            : "Research launch is ready.",
        blocking_reasons: researchBlockingReasons
      },
      execution: {
        attempt_type: "execution",
        status: executionBlockingReasons.length > 0 ? "blocked" : "ready",
        summary:
          executionBlockingReasons.length > 0
            ? executionBlockingReasons.map((reason) => reason.message).join(" ")
            : "Execution launch is ready.",
        blocking_reasons: executionBlockingReasons
      }
    }
  });
}

async function describeWorkerAdapterCapability(
  input: WorkerAdapterCapabilityInput
): Promise<AttachedProjectCapabilitySnapshot["worker_adapter"]> {
  const entrypoint = parseCommandEntrypoint(input.command);
  const available = entrypoint ? await canRunCommand(entrypoint) : false;
  const blockingReasons = available
    ? []
    : [
        buildReason(
          "worker_adapter_command_unavailable",
          `Execution adapter command is unavailable: ${input.command}.`
        )
      ];

  return {
    type: input.type,
    command: input.command,
    model: input.model ?? null,
    available,
    summary: available
      ? `Execution adapter command is available: ${entrypoint}.`
      : `Execution adapter command is unavailable: ${input.command}.`,
    blocking_reasons: blockingReasons
  };
}

async function describeToolchainCapability(
  project: AttachedProjectProfile
): Promise<AttachedProjectCapabilitySnapshot["toolchain"]> {
  const toolSpecs = [
    { key: "git", required: true, commands: ["git"] },
    {
      key: "node",
      required: project.project_type === "node_repo",
      commands: ["node"]
    },
    {
      key: "pnpm",
      required:
        project.project_type === "node_repo" && project.package_manager === "pnpm",
      commands: ["pnpm"]
    },
    {
      key: "npm",
      required:
        project.project_type === "node_repo" &&
        (project.package_manager === "npm" || project.package_manager === null),
      commands: ["npm"]
    },
    {
      key: "python",
      required: project.project_type === "python_repo",
      commands: ["python3", "python"]
    },
    {
      key: "pip",
      required:
        project.project_type === "python_repo" &&
        (project.package_manager === "pip" || project.package_manager === null),
      commands: ["pip3", "pip"]
    },
    {
      key: "poetry",
      required:
        project.project_type === "python_repo" && project.package_manager === "poetry",
      commands: ["poetry"]
    },
    {
      key: "uv",
      required:
        project.project_type === "python_repo" && project.package_manager === "uv",
      commands: ["uv"]
    },
    {
      key: "go",
      required: project.project_type === "go_repo",
      commands: ["go"]
    }
  ] as const;

  const resolved = await Promise.all(
    toolSpecs.map(async (spec) => {
      const version = await readFirstAvailableCommandVersion(spec.commands);
      const available = version !== null;
      const capability: AttachedProjectCapabilityTool = {
        tool: spec.key,
        required: spec.required,
        available,
        version,
        reason:
          spec.required && !available
            ? `${spec.key} is required for ${project.project_type} but is unavailable.`
            : null
      };
      return [spec.key, capability] as const;
    })
  );

  return Object.fromEntries(resolved) as AttachedProjectCapabilitySnapshot["toolchain"];
}

async function describeVerificationCommandCapability(
  project: AttachedProjectProfile,
  toolchain: AttachedProjectCapabilitySnapshot["toolchain"]
): Promise<AttachedProjectCapabilityCommandCheck[]> {
  const checks: AttachedProjectCapabilityCommandCheck[] = [];
  const commandEntries = [
    ["install", project.default_commands.install],
    ["build", project.default_commands.build],
    ["test", project.default_commands.test],
    ["lint", project.default_commands.lint],
    ["start", project.default_commands.start]
  ] as const;

  for (const [label, command] of commandEntries) {
    if (!command) {
      checks.push({
        label,
        command: null,
        entrypoint: null,
        status: "not_applicable",
        summary: `${label} command is not defined for this project.`,
        reason_code: null
      });
      continue;
    }

    const entrypoint = command.trim().split(/\s+/u)[0] ?? null;
    if (!entrypoint) {
      checks.push({
        label,
        command,
        entrypoint: null,
        status: "blocked",
        summary: `${label} command is empty and cannot be replayed.`,
        reason_code: "verification_command_not_runnable"
      });
      continue;
    }

    const available = await canRunCommand(entrypoint);
    if (!available) {
      checks.push({
        label,
        command,
        entrypoint,
        status: "blocked",
        summary: `${label} command cannot run because ${entrypoint} is unavailable.`,
        reason_code: "verification_command_not_runnable"
      });
      continue;
    }

    if (
      project.project_type === "node_repo" &&
      ["build", "test", "lint", "start"].includes(label) &&
      usesNodePackageManagerCommand(entrypoint)
    ) {
      const nodeModulesPresent = await directoryExists(
        join(project.workspace_root, "node_modules")
      );
      if (!nodeModulesPresent) {
        checks.push({
          label,
          command,
          entrypoint,
          status: "blocked",
          summary:
            `${label} command expects local package dependencies, but node_modules is missing in ${project.workspace_root}.`,
          reason_code: "missing_local_verifier_toolchain"
        });
        continue;
      }
    }

    const missingToolReason = project.project_type === "node_repo"
      ? entrypoint === "pnpm" && !toolchain.pnpm.available
      : project.project_type === "python_repo"
        ? (entrypoint === "python" || entrypoint === "python3") && !toolchain.python.available
        : project.project_type === "go_repo"
          ? entrypoint === "go" && !toolchain.go.available
          : false;

    if (missingToolReason) {
      checks.push({
        label,
        command,
        entrypoint,
        status: "blocked",
        summary: `${label} command is configured but its required toolchain is unavailable.`,
        reason_code: "missing_local_verifier_toolchain"
      });
      continue;
    }

    checks.push({
      label,
      command,
      entrypoint,
      status: "ready",
      summary: `${label} command is runnable from the current environment.`,
      reason_code: null
    });
  }

  return checks;
}

function usesNodePackageManagerCommand(entrypoint: string): boolean {
  const packageManagers = new Set(["pnpm", "npm", "yarn", "bun"]);
  return packageManagers.has(entrypoint);
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const fileStat = await stat(path);
    return fileStat.isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }

    throw error;
  }
}

async function readFirstAvailableCommandVersion(
  commands: readonly string[]
): Promise<string | null> {
  for (const command of commands) {
    const version = await readCommandVersion(command);
    if (version) {
      return version;
    }
  }

  return null;
}

async function readCommandVersion(command: string): Promise<string | null> {
  const result = await runCommand(command, ["--version"]).catch(() => null);
  if (!result || result.exitCode !== 0) {
    return null;
  }
  const line = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ?? null;
}

async function canRunCommand(command: string): Promise<boolean> {
  const result = await runCommand(command, ["--version"]).catch(() => null);
  return Boolean(result && result.exitCode === 0);
}

function parseCommandEntrypoint(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed.split(/\s+/u)[0] ?? null;
}

function buildReason(
  code: string,
  message: string
): AttachedProjectCapabilityReason {
  return {
    code,
    message
  };
}

function dedupeReasons(
  ...groups: AttachedProjectCapabilityReason[][]
): AttachedProjectCapabilityReason[] {
  const seen = new Set<string>();
  const deduped: AttachedProjectCapabilityReason[] = [];

  for (const group of groups) {
    for (const reason of group) {
      const key = `${reason.code}:${reason.message}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(reason);
    }
  }

  return deduped;
}

async function runCommand(
  command: string,
  args: string[]
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
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
    child.on("error", () => {
      resolve({
        exitCode: 127,
        stdout,
        stderr
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stdout,
        stderr
      });
    });
  });
}
