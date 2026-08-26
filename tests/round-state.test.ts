import { describe, expect, it } from "vitest";

import { applyRoundEvent, createRound } from "../src/round/round-state.js";

describe("round state", () => {
  it("moves a five-message round through one successful Discord outcome", () => {
    let round = createRound({
      id: "R001",
      baseImagePath: "/tmp/base.png",
      channelUrl: "https://discord.test/channels/one",
      messageLimit: 5
    });
    round = applyRoundEvent(round, { type: "base-submission-started" });
    round = applyRoundEvent(round, {
      type: "base-submission-confirmed",
      baseMessageUrl: "base-message",
      collectionStartedAt: "2026-08-24T10:00:00.000Z"
    });
    round = applyRoundEvent(round, {
      type: "message-collection-filled",
      capturedMessages: fiveMessages()
    });
    expect(round.phase).toBe("synthesizing-feedback");
    round = applyRoundEvent(round, {
      type: "synthesized-prompt-confirmed",
      synthesizedPrompt:
        "Edit the supplied base image using this synthesized participant feedback:\n" +
        "Use all five requested visual changes.\n" +
        "Preserve unrelated content. Produce exactly one edited image."
    });
    round = applyRoundEvent(round, {
      type: "collection-closed",
      closedMessageUrl: "closed-message"
    });
    round = applyRoundEvent(round, { type: "generation-started" });
    round = applyRoundEvent(round, {
      type: "generation-succeeded",
      resultImagePath: "/tmp/result.png"
    });
    round = applyRoundEvent(round, { type: "outcome-publication-started" });
    round = applyRoundEvent(round, {
      type: "outcome-publication-confirmed",
      outcomeMessageUrl: "result-message"
    });

    expect(round).toMatchObject({
      phase: "completed",
      messageLimit: 5,
      closedMessageUrl: "closed-message",
      synthesizedPrompt:
        "Edit the supplied base image using this synthesized participant feedback:\n" +
        "Use all five requested visual changes.\n" +
        "Preserve unrelated content. Produce exactly one edited image.",
      generationOutcome: { kind: "succeeded", resultImagePath: "/tmp/result.png" },
      outcomeMessageUrl: "result-message"
    });
  });

  it("rejects a collection transition that does not match the configured limit", () => {
    let round = createRound({
      id: "R002",
      baseImagePath: "/tmp/base.png",
      channelUrl: "https://discord.test/channels/one",
      messageLimit: 5
    });
    round = applyRoundEvent(round, { type: "base-submission-started" });
    round = applyRoundEvent(round, {
      type: "base-submission-confirmed",
      baseMessageUrl: "base-message",
      collectionStartedAt: "2026-08-24T10:00:00.000Z"
    });

    expect(() =>
      applyRoundEvent(round, {
        type: "message-collection-filled",
        capturedMessages: fiveMessages().slice(0, 4)
      })
    ).toThrow("Filled collection must match the configured message limit.");
  });

  it("rejects stop transitions once collection has reached an external side-effect phase", () => {
    const draft = createRound({
      id: "RSTOP",
      baseImagePath: "/tmp/base.png",
      channelUrl: "https://discord.test/channels/one",
      messageLimit: 5
    });
    const submitting = applyRoundEvent(draft, { type: "base-submission-started" });

    expect(() => applyRoundEvent(submitting, { type: "round-stopped" })).toThrow(
      "Invalid round transition: submitting-base + round-stopped"
    );
  });

  it("records optional parent lineage only for a continued round", () => {
    expect(
      createRound({
        id: "RCHILD",
        baseImagePath: "/tmp/base.png",
        channelUrl: "https://discord.test/channels/one",
        messageLimit: 5,
        parentRoundId: "RPARENT"
      })
    ).toMatchObject({
      schemaVersion: 6,
      id: "RCHILD",
      parentRoundId: "RPARENT"
    });

    expect(
      createRound({
        id: "ROWNER",
        baseImagePath: "/tmp/base.png",
        channelUrl: "https://discord.test/channels/one",
        messageLimit: 5
      })
    ).not.toHaveProperty("parentRoundId");
  });
});

function fiveMessages() {
  return Array.from({ length: 5 }, (_, index) => ({
    messageUrl: `message-${index + 1}`,
    authorId: "alice",
    authorName: "Alice",
    timestamp: `2026-08-24T10:0${index + 1}:00.000Z`,
    text: `message ${index + 1}`,
    contextImages: []
  }));
}
