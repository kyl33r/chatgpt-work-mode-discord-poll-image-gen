import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rm, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import sharp from "sharp";

import {
  ROUND_BASE_IMAGE_BASENAME,
  ROUND_FEEDBACK_IMAGE_FILENAME_PATTERN,
  ROUND_FEEDBACK_IMAGES_DIRECTORY_NAME,
  ROUND_RESULT_IMAGE_BASENAME,
  SUPPORTED_IMAGE_EXTENSIONS
} from "../constants.js";
import { assertSafeRoundId, roundCapsuleDirectory } from "./round-paths.js";

export interface RoundArtifactStore {
  acceptBaseImage(roundId: string, candidatePath: string): Promise<string>;
  acceptResultImage(roundId: string, candidatePath: string): Promise<string>;
  requireResultImage(roundId: string, storedPath: string): Promise<string>;
  acceptFeedbackImage(
    roundId: string,
    messageOrdinal: number,
    attachmentIndex: number,
    candidatePath: string
  ): Promise<string>;
  requireFeedbackImage(
    roundId: string,
    messageOrdinal: number,
    attachmentIndex: number,
    storedPath: string
  ): Promise<string>;
  copyResultAsBase(
    sourceRoundId: string,
    targetRoundId: string,
    sourcePath: string
  ): Promise<string>;
  discardUnpersistedBase(roundId: string, storedPath: string): Promise<void>;
}

export class JsonRoundArtifactStore implements RoundArtifactStore {
  public constructor(private readonly roundsRoot: string) {}

  public acceptBaseImage(roundId: string, candidatePath: string): Promise<string> {
    return this.requireCapsuleImage(
      roundId,
      candidatePath,
      "Base image must be staged under the durable state directory."
    );
  }

  public async acceptResultImage(roundId: string, candidatePath: string): Promise<string> {
    const accepted = await this.requireValidResultImage(
      roundId,
      candidatePath,
      "Result image must be staged under the durable state directory."
    );
    await chmod(accepted, 0o600);
    return accepted;
  }

  public requireResultImage(roundId: string, storedPath: string): Promise<string> {
    return this.requireValidResultImage(
      roundId,
      storedPath,
      "Recorded result image is missing or unsupported."
    );
  }

  public async acceptFeedbackImage(
    roundId: string,
    messageOrdinal: number,
    attachmentIndex: number,
    candidatePath: string
  ): Promise<string> {
    const accepted = await this.requireValidFeedbackImage(
      roundId,
      messageOrdinal,
      attachmentIndex,
      candidatePath
    );
    await chmod(accepted, 0o600);
    return accepted;
  }

  public requireFeedbackImage(
    roundId: string,
    messageOrdinal: number,
    attachmentIndex: number,
    storedPath: string
  ): Promise<string> {
    return this.requireValidFeedbackImage(roundId, messageOrdinal, attachmentIndex, storedPath);
  }

  public async copyResultAsBase(
    sourceRoundId: string,
    targetRoundId: string,
    sourcePath: string
  ): Promise<string> {
    assertSafeRoundId(sourceRoundId);
    assertSafeRoundId(targetRoundId);
    if (sourceRoundId === targetRoundId) {
      throw new Error("Continuation source and target rounds must differ.");
    }
    const resolvedSource = await this.requireResultImage(sourceRoundId, sourcePath);
    await mkdir(resolve(this.roundsRoot), { recursive: true, mode: 0o700 });
    const targetCapsule = roundCapsuleDirectory(this.roundsRoot, targetRoundId);
    let createdTarget = false;
    try {
      await mkdir(targetCapsule, { mode: 0o700 });
      createdTarget = true;
      const [resolvedRoot, resolvedTarget] = await Promise.all([
        realpath(resolve(this.roundsRoot)),
        realpath(targetCapsule)
      ]);
      if (relative(resolvedRoot, resolvedTarget) !== targetRoundId) {
        throw new Error("Continuation target capsule is not isolated.");
      }
      const destination = join(
        targetCapsule,
        `${ROUND_BASE_IMAGE_BASENAME}${extname(resolvedSource).toLowerCase()}`
      );
      await copyFile(resolvedSource, destination, fsConstants.COPYFILE_EXCL);
      await chmod(destination, 0o600);
      return destination;
    } catch (error) {
      if (createdTarget) {
        await rm(targetCapsule, { recursive: true, force: true });
      }
      throw error;
    }
  }

  public async discardUnpersistedBase(roundId: string, storedPath: string): Promise<void> {
    const resolvedBase = await this.requireCapsuleImage(
      roundId,
      storedPath,
      "Unpersisted continuation Base Image is ambiguous."
    );
    const capsule = roundCapsuleDirectory(this.roundsRoot, roundId);
    const [entries, resolvedCapsule] = await Promise.all([readdir(capsule), realpath(capsule)]);
    if (entries.length !== 1 || join(resolvedCapsule, entries[0] as string) !== resolvedBase) {
      throw new Error("Unpersisted continuation capsule is not empty except for its Base Image.");
    }
    await unlink(resolvedBase);
    await rmdir(capsule);
  }

