import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  realpath,
  rm
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import sharp from "sharp";

import {
  ROUND_BASE_IMAGE_BASENAME,
  ROUND_FEEDBACK_IMAGES_DIRECTORY_NAME,
  SUPPORTED_IMAGE_MIME_TYPES
} from "../constants.js";
import { assertSafeRoundId, roundCapsuleDirectory } from "../round/round-paths.js";

export interface InboundAttachmentStore {
  importBaseImage(
    roundId: string,
    stagedPath: string,
    mediaType: string
  ): Promise<string>;
  importFeedbackImage(
    roundId: string,
    messageOrdinal: number,
    attachmentIndex: number,
    stagedPath: string,
    mediaType: string
  ): Promise<string>;
}

export class JsonInboundAttachmentStore implements InboundAttachmentStore {
  public constructor(private readonly roundsRoot: string) {}

  public async importBaseImage(
    roundId: string,
    stagedPath: string,
    mediaType: string
  ): Promise<string> {
    assertSafeRoundId(roundId);
    const format = imageFormat(mediaType);
    const extension = format === "jpeg" ? ".jpg" : `.${format}`;
    const root = resolve(this.roundsRoot);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const source = await requireExternalImage(stagedPath, root, format);
    const capsule = roundCapsuleDirectory(root, roundId);
    let createdCapsule = false;
    try {
      await mkdir(capsule, { mode: 0o700 });
      createdCapsule = true;
      const destination = join(
        capsule,
        `${ROUND_BASE_IMAGE_BASENAME}${extension}`
      );
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      await chmod(destination, 0o600);
      if (!(await isDecodableImage(destination, format))) {
        throw invalidInboundImage();
      }
      return destination;
    } catch (error) {
      if (createdCapsule) {
        await rm(capsule, { recursive: true, force: true });
      }
      throw error;
    }
  }

  public async importFeedbackImage(
    roundId: string,
    messageOrdinal: number,
    attachmentIndex: number,
    stagedPath: string,
    mediaType: string
  ): Promise<string> {
    assertSafeRoundId(roundId);
    if (
      !Number.isInteger(messageOrdinal) ||
      messageOrdinal <= 0 ||
      !Number.isInteger(attachmentIndex) ||
      attachmentIndex < 0
    ) {
      throw invalidInboundImage();
    }
    const format = imageFormat(mediaType);
    const extension = format === "jpeg" ? ".jpg" : `.${format}`;
    const root = resolve(this.roundsRoot);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const source = await requireExternalImage(stagedPath, root, format);
    const capsule = roundCapsuleDirectory(root, roundId);
    await mkdir(capsule, { recursive: true, mode: 0o700 });
    await requireContainedDirectory(capsule, root);
    const feedbackDirectory = join(capsule, ROUND_FEEDBACK_IMAGES_DIRECTORY_NAME);
    await mkdir(feedbackDirectory, { recursive: true, mode: 0o700 });
    await requireContainedDirectory(feedbackDirectory, capsule);
    await chmod(feedbackDirectory, 0o700);
    const destination = join(
      feedbackDirectory,
      `message-${messageOrdinal}-attachment-${attachmentIndex}${extension}`
    );
    try {
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      await chmod(destination, 0o600);
      if (!(await isDecodableImage(destination, format))) {
        throw invalidInboundImage();
      }
      return destination;
    } catch (error) {
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

async function requireContainedDirectory(path: string, parent: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw invalidInboundImage();
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
    throw invalidInboundImage();
  }
}

async function requireExternalImage(
  stagedPath: string,
  roundsRoot: string,
  expectedFormat: "png" | "jpeg" | "webp"
): Promise<string> {
  if (typeof stagedPath !== "string" || !isAbsolute(stagedPath)) {
    throw invalidInboundImage();
  }
  let source: string;
  try {
    const metadata = await lstat(stagedPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw invalidInboundImage();
    }
    source = await realpath(stagedPath);
  } catch {
    throw invalidInboundImage();
  }
  const pathFromRoot = relative(roundsRoot, source);
  if (
    pathFromRoot.length === 0 ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot)) ||
    !(await isDecodableImage(source, expectedFormat))
  ) {
    throw invalidInboundImage();
  }
  return source;
}

function imageFormat(mediaType: string): "png" | "jpeg" | "webp" {
  if (!SUPPORTED_IMAGE_MIME_TYPES.some((candidate) => candidate === mediaType)) {
    throw invalidInboundImage();
  }
  return mediaType === "image/png"
    ? "png"
    : mediaType === "image/webp"
      ? "webp"
      : "jpeg";
}

async function isDecodableImage(
  path: string,
  expectedFormat: "png" | "jpeg" | "webp"
): Promise<boolean> {
  try {
    const decoder = sharp(path, { failOn: "error" });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== expectedFormat ||
      !metadata.width ||
      !metadata.height
    ) {
      return false;
    }
    await decoder.clone().raw().toBuffer();
    return true;
  } catch {
    return false;
  }
}

function invalidInboundImage(): Error {
  return new Error("Inbound Base Image is missing, unsupported, or ambiguously staged.");
}
