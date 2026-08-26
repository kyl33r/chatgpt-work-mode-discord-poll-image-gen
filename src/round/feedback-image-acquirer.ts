import type { ClipboardImageSource } from "../clipboard/clipboard-image-source.js";
import type { RoundArtifactStore } from "./round-artifact-store.js";
import { applyRoundEvent, type FeedbackCaptureBatch, type RoundState } from "./round-state.js";
import type { RoundStateStore } from "./round-state-store.js";

export interface FeedbackImageCaptureRequest {
  roundId: string;
  messageOrdinal: number;
  attachmentIndex: number;
}

export class FeedbackImageAcquirer {
  public constructor(
    private readonly store: RoundStateStore,
    private readonly clipboard: ClipboardImageSource,
    private readonly artifacts: RoundArtifactStore
  ) {}

  public async prepare(request: FeedbackImageCaptureRequest): Promise<{ action: "copy-visible-image" }> {
    const round = await this.requireCollectingRound(request.roundId);
    const next = findNextAttachment(round.feedbackCaptureBatch!, "selected");
    requireRequestedTuple(next, request);

    const expectedClipboardChangeCount = await this.clipboard.getChangeCount();
    await this.store.save(applyRoundEvent(round, {
      type: "feedback-copy-intent-recorded",
      ...request,
      expectedClipboardChangeCount
    }));
    return { action: "copy-visible-image" };
  }

  public async capture(request: FeedbackImageCaptureRequest): Promise<{ action: "captured" }> {
    const round = await this.requireCollectingRound(request.roundId);
    const intent = findNextAttachment(round.feedbackCaptureBatch!, "copy-intent-recorded");
    requireRequestedTuple(intent, request);
    const expectedClipboardChangeCount = intent.expectedClipboardChangeCount;
    if (expectedClipboardChangeCount === undefined) {
      throw new Error("Feedback image capture intent is invalid.");
    }

    const image = await this.clipboard.readSingleImage(expectedClipboardChangeCount);
    if (image.observedChangeCount !== expectedClipboardChangeCount + 1) {
      throw new Error("Clipboard did not advance exactly once.");
    }
    const imagePath = await this.artifacts.acceptFeedbackImageBytes(
      request.roundId,
      request.messageOrdinal,
      request.attachmentIndex,
      image.pngBytes
    );
    await this.store.save(applyRoundEvent(round, {
      type: "feedback-image-accepted",
      ...request,
      imagePath
    }));
    return { action: "captured" };
  }

  private async requireCollectingRound(roundId: string): Promise<RoundState> {
    const round = await this.store.get(roundId);
    if (!round) {
      throw new Error("Feedback Round was not found.");
    }
    if (round.phase !== "collecting-messages" || !round.feedbackCaptureBatch) {
      throw new Error("Feedback image capture is not available for this round.");
    }
    return round;
  }
}

function findNextAttachment(
  batch: FeedbackCaptureBatch,
  status: "selected" | "copy-intent-recorded"
) {
  for (const message of batch.messages) {
    const attachment = message.selectedAttachments.find((candidate) => candidate.status === status);
    if (attachment) {
      return { ...attachment, messageOrdinal: message.messageOrdinal };
    }
  }
  throw new Error("No feedback image capture is available.");
}

function requireRequestedTuple(
  attachment: { messageOrdinal: number; attachmentIndex: number },
  request: FeedbackImageCaptureRequest
): void {
  if (
    attachment.messageOrdinal !== request.messageOrdinal ||
    attachment.attachmentIndex !== request.attachmentIndex
  ) {
    throw new Error("Requested feedback image is not next for capture.");
  }
}
