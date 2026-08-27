import { randomUUID } from "node:crypto";
import { constants as fileSystemConstants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  CONVERSATION_HANDOFF_REQUEST_SUFFIX,
  CONVERSATION_HANDOFF_ROOT,
  CONVERSATION_HANDOFF_SCHEMA_VERSION,
  CONVERSATION_HANDOFF_SNAPSHOT_SUFFIX,
  RUNTIME_ROOT
} from "../constants.js";
import { isOpaqueAttachmentSelection } from "./conversation-parser.js";
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
  private readonly delegate: ConversationPrivateHandoff;

  public constructor() {
    this.delegate = new FilesystemConversationPrivateHandoff(process.cwd());
  }

  public writeRequest(
    invocationId: string,
    request: ConversationObservationRequest
  ): Promise<void> {
    return this.delegate.writeRequest(invocationId, request);
  }

  public readRequest(
    invocationId: string
  ): Promise<ConversationObservationRequest | undefined> {
    return this.delegate.readRequest(invocationId);
  }

  public writeSnapshot(invocationId: string, snapshot: ConversationSnapshot): Promise<void> {
    return this.delegate.writeSnapshot(invocationId, snapshot);
  }

  public readSnapshot(invocationId: string): Promise<ConversationSnapshot | undefined> {
    return this.delegate.readSnapshot(invocationId);
  }
}

class FilesystemConversationPrivateHandoff implements ConversationPrivateHandoff {
  private readonly runtimeRoot: string;
  private readonly root: string;

  public constructor(private readonly workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.runtimeRoot = join(this.workspaceRoot, RUNTIME_ROOT);
    this.root = join(this.workspaceRoot, CONVERSATION_HANDOFF_ROOT);
  }

  public async writeRequest(
    invocationId: string,
    request: ConversationObservationRequest
  ): Promise<void> {
    if (!isObservationRequest(request)) {
      throw new ConversationPrivateHandoffError();
    }
    await this.write(
      invocationId,
      CONVERSATION_HANDOFF_REQUEST_SUFFIX,
      {
        schemaVersion: CONVERSATION_HANDOFF_SCHEMA_VERSION,
        kind: "request",
        request
      },
      isRequestRecord
    );
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
    await this.write(
      invocationId,
      CONVERSATION_HANDOFF_SNAPSHOT_SUFFIX,
      {
        schemaVersion: CONVERSATION_HANDOFF_SCHEMA_VERSION,
        kind: "snapshot",
        snapshot
      },
      isSnapshotRecord
    );
  }

  public async readSnapshot(invocationId: string): Promise<ConversationSnapshot | undefined> {
    const record = await this.read<SnapshotRecord>(
      invocationId,
      CONVERSATION_HANDOFF_SNAPSHOT_SUFFIX,
      isSnapshotRecord
    );
    return record?.snapshot;
  }

  private async write<Record>(
    invocationId: string,
    suffix: string,
    record: Record,
    validate: (value: unknown) => value is Record
  ): Promise<void> {
    requireInvocationId(invocationId);
    const contents = serializeRecord(record, validate);
    await preparePrivateRoot(this.workspaceRoot, this.runtimeRoot, this.root);
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
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, recordPath);
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
      if (!(await requirePrivateRootIfPresent(this.workspaceRoot, this.runtimeRoot, this.root))) {
        return undefined;
      }
      const recordPath = join(this.root, `${invocationId}${suffix}`);
      const contents = await readPrivateRecord(recordPath);
      if (contents === undefined) {
        return undefined;
      }
      const value = JSON.parse(contents) as unknown;
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
    hasExactOwnDataKeys(value, ["schemaVersion", "kind", "request"]) &&
    value.schemaVersion === CONVERSATION_HANDOFF_SCHEMA_VERSION &&
    value.kind === "request" &&
    isObservationRequest(value.request)
  );
}

function isSnapshotRecord(value: unknown): value is SnapshotRecord {
  return (
    isRecord(value) &&
    hasExactOwnDataKeys(value, ["schemaVersion", "kind", "snapshot"]) &&
    value.schemaVersion === CONVERSATION_HANDOFF_SCHEMA_VERSION &&
    value.kind === "snapshot" &&
    isConversationSnapshot(value.snapshot)
  );
}

