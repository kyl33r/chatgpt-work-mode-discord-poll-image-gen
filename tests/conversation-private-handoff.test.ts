import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CONVERSATION_HANDOFF_ROOT, RUNTIME_ROOT } from "../src/constants.js";
import { resolveDiscordConversationDestination } from "../src/conversation/discord-conversation-destination.js";
import {
  type ConversationPrivateHandoff,
  ConversationPrivateHandoffError,
  JsonConversationPrivateHandoff
} from "../src/conversation/conversation-private-handoff.js";
import {
  type ConversationObservationRequest,
  type ConversationSnapshot,
  type StableMessageIdentity
} from "../src/conversation/conversation-parser.js";

const temporaryDirectories: string[] = [];
const SERVER_ID = "123456789012345";
const CHANNEL_ID = "234567890123456";
const CHANNEL_URL = `https://discord.com/channels/${SERVER_ID}/${CHANNEL_ID}`;
const destination = resolveDiscordConversationDestination(CHANNEL_URL, [CHANNEL_URL]);
const messageIdentity = (value: string): StableMessageIdentity => value as StableMessageIdentity;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("JsonConversationPrivateHandoff", () => {
  it("binds production construction to the fixed runtime root", () => {
    const handoff: ConversationPrivateHandoff = new JsonConversationPrivateHandoff();

    expect(handoff).toBeInstanceOf(JsonConversationPrivateHandoff);
    expect(JsonConversationPrivateHandoff.length).toBe(0);
  });

  it("round-trips separate private request and snapshot records with controlled write results", async () => {
    const workspaceRoot = await temporaryDirectory();
    const handoff = testHandoff(workspaceRoot);
    const boundary = messageIdentity("discord-message:boundary");
    const request: ConversationObservationRequest = {
      destination,
      boundary,
      stopAfterQualifyingMessages: 5
    };
    const snapshot: ConversationSnapshot = {
      destination,
      boundary,
      complete: false,
      messages: [
        {
          identity: messageIdentity("discord-message:first"),
          kind: "ordinary-text",
          text: "Synthetic private message",
          author: { id: "participant-one", name: "Participant One" },
          timestamp: "2026-08-26T10:00:00.000Z"
        }
      ],
      selectedAttachments: [
        {
          owner: messageIdentity("discord-message:first"),
          index: 0,
          mediaType: "image/png",
          selection: "opaque-selection:first" as never
        }
      ]
    };

    await expect(handoff.writeRequest("invocation-001", request)).resolves.toBeUndefined();
    await expect(handoff.writeSnapshot("invocation-001", snapshot)).resolves.toBeUndefined();

    const reloaded = testHandoff(workspaceRoot);
    await expect(reloaded.readRequest("invocation-001")).resolves.toEqual(request);
    await expect(reloaded.readSnapshot("invocation-001")).resolves.toEqual(snapshot);
  });

  it.each(["", ".", "..", "../outside", "nested/id", "/absolute", "%2e%2e", "invocation id"])(
    "rejects malformed or traversal invocation ID %j without echoing it",
    async (invocationId) => {
      const handoff = testHandoff(await temporaryDirectory());
      const privateValue = `${invocationId}-private`;

      try {
        await handoff.writeRequest(invocationId, {
          destination,
          stopAfterQualifyingMessages: 1
        });
        throw new Error("Expected the invocation ID to be rejected.");
      } catch (error) {
        expect(error).toBeInstanceOf(ConversationPrivateHandoffError);
        expect(String(error)).not.toContain(privateValue);
        if (invocationId.length > 3) {
          expect(String(error)).not.toContain(invocationId);
        }
      }
    }
  );

  it.each([null, 123, {}, [], "a".repeat(65)])(
    "rejects non-string or overlong invocation IDs",
    async (invocationId) => {
      const handoff = testHandoff(await temporaryDirectory());

      await expect(
        handoff.readRequest(invocationId as never)
      ).rejects.toBeInstanceOf(ConversationPrivateHandoffError);
    }
  );

  it("rejects a symlinked handoff root without exposing its destination", async () => {
    const workspaceRoot = await temporaryDirectory();
    const privateOutsideRoot = join(workspaceRoot, "private-outside-root");
    const runtimeRoot = join(workspaceRoot, RUNTIME_ROOT);
    const handoffRoot = privateHandoffRoot(workspaceRoot);
    await mkdir(privateOutsideRoot);
    await mkdir(runtimeRoot, { mode: 0o700 });
    await symlink(privateOutsideRoot, handoffRoot);

    await expect(
      testHandoff(workspaceRoot).writeRequest("invocation-001", {
        destination,
        stopAfterQualifyingMessages: 1
      })
    ).rejects.toMatchObject({
      name: "ConversationPrivateHandoffError",
      message: "Private conversation handoff is invalid."
    });
  });

  it("rejects a symlinked ancestor before creating the fixed handoff root", async () => {
    const workspaceRoot = await temporaryDirectory();
    const privateOutsideRoot = join(workspaceRoot, "private-outside-runtime");
    const runtimeAlias = join(workspaceRoot, RUNTIME_ROOT);
    await mkdir(privateOutsideRoot);
    await symlink(privateOutsideRoot, runtimeAlias);

    await expect(
      testHandoff(workspaceRoot).writeRequest(
        "invocation-001",
        { destination, stopAfterQualifyingMessages: 1 }
      )
    ).rejects.toBeInstanceOf(ConversationPrivateHandoffError);
    await expect(readdir(privateOutsideRoot)).resolves.toEqual([]);
  });

  it("rejects a handoff record symlink without modifying its outside target", async () => {
    const workspaceRoot = await temporaryDirectory();
    const handoffRoot = await preparePrivateHandoffRoot(workspaceRoot);
    const privateOutsidePath = join(handoffRoot, "private-outside.json");
    const requestPath = join(handoffRoot, "invocation-001.request.json");
    await writeFile(privateOutsidePath, "outside content", "utf8");
    await symlink(privateOutsidePath, requestPath);

    await expect(
      testHandoff(workspaceRoot).writeRequest("invocation-001", {
        destination,
        stopAfterQualifyingMessages: 1
      })
    ).rejects.toBeInstanceOf(ConversationPrivateHandoffError);
    await expect(readFile(privateOutsidePath, "utf8")).resolves.toBe("outside content");
  });

  it("opens persisted records without following a final symlink", async () => {
    const workspaceRoot = await temporaryDirectory();
    const handoffRoot = await preparePrivateHandoffRoot(workspaceRoot);
    const privateOutsidePath = join(workspaceRoot, "private-outside-record.json");
    await writeFile(
      privateOutsidePath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "request",
        request: { destination, stopAfterQualifyingMessages: 1 }
      })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await symlink(privateOutsidePath, join(handoffRoot, "invocation-001.request.json"));

    await expect(
      testHandoff(workspaceRoot).readRequest("invocation-001")
    ).rejects.toBeInstanceOf(ConversationPrivateHandoffError);
  });

  it("rejects an outside-root hard-link alias", async () => {
    const workspaceRoot = await temporaryDirectory();
    const handoffRoot = await preparePrivateHandoffRoot(workspaceRoot);
    const privateOutsidePath = join(workspaceRoot, "private-outside.json");
    await writeFile(privateOutsidePath, "outside content", "utf8");
    await link(privateOutsidePath, join(handoffRoot, "invocation-001.request.json"));

    await expect(
      testHandoff(workspaceRoot).readRequest("invocation-001")
    ).rejects.toBeInstanceOf(ConversationPrivateHandoffError);
  });

  it("rejects a non-regular handoff record", async () => {
    const workspaceRoot = await temporaryDirectory();
    const handoffRoot = await preparePrivateHandoffRoot(workspaceRoot);
    await mkdir(join(handoffRoot, "invocation-001.snapshot.json"));

    await expect(
      testHandoff(workspaceRoot).readSnapshot("invocation-001")
    ).rejects.toBeInstanceOf(ConversationPrivateHandoffError);
  });

  it("returns a controlled error for malformed request JSON without exposing path or content", async () => {
    const workspaceRoot = await temporaryDirectory();
    const handoffRoot = await preparePrivateHandoffRoot(workspaceRoot);
    const privateContents = "private malformed record";
    const requestPath = join(handoffRoot, "invocation-001.request.json");
    await writeFile(requestPath, privateContents, { encoding: "utf8", mode: 0o600 });

    try {
      await testHandoff(workspaceRoot).readRequest("invocation-001");
      throw new Error("Expected malformed JSON to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(ConversationPrivateHandoffError);
      expect(String(error)).not.toContain(privateContents);
      expect(String(error)).not.toContain(requestPath);
    }
  });

  it.each([
    {
      schemaVersion: 1,
      kind: "request",
      request: { destination, stopAfterQualifyingMessages: 1 },
      unexpected: "private-wrapper-value"
    },
    {
      schemaVersion: 1,
      kind: "request",
      request: {
        destination,
        stopAfterQualifyingMessages: 1,
        unexpected: "private-request-value"
      }
    }
  ])("rejects extra keys in private request records", async (record) => {
    const workspaceRoot = await temporaryDirectory();
    const handoffRoot = await preparePrivateHandoffRoot(workspaceRoot);
    await writeFile(
      join(handoffRoot, "invocation-001.request.json"),
      `${JSON.stringify(record)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );

    await expect(
      testHandoff(workspaceRoot).readRequest("invocation-001")
    ).rejects.toBeInstanceOf(ConversationPrivateHandoffError);
  });

  it.each([
    { destination: "", stopAfterQualifyingMessages: 1 },
    { destination, boundary: "", stopAfterQualifyingMessages: 1 },
    { destination, boundary: undefined, stopAfterQualifyingMessages: 1 },
    { destination, stopAfterQualifyingMessages: 0 },
    { destination, stopAfterQualifyingMessages: 1, unexpected: "private-request-value" }
  ])("rejects malformed request values before writing", async (request) => {
    const handoff = testHandoff(await temporaryDirectory());

    await expect(
      handoff.writeRequest("invocation-001", request as never)
    ).rejects.toBeInstanceOf(ConversationPrivateHandoffError);
    await expect(handoff.readRequest("invocation-001")).resolves.toBeUndefined();
  });

  it("rejects inherited request fields and prototype toJSON before writing", async () => {
    const handoff = testHandoff(await temporaryDirectory());
    const request = Object.create({
      destination,
      toJSON: () => ({ destination, stopAfterQualifyingMessages: 99 })
    }) as Record<string, unknown>;
    Object.defineProperty(request, "stopAfterQualifyingMessages", {
      value: 1,
      enumerable: true
    });

    await expect(
      handoff.writeRequest("invocation-001", request as never)
    ).rejects.toBeInstanceOf(ConversationPrivateHandoffError);
    await expect(handoff.readRequest("invocation-001")).resolves.toBeUndefined();
  });

  it("rejects custom prototypes recursively inside snapshot payloads", async () => {
    const handoff = testHandoff(await temporaryDirectory());
    const snapshot = validSnapshot();
    const message = Object.create({
      ...snapshot.messages[0],
      toJSON: () => ({ ...snapshot.messages[0], text: "Changed by prototype serialization" })
    });

    await expect(
      handoff.writeSnapshot("invocation-001", {
        ...snapshot,
        messages: [message]
      })
    ).rejects.toBeInstanceOf(ConversationPrivateHandoffError);
    await expect(handoff.readSnapshot("invocation-001")).resolves.toBeUndefined();
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "   \n"],
    ["URL-like", "https://example.invalid/private-selection"],
    ["absolute-path-like", "/private/local/selection"],
    ["relative-path-like", "../private-selection"],
    ["browser-handle-like", "browser-handle:element-42"]
  ])("rejects a %s selection before writing a private snapshot", async (_description, selection) => {
    const handoff = testHandoff(await temporaryDirectory());
    const snapshot = validSnapshot();

    await expect(
      handoff.writeSnapshot("invocation-001", {
        ...snapshot,
        selectedAttachments: [
          { ...snapshot.selectedAttachments[0]!, selection: selection as never }
        ]
      })
    ).rejects.toBeInstanceOf(ConversationPrivateHandoffError);
    await expect(handoff.readSnapshot("invocation-001")).resolves.toBeUndefined();
  });

  it.each([
    { ...validSnapshot(), unexpected: "private-snapshot-value" },
    {
      ...validSnapshot(),
      messages: [{ ...validSnapshot().messages[0], unexpected: "private-message-value" }]
    },
    {
      ...validSnapshot(),
      selectedAttachments: [
        { ...validSnapshot().selectedAttachments[0], owner: messageIdentity("discord-message:unknown") }
      ]
    },
    { ...validSnapshot(), boundary: undefined },
    { ...validSnapshot(), complete: "false" }
  ])("rejects malformed snapshot values before writing", async (snapshot) => {
    const handoff = testHandoff(await temporaryDirectory());

    await expect(
      handoff.writeSnapshot("invocation-001", snapshot as never)
    ).rejects.toBeInstanceOf(ConversationPrivateHandoffError);
    await expect(handoff.readSnapshot("invocation-001")).resolves.toBeUndefined();
  });

  it("atomically replaces private records with restrictive permissions and no temporary residue", async () => {
    const workspaceRoot = await temporaryDirectory();
    const handoffRoot = privateHandoffRoot(workspaceRoot);
    const handoff = testHandoff(workspaceRoot);
    const requestPath = join(handoffRoot, "invocation-001.request.json");
    await handoff.writeRequest("invocation-001", {
      destination,
      stopAfterQualifyingMessages: 1
    });
    const original = await stat(requestPath);
    await chmod(handoffRoot, 0o755);
    await chmod(requestPath, 0o644);

    await handoff.writeRequest("invocation-001", {
      destination,
      boundary: messageIdentity("discord-message:replacement-boundary"),
      stopAfterQualifyingMessages: 2
    });

    const replacement = await stat(requestPath);
    expect(replacement.ino).not.toBe(original.ino);
    expect(replacement.mode & 0o777).toBe(0o600);
    expect((await stat(handoffRoot)).mode & 0o777).toBe(0o700);
    expect(await readdir(handoffRoot)).toEqual(["invocation-001.request.json"]);
  });

  it("rejects a persisted record whose permissions are no longer private", async () => {
    const workspaceRoot = await temporaryDirectory();
    const handoffRoot = privateHandoffRoot(workspaceRoot);
    const handoff = testHandoff(workspaceRoot);
    await handoff.writeRequest("invocation-001", {
      destination,
      stopAfterQualifyingMessages: 1
    });
    await chmod(join(handoffRoot, "invocation-001.request.json"), 0o644);

    await expect(handoff.readRequest("invocation-001")).rejects.toBeInstanceOf(
      ConversationPrivateHandoffError
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "conversation-handoff-"));
  temporaryDirectories.push(directory);
  return directory;
}

function testHandoff(workspaceRoot: string): ConversationPrivateHandoff {
  const originalWorkingDirectory = process.cwd();
  try {
    process.chdir(workspaceRoot);
    return new JsonConversationPrivateHandoff();
  } finally {
    process.chdir(originalWorkingDirectory);
  }
}

function privateHandoffRoot(workspaceRoot: string): string {
  return join(workspaceRoot, CONVERSATION_HANDOFF_ROOT);
}

async function preparePrivateHandoffRoot(workspaceRoot: string): Promise<string> {
  const runtimeRoot = join(workspaceRoot, RUNTIME_ROOT);
  const handoffRoot = privateHandoffRoot(workspaceRoot);
  await mkdir(runtimeRoot, { mode: 0o700 });
  await mkdir(handoffRoot, { mode: 0o700 });
  return handoffRoot;
}

function validSnapshot(): ConversationSnapshot {
  return {
    destination,
    boundary: messageIdentity("discord-message:boundary"),
    complete: false,
    messages: [
      {
        identity: messageIdentity("discord-message:first"),
        kind: "ordinary-text",
        text: "Synthetic private message",
        author: { id: "participant-one", name: "Participant One" },
        timestamp: "2026-08-26T10:00:00.000Z"
      }
    ],
    selectedAttachments: [
      {
        owner: messageIdentity("discord-message:first"),
        index: 0,
        mediaType: "image/png",
        selection: "opaque-selection:first" as never
      }
    ]
  };
}
