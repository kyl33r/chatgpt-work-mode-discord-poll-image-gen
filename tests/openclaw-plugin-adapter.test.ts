import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  registerOpenClawRoundAdapter,
  type OpenClawAdapterApi
} from "../src/openclaw/openclaw-plugin-adapter.js";
import type { ImageGenerator } from "../src/generation/image-generator.js";
import type { OpenClawRoundBridge } from "../src/openclaw/openclaw-round-bridge.js";

describe("OpenClaw plugin adapter", () => {
  it("registers only the three lifecycle hooks and three bounded optional tools", async () => {
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    const toolFactories: Array<(context: unknown) => unknown> = [];
    const api: OpenClawAdapterApi = {
      on(name, handler) {
        hooks.set(name, handler as (...args: unknown[]) => unknown);
      },
      registerTool(factory) {
        toolFactories.push(factory as (context: unknown) => unknown);
      }
    };
    const generator = { generate: vi.fn() } as ImageGenerator;
    const bridge = {
      onMessageReceived: vi.fn(),
      onBeforeDispatch: vi.fn(),
      onMessageSent: vi.fn(),
      startRoundFromCurrentTurn: vi.fn().mockResolvedValue({
        roundId: "ROUND1",
        status: "awaiting-delivery-confirmation"
      }),
      prepareSynthesisFromCurrentTurn: vi.fn().mockResolvedValue({
        roundId: "ROUND1",
        feedbackTexts: ["increase contrast", "add a blue border"],
        contextImageCount: 1
      }),
      completeRoundFromCurrentTurn: vi.fn().mockResolvedValue({
        roundId: "ROUND1",
        status: "completed"
      })
    } as unknown as OpenClawRoundBridge;

    registerOpenClawRoundAdapter(api, bridge, () => generator);

    expect([...hooks.keys()].sort()).toEqual([
      "before_dispatch",
      "message_received",
      "message_sent"
    ]);
    const context = {
      sessionKey: "session-1",
      delivery: { send: vi.fn() }
    };
    const tools = toolFactories.map((factory) => factory(context)) as Array<{
      name: string;
      parameters: { additionalProperties?: boolean };
      execute(toolCallId: string, params: unknown): Promise<unknown>;
    }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "start_image_feedback_round",
      "prepare_image_feedback_synthesis",
      "complete_image_feedback_round"
    ]);
    expect(tools.every((tool) => tool.parameters.additionalProperties === false)).toBe(
      true
    );
    await expect(tools[0]?.execute("call-1", {})).resolves.toMatchObject({
      details: { status: "awaiting-delivery-confirmation" }
    });
    await expect(tools[1]?.execute("call-2", {})).resolves.toMatchObject({
      details: {
        feedbackTexts: ["increase contrast", "add a blue border"],
        contextImageCount: 1
      }
    });
    await expect(
      tools[2]?.execute("call-3", { synthesizedPrompt: "One safe persisted prompt" })
    ).resolves.toMatchObject({
      details: { status: "completed" }
    });
    expect(bridge.startRoundFromCurrentTurn).toHaveBeenCalledWith(context);
    expect(bridge.prepareSynthesisFromCurrentTurn).toHaveBeenCalledWith("session-1");
    expect(bridge.completeRoundFromCurrentTurn).toHaveBeenCalledWith({
      ...context,
      synthesizedPrompt: "One safe persisted prompt",
      generator
    });
  });

  it("declares no capabilities beyond the bounded round tools", async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL(
          "../extensions/image-feedback-round/openclaw.plugin.json",
          import.meta.url
        ),
        "utf8"
      )
    ) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      id: "image-feedback-round",
      enabledByDefault: false,
      contracts: {
        tools: [
          "start_image_feedback_round",
          "prepare_image_feedback_synthesis",
          "complete_image_feedback_round"
        ]
      },
      configSchema: { type: "object", additionalProperties: false }
    });
    expect(Object.keys(manifest)).not.toContain("mcpServers");
    expect(Object.keys(manifest)).not.toContain("skills");
  });
});
