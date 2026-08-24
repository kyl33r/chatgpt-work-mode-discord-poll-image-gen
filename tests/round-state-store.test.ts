import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRound } from "../src/round/round-state.js";
import { JsonRoundStateStore } from "../src/round/round-state-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("JsonRoundStateStore", () => {
  it("persists and reloads rounds while ignoring an abandoned temporary write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-round-store-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "rounds.json");
    const store = new JsonRoundStateStore(statePath);
    const round = createRound({
      id: "R001",
      baseImagePath: "/tmp/base.png",
      channelUrl: "https://discord.test/channels/one",
      messageLimit: 5
    });

    await store.save(round);
    await writeFile(`${statePath}.tmp`, "truncated", "utf8");

    expect(await store.get("R001")).toEqual(round);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
      schemaVersion: 2,
      rounds: [round]
    });
  });

  it("rejects obsolete native-poll state instead of reinterpreting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-round-store-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "rounds.json");
    await writeFile(statePath, '{"schemaVersion":1,"rounds":[]}', "utf8");

    await expect(new JsonRoundStateStore(statePath).list()).rejects.toThrow(
      "Unsupported or malformed round-state file."
    );
  });
});
