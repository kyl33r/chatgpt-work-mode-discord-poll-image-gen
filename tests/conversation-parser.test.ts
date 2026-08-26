import { describe, expect, it } from "vitest";

import {
  ConversationDestinationError,
  resolveDiscordConversationDestination
} from "../src/conversation/discord-conversation-destination.js";
import {
  type ConversationObservationRequest,
  type ConversationObservation,
  type ConversationSource,
  type StableMessageIdentity,
  ConversationSourceError,
  parseConversation
} from "../src/conversation/conversation-parser.js";

const SERVER_ID = "123456789012345";
const CHANNEL_ID = "234567890123456";
const CHANNEL_URL = `https://discord.com/channels/${SERVER_ID}/${CHANNEL_ID}`;
const destination = resolveDiscordConversationDestination(CHANNEL_URL, [CHANNEL_URL]);
const messageIdentity = (value: string): StableMessageIdentity => value as StableMessageIdentity;

describe("parseConversation", () => {
  it("rejects boundary observations without contiguous boundary-relative coverage", () => {
    const request = validParseRequest();

    expectControlledParserError(
      () => parseConversation({
        ...request,
        observation: {
          ...request.observation,
          coverage: { kind: "contiguous-visible-segment", segmentStart: messageIdentity("discord-message:private-start") }
        }
      } as never),
      "discord-message:private-start",
      "ConversationBoundaryError"
    );
  });

  it("retains the established visible segment start for a no-boundary snapshot", () => {
    const segmentStart = messageIdentity("discord-message:segment-start");

    const snapshot = parseConversation({
      destination,
      messageLimit: 2,
      attachmentLimitPerMessage: 2,
      attachmentLimitTotal: 5,
      supportedAttachmentMediaTypes: ["image/png"],
      observation: {
        destination,
        coverage: { kind: "contiguous-visible-segment", segmentStart },
        messages: [
          message("ordinary-text", "First visible message", "discord-message:segment-start"),
          message("ordinary-text", "Second visible message", "discord-message:second")
        ]
      }
    });

    expect(snapshot).toMatchObject({
      destination,
      segmentStart,
      complete: true,
      messages: [{ text: "First visible message" }, { text: "Second visible message" }]
    });
  });

  it("rejects a no-boundary segment whose claimed start is not the first visible identity", () => {
    const privateSegmentStart = "discord-message:private-earlier-start";

    expectControlledParserError(
      () =>
        parseConversation({
          destination,
          messageLimit: 1,
          attachmentLimitPerMessage: 2,
          attachmentLimitTotal: 5,
          supportedAttachmentMediaTypes: ["image/png"],
          observation: {
            destination,
            coverage: {
              kind: "contiguous-visible-segment",
              segmentStart: messageIdentity(privateSegmentStart)
            },
            messages: [message("ordinary-text", "Visible text", "discord-message:actual-first")]
          }
        }),
      privateSegmentStart,
      "ConversationBoundaryError"
    );
  });

  it("rejects an observation from a different destination", () => {
    const request = validParseRequest();
    const otherDestination = resolveDiscordConversationDestination(
      "https://discord.com/channels/123456789012345/345678901234567",
      ["https://discord.com/channels/123456789012345/345678901234567"]
    );

    expect(() =>
      parseConversation({
        ...request,
        observation: { ...request.observation, destination: otherDestination }
      })
    ).toThrow(ConversationDestinationError);
  });

  it("rejects an observation with a mismatched boundary", () => {
    const request = validParseRequest();

    expectControlledParserError(
      () =>
        parseConversation({
          ...request,
          observation: { ...request.observation, boundary: messageIdentity("discord-message:private-mismatch") }
        }),
      "discord-message:private-mismatch",
      "ConversationBoundaryError"
    );
  });

  it("rejects empty boundary identities supplied by both the request and observation batch", () => {
    const request = validParseRequest();

    expectControlledParserError(
      () =>
        parseConversation({
          ...request,
          boundary: messageIdentity(""),
          observation: { ...request.observation, boundary: messageIdentity("") }
        }),
      "private-empty-boundary",
      "ConversationBoundaryError"
    );
  });

  it("rejects duplicate message identities without accepting an ambiguous prefix", () => {
    const privateIdentity = "discord-message:private-duplicate";

    expectControlledParserError(
      () =>
        parseMessages([
          message("ordinary-text", "First visible message", privateIdentity),
          message("ordinary-text", "Conflicting visible message", privateIdentity)
        ]),
      privateIdentity,
      "ConversationOrderError"
    );
  });

  it("rejects an empty stable message identity as an ordering ambiguity", () => {
    const request = validParseRequest();

    expectControlledParserError(
      () =>
        parseConversation({
          ...request,
          observation: {
            ...request.observation,
            messages: [message("ordinary-text", "Visible text", "")]
          }
        }),
      "private-empty-identity",
      "ConversationOrderError"
    );
  });

  it("rejects an observation with a missing stable message identity", () => {
    const request = validParseRequest();
    const privateText = "private-message-without-identity";

    expectControlledObservationError(
      () =>
        parseConversation({
          ...request,
          observation: {
            ...request.observation,
            messages: [
              {
                kind: "ordinary-text",
                text: privateText,
                author: { id: "participant", name: "Participant" },
                timestamp: "2026-08-26T10:00:00.000Z",
                attachments: []
              }
            ]
          }
        } as never),
      privateText
    );
  });

  it("rejects a boundary batch that omits contiguous coverage proof", () => {
    const request = validParseRequest();

    expectControlledParserError(
      () =>
        parseConversation({
          ...request,
          observation: { ...request.observation, coverage: { privateGap: "virtualized" } }
        } as never),
      "virtualized",
      "ConversationBoundaryError"
    );
  });

  it("represents source uncertainty as a controlled source error", async () => {
    const source: ConversationSource = {
      async observe() {
        throw new ConversationSourceError();
      }
    };

    await expect(
      source.observe({ destination, stopAfterQualifyingMessages: 1 })
    ).rejects.toMatchObject({ name: "ConversationSourceError" });
  });

  it("validates visible timestamp metadata without reordering provider messages", () => {
    const privateTimestamp = "private-not-a-visible-timestamp";
    const request = validParseRequest();

    expectControlledObservationError(
      () =>
        parseConversation({
          ...request,
          observation: {
            ...request.observation,
            messages: [
              { ...message("ordinary-text", "Visible text", "discord-message:ordinary"), timestamp: privateTimestamp }
            ]
          }
        }),
      privateTimestamp
    );
  });

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

  it("selects supported attachments in message and displayed order within configured limits", () => {
    const snapshot = parseMessages(
      [
        message("ordinary-text", "First", "discord-message:first", "participant", undefined, [
          attachment(0, "image/png", "selection:first-png"),
          attachment(1, "application/pdf", "selection:first-pdf"),
          attachment(2, "image/jpeg", "selection:first-jpeg"),
          attachment(3, "image/webp", "selection:first-webp")
        ]),
        message("ordinary-text", "Second", "discord-message:second", "participant", undefined, [
          attachment(0, "image/jpeg", "selection:second-jpeg"),
          attachment(1, "image/png", "selection:second-png"),
          attachment(2, "image/png", "selection:second-excess")
        ]),
        message("ordinary-text", "Third", "discord-message:third", "participant", undefined, [
          attachment(0, "image/png", "selection:third-png"),
          attachment(1, "image/png", "selection:third-excess")
        ])
      ],
      {
        messageLimit: 3,
        attachmentLimitPerMessage: 2,
        attachmentLimitTotal: 5,
        supportedAttachmentMediaTypes: ["image/png", "image/jpeg", "image/webp"]
      }
    );

    expect(snapshot.selectedAttachments).toEqual([
      { owner: messageIdentity("discord-message:first"), index: 0, mediaType: "image/png", selection: "selection:first-png" },
      { owner: messageIdentity("discord-message:first"), index: 2, mediaType: "image/jpeg", selection: "selection:first-jpeg" },
      { owner: messageIdentity("discord-message:second"), index: 0, mediaType: "image/jpeg", selection: "selection:second-jpeg" },
      { owner: messageIdentity("discord-message:second"), index: 1, mediaType: "image/png", selection: "selection:second-png" },
      { owner: messageIdentity("discord-message:third"), index: 0, mediaType: "image/png", selection: "selection:third-png" }
    ]);
  });

  it("never selects attachments from non-qualifying, boundary, or later messages", () => {
    const snapshot = parseMessages(
      [
        message("ordinary-text", "Boundary", "discord-message:boundary", "participant", undefined, [
          attachment(0, "image/png", "selection:boundary")
        ]),
        message("system", "System event", "discord-message:system", "participant", undefined, [
          attachment(0, "image/png", "selection:system")
        ]),
        message("ordinary-text", "  ", "discord-message:empty", "participant", undefined, [
          attachment(0, "image/png", "selection:empty")
        ]),
        message("attachment-only", "", "discord-message:attachment-only", "participant", undefined, [
          attachment(0, "image/png", "selection:attachment-only")
        ]),
        message("ordinary-text", "Accepted", "discord-message:accepted", "participant", undefined, [
          attachment(0, "image/png", "selection:accepted")
        ]),
        message("ordinary-text", "Later", "discord-message:later", "participant", undefined, [
          attachment(0, "image/png", "selection:later")
        ])
      ],
      { messageLimit: 1 }
    );

    expect(snapshot.selectedAttachments).toEqual([
      { owner: messageIdentity("discord-message:accepted"), index: 0, mediaType: "image/png", selection: "selection:accepted" }
    ]);
  });

  it("rejects an attachment with a payload-like extra key without returning it", () => {
    const validOpaqueAttachment: ConversationObservation["attachments"][number] = attachment(
      0,
      "image/png",
      "selection:opaque"
    );
    expect(Object.keys(validOpaqueAttachment)).toEqual(["index", "mediaType", "selection"]);

    const request = validParseRequest();
    const privatePath = "private-image-path";
    const attachmentWithExtraKey = {
      index: 0,
      mediaType: "image/png",
      selection: "selection:opaque",
      imagePath: privatePath
    };

    expectControlledObservationError(
      () =>
        parseConversation({
          ...request,
          observation: {
            ...request.observation,
            messages: [
              { ...message("ordinary-text", "Visible text", "discord-message:ordinary"), attachments: [attachmentWithExtraKey] }
            ]
          }
        } as never),
      privatePath
    );
  });

  it("rejects an attachment with a non-enumerable forbidden extra key", () => {
    const request = validParseRequest();
    const privateValue = "private-hidden-image-path";
    const attachmentWithHiddenExtraKey = {
      index: 0,
      mediaType: "image/png",
      selection: "selection:opaque"
    };
    Object.defineProperty(attachmentWithHiddenExtraKey, "imagePath", {
      enumerable: false,
      value: privateValue
    });

    expectControlledObservationError(
      () =>
        parseConversation({
          ...request,
          observation: {
            ...request.observation,
            messages: [
              { ...message("ordinary-text", "Visible text", "discord-message:ordinary"), attachments: [attachmentWithHiddenExtraKey] }
            ]
          }
        } as never),
      privateValue
    );
  });

  it("rejects a sparse attachment array with a controlled privacy-safe error", () => {
    const request = validParseRequest();
    const privateSelection = "private-sparse-selection";
    const sparseAttachments: ConversationObservation["attachments"][number][] = [];
    sparseAttachments[1] = attachment(1, "image/png", privateSelection);

    expectControlledObservationError(
      () =>
        parseConversation({
          ...request,
          observation: {
            ...request.observation,
            messages: [
              {
                ...message("ordinary-text", "Visible text", "discord-message:ordinary"),
                attachments: sparseAttachments
              }
            ]
          }
        }),
      privateSelection
    );
  });

  it("rejects a negative attachment index with a privacy-safe order error", () => {
    const request = validParseRequest();
    const privateSelection = "private-negative-selection";

    expectControlledParserError(
      () =>
        parseConversation({
          ...request,
          observation: {
            ...request.observation,
            messages: [
              {
                ...message("ordinary-text", "Visible text", "discord-message:ordinary"),
                attachments: [attachment(-1, "image/png", privateSelection)]
              }
            ]
          }
        }),
      privateSelection,
      "ConversationOrderError"
    );
  });

  it.each([
    ["duplicate", [attachment(0, "image/png", "private-duplicate-selection"), attachment(0, "image/png", "selection:duplicate")]],
    ["fractional", [attachment(0.5, "image/png", "private-fractional-selection")]],
    ["decreasing", [attachment(2, "image/png", "private-decreasing-selection"), attachment(1, "image/png", "selection:decreasing")]]
  ])("rejects a %s attachment index order", (_description, attachments) => {
    const request = validParseRequest();
    const privateSelection = attachments[0]!.selection as string;

    expectControlledParserError(
      () =>
        parseConversation({
          ...request,
          observation: {
            ...request.observation,
            messages: [
              { ...message("ordinary-text", "Visible text", "discord-message:ordinary"), attachments }
            ]
          }
        }),
      privateSelection,
      "ConversationOrderError"
    );
  });

  it.each(["attachmentUrl", "cdnUrl", "imagePath", "imageBytes", "base64", "payload"])(
    "rejects forbidden attachment key %s",
    (forbiddenKey) => {
      const request = validParseRequest();
      const privateValue = `private-${forbiddenKey}`;
      const attachmentWithForbiddenKey = {
        index: 0,
        mediaType: "image/png",
        selection: "selection:opaque",
        [forbiddenKey]: privateValue
      };

      expectControlledObservationError(
        () =>
          parseConversation({
            ...request,
            observation: {
              ...request.observation,
              messages: [
                { ...message("ordinary-text", "Visible text", "discord-message:ordinary"), attachments: [attachmentWithForbiddenKey] }
              ]
            }
          } as never),
        privateValue
      );
    }
  );

  it("rejects an attachment with an empty media type", () => {
    const request = validParseRequest();
    const privateSelection = "private-empty-media-type-selection";

    expectControlledObservationError(
      () =>
        parseConversation({
          ...request,
          observation: {
            ...request.observation,
            messages: [
              {
                ...message("ordinary-text", "Visible text", "discord-message:ordinary"),
                attachments: [attachment(0, " ", privateSelection)]
              }
            ]
          }
        }),
      privateSelection
    );
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

  it.each([
    ["the request is null", () => null],
    [
      "the observation batch is malformed",
      () => ({ ...validParseRequest(), observation: { privatePayload: "private malformed observation" } })
    ],
    [
      "a message entry is null",
      () => {
        const request = validParseRequest();
        return { ...request, observation: { ...request.observation, messages: [null] } };
      }
    ],
    [
      "a message text field is malformed",
      () => {
        const request = validParseRequest();
        return {
          ...request,
          observation: {
            ...request.observation,
            messages: [
              {
                ...message("ordinary-text", "Visible text", "discord-message:ordinary"),
                text: { privatePayload: "private malformed text" }
              }
            ]
          }
        };
      }
    ]
  ])("returns a controlled error when %s", (_description, createMalformedRequest) => {
    const privateInputText = "private malformed";

    expectControlledObservationError(
      () => parseConversation(createMalformedRequest() as never),
      privateInputText
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
  timestamp = "2026-08-26T10:00:00.000Z",
  attachments: ConversationObservation["attachments"] = []
): ConversationObservation {
  return {
    identity: messageIdentity(identity),
    kind,
    text,
    author: { id: authorId, name: "Participant" },
    timestamp,
    attachments
  };
}

function attachment(index: number, mediaType: string, selection: string): ConversationObservation["attachments"][number] {
  return { index, mediaType, selection: selection as never };
}

function validParseRequest() {
  const boundary = messageIdentity("discord-message:boundary");
  return {
    destination,
    boundary,
    messageLimit: 3,
    attachmentLimitPerMessage: 2,
    attachmentLimitTotal: 5,
    supportedAttachmentMediaTypes: ["image/png"],
    observation: {
      destination,
      boundary,
      coverage: { kind: "contiguous-after-boundary" as const },
      messages: [message("ordinary-text", "Visible text", "discord-message:ordinary")]
    }
  };
}

function expectControlledObservationError(action: () => unknown, privateInputValue: string): void {
  expectControlledParserError(action, privateInputValue, "ConversationObservationError");
}

function expectControlledParserError(action: () => unknown, privateInputValue: string, name: string): void {
  try {
    action();
    throw new Error("Expected an observation error.");
  } catch (error) {
    expect(error).toMatchObject({ name });
    expect((error as Error).message).not.toContain(privateInputValue);
  }
}
