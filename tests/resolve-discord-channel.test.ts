import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonDiscordChannelAllowlistStore } from "../src/config/discord-channel-allowlist.js";
import { resolveDiscordChannel } from "../src/config/resolve-discord-channel.js";
import { createRound } from "../src/round/round-state.js";
import { JsonRoundStateStore } from "../src/round/round-state-store.js";

const temporaryDirectories: string[] = [];
const CHANNEL = "https://discord.com/channels/123456789012345/234567890123456";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("resolveDiscordChannel", () => {
  it("does not bootstrap a missing allowlist from an active round", async () => {
    const fixture = await createFixture();
    await fixture.rounds.save(
      createRound({
        id: "RLEGACY",
        baseImagePath: "/tmp/base.png",
        channelUrl: CHANNEL,
        messageLimit: 5
      })
    );

    await expect(resolveDiscordChannel(fixture.allowlist)).rejects.toThrow(
      "Configure one Discord channel before running a round command."
    );
    await expect(fixture.allowlist.getAll()).resolves.toEqual([]);
  });

  it("requires explicit configuration when no channel or active round exists", async () => {
    const fixture = await createFixture();

    await expect(resolveDiscordChannel(fixture.allowlist)).rejects.toThrow(
      "Configure one Discord channel before running a round command."
    );
  });
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "resolve-discord-channel-"));
  temporaryDirectories.push(directory);
  return {
    rounds: new JsonRoundStateStore(join(directory, "rounds")),
    allowlist: new JsonDiscordChannelAllowlistStore(
      join(directory, "discord-channel-allowlist.json")
    )
  };
}
