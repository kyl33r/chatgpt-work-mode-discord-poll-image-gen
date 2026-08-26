import type { ConversationDestination } from "./discord-conversation-destination.js";

declare const stableMessageIdentity: unique symbol;
declare const opaqueAttachmentSelection: unique symbol;

export type StableMessageIdentity = string & {
  readonly [stableMessageIdentity]: "StableMessageIdentity";
};

export type OpaqueAttachmentSelection = string & {
  readonly [opaqueAttachmentSelection]: "OpaqueAttachmentSelection";
};

export interface ConversationSource {
  observe(request: ConversationObservationRequest): Promise<ConversationObservationBatch>;
}

export interface ConversationObservationRequest {
  readonly destination: ConversationDestination;
  readonly boundary?: StableMessageIdentity;
  readonly stopAfterQualifyingMessages: number;
}

export interface ConversationParseRequest {
  readonly destination: ConversationDestination;
  readonly boundary?: StableMessageIdentity;
  readonly messageLimit: number;
  readonly attachmentLimitPerMessage: number;
  readonly attachmentLimitTotal: number;
  readonly supportedAttachmentMediaTypes: readonly string[];
  readonly observation: ConversationObservationBatch;
}

export interface ConversationObservationBatch {
  readonly destination: ConversationDestination;
  readonly boundary?: StableMessageIdentity;
  readonly coverage: { readonly kind: "contiguous-after-boundary" };
  readonly messages: readonly ConversationObservation[];
}

export interface ConversationObservation {
  readonly identity: StableMessageIdentity;
  readonly kind: "ordinary-text" | "system" | "attachment-only";
  readonly text: string;
  readonly author: ConversationAuthor;
  readonly timestamp: string;
  readonly attachments: readonly ConversationAttachmentObservation[];
}

export interface ConversationAuthor {
  readonly id: string;
  readonly name: string;
}

export interface ConversationAttachmentObservation {
  readonly index: number;
  readonly mediaType: string;
  readonly selection: OpaqueAttachmentSelection;
}

export interface QualifyingConversationMessage {
  readonly identity: StableMessageIdentity;
  readonly kind: "ordinary-text";
  readonly text: string;
  readonly author: ConversationAuthor;
  readonly timestamp: string;
}

export interface ConversationSnapshot {
  readonly destination: ConversationDestination;
  readonly boundary?: StableMessageIdentity;
  readonly complete: boolean;
  readonly messages: readonly QualifyingConversationMessage[];
}

export class ConversationObservationError extends Error {
  public constructor() {
    super("Conversation observation is invalid.");
    this.name = "ConversationObservationError";
  }
}

export function parseConversation(request: ConversationParseRequest): ConversationSnapshot {
  validateRequest(request);

  const messages: QualifyingConversationMessage[] = [];
  for (const observation of request.observation.messages) {
    if (observation.identity === request.boundary || !isQualifying(observation)) {
      continue;
    }

    messages.push({
      identity: observation.identity,
      kind: observation.kind,
      text: observation.text,
      author: observation.author,
      timestamp: observation.timestamp
    });

    if (messages.length === request.messageLimit) {
      break;
    }
  }

  return {
    destination: request.destination,
    ...(request.boundary === undefined ? {} : { boundary: request.boundary }),
    complete: messages.length === request.messageLimit,
    messages
  };
}

function isQualifying(observation: ConversationObservation): observation is ConversationObservation & {
  readonly kind: "ordinary-text";
} {
  return observation.kind === "ordinary-text" && observation.text.trim().length > 0;
}

function validateRequest(request: ConversationParseRequest): void {
  if (
    !isPositiveInteger(request.messageLimit) ||
    !isNonNegativeInteger(request.attachmentLimitPerMessage) ||
    !isNonNegativeInteger(request.attachmentLimitTotal) ||
    !isSupportedMediaPolicy(request.supportedAttachmentMediaTypes)
  ) {
    throw new ConversationObservationError();
  }
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isSupportedMediaPolicy(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((mediaType) => typeof mediaType === "string" && mediaType.trim().length > 0)
  );
}
