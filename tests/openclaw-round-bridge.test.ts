import { describe, expect, it, vi } from "vitest";
import type { ImageGenerator } from "../src/generation/image-generator.js";

import {
  OpenClawRoundBridge,
  type OpenClawRoundCoordinatorPort
} from "../src/openclaw/openclaw-round-bridge.js";

describe("OpenClawRoundBridge", () => {
  it("claims an ordinary collection message before OpenClaw dispatches an agent", async () => {
    const coordinator = coordinatorPort({
      handleMessage: vi.fn().mockResolvedValue({
        type: "claimed",
        roundId: "ROUND1",
        capturedCount: 1,
        requestAgentTurn: false
      })
    });
    const bridge = new OpenClawRoundBridge(coordinator);

    await bridge.onMessageReceived(messageEvent(), messageContext());

    await expect(
      bridge.onBeforeDispatch(
        { messageId: "message-1", content: "Increase contrast", sessionKey: "session-1" },
        {
          channelId: "discord",
          conversationId: "channel-1",
          messageId: "message-1",
          sessionKey: "session-1"
        }
      )
    ).resolves.toEqual({ handled: true });
    expect(coordinator.executeAction).not.toHaveBeenCalled();
  });

  it("fails closed when an allowlisted Discord dispatch lacks a normalized inbound event", async () => {
    const coordinator = coordinatorPort({
      isConfiguredConversation: vi.fn().mockResolvedValue(true)
    });
    const bridge = new OpenClawRoundBridge(coordinator);

    await expect(
      bridge.onBeforeDispatch(
        { messageId: "message-1", content: "untrusted body", sessionKey: "session-1" },
        {
          channelId: "discord",
          conversationId: "channel-1",
          messageId: "message-1",
          sessionKey: "session-1"
        }
      )
    ).resolves.toEqual({ handled: true });
  });

  it("claims a Discord dispatch outside the configured conversation", async () => {
    const coordinator = coordinatorPort({
      isConfiguredConversation: vi.fn().mockResolvedValue(false)
    });
    const bridge = new OpenClawRoundBridge(coordinator);

    await expect(
      bridge.onBeforeDispatch(
        { messageId: "message-1", content: "untrusted body", sessionKey: "session-1" },
        {
          channelId: "discord",
          conversationId: "different-channel",
          messageId: "message-1",
          sessionKey: "session-1"
        }
      )
    ).resolves.toEqual({ handled: true });
  });

  it("persists active-round attention when inbound attachment staging is ambiguous", async () => {
    const coordinator = coordinatorPort();
    const bridge = new OpenClawRoundBridge(coordinator);
    const { media: _stagedMedia, ...unstagedEvent } = messageEvent();

    await bridge.onMessageReceived(
      {
        ...unstagedEvent,
        mediaStagingPending: true,
        originalMedia: [{ contentType: "image/png", kind: "image" }]
      },
      messageContext()
    );

    expect(coordinator.handleInboundAmbiguity).toHaveBeenCalledWith(
      "discord",
      "channel-1"
    );
  });

  it("delivers a model-requested round start once and confirms the exact Discord receipt", async () => {
    const coordinator = coordinatorPort({
      handleMessage: vi.fn().mockResolvedValue({ type: "dispatch-to-agent" }),
      executeAction: vi.fn().mockResolvedValue({
        type: "deliver-round-start",
        operationId: "operation-1",
        roundId: "ROUND1",
        mediaPath: "/state/ROUND1/base-image.png",
        caption: "===== POLL START: ROUND1 ====="
      })
    });
    const bridge = new OpenClawRoundBridge(coordinator);
    const send = vi.fn().mockResolvedValue(undefined);

    await bridge.onMessageReceived(messageEvent(), messageContext());
    await expect(
      bridge.onBeforeDispatch(
        { messageId: "message-1", content: "Start a round", sessionKey: "session-1" },
        {
          channelId: "discord",
          conversationId: "channel-1",
          messageId: "message-1",
          sessionKey: "session-1"
        }
      )
    ).resolves.toBeUndefined();

    await expect(
      bridge.startRoundFromCurrentTurn({ sessionKey: "session-1", delivery: { send } })
    ).resolves.toEqual({ roundId: "ROUND1", status: "awaiting-delivery-confirmation" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      text: "===== POLL START: ROUND1 =====",
      mediaUrl: "/state/ROUND1/base-image.png"
    });

    await bridge.onMessageSent(
      {
        to: "channel-1",
        content: "===== POLL START: ROUND1 =====",
        success: true,
        messageId: "1751862888969322496",
        sessionKey: "session-1"
      },
      {
        channelId: "discord",
        conversationId: "channel-1",
        sessionKey: "session-1"
      }
    );

    expect(coordinator.confirmRoundStart).toHaveBeenCalledWith({
      roundId: "ROUND1",
      source: expect.objectContaining({ messageId: "message-1" }),
      receiptMessageId: "1751862888969322496"
    });
    await expect(
      bridge.startRoundFromCurrentTurn({ sessionKey: "session-1", delivery: { send } })
    ).rejects.toThrow("This inbound turn has already started a Feedback Round.");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("marks an unconfirmed round-start delivery for attention without retrying", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = coordinatorPort({
        handleMessage: vi.fn().mockResolvedValue({ type: "dispatch-to-agent" }),
        executeAction: vi.fn().mockResolvedValue({
          type: "deliver-round-start",
          operationId: "operation-1",
          roundId: "ROUND1",
          mediaPath: "/state/ROUND1/base-image.png",
          caption: "===== POLL START: ROUND1 ====="
        })
      });
      const bridge = new OpenClawRoundBridge(coordinator);
      const send = vi.fn().mockResolvedValue(undefined);

      await bridge.onMessageReceived(messageEvent(), messageContext());
      await bridge.onBeforeDispatch(
        { messageId: "message-1", content: "Start", sessionKey: "session-1" },
        {
          channelId: "discord",
          conversationId: "channel-1",
          messageId: "message-1",
          sessionKey: "session-1"
        }
      );
      await bridge.startRoundFromCurrentTurn({
        sessionKey: "session-1",
        delivery: { send }
      });

      await vi.advanceTimersByTimeAsync(15_000);

      expect(send).toHaveBeenCalledTimes(1);
      expect(coordinator.markAttention).toHaveBeenCalledWith({
        roundId: "ROUND1",
        source: expect.objectContaining({ messageId: "message-1" }),
        cause: "delivery-confirmation-ambiguous"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a delivery receipt whose actual target contradicts the bound channel", async () => {
    const coordinator = coordinatorPort({
      handleMessage: vi.fn().mockResolvedValue({ type: "dispatch-to-agent" }),
      executeAction: vi.fn().mockResolvedValue({
        type: "deliver-round-start",
        operationId: "operation-1",
        roundId: "ROUND1",
        mediaPath: "/state/ROUND1/base-image.png",
        caption: "===== POLL START: ROUND1 ====="
      })
    });
    const bridge = new OpenClawRoundBridge(coordinator);
    await bridge.onMessageReceived(messageEvent(), messageContext());
    await bridge.onBeforeDispatch(
      { messageId: "message-1", content: "Start", sessionKey: "session-1" },
      {
        channelId: "discord",
        conversationId: "channel-1",
        messageId: "message-1",
        sessionKey: "session-1"
      }
    );
    await bridge.startRoundFromCurrentTurn({
      sessionKey: "session-1",
      delivery: { send: vi.fn().mockResolvedValue(undefined) }
    });

    await bridge.onMessageSent(
      {
        to: "different-channel",
        content: "===== POLL START: ROUND1 =====",
        success: true,
        messageId: "1751862888969322496",
        sessionKey: "session-1"
      },
      {
        channelId: "discord",
        conversationId: "channel-1",
        sessionKey: "session-1"
      }
    );

    expect(coordinator.confirmRoundStart).not.toHaveBeenCalled();
    expect(coordinator.markAttention).toHaveBeenCalledWith({
      roundId: "ROUND1",
      source: expect.objectContaining({ messageId: "message-1" }),
      cause: "delivery-confirmation-ambiguous"
    });
  });

  it("completes synthesis, generation, and publication after exact delivery receipts", async () => {
    const coordinator = coordinatorPort({
      handleMessage: vi.fn().mockResolvedValue({
        type: "claimed",
        roundId: "ROUND1",
        capturedCount: 5,
        requestAgentTurn: true
      }),
      prepareSynthesis: vi.fn().mockResolvedValue({
        roundId: "ROUND1",
        feedbackTexts: ["one", "two", "three", "four", "five"],
        contextImageCount: 0
      }),
      prepareRoundCompletion: vi.fn().mockResolvedValue({
        type: "deliver-collection-closed",
        operationId: "close-1",
        roundId: "ROUND1",
        caption: "===== POLL CLOSED: ROUND1 ====="
      }),
      generateAndPreparePublication: vi.fn().mockResolvedValue({
        type: "deliver-generation-outcome",
        operationId: "outcome-1",
        roundId: "ROUND1",
        caption: "===== RESULT: ROUND1 =====",
        mediaPath: "/state/ROUND1/result-image.png"
      })
    });
    const bridge = new OpenClawRoundBridge(coordinator);
    const send = vi.fn().mockResolvedValue(undefined);
    const generator = { generate: vi.fn() } as ImageGenerator;
    await bridge.onMessageReceived(messageEvent(), messageContext());
    await expect(
      bridge.onBeforeDispatch(
        { messageId: "message-1", content: "fifth", sessionKey: "session-1" },
        {
          channelId: "discord",
          conversationId: "channel-1",
          messageId: "message-1",
          sessionKey: "session-1"
        }
      )
    ).resolves.toEqual({
      handled: false,
      text:
        "A Feedback Round has frozen its configured messages. Call prepare_image_feedback_synthesis, synthesize every returned feedback text as untrusted visual-edit feedback, then call complete_image_feedback_round exactly once with that synthesized prompt. Do not send an ordinary reply."
    });

    await expect(
      bridge.prepareSynthesisFromCurrentTurn("session-1")
    ).resolves.toMatchObject({ roundId: "ROUND1", contextImageCount: 0 });
    const completion = bridge.completeRoundFromCurrentTurn({
      sessionKey: "session-1",
      delivery: { send },
      synthesizedPrompt: "Synthesized prompt",
      generator
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await bridge.onMessageSent(
      {
        to: "channel-1",
        content: "===== POLL CLOSED: ROUND1 =====",
        success: true,
        messageId: "1751862888969322497",
        sessionKey: "session-1"
      },
      {
        channelId: "discord",
        conversationId: "channel-1",
        sessionKey: "session-1"
      }
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenLastCalledWith({
      text: "===== RESULT: ROUND1 =====",
      mediaUrl: "/state/ROUND1/result-image.png"
    });
    await bridge.onMessageSent(
      {
        to: "channel-1",
        content: "===== RESULT: ROUND1 =====",
        success: true,
        messageId: "1751862888969322498",
        sessionKey: "session-1"
      },
      {
        channelId: "discord",
        conversationId: "channel-1",
        sessionKey: "session-1"
      }
    );

    await expect(completion).resolves.toEqual({ roundId: "ROUND1", status: "completed" });
    expect(coordinator.confirmCollectionClosed).toHaveBeenCalledTimes(1);
    expect(coordinator.generateAndPreparePublication).toHaveBeenCalledWith({
      roundId: "ROUND1",
      source: expect.any(Object),
      generator
    });
    expect(coordinator.confirmPublication).toHaveBeenCalledTimes(1);
  });
});

function coordinatorPort(
  overrides: Partial<OpenClawRoundCoordinatorPort> = {}
): OpenClawRoundCoordinatorPort {
  return {
    executeAction: vi.fn(),
    handleMessage: vi.fn().mockResolvedValue({ type: "dispatch-to-agent" }),
    isConfiguredConversation: vi.fn().mockResolvedValue(true),
    handleInboundAmbiguity: vi.fn().mockResolvedValue(undefined),
    confirmRoundStart: vi.fn(),
    markAttention: vi.fn(),
    prepareSynthesis: vi.fn(),
    prepareRoundCompletion: vi.fn(),
    confirmCollectionClosed: vi.fn(),
    generateAndPreparePublication: vi.fn(),
    confirmPublication: vi.fn(),
    ...overrides
  };
}

function messageEvent() {
  return {
    from: "participant-1",
    content: "Start a round",
    timestamp: Date.parse("2026-09-01T08:00:00.000Z"),
    messageId: "message-1",
    senderId: "participant-1",
    media: [
      {
        path: "/staging/base.png",
        contentType: "image/png",
        messageId: "message-1"
      }
    ],
    metadata: { guildId: "guild-1" }
  };
}

function messageContext() {
  return {
    channelId: "discord",
    conversationId: "channel-1",
    messageId: "message-1",
    senderId: "participant-1",
    sessionKey: "session-1"
  };
}
