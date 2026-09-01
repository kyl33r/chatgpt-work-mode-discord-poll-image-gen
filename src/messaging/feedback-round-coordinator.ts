import { createHash } from "node:crypto";

import { executeCommand, type CommandDependencies } from "../cli.js";
import { resolveDiscordChannel } from "../config/resolve-discord-channel.js";
import {
  DISCORD_SNOWFLAKE_EPOCH_MS,
  FEEDBACK_IMAGE_LIMIT_PER_MESSAGE,
  FEEDBACK_IMAGE_LIMIT_PER_ROUND,
  OPENCLAW_DELIVERY_AMBIGUOUS_ATTENTION_REASON,
  OPENCLAW_DELIVERY_FAILED_ATTENTION_REASON,
  OPENCLAW_GENERATION_AMBIGUOUS_ATTENTION_REASON,
  OPENCLAW_INBOUND_AMBIGUITY_ATTENTION_REASON,
  OPENCLAW_INBOUND_IDENTITY_AMBIGUITY_ATTENTION_REASON,
  OPENCLAW_ROUND_ID_PREFIX,
  OPENCLAW_STATE_AMBIGUITY_ATTENTION_REASON,
  OPENCLAW_PARTICIPANT_DISPLAY_NAME,
  SUPPORTED_IMAGE_MIME_TYPES
} from "../constants.js";
import type { RoundArtifactStore } from "../round/round-artifact-store.js";
import type { RoundStateStore } from "../round/round-state-store.js";
import type { WorkflowLock } from "../workflow-lock.js";
import type { DiscordChannelAllowlistStore } from "../config/discord-channel-allowlist.js";
import type { InboundMessage } from "./messaging.js";
import {
  InvalidInboundImageError,
  type InboundAttachmentStore
} from "./inbound-attachment-store.js";
import type { ImageGenerator } from "../generation/image-generator.js";
import type { GeneratedResultStore } from "../generation/generated-result-store.js";
import { applyRoundEvent } from "../round/round-state.js";
import type { InboundAmbiguityEvidence } from "./openclaw-message-normalizer.js";

export interface StartFeedbackRoundAction {
  type: "start-feedback-round";
}

export type RequestedRoundAction = StartFeedbackRoundAction;

export class UnsupportedBaseImageError extends Error {
  public constructor() {
    super("Start the round with exactly one supported Base Image.");
    this.name = "UnsupportedBaseImageError";
  }
}

export interface GovernedActionRequest {
  action: RequestedRoundAction;
  source: InboundMessage;
}

export interface DeliverRoundStartDirective {
  type: "deliver-round-start";
  operationId: string;
  roundId: string;
  mediaPath: string;
  caption: string;
}

export interface DeliverCollectionClosedDirective {
  type: "deliver-collection-closed";
  operationId: string;
  roundId: string;
  caption: string;
}

export interface DeliverGenerationOutcomeDirective {
  type: "deliver-generation-outcome";
  operationId: string;
  roundId: string;
  caption: string;
  mediaPath?: string;
}

export interface SynthesisInputDirective {
  roundId: string;
  feedbackTexts: string[];
  contextImageCount: number;
}

export type InboundRoundDirective =
  | { type: "dispatch-to-agent" }
  | {
      type: "claimed";
      roundId: string;
      capturedCount: number;
      requestAgentTurn: boolean;
    }
  | { type: "needs-attention"; roundId: string };

export interface FeedbackRoundCoordinatorDependencies {
  allowlist: DiscordChannelAllowlistStore;
  artifacts: RoundArtifactStore;
  inboundAttachments: InboundAttachmentStore;
  generatedResults: GeneratedResultStore;
  store: RoundStateStore;
  workflowLock: WorkflowLock;
}

export interface ConfirmRoundStartInput {
  roundId: string;
  source: InboundMessage;
  receiptMessageId: string;
}

export interface MarkRoundAttentionInput {
  roundId: string;
  source: InboundMessage;
  cause: "delivery-failed" | "delivery-confirmation-ambiguous";
}

