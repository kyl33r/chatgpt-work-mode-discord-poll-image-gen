import { ROUND_SCHEMA_VERSION } from "../constants.js";
import type { CapturedMessage } from "./message-collector.js";

export type RoundPhase =
  | "draft"
  | "submitting-base"
  | "collecting-messages"
  | "synthesizing-feedback"
  | "closing-collection"
  | "ready-to-generate"
  | "generating"
  | "outcome-ready"
  | "publishing-outcome"
  | "completed"
  | "stopped"
  | "needs-attention";

export type GenerationOutcome =
  | { kind: "succeeded"; resultImagePath: string }
  | { kind: "refused" }
  | { kind: "failed" };

export type FeedbackCaptureStatus = "selected" | "copy-intent-recorded" | "accepted";

export interface FeedbackCaptureBatch {
  boundaryMessageUrl: string;
  messages: Array<{
    messageUrl: string;
    messageOrdinal: number;
    selectedAttachments: Array<{
      attachmentIndex: number;
      mediaType: "image/png" | "image/jpeg" | "image/webp";
      status: FeedbackCaptureStatus;
      expectedClipboardChangeCount?: number;
      imagePath?: string;
    }>;
  }>;
}

export interface RoundState {
  schemaVersion: typeof ROUND_SCHEMA_VERSION;
  id: string;
  phase: RoundPhase;
  baseImagePath: string;
  channelUrl: string;
  messageLimit: number;
  parentRoundId?: string;
  baseMessageUrl?: string;
  collectionStartedAt?: string;
  capturedMessages: CapturedMessage[];
  feedbackCaptureBatch?: FeedbackCaptureBatch;
  synthesizedPrompt?: string;
  closedMessageUrl?: string;
  generationOutcome?: GenerationOutcome;
  outcomeMessageUrl?: string;
  attentionReason?: string;
}

export type RoundEvent =
  | { type: "base-submission-started" }
  | {
      type: "base-submission-confirmed";
      baseMessageUrl: string;
      collectionStartedAt: string;
    }
  | { type: "message-collection-progressed"; capturedMessages: CapturedMessage[] }
  | { type: "message-collection-filled"; capturedMessages: CapturedMessage[] }
  | { type: "feedback-captures-planned"; feedbackCaptureBatch: FeedbackCaptureBatch }
  | {
      type: "feedback-copy-intent-recorded";
      messageOrdinal: number;
      attachmentIndex: number;
      expectedClipboardChangeCount: number;
    }
  | {
      type: "feedback-image-accepted";
      messageOrdinal: number;
      attachmentIndex: number;
      imagePath: string;
    }
  | { type: "synthesized-prompt-confirmed"; synthesizedPrompt: string }
  | { type: "collection-closed"; closedMessageUrl: string }
  | { type: "generation-started" }
  | { type: "generation-succeeded"; resultImagePath: string }
  | { type: "generation-refused" }
  | { type: "generation-failed" }
  | { type: "outcome-publication-started" }
  | { type: "outcome-publication-confirmed"; outcomeMessageUrl: string }
  | { type: "round-stopped" }
  | { type: "attention-required"; reason: string };

export interface CreateRoundInput {
  id: string;
  baseImagePath: string;
  channelUrl: string;
  messageLimit: number;
  parentRoundId?: string;
}

export function createRound(input: CreateRoundInput): RoundState {
  return {
    schemaVersion: ROUND_SCHEMA_VERSION,
    id: input.id,
    phase: "draft",
    baseImagePath: input.baseImagePath,
    channelUrl: input.channelUrl,
    messageLimit: input.messageLimit,
    ...(input.parentRoundId === undefined ? {} : { parentRoundId: input.parentRoundId }),
    capturedMessages: []
  };
}

