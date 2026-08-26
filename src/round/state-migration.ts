import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  FEEDBACK_MESSAGE_LIMIT,
  ROUND_SCHEMA_VERSION,
  SUPPORTED_IMAGE_EXTENSIONS
} from "../constants.js";
import type { CapturedMessage } from "./message-collector.js";
import type { RoundState } from "./round-state.js";
import { JsonRoundStateStore } from "./round-state-store.js";

export interface StateMigrationPaths {
  legacyStatePath: string;
  newStatePath: string;
  legacyBaseImageRoot: string;
  newBaseImageRoot: string;
  migrationRoot: string;
}

export interface StateMigrationResult {
  migrated: true;
  roundId: string;
  phase: "synthesizing-feedback";
}

interface LegacyRound {
  schemaVersion: 2;
  id: string;
  phase: "closing-collection";
  baseImagePath: string;
  channelUrl: string;
  messageLimit: number;
  baseMessageUrl: string;
  collectionStartedAt: string;
  capturedMessages: CapturedMessage[];
}

export async function migrateLegacyState(
  paths: StateMigrationPaths
): Promise<StateMigrationResult> {
  if (await pathExists(paths.newStatePath)) {
    throw new Error("Durable round state already exists; migration was not run.");
  }

  const legacyContents = await readFile(paths.legacyStatePath, "utf8");
  const legacyRound = parseSupportedLegacyRound(legacyContents);
  const legacyBaseImagePath = await requireContainedLegacyImage(
    legacyRound.baseImagePath,
    paths.legacyBaseImageRoot
  );
  const resultImageName = `${legacyRound.id}${extname(legacyBaseImagePath).toLowerCase()}`;
  const newBaseImagePath = resolve(paths.newBaseImageRoot, resultImageName);

  await mkdir(paths.newBaseImageRoot, { recursive: true });
  await mkdir(paths.migrationRoot, { recursive: true });
  await copyFile(legacyBaseImagePath, newBaseImagePath, fsConstants.COPYFILE_EXCL);
  await copyFile(
    paths.legacyStatePath,
    join(paths.migrationRoot, "rounds-v2.json"),
    fsConstants.COPYFILE_EXCL
  );

  const migratedRound: RoundState = {
    schemaVersion: ROUND_SCHEMA_VERSION,
    id: legacyRound.id,
    phase: "synthesizing-feedback",
    baseImagePath: newBaseImagePath,
    channelUrl: legacyRound.channelUrl,
    messageLimit: legacyRound.messageLimit,
    baseMessageUrl: legacyRound.baseMessageUrl,
    collectionStartedAt: legacyRound.collectionStartedAt,
    capturedMessages: legacyRound.capturedMessages
  };
  await new JsonRoundStateStore(paths.newStatePath).save(migratedRound);
  return { migrated: true, roundId: migratedRound.id, phase: "synthesizing-feedback" };
}

function parseSupportedLegacyRound(contents: string): LegacyRound {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw unsupportedLegacyState();
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 2 || !Array.isArray(parsed.rounds)) {
    throw unsupportedLegacyState();
  }
  if (parsed.rounds.length !== 1 || !isRecord(parsed.rounds[0])) {
    throw unsupportedLegacyState();
  }
  const round = parsed.rounds[0];
  if (
    round.schemaVersion !== 2 ||
    round.phase !== "closing-collection" ||
    typeof round.id !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(round.id) ||
    typeof round.baseImagePath !== "string" ||
    typeof round.channelUrl !== "string" ||
    round.messageLimit !== FEEDBACK_MESSAGE_LIMIT ||
    typeof round.baseMessageUrl !== "string" ||
    typeof round.collectionStartedAt !== "string" ||
    !Array.isArray(round.capturedMessages) ||
    round.capturedMessages.length !== FEEDBACK_MESSAGE_LIMIT ||
    round.closedMessageUrl !== undefined ||
    round.generationOutcome !== undefined ||
    round.outcomeMessageUrl !== undefined ||
    round.attentionReason !== undefined ||
    round.synthesizedPrompt !== undefined
  ) {
    throw unsupportedLegacyState();
  }
  const capturedMessages = round.capturedMessages.map(parseCapturedMessage);
  return {
    schemaVersion: 2,
    id: round.id,
    phase: "closing-collection",
    baseImagePath: round.baseImagePath,
    channelUrl: round.channelUrl,
    messageLimit: round.messageLimit,
    baseMessageUrl: round.baseMessageUrl,
    collectionStartedAt: round.collectionStartedAt,
    capturedMessages
  };
}

function parseCapturedMessage(value: unknown): CapturedMessage {
  if (!isRecord(value)) {
    throw unsupportedLegacyState();
  }
  const keys = ["messageUrl", "authorId", "authorName", "timestamp", "text"] as const;
  if (keys.some((key) => typeof value[key] !== "string")) {
    throw unsupportedLegacyState();
  }
  return {
    messageUrl: value.messageUrl as string,
    authorId: value.authorId as string,
    authorName: value.authorName as string,
    timestamp: value.timestamp as string,
    text: value.text as string
  };
}

async function requireContainedLegacyImage(path: string, root: string): Promise<string> {
  let resolvedPath: string;
  let resolvedRoot: string;
  try {
    [resolvedPath, resolvedRoot] = await Promise.all([realpath(resolve(path)), realpath(resolve(root))]);
  } catch {
    throw unsupportedLegacyState();
  }
  const pathFromRoot = relative(resolvedRoot, resolvedPath);
  const extension = extname(resolvedPath).toLowerCase();
  const isContained =
    pathFromRoot.length > 0 &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot);
  if (
    !isContained ||
    !SUPPORTED_IMAGE_EXTENSIONS.some((candidate) => candidate === extension) ||
    !(await stat(resolvedPath)).isFile()
  ) {
    throw unsupportedLegacyState();
  }
  return resolvedPath;
}

function unsupportedLegacyState(): Error {
  return new Error("Legacy state is not the supported frozen live round.");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
