import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CLIPBOARD_HELPER_MAX_OUTPUT_BYTES,
  CLIPBOARD_HELPER_PROTOCOL_VERSION
} from "../constants.js";
import type { ClipboardImageSource } from "./clipboard-image-source.js";

export interface NativeClipboardHelperResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export type NativeClipboardHelperRunner = (
  operation: "count" | "read"
) => Promise<NativeClipboardHelperResult>;

export type ClipboardImageSourceErrorCategory =
  | "unsupported-platform"
  | "invalid-request"
  | "helper-failed"
  | "malformed-protocol"
  | "clipboard-unchanged"
  | "clipboard-overadvanced"
  | "no-image"
  | "multiple-images"
  | "image-decode-failed";

const CONTROLLED_ERROR_MESSAGES: Record<ClipboardImageSourceErrorCategory, string> = {
  "unsupported-platform": "Clipboard image capture is unsupported on this platform.",
  "invalid-request": "Clipboard image capture received an invalid change count.",
  "helper-failed": "The native clipboard helper failed.",
  "malformed-protocol": "The native clipboard helper returned an invalid response.",
  "clipboard-unchanged": "The clipboard did not change after the copy action.",
  "clipboard-overadvanced": "The clipboard changed more than once after the copy action.",
  "no-image": "The clipboard does not contain one image item.",
  "multiple-images": "The clipboard contains more than one image item.",
  "image-decode-failed": "The clipboard image could not be decoded."
};

export class ClipboardImageSourceError extends Error {
  public readonly disposition = "terminal" as const;

  public constructor(public readonly category: ClipboardImageSourceErrorCategory) {
    super(CONTROLLED_ERROR_MESSAGES[category]);
    this.name = "ClipboardImageSourceError";
  }
}

export interface MacOsClipboardImageSourceOptions {
  platform?: NodeJS.Platform;
  runner?: NativeClipboardHelperRunner;
}

export class MacOsClipboardImageSource implements ClipboardImageSource {
  private readonly platform: NodeJS.Platform;
  private readonly runner: NativeClipboardHelperRunner;

  public constructor(options: MacOsClipboardImageSourceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? createNativeClipboardHelperRunner();
  }

  public async getChangeCount(): Promise<number> {
    this.requireMacOs();
    const result = await this.runHelper("count");
    if (result.exitCode !== 0) {
      throw new ClipboardImageSourceError("helper-failed");
    }
    try {
      const { header, body } = parseResponse(result.stdout);
      if (
        body.length !== 0 ||
        !hasExactKeys(header, ["protocolVersion", "kind", "changeCount"]) ||
        header.protocolVersion !== CLIPBOARD_HELPER_PROTOCOL_VERSION ||
        header.kind !== "count" ||
        !isChangeCount(header.changeCount)
      ) {
        throw new Error();
      }
      return header.changeCount;
    } catch {
      throw new ClipboardImageSourceError("malformed-protocol");
    }
  }

  public async readSingleImage(
    previousChangeCount: number
  ): Promise<{ observedChangeCount: number; pngBytes: Uint8Array }> {
    this.requireMacOs();
    if (!isChangeCount(previousChangeCount)) {
      throw new ClipboardImageSourceError("invalid-request");
    }
    const result = await this.runHelper("read");
    if (result.exitCode !== 0) {
      throw new ClipboardImageSourceError("helper-failed");
    }

    let response: ReturnType<typeof parseResponse>;
    try {
      response = parseResponse(result.stdout);
    } catch {
      throw new ClipboardImageSourceError("malformed-protocol");
    }
    const { header, body } = response;
    if (header.kind === "failure") {
      throw parseFailure(header, body);
    }
    if (
      !hasExactKeys(header, [
        "protocolVersion",
        "kind",
        "changeCount",
        "imageItemCount",
        "imageRepresentationCount",
        "pngByteLength"
      ]) ||
      header.protocolVersion !== CLIPBOARD_HELPER_PROTOCOL_VERSION ||
      header.kind !== "image" ||
      !isChangeCount(header.changeCount)
    ) {
      throw new ClipboardImageSourceError("malformed-protocol");
    }
    if (header.changeCount === previousChangeCount) {
      throw new ClipboardImageSourceError("clipboard-unchanged");
    }
    if (header.changeCount !== previousChangeCount + 1) {
      throw new ClipboardImageSourceError("clipboard-overadvanced");
    }
    if (
      header.imageItemCount !== 1 ||
      !Number.isSafeInteger(header.imageRepresentationCount) ||
      (header.imageRepresentationCount as number) < 1 ||
      header.pngByteLength !== body.length ||
      body.length < 8 ||
      !hasPngSignature(body)
    ) {
      throw new ClipboardImageSourceError("malformed-protocol");
    }
    return { observedChangeCount: header.changeCount, pngBytes: body };
  }

  private requireMacOs(): void {
    if (this.platform !== "darwin") {
      throw new ClipboardImageSourceError("unsupported-platform");
    }
  }

  private async runHelper(operation: "count" | "read"): Promise<NativeClipboardHelperResult> {
    try {
      return await this.runner(operation);
    } catch {
      throw new ClipboardImageSourceError("helper-failed");
    }
  }
}

function createNativeClipboardHelperRunner(): NativeClipboardHelperRunner {
  const helperPath = fileURLToPath(
    new URL("../../scripts/read-macos-clipboard.swift", import.meta.url)
  );
  return (operation) =>
    new Promise((resolve) => {
      execFile(
        "xcrun",
        ["swift", helperPath, operation],
        { encoding: "buffer", maxBuffer: CLIPBOARD_HELPER_MAX_OUTPUT_BYTES },
        (error, stdout, stderr) => {
          resolve({
            exitCode: typeof error?.code === "number" ? error.code : error ? -1 : 0,
            stdout: new Uint8Array(stdout),
            stderr: new Uint8Array(stderr)
          });
        }
      );
    });
}

function parseFailure(
  header: Record<string, unknown>,
  body: Uint8Array
): ClipboardImageSourceError {
  if (
    body.length !== 0 ||
    !hasExactKeys(header, ["protocolVersion", "kind", "category"]) ||
    header.protocolVersion !== CLIPBOARD_HELPER_PROTOCOL_VERSION
  ) {
    return new ClipboardImageSourceError("malformed-protocol");
  }
  if (header.category === "no-image") {
    return new ClipboardImageSourceError("no-image");
  }
  if (header.category === "multiple-images") {
    return new ClipboardImageSourceError("multiple-images");
  }
  if (header.category === "decode-failed") {
    return new ClipboardImageSourceError("image-decode-failed");
  }
  return new ClipboardImageSourceError("malformed-protocol");
}

function parseResponse(bytes: Uint8Array): {
  header: Record<string, unknown>;
  body: Uint8Array;
} {
  const separator = bytes.indexOf(10);
  if (separator < 0) {
    throw new Error();
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, separator));
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error();
  }
  return {
    header: parsed as Record<string, unknown>,
    body: bytes.slice(separator + 1)
  };
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && expectedKeys.every((key, index) => key === keys[index]);
}

function isChangeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasPngSignature(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return signature.every((byte, index) => bytes[index] === byte);
}
