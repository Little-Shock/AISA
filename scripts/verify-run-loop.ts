import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCurrentDecision,
  createRun,
  createRunJournalEntry,
  type Attempt,
  type Run,
  type WorkerWriteback
} from "../packages/domain/src/index.js";
import { Orchestrator } from "../packages/orchestrator/src/index.js";
import {
  appendRunJournal,
  ensureWorkspace,
  getAttemptEvaluation,
  getCurrentDecision,
  getRun,
  listAttempts,
  resolveWorkspacePaths,
  saveCurrentDecision,
  saveRun
} from "../packages/state-store/src/index.js";

class FakeAdapter {
  readonly type = "fake-codex";
  private readonly counts = new Map<string, number>();

  async runAttemptTask(input: {
    run: Run;
    attempt: Attempt;
  }): Promise<{
    writeback: WorkerWriteback;
    reportMarkdown: string;
    exitCode: number;
  }> {
    const key = input.run.id;
    const nextCount = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, nextCount);

    const writeback = input.run.title.includes("happy-path")
      ? this.buildHappyPathWriteback(input.attempt)
      : this.buildStuckWriteback(nextCount);

    return {
      writeback,
      reportMarkdown: "# fake",
      exitCode: 0
    };
  }

  private buildHappyPathWriteback(attempt: Attempt): WorkerWriteback {
    if (attempt.attempt_type === "research") {
      return {
        summary: "Repository understanding is strong enough to start execution.",
        findings: [
          {
            type: "fact",
            content: "Found the right files",
            evidence: ["src/app.ts"]
          }
        ],
        questions: [],
        recommended_next_steps: ["Make the smallest useful change in the target file."],
        confidence: 0.82,
        artifacts: []
      };
    }

    return {
      summary: "Executed the change and left verification artifacts.",
      findings: [
        {
          type: "fact",
          content: "Patched the target code path",
          evidence: ["src/app.ts", "npm test"]
        }
      ],
      questions: [],
      recommended_next_steps: [],
      confidence: 0.88,
      artifacts: [{ type: "patch", path: "artifacts/diff.patch" }]
    };
  }

  private buildStuckWriteback(passNumber: number): WorkerWriteback {
    return {
      summary: `Research pass ${passNumber} still needs stronger evidence.`,
      findings: [
        {
          type: "hypothesis",
          content: "Might be in src/unknown.ts",
          evidence: []
        }
      ],
      questions: ["Need proof from the repository."],
      recommended_next_steps: [],
      confidence: 0.3,
      artifacts: []
    };
  }
}

async function settle(orchestrator: Orchestrator): Promise<void> {
  await orchestrator.tick();
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function bootstrapRun(rootDir: string, title: string): Promise<{
  run: Run;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
}> {
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);

  const run = createRun({
    title,
    description: "Verify loop behavior",
    success_criteria: ["Produce a useful next decision"],
    constraints: [],
    owner_id: "test",
    workspace_root: rootDir
  });
  const current = createCurrentDecision({
    run_id: run.id,
    run_status: "running",
    recommended_next_action: "start_first_attempt",
    recommended_attempt_type: "research",
    summary: "Bootstrapped for verification."
  });

  await saveRun(workspacePaths, run);
  await saveCurrentDecision(workspacePaths, current);
  await appendRunJournal(
    workspacePaths,
    createRunJournalEntry({
      run_id: run.id,
      type: "run.created",
      payload: {
        title: run.title
      }
    })
  );

  return {
    run,
    workspacePaths
  };
}

async function verifyHappyPath(adapter: FakeAdapter, rootDir: string): Promise<{
  runId: string;
  status: string;
}> {
  const { run, workspacePaths } = await bootstrapRun(rootDir, "happy-path-run");
  const orchestrator = new Orchestrator(
    workspacePaths,
    adapter as never,
    undefined,
    60_000
  );

  await settle(orchestrator);
  await settle(orchestrator);
  await settle(orchestrator);
  await settle(orchestrator);

  const attempts = await listAttempts(workspacePaths, run.id);
  const current = await getCurrentDecision(workspacePaths, run.id);
  const researchEvaluation = await getAttemptEvaluation(
    workspacePaths,
    run.id,
    attempts[0]!.id
  );

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.attempt_type, "research");
  assert.equal(attempts[1]?.attempt_type, "execution");
  assert.equal(attempts[0]?.status, "completed");
  assert.equal(attempts[1]?.status, "completed");
  assert.equal(current?.run_status, "completed");
  assert.equal(current?.recommended_next_action, null);
  assert.equal(researchEvaluation?.recommendation, "continue");
  assert.equal(researchEvaluation?.suggested_attempt_type, "execution");

  return {
    runId: run.id,
    status: current?.run_status ?? "missing"
  };
}

async function verifyPausePath(adapter: FakeAdapter, rootDir: string): Promise<{
  runId: string;
  status: string;
}> {
  const { run, workspacePaths } = await bootstrapRun(rootDir, "stuck-run");
  const orchestrator = new Orchestrator(
    workspacePaths,
    adapter as never,
    undefined,
    60_000
  );

  await settle(orchestrator);
  await settle(orchestrator);
  await settle(orchestrator);
  await settle(orchestrator);

  const attempts = await listAttempts(workspacePaths, run.id);
  const current = await getCurrentDecision(workspacePaths, run.id);

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.attempt_type, "research");
  assert.equal(attempts[1]?.attempt_type, "research");
  assert.equal(current?.run_status, "waiting_steer");
  assert.equal(current?.waiting_for_human, true);
  assert.equal(current?.recommended_next_action, "wait_for_human");

  return {
    runId: run.id,
    status: current?.run_status ?? "missing"
  };
}

async function main(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-loop-"));
  const adapter = new FakeAdapter();

  const happyPath = await verifyHappyPath(adapter, rootDir);
  const pausePath = await verifyPausePath(adapter, rootDir);
  const workspacePaths = resolveWorkspacePaths(rootDir);
  const persistedRun = await getRun(workspacePaths, happyPath.runId);

  assert.equal(persistedRun.title, "happy-path-run");

  console.log(
    JSON.stringify(
      {
        rootDir,
        happyPath,
        pausePath
      },
      null,
      2
    )
  );
}

await main();
