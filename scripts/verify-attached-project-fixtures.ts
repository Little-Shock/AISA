import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function initializeGitRepo(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, ".gitignore"),
    ["runs/", "state/", "events/", "artifacts/", "reports/", "plans/"].join("\n") + "\n",
    "utf8"
  );
  await writeFile(join(rootDir, "README.md"), "# attached project fixture\n", "utf8");
  await runCommand(rootDir, ["git", "-C", rootDir, "init"]);
  await runCommand(rootDir, ["git", "-C", rootDir, "config", "user.name", "AISA Verify"]);
  await runCommand(
    rootDir,
    ["git", "-C", rootDir, "config", "user.email", "aisa-verify@example.com"]
  );
  await runCommand(rootDir, ["git", "-C", rootDir, "add", "."]);
  await runCommand(rootDir, ["git", "-C", rootDir, "commit", "-m", "test: seed attached project"]);
}

export async function writeNodeProjectFixture(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify(
      {
        name: "attached-node-project",
        private: true,
        packageManager: "pnpm@10.27.0",
        scripts: {
          build: "pnpm build",
          test: "pnpm test",
          dev: "pnpm dev"
        },
        devDependencies: {
          typescript: "^5.8.0"
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  await writeFile(join(rootDir, "tsconfig.json"), "{\n  \"compilerOptions\": {}\n}\n", "utf8");
  await writeFile(join(rootDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
}

export async function writePythonProjectFixture(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "pyproject.toml"),
    [
      "[project]",
      'name = "attached-python-project"',
      'version = "0.1.0"',
      'requires-python = ">=3.11"',
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(join(rootDir, "requirements.txt"), "pytest==8.3.5\n", "utf8");
}

export async function writeGoProjectFixture(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "go.mod"),
    "module example.com/attached-go-project\n\ngo 1.22.0\n",
    "utf8"
  );
  await writeFile(
    join(rootDir, "main.go"),
    [
      "package main",
      "",
      'import "fmt"',
      "",
      "func main() {",
      '  fmt.Println("hello")',
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

export async function writeGenericRepoFixture(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "MAINTAINERS.md"),
    ["# Maintainers", "", "- ops@example.com", ""].join("\n"),
    "utf8"
  );
  await writeFile(
    join(rootDir, "release-notes.md"),
    ["# Release Notes", "", "This repo exercises maintenance-only defaults.", ""].join("\n"),
    "utf8"
  );
}

async function runCommand(rootDir: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const [command, ...commandArgs] = args;
    const child = spawn(command!, commandArgs, {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Command failed (${args.join(" ")}): ${stderr.trim() || `exit ${code ?? "null"}`}`
        )
      );
    });
  });
}
