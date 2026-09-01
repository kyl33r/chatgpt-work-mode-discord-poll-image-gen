import { Type } from "typebox";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext
} from "openclaw/plugin-sdk/plugin-entry";

import {
  OPENCLAW_COMPLETE_ROUND_TOOL_DESCRIPTION,
  OPENCLAW_COMPLETE_ROUND_TOOL_LABEL,
  OPENCLAW_COMPLETE_ROUND_TOOL_NAME,
  OPENCLAW_COMPLETE_ROUND_TOOL_RESULT,
  OPENCLAW_PREPARE_SYNTHESIS_TOOL_DESCRIPTION,
  OPENCLAW_PREPARE_SYNTHESIS_TOOL_LABEL,
  OPENCLAW_PREPARE_SYNTHESIS_TOOL_NAME,
  OPENCLAW_PREPARE_SYNTHESIS_TOOL_RESULT,
  OPENCLAW_START_ROUND_TOOL_DESCRIPTION,
  OPENCLAW_START_ROUND_TOOL_LABEL,
  OPENCLAW_START_ROUND_TOOL_NAME,
  OPENCLAW_START_ROUND_REFUSAL_RESULT,
  OPENCLAW_START_ROUND_TOOL_RESULT,
  SYNTHESIZED_PROMPT_MAX_CHARACTERS
} from "../constants.js";
import type { ImageGenerator } from "../generation/image-generator.js";
import { UnsupportedBaseImageError } from "../messaging/feedback-round-coordinator.js";
import type { OpenClawRoundBridge } from "./openclaw-round-bridge.js";

export type OpenClawAdapterApi = Pick<OpenClawPluginApi, "on" | "registerTool">;

export type OpenClawImageGeneratorFactory = (
  context: OpenClawPluginToolContext
) => ImageGenerator;

