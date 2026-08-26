import { chmod, lstat, mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  FEEDBACK_ACQUISITION_EVALUATION_FILE_ATTEMPT_LIMIT,
  FEEDBACK_ACQUISITION_EVALUATION_FILE_EXTENSION,
  FEEDBACK_ACQUISITION_EVALUATION_FILE_PREFIX,
  FEEDBACK_ACQUISITION_EVALUATION_COMPLETIONS,
  FEEDBACK_ACQUISITION_EVALUATION_CORRECTNESS_VALUES,
  FEEDBACK_ACQUISITION_EVALUATION_INTERRUPTION_BOUNDARIES,
  FEEDBACK_ACQUISITION_EVALUATION_PHASES,
  FEEDBACK_ACQUISITION_EVALUATION_RECOVERIES,
  FEEDBACK_ACQUISITION_EVALUATION_REPORT_ROOT,
  FEEDBACK_ACQUISITION_EVALUATION_SCENARIO_CODES,
  FEEDBACK_ACQUISITION_EVALUATION_SCHEMA_VERSION,
  FEEDBACK_ACQUISITION_EVALUATION_SINK_TIMEOUT_MS,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE
} from "../constants.js";

export { FEEDBACK_ACQUISITION_EVALUATION_SCHEMA_VERSION } from "../constants.js";

export const FEEDBACK_ACQUISITION_PHASES = FEEDBACK_ACQUISITION_EVALUATION_PHASES;

export type FeedbackAcquisitionPhase = typeof FEEDBACK_ACQUISITION_PHASES[number];
export type FeedbackAcquisitionRecovery =
  typeof FEEDBACK_ACQUISITION_EVALUATION_RECOVERIES[number];
export type FeedbackAcquisitionCompletion =
  typeof FEEDBACK_ACQUISITION_EVALUATION_COMPLETIONS[number];
export type FeedbackAcquisitionCorrectness =
  typeof FEEDBACK_ACQUISITION_EVALUATION_CORRECTNESS_VALUES[number];
export type FeedbackAcquisitionInterruptionBoundary =
  typeof FEEDBACK_ACQUISITION_EVALUATION_INTERRUPTION_BOUNDARIES[number];

type FaultMatrixRow = Readonly<{
  scenarioCode: string;
  completion: FeedbackAcquisitionCompletion;
  browserCopyActionCount: number;
  duplicateArtifactCount: number;
  skippedArtifactCount: number;
  reorderedArtifactCount: number;
  recovery: FeedbackAcquisitionRecovery;
}>;

const FAULT_CLASSIFICATIONS = [
  ["single-valid-image", "complete", 1, "automatic"],
  ["multiple-valid-images", "complete", 2, "automatic"],
  ["unsupported-or-excess-attachments", "complete", 0, "automatic"],
  ["clipboard-unchanged", "incomplete", 1, "needs-attention", 0, 1, 0],
  ["clipboard-over-advanced", "incomplete", 1, "needs-attention", 0, 1, 0],
  ["clipboard-unreadable", "incomplete", 1, "needs-attention", 0, 1, 0],
  ["clipboard-empty", "incomplete", 1, "needs-attention", 0, 1, 0],
  ["clipboard-multiple-images", "incomplete", 1, "needs-attention", 0, 1, 0],
  ["browser-copy-control-missing", "incomplete", 0, "needs-attention", 0, 1, 0],
  ["visible-attachment-ambiguous", "incomplete", 0, "needs-attention", 0, 1, 0],
  ["selection-order-changed", "incomplete", 0, "needs-attention", 0, 1, 1],
  ["interrupted-before-intent", "incomplete", 0, "automatic", 0, 1, 0],
  ["interrupted-after-intent-before-copy", "incomplete", 0, "needs-attention", 0, 1, 0],
  ["interrupted-after-copy-before-capture", "incomplete", 1, "needs-attention", 0, 1, 0],
  ["interrupted-during-staging", "incomplete", 1, "needs-attention", 0, 1, 0],
  ["interrupted-after-install-before-receipt", "incomplete", 1, "needs-attention", 0, 1, 0],
  ["interrupted-after-receipt-before-collection", "incomplete", 1, "resume"],
  ["interrupted-after-collection", "complete", 1, "resume"],
  ["restart-selected", "incomplete", 0, "resume", 0, 1, 0],
  ["restart-unresolved-intent", "incomplete", 0, "needs-attention", 0, 1, 0],
  ["restart-accepted-artifact", "complete", 0, "resume"],
  ["restart-collected-batch", "complete", 0, "resume"],
  ["artifact-missing", "incomplete", 0, "needs-attention", 0, 1, 0],
  ["artifact-corrupt", "incomplete", 0, "needs-attention", 0, 1, 0],
  ["artifact-symlinked", "incomplete", 0, "needs-attention", 0, 1, 0],
  ["artifact-aliased", "incomplete", 0, "needs-attention", 1, 0, 0],
  ["artifact-outside-capsule", "incomplete", 0, "needs-attention", 0, 1, 0],
  ["artifact-pre-existing", "incomplete", 1, "needs-attention", 1, 0, 0],
  ["host-unsupported", "incomplete", 0, "terminal", 0, 1, 0],
  ["pasteboard-unavailable", "incomplete", 0, "terminal", 0, 1, 0]
] as const satisfies ReadonlyArray<readonly [
  string,
  FeedbackAcquisitionCompletion,
  number,
  FeedbackAcquisitionRecovery,
  number?,
  number?,
  number?
]>;

