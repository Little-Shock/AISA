import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EvaluatorCalibrationCaseSchema,
  EvaluatorCalibrationManifestSchema,
  createEvaluatorCalibrationManifest,
  type AttemptEvaluatorCalibrationSample,
  type EvaluatorCalibrationManifestEntry
} from "../packages/domain/src/index.ts";
import {
  RUNTIME_RUN_LOOP_CALIBRATION_BUNDLE_REF,
  buildOnlineEvaluatorCalibrationCase
} from "../packages/orchestrator/src/evaluator-calibration.ts";
import {
  getAttemptEvaluatorCalibrationSample,
  listAttempts,
  listRuns,
  readJsonFile,
  resolveWorkspacePaths,
  writeJsonFile
} from "../packages/state-store/src/index.ts";

type CliOptions = {
  workspaceRoot: string;
  outputRoot: string;
  runId: string | null;
  attemptId: string | null;
};

type ExportSummary = {
  status: "ok";
  workspace_root: string;
  output_root: string;
  exported_case_ids: string[];
  manifest_entries: number;
  manifest_path: string;
};

function getRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function toRepoRelativePath(rootDir: string, absolutePath: string): string {
  return relative(rootDir, absolutePath).replaceAll("\\", "/");
}

function parseArgs(argv: string[]): CliOptions {
  let workspaceRoot: string | null = null;
  let outputRoot = getRepoRoot();
  let runId: string | null = null;
  let attemptId: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }

    const [flag, inlineValue] = token.split("=", 2);
    const value = inlineValue ?? argv[index + 1] ?? null;
    const consumesNext = inlineValue === undefined;

    if (flag === "--workspace-root") {
      workspaceRoot = value ? resolve(value) : null;
      if (consumesNext) {
        index += 1;
      }
      continue;
    }
    if (flag === "--output-root") {
      outputRoot = value ? resolve(value) : outputRoot;
      if (consumesNext) {
        index += 1;
      }
      continue;
    }
    if (flag === "--run-id") {
      runId = value ?? null;
      if (consumesNext) {
        index += 1;
      }
      continue;
    }
    if (flag === "--attempt-id") {
      attemptId = value ?? null;
      if (consumesNext) {
        index += 1;
      }
    }
  }

  if (!workspaceRoot) {
    throw new Error("Missing required --workspace-root.");
  }
  if (attemptId && !runId) {
    throw new Error("--attempt-id requires --run-id.");
  }

  return {
    workspaceRoot,
    outputRoot,
    runId,
    attemptId
  };
}

async function collectSamples(options: CliOptions): Promise<AttemptEvaluatorCalibrationSample[]> {
  const workspacePaths = resolveWorkspacePaths(options.workspaceRoot);

  if (options.runId && options.attemptId) {
    const sample = await getAttemptEvaluatorCalibrationSample(
      workspacePaths,
      options.runId,
      options.attemptId
    );
    if (!sample) {
      throw new Error(
        `No evaluator calibration sample found for ${options.runId}/${options.attemptId}.`
      );
    }
    return [sample];
  }

  if (options.runId) {
    const attempts = await listAttempts(workspacePaths, options.runId);
    const samples = await Promise.all(
      attempts.map((attempt) =>
        getAttemptEvaluatorCalibrationSample(workspacePaths, options.runId!, attempt.id)
      )
    );
    return samples.filter(
      (sample): sample is AttemptEvaluatorCalibrationSample => sample !== null
    );
  }

  const runs = await listRuns(workspacePaths);
  const collected: AttemptEvaluatorCalibrationSample[] = [];

  for (const run of runs) {
    const attempts = await listAttempts(workspacePaths, run.id);
    const samples = await Promise.all(
      attempts.map((attempt) =>
        getAttemptEvaluatorCalibrationSample(workspacePaths, run.id, attempt.id)
      )
    );
    collected.push(
      ...samples.filter(
        (sample): sample is AttemptEvaluatorCalibrationSample => sample !== null
      )
    );
  }

  return collected;
}

async function readPreviousManifest(
  manifestPath: string
): Promise<Map<string, EvaluatorCalibrationManifestEntry>> {
  try {
    const manifest = EvaluatorCalibrationManifestSchema.parse(
      await readJsonFile(manifestPath)
    );
    return new Map(manifest.entries.map((entry) => [entry.case_id, entry] as const));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

async function rebuildManifest(input: {
  outputRoot: string;
  onlineSamplesDir: string;
  manifestPath: string;
  exportedCaseIds: Set<string>;
}): Promise<number> {
  const previousEntries = await readPreviousManifest(input.manifestPath);
  const entries = await readdir(input.onlineSamplesDir, { withFileTypes: true });
  const now = new Date().toISOString();

  const cases = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".json") &&
          entry.name !== "manifest.json"
      )
      .map(async (entry) => {
        const filePath = join(input.onlineSamplesDir, entry.name);
        const calibrationCase = EvaluatorCalibrationCaseSchema.parse(
          await readJsonFile(filePath)
        );
        return {
          calibrationCase,
          filePath
        };
      })
  );

  const manifest = createEvaluatorCalibrationManifest({
    bundle_ref: RUNTIME_RUN_LOOP_CALIBRATION_BUNDLE_REF,
    entries: cases
      .sort((left, right) =>
        left.calibrationCase.case_id.localeCompare(right.calibrationCase.case_id)
      )
      .map(({ calibrationCase, filePath }) => ({
        case_id: calibrationCase.case_id,
        sample_id: calibrationCase.sample.sample_id,
        label: calibrationCase.label,
        path: toRepoRelativePath(input.outputRoot, filePath),
        run_id: calibrationCase.sample.run_id,
        attempt_id: calibrationCase.sample.attempt_id,
        exported_at:
          input.exportedCaseIds.has(calibrationCase.case_id)
            ? now
            : previousEntries.get(calibrationCase.case_id)?.exported_at ?? now
      }))
  });

  await writeJsonFile(input.manifestPath, manifest);
  return manifest.entries.length;
}

async function exportEvaluatorCalibration(options: CliOptions): Promise<ExportSummary> {
  const onlineSamplesDir = join(
    options.outputRoot,
    "evals",
    "runtime-run-loop",
    "datasets",
    "calibration",
    "online-samples"
  );
  const manifestPath = join(onlineSamplesDir, "manifest.json");
  const samples = await collectSamples(options);
  const exportedCaseIds = new Set<string>();

  await mkdir(onlineSamplesDir, { recursive: true });

  for (const sample of samples) {
    const calibrationCase = buildOnlineEvaluatorCalibrationCase(sample);
    const filePath = join(onlineSamplesDir, `${calibrationCase.case_id}.json`);
    await writeJsonFile(filePath, calibrationCase);
    exportedCaseIds.add(calibrationCase.case_id);
  }

  const manifestEntries = await rebuildManifest({
    outputRoot: options.outputRoot,
    onlineSamplesDir,
    manifestPath,
    exportedCaseIds
  });

  return {
    status: "ok",
    workspace_root: options.workspaceRoot,
    output_root: options.outputRoot,
    exported_case_ids: [...exportedCaseIds].sort(),
    manifest_entries: manifestEntries,
    manifest_path: toRepoRelativePath(options.outputRoot, manifestPath)
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const summary = await exportEvaluatorCalibration(options);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
