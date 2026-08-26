import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  CONVERSATION_HANDOFF_REQUEST_SUFFIX,
  CONVERSATION_HANDOFF_ROOT,
  CONVERSATION_HANDOFF_SCHEMA_VERSION,
  CONVERSATION_HANDOFF_SNAPSHOT_SUFFIX
} from "../constants.js";
import type {
  AttachmentSelection,
  ConversationObservationRequest,
  ConversationSnapshot,
  QualifyingConversationMessage
} from "./conversation-parser.js";

export interface ConversationPrivateHandoff {
  writeRequest(invocationId: string, request: ConversationObservationRequest): Promise<void>;
  readRequest(invocationId: string): Promise<ConversationObservationRequest | undefined>;
  writeSnapshot(invocationId: string, snapshot: ConversationSnapshot): Promise<void>;
  readSnapshot(invocationId: string): Promise<ConversationSnapshot | undefined>;
}

export class ConversationPrivateHandoffError extends Error {
  public constructor() {
    super("Private conversation handoff is invalid.");
    this.name = "ConversationPrivateHandoffError";
  }
}

interface RequestRecord {
  readonly schemaVersion: number;
  readonly kind: "request";
  readonly request: ConversationObservationRequest;
}

interface SnapshotRecord {
  readonly schemaVersion: number;
  readonly kind: "snapshot";
  readonly snapshot: ConversationSnapshot;
}

export class JsonConversationPrivateHandoff implements ConversationPrivateHandoff {
  public constructor(private readonly root: string = CONVERSATION_HANDOFF_ROOT) {}

  public async writeRequest(
    invocationId: string,
    request: ConversationObservationRequest
  ): Promise<void> {
    if (!isObservationRequest(request)) {
      throw new ConversationPrivateHandoffError();
    }
    await this.write(invocationId, CONVERSATION_HANDOFF_REQUEST_SUFFIX, {
      schemaVersion: CONVERSATION_HANDOFF_SCHEMA_VERSION,
      kind: "request",
      request
    });
  }

  public async readRequest(
    invocationId: string
  ): Promise<ConversationObservationRequest | undefined> {
    const record = await this.read<RequestRecord>(
      invocationId,
      CONVERSATION_HANDOFF_REQUEST_SUFFIX,
      isRequestRecord
    );
    return record?.request;
  }

  public async writeSnapshot(invocationId: string, snapshot: ConversationSnapshot): Promise<void> {
    if (!isConversationSnapshot(snapshot)) {
      throw new ConversationPrivateHandoffError();
    }
    await this.write(invocationId, CONVERSATION_HANDOFF_SNAPSHOT_SUFFIX, {
      schemaVersion: CONVERSATION_HANDOFF_SCHEMA_VERSION,
      kind: "snapshot",
      snapshot
    });
  }

  public async readSnapshot(invocationId: string): Promise<ConversationSnapshot | undefined> {
    const record = await this.read<SnapshotRecord>(
      invocationId,
      CONVERSATION_HANDOFF_SNAPSHOT_SUFFIX,
      isSnapshotRecord
    );
    return record?.snapshot;
  }

  private async write(invocationId: string, suffix: string, record: unknown): Promise<void> {
    requireInvocationId(invocationId);
    await preparePrivateRoot(this.root);
    const recordPath = join(this.root, `${invocationId}${suffix}`);
    await requireRegularRecordIfPresent(recordPath, false);
    const temporaryPath = join(
      this.root,
      `.${invocationId}${suffix}.${randomUUID()}.tmp`
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let ownsTemporaryPath = false;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      ownsTemporaryPath = true;
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, recordPath);
      await chmod(recordPath, 0o600);
      await syncDirectory(this.root);
    } catch {
      await handle?.close().catch(() => undefined);
      if (ownsTemporaryPath) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
      throw new ConversationPrivateHandoffError();
    }
  }

  private async read<Record>(
    invocationId: string,
    suffix: string,
    validate: (value: unknown) => value is Record
  ): Promise<Record | undefined> {
    requireInvocationId(invocationId);
    try {
      if (!(await requirePrivateRootIfPresent(this.root, true))) {
        return undefined;
      }
      const recordPath = join(this.root, `${invocationId}${suffix}`);
      if (!(await requireRegularRecordIfPresent(recordPath, true))) {
        return undefined;
      }
      const value = JSON.parse(await readFile(recordPath, "utf8")) as unknown;
      if (!validate(value)) {
        throw new ConversationPrivateHandoffError();
      }
      return value;
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      if (error instanceof ConversationPrivateHandoffError) {
        throw error;
      }
      throw new ConversationPrivateHandoffError();
    }
  }
}

function isRequestRecord(value: unknown): value is RequestRecord {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["schemaVersion", "kind", "request"]) &&
    value.schemaVersion === CONVERSATION_HANDOFF_SCHEMA_VERSION &&
    value.kind === "request" &&
    isObservationRequest(value.request)
  );
}

