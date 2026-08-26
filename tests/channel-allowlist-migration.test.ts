import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrateLegacyDiscordChannelAllowlist } from "../src/config/migrate-discord-channel-allowlist.js";
import { JsonDiscordChannelAllowlistStore } from "../src/config/discord-channel-allowlist.js";
import { createRound } from "../src/round/round-state.js";
import { JsonRoundStateStore } from "../src/round/round-state-store.js";
import { InMemoryWorkflowLock } from "../src/workflow-lock.js";

const temporaryDirectories: string[] = [];
const CHANNEL = "https://discord.com/channels/123456789012345/234567890123456";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("migrateLegacyDiscordChannelAllowlist", () => {
  it("explicitly migrates one active round channel and records non-sensitive provenance", async () => {
    const fixture = await createFixture();
    await fixture.rounds.save(
      createRound({
        id: "RLEGACY",
        baseImagePath: "/tmp/base.png",
        channelUrl: CHANNEL,
        messageLimit: 5
      })
    );

    await expect(
      migrateLegacyDiscordChannelAllowlist(
        fixture.rounds,
        fixture.allowlist,
        fixture.markerPath,
        new InMemoryWorkflowLock()
      )
    ).resolves.toEqual({ migrated: true, alreadyMigrated: false });
    await expect(fixture.allowlist.getAll()).resolves.toEqual([CHANNEL]);
    expect(await readFile(fixture.markerPath, "utf8")).not.toContain("discord.com");
    expect((await stat(fixture.markerPath)).mode & 0o777).toBe(0o600);
  });

  it("never bootstraps again after the consumed migration loses its allowlist", async () => {
    const fixture = await createFixture();
    await fixture.rounds.save(
      createRound({
        id: "RLEGACY",
        baseImagePath: "/tmp/base.png",
        channelUrl: CHANNEL,
        messageLimit: 5
      })
    );
    const lock = new InMemoryWorkflowLock();
    await migrateLegacyDiscordChannelAllowlist(
      fixture.rounds,
      fixture.allowlist,
      fixture.markerPath,
      lock
    );
    await rm(fixture.allowlistPath);

    await expect(
      migrateLegacyDiscordChannelAllowlist(
        fixture.rounds,
        fixture.allowlist,
        fixture.markerPath,
        lock
      )
    ).rejects.toThrow("Migrated Discord channel allowlist is missing; configure it explicitly.");
  });
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "discord-allowlist-migration-"));
  temporaryDirectories.push(directory);
  const allowlistPath = join(directory, "discord-channel-allowlist.json");
  return {
    rounds: new JsonRoundStateStore(join(directory, "rounds")),
    allowlist: new JsonDiscordChannelAllowlistStore(allowlistPath),
    allowlistPath,
    markerPath: join(directory, "migrations", "discord-channel-allowlist-v1.json")
  };
}
