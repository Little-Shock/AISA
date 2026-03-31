import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const SELF_BOOTSTRAP_NEXT_TASK_PROMOTION_ARTIFACT_FILE_NAME =
  "self-bootstrap-next-task-promotion.json";
export const SELF_BOOTSTRAP_NEXT_TASK_SOURCE_ASSET_SNAPSHOT_FILE_NAME =
  "self-bootstrap-next-task-source-asset.snapshot.json";
export const SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME =
  "self-bootstrap-next-task-active-entry.snapshot.json";
export const SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH =
  "Codex/self-bootstrap-next-runtime-task-active.json";

export interface SelfBootstrapNextTaskSourceAnchor {
  asset_path: string;
  source_attempt_id: string | null;
  payload_sha256: string | null;
  promoted_at: string | null;
}

export interface SelfBootstrapNextTaskActiveEntry {
  entry_type: "self_bootstrap_next_runtime_task_active";
  updated_at: string;
  source_anchor: SelfBootstrapNextTaskSourceAnchor;
  title: string;
  summary: string;
}

export async function loadSelfBootstrapNextTaskActiveEntry(workspaceRoot: string): Promise<{
  path: string;
  absolutePath: string;
  entry: SelfBootstrapNextTaskActiveEntry;
}> {
  const absolutePath = join(
    workspaceRoot,
    SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH
  );
  let content: string;

  try {
    content = await readFile(absolutePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `self-bootstrap requires ${SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH}: ${reason}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH} is invalid JSON: ${reason}`
    );
  }

  return {
    path: SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH,
    absolutePath,
    entry: parseSelfBootstrapNextTaskActiveEntry(parsed)
  };
}

export function parseSelfBootstrapNextTaskActiveEntry(
  value: unknown
): SelfBootstrapNextTaskActiveEntry {
  const entry = expectObject(
    value,
    SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH
  );

  const entryType = expectString(
    entry.entry_type,
    `${SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH}.entry_type`
  );
  if (entryType !== "self_bootstrap_next_runtime_task_active") {
    throw new Error(
      `${SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH}.entry_type must be self_bootstrap_next_runtime_task_active`
    );
  }

  const sourceAnchor = expectObject(
    entry.source_anchor,
    `${SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH}.source_anchor`
  );

  return {
    entry_type: "self_bootstrap_next_runtime_task_active",
    updated_at: expectString(
      entry.updated_at,
      `${SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH}.updated_at`
    ),
    source_anchor: {
      asset_path: expectString(
        sourceAnchor.asset_path,
        `${SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH}.source_anchor.asset_path`
      ),
      source_attempt_id: expectOptionalStringOrNull(
        sourceAnchor.source_attempt_id,
        `${SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH}.source_anchor.source_attempt_id`
      ),
      payload_sha256: expectOptionalStringOrNull(
        sourceAnchor.payload_sha256,
        `${SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH}.source_anchor.payload_sha256`
      ),
      promoted_at: expectOptionalStringOrNull(
        sourceAnchor.promoted_at,
        `${SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH}.source_anchor.promoted_at`
      )
    },
    title: expectString(
      entry.title,
      `${SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH}.title`
    ),
    summary: expectString(
      entry.summary,
      `${SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH}.summary`
    )
  };
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value;
}

function expectOptionalStringOrNull(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string or null`);
  }

  return value;
}
