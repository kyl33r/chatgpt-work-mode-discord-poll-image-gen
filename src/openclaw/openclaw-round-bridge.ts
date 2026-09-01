import {
  OPENCLAW_CORRELATION_ENTRY_LIMIT,
  OPENCLAW_DELIVERY_CONFIRMATION_TIMEOUT_MS,
  OPENCLAW_SYNTHESIS_TURN_INSTRUCTION
} from "../constants.js";
import type {
  ConfirmRoundDeliveryInput,
  ConfirmRoundStartInput,
  DeliverCollectionClosedDirective,
  DeliverGenerationOutcomeDirective,
  DeliverRoundStartDirective,
  GenerateAndPreparePublicationInput,
  GovernedActionRequest,
  InboundRoundDirective,
  MarkRoundAttentionInput,
  PrepareRoundCompletionInput,
  SynthesisInputDirective
} from "../messaging/feedback-round-coordinator.js";
import type { InboundMessage } from "../messaging/messaging.js";
import type { ImageGenerator } from "../generation/image-generator.js";
import {
  normalizeOpenClawMessage,
  type OpenClawMessageContext,
  type OpenClawMessageEvent
} from "../messaging/openclaw-message-normalizer.js";

export interface OpenClawRoundCoordinatorPort {
  executeAction(request: GovernedActionRequest): Promise<DeliverRoundStartDirective>;
  handleMessage(source: InboundMessage): Promise<InboundRoundDirective>;
  handleInboundAmbiguity(
    provider: string | undefined,
    conversationId: string | undefined
  ): Promise<void>;
  isConfiguredConversation(
    provider: string | undefined,
    conversationId: string | undefined
  ): Promise<boolean>;
  confirmRoundStart(input: ConfirmRoundStartInput): Promise<void>;
  markAttention(input: MarkRoundAttentionInput): Promise<void>;
  prepareSynthesis(source: InboundMessage): Promise<SynthesisInputDirective>;
  prepareRoundCompletion(
    input: PrepareRoundCompletionInput
  ): Promise<DeliverCollectionClosedDirective>;
  confirmCollectionClosed(input: ConfirmRoundDeliveryInput): Promise<void>;
  generateAndPreparePublication(
    input: GenerateAndPreparePublicationInput
  ): Promise<DeliverGenerationOutcomeDirective>;
  confirmPublication(input: ConfirmRoundDeliveryInput): Promise<void>;
}

export interface OpenClawInboundContext extends OpenClawMessageContext {
  sessionKey?: string;
}

export interface OpenClawBeforeDispatchEvent {
  messageId?: string;
  content: string;
  sessionKey?: string;
}

export interface OpenClawBeforeDispatchContext {
  messageId?: string;
  channelId?: string;
  conversationId?: string;
  sessionKey?: string;
}

export interface OpenClawMessageSentEvent {
  to: string;
  content: string;
  success: boolean;
  messageId?: string;
  sessionKey?: string;
}

export interface OpenClawMessageSentContext {
  channelId: string;
  conversationId?: string;
  sessionKey?: string;
}

export interface CurrentTurnDelivery {
  send(params: { text?: string; mediaUrl?: string }): Promise<void>;
}

export interface CurrentTurnContext {
  sessionKey?: string;
  delivery?: CurrentTurnDelivery;
}

export interface CompleteCurrentTurnContext extends CurrentTurnContext {
  synthesizedPrompt: string;
  generator: ImageGenerator;
}

type InboundEvaluation =
  | { type: "evaluated"; directive: InboundRoundDirective; source: InboundMessage }
  | { type: "ambiguous" };

interface CurrentTurnSource {
  messageId: string;
  source: InboundMessage;
  status: "ready" | "starting" | "started" | "completing" | "completed";
}

type DeliverableDirective =
  | DeliverRoundStartDirective
  | DeliverCollectionClosedDirective
  | DeliverGenerationOutcomeDirective;

interface PendingDelivery {
  kind: "round-start" | "collection-closed" | "generation-outcome";
  directive: DeliverableDirective;
  source: InboundMessage;
  resolve?: () => void;
  reject?: (error: Error) => void;
  timeout?: NodeJS.Timeout;
}

export class OpenClawRoundBridge {
  private readonly inbound = new Map<string, Promise<InboundEvaluation>>();
  private readonly currentTurns = new Map<string, CurrentTurnSource>();
  private readonly pendingDeliveries = new Map<string, PendingDelivery>();

  public constructor(private readonly coordinator: OpenClawRoundCoordinatorPort) {}

  public async onMessageReceived(
    event: OpenClawMessageEvent,
    context: OpenClawInboundContext
  ): Promise<void> {
    const correlation = inboundCorrelation(event.messageId, context.messageId, context.sessionKey);
    if (!correlation) {
      return;
    }
    const evaluation = this.evaluateInbound(event, context);
    rememberBounded(this.inbound, correlation, evaluation);
    await evaluation;
  }

