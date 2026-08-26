import { describe, expect, it } from "vitest";

import { ROUND_SCHEMA_VERSION } from "../src/constants.js";
import { applyRoundEvent, createRound } from "../src/round/round-state.js";

describe("round state", () => {
  it("records an optional selected capture batch only while collecting messages", () => {
    let round = createRound({
      id: "RPLAN",
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

    expect(ROUND_SCHEMA_VERSION).toBe(7);
    expect(applyRoundEvent(round, {
      type: "feedback-captures-planned",
      feedbackCaptureBatch: {
        boundaryMessageUrl: "base-message",
        messages: [{
          messageUrl: "message-1",
          messageOrdinal: 1,
          selectedAttachments: [{
            attachmentIndex: 0,
            mediaType: "image/png",
            status: "selected"
          }]
        }]
      }
    })).toMatchObject({ feedbackCaptureBatch: { messages: [{ messageOrdinal: 1 }] } });
  });

  it("clears an incorporated capture batch in the collection transition", () => {
    let round = createRound({
      id: "RHANDOFF",
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
      type: "feedback-captures-planned",
      feedbackCaptureBatch: {
        boundaryMessageUrl: "base-message",
        messages: [{
          messageUrl: "message-1",
          messageOrdinal: 1,
          selectedAttachments: [{
            attachmentIndex: 0,
            mediaType: "image/png",
            status: "accepted",
            imagePath: "accepted.png"
          }]
        }]
      }
    });

    round = applyRoundEvent(round, {
      type: "message-collection-progressed",
      capturedMessages: [{
        messageUrl: "message-1",
        authorId: "alice",
        authorName: "Alice",
        timestamp: "2026-08-24T10:01:00.000Z",
        text: "message 1",
        contextImages: [{ attachmentIndex: 0, imagePath: "accepted.png" }]
      }]
    });

    expect(round).not.toHaveProperty("feedbackCaptureBatch");
    expect(round.capturedMessages[0]?.contextImages).toEqual([
      { attachmentIndex: 0, imagePath: "accepted.png" }
    ]);
  });

  it("rejects collection transitions that would discard an incomplete or mismatched batch", () => {
    let round = createRound({
      id: "RINVALIDHANDOFF",
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
    const incomplete = applyRoundEvent(round, {
      type: "feedback-captures-planned",
      feedbackCaptureBatch: {
        boundaryMessageUrl: "base-message",
        messages: [{
          messageUrl: "message-1",
          messageOrdinal: 1,
          selectedAttachments: [{ attachmentIndex: 0, mediaType: "image/png", status: "selected" }]
        }]
      }
    });
    const capturedMessages = [{
      messageUrl: "message-1",
      authorId: "alice",
      authorName: "Alice",
      timestamp: "2026-08-24T10:01:00.000Z",
      text: "message 1",
      contextImages: [{ attachmentIndex: 0, imagePath: "accepted.png" }]
    }];

    expect(() => applyRoundEvent(incomplete, {
      type: "message-collection-progressed",
      capturedMessages
    })).toThrow("Feedback image capture batch was not incorporated exactly.");

    const mismatched = applyRoundEvent(round, {
      type: "feedback-captures-planned",
      feedbackCaptureBatch: {
        boundaryMessageUrl: "base-message",
        messages: [{
          messageUrl: "message-1",
          messageOrdinal: 1,
          selectedAttachments: [{
            attachmentIndex: 0,
            mediaType: "image/png",
            status: "accepted",
            imagePath: "different.png"
          }]
        }]
      }
    });
    expect(() => applyRoundEvent(mismatched, {
      type: "message-collection-progressed",
      capturedMessages
    })).toThrow("Feedback image capture batch was not incorporated exactly.");
  });

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
      schemaVersion: 7,
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