export function applyRoundEvent(round: RoundState, event: RoundEvent): RoundState {
  if (
    event.type === "attention-required" &&
    round.phase !== "completed" &&
    round.phase !== "stopped" &&
    round.phase !== "needs-attention"
  ) {
    return { ...round, phase: "needs-attention", attentionReason: event.reason };
  }
  if (
    event.type === "round-stopped" &&
    (round.phase === "draft" ||
      (round.phase === "collecting-messages" &&
        round.capturedMessages.length < round.messageLimit))
  ) {
    return { ...round, phase: "stopped" };
  }
  if (round.phase === "draft" && event.type === "base-submission-started") {
    return { ...round, phase: "submitting-base" };
  }
  if (round.phase === "submitting-base" && event.type === "base-submission-confirmed") {
    return {
      ...round,
      phase: "collecting-messages",
      baseMessageUrl: event.baseMessageUrl,
      collectionStartedAt: event.collectionStartedAt
    };
  }
  if (
    round.phase === "collecting-messages" &&
    event.type === "message-collection-progressed"
  ) {
    if (event.capturedMessages.length >= round.messageLimit) {
      throw new Error("In-progress collection must remain below the configured message limit.");
    }
    requireFeedbackCaptureBatchIncorporated(round, event.capturedMessages);
    const { feedbackCaptureBatch: _completedBatch, ...withoutBatch } = round;
    return { ...withoutBatch, capturedMessages: event.capturedMessages };
  }
  if (round.phase === "collecting-messages" && event.type === "feedback-captures-planned") {
    return { ...round, feedbackCaptureBatch: event.feedbackCaptureBatch };
  }
  if (round.phase === "collecting-messages" && event.type === "feedback-copy-intent-recorded") {
    return {
      ...round,
      feedbackCaptureBatch: updateFeedbackCaptureAttachment(round, event, (attachment) => ({
        attachmentIndex: attachment.attachmentIndex,
        mediaType: attachment.mediaType,
        status: "copy-intent-recorded",
        expectedClipboardChangeCount: event.expectedClipboardChangeCount
      }))
    };
  }
  if (round.phase === "collecting-messages" && event.type === "feedback-image-accepted") {
    return {
      ...round,
      feedbackCaptureBatch: updateFeedbackCaptureAttachment(round, event, (attachment) => ({
        attachmentIndex: attachment.attachmentIndex,
        mediaType: attachment.mediaType,
        status: "accepted",
        imagePath: event.imagePath
      }))
    };
  }
  if (round.phase === "collecting-messages" && event.type === "message-collection-filled") {
    if (event.capturedMessages.length !== round.messageLimit) {
      throw new Error("Filled collection must match the configured message limit.");
    }
    requireFeedbackCaptureBatchIncorporated(round, event.capturedMessages);
    const { feedbackCaptureBatch: _completedBatch, ...withoutBatch } = round;
    return {
      ...withoutBatch,
      phase: "synthesizing-feedback",
      capturedMessages: event.capturedMessages
    };
  }
  if (
    round.phase === "synthesizing-feedback" &&
    event.type === "synthesized-prompt-confirmed"
  ) {
    if (event.synthesizedPrompt.length === 0) {
      throw new Error("Synthesized Prompt must not be empty.");
    }
    return {
      ...round,
      phase: "closing-collection",
      synthesizedPrompt: event.synthesizedPrompt
    };
  }
  if (round.phase === "closing-collection" && event.type === "collection-closed") {
    if (!round.synthesizedPrompt) {
      throw new Error("Collection cannot close without a Synthesized Prompt.");
    }
    return { ...round, phase: "ready-to-generate", closedMessageUrl: event.closedMessageUrl };
  }
  if (round.phase === "ready-to-generate" && event.type === "generation-started") {
    return { ...round, phase: "generating" };
  }
  if (round.phase === "generating" && event.type === "generation-succeeded") {
    return {
      ...round,
      phase: "outcome-ready",
      generationOutcome: { kind: "succeeded", resultImagePath: event.resultImagePath }
    };
  }
  if (round.phase === "generating" && event.type === "generation-refused") {
    return { ...round, phase: "outcome-ready", generationOutcome: { kind: "refused" } };
  }
  if (round.phase === "generating" && event.type === "generation-failed") {
    return { ...round, phase: "outcome-ready", generationOutcome: { kind: "failed" } };
  }
  if (round.phase === "outcome-ready" && event.type === "outcome-publication-started") {
    return { ...round, phase: "publishing-outcome" };
  }
  if (
    round.phase === "publishing-outcome" &&
    event.type === "outcome-publication-confirmed"
  ) {
    return { ...round, phase: "completed", outcomeMessageUrl: event.outcomeMessageUrl };
  }
  throw new Error(`Invalid round transition: ${round.phase} + ${event.type}`);
}

function isTerminal(phase: RoundPhase): boolean {
  return phase === "completed" || phase === "stopped" || phase === "needs-attention";
}

function requireFeedbackCaptureBatchIncorporated(
  round: RoundState,
  capturedMessages: CapturedMessage[]
): void {
  if (!round.feedbackCaptureBatch) {
    return;
  }
  const incorporated = round.feedbackCaptureBatch.messages.every((batchMessage) => {
    const captured = capturedMessages[batchMessage.messageOrdinal - 1];
    return (
      captured?.messageUrl === batchMessage.messageUrl &&
      captured.contextImages.length === batchMessage.selectedAttachments.length &&
      batchMessage.selectedAttachments.every((attachment, index) => {
        const image = captured.contextImages[index];
        return (
          attachment.status === "accepted" &&
          typeof attachment.imagePath === "string" &&
          image?.attachmentIndex === attachment.attachmentIndex &&
          image.imagePath === attachment.imagePath
        );
      })
    );
  });
  if (!incorporated) {
    throw new Error("Feedback image capture batch was not incorporated exactly.");
  }
}

function updateFeedbackCaptureAttachment(
  round: RoundState,
  event: { messageOrdinal: number; attachmentIndex: number },
  update: (attachment: FeedbackCaptureBatch["messages"][number]["selectedAttachments"][number]) =>
    FeedbackCaptureBatch["messages"][number]["selectedAttachments"][number]
): FeedbackCaptureBatch {
  if (!round.feedbackCaptureBatch) {
    throw new Error("Feedback image capture batch is missing.");
  }
  let found = false;
  const messages = round.feedbackCaptureBatch.messages.map((message) => ({
    ...message,
    selectedAttachments: message.selectedAttachments.map((attachment) => {
      if (
        message.messageOrdinal !== event.messageOrdinal ||
        attachment.attachmentIndex !== event.attachmentIndex
      ) {
        return attachment;
      }
      found = true;
      return update(attachment);
    })
  }));
  if (!found) {
    throw new Error("Feedback image capture attachment is missing.");
  }
  return { ...round.feedbackCaptureBatch, messages };
}
