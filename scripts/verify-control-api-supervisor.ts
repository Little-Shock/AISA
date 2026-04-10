import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupTrackedVerifyTempDirs,
  createTrackedVerifyTempDir
} from "./verify-temp.ts";

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
  delayMs = 80
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error("Timed out while waiting for control-api supervisor to restart the child.");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

async function verifyFileExistsFailsClosedOnPermissionErrors(): Promise<void> {
  const tempDir = await createTrackedVerifyTempDir(
    "aisa-control-supervisor-file-exists-"
  );
  const blockedParent = join(tempDir, "blocked");
  const blockedFile = join(blockedParent, "ready.txt");
  await mkdir(blockedParent, { recursive: true });
  await chmod(blockedParent, 0o000);

  try {
    await assert.rejects(
      () => fileExists(blockedFile),
      /EACCES|permission denied/i
    );
  } finally {
    await chmod(blockedParent, 0o755);
  }
}

async function main(): Promise<void> {
  let child:
    | ReturnType<typeof spawn>
    | null = null;

  try {
    await verifyFileExistsFailsClosedOnPermissionErrors();

    const tempDir = await createTrackedVerifyTempDir(
      "aisa-control-supervisor-"
    );
    const countFile = join(tempDir, "count.txt");
    const readyFile = join(tempDir, "ready.txt");
    const childFile = join(tempDir, "child.mjs");

  await writeFile(
    childFile,
    [
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      'const countPath = process.env.TEST_COUNT_FILE;',
      'const readyPath = process.env.TEST_READY_FILE;',
      'const restartExitCode = Number.parseInt(process.env.AISA_CONTROL_API_RESTART_EXIT_CODE ?? "75", 10);',
      'const previousCount = existsSync(countPath) ? Number.parseInt(readFileSync(countPath, "utf8"), 10) : 0;',
      'const nextCount = Number.isFinite(previousCount) ? previousCount + 1 : 1;',
      'writeFileSync(countPath, String(nextCount));',
      'if (nextCount === 1) {',
      '  process.exit(restartExitCode);',
      '}',
      'writeFileSync(readyPath, "ready\\n");',
      'const timer = setInterval(() => {}, 1_000);',
      'process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });',
      'process.on("SIGINT", () => { clearInterval(timer); process.exit(0); });'
    ].join("\n") + "\n",
    "utf8"
  );

    child = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--loader",
        "./scripts/ts-runtime-loader.mjs",
        "apps/control-api/src/supervisor.ts"
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AISA_CONTROL_API_CHILD_ENTRY: childFile,
          AISA_CONTROL_API_SUPERVISOR_SELF_REEXEC: "0",
          AISA_CONTROL_API_EXPECTED_RESTART_DELAY_MS: "50",
          AISA_CONTROL_API_UNEXPECTED_RESTART_BASE_DELAY_MS: "50",
          AISA_CONTROL_API_UNEXPECTED_RESTART_MAX_DELAY_MS: "200",
          AISA_CONTROL_API_RAPID_CRASH_WINDOW_MS: "2000",
          AISA_CONTROL_API_MAX_RAPID_UNEXPECTED_RESTARTS: "3",
          TEST_COUNT_FILE: countFile,
          TEST_READY_FILE: readyFile
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    await waitFor(async () => {
      if (!(await fileExists(readyFile))) {
        return false;
      }
      const count = Number.parseInt(await readFile(countFile, "utf8"), 10);
      return count === 2;
    });

    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child?.on("error", reject);
      child?.on("close", resolve);
    });

    assert.equal(
      exitCode,
      0,
      `control-api supervisor should exit cleanly after SIGTERM.\n\nstderr:\n${stderr.trim() || "<empty>"}`
    );

    const count = Number.parseInt(await readFile(countFile, "utf8"), 10);
    assert.equal(count, 2, "control-api supervisor should restart the child exactly once.");

    console.log(
      JSON.stringify(
        {
          status: "passed",
          child_restart_count: count
        },
        null,
        2
      )
    );
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        child?.once("close", resolve);
      });
    }
    await cleanupTrackedVerifyTempDirs();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
