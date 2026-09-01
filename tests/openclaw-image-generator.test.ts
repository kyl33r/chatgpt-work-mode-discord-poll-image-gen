import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { OpenClawImageGenerator } from "../src/openclaw/openclaw-image-generator.js";

describe("OpenClawImageGenerator", () => {
  it("edits the Base Image once with ordered participant image context", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "openclaw-image-generator-"));
    try {
      const baseImagePath = join(temporary, "base.png");
      const contextImagePath = join(temporary, "context.png");
      const inputBytes = await validPng();
      await writeFile(baseImagePath, inputBytes);
      await writeFile(contextImagePath, inputBytes);
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
          contextImagePaths: [contextImagePath]
        })
      ).resolves.toEqual({
        kind: "succeeded",
        bytes: outputBytes,
        mediaType: "image/png"
      });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Persisted prompt",
          count: 1,
          inputImages: [
            expect.objectContaining({ fileName: "base.png" }),
            expect.objectContaining({ fileName: "context.png" })
          ]
        })
      );
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
