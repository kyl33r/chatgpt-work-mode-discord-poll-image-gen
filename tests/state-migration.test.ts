import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  migrateIsolatedRoundCapsulesV4ToV5,
  migrateRoundState,
  migrateSharedRoundState
} from "../src/round/state-migration.js";
import { createRound } from "../src/round/round-state.js";
import { JsonRoundStateStore } from "../src/round/round-state-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("migrateSharedRoundState", () => {
  it("moves the supported shared v3 round into one current isolated capsule", async () => {
    const paths = await createMigrationFixture();

    expect(await migrateSharedRoundState(paths)).toEqual({
      migrated: true,
      roundId: "R001",
      phase: "synthesizing-feedback"
    });

    const capsule = join(paths.roundsRoot, "R001");
    const migrated = JSON.parse(await readFile(join(capsule, "round.json"), "utf8"));
    expect(migrated).toMatchObject({
      schemaVersion: 5,
      id: "R001",
      phase: "synthesizing-feedback",
      messageLimit: 5
    });
    expect(migrated.capturedMessages).toHaveLength(5);
    expect(migrated.baseImagePath).toBe(join(capsule, "base-image.png"));
    expect(await readFile(migrated.baseImagePath, "utf8")).toBe("base image");
    expect(await readFile(join(capsule, "migrations", "rounds-v3.json"), "utf8")).toContain(
      '"schemaVersion": 3'
    );
    expect(await readFile(join(capsule, "migrations", "rounds-v2.json"), "utf8")).toBe(
      "legacy v2 backup"
    );
    expect(await readFile(paths.legacyStatePath, "utf8")).toContain('"schemaVersion": 3');
  });

  it("preserves an existing isolated terminal round", async () => {
    const paths = await createMigrationFixture();
    const store = new JsonRoundStateStore(paths.roundsRoot);
    await store.save({ ...createRound({
      id: "R000",
      baseImagePath: join(paths.roundsRoot, "R000", "base-image.png"),
      channelUrl: "https://discord.test/channels/allowlisted",
      messageLimit: 5
    }), phase: "stopped" });
    const before = await readFile(join(paths.roundsRoot, "R000", "round.json"), "utf8");

    await migrateSharedRoundState(paths);

    expect(await readFile(join(paths.roundsRoot, "R000", "round.json"), "utf8")).toBe(before);
    expect((await store.list()).map(({ id }) => id)).toEqual(["R000", "R001"]);
  });

  it("recognizes an already completed matching capsule", async () => {
    const paths = await createMigrationFixture();
    await migrateSharedRoundState(paths);

    await expect(migrateSharedRoundState(paths)).resolves.toEqual({
      migrated: true,
      roundId: "R001",
      phase: "synthesizing-feedback"
    });
  });

  it("rejects an incomplete destination even when round.json matches", async () => {
    const paths = await createMigrationFixture();
    await migrateSharedRoundState(paths);
    await rm(join(paths.roundsRoot, "R001", "base-image.png"));

    await expect(migrateSharedRoundState(paths)).rejects.toThrow(
      "Existing Round State Capsule does not match the shared round."
    );
  });

  it("rejects a destination whose Base Image is only a symlink to the legacy image", async () => {
    const paths = await createMigrationFixture();
    await migrateSharedRoundState(paths);
    const destination = join(paths.roundsRoot, "R001", "base-image.png");
    await rm(destination);
    await symlink(paths.legacyBaseImagePath, destination);

    await expect(migrateSharedRoundState(paths)).rejects.toThrow(
      "Existing Round State Capsule does not match the shared round."
    );
  });

  it("rejects a destination whose migration backup is only a symlink", async () => {
    const paths = await createMigrationFixture();
    await migrateSharedRoundState(paths);
    const destination = join(paths.roundsRoot, "R001", "migrations", "rounds-v3.json");
    await rm(destination);
    await symlink(paths.legacyStatePath, destination);

    await expect(migrateSharedRoundState(paths)).rejects.toThrow(
      "Existing Round State Capsule does not match the shared round."
    );
  });

  it("rejects an unsupported shared shape without a visible destination capsule", async () => {
    const paths = await createMigrationFixture({ phase: "collecting-messages" });

    await expect(migrateSharedRoundState(paths)).rejects.toThrow(
      "Shared round state is not the supported live schema-three round."
    );
    await expect(access(join(paths.roundsRoot, "R001"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a Base Image symlink escape without a visible destination capsule", async () => {
    const paths = await createMigrationFixture();
    const outsideImage = join(paths.root, "outside.png");
    await writeFile(outsideImage, "outside", "utf8");
    await rm(paths.legacyBaseImagePath);
    await symlink(outsideImage, paths.legacyBaseImagePath);

    await expect(migrateSharedRoundState(paths)).rejects.toThrow(
      "Shared round state is not the supported live schema-three round."
    );
    await expect(access(join(paths.roundsRoot, "R001"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on an existing mismatched destination capsule", async () => {
    const paths = await createMigrationFixture();
    const capsule = join(paths.roundsRoot, "R001");
    await mkdir(capsule, { recursive: true });
    await writeFile(join(capsule, "round.json"), "{}", "utf8");

    await expect(migrateSharedRoundState(paths)).rejects.toThrow(
      "Existing Round State Capsule does not match the shared round."
    );
  });
});

describe("migrateIsolatedRoundCapsulesV4ToV5", () => {
  it("upgrades an isolated v4 capsule without inventing parent lineage", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-round-v5-migration-"));
    temporaryDirectories.push(root);
    const roundsRoot = join(root, "rounds");
    const capsule = join(roundsRoot, "R001");
    await mkdir(capsule, { recursive: true });
    const legacy = {
      schemaVersion: 4,
      id: "R001",
      phase: "stopped",
      baseImagePath: join(capsule, "base-image.png"),
      channelUrl: "https://discord.test/channels/one",
      messageLimit: 5,
      capturedMessages: []
    };
    await writeFile(join(capsule, "round.json"), `${JSON.stringify(legacy, null, 2)}\n`);

    await expect(migrateIsolatedRoundCapsulesV4ToV5(roundsRoot)).resolves.toEqual({
      migratedRoundCount: 1
    });
    const migrated = JSON.parse(await readFile(join(capsule, "round.json"), "utf8"));
    expect(migrated).toEqual({ ...legacy, schemaVersion: 5 });
    expect(migrated).not.toHaveProperty("parentRoundId");
    await expect(readFile(join(capsule, "migrations", "round-v4.json"), "utf8"))
      .resolves.toBe(`${JSON.stringify(legacy, null, 2)}\n`);
  });

  it("is orchestrated even when no legacy shared state exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-round-v5-orchestrator-"));
    temporaryDirectories.push(root);
    const stateRoot = join(root, ".state");
    const roundsRoot = join(stateRoot, "rounds");
    const capsule = join(roundsRoot, "R001");
    await mkdir(capsule, { recursive: true });
    await writeFile(
      join(capsule, "round.json"),
      `${JSON.stringify({
        schemaVersion: 4,
        id: "R001",
        phase: "stopped",
        baseImagePath: join(capsule, "base-image.png"),
        channelUrl: "https://discord.test/channels/one",
        messageLimit: 5,
        capturedMessages: []
      })}\n`
    );

    await expect(
      migrateRoundState({
        legacyStatePath: join(stateRoot, "rounds.json"),
        legacyBaseImageRoot: join(stateRoot, "base-images"),
        legacyMigrationRoot: join(stateRoot, "migrations"),
        roundsRoot
      })
    ).resolves.toEqual({ isolated: { migratedRoundCount: 1 } });
    expect(JSON.parse(await readFile(join(capsule, "round.json"), "utf8")).schemaVersion).toBe(5);
  });

  it("rejects malformed current-version state instead of skipping validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-round-v5-malformed-"));
    temporaryDirectories.push(root);
    const capsule = join(root, "rounds", "R001");
    await mkdir(capsule, { recursive: true });
    await writeFile(
      join(capsule, "round.json"),
      JSON.stringify({ schemaVersion: 5, id: "R001", unexpected: true })
    );

    await expect(migrateIsolatedRoundCapsulesV4ToV5(join(root, "rounds"))).rejects.toThrow(
      "Isolated round state is not a supported schema-four or schema-five capsule."
    );
  });

  it("rejects a migrations-directory symlink without writing outside the capsule", async () => {
    const root = await mkdtemp(join(tmpdir(), "feedback-round-v5-migrations-link-"));
    temporaryDirectories.push(root);
    const roundsRoot = join(root, "rounds");
    const capsule = join(roundsRoot, "R001");
    const outside = join(root, "outside");
    await mkdir(capsule, { recursive: true });
    await mkdir(outside);
    await writeFile(
      join(capsule, "round.json"),
      `${JSON.stringify({
        schemaVersion: 4,
        id: "R001",
        phase: "stopped",
        baseImagePath: join(capsule, "base-image.png"),
        channelUrl: "https://discord.test/channels/one",
        messageLimit: 5,
        capturedMessages: []
      })}\n`
    );
    await symlink(outside, join(capsule, "migrations"));

    await expect(migrateIsolatedRoundCapsulesV4ToV5(roundsRoot)).rejects.toThrow(
      "Isolated round state is not a supported schema-four or schema-five capsule."
    );
    await expect(access(join(outside, "round-v4.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createMigrationFixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "feedback-round-migration-"));
  temporaryDirectories.push(root);
  const stateRoot = join(root, ".state");
  const legacyBaseImageRoot = join(stateRoot, "base-images");
  const legacyMigrationRoot = join(stateRoot, "migrations");
  const legacyStatePath = join(stateRoot, "rounds.json");
  const roundsRoot = join(stateRoot, "rounds");
  await mkdir(legacyBaseImageRoot, { recursive: true });
  await mkdir(legacyMigrationRoot, { recursive: true });
  const legacyBaseImagePath = join(legacyBaseImageRoot, "R001.png");
  await writeFile(legacyBaseImagePath, "base image", "utf8");
  await writeFile(join(legacyMigrationRoot, "rounds-v2.json"), "legacy v2 backup", "utf8");
  const round = {
    schemaVersion: 3,
    id: "R001",
    phase: "synthesizing-feedback",
    baseImagePath: legacyBaseImagePath,
    channelUrl: "https://discord.test/channels/allowlisted",
    messageLimit: 5,
    baseMessageUrl: "base-message",
    collectionStartedAt: "2026-08-24T10:00:00.000Z",
    capturedMessages: Array.from({ length: 5 }, (_, index) => ({
      messageUrl: `message-${index + 1}`,
      authorId: "author",
      authorName: "Author",
      timestamp: `2026-08-24T10:0${index + 1}:00.000Z`,
      text: `change ${index + 1}`
    })),
    ...overrides
  };
  await writeFile(
    legacyStatePath,
    `${JSON.stringify({ schemaVersion: 3, rounds: [round] }, null, 2)}\n`,
    "utf8"
  );
  return {
    root,
    legacyStatePath,
    legacyBaseImageRoot,
    legacyBaseImagePath,
    legacyMigrationRoot,
    roundsRoot
  };
}
