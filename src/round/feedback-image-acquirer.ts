import type { ClipboardImageSource } from "../clipboard/clipboard-image-source.js";
import type { RoundArtifactStore } from "./round-artifact-store.js";
import { applyRoundEvent, type FeedbackCaptureBatch, type RoundState } from "./round-state.js";
import type { RoundStateStore } from "./round-state-store.js";

export interface FeedbackImageCaptureRequest {
  roundId: string;
  messageOrdinal: number;
  attachmentIndex: number;
}

type FeedbackImageCaptureResult =
  | { action: "copy-visible-image" }
  | { action: "captured" }
  | { action: "reuse-accepted-image" }
  | { action: "needs-attention"; reason: string };

const COPY_INTENT_AMBIGUITY_REASON =
  "A feedback image copy may already have occurred; reconcile the Feedback Round manually.";
const CLIPBOARD_CAPTURE_AMBIGUITY_REASON =
  "Clipboard image capture is ambiguous; reconcile the Feedback Round manually.";
const ARTIFACT_INSTALLATION_AMBIGUITY_REASON =
  "Feedback image installation is ambiguous; reconcile the Feedback Round manually.";
const CAPTURE_PROTOCOL_AMBIGUITY_REASON =
  "Feedback image capture state is ambiguous; reconcile the Feedback Round manually.";
const STATE_UNAVAILABLE_ERROR = "Feedback image capture state is unavailable.";
const ATTENTION_PERSISTENCE_ERROR = "Unable to persist controlled Needs Attention state.";

export class FeedbackImageAcquirer {
  public constructor(
    private readonly store: RoundStateStore,
    private readonly clipboard: ClipboardImageSource,
    private readonly artifacts: RoundArtifactStore
  ) {}

  public async prepare(request: FeedbackImageCaptureRequest): Promise<FeedbackImageCaptureResult> {
    const round = await this.requireCollectingRound(request.roundId);
    if (findAttachment(round.feedbackCaptureBatch!, "copy-intent-recorded")) {
      return this.requireAttention(round, COPY_INTENT_AMBIGUITY_REASON);
    }
    const accepted = findRequestedAttachment(round.feedbackCaptureBatch!, request, "accepted");
    if (accepted) {
      try {
        await this.artifacts.requireFeedbackImage(
          request.roundId,
          request.messageOrdinal,
          request.attachmentIndex,
          accepted.imagePath!
        );
      } catch {
        return this.requireAttention(round, ARTIFACT_INSTALLATION_AMBIGUITY_REASON);
      }
      return { action: "reuse-accepted-image" };
    }
    const next = findAttachment(round.feedbackCaptureBatch!, "selected");
    if (!next || !isRequestedTuple(next, request)) {
      return this.requireAttention(round, CAPTURE_PROTOCOL_AMBIGUITY_REASON);
    }

    let expectedClipboardChangeCount: number;
    try {
      expectedClipboardChangeCount = await this.clipboard.getChangeCount();
    } catch {
      return this.requireAttention(round, CLIPBOARD_CAPTURE_AMBIGUITY_REASON);
    }
    try {
      await this.store.save(applyRoundEvent(round, {
        type: "feedback-copy-intent-recorded",
        ...request,
        expectedClipboardChangeCount
      }));
    } catch {
      return this.requireAttention(round, COPY_INTENT_AMBIGUITY_REASON);
    }
    return { action: "copy-visible-image" };
  }

