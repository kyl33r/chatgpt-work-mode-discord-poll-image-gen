import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeCommand } from "../src/cli.js";
import { applyRoundEvent, createRound } from "../src/round/round-state.js";
import { JsonRoundStateStore } from "../src/round/round-state-store.js";

const temporaryDirectories: string[] = [];
const SYNTHESIZED_PROMPT =
  "Edit the supplied base image using this synthesized participant feedback:\n" +
  "Apply all five requested visual changes as one coherent edit.\n" +
  "Preserve unrelated content. Produce exactly one edited image.";

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
      action: "synthesize-feedback",
      roundId: "R001"
    });

    expect(await store.get("R001")).toMatchObject({
      phase: "synthesizing-feedback",
      capturedMessages: [1, 2, 3, 4, 5].map(captured)
    });

    expect(await executeCommand("prepare-prompt-synthesis", { roundId: "R001" }, store)).toEqual({
      action: "synthesize-prompt",
      roundId: "R001",
      capturedMessages: [1, 2, 3, 4, 5].map(captured)
    });

    expect(
      await executeCommand(
        "confirm-synthesized-prompt",
        { roundId: "R001", synthesizedPrompt: SYNTHESIZED_PROMPT },
        store
      )
    ).toEqual({
      action: "post-collection-closed",
      operationId: "R001:closing-collection:1:469d047ee160",
      roundId: "R001",
      channelUrl: "https://discord.test/channels/allowlisted",
      caption: `===== POLL CLOSED: R001 =====\nFinal image prompt:\n${SYNTHESIZED_PROMPT}`
    });

    expect(await store.get("R001")).toMatchObject({
      phase: "closing-collection",
      capturedMessages: [1, 2, 3, 4, 5].map(captured),
      synthesizedPrompt: SYNTHESIZED_PROMPT
    });

    expect(
      await executeCommand(
        "confirm-collection-closed",
        { roundId: "R001", closedMessageUrl: "closed-message" },
        store
      )
    ).toEqual({ action: "recorded", roundId: "R001", phase: "ready-to-generate" });
  });

  it("persists needs-attention when a scan has ambiguous message order", async () => {
    const store = await createStore();
    await store.save(collectingRound("R001"));

    expect(
      await executeCommand(
        "collect-messages",
        {
          roundId: "R001",
          boundaryMessageUrl: "base-message",
          messages: [observation(2), observation(1)]
        },
        store
      )
    ).toEqual({
      action: "needs-attention",
      roundId: "R001",
      reason: "Discord message order is ambiguous; reconcile the round manually."
    });
    expect(await store.get("R001")).toMatchObject({
      phase: "needs-attention",
      attentionReason: "Discord message order is ambiguous; reconcile the round manually."
    });
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
      type: "synthesized-prompt-confirmed",
      synthesizedPrompt: SYNTHESIZED_PROMPT
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
      instruction: SYNTHESIZED_PROMPT
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

  it("allows cancellation only while safely collecting below the threshold", async () => {
    const collectingStore = await createStore();
    await collectingStore.save(collectingRound("RCANCEL"));
    expect(
      await executeCommand("stop-round", { roundId: "RCANCEL" }, collectingStore)
    ).toEqual({ action: "recorded", roundId: "RCANCEL", phase: "stopped" });

    const ambiguousStore = await createStore();
    await ambiguousStore.save({ ...collectingRound("RAMBIGUOUS"), phase: "generating" });
    expect(
      await executeCommand("stop-round", { roundId: "RAMBIGUOUS" }, ambiguousStore)
    ).toEqual({
      action: "needs-attention",
      roundId: "RAMBIGUOUS",
      reason: "Cancellation was requested while an external action may be in flight; reconcile the round manually."
    });
    expect(await ambiguousStore.get("RAMBIGUOUS")).toMatchObject({
      phase: "needs-attention"
    });

    const readyStore = await createStore();
    await readyStore.save(readyRound("RTOOLATE"));
    await expect(
      executeCommand("stop-round", { roundId: "RTOOLATE" }, readyStore)
    ).rejects.toThrow("Round RTOOLATE can only be cancelled before the message threshold.");
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
    ).rejects.toThrow("Base image must be staged under the durable state directory.");

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
    ).rejects.toThrow("Base image must be staged under the durable state directory.");
  });

  it("rejects a Result Image outside the durable staging root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-round-cli-"));
    temporaryDirectories.push(directory);
    const resultRoot = join(directory, ".state", "results");
    await mkdir(resultRoot, { recursive: true });
    const outsideImagePath = join(directory, "outside.png");
    await writeFile(outsideImagePath, "image", "utf8");
    const store = new JsonRoundStateStore(join(directory, "rounds.json"));
    await store.save(readyRound("RRESULT"));
    await executeCommand("prepare-generation", { roundId: "RRESULT" }, store);

    await expect(
      executeCommand(
        "confirm-generation",
        { roundId: "RRESULT", outcome: "succeeded", resultImagePath: outsideImagePath },
        store,
        { resultImageStagingRoot: resultRoot }
      )
    ).rejects.toThrow("Result image must be staged under the durable state directory.");
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
  round = applyRoundEvent(round, {
    type: "synthesized-prompt-confirmed",
    synthesizedPrompt: SYNTHESIZED_PROMPT
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
