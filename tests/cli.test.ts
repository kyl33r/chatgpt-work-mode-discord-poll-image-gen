import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import {
  FEEDBACK_IMAGE_LIMIT_PER_MESSAGE,
  FEEDBACK_IMAGE_LIMIT_PER_ROUND,
  PARTICIPANT_REFERENCE_INSTRUCTION
} from "../src/constants.js";
import { executeCommand as executeRoundCommand } from "../src/cli.js";
import {
  JsonRoundArtifactStore,
  type RoundArtifactStore
} from "../src/round/round-artifact-store.js";
import { applyRoundEvent, createRound } from "../src/round/round-state.js";
import type { DiscordMessageObservation } from "../src/round/message-collector.js";
import {
  JsonRoundStateStore,
  type RoundStateStore
} from "../src/round/round-state-store.js";
import { InMemoryWorkflowLock } from "../src/workflow-lock.js";

const temporaryDirectories: string[] = [];
const ALLOWED_CHANNEL = "https://discord.test/channels/allowlisted";
const SYNTHESIZED_PROMPT =
  "Edit the supplied base image using this synthesized participant feedback:\n" +
  "Apply all five requested visual changes as one coherent edit.\n" +
  "Preserve unrelated content. Produce exactly one edited image.";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("executeCommand", () => {
  it("uses the configured participant-image limits", () => {
    expect(FEEDBACK_IMAGE_LIMIT_PER_MESSAGE).toBe(2);
    expect(FEEDBACK_IMAGE_LIMIT_PER_ROUND).toBe(5);
  });

  it("prepares one Base Image post with the configured marker and message limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-round-cli-"));
    temporaryDirectories.push(directory);
    const roundsRoot = join(directory, "rounds");
    const roundCapsule = join(roundsRoot, "RSTART");
    await mkdir(roundCapsule, { recursive: true });
    const baseImagePath = join(roundCapsule, "base-image.png");
    await writeFile(baseImagePath, "image", "utf8");
    const store = new JsonRoundStateStore(roundsRoot);
    await store.save({
      ...createRound({
        id: "ROLD",
        baseImagePath: join(roundsRoot, "ROLD", "base-image.png"),
        channelUrl: "https://discord.test/channels/allowlisted",
        messageLimit: 5
      }),
      phase: "stopped"
    });
    await store.save({
      ...createRound({
        id: "RATTENTION",
        baseImagePath: join(roundsRoot, "RATTENTION", "base-image.png"),
        channelUrl: "https://discord.test/channels/allowlisted",
        messageLimit: 5
      }),
      phase: "needs-attention",
      attentionReason: "The prior round needs manual reconciliation."
    });
    const priorRoundBytes = await readFile(
      join(roundsRoot, "ROLD", "round.json"),
      "utf8"
    );

    expect(
      await runCommand(
        "prepare-base-submission",
        {
          roundId: "RSTART",
          baseImagePath
        },
        store,
        { artifacts: new JsonRoundArtifactStore(roundsRoot) }
      )
    ).toMatchObject({
      action: "post-base-image",
      roundId: "RSTART",
      caption:
        "===== POLL START: RSTART =====\nThe next 5 ordinary non-empty text messages in this channel will be used as image-edit feedback. Each qualifying message may contribute up to 2 supported images, with at most 5 images accepted for the whole round. Later attachments beyond either limit are ignored in Discord arrival and attachment order. Supported formats: PNG, JPEG, and WebP."
    });
    expect(await store.get("RSTART")).toMatchObject({
      phase: "submitting-base",
      channelUrl: ALLOWED_CHANNEL,
      messageLimit: 5,
      capturedMessages: []
    });
    await expect(readFile(join(roundsRoot, "ROLD", "round.json"), "utf8")).resolves.toBe(
      priorRoundBytes
    );

    expect(
      await runCommand(
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

  it("rejects a caller-supplied channel instead of bypassing the allowlist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-round-cli-"));
    temporaryDirectories.push(directory);
    const roundsRoot = join(directory, "rounds");
    const roundCapsule = join(roundsRoot, "RINJECTED");
    await mkdir(roundCapsule, { recursive: true });
    const baseImagePath = join(roundCapsule, "base-image.png");
    await writeFile(baseImagePath, "image", "utf8");

    await expect(
      runCommand(
        "prepare-base-submission",
        {
          roundId: "RINJECTED",
          baseImagePath,
          channelUrl: "https://discord.test/channels/unexpected"
        },
        new JsonRoundStateStore(roundsRoot),
        { artifacts: new JsonRoundArtifactStore(roundsRoot) }
      )
    ).rejects.toThrow("The round channel is derived from the configured Discord allowlist.");
  });

  it("continues from the most recently completed successful round in the channel", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-round-cli-"));
    temporaryDirectories.push(directory);
    const roundsRoot = join(directory, "rounds");
    const store = new JsonRoundStateStore(roundsRoot);
    const olderResult = await validPng(0);
    const latestResult = await validPng(255);
    for (const [roundId, startedAt, bytes] of [
      ["R001", "2026-08-24T10:00:00.000Z", olderResult],
      ["R002", "2026-08-24T11:00:00.000Z", latestResult]
    ] as const) {
      const capsule = join(roundsRoot, roundId);
      await mkdir(capsule, { recursive: true });
      const resultImagePath = join(capsule, "result-image.png");
      await writeFile(resultImagePath, bytes);
      await store.save({
        ...createRound({
          id: roundId,
          baseImagePath: join(capsule, "base-image.png"),
          channelUrl: ALLOWED_CHANNEL,
          messageLimit: 5
        }),
        phase: "completed",
        collectionStartedAt: startedAt,
        generationOutcome: { kind: "succeeded", resultImagePath },
        outcomeMessageUrl: `${roundId}-outcome`
      });
    }

    const result = await runCommand(
      "prepare-continuation",
      { roundId: "R003" },
      store,
      { artifacts: new JsonRoundArtifactStore(roundsRoot) }
    );

    expect(result).toMatchObject({
      action: "post-base-image",
      roundId: "R003",
      caption:
        "===== POLL START: R003 =====\nThe next 5 ordinary non-empty text messages in this channel will be used as image-edit feedback. Each qualifying message may contribute up to 2 supported images, with at most 5 images accepted for the whole round. Later attachments beyond either limit are ignored in Discord arrival and attachment order. Supported formats: PNG, JPEG, and WebP."
    });
    const continued = await store.get("R003");
    expect(continued).toMatchObject({
      phase: "submitting-base",
      parentRoundId: "R002",
      channelUrl: ALLOWED_CHANNEL
    });
    expect(await readFile(continued!.baseImagePath)).toEqual(latestResult);

    expect(
      await runCommand(
        "confirm-base-submission",
        {
          roundId: "R003",
          baseMessageUrl: "R003-base-message",
          collectionStartedAt: "2026-08-24T12:00:00.000Z"
        },
        store
      )
    ).toEqual({ action: "recorded", roundId: "R003", phase: "collecting-messages" });
  });

  it("rejects caller-selected continuation history", async () => {
    const store = await createStore();

    await expect(
      runCommand(
        "prepare-continuation",
        { roundId: "RNEW", sourceRoundId: "RINJECTED" },
        store,
        { artifacts: new JsonRoundArtifactStore(join(temporaryDirectories.at(-1)!, "rounds")) }
      )
    ).rejects.toThrow("Continuation source is selected from completed channel history.");
  });

  it("does not persist a continuation when the artifact copy fails", async () => {
    const store = await createStore();
    await store.save({
      ...createRound({
        id: "R001",
        baseImagePath: "/state/R001/base-image.png",
        channelUrl: ALLOWED_CHANNEL,
        messageLimit: 5
      }),
      phase: "completed",
      collectionStartedAt: "2026-08-24T10:00:00.000Z",
      generationOutcome: { kind: "succeeded", resultImagePath: "/missing/result.png" },
      outcomeMessageUrl: "R001-outcome"
    });
    const artifacts: RoundArtifactStore = {
      acceptBaseImage: async () => "unused",
      acceptResultImage: async () => "unused",
      requireResultImage: async () => "unused",
      acceptFeedbackImage: async () => "unused",
      requireFeedbackImage: async () => "unused",
      copyResultAsBase: async () => {
        throw new Error("copy failed");
      },
      discardUnpersistedBase: async () => undefined
    };

    await expect(
      runCommand("prepare-continuation", { roundId: "R002" }, store, { artifacts })
    ).rejects.toThrow("copy failed");
    await expect(store.get("R002")).resolves.toBeUndefined();
  });

  it("rejects continuation while another round is active", async () => {
    const store = await createStore();
    await store.save(
      createRound({
        id: "RACTIVE",
        baseImagePath: "/state/RACTIVE/base-image.png",
        channelUrl: ALLOWED_CHANNEL,
        messageLimit: 5
      })
    );

    await expect(
      runCommand("prepare-continuation", { roundId: "RNEW" }, store, {
        artifacts: new JsonRoundArtifactStore(join(temporaryDirectories.at(-1)!, "rounds"))
      })
    ).rejects.toThrow("An active round already exists: RACTIVE");
  });

  it("rejects continuation when history has no eligible same-channel success", async () => {
    const store = await createStore();
    await store.save({
      ...createRound({
        id: "RREFUSED",
        baseImagePath: "/state/RREFUSED/base-image.png",
        channelUrl: ALLOWED_CHANNEL,
        messageLimit: 5
      }),
      phase: "completed",
      collectionStartedAt: "2026-08-24T10:00:00.000Z",
      generationOutcome: { kind: "refused" },
      outcomeMessageUrl: "refused-outcome"
    });

    await expect(
      runCommand("prepare-continuation", { roundId: "RNEW" }, store, {
        artifacts: new JsonRoundArtifactStore(join(temporaryDirectories.at(-1)!, "rounds"))
      })
    ).rejects.toThrow("No completed successful round is available in the configured channel.");
  });

  it("removes an unpersisted copied Base Image so a save failure can be retried", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-round-cli-retry-"));
    temporaryDirectories.push(directory);
    const roundsRoot = join(directory, "rounds");
    const backingStore = new JsonRoundStateStore(roundsRoot);
    const sourceCapsule = join(roundsRoot, "R001");
    await mkdir(sourceCapsule, { recursive: true });
    const resultImagePath = join(sourceCapsule, "result-image.png");
    await writeFile(resultImagePath, await validPng());
    await backingStore.save({
      ...createRound({
        id: "R001",
        baseImagePath: join(sourceCapsule, "base-image.png"),
        channelUrl: ALLOWED_CHANNEL,
        messageLimit: 5
      }),
      phase: "completed",
      collectionStartedAt: "2026-08-24T10:00:00.000Z",
      generationOutcome: { kind: "succeeded", resultImagePath },
      outcomeMessageUrl: "outcome"
    });
    let failNextTargetSave = true;
    const store: RoundStateStore = {
      get: (roundId) => backingStore.get(roundId),
      list: () => backingStore.list(),
      save: async (round) => {
        if (round.id === "R002" && failNextTargetSave) {
          failNextTargetSave = false;
          throw new Error("save failed");
        }
        await backingStore.save(round);
      }
    };
    const artifacts = new JsonRoundArtifactStore(roundsRoot);

    await expect(
      runCommand("prepare-continuation", { roundId: "R002" }, store, { artifacts })
    ).rejects.toThrow("save failed");
    await expect(access(join(roundsRoot, "R002"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      runCommand("prepare-continuation", { roundId: "R002" }, store, { artifacts })
    ).resolves.toMatchObject({ action: "post-base-image", roundId: "R002" });
  });

  it("waits for five messages, deduplicates rescans, then freezes and closes", async () => {
    const store = await createStore();
    await store.save(collectingRound("R001"));
    const firstFour = [1, 2, 3, 4].map(observation);

    expect(
      await runCommand(
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
      await runCommand(
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

    expect(await runCommand("prepare-prompt-synthesis", { roundId: "R001" }, store)).toEqual({
      action: "synthesize-prompt",
      roundId: "R001",
      feedbackTexts: [1, 2, 3, 4, 5].map((index) => `random message ${index}`),
      contextImagePaths: []
    });

    expect(
      await runCommand(
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
      await runCommand(
        "confirm-collection-closed",
        { roundId: "R001", closedMessageUrl: "closed-message" },
        store
      )
    ).toEqual({ action: "recorded", roundId: "R001", phase: "ready-to-generate" });
  });

  it("validates and preserves participant image order through generation", async () => {
    const store = await createStore();
    await store.save(collectingRound("R001"));
    const roundsRoot = join(temporaryDirectories.at(-1)!, "rounds");
    const feedbackRoot = join(roundsRoot, "R001", "feedback-images");
    await mkdir(feedbackRoot, { recursive: true });
    const first = join(feedbackRoot, "message-1-attachment-0.png");
    const second = join(feedbackRoot, "message-2-attachment-0.png");
    await writeFile(first, await validPng());
    await writeFile(second, await validPng());
    const artifacts = new JsonRoundArtifactStore(roundsRoot);
    const messages = [1, 2, 3, 4, 5].map(observation);
    messages[0]!.attachments = [{ attachmentIndex: 0, mediaType: "image/png", imagePath: first }];
    messages[1]!.attachments = [{ attachmentIndex: 0, mediaType: "image/png", imagePath: second }];

    await runCommand(
      "collect-messages",
      { roundId: "R001", boundaryMessageUrl: "base-message", messages },
      store,
      { artifacts }
    );
    expect(await runCommand("prepare-prompt-synthesis", { roundId: "R001" }, store)).toMatchObject({
      contextImagePaths: [await realpath(first), await realpath(second)]
    });
    const prompt =
      "Edit the supplied base image using this synthesized participant feedback:\n" +
      `${PARTICIPANT_REFERENCE_INSTRUCTION}\n` +
      "Apply all requested changes coherently.\n" +
      "Preserve unrelated content. Produce exactly one edited image.";
    await runCommand("confirm-synthesized-prompt", { roundId: "R001", synthesizedPrompt: prompt }, store);
    await runCommand(
      "confirm-collection-closed",
      { roundId: "R001", closedMessageUrl: "closed-message" },
      store
    );
    await expect(
      runCommand("prepare-generation", { roundId: "R001" }, store, { artifacts })
    ).resolves.toMatchObject({
      contextImagePaths: [await realpath(first), await realpath(second)],
      instruction: prompt
    });
  });

  it("persists needs-attention when a scan has ambiguous message order", async () => {
    const store = await createStore();
    await store.save(collectingRound("R001"));

    expect(
      await runCommand(
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

    expect(await runCommand("prepare-generation", { roundId: "RGEN" }, store)).toEqual({
      action: "generate-image",
      operationId: "RGEN:generating:1:1822396ccc5e",
      roundId: "RGEN",
      baseImagePath: "/tmp/base.png",
      contextImagePaths: [],
      instruction: SYNTHESIZED_PROMPT
    });
    expect((await store.get("RGEN"))?.phase).toBe("generating");
  });

  it("publishes a controlled refusal without forwarding raw generation output", async () => {
    const store = await createStore();
    const round = readyRound("RREFUSED");
    await store.save(round);
    await runCommand("prepare-generation", { roundId: "RREFUSED" }, store);

    expect(
      await runCommand(
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
      await runCommand("prepare-publication", { roundId: "RREFUSED" }, store)
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
    await runCommand("prepare-generation", { roundId: "RFAILED" }, store);
    await runCommand(
      "confirm-generation",
      { roundId: "RFAILED", outcome: "failed" },
      store
    );

    expect(
      await runCommand("prepare-publication", { roundId: "RFAILED" }, store)
    ).toMatchObject({
      action: "post-status-message",
      caption: "===== GENERATION FAILED: RFAILED ===== — No image was produced."
    });
  });

  it("persists needs-attention when planning finds an ambiguous close marker", async () => {
    const store = await createStore();
    await store.save({ ...collectingRound("RPAUSE"), phase: "closing-collection" });

    expect(await runCommand("plan-next", { roundId: "RPAUSE" }, store)).toEqual({
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
      await runCommand("stop-round", { roundId: "RCANCEL" }, collectingStore)
    ).toEqual({ action: "recorded", roundId: "RCANCEL", phase: "stopped" });

    const ambiguousStore = await createStore();
    await ambiguousStore.save({ ...collectingRound("RAMBIGUOUS"), phase: "generating" });
    expect(
      await runCommand("stop-round", { roundId: "RAMBIGUOUS" }, ambiguousStore)
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
      runCommand("stop-round", { roundId: "RTOOLATE" }, readyStore)
    ).rejects.toThrow("Round RTOOLATE can only be cancelled before the message threshold.");
  });

  it("rejects an existing Base Image outside the staging root and through a symlink escape", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-round-cli-"));
    temporaryDirectories.push(directory);
    const stagingRoot = join(directory, "rounds");
    const roundCapsule = join(stagingRoot, "ROUTSIDE");
    const outsideImagePath = join(directory, "outside.png");
    await mkdir(roundCapsule, { recursive: true });
    await writeFile(outsideImagePath, "image", "utf8");
    const store = new JsonRoundStateStore(stagingRoot);

    await expect(
      runCommand(
        "prepare-base-submission",
        {
          roundId: "ROUTSIDE",
          baseImagePath: outsideImagePath
        },
        store,
        { artifacts: new JsonRoundArtifactStore(stagingRoot) }
      )
    ).rejects.toThrow("Base image must be staged under the durable state directory.");

    const linkedRoundCapsule = join(stagingRoot, "RSYMLINK");
    await mkdir(linkedRoundCapsule, { recursive: true });
    const linkedImagePath = join(linkedRoundCapsule, "linked.png");
    await symlink(outsideImagePath, linkedImagePath);
    await expect(
      runCommand(
        "prepare-base-submission",
        {
          roundId: "RSYMLINK",
          baseImagePath: linkedImagePath
        },
        store,
        { artifacts: new JsonRoundArtifactStore(stagingRoot) }
      )
    ).rejects.toThrow("Base image must be staged under the durable state directory.");
  });

  it("rejects a Result Image outside the durable staging root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-round-cli-"));
    temporaryDirectories.push(directory);
    const resultRoot = join(directory, ".state", "rounds");
    await mkdir(join(resultRoot, "RRESULT"), { recursive: true });
    const outsideImagePath = join(directory, "outside.png");
    await writeFile(outsideImagePath, "image", "utf8");
    const store = new JsonRoundStateStore(resultRoot);
    await store.save(readyRound("RRESULT"));
    await runCommand("prepare-generation", { roundId: "RRESULT" }, store);

    await expect(
      runCommand(
        "confirm-generation",
        { roundId: "RRESULT", outcome: "succeeded", resultImagePath: outsideImagePath },
        store,
        { artifacts: new JsonRoundArtifactStore(resultRoot) }
      )
    ).rejects.toThrow("Result image must be staged under the durable state directory.");

    const otherCapsule = join(resultRoot, "ROTHER");
    await mkdir(otherCapsule, { recursive: true });
    const otherRoundImage = join(otherCapsule, "result-image.png");
    await writeFile(otherRoundImage, "image", "utf8");
    await expect(
      runCommand(
        "confirm-generation",
        { roundId: "RRESULT", outcome: "succeeded", resultImagePath: otherRoundImage },
        store,
        { artifacts: new JsonRoundArtifactStore(resultRoot) }
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
      runCommand("get-round", { roundId: "RCHANNEL" }, store)
    ).rejects.toThrow("Round channel does not match the configured Discord allowlist.");
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

function observation(index: number): DiscordMessageObservation {
  return {
    kind: "ordinary-text",
    roundId: "R001",
    boundaryMessageUrl: "base-message",
    messageUrl: `message-${index}`,
    authorId: "same-author",
    authorName: "Same author",
    timestamp: `2026-08-24T10:0${index}:00.000Z`,
    text: `random message ${index}`,
    attachments: []
  };
}

function captured(index: number) {
  const {
    kind: _kind,
    roundId: _roundId,
    boundaryMessageUrl: _boundary,
    attachments: _attachments,
    ...message
  } = observation(index);
  return { ...message, contextImages: [] };
}

async function createStore(): Promise<JsonRoundStateStore> {
  const directory = await mkdtemp(join(tmpdir(), "feedback-round-cli-"));
  temporaryDirectories.push(directory);
  return new JsonRoundStateStore(join(directory, "rounds"));
}

function runCommand(
  command: string,
  payload: unknown,
  store: RoundStateStore,
  options: { artifacts?: RoundArtifactStore } = {}
) {
  return executeRoundCommand(command, payload, store, {
    allowlist: {
      getAll: async () => [ALLOWED_CHANNEL],
      replace: async () => undefined
    },
    workflowLock: new InMemoryWorkflowLock(),
    ...options
  });
}

function validPng(red = 0): Promise<Buffer> {
  return sharp({
    create: { width: 1, height: 1, channels: 4, background: { r: red, g: 0, b: 0, alpha: 1 } }
  }).png().toBuffer();
}
