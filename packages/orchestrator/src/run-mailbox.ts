import {
  createRunMailbox,
  createRunMailboxEntry,
  updateRunMailbox,
  updateRunMailboxEntry,
  type RunMailbox,
  type RunMailboxEntry,
  type RunHarnessSlot
} from "@autoresearch/domain";
import {
  getRunMailbox,
  saveRunMailbox,
  type WorkspacePaths
} from "@autoresearch/state-store";

async function loadRunMailbox(
  paths: WorkspacePaths,
  runId: string
): Promise<RunMailbox> {
  return (await getRunMailbox(paths, runId)) ?? createRunMailbox({ run_id: runId });
}

function sortMailboxEntries(entries: RunMailboxEntry[]): RunMailboxEntry[] {
  return entries
    .slice()
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export function buildRunMailboxThreadId(input: {
  kind: "approval" | "dispatch_blocked" | "handoff";
  value: string;
}): string {
  return `${input.kind}:${input.value}`;
}

export async function upsertOpenRunMailboxEntry(input: {
  paths: WorkspacePaths;
  runId: string;
  threadId: string;
  messageType: RunMailboxEntry["message_type"];
  fromSlot?: RunHarnessSlot | null;
  toSlotOrActor: string;
  requiredAction?: string | null;
  summary: string;
  sourceRef?: string | null;
  sourceAttemptId?: string | null;
}): Promise<RunMailbox> {
  const mailbox = await loadRunMailbox(input.paths, input.runId);
  const existingIndex = mailbox.entries.findIndex(
    (entry: RunMailboxEntry) =>
      entry.thread_id === input.threadId && entry.status === "open"
  );
  const nextEntryBase = {
    run_id: input.runId,
    thread_id: input.threadId,
    message_type: input.messageType,
    from_slot: input.fromSlot ?? null,
    to_slot_or_actor: input.toSlotOrActor,
    status: "open" as const,
    required_action: input.requiredAction ?? null,
    summary: input.summary,
    source_ref: input.sourceRef ?? null,
    source_attempt_id: input.sourceAttemptId ?? null
  };
  const nextEntries = mailbox.entries.slice();

  if (existingIndex >= 0) {
    const existingEntry = nextEntries[existingIndex]!;
    nextEntries[existingIndex] = updateRunMailboxEntry(existingEntry, {
      ...nextEntryBase,
      created_at: existingEntry.created_at,
      resolved_at: null
    });
  } else {
    nextEntries.push(
      createRunMailboxEntry({
        ...nextEntryBase
      })
    );
  }

  const nextMailbox = updateRunMailbox(mailbox, {
    entries: sortMailboxEntries(nextEntries)
  });
  await saveRunMailbox(input.paths, nextMailbox);
  return nextMailbox;
}

export async function appendResolvedRunMailboxEntry(input: {
  paths: WorkspacePaths;
  runId: string;
  threadId: string;
  messageType: RunMailboxEntry["message_type"];
  fromSlot?: RunHarnessSlot | null;
  toSlotOrActor: string;
  summary: string;
  requiredAction?: string | null;
  sourceRef?: string | null;
  sourceAttemptId?: string | null;
  createdAt?: string;
  resolvedAt?: string;
}): Promise<RunMailbox> {
  const mailbox = await loadRunMailbox(input.paths, input.runId);
  const nextEntries = mailbox.entries.slice();
  nextEntries.push(
    createRunMailboxEntry({
      run_id: input.runId,
      thread_id: input.threadId,
      message_type: input.messageType,
      from_slot: input.fromSlot ?? null,
      to_slot_or_actor: input.toSlotOrActor,
      status: "resolved",
      required_action: input.requiredAction ?? null,
      summary: input.summary,
      source_ref: input.sourceRef ?? null,
      source_attempt_id: input.sourceAttemptId ?? null,
      created_at: input.createdAt,
      resolved_at: input.resolvedAt ?? input.createdAt ?? new Date().toISOString()
    })
  );
  const nextMailbox = updateRunMailbox(mailbox, {
    entries: sortMailboxEntries(nextEntries)
  });
  await saveRunMailbox(input.paths, nextMailbox);
  return nextMailbox;
}

export async function resolveRunMailboxThread(input: {
  paths: WorkspacePaths;
  runId: string;
  threadId: string;
  resolutionSummary?: string | null;
  resolvedAt?: string;
  sourceRef?: string | null;
}): Promise<RunMailbox> {
  const mailbox = await loadRunMailbox(input.paths, input.runId);
  const resolvedAt = input.resolvedAt ?? new Date().toISOString();
  const nextEntries = mailbox.entries.map((entry: RunMailboxEntry) => {
    if (entry.thread_id !== input.threadId || entry.status !== "open") {
      return entry;
    }

    return updateRunMailboxEntry(entry, {
      status: "resolved",
      summary: input.resolutionSummary ?? entry.summary,
      source_ref: input.sourceRef ?? entry.source_ref,
      resolved_at: resolvedAt
    });
  });
  const nextMailbox = updateRunMailbox(mailbox, {
    entries: sortMailboxEntries(nextEntries)
  });
  await saveRunMailbox(input.paths, nextMailbox);
  return nextMailbox;
}

export async function resolveOpenRunMailboxMessagesByType(input: {
  paths: WorkspacePaths;
  runId: string;
  messageType: RunMailboxEntry["message_type"];
  resolutionSummary?: string | null;
  resolvedAt?: string;
}): Promise<RunMailbox> {
  const mailbox = await loadRunMailbox(input.paths, input.runId);
  const resolvedAt = input.resolvedAt ?? new Date().toISOString();
  const nextEntries = mailbox.entries.map((entry: RunMailboxEntry) => {
    if (entry.message_type !== input.messageType || entry.status !== "open") {
      return entry;
    }

    return updateRunMailboxEntry(entry, {
      status: "resolved",
      summary: input.resolutionSummary ?? entry.summary,
      resolved_at: resolvedAt
    });
  });
  const nextMailbox = updateRunMailbox(mailbox, {
    entries: sortMailboxEntries(nextEntries)
  });
  await saveRunMailbox(input.paths, nextMailbox);
  return nextMailbox;
}
