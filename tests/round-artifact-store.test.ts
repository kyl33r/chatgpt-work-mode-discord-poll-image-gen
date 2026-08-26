import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonRoundArtifactStore } from "../src/round/round-artifact-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("JsonRoundArtifactStore", () => {
  it("copies one source Result Image into a distinct target Base Image", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const sourceCapsule = join(roundsRoot, "R001");
    const targetCapsule = join(roundsRoot, "R002");
    await mkdir(sourceCapsule, { recursive: true });
    const source = join(sourceCapsule, "result-image.png");
    await writeFile(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

    const copied = await new JsonRoundArtifactStore(roundsRoot).copyResultAsBase(
      "R001",
      "R002",
      source
    );

    expect(copied).toBe(join(targetCapsule, "base-image.png"));
    expect(await readFile(copied)).toEqual(await readFile(source));
    expect((await stat(copied)).mode & 0o777).toBe(0o600);
    expect(copied).not.toBe(source);
  });

  it("rejects missing and unsupported continuation sources", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const sourceCapsule = join(roundsRoot, "R001");
    await mkdir(sourceCapsule, { recursive: true });
    const unsupported = join(sourceCapsule, "result-image.gif");
    await writeFile(unsupported, "gif", "utf8");
    const artifacts = new JsonRoundArtifactStore(roundsRoot);

    await expect(
      artifacts.copyResultAsBase("R001", "R002", join(sourceCapsule, "missing.png"))
    ).rejects.toThrow("Recorded result image is missing or unsupported.");
    await expect(
      artifacts.copyResultAsBase("R001", "R002", unsupported)
    ).rejects.toThrow("Recorded result image is missing or unsupported.");
  });

  it("never reuses a source capsule or overwrites an existing target capsule", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const sourceCapsule = join(roundsRoot, "R001");
    await mkdir(sourceCapsule, { recursive: true });
    const source = join(sourceCapsule, "result-image.png");
    await writeFile(source, "source", "utf8");
    const artifacts = new JsonRoundArtifactStore(roundsRoot);

    await expect(artifacts.copyResultAsBase("R001", "R001", source)).rejects.toThrow(
      "Continuation source and target rounds must differ."
    );
    await mkdir(join(roundsRoot, "R002"));
    await expect(artifacts.copyResultAsBase("R001", "R002", source)).rejects.toMatchObject({
      code: "EEXIST"
    });
  });

  it("rejects a symlinked continuation target capsule", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const sourceCapsule = join(roundsRoot, "R001");
    const aliasedCapsule = join(roundsRoot, "R003");
    await mkdir(sourceCapsule, { recursive: true });
    await mkdir(aliasedCapsule);
    const source = join(sourceCapsule, "result-image.png");
    await writeFile(source, "source", "utf8");
    await symlink(aliasedCapsule, join(roundsRoot, "R002"));

    await expect(
      new JsonRoundArtifactStore(roundsRoot).copyResultAsBase("R001", "R002", source)
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("rejects a Result Image file symlink even within the source capsule", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const sourceCapsule = join(roundsRoot, "R001");
    await mkdir(sourceCapsule, { recursive: true });
    const realSource = join(sourceCapsule, "real-result.png");
    const linkedSource = join(sourceCapsule, "result-image.png");
    await writeFile(realSource, "source", "utf8");
    await symlink(realSource, linkedSource);

    await expect(
      new JsonRoundArtifactStore(roundsRoot).copyResultAsBase("R001", "R002", linkedSource)
    ).rejects.toThrow("Recorded result image is missing or unsupported.");
  });

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

  it("accepts a signature-valid participant image only from feedback-images", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const feedbackRoot = join(roundsRoot, "R001", "feedback-images");
    await mkdir(feedbackRoot, { recursive: true });
    const imagePath = join(feedbackRoot, "message-1-attachment-0.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const accepted = await new JsonRoundArtifactStore(roundsRoot).acceptFeedbackImage(
      "R001",
      imagePath
    );

    expect(accepted).toBe(await realpath(imagePath));
    expect((await stat(accepted)).mode & 0o777).toBe(0o600);
  });

  it("rejects participant images with mismatched bytes or the wrong capsule location", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const feedbackRoot = join(roundsRoot, "R001", "feedback-images");
    await mkdir(feedbackRoot, { recursive: true });
    const mismatched = join(feedbackRoot, "bad.png");
    const wrongLocation = join(roundsRoot, "R001", "ordinary.png");
    await writeFile(mismatched, Buffer.from([0xff, 0xd8, 0xff]));
    await writeFile(wrongLocation, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const artifacts = new JsonRoundArtifactStore(roundsRoot);

    await expect(artifacts.acceptFeedbackImage("R001", mismatched)).rejects.toThrow(
      "Feedback image must be a valid staged PNG, JPEG, or WebP inside its round capsule."
    );
    await expect(artifacts.acceptFeedbackImage("R001", wrongLocation)).rejects.toThrow(
      "Feedback image must be a valid staged PNG, JPEG, or WebP inside its round capsule."
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "feedback-round-artifacts-"));
  temporaryDirectories.push(directory);
  return directory;
}