export interface PrepareRoundCompletionInput {
  source: InboundMessage;
  synthesizedPrompt: string;
}

export interface ConfirmRoundDeliveryInput {
  roundId: string;
  source: InboundMessage;
  receiptMessageId: string;
}

export interface GenerateAndPreparePublicationInput {
  roundId: string;
  source: InboundMessage;
  generator: ImageGenerator;
}

export class FeedbackRoundCoordinator {
  public constructor(
    private readonly dependencies: FeedbackRoundCoordinatorDependencies
  ) {}

  public async executeAction(
    request: GovernedActionRequest
  ): Promise<DeliverRoundStartDirective> {
    if (
      request.action.type !== "start-feedback-round" ||
      Object.keys(request.action).length !== 1
    ) {
      if (request.action.type === "start-feedback-round") {
        throw new Error("Feedback Round action contains unsupported fields.");
      }
      throw new Error("Unsupported Feedback Round action.");
    }
    const authorizedChannelUrl = await this.requireAuthorizedSource(request.source);
    const baseImage = requireSingleBaseImage(request.source);
    const roundId = createRoundId(request.source);
    const commandDependencies: CommandDependencies = {
      allowlist: this.dependencies.allowlist,
      artifacts: this.dependencies.artifacts,
      inboundAttachments: this.dependencies.inboundAttachments,
      workflowLock: this.dependencies.workflowLock,
      authorizedChannelUrl
    };
    let prepared;
    try {
      prepared = await executeCommand(
        "prepare-inbound-base-submission",
        {
          roundId,
          stagedPath: baseImage.path,
          mediaType: baseImage.mediaType
        },
        this.dependencies.store,
        commandDependencies
      );
    } catch (error) {
      if (error instanceof InvalidInboundImageError) {
        throw new UnsupportedBaseImageError();
      }
      throw error;
    }
    return requirePreparedRoundStart(prepared, roundId);
  }

  public async handleMessage(source: InboundMessage): Promise<InboundRoundDirective> {
    const authorizedChannelUrl = await this.requireAuthorizedSource(source);
    const active = (await this.dependencies.store.list()).filter(
      (round) => round.channelUrl === authorizedChannelUrl && !isTerminalPhase(round.phase)
    );
    if (active.length === 0) {
      return { type: "dispatch-to-agent" };
    }
    if (active.length !== 1 || !active[0]) {
      throw new Error("Feedback Round collection state is ambiguous.");
    }
    const round = active[0];
    if (round.phase !== "collecting-messages") {
      return {
        type: "claimed",
        roundId: round.id,
        capturedCount: round.capturedMessages.length,
        requestAgentTurn: false
      };
    }
    if (!round?.baseMessageUrl) {
      throw new Error("Feedback Round collection state is ambiguous.");
    }
    const observedMessageUrl = discordMessageUrl(source);
    const result = await executeCommand(
      "collect-messages",
      {
        roundId: round.id,
        boundaryMessageUrl: round.baseMessageUrl,
        messages: [
          {
            kind: source.text.trim().length > 0 ? "ordinary-text" : "attachment-only",
            roundId: round.id,
            boundaryMessageUrl: round.baseMessageUrl,
            messageUrl: observedMessageUrl,
            authorId: source.senderId,
            authorName: OPENCLAW_PARTICIPANT_DISPLAY_NAME,
            timestamp: source.occurredAt,
            text: source.text,
            attachments: source.attachments.map((attachment) => ({
              attachmentIndex: attachment.index,
              mediaType: attachment.mediaType,
              imagePath: attachment.path
            }))
          }
        ]
      },
      this.dependencies.store,
      {
        allowlist: this.dependencies.allowlist,
        artifacts: this.dependencies.artifacts,
        inboundAttachments: this.dependencies.inboundAttachments,
        workflowLock: this.dependencies.workflowLock,
        authorizedChannelUrl
      }
    );
    return parseCollectionDirective(result, round.id, round.messageLimit);
  }

