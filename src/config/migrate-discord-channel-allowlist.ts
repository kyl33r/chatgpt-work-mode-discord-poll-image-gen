import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { DISCORD_CHANNEL_ALLOWLIST_MIGRATION_SCHEMA_VERSION } from "../constants.js";
import type { RoundStateStore } from "../round/round-state-store.js";
import type { WorkflowLock } from "../workflow-lock.js";
import type { DiscordChannelAllowlistStore } from "./discord-channel-allowlist.js";

export interface ChannelAllowlistMigrationResult {
  migrated: true;
  alreadyMigrated: boolean;
}

export async function migrateLegacyDiscordChannelAllowlist(
  rounds: RoundStateStore,
  allowlist: DiscordChannelAllowlistStore,
  markerPath: string,
  lock: WorkflowLock
): Promise<ChannelAllowlistMigrationResult> {
  return lock.runExclusive(async () => {
    if (await migrationWasConsumed(markerPath)) {
      if ((await allowlist.getAll()).length !== 1) {
        throw new Error(
          "Migrated Discord channel allowlist is missing; configure it explicitly."
        );
      }
      return { migrated: true, alreadyMigrated: true };
    }

    const activeRounds = (await rounds.list()).filter((round) => !isTerminal(round.phase));
    if (activeRounds.length !== 1 || !activeRounds[0]) {
      throw new Error("Exactly one legacy active round is required for channel migration.");
    }
    const configured = await allowlist.getAll();
    if (configured.length === 0) {
      await allowlist.replace([activeRounds[0].channelUrl]);
    } else if (configured.length !== 1 || configured[0] !== activeRounds[0].channelUrl) {
      throw new Error("Existing Discord channel allowlist does not match the legacy round.");
    }
    await writeMigrationMarker(markerPath);
    return { migrated: true, alreadyMigrated: false };
  });
}

async function migrationWasConsumed(path: string): Promise<boolean> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw malformedMarker();
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw malformedMarker();
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "schemaVersion" && key !== "migrated") ||
    value.schemaVersion !== DISCORD_CHANNEL_ALLOWLIST_MIGRATION_SCHEMA_VERSION ||
    value.migrated !== true
  ) {
    throw malformedMarker();
  }
  return true;
}

async function writeMigrationMarker(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify(
        {
          schemaVersion: DISCORD_CHANNEL_ALLOWLIST_MIGRATION_SCHEMA_VERSION,
          migrated: true
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isTerminal(phase: string): boolean {
  return phase === "completed" || phase === "stopped" || phase === "needs-attention";
}

function malformedMarker(): Error {
  return new Error("Unsupported or malformed Discord channel migration marker.");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
