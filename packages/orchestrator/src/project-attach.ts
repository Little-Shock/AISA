import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  createAttachedProjectBaselineSnapshot,
  createAttachedProjectProfile,
  type AttachedProjectBaselineSnapshot,
  type AttachedProjectDefaultCommands,
  type AttachedProjectPrimaryLanguage,
  type AttachedProjectProfile,
  type AttachedProjectType
} from "@autoresearch/domain";
import {
  lockRunWorkspaceRoot,
  type LockedWorkspaceRoot,
  RunWorkspaceScopeError,
  type RunWorkspaceScopePolicy
} from "./workspace-scope.js";

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type ProjectInspectionResult = {
  lock: LockedWorkspaceRoot;
  project: AttachedProjectProfile;
  baselineSnapshot: AttachedProjectBaselineSnapshot;
};

type NodePackageJson = {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type DetectedProjectFacts = {
  projectType: AttachedProjectType;
  primaryLanguage: AttachedProjectPrimaryLanguage;
  packageManager: string | null;
  manifestFiles: string[];
  detectionReasons: string[];
  defaultCommands: AttachedProjectDefaultCommands;
};

type ProjectAttachErrorCode =
  | RunWorkspaceScopeError["code"]
  | "workspace_not_git_repo"
  | "invalid_project_manifest"
  | "attach_inspection_failed";

export class ProjectAttachError extends Error {
  constructor(
    readonly code: ProjectAttachErrorCode,
    message: string,
    readonly details: Record<string, unknown>
  ) {
    super(message);
    this.name = "ProjectAttachError";
  }
}

export async function inspectAttachedProjectWorkspace(input: {
  workspaceRoot: string;
  policy: RunWorkspaceScopePolicy;
  title?: string | null;
  existingProfile?: AttachedProjectProfile | null;
}): Promise<ProjectInspectionResult> {
  const lock = await lockRunWorkspaceRoot(input.workspaceRoot, input.policy).catch(
    (error: unknown) => {
      if (error instanceof RunWorkspaceScopeError) {
        throw new ProjectAttachError(error.code, error.message, error.details);
      }
      throw error;
    }
  );
  const repoRoot = await readGitRepoRoot(lock.resolvedRoot);
  const repoName = basename(repoRoot);
  const packageJson = await readNodePackageJson(lock.resolvedRoot);
  const detected = await detectProjectFacts(lock.resolvedRoot, packageJson);
  const toolchain = await readToolchainSnapshot(detected);
  const gitBaseline = await readGitBaseline(lock.resolvedRoot, repoRoot);
  const projectId = buildAttachedProjectId(lock.resolvedRoot);
  const title =
    input.title?.trim() ||
    input.existingProfile?.title ||
    packageJson?.name ||
    repoName;
  const createdAt = input.existingProfile?.created_at;
  const project = createAttachedProjectProfile({
    id: projectId,
    slug: buildAttachedProjectSlug(lock.resolvedRoot),
    title,
    workspace_root: lock.resolvedRoot,
    repo_root: repoRoot,
    repo_name: repoName,
    project_type: detected.projectType,
    primary_language: detected.primaryLanguage,
    package_manager: detected.packageManager,
    manifest_files: detected.manifestFiles,
    detection_reasons: detected.detectionReasons,
    default_commands: detected.defaultCommands,
    created_at: createdAt
  });
  const baselineSnapshot = createAttachedProjectBaselineSnapshot({
    project_id: projectId,
    workspace_root: lock.resolvedRoot,
    workspace_scope: {
      requested_root: lock.requestedRoot,
      resolved_root: lock.resolvedRoot,
      matched_scope_root: lock.matchedScopeRoot
    },
    git: gitBaseline,
    toolchain,
    repo_health: {
      has_tests: project.default_commands.test !== null,
      has_build_command: project.default_commands.build !== null,
      default_verifier_hint: project.project_type,
      suggested_workspace_scope: [lock.resolvedRoot],
      supported: true,
      unsupported_reason: null
    }
  });

  return {
    lock,
    project,
    baselineSnapshot
  };
}

async function detectProjectFacts(
  workspaceRoot: string,
  packageJson: NodePackageJson | null
): Promise<DetectedProjectFacts> {
  const manifestFiles = await listManifestFiles(workspaceRoot);

  if (packageJson) {
    return detectNodeProject(manifestFiles, packageJson);
  }

  const hasPyproject = manifestFiles.includes("pyproject.toml");
  const hasRequirements = manifestFiles.some((file) =>
    /^requirements(\..+)?\.txt$/u.test(file)
  );
  const hasGoMod = manifestFiles.includes("go.mod");

  if (hasPyproject || hasRequirements) {
    return detectPythonProject(manifestFiles);
  }

  if (hasGoMod) {
    return detectGoProject(workspaceRoot, manifestFiles);
  }

  return {
    projectType: "generic_git_repo",
    primaryLanguage: "generic",
    packageManager: null,
    manifestFiles,
    detectionReasons: [
      "Workspace is a git repository but no Node, Python, or Go manifest was detected."
    ],
    defaultCommands: {
      install: null,
      build: null,
      test: null,
      lint: null,
      start: null
    }
  };
}

function detectNodeProject(
  manifestFiles: string[],
  packageJson: NodePackageJson
): DetectedProjectFacts {
  const scripts = packageJson.scripts ?? {};
  const packageManager =
    normalizePackageManager(packageJson.packageManager) ??
    inferNodePackageManagerFromManifests(manifestFiles);
  const primaryLanguage =
    manifestFiles.includes("tsconfig.json") ||
    Boolean(packageJson.devDependencies?.typescript)
      ? "typescript"
      : "javascript";
  const installCommand =
    packageManager === "pnpm"
      ? "pnpm install"
      : packageManager === "yarn"
        ? "yarn install"
        : packageManager === "bun"
          ? "bun install"
          : "npm install";

  return {
    projectType: "node_repo",
    primaryLanguage,
    packageManager,
    manifestFiles,
    detectionReasons: [
      "Detected package.json in workspace root.",
      packageManager
        ? `Detected ${packageManager} as the primary package manager.`
        : "Falling back to npm-compatible defaults."
    ],
    defaultCommands: {
      install: installCommand,
      build: scripts.build ?? null,
      test: scripts.test ?? null,
      lint: scripts.lint ?? null,
      start: scripts.start ?? scripts.dev ?? null
    }
  };
}

function detectPythonProject(
  manifestFiles: string[]
): DetectedProjectFacts {
  const packageManager = manifestFiles.includes("uv.lock")
    ? "uv"
    : manifestFiles.includes("poetry.lock")
      ? "poetry"
      : "pip";
  const hasPyproject = manifestFiles.includes("pyproject.toml");
  const installCommand =
    packageManager === "uv"
      ? "uv sync"
      : packageManager === "poetry"
        ? "poetry install"
        : manifestFiles.find((file) => /^requirements(\..+)?\.txt$/u.test(file))
          ? "pip install -r requirements.txt"
          : null;

  return {
    projectType: "python_repo",
    primaryLanguage: "python",
    packageManager,
    manifestFiles,
    detectionReasons: [
      hasPyproject
        ? "Detected pyproject.toml in workspace root."
        : "Detected requirements file in workspace root.",
      packageManager === "uv"
        ? "Detected uv.lock."
        : packageManager === "poetry"
          ? "Detected poetry.lock."
          : "Falling back to pip-compatible defaults."
    ],
    defaultCommands: {
      install: installCommand,
      build: hasPyproject ? "python -m build" : null,
      test: "pytest",
      lint: null,
      start: null
    }
  };
}

async function detectGoProject(
  workspaceRoot: string,
  manifestFiles: string[]
): Promise<DetectedProjectFacts> {
  const entries = await readdir(workspaceRoot, { withFileTypes: true }).catch(
    () => []
  );
  const hasMainGo = entries.some((entry) => entry.isFile() && entry.name === "main.go");

  return {
    projectType: "go_repo",
    primaryLanguage: "go",
    packageManager: "go",
    manifestFiles,
    detectionReasons: ["Detected go.mod in workspace root."],
    defaultCommands: {
      install: "go mod download",
      build: "go build ./...",
      test: "go test ./...",
      lint: null,
      start: hasMainGo ? "go run ." : null
    }
  };
}

async function listManifestFiles(workspaceRoot: string): Promise<string[]> {
  const candidateFiles = [
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lockb",
    "bun.lock",
    "tsconfig.json",
    "pyproject.toml",
    "poetry.lock",
    "uv.lock",
    "requirements.txt",
    "requirements-dev.txt",
    "requirements-test.txt",
    "pytest.ini",
    "go.mod",
    "go.sum",
    "Makefile"
  ];
  const found: string[] = [];

  for (const file of candidateFiles) {
    try {
      const fileStat = await stat(join(workspaceRoot, file));
      if (fileStat.isFile()) {
        found.push(file);
      }
    } catch {
      // ignore missing manifest
    }
  }

  return found;
}

async function readNodePackageJson(
  workspaceRoot: string
): Promise<NodePackageJson | null> {
  const packageJsonPath = join(workspaceRoot, "package.json");
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    return JSON.parse(raw) as NodePackageJson;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
      return null;
    }
    throw new ProjectAttachError(
      "invalid_project_manifest",
      `package.json is unreadable in ${workspaceRoot}.`,
      {
        workspace_root: workspaceRoot,
        manifest: "package.json",
        reason: error instanceof Error ? error.message : String(error)
      }
    );
  }
}

