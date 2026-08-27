import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { CONVERSATION_SOURCE_FAILURE_CATEGORIES } from "../src/constants.js";
import type { DiscordChannelAllowlistStore } from "../src/config/discord-channel-allowlist.js";
import {
  executeConversationCommand,
  type ConversationCommandDependencies
} from "../src/conversation/conversation-command.js";
import {
  type ConversationPrivateHandoff,
  ConversationPrivateHandoffError
} from "../src/conversation/conversation-private-handoff.js";
import {
  ConversationBoundaryError,
  ConversationCheckpointError,
  ConversationDestinationError,
  ConversationObservationError,
  ConversationOrderError,
  ConversationSourceError,
  type ConversationObservationRequest,
  type ConversationSnapshot
} from "../src/conversation/conversation-parser.js";
import { InMemoryWorkflowLock, type WorkflowLock } from "../src/workflow-lock.js";

const SERVER_ID = "123456789012345";
const CHANNEL_ID = "234567890123456";
const CHANNEL_URL = `https://discord.com/channels/${SERVER_ID}/${CHANNEL_ID}`;
const DESTINATION = `discord:${SERVER_ID}:${CHANNEL_ID}`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("executeConversationCommand", () => {
  it("resolves the sole allowlist before writing a normalized private request", async () => {
    const events: string[] = [];
    const handoff = recordingHandoff(events);

    await expect(
      executeConversationCommand(
        "parse-conversation",
        {
          mode: "prepare",
          invocationId: "invocation-001",
          destination: CHANNEL_ID,
          boundary: "discord-message:boundary",
          stopAfterQualifyingMessages: 5
        },
        dependencies(handoff, {
          getAll: async () => {
            events.push("allowlist");
            return [CHANNEL_URL];
          },
          replace: async () => undefined
        })
      )
    ).resolves.toEqual({ action: "observe-conversation" });

    expect(events).toEqual(["allowlist", "write-request"]);
    expect(handoff.request).toEqual({
      destination: DESTINATION,
      boundary: "discord-message:boundary",
      stopAfterQualifyingMessages: 5
    });
  });

  it("fails closed before a handoff write when the destination is not allowlisted", async () => {
    const handoff = recordingHandoff([]);

    await expect(
      executeConversationCommand(
        "parse-conversation",
        {
          mode: "prepare",
          invocationId: "invocation-001",
          destination: "345678901234567",
          stopAfterQualifyingMessages: 5
        },
        dependencies(handoff)
      )
    ).resolves.toEqual({ action: "needs-attention" });
    expect(handoff.request).toBeUndefined();
  });

  it("parses an observation from the stored request and writes only the private snapshot", async () => {
    const handoff = recordingHandoff([]);
    handoff.request = {
      destination: DESTINATION as never,
      boundary: "discord-message:boundary" as never,
      stopAfterQualifyingMessages: 2
    };

    await expect(
      executeConversationCommand(
        "parse-conversation",
        {
          mode: "observe",
          invocationId: "invocation-001",
          observation: {
            destination: DESTINATION,
            boundary: "discord-message:boundary",
            coverage: { kind: "contiguous-after-boundary" },
            messages: [message("first", "Private message one", true), message("second", "Private message two")]
          }
        },
        dependencies(handoff)
      )
    ).resolves.toEqual({
      action: "conversation-complete",
      acceptedMessageCount: 2,
      selectedAttachmentCount: 1
    });

    expect(handoff.snapshot).toMatchObject({
      destination: DESTINATION,
      complete: true,
      messages: [{ text: "Private message one" }, { text: "Private message two" }],
      selectedAttachments: [{ selection: "opaque-selection:first" }]
    });
  });

  it("constructs a matching checkpoint internally and rejects an edited rescan prefix", async () => {
    const handoff = recordingHandoff([]);
    await executeConversationCommand(
      "parse-conversation",
      {
        mode: "prepare",
        invocationId: "invocation-001",
        destination: CHANNEL_URL,
        boundary: "discord-message:boundary",
        stopAfterQualifyingMessages: 3
      },
      dependencies(handoff)
    );
    const firstObservation = {
      destination: DESTINATION,
      boundary: "discord-message:boundary",
      coverage: { kind: "contiguous-after-boundary" },
      messages: [message("first", "First"), message("second", "Second")]
    };
    await expect(
      executeConversationCommand(
        "parse-conversation",
        { mode: "observe", invocationId: "invocation-001", observation: firstObservation },
        dependencies(handoff)
      )
    ).resolves.toMatchObject({ action: "wait", acceptedMessageCount: 2 });

    await expect(
      executeConversationCommand(
        "parse-conversation",
        {
          mode: "observe",
          invocationId: "invocation-001",
          observation: {
            ...firstObservation,
            messages: [message("first", "Edited First"), firstObservation.messages[1], message("third", "Third")]
          }
        },
        dependencies(handoff)
      )
    ).resolves.toEqual({ action: "needs-attention" });
    expect(handoff.snapshot?.messages.map((entry) => entry.text)).toEqual(["First", "Second"]);
  });

  it("rereads the current sole allowlist under lock and rejects a stale prepared destination", async () => {
    const handoff = recordingHandoff([]);
    handoff.request = {
      destination: DESTINATION as never,
      stopAfterQualifyingMessages: 1
    };
    let lockHeld = false;
    let allowlistReadWhileLocked = false;
    const workflowLock: WorkflowLock = {
      async runExclusive(action) {
        lockHeld = true;
        try {
          return await action();
        } finally {
          lockHeld = false;
        }
      }
    };
    const changedChannelUrl = `https://discord.com/channels/${SERVER_ID}/345678901234567`;

    const result = await executeConversationCommand(
      "parse-conversation",
      { mode: "observe", invocationId: "invocation-001", observation: visibleObservation() },
      {
        handoff,
        workflowLock,
        allowlist: {
          async getAll() {
            allowlistReadWhileLocked = lockHeld;
            return [changedChannelUrl];
          },
          replace: async () => undefined
        }
      }
    );

    expect(result).toEqual({ action: "needs-attention" });
    expect(allowlistReadWhileLocked).toBe(true);
    expect(handoff.snapshot).toBeUndefined();
  });

  it("rejects a stored request whose exact destination was tampered before observation", async () => {
    const handoff = recordingHandoff([]);
    const tamperedDestination = `discord:${SERVER_ID}:345678901234567`;
    handoff.request = {
      destination: tamperedDestination as never,
      stopAfterQualifyingMessages: 1
    };

    const result = await executeConversationCommand(
      "parse-conversation",
      {
        mode: "observe",
        invocationId: "invocation-001",
        observation: {
          ...visibleObservation(),
          destination: tamperedDestination
        }
      },
      dependencies(handoff)
    );

    expect(result).toEqual({ action: "needs-attention" });
    expect(handoff.snapshot).toBeUndefined();
  });

  it("rejects caller-selected output paths without writing a snapshot", async () => {
    const handoff = recordingHandoff([]);
    handoff.request = { destination: DESTINATION as never, stopAfterQualifyingMessages: 2 };

    await expect(
      executeConversationCommand(
        "parse-conversation",
        {
          mode: "observe",
          invocationId: "invocation-001",
          outputPath: "/private/caller-selected.json",
          observation: visibleObservation()
        },
        dependencies(handoff)
      )
    ).resolves.toEqual({ action: "needs-attention" });
    expect(handoff.snapshot).toBeUndefined();
  });

  it.each([
    new ConversationDestinationError(),
    new ConversationBoundaryError(),
    new ConversationOrderError(),
    new ConversationCheckpointError(),
    new ConversationObservationError(),
    new ConversationSourceError(),
    new ConversationPrivateHandoffError()
  ])("maps typed private failure $name to a sanitized result", async (privateError) => {
    const privateValue = "private-message-or-identifier";
    const handoff: ConversationPrivateHandoff = {
      writeRequest: async () => undefined,
      readRequest: async () => {
        Object.defineProperty(privateError, "message", { value: privateValue });
        throw privateError;
      },
      writeSnapshot: async () => undefined,
      readSnapshot: async () => undefined
    };

    const result = await executeConversationCommand(
      "parse-conversation",
      { mode: "observe", invocationId: "invocation-001", observation: visibleObservation() },
      dependencies(handoff)
    );

    expect(result).toEqual({ action: "needs-attention" });
    expect(JSON.stringify(result)).not.toContain(privateValue);
  });

  it.each([
    "login-interrupted",
    "virtualization-gap",
    "unstable-identity",
    "ambiguous-order",
    "missing-boundary",
    "destination-mismatch"
  ])(
    "accepts controlled source failure category %s without retrying",
    async (category) => {
      const handoff = recordingHandoff([]);

      await expect(
        executeConversationCommand(
          "parse-conversation",
          { mode: "source-failure", category },
          dependencies(handoff)
        )
      ).resolves.toEqual({ action: "needs-attention" });
      expect(handoff.readRequestCount).toBe(0);
    }
  );

  it("supports controlled failures for a missing boundary and destination mismatch", () => {
    expect(CONVERSATION_SOURCE_FAILURE_CATEGORIES).toEqual(
      expect.arrayContaining(["missing-boundary", "destination-mismatch"])
    );
  });

  it("rejects raw source failure reasons", async () => {
    const privateReason = "login failed at a private destination";
    const result = await executeConversationCommand(
      "parse-conversation",
      { mode: "source-failure", category: "login-interrupted", reason: privateReason },
      dependencies(recordingHandoff([]))
    );

    expect(result).toEqual({ action: "needs-attention" });
    expect(JSON.stringify(result)).not.toContain(privateReason);
  });
});

