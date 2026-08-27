import { fileURLToPath } from "node:url";

import {
  DISCORD_CHANNEL_ALLOWLIST_PATH,
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
import { resolveDiscordConversationDestination } from "./conversation/discord-conversation-destination.js";
import {
  JsonConversationPrivateHandoff,
  type ConversationPrivateHandoff
} from "./conversation/conversation-private-handoff.js";
import type { CapturedMessage } from "./round/message-collector.js";
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
      dependencies.artifacts,
      dependencies.handoff ?? new JsonConversationPrivateHandoff()
    );
  });
}

async function executeLockedCommand(
  command: string,
  payload: unknown,
  store: RoundStateStore,
  allowedChannelUrl: string,
  artifacts: RoundArtifactStore | undefined,
  handoff: ConversationPrivateHandoff
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
  if (command === "collect-conversation-snapshot") {
    return collectConversationSnapshot(
      payload,
      store,
      artifacts,
      handoff,
      allowedChannelUrl
    );
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

async function collectConversationSnapshot(
  payload: unknown,
  store: RoundStateStore,
  artifacts: RoundArtifactStore | undefined,
  handoff: ConversationPrivateHandoff,
  allowedChannelUrl: string
): Promise<unknown> {
  const record = requireExactPlainRecord(
    payload,
    ["roundId", "invocationId", "acquiredAttachments"],
    "payload"
  );
  const roundId = requireString(record.roundId, "payload.roundId");
  const invocationId = requireString(record.invocationId, "payload.invocationId");
  if (!isPlainDenseArray(record.acquiredAttachments)) {
    throw new Error("payload.acquiredAttachments must be an array.");
  }
  const acquiredAttachments = record.acquiredAttachments.map((value, index) => {
    const attachment = requireExactPlainRecord(
      value,
      ["selection", "imagePath"],
      `payload.acquiredAttachments[${index}]`
    );
    return {
      selection: requireString(
        attachment.selection,
        `payload.acquiredAttachments[${index}].selection`
      ),
      imagePath: requireString(
        attachment.imagePath,
        `payload.acquiredAttachments[${index}].imagePath`
      )
    };
  });
  const round = await requireRound(store, roundId);
  if (
    round.phase !== "collecting-messages" ||
    !round.baseMessageUrl ||
    round.capturedMessages.length !== 0
  ) {
    throw new Error(`Round ${round.id} is not ready for a complete parser snapshot.`);
  }
  const request = await handoff.readRequest(invocationId);
  const snapshot = await handoff.readSnapshot(invocationId);
  if (!request || !snapshot) {
    return markParserAttention(
      round,
      store,
      "Private conversation observation is unavailable or incomplete."
    );
  }
  const expectedDestination = resolveDiscordConversationDestination(
    allowedChannelUrl,
    [allowedChannelUrl]
  );
  if (
    request.destination !== expectedDestination ||
    request.boundary !== round.baseMessageUrl ||
    request.stopAfterQualifyingMessages !== round.messageLimit ||
    snapshot.destination !== expectedDestination ||
    snapshot.boundary !== round.baseMessageUrl
  ) {
    return markParserAttention(
      round,
      store,
      "Conversation observation authority does not match the active round."
    );
  }
  if (!snapshot.complete || snapshot.messages.length !== round.messageLimit) {
    return markParserAttention(
      round,
      store,
      "Private conversation observation is unavailable or incomplete."
    );
  }
  const acquiredBySelection = new Map(
    acquiredAttachments.map((attachment) => [attachment.selection, attachment.imagePath])
  );
  if (
    acquiredBySelection.size !== acquiredAttachments.length ||
    snapshot.selectedAttachments.length !== acquiredAttachments.length ||
    snapshot.selectedAttachments.some(
      (attachment) => !acquiredBySelection.has(attachment.selection)
    )
  ) {
    return markParserAttention(
      round,
      store,
      "Parser-selected participant image mapping is ambiguous."
    );
  }
  const capturedMessages: CapturedMessage[] = [];
  try {
    for (const [messageIndex, message] of snapshot.messages.entries()) {
      const contextImages = [];
      for (const attachment of snapshot.selectedAttachments.filter(
        (candidate) => candidate.owner === message.identity
      )) {
        const imagePath = acquiredBySelection.get(attachment.selection);
        if (!imagePath) {
          throw new Error("Missing acquired attachment.");
        }
        contextImages.push({
          attachmentIndex: attachment.index,
          imagePath: await requireArtifactStore(artifacts).acceptFeedbackImage(
            round.id,
            messageIndex + 1,
            attachment.index,
            imagePath
          )
        });
      }
      capturedMessages.push({
        messageUrl: message.identity,
        authorId: message.author.id,
        authorName: message.author.name,
        timestamp: message.timestamp,
        text: message.text,
        contextImages
      });
    }
  } catch {
    const reason = "A parser-selected participant image is missing, invalid, or ambiguous.";
    await store.save(applyRoundEvent(round, { type: "attention-required", reason }));
    return { action: "needs-attention", roundId: round.id, reason };
  }
  await store.save(
    applyRoundEvent(round, {
      type: "message-collection-filled",
      capturedMessages
    })
  );
  return { action: "synthesize-feedback", roundId: round.id };
}

async function markParserAttention(
  round: Awaited<ReturnType<typeof requireRound>>,
  store: RoundStateStore,
  reason: string
): Promise<unknown> {
  await store.save(applyRoundEvent(round, { type: "attention-required", reason }));
  return { action: "needs-attention", roundId: round.id, reason };
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

function requireExactPlainRecord(
  value: unknown,
  requiredKeys: readonly string[],
  name: string
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${name} is invalid.`);
  }
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== requiredKeys.length ||
    !requiredKeys.every((key) => Object.hasOwn(record, key)) ||
    keys.some((key) => {
      if (typeof key !== "string" || !requiredKeys.includes(key)) {
        return true;
      }
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) {
    throw new Error(`${name} is invalid.`);
  }
  return record;
}

function isPlainDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    return false;
  }
  return value.every((_entry, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
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
    if (
      process.argv[2] === "parse-conversation" ||
      process.argv[2] === "collect-conversation-snapshot"
    ) {
      process.stdout.write(`${JSON.stringify({ action: "needs-attention" }, null, 2)}\n`);
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
