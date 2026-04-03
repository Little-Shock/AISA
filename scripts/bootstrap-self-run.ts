import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCurrentDecision,
  createRun,
  createRunJournalEntry,
  createRunSteer,
  updateCurrentDecision
} from "../packages/domain/src/index.ts";
import { buildSelfBootstrapRunTemplate } from "../packages/planner/src/index.ts";
import {
  captureSelfBootstrapRuntimeHealthSnapshot,
  SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME,
  loadSelfBootstrapNextTaskActiveEntry,
  resolveRuntimeLayout,
  syncRuntimeLayoutHint
} from "../packages/orchestrator/src/index.ts";
import {
  appendRunJournal,
  ensureWorkspace,
  resolveRunPaths,
  resolveWorkspacePaths,
  saveCurrentDecision,
  saveRun,
  saveRunRuntimeHealthSnapshot,
  saveRunSteer
} from "../packages/state-store/src/index.ts";

type CliOptions = {
  ownerId?: string;
  focus?: string;
  launch: boolean;
  seedSteer: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    launch: true,
    seedSteer: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--owner" && argv[index + 1]) {
      options.ownerId = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--focus" && argv[index + 1]) {
      options.focus = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--no-launch") {
      options.launch = false;
      continue;
    }

    if (token === "--no-steer") {
      options.seedSteer = false;
    }
  }

  return options;
}

function resolveSourceRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

async function main(): Promise<void> {
  const sourceRoot = resolveSourceRoot();
  const runtimeLayout = resolveRuntimeLayout({
    repositoryRoot: sourceRoot,
    env: process.env
  });
  syncRuntimeLayoutHint(runtimeLayout);
  const workspacePaths = resolveWorkspacePaths(runtimeLayout.runtimeDataRoot);
  await ensureWorkspace(workspacePaths);

  const options = parseArgs(process.argv.slice(2));
  const activeNextTask = await loadSelfBootstrapNextTaskActiveEntry(
    runtimeLayout.devRepoRoot
  );
  const baseTemplate = buildSelfBootstrapRunTemplate({
    workspaceRoot: runtimeLayout.devRepoRoot,
    ownerId: options.ownerId,
    focus: options.focus,
    activeNextTask: {
      path: activeNextTask.path,
      ...activeNextTask.entry
    }
  });
  const run = createRun(baseTemplate.runInput);
  const runtimeHealthSnapshotRef = relative(
    workspacePaths.rootDir,
    resolveRunPaths(workspacePaths, run.id).runtimeHealthSnapshotFile
  );
  const runtimeHealthSnapshot = await captureSelfBootstrapRuntimeHealthSnapshot({
    runId: run.id,
    workspaceRoot: runtimeLayout.devRepoRoot,
    runtimeRepoRoot: runtimeLayout.runtimeRepoRoot
  });
  const template = buildSelfBootstrapRunTemplate({
    workspaceRoot: runtimeLayout.devRepoRoot,
    ownerId: options.ownerId,
    focus: options.focus,
    activeNextTask: {
      path: activeNextTask.path,
      ...activeNextTask.entry
    },
    runtimeHealthSnapshot: {
      path: runtimeHealthSnapshotRef,
      snapshot: runtimeHealthSnapshot
    }
  });
  let current = createCurrentDecision({
    run_id: run.id,
    run_status: "draft",
    summary: "Self-bootstrap run created. Waiting to launch."
  });

  await saveRun(workspacePaths, run);
  await saveRunRuntimeHealthSnapshot(workspacePaths, runtimeHealthSnapshot);
  await saveCurrentDecision(workspacePaths, current);
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.created",
      payload: {
        title: run.title,
        owner_id: run.owner_id,
        template: "self-bootstrap"
      }
    })
  );
  const runPaths = resolveRunPaths(workspacePaths, run.id);
  const activeNextTaskSnapshotPath = join(
    runPaths.artifactsDir,
    SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME
  );
  await mkdir(runPaths.artifactsDir, { recursive: true });
  await writeFile(
    activeNextTaskSnapshotPath,
    JSON.stringify(activeNextTask.entry, null, 2) + "\n",
    "utf8"
  );
  const activeNextTaskSnapshotRef = relative(
    workspacePaths.rootDir,
    activeNextTaskSnapshotPath
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.self_bootstrap.active_next_task.captured",
      payload: {
        published_path: activeNextTask.path,
        snapshot_path: activeNextTaskSnapshotRef,
        title: activeNextTask.entry.title,
        source_anchor: activeNextTask.entry.source_anchor
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.runtime_health_snapshot.captured",
      payload: {
        path: runtimeHealthSnapshotRef,
        verify_runtime_status: runtimeHealthSnapshot.verify_runtime.status,
        history_contract_drift_status:
          runtimeHealthSnapshot.history_contract_drift.status,
        drift_count: runtimeHealthSnapshot.history_contract_drift.drift_count
      }
    })
  );

  let steerId: string | null = null;
  if (options.seedSteer) {
    const runSteer = createRunSteer({
      run_id: run.id,
      content: template.initialSteer
    });
    steerId = runSteer.id;
    await saveRunSteer(workspacePaths, runSteer);
    await appendRunJournal(
      workspacePaths,
      createRunJournalEntry({
        run_id: run.id,
        attempt_id: null,
        type: "run.steer.queued",
        payload: {
          content: runSteer.content,
          template: "self-bootstrap"
        }
      })
    );
  }

  if (options.launch) {
    current = updateCurrentDecision(current, {
      run_status: "running",
      waiting_for_human: false,
      blocking_reason: null,
      recommended_next_action: "start_first_attempt",
      recommended_attempt_type: "research",
      summary: "Self-bootstrap run launched. Loop will create the first attempt."
    });
    await saveCurrentDecision(workspacePaths, current);
    await appendRunJournal(
      workspacePaths,
      createRunJournalEntry({
        run_id: run.id,
        type: "run.launched",
        payload: {
          template: "self-bootstrap"
        }
      })
    );
  }

  console.log(
    JSON.stringify(
      {
        run_id: run.id,
        current_status: current.run_status,
        workspace_root: run.workspace_root,
        steer_id: steerId,
        launched: options.launch,
        template: "self-bootstrap",
        active_next_task: activeNextTask.path,
        active_next_task_snapshot: activeNextTaskSnapshotRef,
        runtime_health_snapshot: runtimeHealthSnapshotRef
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