  public async onBeforeDispatch(
    event: OpenClawBeforeDispatchEvent,
    context: OpenClawBeforeDispatchContext
  ): Promise<{ handled: true } | { handled: false; text: string } | undefined> {
    const configured = await this.isConfiguredOrFailClosed(
      context.channelId,
      context.conversationId
    );
    if (!configured) {
      return context.channelId === "discord" ? { handled: true } : undefined;
    }
    const correlation = inboundCorrelation(event.messageId, context.messageId, context.sessionKey);
    if (!correlation || event.sessionKey !== context.sessionKey) {
      return { handled: true };
    }
    const pending = this.inbound.get(correlation);
    if (!pending) {
      return { handled: true };
    }
    const evaluation = await pending;
    this.inbound.delete(correlation);
    if (evaluation.type === "ambiguous") {
      return { handled: true };
    }
    if (evaluation.directive.type === "dispatch-to-agent") {
      rememberBounded(this.currentTurns, context.sessionKey, {
        messageId: evaluation.source.messageId,
        source: evaluation.source,
        status: "ready"
      });
      return undefined;
    }
    if (
      evaluation.directive.type === "claimed" &&
      evaluation.directive.requestAgentTurn
    ) {
      rememberBounded(this.currentTurns, context.sessionKey, {
        messageId: evaluation.source.messageId,
        source: evaluation.source,
        status: "ready"
      });
      return { handled: false, text: OPENCLAW_SYNTHESIS_TURN_INSTRUCTION };
    }
    return { handled: true };
  }

  public async startRoundFromCurrentTurn(
    context: CurrentTurnContext
  ): Promise<{ roundId: string; status: "awaiting-delivery-confirmation" }> {
    if (!context.sessionKey || !context.delivery) {
      throw new Error("The current messaging turn does not expose a trusted delivery route.");
    }
    const turn = this.currentTurns.get(context.sessionKey);
    if (!turn) {
      throw new Error("No verified inbound Discord turn is available for this action.");
    }
    if (turn.status !== "ready") {
      throw new Error("This inbound turn has already started a Feedback Round.");
    }
    turn.status = "starting";
    const directive = await this.coordinator.executeAction({
      action: { type: "start-feedback-round" },
      source: turn.source
    });
    turn.status = "started";
    await this.deliver(context.sessionKey, context.delivery, {
      kind: "round-start",
      directive,
      source: turn.source
    }, false);
    return {
      roundId: directive.roundId,
      status: "awaiting-delivery-confirmation"
    };
  }

  public async prepareSynthesisFromCurrentTurn(
    sessionKey: string | undefined
  ): Promise<SynthesisInputDirective> {
    const turn = this.requireReadyTurn(sessionKey);
    return this.coordinator.prepareSynthesis(turn.source);
  }

  public async completeRoundFromCurrentTurn(
    context: CompleteCurrentTurnContext
  ): Promise<{ roundId: string; status: "completed" }> {
    if (!context.sessionKey || !context.delivery) {
      throw new Error("The current messaging turn does not expose a trusted delivery route.");
    }
    const turn = this.requireReadyTurn(context.sessionKey);
    turn.status = "completing";
    const close = await this.coordinator.prepareRoundCompletion({
      source: turn.source,
      synthesizedPrompt: context.synthesizedPrompt
    });
    await this.deliver(
      context.sessionKey,
      context.delivery,
      { kind: "collection-closed", directive: close, source: turn.source },
      true
    );
    const publication = await this.coordinator.generateAndPreparePublication({
      roundId: close.roundId,
      source: turn.source,
      generator: context.generator
    });
    await this.deliver(
      context.sessionKey,
      context.delivery,
      { kind: "generation-outcome", directive: publication, source: turn.source },
      true
    );
    turn.status = "completed";
    return { roundId: close.roundId, status: "completed" };
  }

  public async onMessageSent(
    event: OpenClawMessageSentEvent,
    context: OpenClawMessageSentContext
  ): Promise<void> {
    if (
      !context.sessionKey ||
      event.sessionKey !== context.sessionKey ||
      context.channelId !== "discord"
    ) {
      return;
    }
    const pending = this.pendingDeliveries.get(context.sessionKey);
    if (
      !pending ||
      context.conversationId !== pending.source.destination.channelId ||
      event.content !== pending.directive.caption
    ) {
      return;
    }
    if (event.to !== pending.source.destination.channelId) {
      this.pendingDeliveries.delete(context.sessionKey);
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      await this.failPendingDelivery(
        pending,
        "delivery-confirmation-ambiguous"
      );
      return;
    }
    this.pendingDeliveries.delete(context.sessionKey);
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (!event.success || !event.messageId) {
      await this.failPendingDelivery(
        pending,
        event.success ? "delivery-confirmation-ambiguous" : "delivery-failed"
      );
      return;
    }
    try {
      const confirmation = {
        roundId: pending.directive.roundId,
        source: pending.source,
        receiptMessageId: event.messageId
      };
      if (pending.kind === "round-start") {
        await this.coordinator.confirmRoundStart(confirmation);
      } else if (pending.kind === "collection-closed") {
        await this.coordinator.confirmCollectionClosed(confirmation);
      } else {
        await this.coordinator.confirmPublication(confirmation);
      }
      pending.resolve?.();
    } catch {
      await this.failPendingDelivery(pending, "delivery-confirmation-ambiguous");
    }
  }

