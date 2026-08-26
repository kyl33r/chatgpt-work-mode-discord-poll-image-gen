import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  FEEDBACK_IMAGE_LIMIT_PER_ROUND,
  FEEDBACK_IMAGE_LIMIT_PER_MESSAGE,
  ROUND_SCHEMA_VERSION,
  ROUND_STATE_FILE_NAME
} from "../constants.js";
import { assertSafeRoundId, roundCapsuleDirectory } from "./round-paths.js";
import type { RoundState } from "./round-state.js";

export interface RoundStateStore {
  get(roundId: string): Promise<RoundState | undefined>;
  list(): Promise<RoundState[]>;
  save(round: RoundState): Promise<void>;
}

export class JsonRoundStateStore implements RoundStateStore {
  public constructor(private readonly roundsRoot: string) {}

  public async get(roundId: string): Promise<RoundState | undefined> {
    assertSafeRoundId(roundId);
    const capsulePath = roundCapsuleDirectory(this.roundsRoot, roundId);
    const statePath = join(capsulePath, ROUND_STATE_FILE_NAME);
    try {
      await requireContainedDirectory(capsulePath, this.roundsRoot);
      return await readRoundState(statePath, roundId);
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async list(): Promise<RoundState[]> {
    let entries;
    try {
      entries = await readdir(this.roundsRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }

    const rounds: RoundState[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) {
        throw malformedCapsule();
      }
      if (!entry.isDirectory()) {
        continue;
      }
      assertSafeRoundId(entry.name);
      const capsulePath = roundCapsuleDirectory(this.roundsRoot, entry.name);
      await requireContainedDirectory(capsulePath, this.roundsRoot);
      try {
        rounds.push(
          await readRoundState(join(capsulePath, ROUND_STATE_FILE_NAME), entry.name)
        );
      } catch (error) {
        if (isMissingFileError(error)) {
          continue;
        }
        throw error;
      }
    }
    return rounds;
  }

  public async save(round: RoundState): Promise<void> {
    assertSafeRoundId(round.id);
    if (!isRoundState(round, round.id)) {
      throw malformedCapsule();
    }
    await mkdir(this.roundsRoot, { recursive: true });
    const capsulePath = roundCapsuleDirectory(this.roundsRoot, round.id);
    await mkdir(capsulePath, { recursive: true });
    await requireContainedDirectory(capsulePath, this.roundsRoot);
    const statePath = join(capsulePath, ROUND_STATE_FILE_NAME);
    const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    const contents = `${JSON.stringify(round, null, 2)}\n`;
    const handle = await open(temporaryPath, "wx");

    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporaryPath, statePath);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

async function readRoundState(statePath: string, expectedRoundId: string): Promise<RoundState> {
  let parsed: unknown;
  try {
    const metadata = await lstat(statePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw malformedCapsule();
    }
    parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown;
  } catch (error) {
    if (isMissingFileError(error)) {
      throw error;
    }
    throw malformedCapsule();
  }
  if (!isRoundState(parsed, expectedRoundId)) {
    throw malformedCapsule();
  }
  return parsed;
}

const ROUND_PHASES = new Set([
  "draft",
  "submitting-base",
  "collecting-messages",
  "synthesizing-feedback",
  "closing-collection",
  "ready-to-generate",
  "generating",
  "outcome-ready",
  "publishing-outcome",
  "completed",
  "stopped",
  "needs-attention"
]);

const ROUND_KEYS = new Set([
  "schemaVersion",
  "id",
  "phase",
  "baseImagePath",
  "channelUrl",
  "messageLimit",
  "parentRoundId",
  "baseMessageUrl",
  "collectionStartedAt",
  "capturedMessages",
  "feedbackCaptureBatch",
  "synthesizedPrompt",
  "closedMessageUrl",
  "generationOutcome",
  "outcomeMessageUrl",
  "attentionReason"
]);

function isRoundState(value: unknown, expectedRoundId: string): value is RoundState {
  if (!isRecord(value) || Object.keys(value).some((key) => !ROUND_KEYS.has(key))) {
    return false;
  }
  if (
    value.schemaVersion !== ROUND_SCHEMA_VERSION ||
    value.id !== expectedRoundId ||
    typeof value.phase !== "string" ||
    !ROUND_PHASES.has(value.phase) ||
    typeof value.baseImagePath !== "string" ||
    typeof value.channelUrl !== "string" ||
    !Number.isInteger(value.messageLimit) ||
    (value.messageLimit as number) <= 0 ||
    !isOptionalString(value.parentRoundId) ||
    !Array.isArray(value.capturedMessages) ||
    value.capturedMessages.length > (value.messageLimit as number) ||
    !value.capturedMessages.every(isCapturedMessage) ||
    !hasStableCapturedMessageOrder(value.capturedMessages) ||
    value.capturedMessages.reduce(
      (total, message) => total + (message as { contextImages: unknown[] }).contextImages.length,
      0
    ) > FEEDBACK_IMAGE_LIMIT_PER_ROUND ||
    !isOptionalString(value.baseMessageUrl) ||
    !isOptionalString(value.collectionStartedAt) ||
    !isOptionalString(value.synthesizedPrompt) ||
    !isOptionalString(value.closedMessageUrl) ||
    !isOptionalString(value.outcomeMessageUrl) ||
    !isOptionalString(value.attentionReason) ||
    !isGenerationOutcome(value.generationOutcome) ||
    !isFeedbackCaptureBatch(
      value.feedbackCaptureBatch,
      value.phase,
      value.baseMessageUrl,
      value.messageLimit,
      value.capturedMessages
    )
  ) {
    return false;
  }
  return true;
}

function isFeedbackCaptureBatch(
  value: unknown,
  phase: unknown,
  baseMessageUrl: unknown,
  messageLimit: unknown,
  capturedMessages: unknown[]
): boolean {
  if (value === undefined) {
    return true;
  }
  if (
    phase !== "collecting-messages" ||
    typeof baseMessageUrl !== "string" ||
    !Number.isInteger(messageLimit) ||
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.boundaryMessageUrl !== "string" ||
    value.boundaryMessageUrl !== baseMessageUrl ||
    !Array.isArray(value.messages) ||
    value.messages.length === 0
  ) {
    return false;
  }
  const messageUrls = new Set<string>();
  const capturedUrls = new Set(
    capturedMessages.map((message) => (message as { messageUrl: string }).messageUrl)
  );
  let previousOrdinal = 0;
  let selectedCount = capturedMessages.reduce<number>(
    (total, message) => total + (message as { contextImages: unknown[] }).contextImages.length,
    0
  );
  let inProgressCount: number = 0;
  for (const message of value.messages) {
    if (
      !isRecord(message) ||
      Object.keys(message).length !== 3 ||
      typeof message.messageUrl !== "string" ||
      message.messageUrl.length === 0 ||
      messageUrls.has(message.messageUrl) ||
      !Number.isInteger(message.messageOrdinal) ||
      (message.messageOrdinal as number) <= previousOrdinal ||
      (message.messageOrdinal as number) <= capturedMessages.length ||
      (message.messageOrdinal as number) > (messageLimit as number) ||
      capturedUrls.has(message.messageUrl) ||
      !Array.isArray(message.selectedAttachments) ||
      message.selectedAttachments.length === 0 ||
      message.selectedAttachments.length > FEEDBACK_IMAGE_LIMIT_PER_MESSAGE
    ) {
      return false;
    }
    messageUrls.add(message.messageUrl);
    previousOrdinal = message.messageOrdinal as number;
    let previousAttachmentIndex = -1;
    for (const attachment of message.selectedAttachments) {
      if (!isFeedbackCaptureAttachment(attachment) || attachment.attachmentIndex <= previousAttachmentIndex) {
        return false;
      }
      previousAttachmentIndex = attachment.attachmentIndex;
      selectedCount += 1;
      if (attachment.status === "copy-intent-recorded") {
        inProgressCount += 1;
      }
    }
  }
  return selectedCount <= FEEDBACK_IMAGE_LIMIT_PER_ROUND && inProgressCount <= 1;
}

function isFeedbackCaptureAttachment(value: unknown): value is {
  attachmentIndex: number;
  mediaType: string;
  status: string;
} {
  if (!isRecord(value) || !Number.isInteger(value.attachmentIndex) || (value.attachmentIndex as number) < 0) {
    return false;
  }
  if (value.mediaType !== "image/png" && value.mediaType !== "image/jpeg" && value.mediaType !== "image/webp") {
    return false;
  }
  if (value.status === "selected") {
    return Object.keys(value).length === 3;
  }
  if (value.status === "copy-intent-recorded") {
    return Object.keys(value).length === 4 && Number.isInteger(value.expectedClipboardChangeCount) && (value.expectedClipboardChangeCount as number) >= 0;
  }
  return value.status === "accepted" && Object.keys(value).length === 4 && typeof value.imagePath === "string" && value.imagePath.length > 0;
}

function hasStableCapturedMessageOrder(messages: unknown[]): boolean {
  const messageUrls = new Set<string>();
  const imagePaths = new Set<string>();
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (const value of messages) {
    const message = value as {
      messageUrl: string;
      timestamp: string;
      contextImages: Array<{ imagePath: string }>;
    };
    const timestamp = Date.parse(message.timestamp);
    if (
      !Number.isFinite(timestamp) ||
      timestamp <= previousTimestamp ||
      messageUrls.has(message.messageUrl)
    ) {
      return false;
    }
    previousTimestamp = timestamp;
    messageUrls.add(message.messageUrl);
    for (const image of message.contextImages) {
      if (imagePaths.has(image.imagePath)) {
        return false;
      }
      imagePaths.add(image.imagePath);
    }
  }
  return true;
}

function isCapturedMessage(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = ["messageUrl", "authorId", "authorName", "timestamp", "text", "contextImages"];
  if (!(
    Object.keys(value).every((key) => keys.includes(key)) &&
    keys.slice(0, 5).every((key) => typeof value[key] === "string") &&
    Array.isArray(value.contextImages) &&
    value.contextImages.length <= FEEDBACK_IMAGE_LIMIT_PER_MESSAGE &&
    value.contextImages.every(isContextImage)
  )) {
    return false;
  }
  const contextImages = value.contextImages as unknown[];
  return contextImages.every(
    (image, index) =>
      index === 0 ||
      (image as { attachmentIndex: number }).attachmentIndex >
        (contextImages[index - 1] as { attachmentIndex: number }).attachmentIndex
  );
}

function isContextImage(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === "attachmentIndex" || key === "imagePath") &&
    Object.keys(value).length === 2 &&
    Number.isInteger(value.attachmentIndex) &&
    (value.attachmentIndex as number) >= 0 &&
    typeof value.imagePath === "string" &&
    value.imagePath.length > 0
  );
}

function isGenerationOutcome(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  if (value.kind === "succeeded") {
    return (
      typeof value.resultImagePath === "string" &&
      Object.keys(value).every((key) => key === "kind" || key === "resultImagePath")
    );
  }
  return (
    (value.kind === "refused" || value.kind === "failed") &&
    Object.keys(value).length === 1
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requireContainedDirectory(path: string, root: string): Promise<void> {
  const expectedPath = resolve(path);
  const expectedPathFromRoot = relative(resolve(root), expectedPath);
  const [resolvedPath, resolvedRoot] = await Promise.all([
    realpath(expectedPath),
    realpath(resolve(root))
  ]);
  const pathFromRoot = relative(resolvedRoot, resolvedPath);
  if (
    pathFromRoot !== expectedPathFromRoot ||
    pathFromRoot.length === 0 ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw malformedCapsule();
  }
}

function malformedCapsule(): Error {
  return new Error("Unsupported or malformed Round State Capsule.");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
