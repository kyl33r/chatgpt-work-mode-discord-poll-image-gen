import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeCommand } from "../src/cli.js";
import { applyRoundEvent, createRound } from "../src/round/round-state.js";
import { JsonRoundStateStore } from "../src/round/round-state-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("executeCommand", () => {
  it("prepares one Base Image post with the configured marker and message limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-round-cli-"));
    temporaryDirectories.push(directory);
    const stagingRoot = join(directory, "base-images");
    await mkdir(stagingRoot);
    const baseImagePath = join(stagingRoot, "base.png");
    await writeFile(baseImagePath, "image", "utf8");
    const store = new JsonRoundStateStore(join(directory, "rounds.json"));

    expect(
      await executeCommand(
        "prepare-base-submission",
        {
          roundId: "RSTART",
          baseImagePath,
          channelUrl: "https://discord.test/channels/allowlisted"
        },
        store,
        { baseImageStagingRoot: stagingRoot }
      )
    ).toMatchObject({
      action: "post-base-image",
      roundId: "RSTART",
      caption:
        "===== POLL START: RSTART =====\nThe next 5 non-empty text messages in this channel will be used as image-edit feedback."
    });
    expect(await store.get("RSTART")).toMatchObject({
      phase: "submitting-base",
      messageLimit: 5,
      capturedMessages: []
    });

    expect(
      await executeCommand(
        "confirm-base-submission",
        {
          roundId: "RSTART",
          baseMessageUrl: "base-message",
          collectionStartedAt: "2026-08-24T10:00:00.000Z"
        },
        store
      )
    ).toEqual({ action: "recorded", roundId: "RSTART", phase: "collecting-messages" });
  });

  it("waits for five messages, deduplicates rescans, then freezes and closes", async () => {
    const store = await createStore();
    await store.save(collectingRound("R001"));
    const firstFour = [1, 2, 3, 4].map(observation);

    expect(
      await executeCommand(
        "collect-messages",
        {
          roundId: "R001",
          boundaryMessageUrl: "base-message",
          messages: firstFour
        },
        store
      )
    ).toEqual({
      action: "wait",
      roundId: "R001",
      capturedCount: 4,
      remainingCount: 1,
      scanIntervalMs: 15_000
    });

    expect(
      await executeCommand(
        "collect-messages",
        {
          roundId: "R001",
          boundaryMessageUrl: "base-message",
          messages: [...firstFour, observation(5), observation(6)]
        },
        store
      )
    ).toEqual({
      action: "post-collection-closed",
      operationId: "R001:closing-collection:1:469d047ee160",
      roundId: "R001",
      channelUrl: "https://discord.test/channels/allowlisted",
      caption: "===== POLL CLOSED: R001 =====",
      capturedMessages: [1, 2, 3, 4, 5].map(captured)
    });

    expect(await store.get("R001")).toMatchObject({
      phase: "closing-collection",
      capturedMessages: [1, 2, 3, 4, 5].map(captured)
    });

    expect(
      await executeCommand(
        "confirm-collection-closed",
        { roundId: "R001", closedMessageUrl: "closed-message" },
        store
      )
    ).toEqual({ action: "recorded", roundId: "R001", phase: "ready-to-generate" });
  });

  it("prepares one image edit from all five frozen messages", async () => {
    const store = await createStore();
    let round = collectingRound("RGEN");
    const messages = [1, 2, 3, 4, 5].map((index) => ({
      ...captured(index),
      text: `requested change ${index}`
    }));
    round = applyRoundEvent(round, {
      type: "message-collection-filled",
      capturedMessages: messages
    });
    round = applyRoundEvent(round, {
      type: "collection-closed",
      closedMessageUrl: "closed-message"
    });
    await store.save(round);

    expect(await executeCommand("prepare-generation", { roundId: "RGEN" }, store)).toEqual({
      action: "generate-image",
      operationId: "RGEN:generating:1:1822396ccc5e",
      roundId: "RGEN",
      baseImagePath: "/tmp/base.png",
      instruction:
        "Edit the supplied base image using all of these Discord messages as requested changes:\n1. requested change 1\n2. requested change 2\n3. requested change 3\n4. requested change 4\n5. requested change 5\nPreserve unrelated content. Produce exactly one edited image."
    });
    expect((await store.get("RGEN"))?.phase).toBe("generating");
  });

  it("publishes a controlled refusal without forwarding raw generation output", async () => {
    const store = await createStore();
    const round = readyRound("RREFUSED");
    await store.save(round);
    await executeCommand("prepare-generation", { roundId: "RREFUSED" }, store);

    expect(
      await executeCommand(
        "confirm-generation",
        {
          roundId: "RREFUSED",
          outcome: "refused",
          rawError: "sensitive provider detail that must not be accepted"
        },
        store
      )
    ).toEqual({ action: "recorded", roundId: "RREFUSED", phase: "outcome-ready" });

    expect(
      await executeCommand("prepare-publication", { roundId: "RREFUSED" }, store)
    ).toEqual({
      action: "post-status-message",
      operationId: "RREFUSED:publishing-outcome:1:469d047ee160",
      roundId: "RREFUSED",
      channelUrl: "https://discord.test/channels/allowlisted",
      caption: "===== GENERATION REFUSED: RREFUSED ===== — No image was produced."
    });
    expect(JSON.stringify(await store.get("RREFUSED"))).not.toContain("sensitive provider detail");
  });

  it("publishes a controlled non-refusal failure", async () => {
    const store = await createStore();
    await store.save(readyRound("RFAILED"));
    await executeCommand("prepare-generation", { roundId: "RFAILED" }, store);
    await executeCommand(
      "confirm-generation",
      { roundId: "RFAILED", outcome: "failed" },
      store
    );

    expect(
      await executeCommand("prepare-publication", { roundId: "RFAILED" }, store)
    ).toMatchObject({
      action: "post-status-message",
      caption: "===== GENERATION FAILED: RFAILED ===== — No image was produced."
    });
  });

  it("persists needs-attention when planning finds an ambiguous close marker", async () => {
    const store = await createStore();
    await store.save({ ...collectingRound("RPAUSE"), phase: "closing-collection" });

    expect(await executeCommand("plan-next", { roundId: "RPAUSE" }, store)).toEqual({
      type: "needs-attention",
      reason: "The collection-closed marker may already have been posted; reconcile it manually."
    });
    expect(await store.get("RPAUSE")).toMatchObject({
      phase: "needs-attention",
      attentionReason:
        "The collection-closed marker may already have been posted; reconcile it manually."
    });
  });

  it("rejects an existing Base Image outside the staging root and through a symlink escape", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-round-cli-"));
    temporaryDirectories.push(directory);
    const stagingRoot = join(directory, "base-images");
    const outsideImagePath = join(directory, "outside.png");
    await mkdir(stagingRoot);
    await writeFile(outsideImagePath, "image", "utf8");
    const store = new JsonRoundStateStore(join(directory, "rounds.json"));

    await expect(
      executeCommand(
        "prepare-base-submission",
        {
          roundId: "ROUTSIDE",
          baseImagePath: outsideImagePath,
          channelUrl: "https://discord.test/channels/allowlisted"
        },
        store,
        { baseImageStagingRoot: stagingRoot }
      )
    ).rejects.toThrow("Base image must be staged under the configured runtime directory.");

    const linkedImagePath = join(stagingRoot, "linked.png");
    await symlink(outsideImagePath, linkedImagePath);
    await expect(
      executeCommand(
        "prepare-base-submission",
        {
          roundId: "RSYMLINK",
          baseImagePath: linkedImagePath,
          channelUrl: "https://discord.test/channels/allowlisted"
        },
        store,
        { baseImageStagingRoot: stagingRoot }
      )
    ).rejects.toThrow("Base image must be staged under the configured runtime directory.");
  });

  it("rejects a persisted round outside the configured channel allowlist", async () => {
    const store = await createStore();
    await store.save(
      createRound({
        id: "RCHANNEL",
        baseImagePath: "/tmp/base.png",
        channelUrl: "https://discord.test/channels/unexpected",
        messageLimit: 5
      })
    );

    await expect(
      executeCommand("get-round", { roundId: "RCHANNEL" }, store, {
        allowedChannelUrl: "https://discord.test/channels/allowlisted"
      })
    ).rejects.toThrow("Round channel does not match DISCORD_CHANNEL_URL.");
  });
});