  private requireReadyTurn(sessionKey: string | undefined): CurrentTurnSource {
    if (!sessionKey) {
      throw new Error("No verified inbound Discord turn is available for this action.");
    }
    const turn = this.currentTurns.get(sessionKey);
    if (!turn || turn.status !== "ready") {
      throw new Error("No verified inbound Discord turn is available for this action.");
    }
    return turn;
  }

  private async deliver(
    sessionKey: string,
    delivery: CurrentTurnDelivery,
    pending: Omit<PendingDelivery, "resolve" | "reject" | "timeout">,
    waitForConfirmation: boolean
  ): Promise<void> {
    if (this.pendingDeliveries.has(sessionKey)) {
      throw new Error("A Discord delivery confirmation is already pending for this session.");
    }
    let confirmation: Promise<void> | undefined;
    const tracked: PendingDelivery = { ...pending };
    if (waitForConfirmation) {
      confirmation = new Promise<void>((resolvePromise, reject) => {
        tracked.resolve = resolvePromise;
        tracked.reject = reject;
      });
    }
    tracked.timeout = setTimeout(() => {
      void this.timeoutPendingDelivery(sessionKey, tracked);
    }, OPENCLAW_DELIVERY_CONFIRMATION_TIMEOUT_MS);
    tracked.timeout.unref?.();
    this.pendingDeliveries.set(sessionKey, tracked);
    try {
      await delivery.send({
        text: tracked.directive.caption,
        ...("mediaPath" in tracked.directive && tracked.directive.mediaPath
          ? { mediaUrl: tracked.directive.mediaPath }
          : {})
      });
    } catch {
      this.pendingDeliveries.delete(sessionKey);
      if (tracked.timeout) {
        clearTimeout(tracked.timeout);
      }
      await this.coordinator.markAttention({
        roundId: tracked.directive.roundId,
        source: tracked.source,
        cause: "delivery-failed"
      });
      throw new Error("Discord delivery did not complete; the round needs attention.");
    }
    await confirmation;
  }

  private async timeoutPendingDelivery(
    sessionKey: string,
    pending: PendingDelivery
  ): Promise<void> {
    if (this.pendingDeliveries.get(sessionKey) !== pending) {
      return;
    }
    this.pendingDeliveries.delete(sessionKey);
    await this.failPendingDelivery(pending, "delivery-confirmation-ambiguous");
  }

  private async failPendingDelivery(
    pending: PendingDelivery,
    cause: MarkRoundAttentionInput["cause"]
  ): Promise<void> {
    try {
      await this.coordinator.markAttention({
        roundId: pending.directive.roundId,
        source: pending.source,
        cause
      });
    } finally {
      pending.reject?.(
        new Error("Discord delivery confirmation is incomplete or ambiguous.")
      );
    }
  }

  private async evaluateInbound(
    event: OpenClawMessageEvent,
    context: OpenClawInboundContext
  ): Promise<InboundEvaluation> {
    try {
      const source = normalizeOpenClawMessage(event, context);
      return {
        type: "evaluated",
        directive: await this.coordinator.handleMessage(source),
        source
      };
    } catch {
      await this.coordinator
        .handleInboundAmbiguity(context.channelId, context.conversationId)
        .catch(() => undefined);
      return { type: "ambiguous" };
    }
  }

  private async isConfiguredOrFailClosed(
    provider: string | undefined,
    conversationId: string | undefined
  ): Promise<boolean> {
    try {
      return await this.coordinator.isConfiguredConversation(provider, conversationId);
    } catch {
      return provider === "discord";
    }
  }
}

function inboundCorrelation(
  eventMessageId: string | undefined,
  contextMessageId: string | undefined,
  sessionKey: string | undefined
): string | undefined {
  if (
    !eventMessageId ||
    !contextMessageId ||
    eventMessageId !== contextMessageId ||
    !sessionKey
  ) {
    return undefined;
  }
  return `${sessionKey}\0${eventMessageId}`;
}

function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key) && map.size >= OPENCLAW_CORRELATION_ENTRY_LIMIT) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
  map.set(key, value);
}
