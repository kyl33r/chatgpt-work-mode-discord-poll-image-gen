import { describe, expect, it } from "vitest";

import { resolveDiscordConversationDestination } from "../src/conversation/discord-conversation-destination.js";
import {
  type ConversationObservationRequest,
  type ConversationObservation,
  type ConversationSource,
  type StableMessageIdentity,
  parseConversation
} from "../src/conversation/conversation-parser.js";

const SERVER_ID = "123456789012345";
const CHANNEL_ID = "234567890123456";
const CHANNEL_URL = `https://discord.com/channels/${SERVER_ID}/${CHANNEL_ID}`;
const destination = resolveDiscordConversationDestination(CHANNEL_URL, [CHANNEL_URL]);
const messageIdentity = (value: string): StableMessageIdentity => value as StableMessageIdentity;

describe("parseConversation", () => {
  it("parses a boundary-relative qualifying prefix", async () => {
    const boundary = messageIdentity("discord-message:boundary");
    const source: ConversationSource = {
      async observe(request: ConversationObservationRequest) {
        return {
          destination: request.destination,
          ...(request.boundary === undefined ? {} : { boundary: request.boundary }),
          coverage: { kind: "contiguous-after-boundary" },
          messages: [
            {
              identity: boundary,
              kind: "ordinary-text",
              text: "Excluded boundary text",
              author: { id: "participant-one", name: "Participant One" },
              timestamp: "2026-08-26T10:00:00.000Z",
              attachments: []
            },
            {
              identity: messageIdentity("discord-message:first"),
              kind: "ordinary-text",
              text: "Keep this exact first message.",
              author: { id: "participant-one", name: "Participant One" },
              timestamp: "2026-08-26T09:59:00.000Z",
              attachments: []
            },
            {
              identity: messageIdentity("discord-message:second"),
              kind: "ordinary-text",
              text: "Keep this exact second message.",
              author: { id: "participant-two", name: "Participant Two" },
              timestamp: "2026-08-26T09:58:00.000Z",
              attachments: []
            }
          ]
        };
      }
    };

    const observation = await source.observe({
      destination,
      boundary,
      stopAfterQualifyingMessages: 3
    });

    const snapshot = parseConversation({
      destination,
      boundary,
      messageLimit: 3,
      attachmentLimitPerMessage: 2,
      attachmentLimitTotal: 5,
      supportedAttachmentMediaTypes: ["image/png"],
      observation
    });

    expect(snapshot).toMatchObject({
      destination,
      boundary,
      complete: false,
      messages: [
        { identity: messageIdentity("discord-message:first"), text: "Keep this exact first message." },
        { identity: messageIdentity("discord-message:second"), text: "Keep this exact second message." }
      ]
    });
  });

  it("accepts ordinary non-empty text", () => {
    const snapshot = parseMessages([
      message("ordinary-text", "A visible ordinary message", "discord-message:ordinary")
    ]);

    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]?.text).toBe("A visible ordinary message");
  });

  it("does not qualify empty ordinary text", () => {
    const snapshot = parseMessages([
      message("ordinary-text", " \n ", "discord-message:empty"),
      message("ordinary-text", "A later ordinary message", "discord-message:later")
    ]);

    expect(snapshot.messages.map((item) => item.identity)).toEqual([
      messageIdentity("discord-message:later")
    ]);
  });

  it("does not qualify system messages", () => {
    const snapshot = parseMessages([
      message("system", "A system event", "discord-message:system"),
      message("ordinary-text", "An ordinary message", "discord-message:ordinary")
    ]);

    expect(snapshot.messages.map((item) => item.identity)).toEqual([
      messageIdentity("discord-message:ordinary")
    ]);
  });

  it("does not qualify attachment-only messages", () => {
    const snapshot = parseMessages([
      message("attachment-only", "", "discord-message:attachment-only"),
      message("ordinary-text", "An ordinary message", "discord-message:ordinary")
    ]);

    expect(snapshot.messages.map((item) => item.identity)).toEqual([
      messageIdentity("discord-message:ordinary")
    ]);
  });

  it("counts repeated authors as separate qualifying messages", () => {
    const snapshot = parseMessages(
      [
        message("ordinary-text", "First message", "discord-message:first", "same-author"),
        message("ordinary-text", "Second message", "discord-message:second", "same-author")
      ],
      { messageLimit: 2 }
    );

    expect(snapshot).toMatchObject({
      complete: true,
      messages: [{ text: "First message" }, { text: "Second message" }]
    });
  });

  it("stops at the configurable message limit and ignores later qualifying messages", () => {
    const snapshot = parseMessages(
      [
        message("ordinary-text", "First", "discord-message:first"),
        message("ordinary-text", "Second", "discord-message:second"),
        message("ordinary-text", "Ignored later message", "discord-message:third")
      ],
      { messageLimit: 2 }
    );

    expect(snapshot.messages.map((item) => item.text)).toEqual(["First", "Second"]);
  });

  it("freezes the first five qualifying messages in provider order without timestamp sorting", () => {
    const snapshot = parseMessages(
      [
        message("ordinary-text", "Provider first", "discord-message:one", "author-one", "2026-08-26T05:00:00.000Z"),
        message("ordinary-text", "Provider second", "discord-message:two", "author-two", "2026-08-26T04:00:00.000Z"),
        message("ordinary-text", "Provider third", "discord-message:three", "author-three", "2026-08-26T03:00:00.000Z"),
        message("ordinary-text", "Provider fourth", "discord-message:four", "author-four", "2026-08-26T02:00:00.000Z"),
        message("ordinary-text", "Provider fifth", "discord-message:five", "author-five", "2026-08-26T01:00:00.000Z"),
        message("ordinary-text", "Ignored later provider message", "discord-message:six", "author-six", "2026-08-26T06:00:00.000Z")
      ],
      { messageLimit: 5 }
    );

    expect(snapshot).toMatchObject({
      complete: true,
      messages: [
        { text: "Provider first" },
        { text: "Provider second" },
        { text: "Provider third" },
        { text: "Provider fourth" },
        { text: "Provider fifth" }
      ]
    });
  });

  it.each([
    ["message limit is zero", { messageLimit: 0 }],
    ["message limit is fractional", { messageLimit: 1.5 }],
    ["per-message attachment limit is negative", { attachmentLimitPerMessage: -1 }],
    ["total attachment limit is fractional", { attachmentLimitTotal: 0.5 }],
    ["supported media policy is empty", { supportedAttachmentMediaTypes: [] }]
  ])("rejects invalid parser policy when %s", (_description, overrides) => {
    const privateInputValue = JSON.stringify(overrides);

    expectControlledObservationError(
      () => parseMessages([message("ordinary-text", "Visible text", "discord-message:ordinary")], overrides),
      privateInputValue
    );
  });

  it("returns a controlled error for a malformed supported media policy", () => {
    const privateInputValue = "private-media-policy";

    expectControlledObservationError(
      () =>
        parseMessages([message("ordinary-text", "Visible text", "discord-message:ordinary")], {
          supportedAttachmentMediaTypes: privateInputValue as never
        }),
      privateInputValue
    );
  });
});

