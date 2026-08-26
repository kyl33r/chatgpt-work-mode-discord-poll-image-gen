import type { ClipboardImageSource } from "../clipboard/clipboard-image-source.js";
import {
  type FeedbackAcquisitionEvaluationRecorder,
  type FeedbackAcquisitionEvaluationScenario,
  type FeedbackAcquisitionPhase
} from "../evaluation/feedback-acquisition-evaluation.js";
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
    private readonly artifacts: RoundArtifactStore,
    private readonly evaluation?: FeedbackAcquisitionEvaluationRecorder
  ) {}

  public async prepare(request: FeedbackImageCaptureRequest): Promise<FeedbackImageCaptureResult> {
    const round = await this.requireCollectingRound(request.roundId);
    if (findAttachment(round.feedbackCaptureBatch!, "copy-intent-recorded")) {
      const evaluation = this.startEvaluation("restart-unresolved-intent");
      const result = await this.requireAttention(round, COPY_INTENT_AMBIGUITY_REASON);
      await finishEvaluation(evaluation, createEvaluationSummary(round.feedbackCaptureBatch!, {
        completion: "incomplete",
        correctness: "unverifiable",
        browserCopyActionCount: 0,
        restartCount: 1,
        cleanResume: false,
        manualInterventionRequired: true,
        interruptionBoundary: "after-intent-before-copy",
        recovery: "needs-attention"
      }));
      return result;
    }
    const accepted = findRequestedAttachment(round.feedbackCaptureBatch!, request, "accepted");
    if (accepted) {
      const evaluation = this.startEvaluation("restart-accepted-artifact");
      const endArtifactPhase = startEvaluationPhase(
        evaluation,
        "artifact-validation-install"
      );
      try {
        await this.artifacts.requireFeedbackImage(
          request.roundId,
          request.messageOrdinal,
          request.attachmentIndex,
          accepted.imagePath!
        );
      } catch {
        endArtifactPhase();
        return this.requireAttention(round, ARTIFACT_INSTALLATION_AMBIGUITY_REASON);
      }
      endArtifactPhase();
      await finishEvaluation(evaluation, createEvaluationSummary(round.feedbackCaptureBatch!, {
        completion: "complete",
        correctness: "verified",
        browserCopyActionCount: 0,
        restartCount: 1,
        cleanResume: true,
        manualInterventionRequired: false,
        interruptionBoundary: "after-receipt-before-collection",
        recovery: "resume"
      }));
      return { action: "reuse-accepted-image" };
    }
    const next = findAttachment(round.feedbackCaptureBatch!, "selected");
    if (!next || !isRequestedTuple(next, request)) {
      return this.requireAttention(round, CAPTURE_PROTOCOL_AMBIGUITY_REASON);
    }

    const selectedImageCount = countBatchAttachments(round.feedbackCaptureBatch!);
    const evaluation = this.startEvaluation(
      selectedImageCount === 1 ? "single-valid-image" : "multiple-valid-images"
    );
    const endPreparationPhase = startEvaluationPhase(evaluation, "preparation");

    let expectedClipboardChangeCount: number;
    try {
      expectedClipboardChangeCount = await this.clipboard.getChangeCount();
    } catch (error) {
      endPreparationPhase();
      const classification = classifyClipboardFailure(error);
      try {
        evaluation?.classify(classification.scenarioCode);
      } catch {
        // Evaluation must not affect acquisition behavior.
      }
      const result = await this.requireAttention(round, CLIPBOARD_CAPTURE_AMBIGUITY_REASON);
      await finishEvaluation(evaluation, createEvaluationSummary(round.feedbackCaptureBatch!, {
        completion: "incomplete",
        correctness: "unverifiable",
        browserCopyActionCount: 0,
        restartCount: 0,
        cleanResume: false,
        manualInterventionRequired: classification.recovery === "needs-attention",
        interruptionBoundary: "before-intent",
        recovery: classification.recovery
      }));
      return result;
    }
    try {
      await this.store.save(applyRoundEvent(round, {
        type: "feedback-copy-intent-recorded",
        ...request,
        expectedClipboardChangeCount
      }));
    } catch {
      endPreparationPhase();
      try {
        evaluation?.classify("restart-unresolved-intent");
      } catch {
        // Evaluation must not affect acquisition behavior.
      }
      const result = await this.requireAttention(round, COPY_INTENT_AMBIGUITY_REASON);
      await finishEvaluation(evaluation, createEvaluationSummary(round.feedbackCaptureBatch!, {
        completion: "incomplete",
        correctness: "unverifiable",
        browserCopyActionCount: 0,
        restartCount: 0,
        cleanResume: false,
        manualInterventionRequired: true,
        interruptionBoundary: "after-intent-before-copy",
        recovery: "needs-attention"
      }));
      return result;
    }
    endPreparationPhase();
    await finishEvaluation(evaluation, createEvaluationSummary(round.feedbackCaptureBatch!, {
      completion: "incomplete",
      correctness: "unverifiable",
      browserCopyActionCount: 0,
      restartCount: 0,
      cleanResume: false,
      manualInterventionRequired: false,
      interruptionBoundary: "none",
      recovery: "automatic"
    }));
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

    const selectedImageCount = countBatchAttachments(round.feedbackCaptureBatch!);
    const evaluation = this.startEvaluation(
      selectedImageCount === 1 ? "single-valid-image" : "multiple-valid-images"
    );

    let image: { observedChangeCount: number; pngBytes: Uint8Array };
    const endClipboardPhase = startEvaluationPhase(evaluation, "clipboard-read-decode");
    try {
      image = await this.clipboard.readSingleImage(expectedClipboardChangeCount);
    } catch (error) {
      endClipboardPhase();
      const classification = classifyClipboardFailure(error);
      try {
        evaluation?.classify(classification.scenarioCode);
      } catch {
        // Evaluation must not affect acquisition behavior.
      }
      const result = await this.requireAttention(round, CLIPBOARD_CAPTURE_AMBIGUITY_REASON);
      await finishEvaluation(evaluation, createEvaluationSummary(round.feedbackCaptureBatch!, {
        completion: "incomplete",
        correctness: "unverifiable",
        browserCopyActionCount: 1,
        restartCount: 0,
        cleanResume: false,
        manualInterventionRequired: classification.recovery === "needs-attention",
        interruptionBoundary: "after-copy-before-capture",
        recovery: classification.recovery
      }));
      return result;
    }
    endClipboardPhase();
    if (
      image.observedChangeCount !== expectedClipboardChangeCount + 1 ||
      !(image.pngBytes instanceof Uint8Array) ||
      image.pngBytes.length === 0
    ) {
      return this.requireAttention(round, CLIPBOARD_CAPTURE_AMBIGUITY_REASON);
    }
    let imagePath: string;
    const endArtifactPhase = startEvaluationPhase(
      evaluation,
      "artifact-validation-install"
    );
    try {
      imagePath = await this.artifacts.acceptFeedbackImageBytes(
        request.roundId,
        request.messageOrdinal,
        request.attachmentIndex,
        image.pngBytes
      );
    } catch {
      endArtifactPhase();
      return this.requireAttention(round, ARTIFACT_INSTALLATION_AMBIGUITY_REASON);
    }
    endArtifactPhase();
    try {
      await this.store.save(applyRoundEvent(round, {
        type: "feedback-image-accepted",
        ...request,
        imagePath
      }));
    } catch {
      return this.requireAttention(round, ARTIFACT_INSTALLATION_AMBIGUITY_REASON);
    }
    const acceptedArtifactCount = countBatchAttachments(
      round.feedbackCaptureBatch!,
      "accepted"
    ) + 1;
    await finishEvaluation(evaluation, {
      completion: "complete",
      correctness: "verified",
      expectedSelectedImageCount: selectedImageCount,
      acceptedArtifactCount,
      successfulFullDecodeCount: acceptedArtifactCount,
      acceptedOrderMatched: true,
      browserCopyActionCount: 1,
      otherBrowserAcquisitionActionCount: 0,
      restartCount: 0,
      cleanResume: false,
      manualInterventionRequired: false,
      interruptionBoundary: "none",
      duplicateArtifactCount: 0,
      skippedArtifactCount: 0,
      reorderedArtifactCount: 0,
      recovery: "automatic"
    });
    return { action: "captured" };
  }

  private startEvaluation(scenarioCode: string): FeedbackAcquisitionEvaluationScenario | undefined {
    try {
      return this.evaluation?.start(scenarioCode);
    } catch {
      return undefined;
    }
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

function countBatchAttachments(
  batch: FeedbackCaptureBatch,
  status?: "accepted"
): number {
  return batch.messages.reduce(
    (total, message) => total + message.selectedAttachments.filter(
      (attachment) => status === undefined || attachment.status === status
    ).length,
    0
  );
}

function startEvaluationPhase(
  evaluation: FeedbackAcquisitionEvaluationScenario | undefined,
  phase: FeedbackAcquisitionPhase
): () => void {
  try {
    const end = evaluation?.startPhase(phase);
    return () => {
      try {
        end?.();
      } catch {
        // Evaluation must not affect acquisition behavior.
      }
    };
  } catch {
    return () => undefined;
  }
}

async function finishEvaluation(
  evaluation: FeedbackAcquisitionEvaluationScenario | undefined,
  summary: Parameters<FeedbackAcquisitionEvaluationScenario["finish"]>[0]
): Promise<void> {
  try {
    await evaluation?.finish(summary);
  } catch {
    // Evaluation must not affect acquisition behavior.
  }
}

function createEvaluationSummary(
  batch: FeedbackCaptureBatch,
  classification: Pick<
    Parameters<FeedbackAcquisitionEvaluationScenario["finish"]>[0],
    | "completion"
    | "correctness"
    | "browserCopyActionCount"
    | "restartCount"
    | "cleanResume"
    | "manualInterventionRequired"
    | "interruptionBoundary"
    | "recovery"
  >
): Parameters<FeedbackAcquisitionEvaluationScenario["finish"]>[0] {
  const acceptedArtifactCount = countBatchAttachments(batch, "accepted");
  return {
    ...classification,
    expectedSelectedImageCount: countBatchAttachments(batch),
    acceptedArtifactCount,
    successfulFullDecodeCount: acceptedArtifactCount,
    acceptedOrderMatched: true,
    otherBrowserAcquisitionActionCount: 0,
    duplicateArtifactCount: 0,
    skippedArtifactCount: 0,
    reorderedArtifactCount: 0
  };
}

function classifyClipboardFailure(error: unknown): {
  scenarioCode: string;
  recovery: "needs-attention" | "terminal";
} {
  const category = typeof error === "object" && error !== null && "category" in error
    ? error.category
    : undefined;
  if (category === "clipboard-unchanged") {
    return { scenarioCode: "clipboard-unchanged", recovery: "needs-attention" };
  }
  if (category === "clipboard-overadvanced") {
    return { scenarioCode: "clipboard-over-advanced", recovery: "needs-attention" };
  }
  if (category === "no-image") {
    return { scenarioCode: "clipboard-empty", recovery: "needs-attention" };
  }
  if (category === "multiple-images") {
    return { scenarioCode: "clipboard-multiple-images", recovery: "needs-attention" };
  }
  if (category === "unsupported-platform") {
    return { scenarioCode: "host-unsupported", recovery: "terminal" };
  }
  if (category === "helper-failed") {
    return { scenarioCode: "pasteboard-unavailable", recovery: "terminal" };
  }
  return { scenarioCode: "clipboard-unreadable", recovery: "needs-attention" };
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