export const FEEDBACK_ACQUISITION_FAULT_MATRIX: readonly FaultMatrixRow[] =
  FAULT_CLASSIFICATIONS.map(
    ([
      scenarioCode,
      completion,
      browserCopyActionCount,
      recovery,
      duplicateArtifactCount = 0,
      skippedArtifactCount = 0,
      reorderedArtifactCount = 0
    ]) => ({
      scenarioCode,
      completion,
      browserCopyActionCount,
      duplicateArtifactCount,
      skippedArtifactCount,
      reorderedArtifactCount,
      recovery
    })
  );

export const FAILED_BROWSER_DOWNLOAD_BASELINE = Object.freeze({
  scenarioCode: "browser-download-baseline",
  completion: "incomplete" as const,
  correctness: "unverifiable" as const,
  browserCopyActionCount: 0,
  otherBrowserAcquisitionActionCount: 1,
  manualInterventionRequired: true,
  recovery: "needs-attention" as const
});

const SCENARIO_CODES: ReadonlySet<string> = new Set(
  FEEDBACK_ACQUISITION_EVALUATION_SCENARIO_CODES
);

export interface MonotonicClock {
  now(): number;
}

export interface FeedbackAcquisitionEvaluationRecord {
  schemaVersion: 1;
  scenarioCode: string;
  completion: FeedbackAcquisitionCompletion;
  correctness: FeedbackAcquisitionCorrectness;
  expectedSelectedImageCount: number;
  acceptedArtifactCount: number;
  successfulFullDecodeCount: number;
  acceptedOrderMatched: boolean;
  phaseDurationsMs: Record<FeedbackAcquisitionPhase | "total", number>;
  browserCopyActionCount: number;
  otherBrowserAcquisitionActionCount: number;
  restartCount: number;
  cleanResume: boolean;
  manualInterventionRequired: boolean;
  interruptionBoundary: FeedbackAcquisitionInterruptionBoundary;
  duplicateArtifactCount: number;
  skippedArtifactCount: number;
  reorderedArtifactCount: number;
  recovery: FeedbackAcquisitionRecovery;
}

export type FeedbackAcquisitionEvaluationSummary = Omit<
  FeedbackAcquisitionEvaluationRecord,
  "schemaVersion" | "scenarioCode" | "phaseDurationsMs"
>;

const EVALUATION_SUMMARY_FIELDS = [
  "completion",
  "correctness",
  "expectedSelectedImageCount",
  "acceptedArtifactCount",
  "successfulFullDecodeCount",
  "acceptedOrderMatched",
  "browserCopyActionCount",
  "otherBrowserAcquisitionActionCount",
  "restartCount",
  "cleanResume",
  "manualInterventionRequired",
  "interruptionBoundary",
  "duplicateArtifactCount",
  "skippedArtifactCount",
  "reorderedArtifactCount",
  "recovery"
] as const;

const COMPLETIONS: ReadonlySet<string> = new Set(
  FEEDBACK_ACQUISITION_EVALUATION_COMPLETIONS
);
const CORRECTNESS_VALUES: ReadonlySet<string> = new Set(
  FEEDBACK_ACQUISITION_EVALUATION_CORRECTNESS_VALUES
);
const RECOVERIES: ReadonlySet<string> = new Set(
  FEEDBACK_ACQUISITION_EVALUATION_RECOVERIES
);
const INTERRUPTION_BOUNDARIES: ReadonlySet<string> = new Set(
  FEEDBACK_ACQUISITION_EVALUATION_INTERRUPTION_BOUNDARIES
);

export interface FeedbackAcquisitionEvaluationSink {
  write(record: FeedbackAcquisitionEvaluationRecord): Promise<boolean>;
}

