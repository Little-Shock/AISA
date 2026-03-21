import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CreateGoalInputSchema,
  createEvent,
  createGoal,
  type CreateGoalInput
} from "../packages/domain/src/index.ts";
import { appendEvent } from "../packages/event-log/src/index.ts";
import { generateInitialPlan } from "../packages/planner/src/index.ts";
import {
  resolveWorkspacePaths,
  saveGoal,
  savePlanArtifacts
} from "../packages/state-store/src/index.ts";

async function main() {
  const repositoryRoot = process.cwd();
  const fixturePath = join(repositoryRoot, "tests", "fixtures", "sample-goal.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as CreateGoalInput;
  const input = CreateGoalInputSchema.parse(fixture);
  const goal = createGoal(input);
  const workspacePaths = resolveWorkspacePaths(repositoryRoot);

  await saveGoal(workspacePaths, goal);
  await appendEvent(
    workspacePaths,
    createEvent({
      goal_id: goal.id,
      type: "goal.created",
      payload: {
        title: goal.title
      }
    })
  );

  const plan = generateInitialPlan(goal);
  await savePlanArtifacts(
    workspacePaths,
    goal.id,
    plan.planMarkdown,
    plan.branchSpecs,
    plan.evalSpec
  );
  await appendEvent(
    workspacePaths,
    createEvent({
      goal_id: goal.id,
      type: "plan.generated",
      payload: {
        branch_count: plan.branchSpecs.length
      }
    })
  );

  console.log(
    JSON.stringify(
      {
        goal_id: goal.id,
        plan_dir: join("plans", "goals", goal.id),
        state_file: join("state", "goals", goal.id, "goal.json"),
        event_file: join("events", "goals", `${goal.id}.ndjson`)
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
