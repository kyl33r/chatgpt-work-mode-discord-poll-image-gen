import {
  ConversationDestinationError,
  type ConversationDestination
} from "./discord-conversation-destination.js";

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
  readonly checkpoint?: ConversationCheckpoint;
  readonly observation: ConversationObservationBatch;
}

export interface ConversationObservationBatch {
  readonly destination: ConversationDestination;
  readonly boundary?: StableMessageIdentity;
  readonly coverage:
    | { readonly kind: "contiguous-after-boundary" }
    | { readonly kind: "contiguous-visible-segment"; readonly segmentStart: StableMessageIdentity };
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
  readonly segmentStart?: StableMessageIdentity;
  readonly complete: boolean;
  readonly messages: readonly QualifyingConversationMessage[];
  readonly selectedAttachments: readonly AttachmentSelection[];
}

export interface ConversationCheckpoint {
  readonly destination: ConversationDestination;
  readonly boundary?: StableMessageIdentity;
  readonly segmentStart?: StableMessageIdentity;
  readonly messageLimit: number;
  readonly attachmentLimitPerMessage: number;
  readonly attachmentLimitTotal: number;
  readonly supportedAttachmentMediaTypes: readonly string[];
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

export class ConversationBoundaryError extends Error {
  public constructor() {
    super("Conversation boundary coverage is invalid.");
    this.name = "ConversationBoundaryError";
  }
}

export class ConversationSourceError extends Error {
  public constructor() {
    super("Conversation source is uncertain.");
    this.name = "ConversationSourceError";
  }
}

export class ConversationCheckpointError extends Error {
  public constructor() {
    super("Conversation checkpoint is invalid.");
    this.name = "ConversationCheckpointError";
  }
}

export function parseConversation(request: ConversationParseRequest): ConversationSnapshot {
  try {
    validateRequest(request);
  } catch (error) {
    if (hasCheckpoint(request) && error instanceof ConversationOrderError) {
      throw new ConversationCheckpointError();
    }
    throw error;
  }

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

  const snapshot: ConversationSnapshot = {
    destination: request.destination,
    ...(request.boundary === undefined ? {} : { boundary: request.boundary }),
    ...(request.observation.coverage.kind === "contiguous-visible-segment"
      ? { segmentStart: request.observation.coverage.segmentStart }
      : {}),
    complete: messages.length === request.messageLimit,
    messages,
    selectedAttachments
  };

  if (request.checkpoint === undefined) {
    return snapshot;
  }

  validateCheckpoint(request, snapshot);

  if (request.checkpoint.complete) {
    return snapshotFromCheckpoint(request.checkpoint);
  }

  return {
    ...snapshot,
    messages: [
      ...request.checkpoint.messages,
      ...snapshot.messages.slice(request.checkpoint.messages.length)
    ],
    selectedAttachments: [
      ...request.checkpoint.selectedAttachments,
      ...snapshot.selectedAttachments.slice(request.checkpoint.selectedAttachments.length)
    ],
    complete: snapshot.complete
  };
}

function snapshotFromCheckpoint(checkpoint: ConversationCheckpoint): ConversationSnapshot {
  return {
    destination: checkpoint.destination,
    ...(checkpoint.boundary === undefined ? {} : { boundary: checkpoint.boundary }),
    ...(checkpoint.segmentStart === undefined ? {} : { segmentStart: checkpoint.segmentStart }),
    complete: checkpoint.complete,
    messages: checkpoint.messages,
    selectedAttachments: checkpoint.selectedAttachments
  };
}

function validateCheckpoint(
  request: ConversationParseRequest,
  snapshot: ConversationSnapshot
): asserts request is ConversationParseRequest & { readonly checkpoint: ConversationCheckpoint } {
  const checkpoint = request.checkpoint;
  if (
    !isConversationCheckpoint(checkpoint) ||
    checkpoint.destination !== request.destination ||
    checkpoint.boundary !== request.boundary ||
    checkpoint.messageLimit !== request.messageLimit ||
    checkpoint.attachmentLimitPerMessage !== request.attachmentLimitPerMessage ||
    checkpoint.attachmentLimitTotal !== request.attachmentLimitTotal ||
    !hasSameValues(checkpoint.supportedAttachmentMediaTypes, request.supportedAttachmentMediaTypes) ||
    checkpoint.complete !== (checkpoint.messages.length === request.messageLimit) ||
    (request.boundary === undefined
      ? checkpoint.segmentStart !== snapshot.segmentStart
      : checkpoint.segmentStart !== undefined) ||
    snapshot.messages.length < checkpoint.messages.length ||
    snapshot.selectedAttachments.length < checkpoint.selectedAttachments.length
  ) {
    throw new ConversationCheckpointError();
  }

  for (let index = 0; index < checkpoint.messages.length; index += 1) {
    if (!hasSameMessage(checkpoint.messages[index]!, snapshot.messages[index]!)) {
      throw new ConversationCheckpointError();
    }
  }

  for (let index = 0; index < checkpoint.selectedAttachments.length; index += 1) {
    if (!hasSameAttachmentSelection(checkpoint.selectedAttachments[index]!, snapshot.selectedAttachments[index]!)) {
      throw new ConversationCheckpointError();
    }
  }
}

function isConversationCheckpoint(value: unknown): value is ConversationCheckpoint {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "destination",
      "boundary",
      "segmentStart",
      "messageLimit",
      "attachmentLimitPerMessage",
      "attachmentLimitTotal",
      "supportedAttachmentMediaTypes",
      "complete",
      "messages",
      "selectedAttachments"
    ]) &&
    typeof value.destination === "string" &&
    (value.boundary === undefined || typeof value.boundary === "string") &&
    (value.segmentStart === undefined || typeof value.segmentStart === "string") &&
    isPositiveInteger(value.messageLimit) &&
    isNonNegativeInteger(value.attachmentLimitPerMessage) &&
    isNonNegativeInteger(value.attachmentLimitTotal) &&
    isSupportedMediaPolicy(value.supportedAttachmentMediaTypes) &&
    typeof value.complete === "boolean" &&
    Array.isArray(value.messages) &&
    isDenseArray(value.messages) &&
    value.messages.every(isQualifyingConversationMessage) &&
    Array.isArray(value.selectedAttachments) &&
    isDenseArray(value.selectedAttachments) &&
    value.selectedAttachments.every(isAttachmentSelection)
  );
}