  public async isConfiguredConversation(
    provider: string | undefined,
    conversationId: string | undefined
  ): Promise<boolean> {
    if (provider !== "discord" || typeof conversationId !== "string") {
      return false;
    }
    const channelUrl = await resolveDiscordChannel(this.dependencies.allowlist);
    return new URL(channelUrl).pathname.split("/").filter(Boolean)[2] === conversationId;
  }

  public async handleInboundAmbiguity(
    provider: string | undefined,
    conversationId: string | undefined,
    evidence: InboundAmbiguityEvidence
  ): Promise<void> {
    if (!(await this.isConfiguredConversation(provider, conversationId))) {
      return;
    }
    const authorizedChannelUrl = await resolveDiscordChannel(
      this.dependencies.allowlist
    );
    await this.dependencies.workflowLock.runExclusive(async () => {
      const active = (await this.dependencies.store.list()).filter(
        (round) =>
          round.channelUrl === authorizedChannelUrl &&
          !isTerminalPhase(round.phase)
      );
      if (active.length === 0) {
        return;
      }
      if (active.length > 1) {
        const results = await Promise.allSettled(
          active.map((round) =>
            this.dependencies.store.save(
              applyRoundEvent(round, {
                type: "attention-required",
                reason: OPENCLAW_STATE_AMBIGUITY_ATTENTION_REASON
              })
            )
          )
        );
        if (results.some((result) => result.status === "rejected")) {
          throw new Error("Conflicting Feedback Round state could not be quarantined.");
        }
        return;
      }
      const round = active[0];
      if (!round || round.phase !== "collecting-messages" || !evidence.hasQualifyingText) {
        return;
      }
      if (evidence.category === "media") {
        const acceptedImageCount = round.capturedMessages.reduce(
          (count, message) => count + message.contextImages.length,
          0
        );
        const remainingRoundCapacity = Math.max(
          0,
          FEEDBACK_IMAGE_LIMIT_PER_ROUND - acceptedImageCount
        );
        const selectableImageCount = Math.min(
          FEEDBACK_IMAGE_LIMIT_PER_MESSAGE,
          remainingRoundCapacity,
          evidence.potentialSupportedImageCount
        );
        if (
          selectableImageCount === 0 ||
          evidence.stagedUsableSupportedImageCount >= selectableImageCount
        ) {
          return;
        }
      }
      await this.dependencies.store.save(
        applyRoundEvent(round, {
          type: "attention-required",
          reason:
            evidence.category === "media"
              ? OPENCLAW_INBOUND_AMBIGUITY_ATTENTION_REASON
              : OPENCLAW_INBOUND_IDENTITY_AMBIGUITY_ATTENTION_REASON
        })
      );
    });
  }

  public async confirmRoundStart(input: ConfirmRoundStartInput): Promise<void> {
    const authorizedChannelUrl = await this.requireAuthorizedSource(input.source);
    if (createRoundId(input.source) !== input.roundId) {
      throw new Error("Discord delivery receipt does not match the prepared round.");
    }
    await executeCommand(
      "confirm-base-submission",
      {
        roundId: input.roundId,
        baseMessageUrl: `${authorizedChannelUrl}/${encodeURIComponent(
          input.receiptMessageId
        )}`,
        collectionStartedAt: discordSnowflakeTimestamp(input.receiptMessageId)
      },
      this.dependencies.store,
      {
        allowlist: this.dependencies.allowlist,
        artifacts: this.dependencies.artifacts,
        workflowLock: this.dependencies.workflowLock,
        authorizedChannelUrl
      }
    );
  }