export function registerOpenClawRoundAdapter(
  api: OpenClawAdapterApi,
  bridge: OpenClawRoundBridge,
  createImageGenerator: OpenClawImageGeneratorFactory
): void {
  api.on("message_received", (event, context) =>
    bridge.onMessageReceived(
      {
        from: event.from,
        content: event.content,
        ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
        ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
        ...(event.senderId === undefined ? {} : { senderId: event.senderId }),
        ...(event.media === undefined
          ? {}
          : {
              media: event.media.map(normalizeMediaFact)
            }),
        ...(event.originalMedia === undefined
          ? {}
          : {
              originalMedia: event.originalMedia.map(normalizeMediaFact)
            }),
        ...(event.mediaStagingPending === undefined
          ? {}
          : { mediaStagingPending: event.mediaStagingPending }),
        ...(event.metadata === undefined ? {} : { metadata: event.metadata })
      },
      {
        channelId: context.channelId,
        ...(context.conversationId === undefined
          ? {}
          : { conversationId: context.conversationId }),
        ...(context.messageId === undefined ? {} : { messageId: context.messageId }),
        ...(context.senderId === undefined ? {} : { senderId: context.senderId }),
        ...(context.sessionKey === undefined ? {} : { sessionKey: context.sessionKey })
      }
    )
  );
  api.on("before_dispatch", (event, context) =>
    bridge.onBeforeDispatch(
      {
        content: event.content,
        ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
        ...(event.sessionKey === undefined ? {} : { sessionKey: event.sessionKey })
      },
      {
        ...(context.messageId === undefined ? {} : { messageId: context.messageId }),
        ...(context.channelId === undefined ? {} : { channelId: context.channelId }),
        ...(context.conversationId === undefined
          ? {}
          : { conversationId: context.conversationId }),
        ...(context.sessionKey === undefined ? {} : { sessionKey: context.sessionKey })
      }
    )
  );
  api.on("message_sent", (event, context) =>
    bridge.onMessageSent(
      {
        to: event.to,
        content: event.content,
        success: event.success,
        ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
        ...(event.sessionKey === undefined ? {} : { sessionKey: event.sessionKey })
      },
      {
        channelId: context.channelId,
        ...(context.conversationId === undefined
          ? {}
          : { conversationId: context.conversationId }),
        ...(context.sessionKey === undefined ? {} : { sessionKey: context.sessionKey })
      }
    )
  );
  api.registerTool(
    (context) => ({
      name: OPENCLAW_START_ROUND_TOOL_NAME,
      label: OPENCLAW_START_ROUND_TOOL_LABEL,
      description: OPENCLAW_START_ROUND_TOOL_DESCRIPTION,
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        requireEmptyParameters(params);
        try {
          const result = await bridge.startRoundFromCurrentTurn(context);
          return {
            content: [{ type: "text", text: OPENCLAW_START_ROUND_TOOL_RESULT }],
            details: result
          };
        } catch (error) {
          if (error instanceof UnsupportedBaseImageError) {
            return {
              content: [
                { type: "text", text: OPENCLAW_START_ROUND_REFUSAL_RESULT }
              ],
              details: { status: "refused" as const }
            };
          }
          throw error;
        }
      }
    }),
    { optional: true }
  );
  api.registerTool(
    (context) => ({
      name: OPENCLAW_PREPARE_SYNTHESIS_TOOL_NAME,
      label: OPENCLAW_PREPARE_SYNTHESIS_TOOL_LABEL,
      description: OPENCLAW_PREPARE_SYNTHESIS_TOOL_DESCRIPTION,
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        requireEmptyParameters(params);
        const result = await bridge.prepareSynthesisFromCurrentTurn(
          context.sessionKey
        );
        return {
          content: [
            {
              type: "text",
              text: `${OPENCLAW_PREPARE_SYNTHESIS_TOOL_RESULT}\n${JSON.stringify({
                feedbackTexts: result.feedbackTexts,
                contextImageCount: result.contextImageCount
              })}`
            }
          ],
          details: result
        };
      }
    }),
    { optional: true }
  );
  api.registerTool(
    (context) => ({
      name: OPENCLAW_COMPLETE_ROUND_TOOL_NAME,
      label: OPENCLAW_COMPLETE_ROUND_TOOL_LABEL,
      description: OPENCLAW_COMPLETE_ROUND_TOOL_DESCRIPTION,
      parameters: Type.Object(
        {
          synthesizedPrompt: Type.String({
            minLength: 1,
            maxLength: SYNTHESIZED_PROMPT_MAX_CHARACTERS
          })
        },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, params) {
        const synthesizedPrompt = requireSynthesizedPrompt(params);
        const result = await bridge.completeRoundFromCurrentTurn({
          ...(context.sessionKey === undefined
            ? {}
            : { sessionKey: context.sessionKey }),
          ...(context.delivery === undefined ? {} : { delivery: context.delivery }),
          synthesizedPrompt,
          generator: createImageGenerator(context)
        });
        return {
          content: [{ type: "text", text: OPENCLAW_COMPLETE_ROUND_TOOL_RESULT }],
          details: result
        };
      }
    }),
    { optional: true }
  );
}

function normalizeMediaFact(media: {
  path?: string | undefined;
  contentType?: string | undefined;
  kind?: string | undefined;
  messageId?: string | undefined;
}) {
  return {
    ...(media.path === undefined ? {} : { path: media.path }),
    ...(media.contentType === undefined ? {} : { contentType: media.contentType }),
    ...(media.kind === undefined ? {} : { kind: media.kind }),
    ...(media.messageId === undefined ? {} : { messageId: media.messageId })
  };
}

function requireEmptyParameters(value: unknown): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 0
  ) {
    throw new Error("The round-start tool does not accept model-supplied fields.");
  }
}

function requireSynthesizedPrompt(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("synthesizedPrompt" in value) ||
    typeof value.synthesizedPrompt !== "string" ||
    value.synthesizedPrompt.length < 1 ||
    value.synthesizedPrompt.length > SYNTHESIZED_PROMPT_MAX_CHARACTERS
  ) {
    throw new Error("The round-completion tool accepts only one synthesized prompt.");
  }
  return value.synthesizedPrompt;
}
