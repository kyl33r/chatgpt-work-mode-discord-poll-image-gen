import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  FEEDBACK_MESSAGE_LIMIT,
  LEGACY_STATE_BACKUP_FILE,
  ROUND_SCHEMA_VERSION,
  STATE_MIGRATION_TRANSACTION_FILE,
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
  const stateRoot = dirname(resolve(paths.newStatePath));
  const legacyContents = await readFile(paths.legacyStatePath, "utf8");
  const legacyRound = parseSupportedLegacyRound(legacyContents);
  const legacyBaseImagePath = await requireContainedLegacyImage(
    legacyRound.baseImagePath,
    paths.legacyBaseImageRoot
  );
  const stateRelativePath = requireContainedDestination(paths.newStatePath, stateRoot);
  const baseRootRelativePath = requireContainedDestination(paths.newBaseImageRoot, stateRoot);
  const migrationRootRelativePath = requireContainedDestination(paths.migrationRoot, stateRoot);
  const resultImageName = `${legacyRound.id}${extname(legacyBaseImagePath).toLowerCase()}`;
  const newBaseImagePath = resolve(paths.newBaseImageRoot, resultImageName);
  const newMigrationBackupPath = resolve(paths.migrationRoot, LEGACY_STATE_BACKUP_FILE);
  const transactionPath = resolve(
    paths.migrationRoot,
    STATE_MIGRATION_TRANSACTION_FILE
  );
  const temporaryRoot = join(dirname(stateRoot), `.${basename(stateRoot)}.migration-v2`);
  if (
    await recoverInterruptedMigration({
      transactionPath,
      newStatePath: paths.newStatePath,
      newBaseImagePath,
      newMigrationBackupPath,
      temporaryRoot,
      expectedRoundId: legacyRound.id
    })
  ) {
    return { migrated: true, roundId: legacyRound.id, phase: "synthesizing-feedback" };
  }
  if (await pathExists(paths.newStatePath)) {
    throw new Error("Durable round state already exists; migration was not run.");
  }
  if (await pathExists(newBaseImagePath) || await pathExists(newMigrationBackupPath)) {
    throw new Error("A durable migration artifact already exists; migration was not run.");
  }
  await rm(temporaryRoot, { recursive: true, force: true });

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
  const committedArtifacts: string[] = [];
  let transactionCreated = false;
  try {
    const stagedBaseRoot = join(temporaryRoot, baseRootRelativePath);
    const stagedMigrationRoot = join(temporaryRoot, migrationRootRelativePath);
    const stagedBaseImagePath = join(stagedBaseRoot, resultImageName);
    const stagedMigrationBackupPath = join(
      stagedMigrationRoot,
      LEGACY_STATE_BACKUP_FILE
    );
    const stagedStatePath = join(temporaryRoot, stateRelativePath);
    await mkdir(stagedBaseRoot, { recursive: true });
    await mkdir(stagedMigrationRoot, { recursive: true });
    await copyFile(
      legacyBaseImagePath,
      stagedBaseImagePath,
      fsConstants.COPYFILE_EXCL
    );
    await copyFile(
      paths.legacyStatePath,
      stagedMigrationBackupPath,
      fsConstants.COPYFILE_EXCL
    );
    await new JsonRoundStateStore(stagedStatePath).save(migratedRound);

    await mkdir(paths.newBaseImageRoot, { recursive: true });
    await mkdir(paths.migrationRoot, { recursive: true });
    await createTransactionMarker(transactionPath);
    transactionCreated = true;
    await rename(stagedBaseImagePath, newBaseImagePath);
    committedArtifacts.push(newBaseImagePath);
    await rename(stagedMigrationBackupPath, newMigrationBackupPath);
    committedArtifacts.push(newMigrationBackupPath);
    await rename(stagedStatePath, paths.newStatePath);
    await rm(transactionPath, { force: true }).catch(() => undefined);
    transactionCreated = false;
  } catch (error) {
    await Promise.all(committedArtifacts.map((path) => rm(path, { force: true })));
    if (transactionCreated) {
      await rm(transactionPath, { force: true });
    }
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  await rm(temporaryRoot, { recursive: true, force: true });
  return { migrated: true, roundId: migratedRound.id, phase: "synthesizing-feedback" };
}

interface InterruptedMigrationPaths {
  transactionPath: string;
  newStatePath: string;
  newBaseImagePath: string;
  newMigrationBackupPath: string;
  temporaryRoot: string;
  expectedRoundId: string;
}

async function recoverInterruptedMigration(
  paths: InterruptedMigrationPaths
): Promise<boolean> {
  if (!(await pathExists(paths.transactionPath))) {
    return false;
  }
  if (await pathExists(paths.newStatePath)) {
    const round = await new JsonRoundStateStore(paths.newStatePath).get(paths.expectedRoundId);
    if (
      !round ||
      round.phase !== "synthesizing-feedback" ||
      round.baseImagePath !== paths.newBaseImagePath
    ) {
      throw new Error("Interrupted migration requires manual reconciliation.");
    }
    await rm(paths.temporaryRoot, { recursive: true, force: true });
    await rm(paths.transactionPath, { force: true });
    return true;
  }
  await Promise.all([
    rm(paths.newBaseImagePath, { force: true }),
    rm(paths.newMigrationBackupPath, { force: true }),
    rm(paths.temporaryRoot, { recursive: true, force: true })
  ]);
  await rm(paths.transactionPath, { force: true });
  return false;
}

async function createTransactionMarker(path: string): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile("in-progress\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requireContainedDestination(path: string, root: string): string {
  const relativePath = relative(root, resolve(path));
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Migration destinations must reside beneath the durable state directory.");
  }
  return relativePath;
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
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