  public async prepareSynthesis(source: InboundMessage): Promise<SynthesisInputDirective> {
    const authorizedChannelUrl = await this.requireAuthorizedSource(source);
    const roundId = await this.requireSingleRoundInPhase(
      authorizedChannelUrl,
      "synthesizing-feedback"
    );
    const prepared = await executeCommand(
      "prepare-prompt-synthesis",
      { roundId },
      this.dependencies.store,
      this.commandDependencies(authorizedChannelUrl)
    );
    if (
      !isRecord(prepared) ||
      prepared.action !== "synthesize-prompt" ||
      prepared.roundId !== roundId ||
      !Array.isArray(prepared.feedbackTexts) ||
      prepared.feedbackTexts.some((text) => typeof text !== "string") ||
      !Array.isArray(prepared.contextImagePaths) ||
      prepared.contextImagePaths.some((path) => typeof path !== "string")
    ) {
      throw new Error("Feedback synthesis preparation returned an unsupported directive.");
    }
    return {
      roundId,
      feedbackTexts: prepared.feedbackTexts as string[],
      contextImageCount: prepared.contextImagePaths.length
    };
  }

  public async prepareRoundCompletion(
    input: PrepareRoundCompletionInput
  ): Promise<DeliverCollectionClosedDirective> {
    const authorizedChannelUrl = await this.requireAuthorizedSource(input.source);
    const roundId = await this.requireSingleRoundInPhase(
      authorizedChannelUrl,
      "synthesizing-feedback"
    );
    const prepared = await executeCommand(
      "confirm-synthesized-prompt",
      { roundId, synthesizedPrompt: input.synthesizedPrompt },
      this.dependencies.store,
      this.commandDependencies(authorizedChannelUrl)
    );
    if (
      !isRecord(prepared) ||
      prepared.action !== "post-collection-closed" ||
      prepared.roundId !== roundId ||
      typeof prepared.operationId !== "string" ||
      typeof prepared.caption !== "string"
    ) {
      throw new Error("Collection close preparation returned an unsupported directive.");
    }
    return {
      type: "deliver-collection-closed",
      operationId: prepared.operationId,
      roundId,
      caption: prepared.caption
    };
  }

  public async confirmCollectionClosed(input: ConfirmRoundDeliveryInput): Promise<void> {
    const authorizedChannelUrl = await this.requireAuthorizedSource(input.source);
    await executeCommand(
      "confirm-collection-closed",
      {
        roundId: input.roundId,
        closedMessageUrl: discordReceiptUrl(authorizedChannelUrl, input.receiptMessageId)
      },
      this.dependencies.store,
      this.commandDependencies(authorizedChannelUrl)
    );
  }

  public async generateAndPreparePublication(
    input: GenerateAndPreparePublicationInput
  ): Promise<DeliverGenerationOutcomeDirective> {
    const authorizedChannelUrl = await this.requireAuthorizedSource(input.source);
    const dependencies = this.commandDependencies(authorizedChannelUrl);
    const prepared = await executeCommand(
      "prepare-generation",
      { roundId: input.roundId },
      this.dependencies.store,
      dependencies
    );
    const generation = requireGenerationDirective(prepared, input.roundId);
    try {
      const baseImagePath = await this.dependencies.artifacts.acceptBaseImage(
        input.roundId,
        generation.baseImagePath
      );
      const result = await input.generator.generate({
        prompt: generation.prompt,
        baseImagePath,
        contextImagePaths: generation.contextImagePaths
      });
      if (result.kind === "succeeded") {
        const resultImagePath = await this.dependencies.generatedResults.stage(
          input.roundId,
          result.bytes,
          result.mediaType
        );
        await executeCommand(
          "confirm-generation",
          { roundId: input.roundId, outcome: "succeeded", resultImagePath },
          this.dependencies.store,
          dependencies
        );
      } else {
        await executeCommand(
          "confirm-generation",
          { roundId: input.roundId, outcome: result.kind },
          this.dependencies.store,
          dependencies
        );
      }
      const publication = await executeCommand(
        "prepare-publication",
        { roundId: input.roundId },
        this.dependencies.store,
        dependencies
      );
      return requirePublicationDirective(publication, input.roundId);
    } catch {
      await executeCommand(
        "mark-attention",
        {
          roundId: input.roundId,
          reason: OPENCLAW_GENERATION_AMBIGUOUS_ATTENTION_REASON
        },
        this.dependencies.store,
        dependencies
      );
      throw new Error("Image generation did not produce an unambiguous outcome.");
    }
  }