function isSnapshotRecord(value: unknown): value is SnapshotRecord {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["schemaVersion", "kind", "snapshot"]) &&
    value.schemaVersion === CONVERSATION_HANDOFF_SCHEMA_VERSION &&
    value.kind === "snapshot" &&
    isConversationSnapshot(value.snapshot)
  );
}

function isObservationRequest(value: unknown): value is ConversationObservationRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["destination", "boundary", "stopAfterQualifyingMessages"]) &&
    isNonEmptyString(value.destination) &&
    (value.boundary === undefined || isNonEmptyString(value.boundary)) &&
    typeof value.stopAfterQualifyingMessages === "number" &&
    Number.isInteger(value.stopAfterQualifyingMessages) &&
    value.stopAfterQualifyingMessages > 0
  );
}

function isConversationSnapshot(value: unknown): value is ConversationSnapshot {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "destination",
      "boundary",
      "segmentStart",
      "complete",
      "messages",
      "selectedAttachments"
    ]) ||
    !isNonEmptyString(value.destination) ||
    (value.boundary !== undefined && !isNonEmptyString(value.boundary)) ||
    (value.segmentStart !== undefined && !isNonEmptyString(value.segmentStart)) ||
    (value.boundary === undefined) === (value.segmentStart === undefined) ||
    typeof value.complete !== "boolean" ||
    !Array.isArray(value.messages) ||
    !isDenseArray(value.messages) ||
    !value.messages.every(isQualifyingMessage) ||
    !Array.isArray(value.selectedAttachments) ||
    !isDenseArray(value.selectedAttachments) ||
    !value.selectedAttachments.every(isAttachmentSelection)
  ) {
    return false;
  }

  const identities = value.messages.map((message) => message.identity);
  if (new Set(identities).size !== identities.length) {
    return false;
  }

  let previousMessageIndex = -1;
  let previousAttachmentIndex = -1;
  for (const selection of value.selectedAttachments) {
    const messageIndex = identities.indexOf(selection.owner);
    if (
      messageIndex < 0 ||
      messageIndex < previousMessageIndex ||
      (messageIndex === previousMessageIndex && selection.index <= previousAttachmentIndex)
    ) {
      return false;
    }
    previousMessageIndex = messageIndex;
    previousAttachmentIndex = selection.index;
  }
  return true;
}

function isQualifyingMessage(value: unknown): value is QualifyingConversationMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["identity", "kind", "text", "author", "timestamp"]) &&
    isNonEmptyString(value.identity) &&
    value.kind === "ordinary-text" &&
    typeof value.text === "string" &&
    value.text.trim().length > 0 &&
    isRecord(value.author) &&
    hasOnlyKeys(value.author, ["id", "name"]) &&
    typeof value.author.id === "string" &&
    typeof value.author.name === "string" &&
    isVisibleTimestamp(value.timestamp)
  );
}

function isAttachmentSelection(value: unknown): value is AttachmentSelection {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["owner", "index", "mediaType", "selection"]) &&
    isNonEmptyString(value.owner) &&
    typeof value.index === "number" &&
    Number.isInteger(value.index) &&
    value.index >= 0 &&
    typeof value.mediaType === "string" &&
    value.mediaType.trim().length > 0 &&
    typeof value.selection === "string"
  );
}

function isVisibleTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    return false;
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) {
    return false;
  }
  return timestamp.toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && allowed.includes(key)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDenseArray(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      return false;
    }
  }
  return true;
}

async function preparePrivateRoot(root: string): Promise<void> {
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await requirePrivateRootIfPresent(root, false))) {
      throw new ConversationPrivateHandoffError();
    }
    await chmod(root, 0o700);
  } catch (error) {
    if (error instanceof ConversationPrivateHandoffError) {
      throw error;
    }
    throw new ConversationPrivateHandoffError();
  }
}

async function requirePrivateRootIfPresent(
  root: string,
  requirePrivatePermissions: boolean
): Promise<boolean> {
  try {
    const metadata = await lstat(root);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (requirePrivatePermissions && (metadata.mode & 0o077) !== 0)
    ) {
      throw new ConversationPrivateHandoffError();
    }
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    if (error instanceof ConversationPrivateHandoffError) {
      throw error;
    }
    throw new ConversationPrivateHandoffError();
  }
}

async function requireRegularRecordIfPresent(
  recordPath: string,
  requirePrivatePermissions: boolean
): Promise<boolean> {
  try {
    const metadata = await lstat(recordPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      (requirePrivatePermissions && (metadata.mode & 0o077) !== 0)
    ) {
      throw new ConversationPrivateHandoffError();
    }
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    if (error instanceof ConversationPrivateHandoffError) {
      throw error;
    }
    throw new ConversationPrivateHandoffError();
  }
}

async function syncDirectory(root: string): Promise<void> {
  const handle = await open(root, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requireInvocationId(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new ConversationPrivateHandoffError();
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
