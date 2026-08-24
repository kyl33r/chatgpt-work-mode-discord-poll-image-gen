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
  it("completes one five-message image round across every external-action boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-round-lifecycle-"));
    temporaryDirectories.push(directory);
    const store = new JsonRoundStateStore(join(directory, "rounds.json"));
    const requestedBaseImagePath = join(directory, "base.png");
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
        { baseImageStagingRoot: directory }
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
      action: "post-collection-closed",
      operationId: "R100:closing-collection:1:469d047ee160"
    });

    await executeCommand(
      "confirm-collection-closed",
      { roundId: "R100", closedMessageUrl: "https://discord.test/messages/closed" },
      store
    );
    expect(await executeCommand("prepare-generation", { roundId: "R100" }, store)).toMatchObject({
      action: "generate-image",
      operationId: "R100:generating:1:16e1daee7f6b"
    });

    const resultImagePath = join(directory, "result.png");
    await writeFile(resultImagePath, "test result fixture", "utf8");
    await executeCommand(
      "confirm-generation",
      { roundId: "R100", outcome: "succeeded", resultImagePath },
      store
    );
    expect(
      await executeCommand("prepare-publication", { roundId: "R100" }, store)
    ).toMatchObject({
      action: "post-result-image",
      operationId: "R100:publishing-outcome:1:469d047ee160",
      resultImagePath,
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
      generationOutcome: { kind: "succeeded", resultImagePath },
      outcomeMessageUrl: "https://discord.test/messages/result"
    });
  });
});
