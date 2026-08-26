import { fileURLToPath } from "node:url";

import {
  DISCORD_CHANNEL_ALLOWLIST_PATH,
  DISCORD_SCAN_INTERVAL_MS,
  FEEDBACK_IMAGE_LIMIT_PER_MESSAGE,
  FEEDBACK_IMAGE_LIMIT_PER_ROUND,
  FEEDBACK_MESSAGE_LIMIT,
  FINAL_IMAGE_PROMPT_LABEL,
  GENERATION_FAILED_TEMPLATE,
  GENERATION_REFUSED_TEMPLATE,
  MESSAGE_COLLECTION_INSTRUCTIONS_TEMPLATE,
  OPERATION_TURN_NUMBER,
  POLL_CLOSED_MARKER_TEMPLATE,
  POLL_START_MARKER_TEMPLATE,
  RESULT_MARKER_TEMPLATE,
  ROUND_STATE_ROOT,
  WORKFLOW_LOCK_PATH
} from "./constants.js";
import { JsonDiscordChannelAllowlistStore } from "./config/discord-channel-allowlist.js";
import type { DiscordChannelAllowlistStore } from "./config/discord-channel-allowlist.js";
import { resolveDiscordChannel } from "./config/resolve-discord-channel.js";
import { executeConversationCommand } from "./conversation/conversation-command.js";
import {
  JsonConversationPrivateHandoff,
  type ConversationPrivateHandoff
} from "./conversation/conversation-private-handoff.js";
import {
  collectMessages,
  MessageCollectionAmbiguityError,
  type DiscordMessageObservation
} from "./round/message-collector.js";
import { selectContinuationSource } from "./round/continuation.js";
import { createOperationId, planNextAction } from "./round/idempotency.js";
import {
  JsonRoundArtifactStore,
  type RoundArtifactStore
} from "./round/round-artifact-store.js";
import {
  applyRoundEvent,
  createRound,
  type RoundEvent,
  type RoundPhase
} from "./round/round-state.js";
import { validateSynthesizedPrompt } from "./round/synthesized-prompt.js";
import {
  JsonRoundStateStore,
  type RoundStateStore
} from "./round/round-state-store.js";
import { FileWorkflowLock, type WorkflowLock } from "./workflow-lock.js";

export interface CommandDependencies {
  allowlist: DiscordChannelAllowlistStore;
  artifacts?: RoundArtifactStore;
  handoff?: ConversationPrivateHandoff;
  workflowLock: WorkflowLock;
}

export async function executeCommand(
  command: string,
  payload: unknown,
  store: RoundStateStore,
  dependencies: CommandDependencies
): Promise<unknown> {
  if (command === "parse-conversation") {
    return executeConversationCommand(command, payload, {
      allowlist: dependencies.allowlist,
      handoff: dependencies.handoff ?? new JsonConversationPrivateHandoff(),
      workflowLock: dependencies.workflowLock
    });
  }
  return dependencies.workflowLock.runExclusive(async () => {
    const allowedChannelUrl = await resolveDiscordChannel(dependencies.allowlist);
    return executeLockedCommand(
      command,
      payload,
      store,
      allowedChannelUrl,
      dependencies.artifacts
    );
  });
}

