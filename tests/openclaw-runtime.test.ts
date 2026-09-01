import { describe, expect, it } from "vitest";

import {
  assertOpenClawGatewayPortIsolation,
  isSupportedOpenClawNodeVersion,
  parseListeningTcpPorts,
  requirePinnedOpenClawVersion
} from "../src/openclaw/openclaw-runtime.js";

describe("OpenClaw runtime guard", () => {
  it("accepts only the pinned OpenClaw release and its supported Node lines", () => {
    expect(isSupportedOpenClawNodeVersion("22.22.0")).toBe(true);
    expect(isSupportedOpenClawNodeVersion("24.19.0")).toBe(true);
    expect(isSupportedOpenClawNodeVersion("25.9.0")).toBe(true);
    expect(isSupportedOpenClawNodeVersion("22.21.9")).toBe(false);
    expect(isSupportedOpenClawNodeVersion("26.0.0")).toBe(false);
    expect(() => requirePinnedOpenClawVersion("2026.8.1")).not.toThrow();
    expect(() => requirePinnedOpenClawVersion("2026.8.2")).toThrow(
      "The installed OpenClaw release does not match the pinned POC version."
    );
  });

  it("requires the gateway port to be separated from every other listener", () => {
    expect(() =>
      assertOpenClawGatewayPortIsolation(21789, [21769, 21809])
    ).not.toThrow();
    expect(() =>
      assertOpenClawGatewayPortIsolation(21789, [21770])
    ).toThrow("The isolated OpenClaw Gateway port is too close to another local listener.");
    expect(() =>
      assertOpenClawGatewayPortIsolation(21789, [21808])
    ).toThrow("The isolated OpenClaw Gateway port is too close to another local listener.");
    expect(() =>
      assertOpenClawGatewayPortIsolation(21789, [21789])
    ).not.toThrow();
  });

  it("extracts listener ports without retaining process details", () => {
    expect(
      parseListeningTcpPorts("p123\ncnode\nn127.0.0.1:18789\nn[::1]:631\n")
    ).toEqual([631, 18789]);
  });
});
