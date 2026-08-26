import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonRoundArtifactStore } from "../src/round/round-artifact-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("JsonRoundArtifactStore", () => {
  it("rejects an in-root capsule symlink to another round", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const secondCapsule = join(roundsRoot, "R002");
    await mkdir(secondCapsule, { recursive: true });
    const secondImage = join(secondCapsule, "base-image.png");
    await writeFile(secondImage, "round two", "utf8");
    await symlink(secondCapsule, join(roundsRoot, "R001"));

    await expect(
      new JsonRoundArtifactStore(roundsRoot).acceptBaseImage(
        "R001",
        join(roundsRoot, "R001", "base-image.png")
      )
    ).rejects.toThrow("Base image must be staged under the durable state directory.");
  });

  it("rejects a capsule symlink outside the rounds root", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const outsideCapsule = join(directory, "outside");
    await mkdir(roundsRoot, { recursive: true });
    await mkdir(outsideCapsule, { recursive: true });
    await writeFile(join(outsideCapsule, "result-image.png"), "outside", "utf8");
    await symlink(outsideCapsule, join(roundsRoot, "R001"));

    await expect(
      new JsonRoundArtifactStore(roundsRoot).acceptResultImage(
        "R001",
        join(roundsRoot, "R001", "result-image.png")
      )
    ).rejects.toThrow("Result image must be staged under the durable state directory.");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "feedback-round-artifacts-"));
  temporaryDirectories.push(directory);
  return directory;
}
