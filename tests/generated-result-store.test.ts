import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { JsonGeneratedResultStore } from "../src/generation/generated-result-store.js";

describe("JsonGeneratedResultStore", () => {
  it("stages one validated generated image inside the owning round capsule", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "generated-result-"));
    try {
      const roundsRoot = join(temporary, ".state", "rounds");
      const bytes = await sharp({
        create: {
          width: 2,
          height: 2,
          channels: 4,
          background: { r: 1, g: 2, b: 3, alpha: 1 }
        }
      })
        .png()
        .toBuffer();

      const staged = await new JsonGeneratedResultStore(roundsRoot).stage(
        "ROUND1",
        bytes,
        "image/png"
      );

      expect(staged).toBe(join(roundsRoot, "ROUND1", "result-image.png"));
      expect(await readFile(staged)).toEqual(bytes);
      expect((await stat(staged)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