describe("parse-conversation executable", () => {
  it("keeps preparation stdout and stderr free of private request values", async () => {
    const workspace = await executableWorkspace();
    const privateBoundary = "discord-message:private-boundary";
    const result = await runExecutable(workspace, {
      mode: "prepare",
      invocationId: "invocation-001",
      destination: CHANNEL_URL,
      boundary: privateBoundary,
      stopAfterQualifyingMessages: 2
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({ action: "observe-conversation" });
    expect(result.stdout).not.toContain(privateBoundary);
    expect(result.stdout).not.toContain(CHANNEL_ID);
  });

  it("keeps observation stdout and stderr free of private observation values", async () => {
    const workspace = await executableWorkspace();
    await runExecutable(workspace, {
      mode: "prepare",
      invocationId: "invocation-001",
      destination: CHANNEL_URL,
      stopAfterQualifyingMessages: 1
    });
    const privateText = "Private subprocess message";
    const result = await runExecutable(workspace, {
      mode: "observe",
      invocationId: "invocation-001",
      observation: {
        destination: DESTINATION,
        coverage: { kind: "contiguous-visible-segment", segmentStart: "discord-message:first" },
        messages: [message("first", privateText)]
      }
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      action: "conversation-complete",
      acceptedMessageCount: 1,
      selectedAttachmentCount: 0
    });
    expect(result.stdout).not.toContain(privateText);
    expect(result.stderr).not.toContain(privateText);
    const snapshot = await readFile(
      join(workspace, ".runtime", "conversation-handoffs", "invocation-001.snapshot.json"),
      "utf8"
    );
    expect(snapshot).toContain(privateText);
  });

  it("keeps source failures to the controlled needs-attention contract", async () => {
    const workspace = await executableWorkspace();
    const privateReason = "private source adapter details";
    const result = await runExecutable(workspace, {
      mode: "source-failure",
      category: "login-interrupted",
      reason: privateReason
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({ action: "needs-attention" });
    expect(result.stdout).not.toContain(privateReason);
  });

  it("keeps malformed private round-adapter input out of stdout and stderr", async () => {
    const workspace = await executableWorkspace();
    const privateSelection = "private-selection-token";
    const result = await runRawExecutable(
      workspace,
      "collect-conversation-snapshot",
      `{"roundId":"R001","acquiredAttachments":[{"selection":"${privateSelection}"}`
    );

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({ action: "needs-attention" });
    expect(result.stdout).not.toContain(privateSelection);
  });
});

interface RecordingHandoff extends ConversationPrivateHandoff {
  request?: ConversationObservationRequest;
  snapshot?: ConversationSnapshot;
  readRequestCount: number;
}

function recordingHandoff(events: string[]): RecordingHandoff {
  return {
    readRequestCount: 0,
    async writeRequest(_invocationId, request) {
      events.push("write-request");
      this.request = request;
    },
    async readRequest() {
      this.readRequestCount += 1;
      return this.request;
    },
    async writeSnapshot(_invocationId, snapshot) {
      this.snapshot = snapshot;
    },
    async readSnapshot() {
      return this.snapshot;
    }
  };
}

function dependencies(
  handoff: ConversationPrivateHandoff,
  allowlist: DiscordChannelAllowlistStore = {
    getAll: async () => [CHANNEL_URL],
    replace: async () => undefined
  }
): ConversationCommandDependencies {
  return { allowlist, handoff, workflowLock: new InMemoryWorkflowLock() };
}

function message(identity: string, text: string, attachment = false) {
  return {
    identity: `discord-message:${identity}`,
    kind: "ordinary-text",
    text,
    author: { id: `author-${identity}`, name: `Author ${identity}` },
    timestamp: "2026-08-26T10:00:00.000Z",
    attachments: attachment
      ? [{ index: 0, mediaType: "image/png", selection: `opaque-selection:${identity}` }]
      : []
  };
}

function visibleObservation() {
  return {
    destination: DESTINATION,
    coverage: { kind: "contiguous-visible-segment", segmentStart: "discord-message:first" },
    messages: [message("first", "Private message")]
  };
}

async function executableWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "conversation-command-"));
  temporaryDirectories.push(workspace);
  await mkdir(join(workspace, ".state"), { recursive: true });
  await writeFile(
    join(workspace, ".state", "discord-channel-allowlist.json"),
    `${JSON.stringify({ schemaVersion: 1, channelUrls: [CHANNEL_URL] })}\n`,
    { mode: 0o600 }
  );
  return workspace;
}

async function runExecutable(workspace: string, payload: unknown) {
  return runRawExecutable(workspace, "parse-conversation", JSON.stringify(payload));
}

async function runRawExecutable(workspace: string, command: string, payload: string) {
  const entrypoint = resolve("src/cli.ts");
  const tsx = resolve("node_modules/tsx/dist/cli.mjs");
  const child = spawn(process.execPath, [tsx, entrypoint, command], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end(payload);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolveExit) => child.on("close", resolveExit));
  return { code, stdout, stderr };
}