async function readGitRepoRoot(workspaceRoot: string): Promise<string> {
  const repoRoot = await runCommand("git", [
    "-C",
    workspaceRoot,
    "rev-parse",
    "--show-toplevel"
  ]);

  if (repoRoot.exitCode !== 0) {
    throw new ProjectAttachError(
      "workspace_not_git_repo",
      `工作区不是 git 仓库，无法 attach：${workspaceRoot}`,
      {
        workspace_root: workspaceRoot,
        stderr: repoRoot.stderr.trim() || null
      }
    );
  }

  return repoRoot.stdout.trim();
}

async function readGitBaseline(
  workspaceRoot: string,
  repoRoot: string
): Promise<AttachedProjectBaselineSnapshot["git"]> {
  const [branchResult, headResult, statusResult] = await Promise.all([
    runCommand("git", ["-C", workspaceRoot, "branch", "--show-current"]),
    runCommand("git", ["-C", workspaceRoot, "rev-parse", "HEAD"]),
    runCommand("git", ["-C", workspaceRoot, "status", "--porcelain"])
  ]);

  const statusLines = statusResult.exitCode === 0
    ? statusResult.stdout
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
    : [];

  let stagedFileCount = 0;
  let modifiedFileCount = 0;
  let untrackedFileCount = 0;
  for (const line of statusLines) {
    if (line.startsWith("??")) {
      untrackedFileCount += 1;
      continue;
    }

    if (line[0] && line[0] !== " ") {
      stagedFileCount += 1;
    }
    if (line[1] && line[1] !== " ") {
      modifiedFileCount += 1;
    }
  }

  return {
    repo_root: repoRoot,
    branch:
      branchResult.exitCode === 0 && branchResult.stdout.trim().length > 0
        ? branchResult.stdout.trim()
        : null,
    head_sha:
      headResult.exitCode === 0 && headResult.stdout.trim().length > 0
        ? headResult.stdout.trim()
        : null,
    dirty: statusLines.length > 0,
    staged_file_count: stagedFileCount,
    modified_file_count: modifiedFileCount,
    untracked_file_count: untrackedFileCount,
    status_lines: statusLines
  };
}

