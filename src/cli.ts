import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASE_IMAGE_STAGING_ROOT,
  DISCORD_SCAN_INTERVAL_MS,
  FEEDBACK_MESSAGE_LIMIT,
  GENERATION_FAILED_TEMPLATE,
  GENERATION_REFUSED_TEMPLATE,
  IMAGE_EDIT_PREAMBLE,
  IMAGE_EDIT_SUFFIX,
  MESSAGE_COLLECTION_INSTRUCTIONS_TEMPLATE,
  OPERATION_TURN_NUMBER,
  POLL_CLOSED_MARKER_TEMPLATE,
  POLL_START_MARKER_TEMPLATE,
  RESULT_MARKER_TEMPLATE,
  ROUND_STATE_PATH,
  SUPPORTED_IMAGE_EXTENSIONS
} from "./constants.js";
import {
  collectMessages,
  MessageCollectionAmbiguityError,
  type DiscordMessageObservation
} from "./round/message-collector.js";
import { createOperationId, planNextAction } from "./round/idempotency.js";
import {
  applyRoundEvent,
  createRound,
  type RoundEvent,
  type RoundPhase
} from "./round/round-state.js";
import {
  JsonRoundStateStore,
  type RoundStateStore
} from "./round/round-state-store.js";

interface CommandOptions {
  allowedChannelUrl?: string;
  baseImageStagingRoot?: string;
}

export async function executeCommand(
  command: string,
  payload: unknown,
  store: RoundStateStore,
  options: CommandOptions = {}
): Promise<unknown> {
  await assertAllowedChannel(command, payload, store, options.allowedChannelUrl);
  if (command === "prepare-base-submission") {
    return prepareBaseSubmission(
      payload,
      store,
      options.baseImageStagingRoot ?? BASE_IMAGE_STAGING_ROOT
    );
  }
  if (command === "confirm-base-submission") {
    return applyNamedEvent(payload, store, (record) => ({
      type: "base-submission-confirmed",
      baseMessageUrl: requireString(record.baseMessageUrl, "payload.baseMessageUrl"),
      collectionStartedAt: requireIsoTimestamp(
        record.collectionStartedAt,
        "payload.collectionStartedAt"
      )
    }));
  }
  if (command === "collect-messages") {
    return collectRoundMessages(payload, store);
  }
  if (command === "confirm-collection-closed") {
    return applyNamedEvent(payload, store, (record) => ({
      type: "collection-closed",
      closedMessageUrl: requireString(record.closedMessageUrl, "payload.closedMessageUrl")
    }));
  }
  if (command === "prepare-generation") {
    return prepareGeneration(payload, store);
  }
  if (command === "confirm-generation") {
    return confirmGeneration(payload, store);
  }
  if (command === "prepare-publication") {
    return preparePublication(payload, store);
  }
  if (command === "confirm-publication") {
    return applyNamedEvent(payload, store, (record) => ({
      type: "outcome-publication-confirmed",
      outcomeMessageUrl: requireString(record.outcomeMessageUrl, "payload.outcomeMessageUrl")
    }));
  }
  if (command === "plan-next") {
    return planNext(payload, store);
  }
  if (command === "get-round") {
    const record = requireRecord(payload, "payload");
    return requireRound(store, requireString(record.roundId, "payload.roundId"));
  }
  if (command === "mark-attention") {
    return applyNamedEvent(payload, store, (record) => ({
      type: "attention-required",
      reason: requireString(record.reason, "payload.reason")
    }));
  }
  if (command === "stop-round") {
    return stopRound(payload, store);
  }
  throw new Error(`Unknown command: ${command}`);
}

async function assertAllowedChannel(
  command: string,
  payload: unknown,
  store: RoundStateStore,
  allowedChannelUrl: string | undefined
): Promise<void> {
  if (!allowedChannelUrl) {
    return;
  }
  const record = requireRecord(payload, "payload");
  if (command === "prepare-base-submission") {
    if (requireString(record.channelUrl, "payload.channelUrl") !== allowedChannelUrl) {
      throw new Error("Round channel does not match DISCORD_CHANNEL_URL.");
    }
    return;
  }
  const round = await store.get(requireString(record.roundId, "payload.roundId"));
  if (round && round.channelUrl !== allowedChannelUrl) {
    throw new Error("Round channel does not match DISCORD_CHANNEL_URL.");
  }
}

