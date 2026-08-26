import {
  FEEDBACK_IMAGE_LIMIT_PER_MESSAGE,
  FEEDBACK_IMAGE_LIMIT_PER_ROUND,
  SUPPORTED_IMAGE_MIME_TYPES
} from "../constants.js";

export interface DiscordAttachmentObservation {
  attachmentIndex: number;
  mediaType: string;
  imagePath?: string;
}

export interface DiscordMessageObservation {
  kind: "ordinary-text" | "system" | "attachment-only";
  roundId: string;
  boundaryMessageUrl: string;
  messageUrl: string;
  authorId: string;
  authorName: string;
  timestamp: string;
  text: string;
  attachments: DiscordAttachmentObservation[];
}

export interface ContextImage {
  attachmentIndex: number;
  imagePath: string;
}

export interface CapturedMessage {
  messageUrl: string;
  authorId: string;
  authorName: string;
  timestamp: string;
  text: string;
  contextImages: ContextImage[];
}

export interface CollectMessagesInput {
  roundId: string;
  boundaryMessageUrl: string;
  collectionStartedAt: string;
  limit: number;
  existing: CapturedMessage[];
  observed: DiscordMessageObservation[];
}

export interface CollectionResult {
  complete: boolean;
  captured: CapturedMessage[];
}

export interface PlannedFeedbackCapture {
  messageUrl: string;
  messageOrdinal: number;
  attachmentIndex: number;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
}

export class MessageCollectionAmbiguityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageCollectionAmbiguityError";
  }
}

export function collectMessages(input: CollectMessagesInput): CollectionResult {
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new Error("Message limit must be a positive integer.");
  }
  const collectionStartedAt = Date.parse(input.collectionStartedAt);
  if (!Number.isFinite(collectionStartedAt)) {
    throw new Error("Collection boundary timestamp must be valid.");
  }
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  const observedUrls = new Set<string>();
  for (const observation of input.observed) {
    if (
      observation.roundId !== input.roundId ||
      observation.boundaryMessageUrl !== input.boundaryMessageUrl
    ) {
      throw new Error("Message observation does not match the active round boundary.");
    }
    const timestamp = Date.parse(observation.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= previousTimestamp) {
      throw new MessageCollectionAmbiguityError(
        "Message observations are not in Discord arrival order."
      );
    }
    if (observedUrls.has(observation.messageUrl)) {
      throw new MessageCollectionAmbiguityError("Message observations contain duplicate identities.");
    }
    observedUrls.add(observation.messageUrl);
    if (timestamp < collectionStartedAt) {
      throw new Error("Message observation predates the active round boundary.");
    }
    previousTimestamp = timestamp;
    let previousAttachmentIndex = -1;
    for (const attachment of observation.attachments) {
      if (
        !Number.isInteger(attachment.attachmentIndex) ||
        attachment.attachmentIndex < 0 ||
        attachment.attachmentIndex <= previousAttachmentIndex
      ) {
        throw new MessageCollectionAmbiguityError(
          "Message attachments are not in Discord attachment order."
        );
      }
      previousAttachmentIndex = attachment.attachmentIndex;
    }
  }

  const captured = [...input.existing];
  const capturedUrls = new Set(captured.map((message) => message.messageUrl));
  const latestPersistedTimestamp = captured.reduce((latest, message) => {
    const timestamp = Date.parse(message.timestamp);
    if (!Number.isFinite(timestamp)) {
      throw new MessageCollectionAmbiguityError(
        "Persisted message order cannot be established."
      );
    }
    return Math.max(latest, timestamp);
  }, Number.NEGATIVE_INFINITY);
  let capturedImageCount = captured.reduce(
    (total, message) => total + message.contextImages.length,
    0
  );

  for (const observation of input.observed) {
    if (captured.length >= input.limit) {
      break;
    }
    if (
      observation.kind !== "ordinary-text" ||
      observation.text.trim().length === 0 ||
      observation.messageUrl === input.boundaryMessageUrl ||
      capturedUrls.has(observation.messageUrl)
    ) {
      continue;
    }
    if (Date.parse(observation.timestamp) <= latestPersistedTimestamp) {
      throw new MessageCollectionAmbiguityError(
        "A rescan discovered a message before the persisted collection boundary."
      );
    }
    const contextImages = observation.attachments
      .filter((attachment) =>
        SUPPORTED_IMAGE_MIME_TYPES.some((mediaType) => mediaType === attachment.mediaType)
      )
      .slice(0, FEEDBACK_IMAGE_LIMIT_PER_MESSAGE)
      .slice(0, Math.max(0, FEEDBACK_IMAGE_LIMIT_PER_ROUND - capturedImageCount))
      .map(({ attachmentIndex, imagePath }) => {
        if (typeof imagePath !== "string" || imagePath.length === 0) {
          throw new Error("Selected participant image is missing its staged path.");
        }
        return { attachmentIndex, imagePath };
      });
    captured.push({
      messageUrl: observation.messageUrl,
      authorId: observation.authorId,
      authorName: observation.authorName,
      timestamp: observation.timestamp,
      text: observation.text,
      contextImages
    });
    capturedImageCount += contextImages.length;
    capturedUrls.add(observation.messageUrl);
  }

  return { complete: captured.length >= input.limit, captured };
}

