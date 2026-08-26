import { describe, expect, it } from "vitest";

import type { ClipboardImageSource } from "../src/clipboard/clipboard-image-source.js";
import { FeedbackImageAcquirer } from "../src/round/feedback-image-acquirer.js";
import { applyRoundEvent, createRound } from "../src/round/round-state.js";
import type { RoundState } from "../src/round/round-state.js";
import type { RoundArtifactStore } from "../src/round/round-artifact-store.js";
import type { RoundStateStore } from "../src/round/round-state-store.js";

describe("FeedbackImageAcquirer", () => {
  it("records a clipboard copy intent before returning the controlled copy action", async () => {
    const clipboard = new FakeClipboardImageSource(41);
    const store = new InMemoryRoundStateStore(plannedRound("R001"));
    const acquirer = new FeedbackImageAcquirer(store, clipboard, unusedArtifacts());

    const result = await acquirer.prepare({
      roundId: "R001",
      messageOrdinal: 1,
      attachmentIndex: 0
    });

    expect(result).toEqual({ action: "copy-visible-image" });
    expect(Object.keys(result)).toEqual(["action"]);
    expect(clipboard.getChangeCountCalls).toBe(1);
    expect(store.saved.at(-1)).toMatchObject({
      feedbackCaptureBatch: {
        messages: [{
          selectedAttachments: [{
            status: "copy-intent-recorded",
            expectedClipboardChangeCount: 41
          }]
        }]
      }
    });
  });

  it("installs the one-step clipboard image before persisting its accepted receipt", async () => {
    const clipboard = new FakeClipboardImageSource(41, { observedChangeCount: 42, pngBytes: new Uint8Array([1]) });
    const store = new InMemoryRoundStateStore(intentRecordedRound("R002"));
    const artifacts = new FakeArtifactStore("accepted-artifact");
    const acquirer = new FeedbackImageAcquirer(store, clipboard, artifacts);

    const result = await acquirer.capture({
      roundId: "R002",
      messageOrdinal: 1,
      attachmentIndex: 0
    });

    expect(result).toEqual({ action: "captured" });
    expect(Object.keys(result)).toEqual(["action"]);
    expect(clipboard.readRequests).toEqual([41]);
    expect(artifacts.accepted).toEqual([{ roundId: "R002", messageOrdinal: 1, attachmentIndex: 0, pngBytes: new Uint8Array([1]) }]);
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]).toMatchObject({
      feedbackCaptureBatch: {
        messages: [{ selectedAttachments: [{ status: "accepted", imagePath: "accepted-artifact" }] }]
      }
    });
  });
});

class FakeClipboardImageSource implements ClipboardImageSource {
  public getChangeCountCalls = 0;
  public readonly readRequests: number[] = [];

  public constructor(
    private readonly changeCount: number,
    private readonly image = { observedChangeCount: 0, pngBytes: new Uint8Array() }
  ) {}

  public async getChangeCount(): Promise<number> {
    this.getChangeCountCalls += 1;
    return this.changeCount;
  }

  public async readSingleImage(previousChangeCount: number): Promise<{ observedChangeCount: number; pngBytes: Uint8Array }> {
    this.readRequests.push(previousChangeCount);
    return this.image;
  }
}

class FakeArtifactStore implements RoundArtifactStore {
  public readonly accepted: Array<{
    roundId: string;
    messageOrdinal: number;
    attachmentIndex: number;
    pngBytes: Uint8Array;
  }> = [];

  public constructor(private readonly imagePath: string) {}

  public async acceptFeedbackImageBytes(
    roundId: string,
    messageOrdinal: number,
    attachmentIndex: number,
    pngBytes: Uint8Array
  ): Promise<string> {
    this.accepted.push({ roundId, messageOrdinal, attachmentIndex, pngBytes });
    return this.imagePath;
  }

  public async acceptBaseImage(): Promise<string> { return ""; }
  public async acceptResultImage(): Promise<string> { return ""; }
  public async requireResultImage(): Promise<string> { return ""; }
  public async acceptFeedbackImage(): Promise<string> { return ""; }
  public async requireFeedbackImage(): Promise<string> { return ""; }
  public async copyResultAsBase(): Promise<string> { return ""; }
  public async discardUnpersistedBase(): Promise<void> {}
}

class InMemoryRoundStateStore implements RoundStateStore {
  public readonly saved: RoundState[] = [];

  public constructor(private current: RoundState) {}

  public async get(roundId: string): Promise<RoundState | undefined> {
    return this.current.id === roundId ? this.current : undefined;
  }

  public async list(): Promise<RoundState[]> {
    return [this.current];
  }

  public async save(round: RoundState): Promise<void> {
    this.current = round;
    this.saved.push(round);
  }
}

function plannedRound(roundId: string): RoundState {
  let round = createRound({
    id: roundId,
    baseImagePath: "base-artifact",
    channelUrl: "https://discord.test/channels/allowlisted",
    messageLimit: 5
  });
  round = applyRoundEvent(round, { type: "base-submission-started" });
  round = applyRoundEvent(round, {
    type: "base-submission-confirmed",
    baseMessageUrl: "base-message",
    collectionStartedAt: "2026-08-26T10:00:00.000Z"
  });
  return applyRoundEvent(round, {
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
  });
}

function intentRecordedRound(roundId: string): RoundState {
  const round = plannedRound(roundId);
  return applyRoundEvent(round, {
    type: "feedback-copy-intent-recorded",
    messageOrdinal: 1,
    attachmentIndex: 0,
    expectedClipboardChangeCount: 41
  });
}

function unusedArtifacts(): RoundArtifactStore {
  return {
    acceptBaseImage: async () => "",
    acceptResultImage: async () => "",
    requireResultImage: async () => "",
    acceptFeedbackImage: async () => "",
    acceptFeedbackImageBytes: async () => "",
    requireFeedbackImage: async () => "",
    copyResultAsBase: async () => "",
    discardUnpersistedBase: async () => undefined
  };
}
