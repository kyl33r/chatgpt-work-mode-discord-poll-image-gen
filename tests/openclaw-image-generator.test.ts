import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { OpenClawImageGenerator } from "../src/openclaw/openclaw-image-generator.js";

describe("OpenClawImageGenerator", () => {
  it("edits the Base Image once with every participant image in one ordered contact sheet", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "openclaw-image-generator-"));
    try {
      const baseImagePath = join(temporary, "base.png");
      const inputBytes = await validPng();
      await writeFile(baseImagePath, inputBytes);
      const contextImagePaths = await Promise.all(
        Array.from({ length: 5 }, async (_, index) => {
          const path = join(temporary, `context-${index + 1}.png`);
          await writeFile(path, await validPng(20 + index));
          return path;
        })
      );
      const outputBytes = await validPng(20);
      const generate = vi.fn().mockResolvedValue({
        images: [{ buffer: outputBytes, mimeType: "image/png" }]
      });
      const generator = new OpenClawImageGenerator({
        generate,
        config: {} as never,
        agentDir: temporary
      });

      await expect(
        generator.generate({
          prompt: "Persisted prompt",
          baseImagePath,
          contextImagePaths
        })
      ).resolves.toEqual({
        kind: "succeeded",
        bytes: outputBytes,
        mediaType: "image/png"
      });
      expect(generate).toHaveBeenCalledTimes(1);
      const request = generate.mock.calls[0]?.[0];
      expect(request).toMatchObject({
        prompt: "Persisted prompt",
        count: 1,
        inputImages: [
          expect.objectContaining({ fileName: "base.png" }),
          expect.objectContaining({ fileName: "participant-context.png" })
        ]
      });
      expect(request.inputImages).toHaveLength(2);
      await expect(
        sharp(request.inputImages[1]?.buffer).metadata()
      ).resolves.toMatchObject({ width: 1536, height: 1024, format: "png" });
      const sheet = await sharp(request.inputImages[1]?.buffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const redAt = (column: number, row: number) =>
        sheet.data[(row * 512 + 256) * sheet.info.width * 4 + (column * 512 + 256) * 4];
      expect([
        redAt(0, 0),
        redAt(1, 0),
        redAt(2, 0),
        redAt(0, 1),
        redAt(1, 1)
      ]).toEqual([20, 21, 22, 23, 24]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

function validPng(red = 10): Promise<Buffer> {
  return sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: red, g: 2, b: 3, alpha: 1 }
    }
  })
    .png()
    .toBuffer();
}
