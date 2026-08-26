import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ClipboardImageSourceError,
  MacOsClipboardImageSource,
  type NativeClipboardHelperRunner
} from "../src/clipboard/macos-clipboard-image-source.js";

describe("MacOsClipboardImageSource", () => {
  it("can be constructed with the private production runner", () => {
    expect(new MacOsClipboardImageSource()).toBeInstanceOf(MacOsClipboardImageSource);
  });

  it("reads a numeric pasteboard change-count baseline", async () => {
    const runner: NativeClipboardHelperRunner = async () => ({
      exitCode: 0,
      stdout: encodedHeader({ protocolVersion: 1, kind: "count", changeCount: 41 }),
      stderr: new Uint8Array()
    });

    const source = new MacOsClipboardImageSource({ platform: "darwin", runner });

    await expect(source.getChangeCount()).resolves.toBe(41);
  });

  it("returns canonical PNG bytes after exactly one change for one item with multiple representations", async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const runner: NativeClipboardHelperRunner = async () => ({
      exitCode: 0,
      stdout: encodedHeader(
        {
          protocolVersion: 1,
          kind: "image",
          changeCount: 42,
          imageItemCount: 1,
          imageRepresentationCount: 2,
          pngByteLength: pngBytes.length
        },
        pngBytes
      ),
      stderr: new Uint8Array()
    });
    const source = new MacOsClipboardImageSource({ platform: "darwin", runner });

    await expect(source.readSingleImage(41)).resolves.toEqual({
      observedChangeCount: 42,
      pngBytes
    });
  });

  it.each([
    [
      "malformed helper protocol",
      41,
      helperResult(new TextEncoder().encode("private malformed output")),
      "malformed-protocol"
    ],
    [
      "helper process failure",
      41,
      helperResult(
        new TextEncoder().encode("private stdout"),
        7,
        new TextEncoder().encode("private stderr")
      ),
      "helper-failed"
    ],
    ["unchanged pasteboard", 41, imageResult(41), "clipboard-unchanged"],
    ["over-advanced pasteboard", 41, imageResult(43), "clipboard-overadvanced"],
    ["zero image items", 41, failureResult("no-image"), "no-image"],
    ["multiple image items", 41, failureResult("multiple-images"), "multiple-images"],
    ["an unreadable image", 41, failureResult("decode-failed"), "image-decode-failed"]
  ] as const)("rejects %s with a controlled terminal error", async (_name, baseline, result, category) => {
    const source = new MacOsClipboardImageSource({
      platform: "darwin",
      runner: async () => result
    });

    const error = await source.readSingleImage(baseline).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClipboardImageSourceError);
    expect(error).toMatchObject({ category, disposition: "terminal" });
    expect((error as Error).message).not.toMatch(/private|stdout|stderr/i);
  });

  it("rejects unsupported platforms as terminal without invoking the helper", async () => {
    let invoked = false;
    const source = new MacOsClipboardImageSource({
      platform: "linux",
      runner: async () => {
        invoked = true;
        return helperResult(new Uint8Array());
      }
    });

    const error = await source.getChangeCount().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      category: "unsupported-platform",
      disposition: "terminal"
    });
    expect(invoked).toBe(false);
  });

  it.runIf(process.platform === "darwin")(
    "reads a generated image from an isolated named pasteboard",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "clipboard-adapter-integration-"));
      const writerPath = join(directory, "write-test-pasteboard.swift");
      const pasteboardName = `com.openai.clipboard-adapter-test.${randomUUID()}`;
      await writeFile(writerPath, NAMED_PASTEBOARD_WRITER, "utf8");
      const writer = spawn("xcrun", ["swift", writerPath, pasteboardName], {
        stdio: ["pipe", "pipe", "pipe"]
      });
      writer.stdin!.on("error", () => undefined);
      const writerClosed = once(writer, "close");
      const output = createInterface({ input: writer.stdout! })[Symbol.asyncIterator]();
      try {
        expect((await output.next()).value).toBe("ready");
        const runner = namedPasteboardRunner(pasteboardName);
        const source = new MacOsClipboardImageSource({ platform: "darwin", runner });
        const baseline = await source.getChangeCount();

        writer.stdin!.write("write\n");
        expect((await output.next()).value).toBe("written");

        const captured = await source.readSingleImage(baseline);
        expect(captured.observedChangeCount).toBe(baseline + 1);
        expect(Array.from(captured.pngBytes.subarray(0, 8))).toEqual([
          137, 80, 78, 71, 13, 10, 26, 10
        ]);
      } finally {
        writer.stdin!.end("release\n");
        await writerClosed.catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000
  );
});

function encodedHeader(header: object, body = new Uint8Array()): Uint8Array {
  const prefix = new TextEncoder().encode(`${JSON.stringify(header)}\n`);
  const result = new Uint8Array(prefix.length + body.length);
  result.set(prefix);
  result.set(body, prefix.length);
  return result;
}

function helperResult(
  stdout: Uint8Array,
  exitCode = 0,
  stderr = new Uint8Array()
) {
  return { exitCode, stdout, stderr };
}

function imageResult(changeCount: number) {
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return helperResult(encodedHeader({
    protocolVersion: 1,
    kind: "image",
    changeCount,
    imageItemCount: 1,
    imageRepresentationCount: 1,
    pngByteLength: pngBytes.length
  }, pngBytes));
}

function failureResult(category: "no-image" | "multiple-images" | "decode-failed") {
  return helperResult(encodedHeader({
    protocolVersion: 1,
    kind: "failure",
    category
  }));
}

function namedPasteboardRunner(pasteboardName: string): NativeClipboardHelperRunner {
  const helperPath = fileURLToPath(
    new URL("../scripts/read-macos-clipboard.swift", import.meta.url)
  );
  return (operation) =>
    runProcess("xcrun", [
      "swift",
      helperPath,
      operation,
      "--test-pasteboard",
      pasteboardName
    ]);
}

function runProcess(file: string, arguments_: string[]): Promise<{
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}> {
  return new Promise((resolve) => {
    execFile(file, arguments_, { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        exitCode: typeof error?.code === "number" ? error.code : error ? -1 : 0,
        stdout: new Uint8Array(stdout),
        stderr: new Uint8Array(stderr)
      });
    });
  });
}

const NAMED_PASTEBOARD_WRITER = String.raw`
import AppKit

let arguments = CommandLine.arguments
guard arguments.count == 2 else { exit(2) }
let pasteboard = NSPasteboard(name: NSPasteboard.Name(arguments[1]))
pasteboard.clearContents()
FileHandle.standardOutput.write(Data("ready\n".utf8))

while let command = readLine() {
  if command == "release" {
    pasteboard.releaseGlobally()
    exit(0)
  }
  if command == "write" {
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: 1,
        pixelsHigh: 1,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 4,
        bitsPerPixel: 32
    )!
    let bytes = bitmap.bitmapData!
    bytes[0] = 12
    bytes[1] = 34
    bytes[2] = 56
    bytes[3] = 255
    let png = bitmap.representation(using: .png, properties: [:])!
    let tiff = bitmap.representation(using: .tiff, properties: [:])!
    let item = NSPasteboardItem()
    item.setData(png, forType: .png)
    item.setData(tiff, forType: .tiff)
    pasteboard.clearContents()
    guard pasteboard.writeObjects([item]) else { exit(3) }
    FileHandle.standardOutput.write(Data("written\n".utf8))
  }
}
`;