async function prepareBaseSubmission(
  payload: unknown,
  store: RoundStateStore,
  baseImageStagingRoot: string
): Promise<unknown> {
  const record = requireRecord(payload, "payload");
  const roundId = requireString(record.roundId, "payload.roundId");
  if (await store.get(roundId)) {
    throw new Error(`Round already exists: ${roundId}`);
  }
  const activeRound = (await store.list()).find(
    (round) => round.phase !== "completed" && round.phase !== "stopped"
  );
  if (activeRound) {
    throw new Error(`An active round already exists: ${activeRound.id}`);
  }
  const requestedBaseImagePath = requireString(record.baseImagePath, "payload.baseImagePath");
  await requireExistingImage(
    requestedBaseImagePath,
    "Base image must be an existing PNG, JPEG, or WebP file."
  );
  const baseImagePath = await requireStagedImagePath(
    requestedBaseImagePath,
    baseImageStagingRoot
  );
  const draft = createRound({
    id: roundId,
    baseImagePath,
    channelUrl: requireString(record.channelUrl, "payload.channelUrl"),
    messageLimit: FEEDBACK_MESSAGE_LIMIT
  });
  const submitting = applyRoundEvent(draft, { type: "base-submission-started" });
  await store.save(submitting);
  return {
    action: "post-base-image",
    operationId: createOperationId(
      roundId,
      "submitting-base",
      OPERATION_TURN_NUMBER,
      submitting.channelUrl
    ),
    roundId,
    baseImagePath: submitting.baseImagePath,
    channelUrl: submitting.channelUrl,
    caption: [
      POLL_START_MARKER_TEMPLATE.replace("<id>", roundId),
      MESSAGE_COLLECTION_INSTRUCTIONS_TEMPLATE.replace(
        "<limit>",
        String(FEEDBACK_MESSAGE_LIMIT)
      )
    ].join("\n")
  };
}

async function collectRoundMessages(payload: unknown, store: RoundStateStore): Promise<unknown> {
  const input = parseCollectMessagesPayload(payload);
  const round = await requireRound(store, input.roundId);
  if (
    round.phase !== "collecting-messages" ||
    !round.baseMessageUrl ||
    !round.collectionStartedAt
  ) {
    throw new Error(`Round ${round.id} is not collecting messages.`);
  }
  if (input.boundaryMessageUrl !== round.baseMessageUrl) {
    throw new Error("Message observation does not match the active round boundary.");
  }
  let collection;
  try {
    collection = collectMessages({
      roundId: round.id,
      boundaryMessageUrl: round.baseMessageUrl,
      collectionStartedAt: round.collectionStartedAt,
      limit: round.messageLimit,
      existing: round.capturedMessages,
      observed: input.messages
    });
  } catch (error) {
    if (!(error instanceof MessageCollectionAmbiguityError)) {
      throw error;
    }
    const reason = "Discord message order is ambiguous; reconcile the round manually.";
    await store.save(
      applyRoundEvent(round, { type: "attention-required", reason })
    );
    return { action: "needs-attention", roundId: round.id, reason };
  }
  if (!collection.complete) {
    await store.save(
      applyRoundEvent(round, {
        type: "message-collection-progressed",
        capturedMessages: collection.captured
      })
    );
    return {
      action: "wait",
      roundId: round.id,
      capturedCount: collection.captured.length,
      remainingCount: round.messageLimit - collection.captured.length,
      scanIntervalMs: DISCORD_SCAN_INTERVAL_MS
    };
  }
  const closing = applyRoundEvent(round, {
    type: "message-collection-filled",
    capturedMessages: collection.captured
  });
  await store.save(closing);
  return {
    action: "post-collection-closed",
    operationId: createOperationId(
      round.id,
      "closing-collection",
      OPERATION_TURN_NUMBER,
      round.channelUrl
    ),
    roundId: round.id,
    channelUrl: round.channelUrl,
    caption: POLL_CLOSED_MARKER_TEMPLATE.replace("<id>", round.id),
    capturedMessages: collection.captured
  };
}

async function prepareGeneration(payload: unknown, store: RoundStateStore): Promise<unknown> {
  const record = requireRecord(payload, "payload");
  const round = await requireRound(store, requireString(record.roundId, "payload.roundId"));
  if (round.phase !== "ready-to-generate" || round.capturedMessages.length !== round.messageLimit) {
    throw new Error(`Round ${round.id} is not ready to generate.`);
  }
  const generating = applyRoundEvent(round, { type: "generation-started" });
  await store.save(generating);
  const feedbackLines = round.capturedMessages
    .map(({ text }, index) => `${index + 1}. ${text}`)
    .join("\n");
  return {
    action: "generate-image",
    operationId: createOperationId(
      round.id,
      "generating",
      OPERATION_TURN_NUMBER,
      round.baseMessageUrl ?? round.channelUrl
    ),
    roundId: round.id,
    baseImagePath: round.baseImagePath,
    instruction: `${IMAGE_EDIT_PREAMBLE}\n${feedbackLines}\n${IMAGE_EDIT_SUFFIX}`
  };
}

