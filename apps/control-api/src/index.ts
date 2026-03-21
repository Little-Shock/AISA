import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import { config as loadEnv } from "dotenv";
import Fastify from "fastify";
import {
  CreateGoalInputSchema,
  createBranch,
  createEvent,
  createGoal,
  createSteer,
  updateBranch,
  updateGoal
} from "@autoresearch/domain";
import { ContextManager } from "@autoresearch/context-manager";
import { appendEvent, listEvents } from "@autoresearch/event-log";
import { Orchestrator } from "@autoresearch/orchestrator";
import { generateInitialPlan } from "@autoresearch/planner";
import {
  ensureWorkspace,
  getBranch,
  getContextBoard,
  getGoal,
  getPlanArtifacts,
  getReport,
  getWriteback,
  listBranches,
  listGoals,
  listSteers,
  listWorkerRuns,
  resolveWorkspacePaths,
  saveBranch,
  saveGoal,
  savePlanArtifacts,
  saveSteer
} from "@autoresearch/state-store";
import { CodexCliWorkerAdapter, loadCodexCliConfig } from "@autoresearch/worker-adapters";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(currentDir, "..", "..", "..");
loadEnv({ path: join(repositoryRoot, ".env") });
const workspacePaths = resolveWorkspacePaths(repositoryRoot);
const contextManager = new ContextManager();
const adapter = new CodexCliWorkerAdapter(loadCodexCliConfig(process.env));
const orchestrator = new Orchestrator(workspacePaths, adapter);

