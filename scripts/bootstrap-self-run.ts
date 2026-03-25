import {
  createCurrentDecision,
  createRun,
  createRunJournalEntry,
  createRunSteer,
  updateCurrentDecision
} from "../packages/domain/src/index.ts";
import { buildSelfBootstrapRunTemplate } from "../packages/planner/src/index.ts";
import {
  appendRunJournal,
  ensureWorkspace,
  resolveWorkspacePaths,
  saveCurrentDecision,
  saveRun,
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

async function main(): Promise<void> {
  const repositoryRoot = process.cwd();
  const workspacePaths = resolveWorkspacePaths(repositoryRoot);
  await ensureWorkspace(workspacePaths);

  const options = parseArgs(process.argv.slice(2));
  const template = buildSelfBootstrapRunTemplate({
    workspaceRoot: repositoryRoot,
    ownerId: options.ownerId,
    focus: options.focus
  });
  const run = createRun(template.runInput);
  let current = createCurrentDecision({
    run_id: run.id,
    run_status: "draft",
    summary: "Self-bootstrap run created. Waiting to launch."
  });

  await saveRun(workspacePaths, run);
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
        template: "self-bootstrap"
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
