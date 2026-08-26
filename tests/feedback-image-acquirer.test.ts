import { describe, expect, it } from "vitest";

import type { ClipboardImageSource } from "../src/clipboard/clipboard-image-source.js";
import { ClipboardImageSourceError } from "../src/clipboard/macos-clipboard-image-source.js";
import {
  FeedbackAcquisitionEvaluationRecorder,
  type FeedbackAcquisitionEvaluationRecord
} from "../src/evaluation/feedback-acquisition-evaluation.js";
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

  it("records sanitized capture measurements without changing the production result", async () => {
    const records: FeedbackAcquisitionEvaluationRecord[] = [];
    const evaluation = new FeedbackAcquisitionEvaluationRecorder(
      new FakeMonotonicClock([0, 1, 3, 4, 7, 8]),
      { write: async (record) => { records.push(record); return true; } }
    );
    const acquirer = new FeedbackImageAcquirer(
      new InMemoryRoundStateStore(intentRecordedRound("REVAL")),
      new FakeClipboardImageSource(41, {
        observedChangeCount: 42,
        pngBytes: new Uint8Array([1])
      }),
      new FakeArtifactStore("accepted-artifact"),
      evaluation
    );

    await expect(acquirer.capture({
      roundId: "REVAL",
      messageOrdinal: 1,
      attachmentIndex: 0
    })).resolves.toEqual({ action: "captured" });
    expect(records).toEqual([expect.objectContaining({
      scenarioCode: "image-capture",
      completion: "complete",
      correctness: "verified",
      expectedSelectedImageCount: 1,
      acceptedArtifactCount: 1,
      successfulFullDecodeCount: 1,
      acceptedOrderMatched: true,
      phaseDurationsMs: {
        preparation: 0,
        "browser-action": 0,
        "clipboard-read-decode": 2,
        "artifact-validation-install": 3,
        "collection-handoff": 0,
        total: 8
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
    })]);
  });

  it("does not let a stalled evaluation sink block a successful capture", async () => {
    const acquirer = new FeedbackImageAcquirer(
      new InMemoryRoundStateStore(intentRecordedRound("ESTALL")),
      new FakeClipboardImageSource(41, {
        observedChangeCount: 42,
        pngBytes: new Uint8Array([1])
      }),
      new FakeArtifactStore("accepted-artifact"),
      new FeedbackAcquisitionEvaluationRecorder(
        new IncrementingMonotonicClock(),
        { write: () => new Promise<boolean>(() => undefined) }
      )
    );

    const result = await Promise.race([
      acquirer.capture({ roundId: "ESTALL", messageOrdinal: 1, attachmentIndex: 0 }),
      new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 250))
    ]);
    expect(result).toEqual({ action: "captured" });
  });

  it("records controlled recovery classifications for clipboard ambiguity and restart", async () => {
    const records: FeedbackAcquisitionEvaluationRecord[] = [];
    const sink = { write: async (record: FeedbackAcquisitionEvaluationRecord) => {
      records.push(record);
      return true;
    } };
    const ambiguous = new FeedbackImageAcquirer(
      new InMemoryRoundStateStore(intentRecordedRound("EAMBIG")),
      new FakeClipboardImageSource(
        41,
        undefined,
        new ClipboardImageSourceError("no-image")
      ),
      unusedArtifacts(),
      new FeedbackAcquisitionEvaluationRecorder(
        new FakeMonotonicClock([0, 1, 2, 3]),
        sink
      )
    );
    await expect(ambiguous.capture({
      roundId: "EAMBIG",
      messageOrdinal: 1,
      attachmentIndex: 0
    })).resolves.toMatchObject({ action: "needs-attention" });

    const unresolved = new FeedbackImageAcquirer(
      new InMemoryRoundStateStore(intentRecordedRound("EINTENT")),
      new FakeClipboardImageSource(41),
      unusedArtifacts(),
      new FeedbackAcquisitionEvaluationRecorder(new FakeMonotonicClock([0, 1]), sink)
    );
    await unresolved.prepare({ roundId: "EINTENT", messageOrdinal: 1, attachmentIndex: 0 });

    const resumed = new FeedbackImageAcquirer(
      new InMemoryRoundStateStore(acceptedRound("ERESUME")),
      new FakeClipboardImageSource(41),
      unusedArtifacts(),
      new FeedbackAcquisitionEvaluationRecorder(new FakeMonotonicClock([0, 0, 0, 1]), sink)
    );
    await resumed.prepare({ roundId: "ERESUME", messageOrdinal: 1, attachmentIndex: 0 });

    expect(records.map((record) => ({
      scenarioCode: record.scenarioCode,
      completion: record.completion,
      browserCopyActionCount: record.browserCopyActionCount,
      restartCount: record.restartCount,
      manualInterventionRequired: record.manualInterventionRequired,
      interruptionBoundary: record.interruptionBoundary,
      recovery: record.recovery
    }))).toEqual([
      {
        scenarioCode: "clipboard-empty",
        completion: "incomplete",
        browserCopyActionCount: 1,
        restartCount: 0,
        manualInterventionRequired: true,
        interruptionBoundary: "after-copy-before-capture",
        recovery: "needs-attention"
      },
      {
        scenarioCode: "restart-unresolved-intent",
        completion: "incomplete",
        browserCopyActionCount: 0,
        restartCount: 1,
        manualInterventionRequired: true,
        interruptionBoundary: "after-intent-before-copy",
        recovery: "needs-attention"
      },
      {
        scenarioCode: "restart-accepted-artifact",
        completion: "complete",
        browserCopyActionCount: 0,
        restartCount: 1,
        manualInterventionRequired: false,
        interruptionBoundary: "after-receipt-before-collection",
        recovery: "resume"
      }
    ]);
  });

  it("measures preparation and classifies an unsupported host as terminal", async () => {
    const records: FeedbackAcquisitionEvaluationRecord[] = [];
    const sink = { write: async (record: FeedbackAcquisitionEvaluationRecord) => {
      records.push(record);
      return true;
    } };
    const prepared = new FeedbackImageAcquirer(
      new InMemoryRoundStateStore(plannedRound("EPREP")),
      new FakeClipboardImageSource(41),
      unusedArtifacts(),
      new FeedbackAcquisitionEvaluationRecorder(
        new FakeMonotonicClock([0, 1, 3, 4]),
        sink
      )
    );
    await expect(prepared.prepare({
      roundId: "EPREP",
      messageOrdinal: 1,
      attachmentIndex: 0
    })).resolves.toEqual({ action: "copy-visible-image" });

    const unsupportedClipboard: ClipboardImageSource = {
      getChangeCount: async () => { throw new ClipboardImageSourceError("unsupported-platform"); },
      readSingleImage: async () => { throw new Error("unused"); }
    };
    const unsupported = new FeedbackImageAcquirer(
      new InMemoryRoundStateStore(plannedRound("EHOST")),
      unsupportedClipboard,
      unusedArtifacts(),
      new FeedbackAcquisitionEvaluationRecorder(
        new FakeMonotonicClock([0, 1, 2, 3]),
        sink
      )
    );
    await expect(unsupported.prepare({
      roundId: "EHOST",
      messageOrdinal: 1,
      attachmentIndex: 0
    })).resolves.toMatchObject({ action: "needs-attention" });

    expect(records.map((record) => ({
      scenarioCode: record.scenarioCode,
      completion: record.completion,
      preparationMs: record.phaseDurationsMs.preparation,
      browserCopyActionCount: record.browserCopyActionCount,
      manualInterventionRequired: record.manualInterventionRequired,
      recovery: record.recovery
    }))).toEqual([
      {
        scenarioCode: "image-prepare",
        completion: "incomplete",
        preparationMs: 2,
        browserCopyActionCount: 0,
        manualInterventionRequired: false,
        recovery: "automatic"
      },
      {
        scenarioCode: "host-unsupported",
        completion: "incomplete",
        preparationMs: 1,
        browserCopyActionCount: 0,
        manualInterventionRequired: false,
        recovery: "terminal"
      }
    ]);
  });

  it("emits truthful records for returned clipboard, artifact, receipt, and order faults", async () => {
    const cases: Array<{
      expected: Partial<FeedbackAcquisitionEvaluationRecord>;
      run: (evaluation: FeedbackAcquisitionEvaluationRecorder) => Promise<unknown>;
    }> = [
      {
        expected: {
          scenarioCode: "clipboard-unchanged",
          successfulFullDecodeCount: 0,
          skippedArtifactCount: 1,
          recovery: "needs-attention"
        },
        run: (evaluation) => new FeedbackImageAcquirer(
          new InMemoryRoundStateStore(intentRecordedRound("COUNT1")),
          new FakeClipboardImageSource(41, {
            observedChangeCount: 41,
            pngBytes: new Uint8Array([1])
          }),
          unusedArtifacts(),
          evaluation
        ).capture({ roundId: "COUNT1", messageOrdinal: 1, attachmentIndex: 0 })
      },
      {
        expected: {
          scenarioCode: "clipboard-over-advanced",
          successfulFullDecodeCount: 0,
          skippedArtifactCount: 1,
          recovery: "needs-attention"
        },
        run: (evaluation) => new FeedbackImageAcquirer(
          new InMemoryRoundStateStore(intentRecordedRound("COUNT2")),
          new FakeClipboardImageSource(41, {
            observedChangeCount: 43,
            pngBytes: new Uint8Array([1])
          }),
          unusedArtifacts(),
          evaluation
        ).capture({ roundId: "COUNT2", messageOrdinal: 1, attachmentIndex: 0 })
      },
      {
        expected: {
          scenarioCode: "clipboard-unreadable",
          successfulFullDecodeCount: 0,
          skippedArtifactCount: 1,
          recovery: "needs-attention"
        },
        run: (evaluation) => new FeedbackImageAcquirer(
          new InMemoryRoundStateStore(intentRecordedRound("BYTES")),
          new FakeClipboardImageSource(41, {
            observedChangeCount: 42,
            pngBytes: new Uint8Array()
          }),
          unusedArtifacts(),
          evaluation
        ).capture({ roundId: "BYTES", messageOrdinal: 1, attachmentIndex: 0 })
      },
      {
        expected: {
          scenarioCode: "artifact-install-failed",
          successfulFullDecodeCount: 0,
          skippedArtifactCount: 1,
          recovery: "needs-attention"
        },
        run: (evaluation) => new FeedbackImageAcquirer(
          new InMemoryRoundStateStore(intentRecordedRound("INSTALL")),
          new FakeClipboardImageSource(41, {
            observedChangeCount: 42,
            pngBytes: new Uint8Array([1])
          }),
          new FakeArtifactStore("unused", new Error("private install failure")),
          evaluation
        ).capture({ roundId: "INSTALL", messageOrdinal: 1, attachmentIndex: 0 })
      },
      {
        expected: {
          scenarioCode: "receipt-persistence-failed",
          acceptedArtifactCount: 0,
          successfulFullDecodeCount: 1,
          skippedArtifactCount: 1,
          interruptionBoundary: "after-install-before-receipt",
          recovery: "needs-attention"
        },
        run: (evaluation) => new FeedbackImageAcquirer(
          new FailNextSaveRoundStateStore(intentRecordedRound("RECEIPT")),
          new FakeClipboardImageSource(41, {
            observedChangeCount: 42,
            pngBytes: new Uint8Array([1])
          }),
          new FakeArtifactStore("installed-artifact"),
          evaluation
        ).capture({ roundId: "RECEIPT", messageOrdinal: 1, attachmentIndex: 0 })
      },
      {
        expected: {
          scenarioCode: "artifact-validation-failed",
          acceptedArtifactCount: 1,
          successfulFullDecodeCount: 0,
          skippedArtifactCount: 1,
          recovery: "needs-attention"
        },
        run: (evaluation) => new FeedbackImageAcquirer(
          new InMemoryRoundStateStore(acceptedRound("VALIDATE")),
          new FakeClipboardImageSource(41),
          new FakeArtifactStore("accepted-artifact", new Error("unused"), new Error("private validation failure")),
          evaluation
        ).prepare({ roundId: "VALIDATE", messageOrdinal: 1, attachmentIndex: 0 })
      },
      {
        expected: {
          scenarioCode: "selection-order-changed",
          skippedArtifactCount: 1,
          reorderedArtifactCount: 1,
          recovery: "needs-attention"
        },
        run: (evaluation) => new FeedbackImageAcquirer(
          new InMemoryRoundStateStore(plannedRound("ORDER")),
          new FakeClipboardImageSource(41),
          unusedArtifacts(),
          evaluation
        ).prepare({ roundId: "ORDER", messageOrdinal: 2, attachmentIndex: 0 })
      },
      {
        expected: {
          scenarioCode: "selection-order-changed",
          skippedArtifactCount: 1,
          reorderedArtifactCount: 0,
          recovery: "needs-attention"
        },
        run: (evaluation) => new FeedbackImageAcquirer(
          new InMemoryRoundStateStore(plannedRound("SKIPPED")),
          new FakeClipboardImageSource(41),
          unusedArtifacts(),
          evaluation
        ).capture({ roundId: "SKIPPED", messageOrdinal: 1, attachmentIndex: 0 })
      },
      {
        expected: {
          scenarioCode: "selection-order-changed",
          acceptedArtifactCount: 1,
          successfulFullDecodeCount: 1,
          duplicateArtifactCount: 1,
          skippedArtifactCount: 0,
          reorderedArtifactCount: 0,
          recovery: "needs-attention"
        },
        run: (evaluation) => new FeedbackImageAcquirer(
          new InMemoryRoundStateStore(acceptedRound("DUPLICATE")),
          new FakeClipboardImageSource(41),
          unusedArtifacts(),
          evaluation
        ).capture({ roundId: "DUPLICATE", messageOrdinal: 1, attachmentIndex: 0 })
      }
    ];

    for (const { expected, run } of cases) {
      const records: FeedbackAcquisitionEvaluationRecord[] = [];
      await run(new FeedbackAcquisitionEvaluationRecorder(
        new IncrementingMonotonicClock(),
        { write: async (record) => { records.push(record); return true; } }
      ));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        completion: "incomplete",
        correctness: "unverifiable",
        expectedSelectedImageCount: 1,
        browserCopyActionCount: expected.scenarioCode?.startsWith("clipboard-") ||
          expected.scenarioCode === "artifact-install-failed" ||
          expected.scenarioCode === "receipt-persistence-failed" ? 1 : 0,
        manualInterventionRequired: true,
        ...expected
      });
    }
  });

  it.each([
    ["unchanged clipboard", new FakeClipboardImageSource(41, { observedChangeCount: 41, pngBytes: new Uint8Array([1]) })],
    ["over-advanced clipboard", new FakeClipboardImageSource(41, { observedChangeCount: 43, pngBytes: new Uint8Array([1]) })],
    ["unreadable clipboard", new FakeClipboardImageSource(41, undefined, new Error("private decoder failure"))],
    ["empty pasteboard", new FakeClipboardImageSource(41, undefined, new Error("zero clipboard image items"))],
    ["multiple clipboard images", new FakeClipboardImageSource(41, undefined, new Error("multiple clipboard image items"))],
    ["clipboard adapter failure", new FakeClipboardImageSource(41, undefined, new Error("private adapter failure"))]
  ])("fails closed for %s without accepting an artifact", async (_scenario, clipboard) => {
    const store = new InMemoryRoundStateStore(intentRecordedRound("RFAIL"));
    const artifacts = new FakeArtifactStore("accepted-artifact");
    const acquirer = new FeedbackImageAcquirer(store, clipboard, artifacts);

    await expect(acquirer.capture({ roundId: "RFAIL", messageOrdinal: 1, attachmentIndex: 0 }))
      .resolves.toEqual({ action: "needs-attention", reason: "Clipboard image capture is ambiguous; reconcile the Feedback Round manually." });
    expect(artifacts.accepted).toEqual([]);
    expect(store.saved.at(-1)).toMatchObject({
      phase: "needs-attention",
      attentionReason: "Clipboard image capture is ambiguous; reconcile the Feedback Round manually."
    });
    expect(JSON.stringify(store.saved.at(-1))).not.toContain("private decoder failure");
  });

  it("fails closed when the artifact installation fails without saving an accepted receipt", async () => {
    const store = new InMemoryRoundStateStore(intentRecordedRound("RARTIFACT"));
    const artifacts = new FakeArtifactStore("accepted-artifact", new Error("private install failure"));
    const acquirer = new FeedbackImageAcquirer(
      store,
      new FakeClipboardImageSource(41, { observedChangeCount: 42, pngBytes: new Uint8Array([1]) }),
      artifacts
    );

    await expect(acquirer.capture({ roundId: "RARTIFACT", messageOrdinal: 1, attachmentIndex: 0 }))
      .resolves.toEqual({ action: "needs-attention", reason: "Feedback image installation is ambiguous; reconcile the Feedback Round manually." });
    expect(artifacts.accepted).toEqual([]);
    expect(store.saved.at(-1)).toMatchObject({
      phase: "needs-attention",
      feedbackCaptureBatch: { messages: [{ selectedAttachments: [{ status: "copy-intent-recorded" }] }] }
    });
    expect(JSON.stringify(store.saved.at(-1))).not.toContain("private install failure");
  });

  it("does not touch the clipboard for capture without intent or a non-next tuple", async () => {
    const clipboard = new FakeClipboardImageSource(41, { observedChangeCount: 42, pngBytes: new Uint8Array([1]) });
    const store = new InMemoryRoundStateStore(plannedRound("RMISMATCH"));
    const acquirer = new FeedbackImageAcquirer(store, clipboard, unusedArtifacts());

    await expect(acquirer.capture({ roundId: "RMISMATCH", messageOrdinal: 1, attachmentIndex: 0 }))
      .resolves.toMatchObject({ action: "needs-attention" });
    expect(clipboard.readRequests).toEqual([]);

    const nextStore = new InMemoryRoundStateStore(plannedRound("RNEXT"));
    const nextAcquirer = new FeedbackImageAcquirer(nextStore, clipboard, unusedArtifacts());
    await expect(nextAcquirer.prepare({ roundId: "RNEXT", messageOrdinal: 2, attachmentIndex: 0 }))
      .resolves.toMatchObject({ action: "needs-attention" });
    expect(clipboard.getChangeCountCalls).toBe(0);
  });

  it("does not touch the clipboard or artifacts for a wrong tuple against a recorded intent", async () => {
    const clipboard = new FakeClipboardImageSource(41, { observedChangeCount: 42, pngBytes: new Uint8Array([1]) });
    const artifacts = new FakeArtifactStore("accepted-artifact");
    const acquirer = new FeedbackImageAcquirer(
      new InMemoryRoundStateStore(intentRecordedRound("RINTENT")),
      clipboard,
      artifacts
    );

    await expect(acquirer.capture({ roundId: "RINTENT", messageOrdinal: 1, attachmentIndex: 1 }))
      .resolves.toMatchObject({ action: "needs-attention" });
    expect(clipboard.readRequests).toEqual([]);
    expect(artifacts.accepted).toEqual([]);
  });

  it("hides state-store list and attention-save failures before any clipboard or artifact action", async () => {
    const clipboard = new FakeClipboardImageSource(41, { observedChangeCount: 42, pngBytes: new Uint8Array([1]) });
    const artifacts = new FakeArtifactStore("accepted-artifact");
    const listFailure = new FeedbackImageAcquirer(
      new InMemoryRoundStateStore(plannedRound("RLIST"), new Error("private list failure")),
      clipboard,
      artifacts
    );

    await expect(listFailure.prepare({ roundId: "RLIST", messageOrdinal: 1, attachmentIndex: 0 }))
      .rejects.toThrow("Feedback image capture state is unavailable.");

    const attentionSaveFailure = new FeedbackImageAcquirer(
      new InMemoryRoundStateStore(plannedRound("RSAVE"), undefined, new Error("private attention save failure")),
      clipboard,
      artifacts
    );
    await expect(attentionSaveFailure.prepare({ roundId: "RSAVE", messageOrdinal: 2, attachmentIndex: 0 }))
      .rejects.toThrow("Unable to persist controlled Needs Attention state.");
    expect(clipboard.getChangeCountCalls).toBe(0);
    expect(clipboard.readRequests).toEqual([]);
    expect(artifacts.accepted).toEqual([]);
  });

  it("marks an unresolved copy intent as needing attention without another copy preparation", async () => {
    const clipboard = new FakeClipboardImageSource(41);
    const store = new InMemoryRoundStateStore(intentRecordedRound("RRESTART"));
    const acquirer = new FeedbackImageAcquirer(store, clipboard, unusedArtifacts());

    await expect(acquirer.prepare({ roundId: "RRESTART", messageOrdinal: 1, attachmentIndex: 0 }))
      .resolves.toEqual({ action: "needs-attention", reason: "A feedback image copy may already have occurred; reconcile the Feedback Round manually." });
    expect(clipboard.getChangeCountCalls).toBe(0);
  });

  it("reuses an accepted receipt without copying and rejects a duplicate capture", async () => {
    const clipboard = new FakeClipboardImageSource(41, { observedChangeCount: 42, pngBytes: new Uint8Array([1]) });
    const artifacts = new FakeArtifactStore("accepted-artifact");
    const store = new InMemoryRoundStateStore(acceptedRound("RREUSE"));
    const acquirer = new FeedbackImageAcquirer(store, clipboard, artifacts);

    await expect(acquirer.prepare({ roundId: "RREUSE", messageOrdinal: 1, attachmentIndex: 0 }))
      .resolves.toEqual({ action: "reuse-accepted-image" });
    expect(clipboard.getChangeCountCalls).toBe(0);
    await expect(acquirer.capture({ roundId: "RREUSE", messageOrdinal: 1, attachmentIndex: 0 }))
      .resolves.toMatchObject({ action: "needs-attention" });
    expect(clipboard.readRequests).toEqual([]);
  });
});

