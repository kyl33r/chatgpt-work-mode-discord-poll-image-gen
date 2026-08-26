import { describe, expect, it } from "vitest";

import { collectMessages } from "../src/round/message-collector.js";

describe("collectMessages", () => {
  it("selects participant images in message and attachment order within both limits", () => {
    const result = collectMessages({
      roundId: "R001",
      boundaryMessageUrl: "boundary",
      collectionStartedAt: "2026-08-24T10:00:00.000Z",
      limit: 5,
      existing: [],
      observed: [
        withAttachments(message("1", "alice", "one", "10:01"), [image(0, "1-a.png"), image(1, "1-b.jpg"), image(2, "1-c.webp")]),
        withAttachments(message("2", "bob", "two", "10:02"), [image(0, "2-a.webp"), unsupported(1), image(2, "2-b.png")]),
        withAttachments(message("3", "carol", "three", "10:03"), [image(0, "3-a.png")]),
        withAttachments(message("4", "dan", "four", "10:04"), [image(0, "4-a.png")]),
        message("5", "eve", "five", "10:05")
      ]
    });

    expect(result.captured.map((entry) => entry.contextImages)).toEqual([
      [contextImage(0, "1-a.png"), contextImage(1, "1-b.jpg")],
      [contextImage(0, "2-a.webp"), contextImage(2, "2-b.png")],
      [contextImage(0, "3-a.png")],
      [],
      []
    ]);
  });

  it("freezes the first five arbitrary text messages in arrival order", () => {
    const result = collectMessages({
      roundId: "R001",
      boundaryMessageUrl: "boundary",
      collectionStartedAt: "2026-08-24T10:00:00.000Z",
      limit: 5,
      existing: [],
      observed: [
        message("1", "alice", "make it blue", "10:01"),
        message("2", "alice", "anything at all", "10:02"),
        message("3", "bob", "no prefix is needed", "10:03"),
        message("4", "alice", "add a window", "10:04"),
        message("5", "carol", "use warm light", "10:05"),
        message("6", "dave", "this arrives too late", "10:06")
      ]
    });

    expect(result).toEqual({
      complete: true,
      captured: [
        captured("1", "alice", "make it blue", "10:01"),
        captured("2", "alice", "anything at all", "10:02"),
        captured("3", "bob", "no prefix is needed", "10:03"),
        captured("4", "alice", "add a window", "10:04"),
        captured("5", "carol", "use warm light", "10:05")
      ]
    });
  });

  it("rejects observations for another round or Discord boundary", () => {
    expect(() =>
      collectMessages({
        roundId: "R001",
        boundaryMessageUrl: "boundary",
        collectionStartedAt: "2026-08-24T10:00:00.000Z",
        limit: 5,
        existing: [],
        observed: [{ ...message("1", "alice", "text", "10:01"), roundId: "R999" }]
      })
    ).toThrow("Message observation does not match the active round boundary.");

    expect(() =>
      collectMessages({
        roundId: "R001",
        boundaryMessageUrl: "boundary",
        collectionStartedAt: "2026-08-24T10:00:00.000Z",
        limit: 5,
        existing: [],
        observed: [
          { ...message("1", "alice", "text", "10:01"), boundaryMessageUrl: "other" }
        ]
      })
    ).toThrow("Message observation does not match the active round boundary.");
  });

  it("fails closed when Discord arrival order is contradictory", () => {
    expect(() =>
      collectMessages({
        roundId: "R001",
        boundaryMessageUrl: "boundary",
        collectionStartedAt: "2026-08-24T10:00:00.000Z",
        limit: 5,
        existing: [],
        observed: [
          message("2", "bob", "later", "10:02"),
          message("1", "alice", "earlier", "10:01")
        ]
      })
    ).toThrow("Message observations are not in Discord arrival order.");
  });

  it("fails closed when a rescan discovers an earlier message after later ones were persisted", () => {
    expect(() =>
      collectMessages({
        roundId: "R001",
        boundaryMessageUrl: "boundary",
        collectionStartedAt: "2026-08-24T10:00:00.000Z",
        limit: 5,
        existing: [captured("3", "carol", "already captured", "10:03")],
        observed: [message("2", "bob", "missed on the first scan", "10:02")]
      })
    ).toThrow("A rescan discovered a message before the persisted collection boundary.");
  });

  it("rejects a message timestamped before the confirmed Base Image boundary", () => {
    expect(() =>
      collectMessages({
        roundId: "R001",
        boundaryMessageUrl: "boundary",
        collectionStartedAt: "2026-08-24T10:00:00.000Z",
        limit: 5,
        existing: [],
        observed: [message("0", "alice", "too early", "09:59")]
      })
    ).toThrow("Message observation predates the active round boundary.");
  });

  it("requires a positive configured message limit", () => {
    expect(() =>
      collectMessages({
        roundId: "R001",
        boundaryMessageUrl: "boundary",
        collectionStartedAt: "2026-08-24T10:00:00.000Z",
        limit: 0,
        existing: [],
        observed: []
      })
    ).toThrow("Message limit must be a positive integer.");
  });

  it("uses the supplied limit while ignoring empty, system, attachment, and duplicate records", () => {
    const first = captured("1", "alice", "first observed text", "10:01");
    expect(
      collectMessages({
        roundId: "R001",
        boundaryMessageUrl: "boundary",
        collectionStartedAt: "2026-08-24T10:00:00.000Z",
        limit: 3,
        existing: [first],
        observed: [
          { ...message("1", "alice", "edited later", "10:01") },
          { ...message("system", "discord", "joined", "10:02"), kind: "system" },
          { ...message("attachment", "bob", "", "10:03"), kind: "attachment-only" },
          message("2", "bob", "second", "10:04"),
          message("3", "carol", "third", "10:05")
        ]
      })
    ).toEqual({
      complete: true,
      captured: [
        first,
        captured("2", "bob", "second", "10:04"),
        captured("3", "carol", "third", "10:05")
      ]
    });
  });

  it("does not count the Base Image boundary message as feedback", () => {
    expect(
      collectMessages({
        roundId: "R001",
        boundaryMessageUrl: "boundary",
        collectionStartedAt: "2026-08-24T10:00:00.000Z",
        limit: 2,
        existing: [],
        observed: [
          message("boundary", "owner", "===== POLL START: R001 =====", "10:00"),
          message("1", "alice", "first feedback", "10:01")
        ]
      })
    ).toEqual({
      complete: false,
      captured: [captured("1", "alice", "first feedback", "10:01")]
    });
  });
});

function message(messageUrl: string, authorId: string, text: string, time: string) {
  return {
    kind: "ordinary-text" as const,
    roundId: "R001",
    boundaryMessageUrl: "boundary",
    messageUrl,
    authorId,
    authorName: authorId,
    timestamp: `2026-08-24T${time}:00.000Z`,
    text,
    attachments: []
  };
}

function captured(messageUrl: string, authorId: string, text: string, time: string) {
  return {
    messageUrl,
    authorId,
    authorName: authorId,
    timestamp: `2026-08-24T${time}:00.000Z`,
    text,
    contextImages: []
  };
}

function withAttachments<T>(messageValue: T, attachments: unknown[]) {
  return { ...messageValue, attachments };
}

function image(attachmentIndex: number, imagePath: string) {
  return { attachmentIndex, mediaType: `image/${imagePath.endsWith(".jpg") ? "jpeg" : imagePath.endsWith(".webp") ? "webp" : "png"}`, imagePath };
}

function unsupported(attachmentIndex: number) {
  return { attachmentIndex, mediaType: "application/pdf", imagePath: "ignored.pdf" };
}

function contextImage(attachmentIndex: number, imagePath: string) {
  return { attachmentIndex, imagePath };
}
