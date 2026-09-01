import { describe, expect, it } from "vitest";

import {
  isSupportedOpenClawNodeVersion,
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
});
