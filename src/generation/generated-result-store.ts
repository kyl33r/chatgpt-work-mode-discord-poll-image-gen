import { chmod, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import sharp from "sharp";

import {
  ROUND_RESULT_IMAGE_BASENAME,
  SUPPORTED_IMAGE_MIME_TYPES
} from "../constants.js";
import { assertSafeRoundId, roundCapsuleDirectory } from "../round/round-paths.js";

export interface GeneratedResultStore {
  stage(roundId: string, bytes: Buffer, mediaType: string): Promise<string>;
}

export class JsonGeneratedResultStore implements GeneratedResultStore {
  public constructor(private readonly roundsRoot: string) {}

  public async stage(
    roundId: string,
    bytes: Buffer,
    mediaType: string
  ): Promise<string> {
    assertSafeRoundId(roundId);
    const format = imageFormat(mediaType);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || !(await matchesFormat(bytes, format))) {
      throw invalidGeneratedResult();
    }
    const root = resolve(this.roundsRoot);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const capsule = roundCapsuleDirectory(root, roundId);
    await mkdir(capsule, { recursive: true, mode: 0o700 });
    await requireContainedDirectory(capsule, root);
    const extension = format === "jpeg" ? ".jpg" : `.${format}`;
    const destination = join(
      capsule,
      `${ROUND_RESULT_IMAGE_BASENAME}${extension}`
    );
    let handle;
    try {
      handle = await open(destination, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      await chmod(destination, 0o600);
      if (!(await matchesFormat(destination, format))) {
        throw invalidGeneratedResult();
      }
      return destination;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function imageFormat(mediaType: string): "png" | "jpeg" | "webp" {
  if (!SUPPORTED_IMAGE_MIME_TYPES.some((candidate) => candidate === mediaType)) {
    throw invalidGeneratedResult();
  }
  return mediaType === "image/jpeg" ? "jpeg" : mediaType.slice("image/".length) as "png" | "webp";
}

async function matchesFormat(
  input: Buffer | string,
  expected: "png" | "jpeg" | "webp"
): Promise<boolean> {
  try {
    return (await sharp(input).metadata()).format === expected;
  } catch {
    return false;
  }
}

async function requireContainedDirectory(path: string, parent: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw invalidGeneratedResult();
  }
  const resolvedPath = await realpath(path);
  const resolvedParent = await realpath(parent);
  const pathFromParent = relative(resolvedParent, resolvedPath);
  if (
    pathFromParent.length === 0 ||
    pathFromParent === ".." ||
    pathFromParent.startsWith(`..${sep}`) ||
    isAbsolute(pathFromParent)
  ) {
    throw invalidGeneratedResult();
  }
}

function invalidGeneratedResult(): Error {
  return new Error("Generated image output is missing, invalid, or ambiguous.");
}