function collectingRound(roundId: string) {
  const draft = createRound({
    id: roundId,
    baseImagePath: "/tmp/base.png",
    channelUrl: "https://discord.test/channels/allowlisted",
    messageLimit: 5
  });
  const submitting = applyRoundEvent(draft, { type: "base-submission-started" });
  return applyRoundEvent(submitting, {
    type: "base-submission-confirmed",
    baseMessageUrl: "base-message",
    collectionStartedAt: "2026-08-24T10:00:00.000Z"
  });
}

function readyRound(roundId: string) {
  let round = collectingRound(roundId);
  round = applyRoundEvent(round, {
    type: "message-collection-filled",
    capturedMessages: [1, 2, 3, 4, 5].map(captured)
  });
  return applyRoundEvent(round, {
    type: "collection-closed",
    closedMessageUrl: "closed-message"
  });
}

function observation(index: number) {
  return {
    kind: "ordinary-text",
    roundId: "R001",
    boundaryMessageUrl: "base-message",
    messageUrl: `message-${index}`,
    authorId: "same-author",
    authorName: "Same author",
    timestamp: `2026-08-24T10:0${index}:00.000Z`,
    text: `random message ${index}`
  };
}

function captured(index: number) {
  const { kind: _kind, roundId: _roundId, boundaryMessageUrl: _boundary, ...message } =
    observation(index);
  return message;
}

async function createStore(): Promise<JsonRoundStateStore> {
  const directory = await mkdtemp(join(tmpdir(), "feedback-round-cli-"));
  temporaryDirectories.push(directory);
  return new JsonRoundStateStore(join(directory, "rounds.json"));
}
