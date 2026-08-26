import { isAbsolute, relative, resolve, sep } from "node:path";

export function assertSafeRoundId(roundId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(roundId)) {
    throw new Error("Round ID is not safe for local storage.");
  }
}

export function roundCapsuleDirectory(roundsRoot: string, roundId: string): string {
  assertSafeRoundId(roundId);
  const resolvedRoot = resolve(roundsRoot);
  const capsulePath = resolve(resolvedRoot, roundId);
  const pathFromRoot = relative(resolvedRoot, capsulePath);
  if (
    pathFromRoot.length === 0 ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Round ID is not safe for local storage.");
  }
  return capsulePath;
}
