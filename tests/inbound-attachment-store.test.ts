import { lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { JsonInboundAttachmentStore } from "../src/messaging/inbound-attachment-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("JsonInboundAttachmentStore", () => {
  it("copies a staged Base Image into its isolated round capsule", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inbound-attachment-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "openclaw-staging-image");
    await writeFile(source, await validPng());

    const imported = await new JsonInboundAttachmentStore(
      join(directory, ".state", "rounds")
    ).importBaseImage("ROUND1", source, "image/png");

    expect(imported).toBe(
      join(directory, ".state", "rounds", "ROUND1", "base-image.png")
    );
    expect(imported).not.toBe(source);
    expect(await readFile(imported)).toEqual(await readFile(source));
    expect((await stat(imported)).mode & 0o777).toBe(0o600);
  });

  it("imports a selected participant image into the owning round capsule", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "inbound-feedback-image-"));
    try {
      const sourcePath = join(temporary, "provider-stage.png");
      await sharp({
        create: {
          width: 3,
          height: 3,
          channels: 4,
          background: { r: 10, g: 20, b: 30, alpha: 1 }
        }
      })
        .png()
        .toFile(sourcePath);
      const roundsRoot = join(temporary, ".state", "rounds");
      const store = new JsonInboundAttachmentStore(roundsRoot);

      const imported = await store.importFeedbackImage(
        "ROUND1",
        1,
        0,
        sourcePath,
        "image/png"
      );

      expect(imported).toBe(
        join(
          roundsRoot,
          "ROUND1",
          "feedback-images",
          "message-1-attachment-0.png"
        )
      );
      expect(await readFile(imported)).toEqual(await readFile(sourcePath));
      expect((await lstat(imported)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

function validPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }
    }
  })
    .png()
    .toBuffer();
}
