import { describe, expect, it } from "vitest";

import { applyRoundEvent, createRound } from "../src/round/round-state.js";

describe("round state", () => {
  it("allows only the documented phase sequence", () => {
    const draft = createRound({
      id: "R001",
      baseImagePath: "/tmp/base.png",
      channelUrl: "https://discord.test/channels/one"
    });

    const submitting = applyRoundEvent(draft, { type: "base-submission-started" });
    const collecting = applyRoundEvent(submitting, {
      type: "base-submission-confirmed",
      baseMessageUrl: "https://discord.test/messages/base",
      feedbackOpensAt: "2026-08-24T10:00:00.000Z",
      feedbackClosesAt: "2026-08-24T11:00:00.000Z"
    });

    expect(collecting.phase).toBe("collecting-feedback");
    expect(collecting.baseMessageUrl).toBe("https://discord.test/messages/base");
    expect(() => applyRoundEvent(collecting, { type: "base-submission-started" })).toThrow(
      "Invalid round transition"
    );
  });

  it("records every externally visible boundary before completing a round", () => {
    let round = createRound({
      id: "R002",
      baseImagePath: "/tmp/base.png",
      channelUrl: "https://discord.test/channels/one"
    });
    round = applyRoundEvent(round, { type: "base-submission-started" });
    round = applyRoundEvent(round, {
      type: "base-submission-confirmed",
      baseMessageUrl: "https://discord.test/messages/base",
      feedbackOpensAt: "2026-08-24T10:00:00.000Z",
      feedbackClosesAt: "2026-08-24T11:00:00.000Z"
    });
    round = applyRoundEvent(round, {
      type: "feedback-collection-closed",
      candidates: [
        {
          label: "F1",
          messageUrl: "https://discord.test/messages/feedback",
          participantId: "alice",
          participantName: "Alice",
          submittedAt: "2026-08-24T10:10:00.000Z",
          text: "Make the background warmer."
        }
      ]
    });
    round = applyRoundEvent(round, { type: "poll-created", pollMessageUrl: "poll-url" });
    round = applyRoundEvent(round, {
      type: "poll-finalized",
      selectedFeedback: [{ label: "F1", text: "Make the background warmer.", votes: 2 }]
    });
    round = applyRoundEvent(round, { type: "generation-started" });
    round = applyRoundEvent(round, {
      type: "generation-confirmed",
      resultImagePath: "/tmp/result.png"
    });
    round = applyRoundEvent(round, { type: "publication-started" });
    round = applyRoundEvent(round, {
      type: "publication-confirmed",
      resultMessageUrl: "https://discord.test/messages/result"
    });

    expect(round).toMatchObject({
      phase: "completed",
      pollMessageUrl: "poll-url",
      resultImagePath: "/tmp/result.png",
      resultMessageUrl: "https://discord.test/messages/result"
    });
  });

  it("pauses an ambiguous external side effect instead of making it retryable", () => {
    const generating = {
      ...createRound({
        id: "R003",
        baseImagePath: "/tmp/base.png",
        channelUrl: "https://discord.test/channels/one"
      }),
      phase: "generating" as const
    };

    const paused = applyRoundEvent(generating, {
      type: "attention-required",
      reason: "Generation result could not be confirmed."
    });

    expect(paused).toMatchObject({
      phase: "needs-attention",
      attentionReason: "Generation result could not be confirmed."
    });
    expect(() => applyRoundEvent(paused, { type: "generation-started" })).toThrow(
      "Invalid round transition"
    );
  });

  it("stops a finalized poll when no feedback received a vote", () => {
    const polling = {
      ...createRound({
        id: "R004",
        baseImagePath: "/tmp/base.png",
        channelUrl: "https://discord.test/channels/one"
      }),
      phase: "polling" as const,
      pollMessageUrl: "poll-url"
    };

    expect(applyRoundEvent(polling, { type: "poll-finalized-empty" }).phase).toBe("stopped");
  });
});
