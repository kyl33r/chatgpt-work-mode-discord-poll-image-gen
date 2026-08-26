import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrateLegacyState } from "../src/round/state-migration.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("migrateLegacyState", () => {
  it("moves the one supported frozen v2 round into durable v3 state", async () => {
    const paths = await createMigrationFixture();

    expect(await migrateLegacyState(paths)).toEqual({
      migrated: true,
      roundId: "R001",
      phase: "synthesizing-feedback"
    });

    const migrated = JSON.parse(await readFile(paths.newStatePath, "utf8"));
    expect(migrated).toMatchObject({
      schemaVersion: 3,
      rounds: [
        {
          schemaVersion: 3,
          id: "R001",
          phase: "synthesizing-feedback",
          messageLimit: 5
        }
      ]
    });
    expect(migrated.rounds[0].capturedMessages).toHaveLength(5);
    expect(migrated.rounds[0].capturedMessages.map((message: { text: string }) => message.text)).toEqual([
      "change 1",
      "change 2",
      "change 3",
      "change 4",
      "change 5"
    ]);
    expect(migrated.rounds[0].baseImagePath).toBe(
      join(paths.newBaseImageRoot, "R001.png")
    );
    expect(await readFile(migrated.rounds[0].baseImagePath, "utf8")).toBe("base image");
    expect(await readFile(join(paths.migrationRoot, "rounds-v2.json"), "utf8")).toContain(
      '"schemaVersion": 2'
    );
    expect(await readFile(paths.legacyStatePath, "utf8")).toContain('"schemaVersion": 2');
  });

  it("rejects every other legacy shape without creating durable state", async () => {
    const paths = await createMigrationFixture({ phase: "collecting-messages" });

    await expect(migrateLegacyState(paths)).rejects.toThrow(
      "Legacy state is not the supported frozen live round."
    );
    await expect(access(paths.newStatePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.newBaseImageRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.migrationRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a legacy round that already contains synthesis data", async () => {
    const paths = await createMigrationFixture({ synthesizedPrompt: "unexpected" });

    await expect(migrateLegacyState(paths)).rejects.toThrow(
      "Legacy state is not the supported frozen live round."
    );
    await expect(access(paths.newStatePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite existing durable state", async () => {
    const paths = await createMigrationFixture();
    await mkdir(join(paths.newStatePath, ".."), { recursive: true });
    await writeFile(paths.newStatePath, "existing", "utf8");

    await expect(migrateLegacyState(paths)).rejects.toThrow(
      "Durable round state already exists; migration was not run."
    );
    expect(await readFile(paths.newStatePath, "utf8")).toBe("existing");
  });

  it("preserves unrelated durable directories when rounds.json does not exist", async () => {
    const paths = await createMigrationFixture();
    const unrelatedDirectory = join(paths.newStatePath, "..", "results");
    await mkdir(unrelatedDirectory, { recursive: true });

    await expect(migrateLegacyState(paths)).resolves.toMatchObject({ migrated: true });
    await expect(access(unrelatedDirectory)).resolves.toBeUndefined();
    await expect(access(paths.newStatePath)).resolves.toBeUndefined();
  });

  it("recovers an interrupted marked migration before retrying", async () => {
    const paths = await createMigrationFixture();
    const partialBaseImagePath = join(paths.newBaseImageRoot, "R001.png");
    const partialBackupPath = join(paths.migrationRoot, "rounds-v2.json");
    const transactionPath = join(paths.migrationRoot, "v2-to-v3-transaction");
    await mkdir(paths.newBaseImageRoot, { recursive: true });
    await mkdir(paths.migrationRoot, { recursive: true });
    await writeFile(partialBaseImagePath, "partial", "utf8");
    await writeFile(partialBackupPath, "partial", "utf8");
    await writeFile(transactionPath, "in-progress\n", "utf8");

    await expect(migrateLegacyState(paths)).resolves.toMatchObject({ migrated: true });
    expect(await readFile(partialBaseImagePath, "utf8")).toBe("base image");
    expect(await readFile(partialBackupPath, "utf8")).toContain('"schemaVersion": 2');
    await expect(access(transactionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recognizes a marked migration whose state commit completed", async () => {
    const paths = await createMigrationFixture();
    await migrateLegacyState(paths);
    const transactionPath = join(paths.migrationRoot, "v2-to-v3-transaction");
    await writeFile(transactionPath, "in-progress\n", "utf8");

    await expect(migrateLegacyState(paths)).resolves.toEqual({
      migrated: true,
      roundId: "R001",
      phase: "synthesizing-feedback"
    });
    await expect(access(transactionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes staged output when commit preparation fails", async () => {
    const paths = await createMigrationFixture();
    const stateRoot = join(paths.newStatePath, "..");
    paths.newStatePath = paths.newBaseImageRoot;

    await expect(migrateLegacyState(paths)).rejects.toThrow();
    await expect(access(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createMigrationFixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "feedback-round-migration-"));
  temporaryDirectories.push(root);
  const legacyBaseImageRoot = join(root, ".runtime", "base-images");
  const legacyStatePath = join(root, ".runtime", "rounds.json");
  const newBaseImageRoot = join(root, ".state", "base-images");
  const newStatePath = join(root, ".state", "rounds.json");
  const migrationRoot = join(root, ".state", "migrations");
  await mkdir(legacyBaseImageRoot, { recursive: true });
  const legacyBaseImagePath = join(legacyBaseImageRoot, "base.png");
  await writeFile(legacyBaseImagePath, "base image", "utf8");
  const round = {
    schemaVersion: 2,
    id: "R001",
    phase: "closing-collection",
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
    `${JSON.stringify({ schemaVersion: 2, rounds: [round] }, null, 2)}\n`,
    "utf8"
  );
  return {
    legacyStatePath,
    newStatePath,
    legacyBaseImageRoot,
    newBaseImageRoot,
    migrationRoot
  };
}