  public async confirmPublication(input: ConfirmRoundDeliveryInput): Promise<void> {
    const authorizedChannelUrl = await this.requireAuthorizedSource(input.source);
    await executeCommand(
      "confirm-publication",
      {
        roundId: input.roundId,
        outcomeMessageUrl: discordReceiptUrl(authorizedChannelUrl, input.receiptMessageId)
      },
      this.dependencies.store,
      this.commandDependencies(authorizedChannelUrl)
    );
  }

  public async markAttention(input: MarkRoundAttentionInput): Promise<void> {
    const authorizedChannelUrl = await this.requireAuthorizedSource(input.source);
    await executeCommand(
      "mark-attention",
      {
        roundId: input.roundId,
        reason:
          input.cause === "delivery-failed"
            ? OPENCLAW_DELIVERY_FAILED_ATTENTION_REASON
            : OPENCLAW_DELIVERY_AMBIGUOUS_ATTENTION_REASON
      },
      this.dependencies.store,
      {
        allowlist: this.dependencies.allowlist,
        artifacts: this.dependencies.artifacts,
        workflowLock: this.dependencies.workflowLock,
        authorizedChannelUrl
      }
    );
  }

  private async requireAuthorizedSource(source: InboundMessage): Promise<string> {
    if (source.provider !== "discord" || source.destination.kind !== "discord-channel") {
      throw new Error("Message source is not authorized for Feedback Rounds.");
    }
    const channelUrl = await resolveDiscordChannel(this.dependencies.allowlist);
    const url = new URL(channelUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      parts.length !== 3 ||
      source.destination.guildId !== parts[1] ||
      source.destination.channelId !== parts[2]
    ) {
      throw new Error("Message source is not authorized for Feedback Rounds.");
    }
    return channelUrl;
  }

  private async requireSingleRoundInPhase(
    channelUrl: string,
    phase: "synthesizing-feedback"
  ): Promise<string> {
    const matches = (await this.dependencies.store.list()).filter(
      (round) => round.channelUrl === channelUrl && round.phase === phase
    );
    if (matches.length !== 1 || !matches[0]) {
      throw new Error("Feedback Round state is incomplete or ambiguous.");
    }
    return matches[0].id;
  }

  private commandDependencies(authorizedChannelUrl: string): CommandDependencies {
    return {
      allowlist: this.dependencies.allowlist,
      artifacts: this.dependencies.artifacts,
      inboundAttachments: this.dependencies.inboundAttachments,
      workflowLock: this.dependencies.workflowLock,
      authorizedChannelUrl
    };
  }
}

function isTerminalPhase(phase: string): boolean {
  return phase === "completed" || phase === "stopped" || phase === "needs-attention";
}

function discordSnowflakeTimestamp(messageId: string): string {
  if (!/^\d{15,20}$/.test(messageId)) {
    throw new Error("Discord delivery confirmation is incomplete or ambiguous.");
  }
  const timestampMs = (BigInt(messageId) >> 22n) + DISCORD_SNOWFLAKE_EPOCH_MS;
  const timestamp = new Date(Number(timestampMs));
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("Discord delivery confirmation is incomplete or ambiguous.");
  }
  return timestamp.toISOString();
}

function discordReceiptUrl(channelUrl: string, messageId: string): string {
  discordSnowflakeTimestamp(messageId);
  return `${channelUrl}/${encodeURIComponent(messageId)}`;
}

