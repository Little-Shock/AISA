import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveRuntimeControlApiPaths,
  resolveRuntimeLayout,
  syncRuntimeLayoutHint
} from "@autoresearch/orchestrator";

const currentDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(currentDir, "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const runtimeLayout = resolveRuntimeLayout({
  repositoryRoot,
  env: process.env
});
syncRuntimeLayoutHint(runtimeLayout);
const runtimeControlApiPaths = resolveRuntimeControlApiPaths(runtimeLayout);
const restartExitCode = readPositiveIntegerEnv(
  "AISA_CONTROL_API_RESTART_EXIT_CODE",
  75
);
const expectedRestartDelayMs = readPositiveIntegerEnv(
  "AISA_CONTROL_API_EXPECTED_RESTART_DELAY_MS",
  500
);
const unexpectedRestartBaseDelayMs = readPositiveIntegerEnv(
  "AISA_CONTROL_API_UNEXPECTED_RESTART_BASE_DELAY_MS",
  1_000
);
const unexpectedRestartMaxDelayMs = readPositiveIntegerEnv(
  "AISA_CONTROL_API_UNEXPECTED_RESTART_MAX_DELAY_MS",
  15_000
);
const rapidCrashWindowMs = readPositiveIntegerEnv(
  "AISA_CONTROL_API_RAPID_CRASH_WINDOW_MS",
  60_000
);
const maxRapidUnexpectedRestarts = readPositiveIntegerEnv(
  "AISA_CONTROL_API_MAX_RAPID_UNEXPECTED_RESTARTS",
  5
);
const childEntry =
  process.env.AISA_CONTROL_API_CHILD_ENTRY ?? runtimeControlApiPaths.childEntry;
const childCwd =
  process.env.AISA_CONTROL_API_CHILD_CWD ?? runtimeControlApiPaths.packageRoot;
const supervisorEntry =
  process.env.AISA_CONTROL_API_SUPERVISOR_ENTRY ??
  runtimeControlApiPaths.supervisorEntry;
const supervisorCwd =
  process.env.AISA_CONTROL_API_SUPERVISOR_CWD ??
  runtimeControlApiPaths.packageRoot;
const selfReexecOnExpectedRestart =
  process.env.AISA_CONTROL_API_SUPERVISOR_SELF_REEXEC === "1" ||
  (process.env.AISA_CONTROL_API_SUPERVISOR_SELF_REEXEC !== "0" &&
    (process.env.AISA_RUNTIME_REPO_ROOT !== undefined ||
      process.env.AISA_CONTROL_API_SUPERVISOR_ENTRY !== undefined));

let shuttingDown = false;
let activeChild: ChildProcess | null = null;
let rapidUnexpectedRestartTimestamps: number[] = [];

async function main(): Promise<void> {
  while (!shuttingDown) {
    const exitCode = await runChild();
    if (shuttingDown) {
      return;
    }

    const now = Date.now();
    const expectedRestart = exitCode === restartExitCode;
    if (expectedRestart) {
      rapidUnexpectedRestartTimestamps = [];
      console.error(
        `[control-api-supervisor] child requested restart with exit code ${restartExitCode}; restarting in ${expectedRestartDelayMs}ms`
      );
      await delay(expectedRestartDelayMs);
      if (selfReexecOnExpectedRestart) {
        await relaunchSupervisorProcess();
        return;
      }
      continue;
    }

    rapidUnexpectedRestartTimestamps = rapidUnexpectedRestartTimestamps.filter(
      (timestamp) => now - timestamp <= rapidCrashWindowMs
    );
    rapidUnexpectedRestartTimestamps.push(now);

    if (rapidUnexpectedRestartTimestamps.length > maxRapidUnexpectedRestarts) {
      throw new Error(
        `control-api restarted unexpectedly ${rapidUnexpectedRestartTimestamps.length} times within ${rapidCrashWindowMs}ms; supervisor is stopping`
      );
    }

    const unexpectedRestartDelayMs = Math.min(
      unexpectedRestartMaxDelayMs,
      unexpectedRestartBaseDelayMs *
        Math.max(1, rapidUnexpectedRestartTimestamps.length)
    );
    console.error(
      `[control-api-supervisor] child exited unexpectedly with code ${exitCode ?? "null"}; restarting in ${unexpectedRestartDelayMs}ms`
    );
    await delay(unexpectedRestartDelayMs);
  }
}

function runChild(): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", childEntry],
      {
        cwd: childCwd,
        env: {
          ...process.env,
          AISA_CONTROL_API_SUPERVISED: "1",
          AISA_CONTROL_API_ENABLE_SELF_RESTART: "1",
          AISA_CONTROL_API_RESTART_EXIT_CODE: String(restartExitCode)
        },
        stdio: "inherit"
      }
    );
    activeChild = child;

    child.on("error", (error) => {
      if (activeChild === child) {
        activeChild = null;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (activeChild === child) {
        activeChild = null;
      }
      resolve(code);
    });
  });
}

async function relaunchSupervisorProcess(): Promise<void> {
  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", supervisorEntry],
      {
        cwd: supervisorCwd,
        env: process.env,
        detached: true,
        stdio: "inherit"
      }
    );
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveLaunch();
    });
  });
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  const child = activeChild;
  if (!child) {
    return;
  }

  child.kill(signal);
  await new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on("SIGINT", () => {
  void shutdown("SIGINT").finally(() => {
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM").finally(() => {
    process.exit(0);
  });
});

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