class FakeClipboardImageSource implements ClipboardImageSource {
  public getChangeCountCalls = 0;
  public readonly readRequests: number[] = [];

  public constructor(
    private readonly changeCount: number,
    private readonly image: { observedChangeCount: number; pngBytes: Uint8Array } | undefined = { observedChangeCount: 0, pngBytes: new Uint8Array() },
    private readonly error?: Error
  ) {}

  public async getChangeCount(): Promise<number> {
    this.getChangeCountCalls += 1;
    return this.changeCount;
  }

  public async readSingleImage(previousChangeCount: number): Promise<{ observedChangeCount: number; pngBytes: Uint8Array }> {
    this.readRequests.push(previousChangeCount);
    if (this.error) {
      throw this.error;
    }
    if (!this.image) {
      throw new Error("clipboard image unavailable");
    }
    return this.image;
  }
}

class FakeMonotonicClock {
  public constructor(private readonly readings: number[]) {}

  public now(): number {
    const reading = this.readings.shift();
    if (reading === undefined) {
      throw new Error("No monotonic clock reading remains.");
    }
    return reading;
  }
}

class IncrementingMonotonicClock {
  private value = 0;
  public now(): number { return this.value++; }
}

class FakeArtifactStore implements RoundArtifactStore {
  public readonly accepted: Array<{
    roundId: string;
    messageOrdinal: number;
    attachmentIndex: number;
    pngBytes: Uint8Array;
  }> = [];

