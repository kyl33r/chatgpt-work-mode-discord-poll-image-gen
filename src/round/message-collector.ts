export interface DiscordMessageObservation {
  kind: "ordinary-text" | "system" | "attachment-only";
  roundId: string;
  boundaryMessageUrl: string;
  messageUrl: string;
  authorId: string;
  authorName: string;
  timestamp: string;
  text: string;
}

export interface CapturedMessage {
  messageUrl: string;
  authorId: string;
  authorName: string;
  timestamp: string;
  text: string;
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
  for (const observation of input.observed) {
    if (
      observation.roundId !== input.roundId ||
      observation.boundaryMessageUrl !== input.boundaryMessageUrl
    ) {
      throw new Error("Message observation does not match the active round boundary.");
    }
    const timestamp = Date.parse(observation.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < previousTimestamp) {
      throw new MessageCollectionAmbiguityError(
        "Message observations are not in Discord arrival order."
      );
    }
    if (timestamp < collectionStartedAt) {
      throw new Error("Message observation predates the active round boundary.");
    }
    previousTimestamp = timestamp;
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
    captured.push({
      messageUrl: observation.messageUrl,
      authorId: observation.authorId,
      authorName: observation.authorName,
      timestamp: observation.timestamp,
      text: observation.text
    });
    capturedUrls.add(observation.messageUrl);
  }

  return { complete: captured.length >= input.limit, captured };
}