async function confirmGeneration(payload: unknown, store: RoundStateStore): Promise<unknown> {
  const record = requireRecord(payload, "payload");
  const round = await requireRound(store, requireString(record.roundId, "payload.roundId"));
  if (round.phase !== "generating") {
    throw new Error(`Round ${round.id} is not recording a generation outcome.`);
  }
  const outcome = requireString(record.outcome, "payload.outcome");
  let event: RoundEvent;
  if (outcome === "succeeded") {
    const resultImagePath = requireString(record.resultImagePath, "payload.resultImagePath");
    await requireExistingImage(
      resultImagePath,
      "Result image must be an existing PNG, JPEG, or WebP file."
    );
    event = { type: "generation-succeeded", resultImagePath };
  } else if (outcome === "refused") {
    event = { type: "generation-refused" };
  } else if (outcome === "failed") {
    event = { type: "generation-failed" };
  } else {
    throw new Error("payload.outcome must be succeeded, refused, or failed.");
  }
  const outcomeReady = applyRoundEvent(round, event);
  await store.save(outcomeReady);
  return { action: "recorded", roundId: round.id, phase: outcomeReady.phase };
}

async function preparePublication(payload: unknown, store: RoundStateStore): Promise<unknown> {
  const record = requireRecord(payload, "payload");
  const round = await requireRound(store, requireString(record.roundId, "payload.roundId"));
  if (round.phase !== "outcome-ready" || !round.generationOutcome) {
    throw new Error(`Round ${round.id} has no confirmed outcome to publish.`);
  }
  if (round.generationOutcome.kind === "succeeded") {
    await requireExistingImage(
      round.generationOutcome.resultImagePath,
      "Recorded result image is missing or unsupported."
    );
  }
  const publishing = applyRoundEvent(round, { type: "outcome-publication-started" });
  await store.save(publishing);
  const shared = {
    operationId: createOperationId(
      round.id,
      "publishing-outcome",
      OPERATION_TURN_NUMBER,
      round.channelUrl
    ),
    roundId: round.id,
    channelUrl: round.channelUrl
  };
  if (round.generationOutcome.kind === "succeeded") {
    return {
      action: "post-result-image",
      ...shared,
      resultImagePath: round.generationOutcome.resultImagePath,
      caption: RESULT_MARKER_TEMPLATE.replace("<id>", round.id)
    };
  }
  return {
    action: "post-status-message",
    ...shared,
    caption: (round.generationOutcome.kind === "refused"
      ? GENERATION_REFUSED_TEMPLATE
      : GENERATION_FAILED_TEMPLATE
    ).replace("<id>", round.id)
  };
}

async function planNext(payload: unknown, store: RoundStateStore): Promise<unknown> {
  const record = requireRecord(payload, "payload");
  const round = await requireRound(store, requireString(record.roundId, "payload.roundId"));
  const action = planNextAction(round);
  if (action.type === "needs-attention" && round.phase !== "needs-attention") {
    await store.save(
      applyRoundEvent(round, { type: "attention-required", reason: action.reason })
    );
  }
  return action;
}

const AMBIGUOUS_SIDE_EFFECT_PHASES: ReadonlySet<RoundPhase> = new Set([
  "submitting-base",
  "closing-collection",
  "generating",
  "publishing-outcome"
]);

async function stopRound(payload: unknown, store: RoundStateStore): Promise<unknown> {
  const record = requireRecord(payload, "payload");
  const round = await requireRound(store, requireString(record.roundId, "payload.roundId"));
  if (AMBIGUOUS_SIDE_EFFECT_PHASES.has(round.phase)) {
    const reason =
      "Cancellation was requested while an external action may be in flight; reconcile the round manually.";
    const attention = applyRoundEvent(round, { type: "attention-required", reason });
    await store.save(attention);
    return { action: "needs-attention", roundId: round.id, reason };
  }
  if (
    round.phase !== "draft" &&
    !(
      round.phase === "collecting-messages" &&
      round.capturedMessages.length < round.messageLimit
    )
  ) {
    throw new Error(
      `Round ${round.id} can only be cancelled before the message threshold.`
    );
  }
  const stopped = applyRoundEvent(round, { type: "round-stopped" });
  await store.save(stopped);
  return { action: "recorded", roundId: round.id, phase: stopped.phase };
}

