import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERIFY_TEMP_ROOT_ENV = "AISA_VERIFY_TEMP_ROOT";
const VERIFY_KEEP_TEMP_ENV = "AISA_VERIFY_KEEP_TMP";

const trackedVerifyTempDirs: string[] = [];
const trackedVerifyTempRoots = new Set<string>();

function shouldKeepVerifyTempDirs(): boolean {
  return process.env[VERIFY_KEEP_TEMP_ENV] === "1";
}

export async function createTrackedVerifyTempDir(
  prefix: string,
  options?: {
    useSystemTempRoot?: boolean;
  }
): Promise<string> {
  if (options?.useSystemTempRoot) {
    const rootDir = await mkdtemp(join(tmpdir(), prefix));
    trackedVerifyTempDirs.push(rootDir);
    return rootDir;
  }

  const configuredRoot = process.env[VERIFY_TEMP_ROOT_ENV]?.trim();
  if (configuredRoot) {
    await mkdir(configuredRoot, { recursive: true });
    trackedVerifyTempRoots.add(configuredRoot);
  }

  const rootDir = await mkdtemp(join(configuredRoot || tmpdir(), prefix));
  trackedVerifyTempDirs.push(rootDir);
  return rootDir;
}

export async function cleanupTrackedVerifyTempDirs(): Promise<void> {
  if (shouldKeepVerifyTempDirs()) {
    return;
  }

  while (trackedVerifyTempDirs.length > 0) {
    const rootDir = trackedVerifyTempDirs.pop();
    if (!rootDir) {
      continue;
    }

    await rm(rootDir, {
      recursive: true,
      force: true,
      maxRetries: 3
    });
  }

  while (trackedVerifyTempRoots.size > 0) {
    const tempRoot = trackedVerifyTempRoots.values().next().value;
    if (!tempRoot) {
      break;
    }
    trackedVerifyTempRoots.delete(tempRoot);

    const entries = await readdir(tempRoot, {
      withFileTypes: true
    }).catch(() => []);

    for (const entry of entries) {
      if (!entry.name.match(/^\.?aisa-/)) {
        continue;
      }

      await rm(join(tempRoot, entry.name), {
        recursive: true,
        force: true,
        maxRetries: 3
      });
    }
  }
}
