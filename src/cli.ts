import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASE_IMAGE_STAGING_ROOT,
  FEEDBACK_INDEX_TEMPLATE,
  FEEDBACK_WINDOW_MS,
  IMAGE_EDIT_PREAMBLE,
  IMAGE_EDIT_SUFFIX,
  OPERATION_TURN_NUMBER,
  PARTICIPANT_INSTRUCTIONS,
  POLL_DURATION_HOURS,
  POLL_QUESTION_TEMPLATE,
  RESULT_MARKER_TEMPLATE,
  ROUND_MARKER_TEMPLATE,
  ROUND_STATE_PATH,
  SUPPORTED_IMAGE_EXTENSIONS
} from "./constants.js";
import {
  collectFeedbackCandidates,
  selectFeedback,
  type FeedbackMessage
} from "./round/feedback-normalizer.js";
import { createOperationId, planNextAction } from "./round/idempotency.js";
import { applyRoundEvent, createRound, type RoundEvent } from "./round/round-state.js";
import {
  JsonRoundStateStore,
  type RoundStateStore
} from "./round/round-state-store.js";

export async function executeCommand(
  command: string,
  payload: unknown,
  store: RoundStateStore,
  options: { allowedChannelUrl?: string; baseImageStagingRoot?: string } = {}
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
    return applyNamedEvent(payload, store, createBaseSubmissionConfirmedEvent);
  }
  if (command === "collect-feedback") {
    return collectFeedback(payload, store);
  }
  if (command === "confirm-poll-created") {
    return applyNamedEvent(payload, store, (record) => ({
      type: "poll-created",
      pollMessageUrl: requireString(record.pollMessageUrl, "payload.pollMessageUrl")
    }));
  }
  if (command === "record-poll-results") {
    return recordPollResults(payload, store);
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
      type: "publication-confirmed",
      resultMessageUrl: requireString(record.resultMessageUrl, "payload.resultMessageUrl")
    }));
  }
  if (command === "plan-next") {
    const record = requireRecord(payload, "payload");
    const round = await requireRound(store, requireString(record.roundId, "payload.roundId"));
    const action = planNextAction(round, new Date().toISOString());
    if (action.type === "needs-attention" && round.phase !== "needs-attention") {
      await store.save(
        applyRoundEvent(round, { type: "attention-required", reason: action.reason })
      );
    }
    return action;
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
  const roundId = requireString(record.roundId, "payload.roundId");
  const round = await store.get(roundId);
  if (round && round.channelUrl !== allowedChannelUrl) {
    throw new Error("Round channel does not match DISCORD_CHANNEL_URL.");
  }
}

function createBaseSubmissionConfirmedEvent(record: Record<string, unknown>): RoundEvent {
  const feedbackOpensAt = requireIsoTimestamp(
    record.feedbackOpensAt,
    "payload.feedbackOpensAt"
  );
  const feedbackClosesAt = requireIsoTimestamp(
    record.feedbackClosesAt,
    "payload.feedbackClosesAt"
  );
  if (Date.parse(feedbackClosesAt) - Date.parse(feedbackOpensAt) !== FEEDBACK_WINDOW_MS) {
    throw new Error("Feedback must close exactly one hour after it opens.");
  }
  return {
    type: "base-submission-confirmed",
    baseMessageUrl: requireString(record.baseMessageUrl, "payload.baseMessageUrl"),
    feedbackOpensAt,
    feedbackClosesAt
  };
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
    channelUrl: requireString(record.channelUrl, "payload.channelUrl")
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
    caption: ROUND_MARKER_TEMPLATE.replace("<id>", roundId),
    participantInstructions: PARTICIPANT_INSTRUCTIONS
  };
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

async function prepareGeneration(payload: unknown, store: RoundStateStore): Promise<unknown> {
  const record = requireRecord(payload, "payload");
  const round = await requireRound(store, requireString(record.roundId, "payload.roundId"));
  if (round.phase !== "ready-to-generate" || !round.selectedFeedback?.length) {
    throw new Error(`Round ${round.id} is not ready to generate.`);
  }
  const generating = applyRoundEvent(round, { type: "generation-started" });
  await store.save(generating);
  const feedbackLines = round.selectedFeedback.map(({ text }) => `- ${text}`).join("\n");
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
  const resultImagePath = requireString(record.resultImagePath, "payload.resultImagePath");
  await requireExistingImage(
    resultImagePath,
    "Result image must be an existing PNG, JPEG, or WebP file."
  );
  const generated = applyRoundEvent(round, { type: "generation-confirmed", resultImagePath });
  await store.save(generated);
  return { action: "recorded", roundId: round.id, phase: generated.phase };
}

