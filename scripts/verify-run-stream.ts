import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAttempt,
  createAttemptRuntimeState,
  createCurrentDecision,
  createRun,
  updateAttempt,
  updateAttemptRuntimeState
} from "../packages/domain/src/index.ts";
import {
  ensureWorkspace,
  resolveWorkspacePaths,
  saveAttempt,
  saveAttemptRuntimeState,
  saveCurrentDecision,
  saveRun
} from "../packages/state-store/src/index.ts";
import { buildServer } from "../apps/control-api/src/index.ts";

type RunStreamPayload = {
  run: { id: string };
  attempt_details: Array<{
    attempt: { id: string };
    runtime_state: {
      progress_text: string | null;
      phase: string | null;
      session_id: string | null;
      event_count: number;
    } | null;
  }>;
};

async function readNextSnapshot(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  state: { buffer: string },
  timeoutMs: number
): Promise<RunStreamPayload> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const separatorIndex = state.buffer.indexOf("\n\n");
    if (separatorIndex >= 0) {
      const block = state.buffer.slice(0, separatorIndex);
      state.buffer = state.buffer.slice(separatorIndex + 2);
      const lines = block
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean);
      if (lines.length === 0 || lines.every((line) => line.startsWith(":"))) {
        continue;
      }

      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
        }
      }

      if (eventName === "snapshot" && dataLines.length > 0) {
        return JSON.parse(dataLines.join("\n")) as RunStreamPayload;
      }

      continue;
    }

    const remainingMs = Math.max(deadline - Date.now(), 1);
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("Timed out waiting for SSE snapshot"));
        }, remainingMs);
      })
    ]);

    if (chunk.done) {
      throw new Error("SSE stream ended before a snapshot arrived");
    }

    state.buffer += decoder.decode(chunk.value, { stream: true });
  }

  throw new Error("Timed out waiting for SSE snapshot");
}

async function main(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "aisa-run-stream-"));
  const projectScopeDir = await mkdtemp(join(tmpdir(), "aisa-run-stream-scope-"));
  const projectRoot = join(projectScopeDir, "project-a");
  await mkdir(projectRoot, { recursive: true });
  const workspacePaths = resolveWorkspacePaths(rootDir);
  await ensureWorkspace(workspacePaths);

  const run = createRun({
    title: "Run SSE verification",
    description: "Ensure /runs/:id/stream pushes runtime state snapshots.",
    success_criteria: ["stream includes runtime state"],
    constraints: [],
    owner_id: "test-owner",
    workspace_root: projectRoot
  });
  const createdAttempt = createAttempt({
    run_id: run.id,
    attempt_type: "execution",
    worker: "fake-codex",
    objective: "Keep streaming normalized runtime state.",
    success_criteria: run.success_criteria,
    workspace_root: projectRoot
  });
  const attempt = updateAttempt(createdAttempt, {
    status: "running",
    started_at: new Date().toISOString()
  });
  const initialRuntimeState = createAttemptRuntimeState({
    attempt_id: attempt.id,
    run_id: run.id,
    running: true,
    phase: "reasoning",
    active_since: attempt.started_at,
    last_event_at: new Date().toISOString(),
    progress_text: "初始运行态",
    recent_activities: ["思考：先返回第一帧快照。"],
    completed_steps: [],
    process_content: ["先让控制 API 把快照推出去。"],
    session_id: "sess_stream_initial",
    event_count: 1
  });

  await saveRun(workspacePaths, run);
  await saveCurrentDecision(
    workspacePaths,
    createCurrentDecision({
      run_id: run.id,
      run_status: "running",
      latest_attempt_id: attempt.id,
      best_attempt_id: null,
      recommended_next_action: "continue_attempt",
      recommended_attempt_type: "execution",
      summary: "Waiting for the live stream snapshot."
    })
  );
  await saveAttempt(workspacePaths, attempt);
  await saveAttemptRuntimeState(workspacePaths, initialRuntimeState);

  const app = await buildServer({
    workspaceRoot: rootDir,
    startOrchestrator: false,
    allowedRunWorkspaceRoots: [rootDir, projectScopeDir]
  });

  let baseUrl = "";
  try {
    baseUrl = await app.listen({
      host: "127.0.0.1",
      port: 0
    });

    const response = await fetch(`${baseUrl}/runs/${run.id}/stream`, {
      headers: {
        accept: "text/event-stream"
      }
    });
    assert.equal(response.status, 200);
    assert.ok(response.body, "SSE response body should exist");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const streamState = { buffer: "" };

    const firstSnapshot = await readNextSnapshot(reader, decoder, streamState, 5_000);
    const firstRuntimeState =
      firstSnapshot.attempt_details.find((detail) => detail.attempt.id === attempt.id)
        ?.runtime_state ?? null;
    assert.equal(firstRuntimeState?.progress_text, "初始运行态");
    assert.equal(firstRuntimeState?.phase, "reasoning");
    assert.equal(firstRuntimeState?.session_id, "sess_stream_initial");

    await saveAttemptRuntimeState(
      workspacePaths,
      updateAttemptRuntimeState(initialRuntimeState, {
        phase: "tool",
        progress_text: "第二次快照",
        recent_activities: ["命令：pnpm verify:runtime"],
        event_count: 2
      })
    );

    const secondSnapshot = await readNextSnapshot(reader, decoder, streamState, 5_000);
    const secondRuntimeState =
      secondSnapshot.attempt_details.find((detail) => detail.attempt.id === attempt.id)
        ?.runtime_state ?? null;
    assert.equal(secondRuntimeState?.progress_text, "第二次快照");
    assert.equal(secondRuntimeState?.phase, "tool");
    assert.equal(secondRuntimeState?.event_count, 2);

    await reader.cancel();

    console.log(
      JSON.stringify(
        {
          run_id: run.id,
          attempt_id: attempt.id,
          first_phase: firstRuntimeState?.phase,
          second_phase: secondRuntimeState?.phase,
          status: "passed"
        },
        null,
        2
      )
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
