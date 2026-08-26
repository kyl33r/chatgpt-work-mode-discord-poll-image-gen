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
      return this.requireAttentionWithEvaluation(
        round,
        COPY_INTENT_AMBIGUITY_REASON,
        evaluation,
        createImageEvaluationSummary({
          completion: "incomplete",
          correctness: "unverifiable",
          skippedArtifactCount: 1,
          browserCopyActionCount: 0,
          restartCount: 1,
          cleanResume: false,
          manualInterventionRequired: true,
          interruptionBoundary: "after-intent-before-copy",
          recovery: "needs-attention"
        })
      );
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
        tryClassifyEvaluation(evaluation, "artifact-validation-failed");
        return this.requireAttentionWithEvaluation(
          round,
          ARTIFACT_INSTALLATION_AMBIGUITY_REASON,
          evaluation,
          createImageEvaluationSummary({
            completion: "incomplete",
            correctness: "unverifiable",
            acceptedArtifactCount: 1,
            successfulFullDecodeCount: 0,
            skippedArtifactCount: 1,
            browserCopyActionCount: 0,
            restartCount: 1,
            cleanResume: false,
            manualInterventionRequired: true,
            interruptionBoundary: "after-receipt-before-collection",
            recovery: "needs-attention"
          })
        );
      }
      endArtifactPhase();
      await finishEvaluation(evaluation, createImageEvaluationSummary({
        completion: "complete",
        correctness: "verified",
        acceptedArtifactCount: 1,
        successfulFullDecodeCount: 1,
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
      const evaluation = this.startEvaluation("selection-order-changed");
      return this.requireAttentionWithEvaluation(
        round,
        CAPTURE_PROTOCOL_AMBIGUITY_REASON,
        evaluation,
        createOrderingFaultSummary(round.feedbackCaptureBatch!, request, "selected")
      );
    }

    const evaluation = this.startEvaluation("image-prepare");
    const endPreparationPhase = startEvaluationPhase(evaluation, "preparation");

    let expectedClipboardChangeCount: number;
    try {
      expectedClipboardChangeCount = await this.clipboard.getChangeCount();
    } catch (error) {
      endPreparationPhase();
      const classification = classifyClipboardFailure(error, "before-copy");
      tryClassifyEvaluation(evaluation, classification.scenarioCode);
      return this.requireAttentionWithEvaluation(
        round,
        CLIPBOARD_CAPTURE_AMBIGUITY_REASON,
        evaluation,
        createImageEvaluationSummary({
          completion: "incomplete",
          correctness: "unverifiable",
          skippedArtifactCount: 1,
          browserCopyActionCount: 0,
          restartCount: 0,
          cleanResume: false,
          manualInterventionRequired: classification.recovery === "needs-attention",
          interruptionBoundary: "before-intent",
          recovery: classification.recovery
        })
      );
    }
    try {
      await this.store.save(applyRoundEvent(round, {
        type: "feedback-copy-intent-recorded",
        ...request,
        expectedClipboardChangeCount
      }));
    } catch {
      endPreparationPhase();
      tryClassifyEvaluation(evaluation, "interrupted-after-intent-before-copy");
      return this.requireAttentionWithEvaluation(
        round,
        COPY_INTENT_AMBIGUITY_REASON,
        evaluation,
        createImageEvaluationSummary({
          completion: "incomplete",
          correctness: "unverifiable",
          skippedArtifactCount: 1,
          browserCopyActionCount: 0,
          restartCount: 0,
          cleanResume: false,
          manualInterventionRequired: true,
          interruptionBoundary: "after-intent-before-copy",
          recovery: "needs-attention"
        })
      );
    }
    endPreparationPhase();
    await finishEvaluation(evaluation, createImageEvaluationSummary({
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
      const evaluation = this.startEvaluation("selection-order-changed");
      return this.requireAttentionWithEvaluation(
        round,
        CAPTURE_PROTOCOL_AMBIGUITY_REASON,
        evaluation,
        createOrderingFaultSummary(round.feedbackCaptureBatch!, request, "copy-intent-recorded")
      );
    }
    const expectedClipboardChangeCount = intent.expectedClipboardChangeCount;
    if (expectedClipboardChangeCount === undefined) {
      const evaluation = this.startEvaluation("selection-order-changed");
      return this.requireAttentionWithEvaluation(
        round,
        CAPTURE_PROTOCOL_AMBIGUITY_REASON,
        evaluation,
        createOrderingFaultSummary(round.feedbackCaptureBatch!, request, "copy-intent-recorded")
      );
    }

    const evaluation = this.startEvaluation("image-capture");

    let image: { observedChangeCount: number; pngBytes: Uint8Array };
    const endClipboardPhase = startEvaluationPhase(evaluation, "clipboard-read-decode");
    try {
      image = await this.clipboard.readSingleImage(expectedClipboardChangeCount);
    } catch (error) {
      endClipboardPhase();
      const classification = classifyClipboardFailure(error, "after-copy");
      tryClassifyEvaluation(evaluation, classification.scenarioCode);
      return this.requireAttentionWithEvaluation(
        round,
        CLIPBOARD_CAPTURE_AMBIGUITY_REASON,
        evaluation,
        createImageEvaluationSummary({
          completion: "incomplete",
          correctness: "unverifiable",
          skippedArtifactCount: 1,
          browserCopyActionCount: 1,
          restartCount: 0,
          cleanResume: false,
          manualInterventionRequired: classification.recovery === "needs-attention",
          interruptionBoundary: "after-copy-before-capture",
          recovery: classification.recovery
        })
      );
    }
    endClipboardPhase();
    if (
      image.observedChangeCount !== expectedClipboardChangeCount + 1 ||
      !(image.pngBytes instanceof Uint8Array) ||
      image.pngBytes.length === 0
    ) {
      const scenarioCode = image.observedChangeCount === expectedClipboardChangeCount
        ? "clipboard-unchanged"
        : image.observedChangeCount !== expectedClipboardChangeCount + 1
          ? "clipboard-over-advanced"
          : "clipboard-unreadable";
      tryClassifyEvaluation(evaluation, scenarioCode);
      return this.requireAttentionWithEvaluation(
        round,
        CLIPBOARD_CAPTURE_AMBIGUITY_REASON,
        evaluation,
        createImageEvaluationSummary({
          completion: "incomplete",
          correctness: "unverifiable",
          skippedArtifactCount: 1,
          browserCopyActionCount: 1,
          restartCount: 0,
          cleanResume: false,
          manualInterventionRequired: true,
          interruptionBoundary: "after-copy-before-capture",
          recovery: "needs-attention"
        })
      );
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
      tryClassifyEvaluation(evaluation, "artifact-install-failed");
      return this.requireAttentionWithEvaluation(
        round,
        ARTIFACT_INSTALLATION_AMBIGUITY_REASON,
        evaluation,
        createImageEvaluationSummary({
          completion: "incomplete",
          correctness: "unverifiable",
          skippedArtifactCount: 1,
          browserCopyActionCount: 1,
          restartCount: 0,
          cleanResume: false,
          manualInterventionRequired: true,
          interruptionBoundary: "during-staging",
          recovery: "needs-attention"
        })
      );
    }
    endArtifactPhase();
    try {
      await this.store.save(applyRoundEvent(round, {
        type: "feedback-image-accepted",
        ...request,
        imagePath
      }));
    } catch {
      tryClassifyEvaluation(evaluation, "receipt-persistence-failed");
      return this.requireAttentionWithEvaluation(
        round,
        ARTIFACT_INSTALLATION_AMBIGUITY_REASON,
        evaluation,
        createImageEvaluationSummary({
          completion: "incomplete",
          correctness: "unverifiable",
          acceptedArtifactCount: 0,
          successfulFullDecodeCount: 1,
          skippedArtifactCount: 1,
          browserCopyActionCount: 1,
          restartCount: 0,
          cleanResume: false,
          manualInterventionRequired: true,
          interruptionBoundary: "after-install-before-receipt",
          recovery: "needs-attention"
        })
      );
    }
    await finishEvaluation(evaluation, createImageEvaluationSummary({
      completion: "complete",
      correctness: "verified",
      acceptedArtifactCount: 1,
      successfulFullDecodeCount: 1,
      browserCopyActionCount: 1,
      restartCount: 0,
      cleanResume: false,
      manualInterventionRequired: false,
      interruptionBoundary: "none",
      recovery: "automatic"
    }));
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

  private async requireAttentionWithEvaluation(
    round: RoundState,
    reason: string,
    evaluation: FeedbackAcquisitionEvaluationScenario | undefined,
    summary: Parameters<FeedbackAcquisitionEvaluationScenario["finish"]>[0]
  ): Promise<{ action: "needs-attention"; reason: string }> {
    try {
      return await this.requireAttention(round, reason);
    } finally {
      await finishEvaluation(evaluation, summary);
    }
  }
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

type EvaluationSummary = Parameters<FeedbackAcquisitionEvaluationScenario["finish"]>[0];

function createImageEvaluationSummary(
  classification: Pick<
    EvaluationSummary,
    | "completion"
    | "correctness"
    | "browserCopyActionCount"
    | "restartCount"
    | "cleanResume"
    | "manualInterventionRequired"
    | "interruptionBoundary"
    | "recovery"
  > & Partial<Pick<
    EvaluationSummary,
    | "acceptedArtifactCount"
    | "successfulFullDecodeCount"
    | "acceptedOrderMatched"
    | "duplicateArtifactCount"
    | "skippedArtifactCount"
    | "reorderedArtifactCount"
  >>
): EvaluationSummary {
  return {
    ...classification,
    expectedSelectedImageCount: 1,
    acceptedArtifactCount: classification.acceptedArtifactCount ?? 0,
    successfulFullDecodeCount: classification.successfulFullDecodeCount ?? 0,
    acceptedOrderMatched: classification.acceptedOrderMatched ?? true,
    otherBrowserAcquisitionActionCount: 0,
    duplicateArtifactCount: classification.duplicateArtifactCount ?? 0,
    skippedArtifactCount: classification.skippedArtifactCount ?? 0,
    reorderedArtifactCount: classification.reorderedArtifactCount ?? 0
  };
}

function createOrderingFaultSummary(
  batch: FeedbackCaptureBatch,
  request: FeedbackImageCaptureRequest,
  expectedStatus: "selected" | "copy-intent-recorded"
): EvaluationSummary {
  const duplicate = Boolean(findRequestedAttachment(batch, request, "accepted"));
  const expected = findAttachment(batch, expectedStatus);
  const wrongOrder = Boolean(expected && !isRequestedTuple(expected, request));
  const skippedIntent = expectedStatus === "copy-intent-recorded" && Boolean(
    findRequestedAttachment(batch, request, "selected")
  );
  return createImageEvaluationSummary({
    completion: "incomplete",
    correctness: "unverifiable",
    acceptedArtifactCount: duplicate ? 1 : 0,
    successfulFullDecodeCount: duplicate ? 1 : 0,
    acceptedOrderMatched: false,
    browserCopyActionCount: 0,
    restartCount: 0,
    cleanResume: false,
    manualInterventionRequired: true,
    interruptionBoundary: "before-intent",
    duplicateArtifactCount: duplicate ? 1 : 0,
    skippedArtifactCount: wrongOrder || skippedIntent ? 1 : 0,
    reorderedArtifactCount: wrongOrder ? 1 : 0,
    recovery: "needs-attention"
  });
}

function tryClassifyEvaluation(
  evaluation: FeedbackAcquisitionEvaluationScenario | undefined,
  scenarioCode: string
): void {
  try {
    evaluation?.classify(scenarioCode);
  } catch {
    // Evaluation must not affect acquisition behavior.
  }
}

function classifyClipboardFailure(
  error: unknown,
  boundary: "before-copy" | "after-copy"
): {
  scenarioCode: string;
  recovery: "needs-attention" | "terminal";
} {
  const category = typeof error === "object" && error !== null && "category" in error
    ? error.category
    : undefined;
  if (boundary === "before-copy") {
    return category === "unsupported-platform"
      ? { scenarioCode: "host-unsupported", recovery: "terminal" }
      : { scenarioCode: "pasteboard-unavailable", recovery: "terminal" };
  }
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
    return { scenarioCode: "host-unsupported-after-copy", recovery: "terminal" };
  }
  if (category === "helper-failed") {
    return { scenarioCode: "pasteboard-unavailable-after-copy", recovery: "terminal" };
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
  status: "selected" | "accepted"
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
