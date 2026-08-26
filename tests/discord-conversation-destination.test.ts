import { describe, expect, it } from "vitest";

import {
  ConversationDestinationError,
  resolveDiscordConversationDestination
} from "../src/conversation/discord-conversation-destination.js";

const SERVER_ID = "123456789012345";
const CHANNEL_ID = "234567890123456";
const CANONICAL_CHANNEL_URL = `https://discord.com/channels/${SERVER_ID}/${CHANNEL_ID}`;

describe("resolveDiscordConversationDestination", () => {
  it("resolves the exact canonical allowlisted Discord channel URL to an opaque provider-qualified destination", () => {
    expect(resolveDiscordConversationDestination(CANONICAL_CHANNEL_URL, [CANONICAL_CHANNEL_URL])).toBe(
      `discord:${SERVER_ID}:${CHANNEL_ID}`
    );
  });

  it("derives the server segment from the sole allowlist entry for a matching channel ID", () => {
    expect(resolveDiscordConversationDestination(CHANNEL_ID, [CANONICAL_CHANNEL_URL])).toBe(
      `discord:${SERVER_ID}:${CHANNEL_ID}`
    );
  });

  it("normalizes an exact server and channel pair to the allowlisted destination", () => {
    expect(
      resolveDiscordConversationDestination({ serverId: SERVER_ID, channelId: CHANNEL_ID }, [
        CANONICAL_CHANNEL_URL
      ])
    ).toBe(`discord:${SERVER_ID}:${CHANNEL_ID}`);
  });

  it("normalizes an exact DM channel pair to the allowlisted destination", () => {
    const dmChannelUrl = `https://discord.com/channels/@me/${CHANNEL_ID}`;

    expect(
      resolveDiscordConversationDestination({ serverId: "@me", channelId: CHANNEL_ID }, [dmChannelUrl])
    ).toBe(`discord:@me:${CHANNEL_ID}`);
  });

  it("rejects a missing allowlist entry with a controlled error", () => {
    expectDestinationError(
      () => resolveDiscordConversationDestination(CANONICAL_CHANNEL_URL, []),
      [CANONICAL_CHANNEL_URL]
    );
  });

  it("rejects multiple allowlist entries with a controlled error", () => {
    const extraChannelUrl = `https://discord.com/channels/${SERVER_ID}/345678901234567`;

    expectDestinationError(
      () => resolveDiscordConversationDestination(CANONICAL_CHANNEL_URL, [CANONICAL_CHANNEL_URL, extraChannelUrl]),
      [CANONICAL_CHANNEL_URL, extraChannelUrl]
    );
  });

  it("rejects malformed input with a controlled error", () => {
    const malformedUrl = `https://discord.com/channels/${SERVER_ID}/${CHANNEL_ID}?private=value`;

    expectDestinationError(
      () => resolveDiscordConversationDestination(malformedUrl, [CANONICAL_CHANNEL_URL]),
      [malformedUrl]
    );
  });

  it("rejects a mismatched channel ID with a controlled error", () => {
    const mismatchedChannelId = "345678901234567";

    expectDestinationError(
      () => resolveDiscordConversationDestination(mismatchedChannelId, [CANONICAL_CHANNEL_URL]),
      [mismatchedChannelId]
    );
  });

  it("rejects a mismatched server and channel pair with a controlled error", () => {
    const mismatchedServerId = "345678901234567";

    expectDestinationError(
      () =>
        resolveDiscordConversationDestination(
          { serverId: mismatchedServerId, channelId: CHANNEL_ID },
          [CANONICAL_CHANNEL_URL]
        ),
      [mismatchedServerId, CHANNEL_ID]
    );
  });

  it("rejects server-wide, category, thread, and multi-channel input shapes", () => {
    const categoryId = "345678901234567";
    const threadId = "456789012345678";

    for (const input of [
      { serverId: SERVER_ID },
      { serverId: SERVER_ID, categoryId },
      `https://discord.com/channels/${SERVER_ID}/${CHANNEL_ID}/${threadId}`,
      { serverId: SERVER_ID, channelIds: [CHANNEL_ID, categoryId] }
    ]) {
      expectDestinationError(() => resolveDiscordConversationDestination(input, [CANONICAL_CHANNEL_URL]), [
        SERVER_ID,
        CHANNEL_ID,
        categoryId,
        threadId
      ]);
    }
  });

  it("rejects input objects with unexpected keys", () => {
    expectDestinationError(
      () =>
        resolveDiscordConversationDestination(
          { serverId: SERVER_ID, channelId: CHANNEL_ID, unexpected: "private-value" },
          [CANONICAL_CHANNEL_URL]
        ),
      [SERVER_ID, CHANNEL_ID, "private-value"]
    );
  });
});

function expectDestinationError(action: () => unknown, privateValues: readonly string[]): void {
  try {
    action();
    throw new Error("Expected a destination error.");
  } catch (error) {
    expect(error).toBeInstanceOf(ConversationDestinationError);
    const message = (error as Error).message;
    for (const value of privateValues) {
      expect(message).not.toContain(value);
    }
  }
}
