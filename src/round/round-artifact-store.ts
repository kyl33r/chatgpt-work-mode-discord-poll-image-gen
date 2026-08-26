import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  ROUND_BASE_IMAGE_BASENAME,
  ROUND_FEEDBACK_IMAGE_FILENAME_PATTERN,
  ROUND_FEEDBACK_IMAGES_DIRECTORY_NAME,
  SUPPORTED_IMAGE_EXTENSIONS
} from "../constants.js";
import { assertSafeRoundId, roundCapsuleDirectory } from "./round-paths.js";

export interface RoundArtifactStore {
  acceptBaseImage(roundId: string, candidatePath: string): Promise<string>;
  acceptResultImage(roundId: string, candidatePath: string): Promise<string>;
  requireResultImage(roundId: string, storedPath: string): Promise<string>;
  acceptFeedbackImage(roundId: string, candidatePath: string): Promise<string>;
  requireFeedbackImage(roundId: string, storedPath: string): Promise<string>;
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

  public acceptResultImage(roundId: string, candidatePath: string): Promise<string> {
    return this.requireCapsuleImage(
      roundId,
      candidatePath,
      "Result image must be staged under the durable state directory."
    );
  }

  public requireResultImage(roundId: string, storedPath: string): Promise<string> {
    return this.requireCapsuleImage(
      roundId,
      storedPath,
      "Recorded result image is missing or unsupported."
    );
  }

  public async acceptFeedbackImage(roundId: string, candidatePath: string): Promise<string> {
    const accepted = await this.requireValidFeedbackImage(roundId, candidatePath);
    await chmod(accepted, 0o600);
    return accepted;
  }

  public requireFeedbackImage(roundId: string, storedPath: string): Promise<string> {
    return this.requireValidFeedbackImage(roundId, storedPath);
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

  private async requireValidFeedbackImage(
    roundId: string,
    candidatePath: string
  ): Promise<string> {
    const errorMessage =
      "Feedback image must be a valid staged PNG, JPEG, or WebP inside its round capsule.";
    const resolvedPath = await this.requireCapsuleImage(roundId, candidatePath, errorMessage);
    const resolvedCapsule = await realpath(roundCapsuleDirectory(this.roundsRoot, roundId));
    if (
      dirname(relative(resolvedCapsule, resolvedPath)) !== ROUND_FEEDBACK_IMAGES_DIRECTORY_NAME ||
      !ROUND_FEEDBACK_IMAGE_FILENAME_PATTERN.test(basename(resolvedPath))
    ) {
      throw new Error(errorMessage);
    }
    const bytes = await readFile(resolvedPath);
    if (!hasMatchingImageSignature(bytes, extname(resolvedPath).toLowerCase())) {
      throw new Error(errorMessage);
    }
    return resolvedPath;
  }
}

function hasMatchingImageSignature(bytes: Buffer, extension: string): boolean {
  if (extension === ".png") {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return (
    extension === ".webp" &&
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}
