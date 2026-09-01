import { Type } from "typebox";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";

import {
  OPENCLAW_COMPLETE_ROUND_TOOL_DESCRIPTION,
  OPENCLAW_COMPLETE_ROUND_TOOL_NAME,
  OPENCLAW_COMPLETE_ROUND_TOOL_RESULT,
  OPENCLAW_PREPARE_SYNTHESIS_TOOL_DESCRIPTION,
  OPENCLAW_PREPARE_SYNTHESIS_TOOL_NAME,
  OPENCLAW_PREPARE_SYNTHESIS_TOOL_RESULT,
  OPENCLAW_START_ROUND_TOOL_DESCRIPTION,
  OPENCLAW_START_ROUND_TOOL_NAME,
  OPENCLAW_START_ROUND_TOOL_RESULT,
  SYNTHESIZED_PROMPT_MAX_CHARACTERS
} from "../constants.js";
import type { ImageGenerator } from "../generation/image-generator.js";
import type {
  OpenClawBeforeDispatchContext,
  OpenClawBeforeDispatchEvent,
  OpenClawInboundContext,
  OpenClawMessageSentContext,
  OpenClawMessageSentEvent,
  OpenClawRoundBridge
} from "./openclaw-round-bridge.js";
import type { OpenClawMessageEvent } from "../messaging/openclaw-message-normalizer.js";

type AdapterHookName = "message_received" | "before_dispatch" | "message_sent";

interface OpenClawToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}

interface OpenClawAgentTool {
  name: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<OpenClawToolResult>;
}

export interface OpenClawAdapterApi {
  on(
    name: AdapterHookName,
    handler: (event: never, context: never) => Promise<unknown> | unknown
  ): void;
  registerTool(
    factory: (context: OpenClawPluginToolContext) => OpenClawAgentTool,
    options?: { optional?: boolean }
  ): void;
}

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
      event as OpenClawMessageEvent,
      context as OpenClawInboundContext
    )
  );
  api.on("before_dispatch", (event, context) =>
    bridge.onBeforeDispatch(
      event as OpenClawBeforeDispatchEvent,
      context as OpenClawBeforeDispatchContext
    )
  );
  api.on("message_sent", (event, context) =>
    bridge.onMessageSent(
      event as OpenClawMessageSentEvent,
      context as OpenClawMessageSentContext
    )
  );
  api.registerTool(
    (context) => ({
      name: OPENCLAW_START_ROUND_TOOL_NAME,
      description: OPENCLAW_START_ROUND_TOOL_DESCRIPTION,
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        requireEmptyParameters(params);
        const result = await bridge.startRoundFromCurrentTurn(context);
        return {
          content: [{ type: "text", text: OPENCLAW_START_ROUND_TOOL_RESULT }],
          details: result
        };
      }
    }),
    { optional: true }
  );
  api.registerTool(
    (context) => ({
      name: OPENCLAW_PREPARE_SYNTHESIS_TOOL_NAME,
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