function isObservationRequest(value: unknown): value is ConversationObservationRequest {
  return (
    isRecord(value) &&
    hasExactOwnDataKeys(
      value,
      ["destination", "stopAfterQualifyingMessages"],
      ["boundary"]
    ) &&
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
    !hasExactOwnDataKeys(
      value,
      ["destination", "complete", "messages", "selectedAttachments"],
      ["boundary", "segmentStart"]
    ) ||
    !isNonEmptyString(value.destination) ||
    (value.boundary !== undefined && !isNonEmptyString(value.boundary)) ||
    (value.segmentStart !== undefined && !isNonEmptyString(value.segmentStart)) ||
    (value.boundary === undefined) === (value.segmentStart === undefined) ||
    typeof value.complete !== "boolean" ||
    !isPlainDenseArray(value.messages) ||
    !value.messages.every(isQualifyingMessage) ||
    !isPlainDenseArray(value.selectedAttachments) ||
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
  const opaqueSelections = new Set<string>();
  for (const selection of value.selectedAttachments) {
    const messageIndex = identities.indexOf(selection.owner);
    if (
      messageIndex < 0 ||
      messageIndex < previousMessageIndex ||
      (messageIndex === previousMessageIndex && selection.index <= previousAttachmentIndex) ||
      opaqueSelections.has(selection.selection)
    ) {
      return false;
    }
    opaqueSelections.add(selection.selection);
    previousMessageIndex = messageIndex;
    previousAttachmentIndex = selection.index;
  }
  return true;
}

function isQualifyingMessage(value: unknown): value is QualifyingConversationMessage {
  return (
    isRecord(value) &&
    hasExactOwnDataKeys(value, ["identity", "kind", "text", "author", "timestamp"]) &&
    isNonEmptyString(value.identity) &&
    value.kind === "ordinary-text" &&
    typeof value.text === "string" &&
    value.text.trim().length > 0 &&
    isRecord(value.author) &&
    hasExactOwnDataKeys(value.author, ["id", "name"]) &&
    typeof value.author.id === "string" &&
    typeof value.author.name === "string" &&
    isVisibleTimestamp(value.timestamp)
  );
}

function isAttachmentSelection(value: unknown): value is AttachmentSelection {
  return (
    isRecord(value) &&
    hasExactOwnDataKeys(value, ["owner", "index", "mediaType", "selection"]) &&
    isNonEmptyString(value.owner) &&
    typeof value.index === "number" &&
    Number.isInteger(value.index) &&
    value.index >= 0 &&
    typeof value.mediaType === "string" &&
    value.mediaType.trim().length > 0 &&
    isOpaqueAttachmentSelection(value.selection)
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
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactOwnDataKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = [...required, ...optional];
  const keys = Reflect.ownKeys(value);
  return (
    !("toJSON" in value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) =>
      typeof key === "string" &&
      allowed.includes(key) &&
      isEnumerableDataProperty(value, key)
    )
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainDenseArray(value: unknown): value is readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    "toJSON" in value
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    if (!Object.hasOwn(value, key) || !isEnumerableDataProperty(value, key)) {
      return false;
    }
  }
  return keys.every(
    (key) =>
      typeof key === "string" &&
      (key === "length" || (/^(?:0|[1-9]\d*)$/.test(key) && Number(key) < value.length))
  );
}

function isEnumerableDataProperty(value: object, key: PropertyKey): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true;
}

function serializeRecord<Record>(
  record: Record,
  validate: (value: unknown) => value is Record
): string {
  try {
    if (!validate(record)) {
      throw new ConversationPrivateHandoffError();
    }
    const serialized = JSON.stringify(record);
    const roundTripped = JSON.parse(serialized) as unknown;
    if (
      !validate(roundTripped) ||
      !isDeepStrictEqual(record, roundTripped) ||
      JSON.stringify(roundTripped) !== serialized
    ) {
      throw new ConversationPrivateHandoffError();
    }
    return `${serialized}\n`;
  } catch (error) {
    if (error instanceof ConversationPrivateHandoffError) {
      throw error;
    }
    throw new ConversationPrivateHandoffError();
  }
}

async function preparePrivateRoot(
  workspaceRoot: string,
  runtimeRoot: string,
  handoffRoot: string
): Promise<void> {
  try {
    if (!(await requireDirectoryIfPresent(workspaceRoot, false, false))) {
      throw new ConversationPrivateHandoffError();
    }
    for (const directory of [runtimeRoot, handoffRoot]) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
      }
      if (!(await requireDirectoryIfPresent(directory, false, true))) {
        throw new ConversationPrivateHandoffError();
      }
    }
  } catch (error) {
    if (error instanceof ConversationPrivateHandoffError) {
      throw error;
    }
    throw new ConversationPrivateHandoffError();
  }
}

async function requirePrivateRootIfPresent(
  workspaceRoot: string,
  runtimeRoot: string,
  handoffRoot: string
): Promise<boolean> {
  if (!(await requireDirectoryIfPresent(workspaceRoot, false, false))) {
    throw new ConversationPrivateHandoffError();
  }
  if (!(await requireDirectoryIfPresent(runtimeRoot, true, false))) {
    return false;
  }
  return requireDirectoryIfPresent(handoffRoot, true, false);
}

async function requireDirectoryIfPresent(
  directory: string,
  requirePrivatePermissions: boolean,
  makePrivate: boolean
): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(
        directory,
        fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW
      );
    } catch (error) {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    }
    const metadata = await handle.stat();
    if (
      !metadata.isDirectory() ||
      (requirePrivatePermissions && (metadata.mode & 0o077) !== 0)
    ) {
      throw new ConversationPrivateHandoffError();
    }
    if (makePrivate) {
      await handle.chmod(0o700);
    }
    return true;
  } catch (error) {
    if (error instanceof ConversationPrivateHandoffError) {
      throw error;
    }
    throw new ConversationPrivateHandoffError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readPrivateRecord(recordPath: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(
        recordPath,
        fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW
      );
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }

    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new ConversationPrivateHandoffError();
    }
    return await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof ConversationPrivateHandoffError) {
      throw error;
    }
    throw new ConversationPrivateHandoffError();
  } finally {
    await handle?.close().catch(() => undefined);
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
  const handle = await open(
    root,
    fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory()) {
      throw new ConversationPrivateHandoffError();
    }
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

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
