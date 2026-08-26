import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureDiscordChannel } from "../src/configure-channel.js";
import { JsonDiscordChannelAllowlistStore } from "../src/config/discord-channel-allowlist.js";
import { createRound } from "../src/round/round-state.js";
import { JsonRoundStateStore } from "../src/round/round-state-store.js";
import { InMemoryWorkflowLock } from "../src/workflow-lock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("configureDiscordChannel", () => {
  it("replaces the allowlist without returning the private channel URL", async () => {
    const fixture = await createFixture();
    const result = await configureDiscordChannel(
      { channelUrl: "https://discord.com/channels/123456789012345/234567890123456" },
      fixture.rounds,
      fixture.allowlist,
      fixture.lock
    );

    expect(result).toEqual({ configured: true, channelCount: 1 });
    expect(JSON.stringify(result)).not.toContain("discord.com");
    await expect(fixture.allowlist.getAll()).resolves.toEqual([
      "https://discord.com/channels/123456789012345/234567890123456"
    ]);
  });

  it("rejects non-channel URLs without changing the existing allowlist", async () => {
    const fixture = await createFixture();
    await fixture.allowlist.replace([
      "https://discord.com/channels/123456789012345/234567890123456"
    ]);

    await expect(
      configureDiscordChannel(
        { channelUrl: "https://example.test/not-discord" },
        fixture.rounds,
        fixture.allowlist,
        fixture.lock
      )
    ).rejects.toThrow("A canonical Discord channel URL is required.");
    await expect(fixture.allowlist.getAll()).resolves.toEqual([
      "https://discord.com/channels/123456789012345/234567890123456"
    ]);
  });

  it("refuses to switch channels while a nonterminal round exists", async () => {
    const fixture = await createFixture();
    await fixture.rounds.save(
      createRound({
        id: "RACTIVE",
        baseImagePath: "/tmp/base.png",
        channelUrl: "https://discord.com/channels/123456789012345/234567890123456",
        messageLimit: 5
      })
    );

    await expect(
      configureDiscordChannel(
        { channelUrl: "https://discord.com/channels/123456789012345/345678901234567" },
        fixture.rounds,
        fixture.allowlist,
        fixture.lock
      )
    ).rejects.toThrow("Discord channel configuration is locked while a round is active.");
    await expect(fixture.allowlist.getAll()).resolves.toEqual([]);
  });

  it("holds the shared mutation lock across the active-round check and allowlist write", async () => {
    const fixture = await createFixture();
    let signalWriteStarted!: () => void;
    let releaseWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const configuration = configureDiscordChannel(
      { channelUrl: "https://discord.com/channels/123456789012345/234567890123456" },
      fixture.rounds,
      {
        getAll: async () => [],
        replace: async () => {
          signalWriteStarted();
          await writeBlocked;
        }
      },
      fixture.lock
    );
    await writeStarted;

    await expect(
      fixture.lock.runExclusive(async () =>
        fixture.rounds.save(
          createRound({
            id: "RINTERLEAVE",
            baseImagePath: "/tmp/base.png",
            channelUrl: "https://discord.com/channels/123456789012345/234567890123456",
            messageLimit: 5
          })
        )
      )
    ).rejects.toThrow("Another workflow mutation is already in progress.");
    releaseWrite();
    await configuration;
  });
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "configure-discord-channel-"));
  temporaryDirectories.push(directory);
  return {
    rounds: new JsonRoundStateStore(join(directory, "rounds")),
    allowlist: new JsonDiscordChannelAllowlistStore(
      join(directory, "discord-channel-allowlist.json")
    ),
    lock: new InMemoryWorkflowLock()
  };
}
