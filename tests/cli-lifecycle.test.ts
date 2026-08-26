import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import type { ClipboardImageSource } from "../src/clipboard/clipboard-image-source.js";
import { PARTICIPANT_REFERENCE_INSTRUCTION } from "../src/constants.js";
import { executeCommand as executeRoundCommand } from "../src/cli.js";
import {
  JsonRoundArtifactStore,
  type RoundArtifactStore
} from "../src/round/round-artifact-store.js";
import { JsonRoundStateStore } from "../src/round/round-state-store.js";
import { InMemoryWorkflowLock } from "../src/workflow-lock.js";

const temporaryDirectories: string[] = [];
const ALLOWED_CHANNEL = "https://discord.test/channels/allowlisted";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("round CLI lifecycle", () => {
  it("hands accepted clipboard images to collection without caller-supplied paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-round-lifecycle-"));
    temporaryDirectories.push(directory);
    const roundsRoot = join(directory, "rounds");
    const roundCapsule = join(roundsRoot, "RCLIP");
    await mkdir(roundCapsule, { recursive: true });
    const store = new JsonRoundStateStore(roundsRoot);
    const requestedBaseImagePath = join(roundCapsule, "base-image.png");
    await writeFile(requestedBaseImagePath, "test image fixture", "utf8");
    const baseImagePath = await realpath(requestedBaseImagePath);
    const artifacts = new FakeClipboardArtifacts();
    const clipboard = new SequencedClipboardImageSource();
    const boundaryMessageUrl = "https://discord.test/messages/base";
    const messages = Array.from({ length: 5 }, (_, index) => ({
      kind: "ordinary-text" as const,
      roundId: "RCLIP",
      boundaryMessageUrl,
      messageUrl: `https://discord.test/messages/${index + 1}`,
      authorId: "same-author",
      authorName: "Same author",
      timestamp: `2026-08-24T10:0${index + 1}:00.000Z`,
      text: `change ${index + 1}`,
      attachments: index === 0
        ? [{ attachmentIndex: 2, mediaType: "image/png" }]
        : index === 1
          ? [{ attachmentIndex: 0, mediaType: "image/jpeg" }]
          : []
    }));

    await runCommand(
      "prepare-base-submission",
      { roundId: "RCLIP", baseImagePath },
      store,
      { artifacts }
    );
    await runCommand(
      "confirm-base-submission",
      {
        roundId: "RCLIP",
        baseMessageUrl: boundaryMessageUrl,
        collectionStartedAt: "2026-08-24T10:00:00.000Z"
      },
      store
    );
    await runCommand(
      "plan-feedback-captures",
      { roundId: "RCLIP", boundaryMessageUrl, messages },
      store
    );
    for (const [messageOrdinal, attachmentIndex] of [[1, 2], [2, 0]] as const) {
      await expect(runCommand(
        "prepare-feedback-image-capture",
        { roundId: "RCLIP", messageOrdinal, attachmentIndex },
        store,
        { artifacts, clipboard }
      )).resolves.toEqual({ action: "copy-visible-image" });
      await expect(runCommand(
        "capture-feedback-image",
        { roundId: "RCLIP", messageOrdinal, attachmentIndex },
        store,
        { artifacts, clipboard }
      )).resolves.toEqual({ action: "captured" });
    }

    await expect(runCommand(
      "collect-messages",
      {
        roundId: "RCLIP",
        boundaryMessageUrl,
        messages: messages.map((message, index) => index === 0
          ? { ...message, attachments: [{ ...message.attachments[0]!, imagePath: "caller-path.png" }] }
          : message)
      },
      store,
      { artifacts }
    )).rejects.toThrow("payload attachment contains unsupported fields.");

    await expect(runCommand(
      "collect-messages",
      { roundId: "RCLIP", boundaryMessageUrl, messages },
      store,
      { artifacts }
    )).resolves.toEqual({ action: "synthesize-feedback", roundId: "RCLIP" });
    const collected = await store.get("RCLIP");
    expect(collected).toMatchObject({ phase: "synthesizing-feedback" });
    expect(collected?.capturedMessages.map((message) => message.contextImages)).toEqual([
      [{ attachmentIndex: 2, imagePath: "accepted-1-2.png" }],
      [{ attachmentIndex: 0, imagePath: "accepted-2-0.png" }],
      [],
      [],
      []
    ]);
    expect(collected).not.toHaveProperty("feedbackCaptureBatch");
    expect(artifacts.requiredFeedbackImages).toEqual([
      { roundId: "RCLIP", messageOrdinal: 1, attachmentIndex: 2, imagePath: "accepted-1-2.png" },
      { roundId: "RCLIP", messageOrdinal: 2, attachmentIndex: 0, imagePath: "accepted-2-0.png" }
    ]);

    const prompt =
      "Edit the supplied base image using this synthesized participant feedback:\n" +
      `${PARTICIPANT_REFERENCE_INSTRUCTION}\n` +
      "Apply all five requested visual changes as one coherent edit.\n" +
      "Preserve unrelated content. Produce exactly one edited image.";
    expect(await runCommand("prepare-prompt-synthesis", { roundId: "RCLIP" }, store)).toMatchObject({
      contextImagePaths: ["accepted-1-2.png", "accepted-2-0.png"]
    });
    await runCommand("confirm-synthesized-prompt", { roundId: "RCLIP", synthesizedPrompt: prompt }, store);
    await runCommand(
      "confirm-collection-closed",
      { roundId: "RCLIP", closedMessageUrl: "https://discord.test/messages/closed" },
      store
    );
    await expect(runCommand("prepare-generation", { roundId: "RCLIP" }, store, { artifacts }))
      .resolves.toMatchObject({
        baseImagePath,
        contextImagePaths: ["accepted-1-2.png", "accepted-2-0.png"],
        instruction: prompt
      });
  });

  it("completes one five-message image round across every external-action boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-round-lifecycle-"));
    temporaryDirectories.push(directory);
    const roundsRoot = join(directory, "rounds");
    const roundCapsule = join(roundsRoot, "R100");
    await mkdir(roundCapsule, { recursive: true });
    const store = new JsonRoundStateStore(roundsRoot);
    const requestedBaseImagePath = join(roundCapsule, "base-image.png");
    await writeFile(requestedBaseImagePath, "test image fixture", "utf8");
    const baseImagePath = await realpath(requestedBaseImagePath);

    expect(
      await runCommand(
        "prepare-base-submission",
        {
          roundId: "R100",
          baseImagePath
        },
        store,
        { artifacts: new JsonRoundArtifactStore(roundsRoot) }
      )
    ).toMatchObject({
      action: "post-base-image",
      operationId: "R100:submitting-base:1:469d047ee160"
    });

    await runCommand(
      "confirm-base-submission",
      {
        roundId: "R100",
        baseMessageUrl: "https://discord.test/messages/base",
        collectionStartedAt: "2026-08-24T10:00:00.000Z"
      },
      store
    );

    expect(
      await runCommand(
        "collect-messages",
        {
          roundId: "R100",
          boundaryMessageUrl: "https://discord.test/messages/base",
          messages: Array.from({ length: 5 }, (_, index) => ({
            kind: "ordinary-text",
            roundId: "R100",
            boundaryMessageUrl: "https://discord.test/messages/base",
            messageUrl: `https://discord.test/messages/${index + 1}`,
            authorId: "same-author",
            authorName: "Same author",
            timestamp: `2026-08-24T10:0${index + 1}:00.000Z`,
            text: `change ${index + 1}`
          }))
        },
        store
      )
    ).toMatchObject({
      action: "synthesize-feedback",
      roundId: "R100"
    });
    expect(await store.get("R100")).not.toHaveProperty("feedbackCaptureBatch");

    expect(await runCommand("plan-next", { roundId: "R100" }, store)).toEqual({
      type: "synthesize-feedback"
    });
    expect(
      await runCommand("prepare-prompt-synthesis", { roundId: "R100" }, store)
    ).toMatchObject({
      action: "synthesize-prompt",
      roundId: "R100",
      feedbackTexts: Array.from({ length: 5 }, (_, index) => `change ${index + 1}`)
    });

    const synthesizedPrompt =
      "Edit the supplied base image using this synthesized participant feedback:\n" +
      "Apply all five requested visual changes as one coherent edit.\n" +
      "Preserve unrelated content. Produce exactly one edited image.";
    expect(
      await runCommand(
        "confirm-synthesized-prompt",
        { roundId: "R100", synthesizedPrompt },
        store
      )
    ).toEqual({
      action: "post-collection-closed",
      operationId: "R100:closing-collection:1:469d047ee160",
      roundId: "R100",
      channelUrl: "https://discord.test/channels/allowlisted",
      caption:
        "===== POLL CLOSED: R100 =====\nFinal image prompt:\n" + synthesizedPrompt
    });

    await runCommand(
      "confirm-collection-closed",
      { roundId: "R100", closedMessageUrl: "https://discord.test/messages/closed" },
      store
    );
    expect(await runCommand("prepare-generation", { roundId: "R100" }, store)).toEqual({
      action: "generate-image",
      operationId: "R100:generating:1:16e1daee7f6b",
      roundId: "R100",
      baseImagePath,
      contextImagePaths: [],
      instruction: synthesizedPrompt
    });

    const resultImagePath = join(roundCapsule, "result-image.png");
    await writeFile(resultImagePath, await validPng());
    const stagedResultImagePath = await realpath(resultImagePath);
    await runCommand(
      "confirm-generation",
      { roundId: "R100", outcome: "succeeded", resultImagePath },
      store,
      { artifacts: new JsonRoundArtifactStore(roundsRoot) }
    );
    expect(
      await runCommand("prepare-publication", { roundId: "R100" }, store, {
        artifacts: new JsonRoundArtifactStore(roundsRoot)
      })
    ).toMatchObject({
      action: "post-result-image",
      operationId: "R100:publishing-outcome:1:469d047ee160",
      resultImagePath: stagedResultImagePath,
      caption: "===== RESULT: R100 ====="
    });
    await runCommand(
      "confirm-publication",
      { roundId: "R100", outcomeMessageUrl: "https://discord.test/messages/result" },
      store
    );

    expect(await runCommand("plan-next", { roundId: "R100" }, store)).toEqual({
      type: "none",
      reason: "Round is already completed."
    });
    expect(await store.get("R100")).toMatchObject({
      phase: "completed",
      generationOutcome: { kind: "succeeded", resultImagePath: stagedResultImagePath },
      outcomeMessageUrl: "https://discord.test/messages/result"
    });
  });
});