function requireGenerationDirective(
  value: unknown,
  expectedRoundId: string
): { prompt: string; baseImagePath: string; contextImagePaths: string[] } {
  if (
    !isRecord(value) ||
    value.action !== "generate-image" ||
    value.roundId !== expectedRoundId ||
    typeof value.instruction !== "string" ||
    typeof value.baseImagePath !== "string" ||
    !Array.isArray(value.contextImagePaths) ||
    value.contextImagePaths.some((path) => typeof path !== "string")
  ) {
    throw new Error("Image generation preparation returned an unsupported directive.");
  }
  return {
    prompt: value.instruction,
    baseImagePath: value.baseImagePath,
    contextImagePaths: value.contextImagePaths as string[]
  };
}

function requirePublicationDirective(
  value: unknown,
  expectedRoundId: string
): DeliverGenerationOutcomeDirective {
  if (
    !isRecord(value) ||
    value.roundId !== expectedRoundId ||
    typeof value.operationId !== "string" ||
    typeof value.caption !== "string"
  ) {
    throw new Error("Outcome publication preparation returned an unsupported directive.");
  }
  if (value.action === "post-result-image" && typeof value.resultImagePath === "string") {
    return {
      type: "deliver-generation-outcome",
      operationId: value.operationId,
      roundId: expectedRoundId,
      caption: value.caption,
      mediaPath: value.resultImagePath
    };
  }
  if (value.action === "post-status-message") {
    return {
      type: "deliver-generation-outcome",
      operationId: value.operationId,
      roundId: expectedRoundId,
      caption: value.caption
    };
  }
  throw new Error("Outcome publication preparation returned an unsupported directive.");
}

function discordMessageUrl(source: InboundMessage): string {
  return `https://discord.com/channels/${encodeURIComponent(
    source.destination.guildId
  )}/${encodeURIComponent(source.destination.channelId)}/${encodeURIComponent(
    source.messageId
  )}`;
}

function requireSingleBaseImage(source: InboundMessage) {
  if (
    source.attachments.length !== 1 ||
    !SUPPORTED_IMAGE_MIME_TYPES.some(
      (mediaType) => mediaType === source.attachments[0]?.mediaType
    )
  ) {
    throw new UnsupportedBaseImageError();
  }
  return source.attachments[0] as InboundMessage["attachments"][number];
}

function createRoundId(source: InboundMessage): string {
  const identity = [
    source.provider,
    source.destination.guildId,
    source.destination.channelId,
    source.messageId
  ].join("\0");
  return `${OPENCLAW_ROUND_ID_PREFIX}${createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 24)}`;
}

function requirePreparedRoundStart(
  value: unknown,
  expectedRoundId: string
): DeliverRoundStartDirective {
  if (!isRecord(value)) {
    throw new Error("Round start preparation returned an unsupported directive.");
  }
  const operationId = value.operationId;
  const roundId = value.roundId;
  const mediaPath = value.baseImagePath;
  const caption = value.caption;
  if (
    value.action !== "post-base-image" ||
    typeof operationId !== "string" ||
    roundId !== expectedRoundId ||
    typeof mediaPath !== "string" ||
    typeof caption !== "string"
  ) {
    throw new Error("Round start preparation returned an unsupported directive.");
  }
  return {
    type: "deliver-round-start",
    operationId,
    roundId,
    mediaPath,
    caption
  };
}

function parseCollectionDirective(
  value: unknown,
  expectedRoundId: string,
  messageLimit: number
): InboundRoundDirective {
  if (!isRecord(value) || value.roundId !== expectedRoundId) {
    throw new Error("Message collection returned an unsupported directive.");
  }
  if (
    value.action === "wait" &&
    Number.isInteger(value.capturedCount) &&
    (value.capturedCount as number) >= 0
  ) {
    return {
      type: "claimed",
      roundId: expectedRoundId,
      capturedCount: value.capturedCount as number,
      requestAgentTurn: false
    };
  }
  if (value.action === "synthesize-feedback") {
    return {
      type: "claimed",
      roundId: expectedRoundId,
      capturedCount: messageLimit,
      requestAgentTurn: true
    };
  }
  if (value.action === "needs-attention") {
    return { type: "needs-attention", roundId: expectedRoundId };
  }
  throw new Error("Message collection returned an unsupported directive.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