async function readToolchainSnapshot(
  detected: DetectedProjectFacts
): Promise<AttachedProjectBaselineSnapshot["toolchain"]> {
  const versions = new Map<string, string | null>();
  versions.set("git", await readCommandVersion("git"));

  if (detected.projectType === "node_repo") {
    versions.set("node", await readCommandVersion("node"));
    versions.set("pnpm", await readCommandVersion("pnpm"));
    versions.set("npm", await readCommandVersion("npm"));
  }

  if (detected.projectType === "python_repo") {
    versions.set(
      "python",
      (await readFirstCommandVersion(["python3", "python"])) ?? null
    );
    versions.set("pip", (await readFirstCommandVersion(["pip3", "pip"])) ?? null);
    versions.set("poetry", await readCommandVersion("poetry"));
    versions.set("uv", await readCommandVersion("uv"));
  }

  if (detected.projectType === "go_repo") {
    versions.set("go", await readCommandVersion("go"));
  }

  return {
    git: versions.get("git") ?? null,
    node: versions.get("node") ?? null,
    pnpm: versions.get("pnpm") ?? null,
    npm: versions.get("npm") ?? null,
    python: versions.get("python") ?? null,
    pip: versions.get("pip") ?? null,
    poetry: versions.get("poetry") ?? null,
    uv: versions.get("uv") ?? null,
    go: versions.get("go") ?? null
  };
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

async function readFirstCommandVersion(
  commands: string[]
): Promise<string | null> {
  for (const command of commands) {
    const version = await readCommandVersion(command);
    if (version) {
      return version;
    }
  }

  return null;
}

function normalizePackageManager(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const [name] = value.split("@");
  return name?.trim() || null;
}

function inferNodePackageManagerFromManifests(
  manifestFiles: string[]
): string | null {
  if (manifestFiles.includes("pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (manifestFiles.includes("yarn.lock")) {
    return "yarn";
  }
  if (manifestFiles.includes("bun.lockb") || manifestFiles.includes("bun.lock")) {
    return "bun";
  }
  if (manifestFiles.includes("package-lock.json")) {
    return "npm";
  }
  return null;
}

function buildAttachedProjectId(workspaceRoot: string): string {
  const digest = createHash("sha1").update(workspaceRoot).digest("hex").slice(0, 10);
  return `project_${digest}`;
}

function buildAttachedProjectSlug(workspaceRoot: string): string {
  return `${slugify(basename(workspaceRoot))}-${createHash("sha1")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 6)}`;
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized.length > 0 ? normalized : "project";
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
