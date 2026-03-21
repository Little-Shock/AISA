import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "@autoresearch/domain";
import { EventSchema } from "@autoresearch/domain";
import type { WorkspacePaths } from "@autoresearch/state-store";
import { ensureWorkspace } from "@autoresearch/state-store";

export async function appendEvent(
  paths: WorkspacePaths,
  event: Event
): Promise<void> {
  await ensureWorkspace(paths);
  const filePath = join(paths.eventsDir, "goals", `${event.goal_id}.ndjson`);
  await mkdir(join(paths.eventsDir, "goals"), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(EventSchema.parse(event))}\n`, "utf8");
}

export async function listEvents(
  paths: WorkspacePaths,
  goalId: string
): Promise<Event[]> {
  const filePath = join(paths.eventsDir, "goals", `${goalId}.ndjson`);

  try {
    const raw = await readFile(filePath, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => EventSchema.parse(JSON.parse(line)));
  } catch {
    return [];
  }
}
