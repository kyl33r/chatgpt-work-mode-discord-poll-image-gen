import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import { JsonRoundArtifactStore } from "../src/round/round-artifact-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("JsonRoundArtifactStore", () => {
  it("accepts only the canonical decodable Base Image in its round capsule", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const capsule = join(roundsRoot, "R001");
    await mkdir(capsule, { recursive: true });
    const baseImage = join(capsule, "base-image.png");
    await writeFile(baseImage, await validPng());
    const artifacts = new JsonRoundArtifactStore(roundsRoot);

    await expect(artifacts.acceptBaseImage("R001", baseImage)).resolves.toBe(
      await realpath(baseImage)
    );
    await writeFile(baseImage, Buffer.from("corrupt"));
    await expect(artifacts.acceptBaseImage("R001", baseImage)).rejects.toThrow(
      "Base image must be staged under the durable state directory."
    );
  });

  it("copies one source Result Image into a distinct target Base Image", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const sourceCapsule = join(roundsRoot, "R001");
    const targetCapsule = join(roundsRoot, "R002");
    await mkdir(sourceCapsule, { recursive: true });
    const source = join(sourceCapsule, "result-image.png");
    await writeFile(source, await validPng());

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

  it("rejects a corrupt Result Image before it can seed a continuation round", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const sourceCapsule = join(roundsRoot, "R001");
    await mkdir(sourceCapsule, { recursive: true });
    const corruptSource = join(sourceCapsule, "result-image.png");
    await writeFile(corruptSource, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

    await expect(
      new JsonRoundArtifactStore(roundsRoot).copyResultAsBase(
        "R001",
        "R002",
        corruptSource
      )
    ).rejects.toThrow("Recorded result image is missing or unsupported.");
  });

  it("rejects other decodable images in the capsule as the round Result Image", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const capsule = join(roundsRoot, "R001");
    const feedbackRoot = join(capsule, "feedback-images");
    await mkdir(feedbackRoot, { recursive: true });
    const baseImage = join(capsule, "base-image.png");
    const feedbackImage = join(feedbackRoot, "message-1-attachment-0.png");
    const image = await validPng();
    await Promise.all([
      writeFile(baseImage, image),
      writeFile(feedbackImage, image)
    ]);
    const artifacts = new JsonRoundArtifactStore(roundsRoot);

    await expect(artifacts.requireResultImage("R001", baseImage)).rejects.toThrow(
      "Recorded result image is missing or unsupported."
    );
    await expect(artifacts.requireResultImage("R001", feedbackImage)).rejects.toThrow(
      "Recorded result image is missing or unsupported."
    );
  });

  it("never reuses a source capsule or overwrites an existing target capsule", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const sourceCapsule = join(roundsRoot, "R001");
    await mkdir(sourceCapsule, { recursive: true });
    const source = join(sourceCapsule, "result-image.png");
    await writeFile(source, await validPng());
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
    await writeFile(source, await validPng());
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
    await writeFile(imagePath, await validPng());

    const accepted = await new JsonRoundArtifactStore(roundsRoot).acceptFeedbackImage(
      "R001",
      1,
      0,
      imagePath
    );

    expect(accepted).toBe(await realpath(imagePath));
    expect((await stat(accepted)).mode & 0o777).toBe(0o600);
    await expect(
      new JsonRoundArtifactStore(roundsRoot).requireFeedbackImage("R001", 2, 0, imagePath)
    ).rejects.toThrow(
      "Feedback image must be a valid staged PNG, JPEG, or WebP inside its round capsule."
    );
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

    await expect(artifacts.acceptFeedbackImage("R001", 1, 0, mismatched)).rejects.toThrow(
      "Feedback image must be a valid staged PNG, JPEG, or WebP inside its round capsule."
    );
    await expect(artifacts.acceptFeedbackImage("R001", 1, 0, wrongLocation)).rejects.toThrow(
      "Feedback image must be a valid staged PNG, JPEG, or WebP inside its round capsule."
    );
  });

  it("rejects truncated PNG, JPEG, and WebP downloads", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const feedbackRoot = join(roundsRoot, "R001", "feedback-images");
    await mkdir(feedbackRoot, { recursive: true });
    const files = [
      ["message-1-attachment-0.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      ["message-1-attachment-1.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
      ["message-2-attachment-0.webp", Buffer.from("RIFF0000WEBP", "ascii")]
    ] as const;
    const artifacts = new JsonRoundArtifactStore(roundsRoot);

    for (const [name, bytes] of files) {
      const imagePath = join(feedbackRoot, name);
      await writeFile(imagePath, bytes);
      const match = name.match(/^message-(\d+)-attachment-(\d+)/)!;
      await expect(
        artifacts.acceptFeedbackImage("R001", Number(match[1]), Number(match[2]), imagePath)
      ).rejects.toThrow(
        "Feedback image must be a valid staged PNG, JPEG, or WebP inside its round capsule."
      );
    }
  });

  it("rejects a complete-looking PNG whose encoded payload is corrupt", async () => {
    const directory = await temporaryDirectory();
    const roundsRoot = join(directory, "rounds");
    const feedbackRoot = join(roundsRoot, "R001", "feedback-images");
    await mkdir(feedbackRoot, { recursive: true });
    const imagePath = join(feedbackRoot, "message-1-attachment-0.png");
    const corrupt = Buffer.from(await validPng());
    const imageDataMarker = corrupt.indexOf(Buffer.from("IDAT", "ascii"));
    corrupt[imageDataMarker + 4] = (corrupt[imageDataMarker + 4] ?? 0) ^ 0xff;
    await writeFile(imagePath, corrupt);

    await expect(
      new JsonRoundArtifactStore(roundsRoot).acceptFeedbackImage("R001", 1, 0, imagePath)
    ).rejects.toThrow(
      "Feedback image must be a valid staged PNG, JPEG, or WebP inside its round capsule."
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "feedback-round-artifacts-"));
  temporaryDirectories.push(directory);
  return directory;
}

function validPng(): Promise<Buffer> {
  return sharp({
    create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } }
  }).png().toBuffer();
}
