import { describe, expect, it } from "vitest";

import {
  InboundMessageAmbiguityError,
  normalizeOpenClawMessage
} from "../src/messaging/openclaw-message-normalizer.js";

describe("normalizeOpenClawMessage", () => {
  it("normalizes a fully staged Discord channel message", () => {
    const message = normalizeOpenClawMessage(
      {
        from: "participant",
        content: "Increase the contrast",
        timestamp: Date.parse("2026-09-01T08:00:00.000Z"),
        messageId: "message-1",
        senderId: "participant-1",
        media: [
          {
            path: "/private/staging/reference.png",
            contentType: "image/png",
            kind: "image",
            messageId: "message-1"
          }
        ],
        metadata: { guildId: "guild-1" }
      },
      {
        channelId: "discord",
        conversationId: "channel-1",
        messageId: "message-1",
        senderId: "participant-1"
      }
    );

    expect(message).toEqual({
      provider: "discord",
      destination: {
        kind: "discord-channel",
        guildId: "guild-1",
        channelId: "channel-1"
      },
      messageId: "message-1",
      senderId: "participant-1",
      occurredAt: "2026-09-01T08:00:00.000Z",
      text: "Increase the contrast",
      attachments: [
        {
          index: 0,
          path: "/private/staging/reference.png",
          mediaType: "image/png"
        }
      ]
    });
  });

  it("fails closed while an attachment is still staging", () => {
    expect(() =>
      normalizeOpenClawMessage(
        {
          from: "participant",
          content: "Use this reference",
          timestamp: Date.parse("2026-09-01T08:00:00.000Z"),
          messageId: "message-1",
          senderId: "participant-1",
          mediaStagingPending: true,
          originalMedia: [{ contentType: "image/png", kind: "image" }],
          metadata: { guildId: "guild-1" }
        },
        {
          channelId: "discord",
          conversationId: "channel-1",
          messageId: "message-1",
          senderId: "participant-1"
        }
      )
    ).toThrow(InboundMessageAmbiguityError);
  });

  it("fails closed when original media exists without staged media", () => {
    expect(() =>
      normalizeOpenClawMessage(
        {
          from: "participant",
          content: "Use this reference",
          timestamp: Date.parse("2026-09-01T08:00:00.000Z"),
          messageId: "message-1",
          senderId: "participant-1",
          originalMedia: [{ contentType: "image/png", kind: "image" }],
          metadata: { guildId: "guild-1" }
        },
        {
          channelId: "discord",
          conversationId: "channel-1",
          messageId: "message-1",
          senderId: "participant-1"
        }
      )
    ).toThrow(InboundMessageAmbiguityError);
  });
});