  public constructor(
    private readonly imagePath: string,
    private readonly error?: Error,
    private readonly validationError?: Error
  ) {}

  public async acceptFeedbackImageBytes(
    roundId: string,
    messageOrdinal: number,
    attachmentIndex: number,
    pngBytes: Uint8Array
  ): Promise<string> {
    if (this.error) {
      throw this.error;
    }
    this.accepted.push({ roundId, messageOrdinal, attachmentIndex, pngBytes });
    return this.imagePath;
  }

  public async acceptBaseImage(): Promise<string> { return ""; }
  public async acceptResultImage(): Promise<string> { return ""; }
  public async requireResultImage(): Promise<string> { return ""; }
  public async requireFeedbackImage(): Promise<string> {
    if (this.validationError) {
      throw this.validationError;
    }
    return this.imagePath;
  }
  public async copyResultAsBase(): Promise<string> { return ""; }
  public async discardUnpersistedBase(): Promise<void> {}
}

class InMemoryRoundStateStore implements RoundStateStore {
  public readonly saved: RoundState[] = [];

  public constructor(
    private current: RoundState,
    private readonly listError?: Error,
    private readonly saveError?: Error
  ) {}

  public async get(roundId: string): Promise<RoundState | undefined> {
    return this.current.id === roundId ? this.current : undefined;
  }