function parseMessages(
  messages: readonly ConversationObservation[],
  overrides: Partial<{
    readonly messageLimit: number;
    readonly attachmentLimitPerMessage: number;
    readonly attachmentLimitTotal: number;
    readonly supportedAttachmentMediaTypes: readonly string[];
  }> = {}
) {
  const boundary = messageIdentity("discord-message:boundary");
  return parseConversation({
    destination,
    boundary,
    messageLimit: overrides.messageLimit ?? 3,
    attachmentLimitPerMessage: overrides.attachmentLimitPerMessage ?? 2,
    attachmentLimitTotal: overrides.attachmentLimitTotal ?? 5,
    supportedAttachmentMediaTypes: overrides.supportedAttachmentMediaTypes ?? ["image/png"],
    observation: {
      destination,
      boundary,
      coverage: { kind: "contiguous-after-boundary" },
      messages
    }
  });
}

function message(
  kind: ConversationObservation["kind"],
  text: string,
  identity: string,
  authorId = "participant",
  timestamp = "2026-08-26T10:00:00.000Z"
): ConversationObservation {
  return {
    identity: messageIdentity(identity),
    kind,
    text,
    author: { id: authorId, name: "Participant" },
    timestamp,
    attachments: []
  };
}

function expectControlledObservationError(action: () => unknown, privateInputValue: string): void {
  try {
    action();
    throw new Error("Expected an observation error.");
  } catch (error) {
    expect(error).toMatchObject({ name: "ConversationObservationError" });
    expect((error as Error).message).not.toContain(privateInputValue);
  }
}
