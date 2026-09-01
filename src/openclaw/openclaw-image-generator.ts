import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import sharp from "sharp";

import {
  OPENCLAW_CONTEXT_SHEET_CELL_SIZE_PX,
  OPENCLAW_CONTEXT_SHEET_COLUMNS,
  OPENCLAW_CONTEXT_SHEET_FILE_NAME,
  SUPPORTED_IMAGE_MIME_TYPES
} from "../constants.js";
import type {
  ImageGenerationInput,
  ImageGenerationResult,
  ImageGenerator
} from "../generation/image-generator.js";

type OpenClawGenerateImage = OpenClawPluginApi["runtime"]["imageGeneration"]["generate"];
type OpenClawConfig = OpenClawPluginApi["config"];

export interface OpenClawImageGeneratorDependencies {
  generate: OpenClawGenerateImage;
  config: OpenClawConfig;
  agentDir?: string;
}

export class OpenClawImageGenerator implements ImageGenerator {
  public constructor(private readonly dependencies: OpenClawImageGeneratorDependencies) {}

  public async generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const inputImages = [await loadImage(input.baseImagePath)];
    if (input.contextImagePaths.length > 0) {
      inputImages.push(await createParticipantContextSheet(input.contextImagePaths));
    }
    const result = await this.dependencies.generate({
      cfg: this.dependencies.config,
      prompt: input.prompt,
      ...(this.dependencies.agentDir === undefined
        ? {}
        : { agentDir: this.dependencies.agentDir }),
      count: 1,
      outputFormat: "png",
      autoProviderFallback: false,
      inputImages
    });
    if (
      result.images.length !== 1 ||
      !result.images[0] ||
      !Buffer.isBuffer(result.images[0].buffer) ||
      result.images[0].buffer.length === 0 ||
      !SUPPORTED_IMAGE_MIME_TYPES.some(
        (mediaType) => mediaType === result.images[0]?.mimeType
      )
    ) {
      throw new Error("OpenClaw image generation returned an ambiguous result.");
    }
    return {
      kind: "succeeded",
      bytes: result.images[0].buffer,
      mediaType: result.images[0].mimeType
    };
  }
}

async function createParticipantContextSheet(paths: readonly string[]) {
  const images = await Promise.all(paths.map((path) => loadImage(path)));
  const columns = Math.min(OPENCLAW_CONTEXT_SHEET_COLUMNS, images.length);
  const rows = Math.ceil(images.length / columns);
  const tiles = await Promise.all(
    images.map(async (image) =>
      sharp(image.buffer)
        .resize(
          OPENCLAW_CONTEXT_SHEET_CELL_SIZE_PX,
          OPENCLAW_CONTEXT_SHEET_CELL_SIZE_PX,
          {
            fit: "contain",
            background: { r: 255, g: 255, b: 255, alpha: 1 }
          }
        )
        .png()
        .toBuffer()
    )
  );
  const buffer = await sharp({
    create: {
      width: columns * OPENCLAW_CONTEXT_SHEET_CELL_SIZE_PX,
      height: rows * OPENCLAW_CONTEXT_SHEET_CELL_SIZE_PX,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  })
    .composite(
      tiles.map((tile, index) => ({
        input: tile,
        left:
          (index % columns) * OPENCLAW_CONTEXT_SHEET_CELL_SIZE_PX,
        top:
          Math.floor(index / columns) * OPENCLAW_CONTEXT_SHEET_CELL_SIZE_PX
      }))
    )
    .png()
    .toBuffer();
  return {
    buffer,
    mimeType: "image/png" as const,
    fileName: OPENCLAW_CONTEXT_SHEET_FILE_NAME
  };
}

async function loadImage(path: string) {
  if (!isAbsolute(path)) {
    throw new Error("An absolute persisted image path is required.");
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("A persisted image is missing or unsupported.");
  }
  const bytes = await readFile(path);
  const imageMetadata = await sharp(bytes).metadata();
  const mediaType = mediaTypeForFormat(imageMetadata.format);
  return { buffer: bytes, mimeType: mediaType, fileName: basename(path) };
}

function mediaTypeForFormat(format: string | undefined): "image/png" | "image/jpeg" | "image/webp" {
  if (format === "png") {
    return "image/png";
  }
  if (format === "jpeg") {
    return "image/jpeg";
  }
  if (format === "webp") {
    return "image/webp";
  }
  throw new Error("A persisted image is missing or unsupported.");
}