  public async list(): Promise<RoundState[]> {
    if (this.listError) {
      throw this.listError;
    }
    return [this.current];
  }

  public async save(round: RoundState): Promise<void> {
    if (this.saveError) {
      throw this.saveError;
    }
    this.current = round;
    this.saved.push(round);
  }
}

class FailNextSaveRoundStateStore implements RoundStateStore {
  private failed = false;

  public constructor(private current: RoundState) {}
  public async get(roundId: string): Promise<RoundState | undefined> {
    return this.current.id === roundId ? this.current : undefined;
  }
  public async list(): Promise<RoundState[]> { return [this.current]; }
  public async save(round: RoundState): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("private receipt persistence failure");
    }
    this.current = round;
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

function acceptedRound(roundId: string): RoundState {
  return applyRoundEvent(intentRecordedRound(roundId), {
    type: "feedback-image-accepted",
    messageOrdinal: 1,
    attachmentIndex: 0,
    imagePath: "accepted-artifact"
  });
}

function unusedArtifacts(): RoundArtifactStore {
  return {
    acceptBaseImage: async () => "",
    acceptResultImage: async () => "",
    requireResultImage: async () => "",
    acceptFeedbackImageBytes: async () => "",
    requireFeedbackImage: async () => "",
    copyResultAsBase: async () => "",
    discardUnpersistedBase: async () => undefined
  };
}
