import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import { SUPPORTED_IMAGE_EXTENSIONS } from "../constants.js";
import { assertSafeRoundId, roundCapsuleDirectory } from "./round-paths.js";

export interface RoundArtifactStore {
  acceptBaseImage(roundId: string, candidatePath: string): Promise<string>;
  acceptResultImage(roundId: string, candidatePath: string): Promise<string>;
  requireResultImage(roundId: string, storedPath: string): Promise<string>;
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
      !(await stat(resolvedPath)).isFile() ||
      !SUPPORTED_IMAGE_EXTENSIONS.some((candidate) => candidate === extension)
    ) {
      throw new Error(errorMessage);
    }
    return resolvedPath;
  }
}
