import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRound, type RoundState } from "../src/round/round-state.js";
import { JsonRoundStateStore } from "../src/round/round-state-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("JsonRoundStateStore", () => {
  it("persists each round in an isolated capsule without rewriting another round", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const store = new JsonRoundStateStore(roundsRoot);
    const first = round("R001");
    const second = round("R002");

    await store.save(first);
    const firstPath = join(roundsRoot, "R001", "round.json");
    const firstBytes = await readFile(firstPath, "utf8");
    await store.save(second);
    await store.save({ ...second, phase: "stopped" });

    expect(await readFile(firstPath, "utf8")).toBe(firstBytes);
    expect(JSON.parse(firstBytes)).toEqual(first);
    expect(JSON.parse(await readFile(join(roundsRoot, "R002", "round.json"), "utf8"))).toEqual({
      ...second,
      phase: "stopped"
    });
  });

  it("reloads every persisted capsule in deterministic identifier order", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const store = new JsonRoundStateStore(roundsRoot);
    await store.save(round("R002"));
    await store.save(round("R001"));
    await writeFile(join(roundsRoot, "R001", "round.json.abandoned.tmp"), "truncated", "utf8");

    expect((await new JsonRoundStateStore(roundsRoot).list()).map(({ id }) => id)).toEqual([
      "R001",
      "R002"
    ]);
  });

  it("fails closed on malformed, mismatched, and unsafe capsule identities", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const capsule = join(roundsRoot, "R001");
    await mkdir(capsule, { recursive: true });
    await writeFile(
      join(capsule, "round.json"),
      JSON.stringify({ ...round("R002"), schemaVersion: 4 }),
      "utf8"
    );

    await expect(new JsonRoundStateStore(roundsRoot).list()).rejects.toThrow(
      "Unsupported or malformed Round State Capsule."
    );
    await expect(new JsonRoundStateStore(roundsRoot).get("../R001")).rejects.toThrow(
      "Round ID is not safe for local storage."
    );
  });

  it("rejects a capsule symlink instead of overwriting another round", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const store = new JsonRoundStateStore(roundsRoot);
    const second = round("R002");
    await store.save(second);
    const secondPath = join(roundsRoot, "R002", "round.json");
    const secondBytes = await readFile(secondPath, "utf8");
    await symlink(join(roundsRoot, "R002"), join(roundsRoot, "R001"));

    await expect(store.save(round("R001"))).rejects.toThrow(
      "Unsupported or malformed Round State Capsule."
    );
    await expect(readFile(secondPath, "utf8")).resolves.toBe(secondBytes);
  });
});

function round(id: string): RoundState {
  return createRound({
    id,
    baseImagePath: `/tmp/${id}.png`,
    channelUrl: "https://discord.test/channels/one",
    messageLimit: 5
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "feedback-round-store-"));
  temporaryDirectories.push(directory);
  return directory;
}
