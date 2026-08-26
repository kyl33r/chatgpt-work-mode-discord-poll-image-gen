import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  FEEDBACK_MESSAGE_LIMIT,
  LEGACY_V2_STATE_BACKUP_FILE,
  LEGACY_V3_STATE_BACKUP_FILE,
  LEGACY_V4_ROUND_BACKUP_FILE,
  LEGACY_V5_ROUND_BACKUP_FILE,
  LEGACY_V6_ROUND_BACKUP_FILE,
  ROUND_BASE_IMAGE_BASENAME,
  ROUND_MIGRATION_STAGING_DIRECTORY,
  ROUND_MIGRATIONS_DIRECTORY_NAME,
  ROUND_SCHEMA_VERSION,
  ROUND_STATE_FILE_NAME,
  SUPPORTED_IMAGE_EXTENSIONS
} from "../constants.js";
import type { CapturedMessage } from "./message-collector.js";
import { assertSafeRoundId, roundCapsuleDirectory } from "./round-paths.js";
import type { RoundState } from "./round-state.js";
import { JsonRoundStateStore } from "./round-state-store.js";

export interface IsolatedRoundMigrationResult {
  migratedRoundCount: number;
}

export async function migrateIsolatedRoundCapsulesToV7(
  roundsRoot: string
): Promise<IsolatedRoundMigrationResult> {
  let entries;
  try {
    entries = await readdir(roundsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return { migratedRoundCount: 0 };
    }
    throw error;
  }
  const resolvedRoot = await realpath(resolve(roundsRoot));
  let migratedRoundCount = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) {
      throw unsupportedIsolatedState();
    }
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      assertSafeRoundId(entry.name);
    } catch {
      throw unsupportedIsolatedState();
    }
    const capsule = roundCapsuleDirectory(roundsRoot, entry.name);
    const resolvedCapsule = await realpath(capsule);
    const capsuleFromRoot = relative(resolvedRoot, resolvedCapsule);
    if (
      capsuleFromRoot !== entry.name ||
      capsuleFromRoot === ".." ||
      capsuleFromRoot.startsWith(`..${sep}`) ||
      isAbsolute(capsuleFromRoot)
    ) {
      throw unsupportedIsolatedState();
    }
    const statePath = join(capsule, ROUND_STATE_FILE_NAME);
    const stateMetadata = await lstat(statePath).catch(() => {
      throw unsupportedIsolatedState();
    });
    if (!stateMetadata.isFile() || stateMetadata.isSymbolicLink()) {
      throw unsupportedIsolatedState();
    }
    const legacyContents = await readFile(statePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(legacyContents) as unknown;
    } catch {
      throw unsupportedIsolatedState();
    }
    if (isRecord(parsed) && parsed.schemaVersion === ROUND_SCHEMA_VERSION) {
      try {
        if (!(await new JsonRoundStateStore(roundsRoot).get(entry.name))) {
          throw new Error("missing current round");
        }
      } catch {
        throw unsupportedIsolatedState();
      }
      continue;
    }
    if (
      !isRecord(parsed) ||
      (parsed.schemaVersion !== 4 && parsed.schemaVersion !== 5 && parsed.schemaVersion !== 6) ||
      parsed.id !== entry.name ||
      (parsed.schemaVersion === 4 && "parentRoundId" in parsed) ||
      !Array.isArray(parsed.capturedMessages)
    ) {
      throw unsupportedIsolatedState();
    }
    if (
      parsed.schemaVersion === 6 &&
      Object.keys(parsed).some((key) => !V6_ROUND_KEYS.has(key))
    ) {
      throw unsupportedIsolatedState();
    }
    const legacyVersion = parsed.schemaVersion;
    const { feedbackCaptureBatch: _discardedCaptureBatch, ...legacyWithoutCaptureBatch } = parsed;
    const migrated = {
      ...legacyWithoutCaptureBatch,
      schemaVersion: ROUND_SCHEMA_VERSION,
      capturedMessages: parsed.capturedMessages.map((message) => {
        if (!isRecord(message)) {
          throw unsupportedIsolatedState();
        }
        if (parsed.schemaVersion === 6) {
          if (!("contextImages" in message)) {
            throw unsupportedIsolatedState();
          }
          return message;
        }
        if ("contextImages" in message) {
          throw unsupportedIsolatedState();
        }
        return { ...message, contextImages: [] };
      })
    } as unknown as RoundState;
    const validationRoot = join(dirname(roundsRoot), `.round-v6-validation-${Date.now()}`);
    try {
      await new JsonRoundStateStore(validationRoot).save(migrated);
    } catch {
      throw unsupportedIsolatedState();
    } finally {
      await rm(validationRoot, { recursive: true, force: true });
    }
    const migrations = join(capsule, ROUND_MIGRATIONS_DIRECTORY_NAME);
    try {
      await mkdir(migrations, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
    const migrationsMetadata = await lstat(migrations).catch(() => {
      throw unsupportedIsolatedState();
    });
    if (
      !migrationsMetadata.isDirectory() ||
      migrationsMetadata.isSymbolicLink() ||
      relative(resolvedCapsule, await realpath(migrations)) !== ROUND_MIGRATIONS_DIRECTORY_NAME
    ) {
      throw unsupportedIsolatedState();
    }
    const backupPath = join(
      migrations,
      legacyVersion === 4
        ? LEGACY_V4_ROUND_BACKUP_FILE
        : legacyVersion === 5
          ? LEGACY_V5_ROUND_BACKUP_FILE
          : LEGACY_V6_ROUND_BACKUP_FILE
    );
    await ensureIsolatedMigrationBackup(backupPath, legacyContents);
    const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(migrated, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporaryPath, statePath);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    migratedRoundCount += 1;
  }
  return { migratedRoundCount };
}