async function executeLockedCommand(
  command: string,
  payload: unknown,
  store: RoundStateStore,
  allowedChannelUrl: string,
  artifacts: RoundArtifactStore | undefined
): Promise<unknown> {
  await assertAllowedChannel(command, payload, store, allowedChannelUrl);
  if (command === "prepare-base-submission") {
    return prepareBaseSubmission(
      payload,
      store,
      requireArtifactStore(artifacts),
      allowedChannelUrl
    );
  }
  if (command === "prepare-continuation") {
    return prepareContinuation(
      payload,
      store,
      requireArtifactStore(artifacts),
      allowedChannelUrl
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
    return collectRoundMessages(payload, store, artifacts);
  }
  if (command === "prepare-prompt-synthesis") {
    return preparePromptSynthesis(payload, store);
  }
  if (command === "confirm-synthesized-prompt") {
    return confirmSynthesizedPrompt(payload, store);
  }
  if (command === "confirm-collection-closed") {
    return applyNamedEvent(payload, store, (record) => ({
      type: "collection-closed",
      closedMessageUrl: requireString(record.closedMessageUrl, "payload.closedMessageUrl")
    }));
  }
  if (command === "prepare-generation") {
    return prepareGeneration(payload, store, artifacts);
  }
  if (command === "confirm-generation") {
    return confirmGeneration(
      payload,
      store,
      artifacts
    );
  }
  if (command === "prepare-publication") {
    return preparePublication(payload, store, artifacts);
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
  allowedChannelUrl: string
): Promise<void> {
  const record = requireRecord(payload, "payload");
  if (command === "prepare-base-submission" || command === "prepare-continuation") {
    if ("channelUrl" in record) {
      throw new Error("The round channel is derived from the configured Discord allowlist.");
    }
    return;
  }
  const round = await store.get(requireString(record.roundId, "payload.roundId"));
  if (round && round.channelUrl !== allowedChannelUrl) {
    throw new Error("Round channel does not match the configured Discord allowlist.");
  }
}

async function prepareContinuation(
  payload: unknown,
  store: RoundStateStore,
  artifacts: RoundArtifactStore,
  allowedChannelUrl: string
): Promise<unknown> {
  const record = requireRecord(payload, "payload");
  if (Object.keys(record).some((key) => key !== "roundId")) {
    throw new Error("Continuation source is selected from completed channel history.");
  }
  const roundId = requireString(record.roundId, "payload.roundId");
  if (await store.get(roundId)) {
    throw new Error(`Round already exists: ${roundId}`);
  }
  const rounds = await store.list();
  const activeRound = rounds.find(
    (round) =>
      round.phase !== "completed" &&
      round.phase !== "stopped" &&
      round.phase !== "needs-attention"
  );
  if (activeRound) {
    throw new Error(`An active round already exists: ${activeRound.id}`);
  }
  const source = selectContinuationSource(rounds, allowedChannelUrl);
  const baseImagePath = await artifacts.copyResultAsBase(
    source.id,
    roundId,
    source.generationOutcome.resultImagePath
  );
  const submitting = applyRoundEvent(
    createRound({
      id: roundId,
      baseImagePath,
      channelUrl: allowedChannelUrl,
      messageLimit: FEEDBACK_MESSAGE_LIMIT,
      parentRoundId: source.id
    }),
    { type: "base-submission-started" }
  );
  try {
    await store.save(submitting);
  } catch (error) {
    const persisted = await store.get(roundId).catch(() => {
      throw new Error("Continuation persistence is ambiguous; the copied Base Image was retained.");
    });
    if (!persisted) {
      await artifacts.discardUnpersistedBase(roundId, baseImagePath);
    }
    throw error;
  }
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
      messageCollectionInstructions()
    ].join("\n")
  };
}

async function prepareBaseSubmission(
  payload: unknown,
  store: RoundStateStore,
  artifacts: RoundArtifactStore,
  allowedChannelUrl: string
): Promise<unknown> {
  const record = requireRecord(payload, "payload");
  const roundId = requireString(record.roundId, "payload.roundId");
  if (await store.get(roundId)) {
    throw new Error(`Round already exists: ${roundId}`);
  }
  const activeRound = (await store.list()).find(
    (round) =>
      round.phase !== "completed" &&
      round.phase !== "stopped" &&
      round.phase !== "needs-attention"
  );
  if (activeRound) {
    throw new Error(`An active round already exists: ${activeRound.id}`);
  }
  const requestedBaseImagePath = requireString(record.baseImagePath, "payload.baseImagePath");
  const baseImagePath = await artifacts.acceptBaseImage(roundId, requestedBaseImagePath);
  const draft = createRound({
    id: roundId,
    baseImagePath,
    channelUrl: allowedChannelUrl,
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
      messageCollectionInstructions()
    ].join("\n")
  };
}

