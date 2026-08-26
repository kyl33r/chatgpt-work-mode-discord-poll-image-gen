import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FAILED_BROWSER_DOWNLOAD_BASELINE,
  FEEDBACK_ACQUISITION_FAULT_MATRIX,
  FeedbackAcquisitionEvaluationRecorder,
  LocalFeedbackAcquisitionEvaluationSink,
  type FeedbackAcquisitionEvaluationRecord,
  type FeedbackAcquisitionEvaluationSink,
  type MonotonicClock
} from "../src/evaluation/feedback-acquisition-evaluation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("feedback acquisition evaluation", () => {
  it("records only the closed sanitized schema with monotonic phase durations", async () => {
    const clock = new FakeMonotonicClock([10, 10, 14, 20, 29, 29]);
    const sink = new InMemoryEvaluationSink();
    const evaluation = new FeedbackAcquisitionEvaluationRecorder(clock, sink);
    const scenario = evaluation.start("single-valid-image");

    const endPreparation = scenario.startPhase("preparation");
    endPreparation();
    const endClipboardRead = scenario.startPhase("clipboard-read-decode");
    endClipboardRead();

    await expect(scenario.finish(validSummary())).resolves.toEqual({
      completion: "complete",
      reportWritten: true
    });

    expect(sink.records).toEqual([{
      schemaVersion: 1,
      scenarioCode: "single-valid-image",
      completion: "complete",
      correctness: "verified",
      expectedSelectedImageCount: 1,
      acceptedArtifactCount: 1,
      successfulFullDecodeCount: 1,
      acceptedOrderMatched: true,
      phaseDurationsMs: {
        preparation: 4,
        "browser-action": 0,
        "clipboard-read-decode": 9,
        "artifact-validation-install": 0,
        "collection-handoff": 0,
        total: 19
      },
      browserCopyActionCount: 1,
      otherBrowserAcquisitionActionCount: 0,
      restartCount: 0,
      cleanResume: false,
      manualInterventionRequired: false,
      interruptionBoundary: "none",
      duplicateArtifactCount: 0,
      skippedArtifactCount: 0,
      reorderedArtifactCount: 0,
      recovery: "automatic"
    }]);
  });

  it("rejects forbidden private fields rather than redacting them", async () => {
    const forbiddenFields = {
      wallClockTimestamp: "2026-08-27T00:00:00.000Z",
      clipboardBytes: new Uint8Array([1]),
      clipboardType: "image/tiff",
      imageHash: "synthetic-hash",
      imageWidth: 1,
      filename: "private.png",
      messageText: "private text",
      authorName: "private author",
      url: "https://discord.test/private",
      discordId: "123456789012345678",
      roundId: "PRIVATE-ROUND",
      path: "/private/path",
      rawError: "private failure",
      domExcerpt: "<private>"
    };

    for (const [field, value] of Object.entries(forbiddenFields)) {
      const sink = new InMemoryEvaluationSink();
      const scenario = new FeedbackAcquisitionEvaluationRecorder(
        new FakeMonotonicClock([0, 1]),
        sink
      ).start("single-valid-image");
      const invalid = { ...validSummary(), [field]: value };

      await expect(scenario.finish(invalid)).rejects.toThrow(
        "Evaluation summary contains unsupported fields."
      );
      expect(sink.records).toEqual([]);
    }
  });

  it("classifies the fixed fault matrix with truthful integrity counts", () => {
    expect(FEEDBACK_ACQUISITION_FAULT_MATRIX.map((row) => ({
      scenarioCode: row.scenarioCode,
      completion: row.completion,
      browserCopyActionCount: row.browserCopyActionCount,
      recovery: row.recovery
    }))).toEqual([
      ["single-valid-image", "complete", 1, "automatic"],
      ["multiple-valid-images", "complete", 2, "automatic"],
      ["unsupported-or-excess-attachments", "complete", 0, "automatic"],
      ["clipboard-unchanged", "incomplete", 1, "needs-attention"],
      ["clipboard-over-advanced", "incomplete", 1, "needs-attention"],
      ["clipboard-unreadable", "incomplete", 1, "needs-attention"],
      ["clipboard-empty", "incomplete", 1, "needs-attention"],
      ["clipboard-multiple-images", "incomplete", 1, "needs-attention"],
      ["browser-copy-control-missing", "incomplete", 0, "needs-attention"],
      ["visible-attachment-ambiguous", "incomplete", 0, "needs-attention"],
      ["selection-order-changed", "incomplete", 0, "needs-attention"],
      ["interrupted-before-intent", "incomplete", 0, "automatic"],
      ["interrupted-after-intent-before-copy", "incomplete", 0, "needs-attention"],
      ["interrupted-after-copy-before-capture", "incomplete", 1, "needs-attention"],
      ["interrupted-during-staging", "incomplete", 1, "needs-attention"],
      ["interrupted-after-install-before-receipt", "incomplete", 1, "needs-attention"],
      ["interrupted-after-receipt-before-collection", "incomplete", 1, "resume"],
      ["interrupted-after-collection", "complete", 1, "resume"],
      ["restart-selected", "incomplete", 0, "resume"],
      ["restart-unresolved-intent", "incomplete", 0, "needs-attention"],
      ["restart-accepted-artifact", "complete", 0, "resume"],
      ["restart-collected-batch", "complete", 0, "resume"],
      ["artifact-missing", "incomplete", 0, "needs-attention"],
      ["artifact-corrupt", "incomplete", 0, "needs-attention"],
      ["artifact-symlinked", "incomplete", 0, "needs-attention"],
      ["artifact-aliased", "incomplete", 0, "needs-attention"],
      ["artifact-outside-capsule", "incomplete", 0, "needs-attention"],
      ["artifact-pre-existing", "incomplete", 1, "needs-attention"],
      ["host-unsupported", "incomplete", 0, "terminal"],
      ["pasteboard-unavailable", "incomplete", 0, "terminal"]
    ].map(([scenarioCode, completion, browserCopyActionCount, recovery]) => ({
      scenarioCode,
      completion,
      browserCopyActionCount,
      recovery
    })));
    expect(FEEDBACK_ACQUISITION_FAULT_MATRIX.find(
      (row) => row.scenarioCode === "selection-order-changed"
    )).toMatchObject({ skippedArtifactCount: 1, reorderedArtifactCount: 1 });
    expect(FEEDBACK_ACQUISITION_FAULT_MATRIX.find(
      (row) => row.scenarioCode === "artifact-aliased"
    )).toMatchObject({ duplicateArtifactCount: 1 });
    expect(FEEDBACK_ACQUISITION_FAULT_MATRIX.find(
      (row) => row.scenarioCode === "clipboard-empty"
    )).toMatchObject({ skippedArtifactCount: 1 });
    expect(FAILED_BROWSER_DOWNLOAD_BASELINE).toEqual({
      scenarioCode: "browser-download-baseline",
      completion: "incomplete",
      correctness: "unverifiable",
      browserCopyActionCount: 0,
      otherBrowserAcquisitionActionCount: 1,
      manualInterventionRequired: true,
      recovery: "needs-attention"
    });
  });

  it("writes private reports exclusively without returning a path or content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-evaluation-"));
    temporaryDirectories.push(directory);
    const reportRoot = join(directory, "reports");
    const sink = new LocalFeedbackAcquisitionEvaluationSink(reportRoot);

    const first = new FeedbackAcquisitionEvaluationRecorder(
      new FakeMonotonicClock([0, 1]),
      sink
    ).start("single-valid-image");
    const second = new FeedbackAcquisitionEvaluationRecorder(
      new FakeMonotonicClock([0, 1]),
      sink
    ).start("single-valid-image");

    await expect(first.finish(validSummary())).resolves.toEqual({
      completion: "complete",
      reportWritten: true
    });
    await expect(second.finish(validSummary())).resolves.toEqual({
      completion: "complete",
      reportWritten: true
    });

    expect((await stat(reportRoot)).mode & 0o777).toBe(0o700);
    const files = await readdir(reportRoot);
    expect(files).toEqual(["evaluation-000001.json", "evaluation-000002.json"]);
    for (const file of files) {
      const reportPath = join(reportRoot, file);
      expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        schemaVersion: 1,
        scenarioCode: "single-valid-image",
        completion: "complete",
        recovery: "automatic"
      });
    }
  });

  it("keeps the production outcome independent from report failure and emits no fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feedback-evaluation-"));
    temporaryDirectories.push(directory);
    const unavailableRoot = join(directory, "not-a-directory");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(unavailableRoot, "occupied", { mode: 0o600 })
    );
    const scenario = new FeedbackAcquisitionEvaluationRecorder(
      new FakeMonotonicClock([0, 1]),
      new LocalFeedbackAcquisitionEvaluationSink(unavailableRoot)
    ).start("single-valid-image");

    await expect(scenario.finish(validSummary())).resolves.toEqual({
      completion: "complete",
      reportWritten: false
    });
    expect(await readdir(directory)).toEqual(["not-a-directory"]);

    const throwing = new FeedbackAcquisitionEvaluationRecorder(
      new FakeMonotonicClock([0, 1]),
      { write: async () => { throw new Error("private report failure"); } }
    ).start("single-valid-image");
    await expect(throwing.finish(validSummary())).resolves.toEqual({
      completion: "complete",
      reportWritten: false
    });
  });

  it("bounds a never-settling report sink so production cannot be blocked", async () => {
    const scenario = new FeedbackAcquisitionEvaluationRecorder(
      new FakeMonotonicClock([0, 1]),
      { write: () => new Promise<boolean>(() => undefined) }
    ).start("single-valid-image");

    const outcome = await Promise.race([
      scenario.finish(validSummary()),
      new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 250))
    ]);

    expect(outcome).toEqual({ completion: "complete", reportWritten: false });
  });
});

function validSummary() {
  return {
    completion: "complete" as const,
    correctness: "verified" as const,
    expectedSelectedImageCount: 1,
    acceptedArtifactCount: 1,
    successfulFullDecodeCount: 1,
    acceptedOrderMatched: true,
    browserCopyActionCount: 1,
    otherBrowserAcquisitionActionCount: 0,
    restartCount: 0,
    cleanResume: false,
    manualInterventionRequired: false,
    interruptionBoundary: "none" as const,
    duplicateArtifactCount: 0,
    skippedArtifactCount: 0,
    reorderedArtifactCount: 0,
    recovery: "automatic" as const
  };
}

class FakeMonotonicClock implements MonotonicClock {
  public constructor(private readonly readings: number[]) {}

  public now(): number {
    const reading = this.readings.shift();
    if (reading === undefined) {
      throw new Error("No monotonic clock reading remains.");
    }
    return reading;
  }
}

class InMemoryEvaluationSink implements FeedbackAcquisitionEvaluationSink {
  public readonly records: FeedbackAcquisitionEvaluationRecord[] = [];

  public async write(record: FeedbackAcquisitionEvaluationRecord): Promise<boolean> {
    this.records.push(record);
    return true;
  }
}
