import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeCommand } from "../src/cli.js";
import { JsonRoundArtifactStore } from "../src/round/round-artifact-store.js";
import { JsonRoundStateStore } from "../src/round/round-state-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("round CLI lifecycle", () => {
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
      await executeCommand(
        "prepare-base-submission",
        {
          roundId: "R100",
          baseImagePath,
          channelUrl: "https://discord.test/channels/allowlisted"
        },
        store,
        { artifacts: new JsonRoundArtifactStore(roundsRoot) }
      )
    ).toMatchObject({
      action: "post-base-image",
      operationId: "R100:submitting-base:1:469d047ee160"
    });

    await executeCommand(
      "confirm-base-submission",
      {
        roundId: "R100",
        baseMessageUrl: "https://discord.test/messages/base",
        collectionStartedAt: "2026-08-24T10:00:00.000Z"
      },
      store
    );

    expect(
      await executeCommand(
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

    expect(await executeCommand("plan-next", { roundId: "R100" }, store)).toEqual({
      type: "synthesize-feedback"
    });
    expect(
      await executeCommand("prepare-prompt-synthesis", { roundId: "R100" }, store)
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
      await executeCommand(
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

    await executeCommand(
      "confirm-collection-closed",
      { roundId: "R100", closedMessageUrl: "https://discord.test/messages/closed" },
      store
    );
    expect(await executeCommand("prepare-generation", { roundId: "R100" }, store)).toEqual({
      action: "generate-image",
      operationId: "R100:generating:1:16e1daee7f6b",
      roundId: "R100",
      baseImagePath,
      instruction: synthesizedPrompt
    });

    const resultImagePath = join(roundCapsule, "result-image.png");
    await writeFile(resultImagePath, "test result fixture", "utf8");
    const stagedResultImagePath = await realpath(resultImagePath);
    await executeCommand(
      "confirm-generation",
      { roundId: "R100", outcome: "succeeded", resultImagePath },
      store,
      { artifacts: new JsonRoundArtifactStore(roundsRoot) }
    );
    expect(
      await executeCommand("prepare-publication", { roundId: "R100" }, store, {
        artifacts: new JsonRoundArtifactStore(roundsRoot)
      })
    ).toMatchObject({
      action: "post-result-image",
      operationId: "R100:publishing-outcome:1:469d047ee160",
      resultImagePath: stagedResultImagePath,
      caption: "===== RESULT: R100 ====="
    });
    await executeCommand(
      "confirm-publication",
      { roundId: "R100", outcomeMessageUrl: "https://discord.test/messages/result" },
      store
    );

    expect(await executeCommand("plan-next", { roundId: "R100" }, store)).toEqual({
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