export class LocalFeedbackAcquisitionEvaluationSink
implements FeedbackAcquisitionEvaluationSink {
  public constructor(
    private readonly reportRoot = FEEDBACK_ACQUISITION_EVALUATION_REPORT_ROOT
  ) {}

  public async write(record: FeedbackAcquisitionEvaluationRecord): Promise<boolean> {
    const validated = validateEvaluationRecord(record);
    try {
      await mkdir(this.reportRoot, {
        recursive: true,
        mode: PRIVATE_DIRECTORY_MODE
      });
      const rootInfo = await lstat(this.reportRoot);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        return false;
      }
      await chmod(this.reportRoot, PRIVATE_DIRECTORY_MODE);
      if (((await stat(this.reportRoot)).mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        return false;
      }
      return await this.writeExclusive(validated);
    } catch {
      return false;
    }
  }

  private async writeExclusive(record: FeedbackAcquisitionEvaluationRecord): Promise<boolean> {
    const content = `${JSON.stringify(record)}\n`;
    for (
      let sequence = 1;
      sequence <= FEEDBACK_ACQUISITION_EVALUATION_FILE_ATTEMPT_LIMIT;
      sequence += 1
    ) {
      const filename =
        `${FEEDBACK_ACQUISITION_EVALUATION_FILE_PREFIX}${String(sequence).padStart(6, "0")}` +
        FEEDBACK_ACQUISITION_EVALUATION_FILE_EXTENSION;
      let handle;
      try {
        handle = await open(join(this.reportRoot, filename), "wx", PRIVATE_FILE_MODE);
        await handle.writeFile(content, "utf8");
        await handle.sync();
        return true;
      } catch (error) {
        if (isFileExistsError(error)) {
          continue;
        }
        return false;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    return false;
  }
}

export class FeedbackAcquisitionEvaluationRecorder {
  public constructor(
    private readonly clock: MonotonicClock,
    private readonly sink: FeedbackAcquisitionEvaluationSink
  ) {}

  public start(scenarioCode: string): FeedbackAcquisitionEvaluationScenario {
    if (!SCENARIO_CODES.has(scenarioCode)) {
      throw new Error("Evaluation scenario code is unsupported.");
    }
    return new FeedbackAcquisitionEvaluationScenario(
      scenarioCode,
      this.clock,
      this.sink
    );
  }
}

export class FeedbackAcquisitionEvaluationScenario {
  private readonly startedAt: number;
  private readonly durations = new Map<FeedbackAcquisitionPhase, number>();

  public constructor(
    private scenarioCode: string,
    private readonly clock: MonotonicClock,
    private readonly sink: FeedbackAcquisitionEvaluationSink
  ) {
    this.startedAt = requireMonotonicReading(clock.now());
  }

  public startPhase(phase: FeedbackAcquisitionPhase): () => void {
    const startedAt = requireMonotonicReading(this.clock.now());
    let ended = false;
    return () => {
      if (ended) {
        throw new Error("Evaluation phase has already ended.");
      }
      ended = true;
      const endedAt = requireMonotonicReading(this.clock.now());
      if (endedAt < startedAt) {
        throw new Error("Evaluation monotonic clock moved backwards.");
      }
      this.durations.set(phase, (this.durations.get(phase) ?? 0) + endedAt - startedAt);
    };
  }

  public classify(scenarioCode: string): void {
    if (!SCENARIO_CODES.has(scenarioCode)) {
      throw new Error("Evaluation scenario code is unsupported.");
    }
    this.scenarioCode = scenarioCode;
  }

  public async finish(
    summary: FeedbackAcquisitionEvaluationSummary
  ): Promise<{ completion: FeedbackAcquisitionCompletion; reportWritten: boolean }> {
    const validatedSummary = validateEvaluationSummary(summary);
    const endedAt = requireMonotonicReading(this.clock.now());
    if (endedAt < this.startedAt) {
      throw new Error("Evaluation monotonic clock moved backwards.");
    }
    const phaseDurationsMs = Object.fromEntries([
      ...FEEDBACK_ACQUISITION_PHASES.map((phase) => [phase, this.durations.get(phase) ?? 0]),
      ["total", endedAt - this.startedAt]
    ]) as FeedbackAcquisitionEvaluationRecord["phaseDurationsMs"];
    const record: FeedbackAcquisitionEvaluationRecord = {
      schemaVersion: FEEDBACK_ACQUISITION_EVALUATION_SCHEMA_VERSION,
      scenarioCode: this.scenarioCode,
      ...validatedSummary,
      phaseDurationsMs
    };
    const reportWritten = await writeWithDeadline(this.sink, record);
    return { completion: validatedSummary.completion, reportWritten };
  }
}

async function writeWithDeadline(
  sink: FeedbackAcquisitionEvaluationSink,
  record: FeedbackAcquisitionEvaluationRecord
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      sink.write(record).catch(() => false),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(
          () => resolve(false),
          FEEDBACK_ACQUISITION_EVALUATION_SINK_TIMEOUT_MS
        );
      })
    ]);
  } catch {
    return false;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function validateEvaluationSummary(value: unknown): FeedbackAcquisitionEvaluationSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Evaluation summary must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== EVALUATION_SUMMARY_FIELDS.length ||
    Object.keys(record).some(
      (key) => !(EVALUATION_SUMMARY_FIELDS as readonly string[]).includes(key)
    )
  ) {
    throw new Error("Evaluation summary contains unsupported fields.");
  }
  return {
    completion: requireEnum(
      record.completion,
      COMPLETIONS,
      "Evaluation completion"
    ) as FeedbackAcquisitionCompletion,
    correctness: requireEnum(
      record.correctness,
      CORRECTNESS_VALUES,
      "Evaluation correctness"
    ) as FeedbackAcquisitionCorrectness,
    expectedSelectedImageCount: requireCount(record.expectedSelectedImageCount),
    acceptedArtifactCount: requireCount(record.acceptedArtifactCount),
    successfulFullDecodeCount: requireCount(record.successfulFullDecodeCount),
    acceptedOrderMatched: requireBoolean(record.acceptedOrderMatched),
    browserCopyActionCount: requireCount(record.browserCopyActionCount),
    otherBrowserAcquisitionActionCount: requireCount(
      record.otherBrowserAcquisitionActionCount
    ),
    restartCount: requireCount(record.restartCount),
    cleanResume: requireBoolean(record.cleanResume),
    manualInterventionRequired: requireBoolean(record.manualInterventionRequired),
    interruptionBoundary: requireEnum(
      record.interruptionBoundary,
      INTERRUPTION_BOUNDARIES,
      "Evaluation interruption boundary"
    ) as FeedbackAcquisitionInterruptionBoundary,
    duplicateArtifactCount: requireCount(record.duplicateArtifactCount),
    skippedArtifactCount: requireCount(record.skippedArtifactCount),
    reorderedArtifactCount: requireCount(record.reorderedArtifactCount),
    recovery: requireEnum(
      record.recovery,
      RECOVERIES,
      "Evaluation recovery"
    ) as FeedbackAcquisitionRecovery
  };
}

