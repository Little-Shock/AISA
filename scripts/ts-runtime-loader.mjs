import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = resolvePath(fileURLToPath(new URL("..", import.meta.url)));

const workspacePackageMap = new Map([
  ["@autoresearch/context-manager", "packages/context-manager/src/index.ts"],
  ["@autoresearch/domain", "packages/domain/src/index.ts"],
  ["@autoresearch/event-log", "packages/event-log/src/index.ts"],
  ["@autoresearch/judge", "packages/judge/src/index.ts"],
  ["@autoresearch/orchestrator", "packages/orchestrator/src/index.ts"],
  ["@autoresearch/planner", "packages/planner/src/index.ts"],
  ["@autoresearch/report-builder", "packages/report-builder/src/index.ts"],
  ["@autoresearch/state-store", "packages/state-store/src/index.ts"],
  ["@autoresearch/worker-adapters", "packages/worker-adapters/src/index.ts"]
]);

async function fileExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, nextResolve) {
  const mappedWorkspacePath = workspacePackageMap.get(specifier);
  if (mappedWorkspacePath) {
    return nextResolve(
      pathToFileURL(resolvePath(workspaceRoot, mappedWorkspacePath)).href,
      context
    );
  }

  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js") &&
    context.parentURL?.startsWith("file:")
  ) {
    const parentPath = fileURLToPath(context.parentURL);
    const candidateTsPath = resolvePath(
      dirname(parentPath),
      specifier.replace(/\.js$/u, ".ts")
    );
    if (await fileExists(candidateTsPath)) {
      return nextResolve(pathToFileURL(candidateTsPath).href, context);
    }
  }

  return nextResolve(specifier, context);
}