export async function buildServer() {
  const app = Fastify({
    logger: true
  });

  await ensureWorkspace(workspacePaths);
  orchestrator.start();
  await app.register(cors, {
    origin: true
  });

  app.addHook("onClose", async () => {
    orchestrator.stop();
  });

  app.get("/health", async () => ({
    status: "ok",
    codex_command: process.env.CODEX_CLI_COMMAND ?? "codex",
    codex_model: process.env.CODEX_MODEL ?? null
  }));

  app.get("/goals", async () => {
    const goals = await listGoals(workspacePaths);
    const data = await Promise.all(
      goals.map(async (goal) => {
        const branches = await listBranches(workspacePaths, goal.id);
        return {
          goal,
          branch_count: branches.length,
          running_count: branches.filter((branch) => branch.status === "running").length,
          kept_count: branches.filter((branch) => branch.status === "kept").length
        };
      })
    );
    return { goals: data };
  });

  app.get("/goals/:goalId", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    try {
      const [goal, branches, workerRuns, steers, events, context, report] =
        await Promise.all([
          getGoal(workspacePaths, goalId),
          listBranches(workspacePaths, goalId),
          listWorkerRuns(workspacePaths, goalId),
          listSteers(workspacePaths, goalId),
          listEvents(workspacePaths, goalId),
          getContextBoard(workspacePaths, goalId),
          getReport(workspacePaths, goalId)
        ]);

      const branchDetails = await Promise.all(
        branches.map(async (branch) => ({
          branch,
          writeback: await getWriteback(workspacePaths, goalId, branch.id)
        }))
      );

      return {
        goal,
        branches: branchDetails,
        worker_runs: workerRuns,
        steers,
        context,
        report,
        events
      };
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  app.post("/goals", async (request, reply) => {
    const input = CreateGoalInputSchema.parse(request.body);
    const goal = createGoal(input);

    await saveGoal(workspacePaths, goal);
    await contextManager.initializeGoal(workspacePaths, goal);
    await appendEvent(
      workspacePaths,
      createEvent({
        goal_id: goal.id,
        type: "goal.created",
        payload: {
          title: goal.title,
          owner_id: goal.owner_id
        }
      })
    );

    return reply.code(201).send({ goal });
  });

  app.post("/goals/:goalId/plan", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    try {
      const goal = await getGoal(workspacePaths, goalId);
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
            branch_count: plan.branchSpecs.length,
            dimensions: plan.evalSpec.dimensions
          }
        })
      );

      return {
        goal_id: goal.id,
        branch_specs: plan.branchSpecs,
        eval_spec: plan.evalSpec
      };
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  app.post("/goals/:goalId/launch", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    try {
      let goal = await getGoal(workspacePaths, goalId);
      let plan = await getPlanArtifacts(workspacePaths, goalId);

      if (!plan) {
        const generated = generateInitialPlan(goal);
        await savePlanArtifacts(
          workspacePaths,
          goal.id,
          generated.planMarkdown,
          generated.branchSpecs,
          generated.evalSpec
        );
        plan = generated;
      }

      const existingBranches = await listBranches(workspacePaths, goal.id);
      if (existingBranches.length === 0) {
        for (const spec of plan.branchSpecs) {
          const branch = createBranch(goal.id, spec, "pending");
          const queuedBranch = updateBranch(branch, {
            status: "queued"
          });
          await saveBranch(workspacePaths, queuedBranch);
          await appendEvent(
            workspacePaths,
            createEvent({
              goal_id: goal.id,
              branch_id: queuedBranch.id,
              type: "branch.spawned",
              payload: {
                hypothesis: queuedBranch.hypothesis
              }
            })
          );
          await appendEvent(
            workspacePaths,
            createEvent({
              goal_id: goal.id,
              branch_id: queuedBranch.id,
              type: "branch.queued",
              payload: {
                reason: "goal.launch"
              }
            })
          );
        }
      }

      goal = updateGoal(goal, {
        status: "planned"
      });
      await saveGoal(workspacePaths, goal);

      return {
        goal,
        branch_count: (await listBranches(workspacePaths, goal.id)).length
      };
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  app.post("/goals/:goalId/steers", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };
    const body = request.body as {
      content: string;
      scope?: "goal" | "branch" | "worker";
      branch_id?: string | null;
    };

    try {
      await getGoal(workspacePaths, goalId);
      const steer = createSteer({
        goal_id: goalId,
        branch_id: body.branch_id ?? null,
        scope: body.scope ?? "goal",
        content: body.content
      });
      await saveSteer(workspacePaths, steer);
      await appendEvent(
        workspacePaths,
        createEvent({
          goal_id: goalId,
          branch_id: steer.branch_id,
          type: "steer.queued",
          payload: {
            content: steer.content,
            scope: steer.scope
          }
        })
      );

      return reply.code(201).send({ steer });
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  app.post("/goals/:goalId/branches/:branchId/rerun", async (request, reply) => {
    const { goalId, branchId } = request.params as { goalId: string; branchId: string };

    try {
      const branch = await getBranch(workspacePaths, goalId, branchId);
      const queuedBranch = updateBranch(branch, {
        status: "queued",
        score: null,
        confidence: null
      });
      await saveBranch(workspacePaths, queuedBranch);
      await appendEvent(
        workspacePaths,
        createEvent({
          goal_id: goalId,
          branch_id: branchId,
          type: "branch.queued",
          payload: {
            rerun: true
          }
        })
      );

      return { branch: queuedBranch };
    } catch {
      return reply.code(404).send({ message: `Branch ${branchId} not found` });
    }
  });

  app.get("/goals/:goalId/report", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    try {
      await getGoal(workspacePaths, goalId);
      return {
        report: await getReport(workspacePaths, goalId)
      };
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  app.get("/goals/:goalId/context", async (request, reply) => {
    const { goalId } = request.params as { goalId: string };

    try {
      await getGoal(workspacePaths, goalId);
      return {
        context: await getContextBoard(workspacePaths, goalId)
      };
    } catch {
      return reply.code(404).send({ message: `Goal ${goalId} not found` });
    }
  });

  return app;
}

const port = Number(process.env.CONTROL_API_PORT ?? process.env.PORT ?? "8787");
const host = process.env.CONTROL_API_HOST ?? process.env.HOST ?? "127.0.0.1";

const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  buildServer()
    .then((app) => app.listen({ port, host }))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
