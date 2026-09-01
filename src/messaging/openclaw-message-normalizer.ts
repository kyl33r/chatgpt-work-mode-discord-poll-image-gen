import { isAbsolute } from "node:path";

import type { InboundMessage } from "./messaging.js";

export interface OpenClawMediaFact {
  path?: string;
  contentType?: string;
  kind?: string;
  messageId?: string;
}

export interface OpenClawMessageEvent {
  from: string;
  content: string;
  timestamp?: number;
  messageId?: string;
  senderId?: string;
  media?: OpenClawMediaFact[];
  originalMedia?: OpenClawMediaFact[];
  mediaStagingPending?: boolean;
  metadata?: Record<string, unknown>;
}

export interface OpenClawMessageContext {
  channelId: string;
  conversationId?: string;
  messageId?: string;
  senderId?: string;
}

export class InboundMessageAmbiguityError extends Error {
  public constructor() {
    super("Inbound messaging state is incomplete or ambiguous.");
    this.name = "InboundMessageAmbiguityError";
  }
}

export function normalizeOpenClawMessage(
  event: OpenClawMessageEvent,
  context: OpenClawMessageContext
): InboundMessage {
  if (
    context.channelId !== "discord" ||
    event.mediaStagingPending === true ||
    ((event.originalMedia?.length ?? 0) > 0 && (event.media?.length ?? 0) === 0)
  ) {
    throw ambiguity();
  }

  const guildId = requireOpaqueId(event.metadata?.guildId);
  const channelId = requireOpaqueId(context.conversationId);
  const messageId = requireMatchingOpaqueId(event.messageId, context.messageId);
  const senderId = requireMatchingOpaqueId(event.senderId, context.senderId);
  const occurredAt = requireTimestamp(event.timestamp);
  if (typeof event.content !== "string") {
    throw ambiguity();
  }

  const seenPaths = new Set<string>();
  const attachments = (event.media ?? []).map((media, index) => {
    if (
      typeof media.path !== "string" ||
      media.path.length === 0 ||
      !isAbsolute(media.path) ||
      typeof media.contentType !== "string" ||
      media.contentType.length === 0 ||
      (media.messageId !== undefined && media.messageId !== messageId) ||
      seenPaths.has(media.path)
    ) {
      throw ambiguity();
    }
    seenPaths.add(media.path);
    return {
      index,
      path: media.path,
      mediaType: media.contentType
    };
  });

  return {
    provider: "discord",
    destination: { kind: "discord-channel", guildId, channelId },
    messageId,
    senderId,
    occurredAt,
    text: event.content,
    attachments
  };
}

function requireOpaqueId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw ambiguity();
  }
  return value;
}

function requireMatchingOpaqueId(left: unknown, right: unknown): string {
  const leftId = requireOpaqueId(left);
  const rightId = requireOpaqueId(right);
  if (leftId !== rightId) {
    throw ambiguity();
  }
  return leftId;
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw ambiguity();
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw ambiguity();
  }
  return timestamp.toISOString();
}

function ambiguity(): InboundMessageAmbiguityError {
  return new InboundMessageAmbiguityError();
}