const V6_ROUND_KEYS = new Set([
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
  "synthesizedPrompt",
  "closedMessageUrl",
  "generationOutcome",
  "outcomeMessageUrl",
  "attentionReason"
]);

async function ensureIsolatedMigrationBackup(
  backupPath: string,
  legacyContents: string
): Promise<void> {
  try {
    await requireMatchingRegularBackup(backupPath, legacyContents);
    return;
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw unsupportedIsolatedState();
    }
  }

  let backup;
  try {
    backup = await open(backupPath, "wx", 0o600);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      await requireMatchingRegularBackup(backupPath, legacyContents).catch(() => {
        throw unsupportedIsolatedState();
      });
      return;
    }
    throw error;
  }
  try {
    await backup.writeFile(legacyContents, "utf8");
    await backup.sync();
    await backup.close();
  } catch (error) {
    await backup.close().catch(() => undefined);
    await rm(backupPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function requireMatchingRegularBackup(
  backupPath: string,
  expectedContents: string
): Promise<void> {
  const metadata = await lstat(backupPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (await readFile(backupPath, "utf8")) !== expectedContents
  ) {
    throw unsupportedIsolatedState();
  }
}

export interface SharedStateMigrationPaths {
  legacyStatePath: string;
  legacyBaseImageRoot: string;
  legacyMigrationRoot: string;
  roundsRoot: string;
}

export interface RoundStateMigrationResult {
  isolated: IsolatedRoundMigrationResult;
  shared?: StateMigrationResult;
}

export async function migrateRoundState(
  paths: SharedStateMigrationPaths
): Promise<RoundStateMigrationResult> {
  const isolated = await migrateIsolatedRoundCapsulesToV7(paths.roundsRoot);
  if (!(await pathExists(paths.legacyStatePath))) {
    return { isolated };
  }
  return { isolated, shared: await migrateSharedRoundState(paths) };
}

export interface StateMigrationResult {
  migrated: true;
  roundId: string;
  phase: "synthesizing-feedback";
}

interface LegacyRoundState {
  schemaVersion: 3;
  id: string;
  phase: "synthesizing-feedback";
  baseImagePath: string;
  channelUrl: string;
  messageLimit: number;
  baseMessageUrl: string;
  collectionStartedAt: string;
  capturedMessages: CapturedMessage[];
}

export async function migrateSharedRoundState(
  paths: SharedStateMigrationPaths
): Promise<StateMigrationResult> {
  const legacyContents = await readFile(paths.legacyStatePath, "utf8");
  const legacyRound = parseSupportedLegacyRound(legacyContents);
  const legacyBaseImagePath = await requireContainedLegacyImage(
    legacyRound.baseImagePath,
    paths.legacyBaseImageRoot
  );
  const destinationCapsule = roundCapsuleDirectory(paths.roundsRoot, legacyRound.id);
  const baseImageName = `${ROUND_BASE_IMAGE_BASENAME}${extname(legacyBaseImagePath).toLowerCase()}`;
  const finalBaseImagePath = join(destinationCapsule, baseImageName);
  const migratedRound: RoundState = {
    schemaVersion: ROUND_SCHEMA_VERSION,
    id: legacyRound.id,
    phase: legacyRound.phase,
    baseImagePath: finalBaseImagePath,
    channelUrl: legacyRound.channelUrl,
    messageLimit: legacyRound.messageLimit,
    baseMessageUrl: legacyRound.baseMessageUrl,
    collectionStartedAt: legacyRound.collectionStartedAt,
    capturedMessages: legacyRound.capturedMessages
  };

  if (await pathExists(destinationCapsule)) {
    if (
      await matchingDestinationExists(
        paths,
        migratedRound,
        legacyContents,
        legacyBaseImagePath,
        finalBaseImagePath
      )
    ) {
      return migrationResult(migratedRound);
    }
    throw new Error("Existing Round State Capsule does not match the shared round.");
  }

  const stateRoot = dirname(resolve(paths.roundsRoot));
  const stagingRoot = join(stateRoot, ROUND_MIGRATION_STAGING_DIRECTORY);
  const stagedCapsule = roundCapsuleDirectory(stagingRoot, migratedRound.id);
  await rm(stagingRoot, { recursive: true, force: true });

  try {
    await new JsonRoundStateStore(stagingRoot).save(migratedRound);
    const stagedMigrations = join(stagedCapsule, ROUND_MIGRATIONS_DIRECTORY_NAME);
    await mkdir(stagedMigrations, { recursive: true });
    await copyFile(
      legacyBaseImagePath,
      join(stagedCapsule, baseImageName),
      fsConstants.COPYFILE_EXCL
    );
    await copyFile(
      paths.legacyStatePath,
      join(stagedMigrations, LEGACY_V3_STATE_BACKUP_FILE),
      fsConstants.COPYFILE_EXCL
    );
    await copyOptionalV2Backup(paths.legacyMigrationRoot, stagedMigrations);
    await mkdir(paths.roundsRoot, { recursive: true });
    await rename(stagedCapsule, destinationCapsule);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  await rm(stagingRoot, { recursive: true, force: true });
  return migrationResult(migratedRound);
}

async function matchingDestinationExists(
  paths: SharedStateMigrationPaths,
  expected: RoundState,
  legacyContents: string,
  legacyBaseImagePath: string,
  finalBaseImagePath: string
): Promise<boolean> {
  try {
    const existing = await new JsonRoundStateStore(paths.roundsRoot).get(expected.id);
    if (existing === undefined || JSON.stringify(existing) !== JSON.stringify(expected)) {
      return false;
    }
    const capsule = roundCapsuleDirectory(paths.roundsRoot, expected.id);
    const migratedV3Path = join(
      capsule,
      ROUND_MIGRATIONS_DIRECTORY_NAME,
      LEGACY_V3_STATE_BACKUP_FILE
    );
    if (
      (await readRegularFile(migratedV3Path, "utf8")) !== legacyContents ||
      !(await filesMatch(legacyBaseImagePath, finalBaseImagePath))
    ) {
      return false;
    }
    const legacyV2Path = join(paths.legacyMigrationRoot, LEGACY_V2_STATE_BACKUP_FILE);
    if (!(await pathExists(legacyV2Path))) {
      return true;
    }
    return filesMatch(
      legacyV2Path,
      join(capsule, ROUND_MIGRATIONS_DIRECTORY_NAME, LEGACY_V2_STATE_BACKUP_FILE)
    );
  } catch {
    return false;
  }
}

async function filesMatch(leftPath: string, rightPath: string): Promise<boolean> {
  const [left, right] = await Promise.all([readFile(leftPath), readRegularFile(rightPath)]);
  return left.equals(right);
}

async function readRegularFile(path: string): Promise<Buffer>;
async function readRegularFile(path: string, encoding: "utf8"): Promise<string>;
async function readRegularFile(path: string, encoding?: "utf8"): Promise<Buffer | string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Migration destination artifact is not a regular file.");
  }
  return encoding ? readFile(path, encoding) : readFile(path);
}

async function copyOptionalV2Backup(
  legacyMigrationRoot: string,
  stagedMigrations: string
): Promise<void> {
  const source = join(legacyMigrationRoot, LEGACY_V2_STATE_BACKUP_FILE);
  if (!(await pathExists(source))) {
    return;
  }
  const resolvedSource = await requireContainedFile(source, legacyMigrationRoot);
  await copyFile(
    resolvedSource,
    join(stagedMigrations, LEGACY_V2_STATE_BACKUP_FILE),
    fsConstants.COPYFILE_EXCL
  );
}

function parseSupportedLegacyRound(contents: string): LegacyRoundState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw unsupportedSharedState();
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).some((key) => key !== "schemaVersion" && key !== "rounds") ||
    parsed.schemaVersion !== 3 ||
    !Array.isArray(parsed.rounds) ||
    parsed.rounds.length !== 1 ||
    !isRecord(parsed.rounds[0])
  ) {
    throw unsupportedSharedState();
  }
  const round = parsed.rounds[0];
  const allowedKeys = new Set([
    "schemaVersion",
    "id",
    "phase",
    "baseImagePath",
    "channelUrl",
    "messageLimit",
    "baseMessageUrl",
    "collectionStartedAt",
    "capturedMessages"
  ]);
  if (
    Object.keys(round).some((key) => !allowedKeys.has(key)) ||
    round.schemaVersion !== 3 ||
    round.phase !== "synthesizing-feedback" ||
    typeof round.id !== "string" ||
    typeof round.baseImagePath !== "string" ||
    typeof round.channelUrl !== "string" ||
    round.messageLimit !== FEEDBACK_MESSAGE_LIMIT ||
    typeof round.baseMessageUrl !== "string" ||
    typeof round.collectionStartedAt !== "string" ||
    !Array.isArray(round.capturedMessages) ||
    round.capturedMessages.length !== FEEDBACK_MESSAGE_LIMIT
  ) {
    throw unsupportedSharedState();
  }
  try {
    assertSafeRoundId(round.id);
  } catch {
    throw unsupportedSharedState();
  }
  return {
    schemaVersion: 3,
    id: round.id,
    phase: "synthesizing-feedback",
    baseImagePath: round.baseImagePath,
    channelUrl: round.channelUrl,
    messageLimit: round.messageLimit,
    baseMessageUrl: round.baseMessageUrl,
    collectionStartedAt: round.collectionStartedAt,
    capturedMessages: round.capturedMessages.map(parseCapturedMessage)
  };
}

