import { describe, expect, it } from "vitest";

import {
  collectFeedbackCandidates,
  selectFeedback
} from "../src/round/feedback-normalizer.js";

describe("collectFeedbackCandidates", () => {
  it("keeps each participant's newest valid feedback and orders survivors by submission time", () => {
    const candidates = collectFeedbackCandidates({
      roundId: "R001",
      opensAt: "2026-08-24T10:00:00.000Z",
      closesAt: "2026-08-24T11:00:00.000Z",
      messages: [
        {
          messageUrl: "https://discord.test/messages/1",
          authorId: "alice",
          authorName: "Alice",
          timestamp: "2026-08-24T10:05:00.000Z",
          kind: "feedback",
          roundId: "R001",
          text: "FEEDBACK: Make the background blue."
        },
        {
          messageUrl: "https://discord.test/messages/2",
          authorId: "bob",
          authorName: "Bob",
          timestamp: "2026-08-24T10:10:00.000Z",
          kind: "feedback",
          roundId: "R001",
          text: "FEEDBACK: Add soft window light."
        },
        {
          messageUrl: "https://discord.test/messages/3",
          authorId: "alice",
          authorName: "Alice",
          timestamp: "2026-08-24T10:15:00.000Z",
          kind: "feedback",
          roundId: "R001",
          text: "FEEDBACK: Make the background warmer."
        }
      ]
    });

    expect(candidates).toEqual([
      {
        label: "F1",
        messageUrl: "https://discord.test/messages/2",
        participantId: "bob",
        participantName: "Bob",
        submittedAt: "2026-08-24T10:10:00.000Z",
        text: "Add soft window light."
      },
      {
        label: "F2",
        messageUrl: "https://discord.test/messages/3",
        participantId: "alice",
        participantName: "Alice",
        submittedAt: "2026-08-24T10:15:00.000Z",
        text: "Make the background warmer."
      }
    ]);
  });

  it("rejects malformed, empty, and out-of-window messages while preserving exact feedback text", () => {
    const candidates = collectFeedbackCandidates({
      roundId: "R002",
      opensAt: "2026-08-24T10:00:00.000Z",
      closesAt: "2026-08-24T11:00:00.000Z",
      messages: [
        {
          messageUrl: "wrong-round",
          authorId: "zero",
          authorName: "Zero",
          timestamp: "2026-08-24T10:04:00.000Z",
          kind: "feedback",
          roundId: "R999",
          text: "FEEDBACK: This belongs to another round."
        },
        {
          messageUrl: "invalid-time",
          authorId: "one",
          authorName: "One",
          timestamp: "not-a-time",
          kind: "feedback",
          roundId: "R002",
          text: "FEEDBACK: Reject me."
        },
        {
          messageUrl: "too-early",
          authorId: "two",
          authorName: "Two",
          timestamp: "2026-08-24T09:59:59.000Z",
          kind: "feedback",
          roundId: "R002",
          text: "FEEDBACK: Reject me too."
        },
        {
          messageUrl: "empty",
          authorId: "three",
          authorName: "Three",
          timestamp: "2026-08-24T10:05:00.000Z",
          kind: "feedback",
          roundId: "R002",
          text: "FEEDBACK:   "
        },
        {
          messageUrl: "valid",
          authorId: "four",
          authorName: "Four",
          timestamp: "2026-08-24T10:06:00.000Z",
          kind: "feedback",
          roundId: "R002",
          text: "FEEDBACK: Keep  two spaces."
        }
      ]
    });

    expect(candidates.map(({ text }) => text)).toEqual(["Keep  two spaces."]);
  });
});

describe("selectFeedback", () => {
  it("returns at most three nonzero candidates by votes with earlier submissions winning ties", () => {
    const selected = selectFeedback({
      finalized: true,
      candidates: [
        { label: "F1", text: "First", submittedAt: "2026-08-24T10:01:00.000Z" },
        { label: "F2", text: "Second", submittedAt: "2026-08-24T10:02:00.000Z" },
        { label: "F3", text: "Third", submittedAt: "2026-08-24T10:03:00.000Z" },
        { label: "F4", text: "Fourth", submittedAt: "2026-08-24T10:04:00.000Z" },
        { label: "F5", text: "Ignored", submittedAt: "2026-08-24T10:05:00.000Z" }
      ],
      votes: { F1: 2, F2: 5, F3: 5, F4: 1, F5: 0 }
    });

    expect(selected).toEqual([
      { label: "F2", text: "Second", votes: 5 },
      { label: "F3", text: "Third", votes: 5 },
      { label: "F1", text: "First", votes: 2 }
    ]);
  });
});
