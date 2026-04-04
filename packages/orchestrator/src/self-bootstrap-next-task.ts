import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  AttemptContractDraftSchema,
  type AttemptContractDraft
} from "@autoresearch/domain";

export const SELF_BOOTSTRAP_NEXT_TASK_PROMOTION_ARTIFACT_FILE_NAME =
  "self-bootstrap-next-task-promotion.json";
export const SELF_BOOTSTRAP_NEXT_TASK_SOURCE_ASSET_SNAPSHOT_FILE_NAME =
  "self-bootstrap-next-task-source-asset.snapshot.json";
export const SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME =
  "self-bootstrap-next-task-active-entry.snapshot.json";
export const SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_RELATIVE_PATH =
  "Codex/self-bootstrap-next-runtime-task-active.json";

export interface SelfBootstrapNextTaskSourceAsset {
  path: string;
  absolutePath: string;
  content: string;
  payload_sha256: string;
  asset: Record<string, unknown>;
  draft: AttemptContractDraft;
}

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

export async function loadSelfBootstrapNextTaskRecommendedAttemptDraft(input: {
  workspaceRoot: string;
  sourceAssetPath: string;
}): Promise<{
  path: string;
  absolutePath: string;
  draft: AttemptContractDraft;
}> {
  const sourceAsset = await loadSelfBootstrapNextTaskSourceAsset(input);
  return {
    path: sourceAsset.path,
    absolutePath: sourceAsset.absolutePath,
    draft: sourceAsset.draft
  };
}

export async function loadSelfBootstrapNextTaskSourceAsset(input: {
  workspaceRoot: string;
  sourceAssetPath: string;
}): Promise<SelfBootstrapNextTaskSourceAsset> {
  return loadSelfBootstrapNextTaskSourceAssetFromAbsolutePath({
    path: input.sourceAssetPath,
    absolutePath: join(input.workspaceRoot, input.sourceAssetPath),
    label: `self-bootstrap source asset ${input.sourceAssetPath}`
  });
}

export async function loadSelfBootstrapNextTaskSourceAssetSnapshot(input: {
  absolutePath: string;
  path: string;
}): Promise<SelfBootstrapNextTaskSourceAsset> {
  return loadSelfBootstrapNextTaskSourceAssetFromAbsolutePath({
    path: input.path,
    absolutePath: input.absolutePath,
    label: `self-bootstrap source asset snapshot ${input.path}`
  });
}

export function assertSelfBootstrapNextTaskSourceAnchorMatchesPayload(input: {
  sourceAnchor: SelfBootstrapNextTaskSourceAnchor;
  observedPath: string;
  observedPayloadSha256: string;
  subjectLabel: string;
}): void {
  const expectedPayloadSha256 = input.sourceAnchor.payload_sha256;
  if (
    expectedPayloadSha256 &&
    expectedPayloadSha256 !== input.observedPayloadSha256
  ) {
    throw new Error(
      `${input.subjectLabel} ${input.observedPath} payload_sha256 mismatch: expected ${expectedPayloadSha256} but observed ${input.observedPayloadSha256}`
    );
  }
}

export async function captureSelfBootstrapNextTaskArtifacts(input: {
  workspaceRoot: string;
  workspaceDataRoot: string;
  runArtifactsDir: string;
  activeEntry: SelfBootstrapNextTaskActiveEntry;
}): Promise<{
  activeEntrySnapshotPath: string;
  activeEntrySnapshotRef: string;
  sourceAssetSnapshotPath: string;
  sourceAssetSnapshotRef: string;
  sourceAssetPayloadSha256: string;
}> {
  const sourceAsset = await loadSelfBootstrapNextTaskSourceAsset({
    workspaceRoot: input.workspaceRoot,
    sourceAssetPath: input.activeEntry.source_anchor.asset_path
  });
  assertSelfBootstrapNextTaskSourceAnchorMatchesPayload({
    sourceAnchor: input.activeEntry.source_anchor,
    observedPath: sourceAsset.path,
    observedPayloadSha256: sourceAsset.payload_sha256,
    subjectLabel: "self-bootstrap source asset"
  });

  const activeEntrySnapshotPath = join(
    input.runArtifactsDir,
    SELF_BOOTSTRAP_NEXT_TASK_ACTIVE_ENTRY_SNAPSHOT_FILE_NAME
  );
  const sourceAssetSnapshotPath = join(
    input.runArtifactsDir,
    SELF_BOOTSTRAP_NEXT_TASK_SOURCE_ASSET_SNAPSHOT_FILE_NAME
  );
  await mkdir(input.runArtifactsDir, { recursive: true });
  await writeFile(
    activeEntrySnapshotPath,
    `${JSON.stringify(input.activeEntry, null, 2)}\n`,
    "utf8"
  );
  await writeFile(sourceAssetSnapshotPath, sourceAsset.content, "utf8");

  return {
    activeEntrySnapshotPath,
    activeEntrySnapshotRef: relative(
      input.workspaceDataRoot,
      activeEntrySnapshotPath
    ),
    sourceAssetSnapshotPath,
    sourceAssetSnapshotRef: relative(
      input.workspaceDataRoot,
      sourceAssetSnapshotPath
    ),
    sourceAssetPayloadSha256: sourceAsset.payload_sha256
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

async function loadSelfBootstrapNextTaskSourceAssetFromAbsolutePath(input: {
  path: string;
  absolutePath: string;
  label: string;
}): Promise<SelfBootstrapNextTaskSourceAsset> {
  let content: string;

  try {
    content = await readFile(input.absolutePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${input.label} is unreadable: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${input.label} is invalid JSON: ${reason}`);
  }

  const sourceAsset = expectObject(parsed, input.path);
  let draft: AttemptContractDraft;
  try {
    draft = AttemptContractDraftSchema.parse(sourceAsset.recommended_next_attempt);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${input.label}.recommended_next_attempt is invalid: ${reason}`
    );
  }

  return {
    path: input.path,
    absolutePath: input.absolutePath,
    content,
    payload_sha256: createHash("sha256").update(content).digest("hex"),
    asset: sourceAsset,
    draft
  };
}