function parseCapturedMessage(value: unknown): CapturedMessage {
  if (!isRecord(value)) {
    throw unsupportedSharedState();
  }
  const keys = ["messageUrl", "authorId", "authorName", "timestamp", "text"] as const;
  if (
    Object.keys(value).some((key) => !keys.includes(key as (typeof keys)[number])) ||
    keys.some((key) => typeof value[key] !== "string")
  ) {
    throw unsupportedSharedState();
  }
  return {
    messageUrl: value.messageUrl as string,
    authorId: value.authorId as string,
    authorName: value.authorName as string,
    timestamp: value.timestamp as string,
    text: value.text as string,
    contextImages: []
  };
}

async function requireContainedLegacyImage(path: string, root: string): Promise<string> {
  const resolvedPath = await requireContainedFile(path, root).catch(() => {
    throw unsupportedSharedState();
  });
  const extension = extname(resolvedPath).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.some((candidate) => candidate === extension)) {
    throw unsupportedSharedState();
  }
  return resolvedPath;
}

async function requireContainedFile(path: string, root: string): Promise<string> {
  const [resolvedPath, resolvedRoot] = await Promise.all([
    realpath(resolve(path)),
    realpath(resolve(root))
  ]);
  const pathFromRoot = relative(resolvedRoot, resolvedPath);
  if (
    pathFromRoot.length === 0 ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot) ||
    !(await stat(resolvedPath)).isFile()
  ) {
    throw new Error("File is outside the configured migration root.");
  }
  return resolvedPath;
}

function migrationResult(round: RoundState): StateMigrationResult {
  return { migrated: true, roundId: round.id, phase: "synthesizing-feedback" };
}

function unsupportedSharedState(): Error {
  return new Error("Shared round state is not the supported live schema-three round.");
}

function unsupportedIsolatedState(): Error {
  return new Error(
    "Isolated round state is not a supported schema-four, schema-five, schema-six, or schema-seven capsule."
  );
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

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
