import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonDiscordChannelAllowlistStore } from "../src/config/discord-channel-allowlist.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("JsonDiscordChannelAllowlistStore", () => {
  it("atomically replaces and reloads one configured Discord channel", async () => {
    const directory = await temporaryDirectory();
    const statePath = join(directory, "discord-channel-allowlist.json");
    const store = new JsonDiscordChannelAllowlistStore(statePath);

    await store.replace(["https://discord.com/channels/123456789012345/234567890123456"]);

    await expect(new JsonDiscordChannelAllowlistStore(statePath).getAll()).resolves.toEqual([
      "https://discord.com/channels/123456789012345/234567890123456"
    ]);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });

  it("fails closed when the configured file is a symlink", async () => {
    const directory = await temporaryDirectory();
    const outsidePath = join(directory, "outside.json");
    const statePath = join(directory, "discord-channel-allowlist.json");
    await writeFile(
      outsidePath,
      '{"schemaVersion":1,"channelUrls":["https://discord.com/channels/123456789012345/234567890123456"]}\n',
      "utf8"
    );
    await symlink(outsidePath, statePath);

    await expect(new JsonDiscordChannelAllowlistStore(statePath).getAll()).rejects.toThrow(
      "Unsupported or malformed Discord channel allowlist."
    );
  });

  it("rejects multiple configured channels for the single-channel POC", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonDiscordChannelAllowlistStore(
      join(directory, "discord-channel-allowlist.json")
    );

    await expect(
      store.replace([
        "https://discord.com/channels/123456789012345/234567890123456",
        "https://discord.com/channels/123456789012345/345678901234567"
      ])
    ).rejects.toThrow("Unsupported or malformed Discord channel allowlist.");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "discord-allowlist-"));
  temporaryDirectories.push(directory);
  return directory;
}
