import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { DISCORD_CHANNEL_ALLOWLIST_SCHEMA_VERSION } from "../constants.js";

export interface DiscordChannelAllowlistStore {
  getAll(): Promise<string[]>;
  replace(channelUrls: readonly string[]): Promise<void>;
}

export class JsonDiscordChannelAllowlistStore implements DiscordChannelAllowlistStore {
  public constructor(private readonly statePath: string) {}

  public async getAll(): Promise<string[]> {
    let contents: string;
    try {
      await requireRegularFile(this.statePath);
      contents = await readFile(this.statePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw malformedAllowlist();
    }
    return parseAllowlist(contents);
  }

  public async replace(channelUrls: readonly string[]): Promise<void> {
    const normalized = normalizeAllowlist(channelUrls);
    const parent = dirname(this.statePath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentMetadata = await lstat(parent);
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      throw malformedAllowlist();
    }
    await chmod(parent, 0o700);
    try {
      await requireRegularFile(this.statePath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw malformedAllowlist();
      }
    }

    const temporaryPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    const contents = `${JSON.stringify(
      {
        schemaVersion: DISCORD_CHANNEL_ALLOWLIST_SCHEMA_VERSION,
        channelUrls: normalized
      },
      null,
      2
    )}\n`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporaryPath, this.statePath);
      await chmod(this.statePath, 0o600);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export function normalizeDiscordChannelUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidChannelUrl();
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const snowflake = /^\d{15,20}$/;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "discord.com" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    parts.length !== 3 ||
    parts[0] !== "channels" ||
    (parts[1] !== "@me" && !snowflake.test(parts[1] ?? "")) ||
    !snowflake.test(parts[2] ?? "")
  ) {
    throw invalidChannelUrl();
  }
  return `https://discord.com/channels/${parts[1]}/${parts[2]}`;
}

function parseAllowlist(contents: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw malformedAllowlist();
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "schemaVersion" && key !== "channelUrls") ||
    value.schemaVersion !== DISCORD_CHANNEL_ALLOWLIST_SCHEMA_VERSION ||
    !Array.isArray(value.channelUrls)
  ) {
    throw malformedAllowlist();
  }
  try {
    return normalizeAllowlist(value.channelUrls);
  } catch {
    throw malformedAllowlist();
  }
}

function normalizeAllowlist(values: readonly unknown[]): string[] {
  if (values.length !== 1 || values.some((value) => typeof value !== "string")) {
    throw malformedAllowlist();
  }
  const normalized = values.map((value) => normalizeDiscordChannelUrl(value as string));
  if (new Set(normalized).size !== normalized.length) {
    throw malformedAllowlist();
  }
  return [...normalized].sort();
}

async function requireRegularFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw malformedAllowlist();
  }
}

function invalidChannelUrl(): Error {
  return new Error("A canonical Discord channel URL is required.");
}

function malformedAllowlist(): Error {
  return new Error("Unsupported or malformed Discord channel allowlist.");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
