import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const tsFallbackExtensions = [".ts", ".tsx", ".mts", ".cts"];

function isFileLikeSpecifier(specifier) {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:")
  );
}

function resolveWorkspacePackage(specifier) {
  if (!specifier.startsWith("@autoresearch/")) {
    return null;
  }

  const packageName = specifier.slice("@autoresearch/".length);
  const packageRoots = [
    resolve(repoRoot, "packages", packageName, "src", "index.ts"),
    resolve(repoRoot, "apps", packageName, "src", "index.ts")
  ];

  for (const candidate of packageRoots) {
    if (existsSync(candidate)) {
      return {
        url: pathToFileURL(candidate).href,
        shortCircuit: true
      };
    }
  }

  return null;
}

function resolveTypeScriptFallback(specifier, parentURL) {
  if (!specifier.endsWith(".js")) {
    return null;
  }

  const baseURL = parentURL
    ? new URL(parentURL)
    : pathToFileURL(`${repoRoot}/`);
  const resolvedURL = specifier.startsWith("file:")
    ? new URL(specifier)
    : new URL(specifier, baseURL);
  const jsPath = fileURLToPath(resolvedURL);

  for (const extension of tsFallbackExtensions) {
    const candidatePath = `${jsPath.slice(0, -3)}${extension}`;
    if (existsSync(candidatePath)) {
      return {
        url: pathToFileURL(candidatePath).href,
        shortCircuit: true
      };
    }
  }

  return null;
}

function isTypeScriptUrl(url) {
  return /\.(cts|mts|tsx|ts)$/.test(new URL(url).pathname);
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const workspacePackage = resolveWorkspacePackage(specifier);
    if (workspacePackage) {
      return workspacePackage;
    }

    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const fallback = isFileLikeSpecifier(specifier)
        ? resolveTypeScriptFallback(specifier, context.parentURL)
        : null;
      if (fallback) {
        return fallback;
      }

      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (!isTypeScriptUrl(url)) {
      return nextLoad(url, context);
    }

    const source = readFileSync(new URL(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: stripTypeScriptTypes(source, {
        mode: "transform",
        sourceUrl: url
      })
    };
  }
});
