import { OPENCLAW_VERSION } from "../constants.js";

export function isSupportedOpenClawNodeVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major === 22) {
    return atLeast(minor, patch, 22, 0);
  }
  if (major === 24) {
    return atLeast(minor, patch, 15, 0);
  }
  if (major === 25) {
    return atLeast(minor, patch, 9, 0);
  }
  return false;
}

export function requirePinnedOpenClawVersion(version: string): void {
  if (version !== OPENCLAW_VERSION) {
    throw new Error(
      "The installed OpenClaw release does not match the pinned POC version."
    );
  }
}

function atLeast(
  minor: number,
  patch: number,
  minimumMinor: number,
  minimumPatch: number
): boolean {
  return minor > minimumMinor || (minor === minimumMinor && patch >= minimumPatch);
}
