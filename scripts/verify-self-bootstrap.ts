import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCurrentDecision,
  createRun,
  createRunJournalEntry,
  createRunSteer,
  updateCurrentDecision,
  type Attempt,
  type Run,
  type WorkerWriteback
} from "../packages/domain/src/index.ts";
import { Orchestrator } from "../packages/orchestrator/src/index.ts";
import { buildSelfBootstrapRunTemplate } from "../packages/planner/src/index.ts";
import {
  appendRunJournal,
  ensureWorkspace,
  getAttemptContract,
  getCurrentDecision,
  listAttempts,
  listRunJournal,
  listRunSteers,
  resolveWorkspacePaths,
  saveCurrentDecision,
  saveRun,
  saveRunSteer
} from "../packages/state-store/src/index.ts";

class NoopAdapter {
  readonly type = "fake-codex";

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    return {
      writeback: {
        summary: `Captured objective for ${input.attempt.id}`,
        findings: [],
        questions: [],
        recommended_next_steps: [],
        confidence: 0.4,
        artifacts: []
      },
      reportMarkdown: "# noop",
      exitCode: 0
    };
  }
}

async function main(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-self-bootstrap-"));
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);

  const template = buildSelfBootstrapRunTemplate({
    workspaceRoot: rootDir,
    ownerId: "test-owner",
    focus: "Use runtime evidence to choose the next backend step."
  });
  assert.equal(template.runInput.workspace_root, rootDir);
  assert.equal(template.runInput.owner_id, "test-owner");
  assert.equal(template.runInput.title, "AISA 自举下一步规划");
  assert.match(template.runInput.description, /自举开发/);
  assert.equal(template.runInput.success_criteria[0], "确定下一项该做的具体后端或运行时任务。");
  assert.ok(template.initialSteer.includes("runtime"));
  assert.ok(template.initialSteer.includes("回放"));

  const run = createRun(template.runInput);
  let current = createCurrentDecision({
    run_id: run.id,
    run_status: "draft",
    summary: "Self-bootstrap run created. Waiting to launch."
  });
  const steer = createRunSteer({
    run_id: run.id,
    content: template.initialSteer
  });

  await saveRun(workspacePaths, run);
  await saveCurrentDecision(workspacePaths, current);
  await saveRunSteer(workspacePaths, steer);
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.created",
      payload: {
        title: run.title,
        template: "self-bootstrap"
      }
    })
  );
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.steer.queued",
      payload: {
        content: steer.content,
        template: "self-bootstrap"
      }
    })
  );
  current = updateCurrentDecision(current, {
    run_status: "running",
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

  const orchestrator = new Orchestrator(
    workspacePaths,
    new NoopAdapter() as never,
    undefined,
    60_000
  );
  await orchestrator.tick();

  const persistedCurrent = await getCurrentDecision(workspacePaths, run.id);
  const attempts = await listAttempts(workspacePaths, run.id);
  const steers = await listRunSteers(workspacePaths, run.id);
  const journal = await listRunJournal(workspacePaths, run.id);

  assert.equal(persistedCurrent?.run_status, "running");
  assert.equal(steers.length, 1);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.attempt_type, "research");
  assert.ok(
    attempts[0]?.objective.includes("人工指令："),
    "first attempt should incorporate the seeded steer in Chinese"
  );
  assert.ok(
    attempts[0]?.objective.includes("runtime evidence"),
    "first attempt should keep the self-bootstrap focus"
  );
  const attemptContract = attempts[0]
    ? await getAttemptContract(workspacePaths, run.id, attempts[0].id)
    : null;
  assert.ok(attemptContract, "first attempt should persist attempt_contract.json");
  assert.deepEqual(
    attemptContract?.required_evidence ?? [],
    [
      "Ground findings in concrete files, commands, or artifacts.",
      "If execution is recommended, leave a replayable execution contract for the next attempt."
    ],
    "research attempt contract should enforce grounded evidence and execution readiness"
  );
  assert.ok(
    journal.some((entry) => entry.type === "run.steer.queued"),
    "journal should record the seeded steer"
  );

  console.log(
    JSON.stringify(
      {
        run_id: run.id,
        attempt_id: attempts[0]?.id ?? null,
        objective: attempts[0]?.objective ?? null
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
