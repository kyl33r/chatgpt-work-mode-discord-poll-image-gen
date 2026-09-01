import {
  OPENCLAW_GATEWAY_MINIMUM_PORT_SEPARATION,
  OPENCLAW_VERSION
} from "../constants.js";

export function assertOpenClawGatewayPortIsolation(
  candidatePort: number,
  occupiedPorts: readonly number[]
): void {
  if (occupiedPorts.includes(candidatePort)) {
    throw new Error("The isolated OpenClaw Gateway port is already occupied.");
  }
  const tooClose = occupiedPorts.some(
    (port) =>
      Math.abs(port - candidatePort) < OPENCLAW_GATEWAY_MINIMUM_PORT_SEPARATION
  );
  if (tooClose) {
    throw new Error(
      "The isolated OpenClaw Gateway port is too close to another local listener."
    );
  }
}

export function parseListeningTcpPorts(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^n.*:(\d+)$/.exec(line);
    if (!match) {
      continue;
    }
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) {
      ports.add(port);
    }
  }
  return [...ports].sort((left, right) => left - right);
}

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