export function planFeedbackCaptures(input: CollectMessagesInput): PlannedFeedbackCapture[] {
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new Error("Message limit must be a positive integer.");
  }
  const collectionStartedAt = Date.parse(input.collectionStartedAt);
  if (!Number.isFinite(collectionStartedAt)) {
    throw new Error("Collection boundary timestamp must be valid.");
  }
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  const observedUrls = new Set<string>();
  for (const observation of input.observed) {
    if (
      observation.roundId !== input.roundId ||
      observation.boundaryMessageUrl !== input.boundaryMessageUrl
    ) {
      throw new Error("Message observation does not match the active round boundary.");
    }
    const timestamp = Date.parse(observation.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= previousTimestamp) {
      throw new MessageCollectionAmbiguityError(
        "Message observations are not in Discord arrival order."
      );
    }
    if (observedUrls.has(observation.messageUrl)) {
      throw new MessageCollectionAmbiguityError("Message observations contain duplicate identities.");
    }
    observedUrls.add(observation.messageUrl);
    if (timestamp < collectionStartedAt) {
      throw new Error("Message observation predates the active round boundary.");
    }
    previousTimestamp = timestamp;
    let previousAttachmentIndex = -1;
    for (const attachment of observation.attachments) {
      if (
        !Number.isInteger(attachment.attachmentIndex) ||
        attachment.attachmentIndex < 0 ||
        attachment.attachmentIndex <= previousAttachmentIndex
      ) {
        throw new MessageCollectionAmbiguityError(
          "Message attachments are not in Discord attachment order."
        );
      }
      previousAttachmentIndex = attachment.attachmentIndex;
    }
  }

  const existingUrls = new Set(input.existing.map((message) => message.messageUrl));
  const latestPersistedTimestamp = input.existing.reduce((latest, message) => {
    const timestamp = Date.parse(message.timestamp);
    if (!Number.isFinite(timestamp)) {
      throw new MessageCollectionAmbiguityError(
        "Persisted message order cannot be established."
      );
    }
    return Math.max(latest, timestamp);
  }, Number.NEGATIVE_INFINITY);
  let messageOrdinal = input.existing.length;
  let selectedImageCount = input.existing.reduce(
    (total, message) => total + message.contextImages.length,
    0
  );
  const planned: PlannedFeedbackCapture[] = [];

  for (const observation of input.observed) {
    if (messageOrdinal >= input.limit) {
      break;
    }
    if (
      observation.kind !== "ordinary-text" ||
      observation.text.trim().length === 0 ||
      observation.messageUrl === input.boundaryMessageUrl ||
      existingUrls.has(observation.messageUrl)
    ) {
      continue;
    }
    if (Date.parse(observation.timestamp) <= latestPersistedTimestamp) {
      throw new MessageCollectionAmbiguityError(
        "A rescan discovered a message before the persisted collection boundary."
      );
    }
    messageOrdinal += 1;
    for (const attachment of observation.attachments) {
      if (selectedImageCount >= FEEDBACK_IMAGE_LIMIT_PER_ROUND) {
        break;
      }
      if (
        planned.filter((capture) => capture.messageOrdinal === messageOrdinal).length >=
          FEEDBACK_IMAGE_LIMIT_PER_MESSAGE ||
        !SUPPORTED_IMAGE_MIME_TYPES.some((mediaType) => mediaType === attachment.mediaType)
      ) {
        continue;
      }
      planned.push({
        messageUrl: observation.messageUrl,
        messageOrdinal,
        attachmentIndex: attachment.attachmentIndex,
        mediaType: attachment.mediaType as PlannedFeedbackCapture["mediaType"]
      });
      selectedImageCount += 1;
    }
  }
  return planned;
}
