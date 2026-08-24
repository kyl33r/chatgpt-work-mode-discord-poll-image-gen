import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeCommand } from "../src/cli.js";
import { JsonRoundStateStore } from "../src/round/round-state-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("round CLI lifecycle", () => {
  it("persists every external-action boundary and completes exactly one image turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-round-lifecycle-"));
    temporaryDirectories.push(directory);
    const store = new JsonRoundStateStore(join(directory, "rounds.json"));
    const requestedBaseImagePath = join(directory, "base.png");
    await writeFile(requestedBaseImagePath, "test image fixture", "utf8");
    const baseImagePath = await realpath(requestedBaseImagePath);

    const baseAction = await executeCommand(
      "prepare-base-submission",
      {
        roundId: "R100",
        baseImagePath,
        channelUrl: "https://discord.test/channels/allowlisted"
      },
      store,
      { baseImageStagingRoot: directory }
    );
    expect(baseAction).toMatchObject({
      action: "post-base-image",
      operationId: "R100:submitting-base:1:469d047ee160"
    });
    expect((await store.get("R100"))?.phase).toBe("submitting-base");

    await executeCommand(
      "confirm-base-submission",
      {
        roundId: "R100",
        baseMessageUrl: "https://discord.test/messages/base",
        feedbackOpensAt: "2026-08-24T10:00:00.000Z",
        feedbackClosesAt: "2026-08-24T11:00:00.000Z"
      },
      store
    );
    await executeCommand(
      "collect-feedback",
      {
        roundId: "R100",
        observedAt: "2026-08-24T11:00:00.000Z",
        messages: [
          {
            messageUrl: "https://discord.test/messages/feedback",
            authorId: "alice",
            authorName: "Alice",
            timestamp: "2026-08-24T10:10:00.000Z",
            kind: "feedback",
            roundId: "R100",
            text: "FEEDBACK: Make the background warmer."
          }
        ]
      },
      store
    );
    await executeCommand(
      "confirm-poll-created",
      { roundId: "R100", pollMessageUrl: "https://discord.test/messages/poll" },
      store
    );
    await executeCommand(
      "record-poll-results",
      {
        roundId: "R100",
        pollMessageUrl: "https://discord.test/messages/poll",
        finalized: true,
        votes: { F1: 2 }
      },
      store
    );

    const generationAction = await executeCommand(
      "prepare-generation",
      { roundId: "R100" },
      store
    );
    expect(generationAction).toEqual({
      action: "generate-image",
      operationId: "R100:generating:1:16e1daee7f6b",
      roundId: "R100",
      baseImagePath,
      instruction:
        "Edit the supplied base image using only these requested changes:\n- Make the background warmer.\nPreserve all unrelated subjects, composition, style, and details. Produce exactly one edited image."
    });
    expect((await store.get("R100"))?.phase).toBe("generating");

    const resultImagePath = join(directory, "result.png");
    await writeFile(resultImagePath, "test result fixture", "utf8");
    await executeCommand(
      "confirm-generation",
      { roundId: "R100", resultImagePath },
      store
    );
    const publicationAction = await executeCommand(
      "prepare-publication",
      { roundId: "R100" },
      store
    );
    expect(publicationAction).toMatchObject({
      action: "post-result-image",
      operationId: "R100:publishing:1:469d047ee160",
      resultImagePath,
      channelUrl: "https://discord.test/channels/allowlisted"
    });
    await executeCommand(
      "confirm-publication",
      { roundId: "R100", resultMessageUrl: "https://discord.test/messages/result" },
      store
    );

    expect(await executeCommand("plan-next", { roundId: "R100" }, store)).toEqual({
      type: "none",
      reason: "Round is already completed."
    });
    expect((await store.get("R100"))?.phase).toBe("completed");
  });
});