function isQualifyingConversationMessage(value: unknown): value is QualifyingConversationMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["identity", "kind", "text", "author", "timestamp"]) &&
    typeof value.identity === "string" &&
    value.identity.length > 0 &&
    value.kind === "ordinary-text" &&
    typeof value.text === "string" &&
    value.text.trim().length > 0 &&
    isConversationAuthor(value.author) &&
    isVisibleTimestamp(value.timestamp)
  );
}

function isAttachmentSelection(value: unknown): value is AttachmentSelection {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["owner", "index", "mediaType", "selection"]) &&
    typeof value.owner === "string" &&
    value.owner.length > 0 &&
    typeof value.index === "number" &&
    Number.isInteger(value.index) &&
    value.index >= 0 &&
    typeof value.mediaType === "string" &&
    value.mediaType.trim().length > 0 &&
    typeof value.selection === "string"
  );
}

function hasSameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasSameMessage(
  left: QualifyingConversationMessage,
  right: QualifyingConversationMessage
): boolean {
  return (
    left.identity === right.identity &&
    left.kind === right.kind &&
    left.text === right.text &&
    left.author.id === right.author.id &&
    left.author.name === right.author.name &&
    left.timestamp === right.timestamp
  );
}

function hasSameAttachmentSelection(left: AttachmentSelection, right: AttachmentSelection): boolean {
  return (
    left.owner === right.owner &&
    left.index === right.index &&
    left.mediaType === right.mediaType &&
    left.selection === right.selection
  );
}

function isQualifying(observation: ConversationObservation): observation is ConversationObservation & {
  readonly kind: "ordinary-text";
} {
  return observation.kind === "ordinary-text" && observation.text.trim().length > 0;
}

function validateRequest(request: unknown): asserts request is ConversationParseRequest {
  if (
    isRecord(request) &&
    isRecord(request.observation) &&
    typeof request.observation.destination === "string" &&
    Array.isArray(request.observation.messages) &&
    !isCoverage(request.observation.coverage)
  ) {
    throw new ConversationBoundaryError();
  }

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

  if (
    (request.boundary !== undefined && request.observation.coverage.kind !== "contiguous-after-boundary") ||
    (request.boundary === undefined && request.observation.coverage.kind !== "contiguous-visible-segment")
  ) {
    throw new ConversationBoundaryError();
  }

  if (
    request.boundary === "" ||
    request.observation.boundary === ""
  ) {
    throw new ConversationBoundaryError();
  }

  if (request.destination !== request.observation.destination) {
    throw new ConversationDestinationError();
  }

  if (request.boundary !== request.observation.boundary) {
    throw new ConversationBoundaryError();
  }

  if (
    request.observation.coverage.kind === "contiguous-visible-segment" &&
    request.observation.messages[0]?.identity !== request.observation.coverage.segmentStart
  ) {
    throw new ConversationBoundaryError();
  }

  validateAttachmentIndexes(request.observation.messages);
  validateMessageIdentities(request.observation.messages);
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
    isCoverage(value.coverage) &&
    Array.isArray(value.messages) &&
    value.messages.every(isConversationObservation)
  );
}

function isCoverage(
  value: unknown
): value is ConversationObservationBatch["coverage"] {
  return (
    isRecord(value) &&
    ((value.kind === "contiguous-after-boundary" && hasOnlyKeys(value, ["kind"])) ||
      (value.kind === "contiguous-visible-segment" &&
        typeof value.segmentStart === "string" &&
        value.segmentStart.length > 0 &&
        hasOnlyKeys(value, ["kind", "segmentStart"])))
  );
}

function isConversationObservation(value: unknown): value is ConversationObservation {
  return (
    isRecord(value) &&
    typeof value.identity === "string" &&
    (value.kind === "ordinary-text" || value.kind === "system" || value.kind === "attachment-only") &&
    typeof value.text === "string" &&
    isConversationAuthor(value.author) &&
    isVisibleTimestamp(value.timestamp) &&
    Array.isArray(value.attachments) &&
    isDenseArray(value.attachments) &&
    value.attachments.every(isConversationAttachmentObservation)
  );
}

function isVisibleTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return false;
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) {
    return false;
  }

  const canonicalTimestamp = value.includes(".") ? value : value.replace("Z", ".000Z");
  return timestamp.toISOString() === canonicalTimestamp;
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

function validateMessageIdentities(messages: readonly ConversationObservation[]): void {
  const identities = new Set<string>();
  for (const message of messages) {
    if (message.identity.length === 0 || identities.has(message.identity)) {
      throw new ConversationOrderError();
    }
    identities.add(message.identity);
  }
}

function isConversationAuthor(value: unknown): value is ConversationAuthor {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCheckpoint(value: unknown): boolean {
  return isRecord(value) && value.checkpoint !== undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowedKeys.includes(key));
}

function isDenseArray(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      return false;
    }
  }
  return true;
}