async function collectRoundMessages(
  payload: unknown,
  store: RoundStateStore,
  artifacts: RoundArtifactStore | undefined
): Promise<unknown> {
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
  try {
    const existingUrls = new Set(round.capturedMessages.map((message) => message.messageUrl));
    for (const [messageIndex, message] of collection.captured.entries()) {
      for (const image of message.contextImages) {
        image.imagePath = existingUrls.has(message.messageUrl)
          ? await requireArtifactStore(artifacts).requireFeedbackImage(
              round.id,
              messageIndex + 1,
              image.attachmentIndex,
              image.imagePath
            )
          : await requireArtifactStore(artifacts).acceptFeedbackImage(
              round.id,
              messageIndex + 1,
              image.attachmentIndex,
              image.imagePath
            );
      }
    }
  } catch {
    const reason = "A selected participant image is missing, invalid, or ambiguously staged.";
    await store.save(applyRoundEvent(round, { type: "attention-required", reason }));
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
  const synthesizing = applyRoundEvent(round, {
    type: "message-collection-filled",
    capturedMessages: collection.captured
  });
  await store.save(synthesizing);
  return {
    action: "synthesize-feedback",
    roundId: round.id
  };
}

async function preparePromptSynthesis(
  payload: unknown,
  store: RoundStateStore
): Promise<unknown> {
  const record = requireRecord(payload, "payload");
  const round = await requireRound(store, requireString(record.roundId, "payload.roundId"));
  if (
    round.phase !== "synthesizing-feedback" ||
    round.capturedMessages.length !== round.messageLimit
  ) {
    throw new Error(`Round ${round.id} is not ready to synthesize feedback.`);
  }
  return {
    action: "synthesize-prompt",
    roundId: round.id,
    feedbackTexts: round.capturedMessages.map((message) => message.text),
    contextImagePaths: round.capturedMessages.flatMap((message) =>
      message.contextImages.map((image) => image.imagePath)
    )
  };
}

async function confirmSynthesizedPrompt(
  payload: unknown,
  store: RoundStateStore
): Promise<unknown> {
  const record = requireRecord(payload, "payload");
  const round = await requireRound(store, requireString(record.roundId, "payload.roundId"));
  if (round.phase !== "synthesizing-feedback") {
    throw new Error(`Round ${round.id} is not accepting a Synthesized Prompt.`);
  }
  const synthesizedPrompt = validateSynthesizedPrompt(
    requireString(record.synthesizedPrompt, "payload.synthesizedPrompt"),
    round.capturedMessages.some((message) => message.contextImages.length > 0)
  );
  const closing = applyRoundEvent(round, {
    type: "synthesized-prompt-confirmed",
    synthesizedPrompt
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
    caption: [
      POLL_CLOSED_MARKER_TEMPLATE.replace("<id>", round.id),
      FINAL_IMAGE_PROMPT_LABEL,
      synthesizedPrompt
    ].join("\n")
  };
}

async function prepareGeneration(
  payload: unknown,
  store: RoundStateStore,
  artifacts: RoundArtifactStore | undefined
): Promise<unknown> {
  const record = requireRecord(payload, "payload");
  const round = await requireRound(store, requireString(record.roundId, "payload.roundId"));
  if (
    round.phase !== "ready-to-generate" ||
    round.capturedMessages.length !== round.messageLimit ||
    !round.synthesizedPrompt
  ) {
    throw new Error(`Round ${round.id} is not ready to generate.`);
  }
  let contextImagePaths: string[];
  try {
    contextImagePaths = [];
    const seenPaths = new Set<string>();
    for (const [messageIndex, message] of round.capturedMessages.entries()) {
      for (const image of message.contextImages) {
        const validated = await requireArtifactStore(artifacts).requireFeedbackImage(
          round.id,
          messageIndex + 1,
          image.attachmentIndex,
          image.imagePath
        );
        if (seenPaths.has(validated)) {
          throw new Error("Participant image context contains a duplicate path.");
        }
        seenPaths.add(validated);
        contextImagePaths.push(validated);
      }
    }
  } catch {
    const reason = "Persisted participant image context is missing or invalid.";
    await store.save(applyRoundEvent(round, { type: "attention-required", reason }));
    return { action: "needs-attention", roundId: round.id, reason };
  }
  const generating = applyRoundEvent(round, { type: "generation-started" });
  await store.save(generating);
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
    contextImagePaths,
    instruction: round.synthesizedPrompt
  };
}

async function confirmGeneration(
  payload: unknown,
  store: RoundStateStore,
  artifacts: RoundArtifactStore | undefined
): Promise<unknown> {
  const record = requireRecord(payload, "payload");
  const round = await requireRound(store, requireString(record.roundId, "payload.roundId"));
  if (round.phase !== "generating") {
    throw new Error(`Round ${round.id} is not recording a generation outcome.`);
  }
  const outcome = requireString(record.outcome, "payload.outcome");
  let event: RoundEvent;
  if (outcome === "succeeded") {
    const resultImagePath = requireString(record.resultImagePath, "payload.resultImagePath");
    event = {
      type: "generation-succeeded",
      resultImagePath: await requireArtifactStore(artifacts).acceptResultImage(
        round.id,
        resultImagePath
      )
    };
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

async function preparePublication(
  payload: unknown,
  store: RoundStateStore,
  artifacts: RoundArtifactStore | undefined
): Promise<unknown> {
  const record = requireRecord(payload, "payload");
  const round = await requireRound(store, requireString(record.roundId, "payload.roundId"));
  if (round.phase !== "outcome-ready" || !round.generationOutcome) {
    throw new Error(`Round ${round.id} has no confirmed outcome to publish.`);
  }
  if (round.generationOutcome.kind === "succeeded") {
    await requireArtifactStore(artifacts).requireResultImage(
      round.id,
      round.generationOutcome.resultImagePath
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

function requireArtifactStore(artifacts: RoundArtifactStore | undefined): RoundArtifactStore {
  if (!artifacts) {
    throw new Error("A RoundArtifactStore is required for image commands.");
  }
  return artifacts;
}

function messageCollectionInstructions(): string {
  return MESSAGE_COLLECTION_INSTRUCTIONS_TEMPLATE
    .replace("<messageLimit>", String(FEEDBACK_MESSAGE_LIMIT))
    .replace("<perMessageImageLimit>", String(FEEDBACK_IMAGE_LIMIT_PER_MESSAGE))
    .replace("<roundImageLimit>", String(FEEDBACK_IMAGE_LIMIT_PER_ROUND));
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
        text: requireText(item.text, `payload.messages[${index}].text`),
        attachments: parseAttachments(item.attachments, index)
      };
    })
  };
}

function parseAttachments(value: unknown, messageIndex: number) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`payload.messages[${messageIndex}].attachments must be an array.`);
  }
  return value.map((attachment, attachmentPosition) => {
    const item = requireRecord(
      attachment,
      `payload.messages[${messageIndex}].attachments[${attachmentPosition}]`
    );
    const attachmentIndex = item.attachmentIndex;
    if (!Number.isInteger(attachmentIndex) || (attachmentIndex as number) < 0) {
      throw new Error("payload attachmentIndex must be a non-negative integer.");
    }
    return {
      attachmentIndex: attachmentIndex as number,
      mediaType: requireString(item.mediaType, "payload attachment mediaType"),
      imagePath: requireString(item.imagePath, "payload attachment imagePath")
    };
  });
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
  const stateStore = new JsonRoundStateStore(ROUND_STATE_ROOT);
  const result = await executeCommand(
    command,
    JSON.parse(rawPayload) as unknown,
    stateStore,
    {
      allowlist: new JsonDiscordChannelAllowlistStore(DISCORD_CHANNEL_ALLOWLIST_PATH),
      artifacts: new JsonRoundArtifactStore(ROUND_STATE_ROOT),
      workflowLock: new FileWorkflowLock(WORKFLOW_LOCK_PATH)
    }
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    if (process.argv[2] === "parse-conversation") {
      process.stdout.write(`${JSON.stringify({ action: "needs-attention" }, null, 2)}\n`);
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
