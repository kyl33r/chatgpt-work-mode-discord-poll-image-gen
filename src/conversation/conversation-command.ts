import {
  resolveDiscordConversationDestination
} from "./discord-conversation-destination.js";
import type { DiscordChannelAllowlistStore } from "../config/discord-channel-allowlist.js";
import {
  CONVERSATION_SOURCE_FAILURE_CATEGORIES,
  FEEDBACK_IMAGE_LIMIT_PER_MESSAGE,
  FEEDBACK_IMAGE_LIMIT_PER_ROUND,
  SUPPORTED_IMAGE_MIME_TYPES
} from "../constants.js";
import type { WorkflowLock } from "../workflow-lock.js";
import type { ConversationPrivateHandoff } from "./conversation-private-handoff.js";
import {
  ConversationDestinationError,
  parseConversation,
  type ConversationCheckpoint,
  type ConversationObservationBatch,
  type ConversationObservationRequest,
  type StableMessageIdentity
} from "./conversation-parser.js";

export interface ConversationCommandDependencies {
  readonly allowlist: DiscordChannelAllowlistStore;
  readonly workflowLock: WorkflowLock;
  readonly handoff: ConversationPrivateHandoff;
}

type ConversationCommandResult =
  | { readonly action: "observe-conversation" }
  | {
      readonly action: "wait" | "conversation-complete";
      readonly acceptedMessageCount: number;
      readonly selectedAttachmentCount: number;
    }
  | { readonly action: "needs-attention" };

export async function executeConversationCommand(
  command: string,
  payload: unknown,
  dependencies: ConversationCommandDependencies
): Promise<ConversationCommandResult> {
  if (command !== "parse-conversation") {
    throw new Error("Unknown conversation command.");
  }

  try {
    return await dependencies.workflowLock.runExclusive(async () => {
      const record = requirePlainRecord(payload);
      if (record.mode === "prepare") {
        return prepareConversation(record, dependencies);
      }
      if (record.mode === "observe") {
        return observeConversation(record, dependencies);
      }
      if (record.mode === "source-failure") {
        return recordSourceFailure(record);
      }
      throw new Error("Unsupported conversation command mode.");
    });
  } catch {
    return { action: "needs-attention" };
  }
}

async function prepareConversation(
  record: Record<string, unknown>,
  dependencies: ConversationCommandDependencies
): Promise<{ readonly action: "observe-conversation" }> {
  requireExactKeys(
    record,
    ["mode", "invocationId", "destination", "stopAfterQualifyingMessages"],
    ["boundary"]
  );
  const invocationId = requireNonEmptyString(record.invocationId);
  const configuredChannels = await dependencies.allowlist.getAll();
  const destination = resolveDiscordConversationDestination(
    record.destination,
    configuredChannels
  );
  const stopAfterQualifyingMessages = requirePositiveInteger(
    record.stopAfterQualifyingMessages
  );
  const request: ConversationObservationRequest = {
    destination,
    ...(record.boundary === undefined
      ? {}
      : { boundary: requireNonEmptyString(record.boundary) as StableMessageIdentity }),
    stopAfterQualifyingMessages
  };
  await dependencies.handoff.writeRequest(invocationId, request);
  return { action: "observe-conversation" };
}

async function observeConversation(
  record: Record<string, unknown>,
  dependencies: ConversationCommandDependencies
): Promise<ConversationCommandResult> {
  requireExactKeys(record, ["mode", "invocationId", "observation"]);
  const invocationId = requireNonEmptyString(record.invocationId);
  const request = await dependencies.handoff.readRequest(invocationId);
  if (request === undefined) {
    throw new Error("Private conversation request is unavailable.");
  }
  const configuredChannels = await dependencies.allowlist.getAll();
  const currentDestination = resolveDiscordConversationDestination(
    configuredChannels[0],
    configuredChannels
  );
  if (request.destination !== currentDestination) {
    throw new ConversationDestinationError();
  }
  const previousSnapshot = await dependencies.handoff.readSnapshot(invocationId);
  const checkpoint: ConversationCheckpoint | undefined = previousSnapshot
    ? {
        ...previousSnapshot,
        messageLimit: request.stopAfterQualifyingMessages,
        attachmentLimitPerMessage: FEEDBACK_IMAGE_LIMIT_PER_MESSAGE,
        attachmentLimitTotal: FEEDBACK_IMAGE_LIMIT_PER_ROUND,
        supportedAttachmentMediaTypes: SUPPORTED_IMAGE_MIME_TYPES
      }
    : undefined;

  const snapshot = parseConversation({
    destination: request.destination,
    ...(request.boundary === undefined ? {} : { boundary: request.boundary }),
    messageLimit: request.stopAfterQualifyingMessages,
    attachmentLimitPerMessage: FEEDBACK_IMAGE_LIMIT_PER_MESSAGE,
    attachmentLimitTotal: FEEDBACK_IMAGE_LIMIT_PER_ROUND,
    supportedAttachmentMediaTypes: SUPPORTED_IMAGE_MIME_TYPES,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    observation: record.observation as ConversationObservationBatch
  });
  await dependencies.handoff.writeSnapshot(invocationId, snapshot);
  return {
    action: snapshot.complete ? "conversation-complete" : "wait",
    acceptedMessageCount: snapshot.messages.length,
    selectedAttachmentCount: snapshot.selectedAttachments.length
  };
}

function recordSourceFailure(
  record: Record<string, unknown>
): { readonly action: "needs-attention" } {
  requireExactKeys(record, ["mode", "category"]);
  if (!CONVERSATION_SOURCE_FAILURE_CATEGORIES.includes(record.category as never)) {
    throw new Error("Unsupported conversation source failure category.");
  }
  return { action: "needs-attention" };
}

function requirePlainRecord(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("Conversation command payload is invalid.");
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new Error("Conversation command payload is invalid.");
    }
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const keys = Reflect.ownKeys(record);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (!required.includes(key) && !optional.includes(key))
    )
  ) {
    throw new Error("Conversation command payload is invalid.");
  }
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Conversation command payload is invalid.");
  }
  return value;
}

function requirePositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("Conversation command payload is invalid.");
  }
  return value;
}