  private async requireCapsuleImage(
    roundId: string,
    candidatePath: string,
    errorMessage: string
  ): Promise<string> {
    assertSafeRoundId(roundId);
    let resolvedPath: string;
    let resolvedCapsule: string;
    let resolvedRoot: string;
    const expectedCapsule = resolve(roundCapsuleDirectory(this.roundsRoot, roundId));
    const expectedCapsuleFromRoot = relative(resolve(this.roundsRoot), expectedCapsule);
    try {
      const candidateMetadata = await lstat(resolve(candidatePath));
      if (
        !candidateMetadata.isFile() ||
        candidateMetadata.isSymbolicLink() ||
        candidateMetadata.nlink !== 1
      ) {
        throw new Error(errorMessage);
      }
      [resolvedPath, resolvedCapsule, resolvedRoot] = await Promise.all([
        realpath(resolve(candidatePath)),
        realpath(expectedCapsule),
        realpath(resolve(this.roundsRoot))
      ]);
    } catch {
      throw new Error(errorMessage);
    }
    const pathFromCapsule = relative(resolvedCapsule, resolvedPath);
    const capsuleFromRoot = relative(resolvedRoot, resolvedCapsule);
    const extension = extname(resolvedPath).toLowerCase();
    if (
      capsuleFromRoot !== expectedCapsuleFromRoot ||
      pathFromCapsule.length === 0 ||
      pathFromCapsule === ".." ||
      pathFromCapsule.startsWith(`..${sep}`) ||
      isAbsolute(pathFromCapsule) ||
      !SUPPORTED_IMAGE_EXTENSIONS.some((candidate) => candidate === extension)
    ) {
      throw new Error(errorMessage);
    }
    return resolvedPath;
  }

  private async requireValidResultImage(
    roundId: string,
    candidatePath: string,
    errorMessage: string
  ): Promise<string> {
    const resolvedPath = await this.requireCapsuleImage(roundId, candidatePath, errorMessage);
    const resolvedCapsule = await realpath(roundCapsuleDirectory(this.roundsRoot, roundId));
    const pathFromCapsule = relative(resolvedCapsule, resolvedPath);
    const expectedName = `${ROUND_RESULT_IMAGE_BASENAME}${extname(resolvedPath).toLowerCase()}`;
    if (
      dirname(pathFromCapsule) !== "." ||
      basename(pathFromCapsule) !== expectedName ||
      !(await isDecodableImageOfExpectedFormat(resolvedPath))
    ) {
      throw new Error(errorMessage);
    }
    return resolvedPath;
  }

  private async requireValidFeedbackImage(
    roundId: string,
    messageOrdinal: number,
    attachmentIndex: number,
    candidatePath: string
  ): Promise<string> {
    const errorMessage =
      "Feedback image must be a valid staged PNG, JPEG, or WebP inside its round capsule.";
    const resolvedPath = await this.requireCapsuleImage(roundId, candidatePath, errorMessage);
    const resolvedCapsule = await realpath(roundCapsuleDirectory(this.roundsRoot, roundId));
    const expectedName = `message-${messageOrdinal}-attachment-${attachmentIndex}${extname(resolvedPath).toLowerCase()}`;
    if (
      !Number.isInteger(messageOrdinal) ||
      messageOrdinal <= 0 ||
      !Number.isInteger(attachmentIndex) ||
      attachmentIndex < 0 ||
      dirname(relative(resolvedCapsule, resolvedPath)) !== ROUND_FEEDBACK_IMAGES_DIRECTORY_NAME ||
      !ROUND_FEEDBACK_IMAGE_FILENAME_PATTERN.test(basename(resolvedPath)) ||
      basename(resolvedPath) !== expectedName
    ) {
      throw new Error(errorMessage);
    }
    if (!(await isDecodableImageOfExpectedFormat(resolvedPath))) {
      throw new Error(errorMessage);
    }
    return resolvedPath;
  }
}

async function isDecodableImageOfExpectedFormat(path: string): Promise<boolean> {
  const extension = extname(path).toLowerCase();
  const expectedFormat = extension === ".png" ? "png" : extension === ".webp" ? "webp" : "jpeg";
  try {
    const decoder = sharp(path, { failOn: "error" });
    const metadata = await decoder.metadata();
    if (metadata.format !== expectedFormat || !metadata.width || !metadata.height) {
      return false;
    }
    await decoder.clone().raw().toBuffer();
    return true;
  } catch {
    return false;
  }
}
