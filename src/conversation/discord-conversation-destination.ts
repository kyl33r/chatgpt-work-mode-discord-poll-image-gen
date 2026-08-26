import { normalizeDiscordChannelUrl } from "../config/discord-channel-allowlist.js";

declare const conversationDestination: unique symbol;

export type ConversationDestination = string & {
  readonly [conversationDestination]: "ConversationDestination";
};

export class ConversationDestinationError extends Error {
  public constructor() {
    super("Discord conversation destination is invalid.");
    this.name = "ConversationDestinationError";
  }
}

export function resolveDiscordConversationDestination(
  input: unknown,
  allowlist: readonly unknown[]
): ConversationDestination {
  const allowlistedUrl = soleAllowlistedUrl(allowlist);
  const allowlistedParts = channelParts(allowlistedUrl);
  if (isServerChannelPair(input)) {
    if (
      input.serverId !== allowlistedParts.serverId ||
      input.channelId !== allowlistedParts.channelId
    ) {
      throw new ConversationDestinationError();
    }
    return toConversationDestination(allowlistedParts);
  }

  if (typeof input !== "string") {
    throw new ConversationDestinationError();
  }

  if (/^\d{15,20}$/.test(input)) {
    if (input !== allowlistedParts.channelId) {
      throw new ConversationDestinationError();
    }
    return toConversationDestination(allowlistedParts);
  }

  const normalizedInput = normalizeChannelUrl(input);
  if (normalizedInput !== allowlistedUrl) {
    throw new ConversationDestinationError();
  }
  return toConversationDestination(allowlistedParts);
}

function soleAllowlistedUrl(allowlist: readonly unknown[]): string {
  if (allowlist.length !== 1 || typeof allowlist[0] !== "string") {
    throw new ConversationDestinationError();
  }
  return normalizeChannelUrl(allowlist[0]);
}

function normalizeChannelUrl(value: string): string {
  try {
    return normalizeDiscordChannelUrl(value);
  } catch {
    throw new ConversationDestinationError();
  }
}

function channelParts(channelUrl: string): { serverId: string; channelId: string } {
  const [, serverId, channelId] = channelUrl.split("/").slice(-3);
  if (serverId === undefined || channelId === undefined) {
    throw new ConversationDestinationError();
  }
  return { serverId, channelId };
}

function toConversationDestination({ serverId, channelId }: { serverId: string; channelId: string }): ConversationDestination {
  return `discord:${serverId}:${channelId}` as ConversationDestination;
}

function isServerChannelPair(value: unknown): value is { serverId: string; channelId: string } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    Object.keys(value).every((key) => key === "serverId" || key === "channelId") &&
    typeof value.serverId === "string" &&
    typeof value.channelId === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