function validateEvaluationRecord(value: unknown): FeedbackAcquisitionEvaluationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Evaluation record must be an object.");
  }
  const record = value as Record<string, unknown>;
  const allowedFields = [
    "schemaVersion",
    "scenarioCode",
    ...EVALUATION_SUMMARY_FIELDS,
    "phaseDurationsMs"
  ];
  if (
    Object.keys(record).length !== allowedFields.length ||
    Object.keys(record).some((key) => !allowedFields.includes(key))
  ) {
    throw new Error("Evaluation record contains unsupported fields.");
  }
  if (record.schemaVersion !== FEEDBACK_ACQUISITION_EVALUATION_SCHEMA_VERSION) {
    throw new Error("Evaluation schema version is unsupported.");
  }
  if (typeof record.scenarioCode !== "string" || !SCENARIO_CODES.has(record.scenarioCode)) {
    throw new Error("Evaluation scenario code is unsupported.");
  }
  const summary = validateEvaluationSummary(Object.fromEntries(
    EVALUATION_SUMMARY_FIELDS.map((field) => [field, record[field]])
  ));
  const phaseDurationsMs = validatePhaseDurations(record.phaseDurationsMs);
  return {
    schemaVersion: FEEDBACK_ACQUISITION_EVALUATION_SCHEMA_VERSION,
    scenarioCode: record.scenarioCode,
    ...summary,
    phaseDurationsMs
  };
}

function validatePhaseDurations(
  value: unknown
): FeedbackAcquisitionEvaluationRecord["phaseDurationsMs"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Evaluation phase durations must be an object.");
  }
  const record = value as Record<string, unknown>;
  const phases = [...FEEDBACK_ACQUISITION_PHASES, "total"];
  if (
    Object.keys(record).length !== phases.length ||
    Object.keys(record).some((key) => !phases.includes(key))
  ) {
    throw new Error("Evaluation phase durations contain unsupported fields.");
  }
  return Object.fromEntries(phases.map((phase) => {
    const duration = record[phase];
    if (!Number.isFinite(duration) || (duration as number) < 0) {
      throw new Error("Evaluation phase durations must be non-negative finite numbers.");
    }
    return [phase, duration];
  })) as FeedbackAcquisitionEvaluationRecord["phaseDurationsMs"];
}

function requireCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Evaluation counts must be non-negative safe integers.");
  }
  return value as number;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("Evaluation flags must be boolean.");
  }
  return value;
}

function requireEnum(value: unknown, allowed: ReadonlySet<string>, name: string): string {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`${name} is unsupported.`);
  }
  return value;
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function requireMonotonicReading(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Evaluation monotonic clock returned an invalid reading.");
  }
  return value;
}
