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

export interface AttachmentSelection {
  readonly owner: StableMessageIdentity;
  readonly index: number;
  readonly mediaType: string;
  readonly selection: OpaqueAttachmentSelection;
}

export interface ConversationSnapshot {
  readonly destination: ConversationDestination;
  readonly boundary?: StableMessageIdentity;
  readonly complete: boolean;
  readonly messages: readonly QualifyingConversationMessage[];
  readonly selectedAttachments: readonly AttachmentSelection[];
}

export class ConversationObservationError extends Error {
  public constructor() {
    super("Conversation observation is invalid.");
    this.name = "ConversationObservationError";
  }
}

export class ConversationOrderError extends Error {
  public constructor() {
    super("Conversation order is invalid.");
    this.name = "ConversationOrderError";
  }
}

export function parseConversation(request: ConversationParseRequest): ConversationSnapshot {
  validateRequest(request);

  const messages: QualifyingConversationMessage[] = [];
  const selectedAttachments: AttachmentSelection[] = [];
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

    let selectedForMessage = 0;
    for (const attachment of observation.attachments) {
      if (
        selectedAttachments.length === request.attachmentLimitTotal ||
        selectedForMessage === request.attachmentLimitPerMessage
      ) {
        break;
      }

      if (request.supportedAttachmentMediaTypes.includes(attachment.mediaType)) {
        selectedAttachments.push({
          owner: observation.identity,
          index: attachment.index,
          mediaType: attachment.mediaType,
          selection: attachment.selection
        });
        selectedForMessage += 1;
      }
    }

    if (messages.length === request.messageLimit) {
      break;
    }
  }

  return {
    destination: request.destination,
    ...(request.boundary === undefined ? {} : { boundary: request.boundary }),
    complete: messages.length === request.messageLimit,
    messages,
    selectedAttachments
  };
}

function isQualifying(observation: ConversationObservation): observation is ConversationObservation & {
  readonly kind: "ordinary-text";
} {
  return observation.kind === "ordinary-text" && observation.text.trim().length > 0;
}

function validateRequest(request: unknown): asserts request is ConversationParseRequest {
  if (
    !isRecord(request) ||
    typeof request.destination !== "string" ||
    (request.boundary !== undefined && typeof request.boundary !== "string") ||
    !isPositiveInteger(request.messageLimit) ||
    !isNonNegativeInteger(request.attachmentLimitPerMessage) ||
    !isNonNegativeInteger(request.attachmentLimitTotal) ||
    !isSupportedMediaPolicy(request.supportedAttachmentMediaTypes) ||
    !isConversationObservationBatch(request.observation)
  ) {
    throw new ConversationObservationError();
  }

  validateAttachmentIndexes(request.observation.messages);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isSupportedMediaPolicy(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((mediaType) => typeof mediaType === "string" && mediaType.trim().length > 0)
  );
}

function isConversationObservationBatch(value: unknown): value is ConversationObservationBatch {
  return (
    isRecord(value) &&
    typeof value.destination === "string" &&
    (value.boundary === undefined || typeof value.boundary === "string") &&
    isRecord(value.coverage) &&
    value.coverage.kind === "contiguous-after-boundary" &&
    Array.isArray(value.messages) &&
    value.messages.every(isConversationObservation)
  );
}

function isConversationObservation(value: unknown): value is ConversationObservation {
  return (
    isRecord(value) &&
    typeof value.identity === "string" &&
    (value.kind === "ordinary-text" || value.kind === "system" || value.kind === "attachment-only") &&
    typeof value.text === "string" &&
    isConversationAuthor(value.author) &&
    typeof value.timestamp === "string" &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isConversationAttachmentObservation)
  );
}

function isConversationAttachmentObservation(value: unknown): value is ConversationAttachmentObservation {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["index", "mediaType", "selection"]) &&
    typeof value.index === "number" &&
    typeof value.mediaType === "string" &&
    value.mediaType.trim().length > 0 &&
    typeof value.selection === "string"
  );
}

function validateAttachmentIndexes(messages: readonly ConversationObservation[]): void {
  for (const message of messages) {
    let previousIndex = -1;
    for (const attachment of message.attachments) {
      if (
        !Number.isInteger(attachment.index) ||
        attachment.index < 0 ||
        attachment.index <= previousIndex
      ) {
        throw new ConversationOrderError();
      }
      previousIndex = attachment.index;
    }
  }
}

function isConversationAuthor(value: unknown): value is ConversationAuthor {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}