  public async capture(request: FeedbackImageCaptureRequest): Promise<FeedbackImageCaptureResult> {
    const round = await this.requireCollectingRound(request.roundId);
    const intent = findAttachment(round.feedbackCaptureBatch!, "copy-intent-recorded");
    if (!intent || !isRequestedTuple(intent, request)) {
      return this.requireAttention(round, CAPTURE_PROTOCOL_AMBIGUITY_REASON);
    }
    const expectedClipboardChangeCount = intent.expectedClipboardChangeCount;
    if (expectedClipboardChangeCount === undefined) {
      return this.requireAttention(round, CAPTURE_PROTOCOL_AMBIGUITY_REASON);
    }

    let image: { observedChangeCount: number; pngBytes: Uint8Array };
    try {
      image = await this.clipboard.readSingleImage(expectedClipboardChangeCount);
    } catch {
      return this.requireAttention(round, CLIPBOARD_CAPTURE_AMBIGUITY_REASON);
    }
    if (
      image.observedChangeCount !== expectedClipboardChangeCount + 1 ||
      !(image.pngBytes instanceof Uint8Array) ||
      image.pngBytes.length === 0
    ) {
      return this.requireAttention(round, CLIPBOARD_CAPTURE_AMBIGUITY_REASON);
    }
    let imagePath: string;
    try {
      imagePath = await this.artifacts.acceptFeedbackImageBytes(
        request.roundId,
        request.messageOrdinal,
        request.attachmentIndex,
        image.pngBytes
      );
    } catch {
      return this.requireAttention(round, ARTIFACT_INSTALLATION_AMBIGUITY_REASON);
    }
    try {
      await this.store.save(applyRoundEvent(round, {
        type: "feedback-image-accepted",
        ...request,
        imagePath
      }));
    } catch {
      return this.requireAttention(round, ARTIFACT_INSTALLATION_AMBIGUITY_REASON);
    }
    return { action: "captured" };
  }

  private async requireCollectingRound(roundId: string): Promise<RoundState> {
    let round: RoundState | undefined;
    try {
      round = await this.store.get(roundId);
    } catch {
      throw new Error(STATE_UNAVAILABLE_ERROR);
    }
    if (!round) {
      throw new Error("Feedback Round was not found.");
    }
    if (round.phase !== "collecting-messages" || !round.feedbackCaptureBatch) {
      throw new Error("Feedback image capture is not available for this round.");
    }
    let activeRounds: RoundState[];
    try {
      activeRounds = (await this.store.list()).filter(
        (candidate) =>
          candidate.phase !== "completed" &&
          candidate.phase !== "stopped" &&
          candidate.phase !== "needs-attention"
      );
    } catch {
      throw new Error(STATE_UNAVAILABLE_ERROR);
    }
    if (activeRounds.length !== 1 || activeRounds[0]!.id !== round.id) {
      throw new Error("Feedback image capture does not target the active Feedback Round.");
    }
    return round;
  }

  private async requireAttention(
    round: RoundState,
    reason: string
  ): Promise<{ action: "needs-attention"; reason: string }> {
    try {
      await this.store.save(applyRoundEvent(round, { type: "attention-required", reason }));
    } catch {
      throw new Error(ATTENTION_PERSISTENCE_ERROR);
    }
    return { action: "needs-attention", reason };
  }
}

function findAttachment(
  batch: FeedbackCaptureBatch,
  status: "selected" | "copy-intent-recorded"
) {
  for (const message of batch.messages) {
    const attachment = message.selectedAttachments.find((candidate) => candidate.status === status);
    if (attachment) {
      return { ...attachment, messageOrdinal: message.messageOrdinal };
    }
  }
  return undefined;
}

function findRequestedAttachment(
  batch: FeedbackCaptureBatch,
  request: FeedbackImageCaptureRequest,
  status: "accepted"
) {
  for (const message of batch.messages) {
    const attachment = message.selectedAttachments.find(
      (candidate) =>
        candidate.status === status &&
        message.messageOrdinal === request.messageOrdinal &&
        candidate.attachmentIndex === request.attachmentIndex
    );
    if (attachment) {
      return attachment;
    }
  }
  return undefined;
}

function isRequestedTuple(
  attachment: { messageOrdinal: number; attachmentIndex: number },
  request: FeedbackImageCaptureRequest
): boolean {
  return (
    attachment.messageOrdinal === request.messageOrdinal &&
    attachment.attachmentIndex === request.attachmentIndex
  );
}