async function preparePublication(payload: unknown, store: RoundStateStore): Promise<unknown> {
  const record = requireRecord(payload, "payload");
  const round = await requireRound(store, requireString(record.roundId, "payload.roundId"));
  if (round.phase !== "generated" || !round.resultImagePath) {
    throw new Error(`Round ${round.id} has no confirmed result to publish.`);
  }
  await requireExistingImage(
    round.resultImagePath,
    "Recorded result image is missing or unsupported."
  );
  const publishing = applyRoundEvent(round, { type: "publication-started" });
  await store.save(publishing);
  return {
    action: "post-result-image",
    operationId: createOperationId(
      round.id,
      "publishing",
      OPERATION_TURN_NUMBER,
      round.channelUrl
    ),
    roundId: round.id,
    resultImagePath: round.resultImagePath,
    channelUrl: round.channelUrl,
    caption: RESULT_MARKER_TEMPLATE.replace("<id>", round.id)
  };
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

async function requireRound(store: RoundStateStore, roundId: string) {
  const round = await store.get(roundId);
  if (!round) {
    throw new Error(`Round not found: ${roundId}`);
  }
  return round;
}

async function collectFeedback(payload: unknown, store: RoundStateStore): Promise<unknown> {
  const input = parseCollectFeedbackPayload(payload);
  const round = await store.get(input.roundId);
  if (!round) {
    throw new Error(`Round not found: ${input.roundId}`);
  }
  if (round.phase !== "collecting-feedback") {
    throw new Error(`Round ${round.id} is not collecting feedback.`);
  }
  if (!round.feedbackOpensAt || !round.feedbackClosesAt) {
    throw new Error(`Round ${round.id} has no authoritative feedback window.`);
  }

  const opensAt = Date.parse(round.feedbackOpensAt);
  const scheduledClose = Date.parse(round.feedbackClosesAt);
  const observedAt = Date.parse(input.observedAt);
  if (observedAt < opensAt) {
    throw new Error("Feedback cannot close before it opens.");
  }
  if (!input.ownerClosedEarly && observedAt < scheduledClose) {
    throw new Error("The feedback deadline has not passed.");
  }
  const effectiveClose = input.ownerClosedEarly
    ? new Date(Math.min(observedAt, scheduledClose)).toISOString()
    : round.feedbackClosesAt;

  const candidates = collectFeedbackCandidates({
    roundId: round.id,
    opensAt: round.feedbackOpensAt,
    closesAt: effectiveClose,
    messages: input.messages
  });
  if (candidates.length === 0) {
    await store.save(applyRoundEvent(round, { type: "feedback-collection-empty" }));
    return { action: "stop", roundId: round.id, reason: "No valid feedback was collected." };
  }
  const nextRound = applyRoundEvent(round, {
    type: "feedback-collection-closed",
    candidates
  });
  await store.save(nextRound);

  return {
    action: "create-poll",
    roundId: round.id,
    indexText: [
      FEEDBACK_INDEX_TEMPLATE.replace("<id>", round.id),
      ...candidates.map((candidate) => `${candidate.label} — ${candidate.text}`)
    ].join("\n"),
    pollQuestion: POLL_QUESTION_TEMPLATE.replace("<id>", round.id),
    pollOptionLabels: candidates.map((candidate) => candidate.label),
    pollDurationHours: POLL_DURATION_HOURS,
    allowMultipleSelections: true,
    candidates
  };
}

async function recordPollResults(payload: unknown, store: RoundStateStore): Promise<unknown> {
  const input = parsePollResultsPayload(payload);
  const round = await store.get(input.roundId);
  if (!round) {
    throw new Error(`Round not found: ${input.roundId}`);
  }
  if (round.phase !== "polling" || !round.candidates) {
    throw new Error(`Round ${round.id} is not waiting for poll results.`);
  }
  if (!round.pollMessageUrl || input.pollMessageUrl !== round.pollMessageUrl) {
    throw new Error("Poll observation does not match the recorded feedback poll.");
  }

  const candidateLabels = new Set(round.candidates.map((candidate) => candidate.label));
  for (const label of Object.keys(input.votes)) {
    if (!candidateLabels.has(label)) {
      throw new Error(`Poll contains an unknown candidate label: ${label}`);
    }
  }
  for (const label of candidateLabels) {
    if (!(label in input.votes)) {
      throw new Error(`Poll observation is missing candidate label: ${label}`);
    }
  }

  const selectedFeedback = selectFeedback({
    finalized: input.finalized,
    candidates: round.candidates,
    votes: input.votes
  });
  const nextRound = applyRoundEvent(
    round,
    selectedFeedback.length === 0
      ? { type: "poll-finalized-empty" }
      : { type: "poll-finalized", selectedFeedback }
  );
  await store.save(nextRound);

  if (selectedFeedback.length === 0) {
    return { action: "stop", roundId: round.id, reason: "No feedback received a vote." };
  }
  return {
    action: "generate-image",
    roundId: round.id,
    baseImagePath: round.baseImagePath,
    selectedFeedback
  };
}

interface CollectFeedbackPayload {
  roundId: string;
  observedAt: string;
  ownerClosedEarly: boolean;
  messages: FeedbackMessage[];
}

interface PollResultsPayload {
  roundId: string;
  pollMessageUrl: string;
  finalized: boolean;
  votes: Record<string, number>;
}

function parseCollectFeedbackPayload(payload: unknown): CollectFeedbackPayload {
  const record = requireRecord(payload, "payload");
  const messages = record.messages;
  if (!Array.isArray(messages)) {
    throw new Error("payload.messages must be an array.");
  }

  return {
    roundId: requireString(record.roundId, "payload.roundId"),
    observedAt: requireIsoTimestamp(record.observedAt, "payload.observedAt"),
    ownerClosedEarly: record.ownerClosedEarly === true,
    messages: messages.map((message, index) => {
      const item = requireRecord(message, `payload.messages[${index}]`);
      return {
        messageUrl: requireString(item.messageUrl, `payload.messages[${index}].messageUrl`),
        authorId: requireString(item.authorId, `payload.messages[${index}].authorId`),
        authorName: requireString(item.authorName, `payload.messages[${index}].authorName`),
        timestamp: requireIsoTimestamp(item.timestamp, `payload.messages[${index}].timestamp`),
        kind: requireLiteralFeedback(item.kind, `payload.messages[${index}].kind`),
        roundId: requireString(item.roundId, `payload.messages[${index}].roundId`),
        text: requireString(item.text, `payload.messages[${index}].text`)
      };
    })
  };
}

function parsePollResultsPayload(payload: unknown): PollResultsPayload {
  const record = requireRecord(payload, "payload");
  if (typeof record.finalized !== "boolean") {
    throw new Error("payload.finalized must be a boolean.");
  }
  const rawVotes = requireRecord(record.votes, "payload.votes");
  const votes = Object.fromEntries(
    Object.entries(rawVotes).map(([label, value]) => {
      if (!Number.isInteger(value) || (value as number) < 0) {
        throw new Error(`payload.votes.${label} must be a non-negative integer.`);
      }
      return [label, value as number];
    })
  );
  return {
    roundId: requireString(record.roundId, "payload.roundId"),
    pollMessageUrl: requireString(record.pollMessageUrl, "payload.pollMessageUrl"),
    finalized: record.finalized,
    votes
  };
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

function requireLiteralFeedback(value: unknown, name: string): "feedback" {
  if (value !== "feedback") {
    throw new Error(`${name} must be feedback.`);
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
  const payload: unknown = JSON.parse(rawPayload);
  const allowedChannelUrl = process.env.DISCORD_CHANNEL_URL;
  if (!allowedChannelUrl) {
    throw new Error("DISCORD_CHANNEL_URL is required in the local .env file.");
  }
  const result = await executeCommand(
    command,
    payload,
    new JsonRoundStateStore(ROUND_STATE_PATH),
    { allowedChannelUrl }
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