async function applyNamedEvent(
  payload: unknown,
  store: RoundStateStore,
  createEvent: (record: Record<string, unknown>) => RoundEvent
): Promise<unknown> {
  const record = requireRecord(payload, "payload");
  const round = await requireRound(store, requireString(record.roundId, "payload.roundId"));
  const nextRound = applyRoundEvent(round, createEvent(record));
  await store.save(nextRound);
  return { action: "recorded", roundId: round.id, phase: nextRound.phase };
}

async function requireExistingImage(path: string, errorMessage: string): Promise<void> {
  let exists = false;
  try {
    exists = (await stat(path)).isFile();
  } catch {
    exists = false;
  }
  const extension = extname(path).toLowerCase();
  if (!exists || !SUPPORTED_IMAGE_EXTENSIONS.some((candidate) => candidate === extension)) {
    throw new Error(errorMessage);
  }
}

async function requireStagedImagePath(path: string, stagingRoot: string): Promise<string> {
  let resolvedPath: string;
  let resolvedRoot: string;
  try {
    [resolvedPath, resolvedRoot] = await Promise.all([
      realpath(resolve(path)),
      realpath(resolve(stagingRoot))
    ]);
  } catch {
    throw new Error("Base image must be staged under the configured runtime directory.");
  }
  const pathFromRoot = relative(resolvedRoot, resolvedPath);
  if (
    pathFromRoot.length === 0 ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Base image must be staged under the configured runtime directory.");
  }
  return resolvedPath;
}

interface CollectMessagesPayload {
  roundId: string;
  boundaryMessageUrl: string;
  messages: DiscordMessageObservation[];
}

function parseCollectMessagesPayload(payload: unknown): CollectMessagesPayload {
  const record = requireRecord(payload, "payload");
  if (!Array.isArray(record.messages)) {
    throw new Error("payload.messages must be an array.");
  }
  return {
    roundId: requireString(record.roundId, "payload.roundId"),
    boundaryMessageUrl: requireString(
      record.boundaryMessageUrl,
      "payload.boundaryMessageUrl"
    ),
    messages: record.messages.map((message, index) => {
      const item = requireRecord(message, `payload.messages[${index}]`);
      return {
        kind: requireMessageKind(item.kind, `payload.messages[${index}].kind`),
        roundId: requireString(item.roundId, `payload.messages[${index}].roundId`),
        boundaryMessageUrl: requireString(
          item.boundaryMessageUrl,
          `payload.messages[${index}].boundaryMessageUrl`
        ),
        messageUrl: requireString(item.messageUrl, `payload.messages[${index}].messageUrl`),
        authorId: requireString(item.authorId, `payload.messages[${index}].authorId`),
        authorName: requireString(item.authorName, `payload.messages[${index}].authorName`),
        timestamp: requireIsoTimestamp(item.timestamp, `payload.messages[${index}].timestamp`),
        text: requireText(item.text, `payload.messages[${index}].text`)
      };
    })
  };
}

async function requireRound(store: RoundStateStore, roundId: string) {
  const round = await store.get(roundId);
  if (!round) {
    throw new Error(`Round not found: ${roundId}`);
  }
  return round;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  return value;
}

function requireMessageKind(
  value: unknown,
  name: string
): DiscordMessageObservation["kind"] {
  if (value !== "ordinary-text" && value !== "system" && value !== "attachment-only") {
    throw new Error(`${name} is not a supported Discord message kind.`);
  }
  return value;
}

function requireIsoTimestamp(value: unknown, name: string): string {
  const timestamp = requireString(value, name);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${name} must be an ISO timestamp.`);
  }
  return timestamp;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command) {
    throw new Error("Usage: npm run round -- <command> < payload.json");
  }
  let rawPayload = "";
  for await (const chunk of process.stdin) {
    rawPayload += chunk.toString();
  }
  const allowedChannelUrl = process.env.DISCORD_CHANNEL_URL;
  if (!allowedChannelUrl) {
    throw new Error("DISCORD_CHANNEL_URL is required in the local .env file.");
  }
  const result = await executeCommand(
    command,
    JSON.parse(rawPayload) as unknown,
    new JsonRoundStateStore(ROUND_STATE_PATH),
    { allowedChannelUrl }
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