function runCommand(
  command: string,
  payload: unknown,
  store: JsonRoundStateStore,
  options: { artifacts?: RoundArtifactStore; clipboard?: ClipboardImageSource } = {}
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

class SequencedClipboardImageSource implements ClipboardImageSource {
  private changeCount = 10;

  public async getChangeCount(): Promise<number> {
    return this.changeCount;
  }

  public async readSingleImage(previousChangeCount: number) {
    this.changeCount = previousChangeCount + 1;
    return { observedChangeCount: this.changeCount, pngBytes: new Uint8Array([1]) };
  }
}

class FakeClipboardArtifacts implements RoundArtifactStore {
  public readonly requiredFeedbackImages: Array<{
    roundId: string;
    messageOrdinal: number;
    attachmentIndex: number;
    imagePath: string;
  }> = [];

  public async acceptBaseImage(_roundId: string, candidatePath: string): Promise<string> {
    return candidatePath;
  }

  public async acceptResultImage(_roundId: string, candidatePath: string): Promise<string> {
    return candidatePath;
  }

  public async requireResultImage(_roundId: string, storedPath: string): Promise<string> {
    return storedPath;
  }

  public async acceptFeedbackImageBytes(
    _roundId: string,
    messageOrdinal: number,
    attachmentIndex: number
  ): Promise<string> {
    return `accepted-${messageOrdinal}-${attachmentIndex}.png`;
  }

  public async requireFeedbackImage(
    roundId: string,
    messageOrdinal: number,
    attachmentIndex: number,
    imagePath: string
  ): Promise<string> {
    this.requiredFeedbackImages.push({ roundId, messageOrdinal, attachmentIndex, imagePath });
    return imagePath;
  }

  public async copyResultAsBase(
    _sourceRoundId: string,
    _targetRoundId: string,
    sourcePath: string
  ): Promise<string> {
    return sourcePath;
  }

  public async discardUnpersistedBase(): Promise<void> {}
}

function validPng(): Promise<Buffer> {
  return sharp({
    create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } }
  }).png().toBuffer();
}
