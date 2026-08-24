import type { FeedbackCandidate, SelectedFeedback } from "./feedback-normalizer.js";
import { ROUND_SCHEMA_VERSION } from "../constants.js";

export type RoundPhase =
  | "draft"
  | "submitting-base"
  | "collecting-feedback"
  | "creating-poll"
  | "polling"
  | "ready-to-generate"
  | "generating"
  | "generated"
  | "publishing"
  | "completed"
  | "stopped"
  | "needs-attention";

export interface RoundState {
  schemaVersion: typeof ROUND_SCHEMA_VERSION;
  id: string;
  phase: RoundPhase;
  baseImagePath: string;
  channelUrl: string;
  baseMessageUrl?: string;
  feedbackOpensAt?: string;
  feedbackClosesAt?: string;
  candidates?: FeedbackCandidate[];
  pollMessageUrl?: string;
  selectedFeedback?: SelectedFeedback[];
  resultImagePath?: string;
  resultMessageUrl?: string;
  attentionReason?: string;
}

export type RoundEvent =
  | { type: "base-submission-started" }
  | {
      type: "base-submission-confirmed";
      baseMessageUrl: string;
      feedbackOpensAt: string;
      feedbackClosesAt: string;
    }
  | { type: "feedback-collection-closed"; candidates: FeedbackCandidate[] }
  | { type: "feedback-collection-empty" }
  | { type: "poll-created"; pollMessageUrl: string }
  | { type: "poll-finalized"; selectedFeedback: SelectedFeedback[] }
  | { type: "poll-finalized-empty" }
  | { type: "generation-started" }
  | { type: "generation-confirmed"; resultImagePath: string }
  | { type: "publication-started" }
  | { type: "publication-confirmed"; resultMessageUrl: string }
  | { type: "attention-required"; reason: string };

export interface CreateRoundInput {
  id: string;
  baseImagePath: string;
  channelUrl: string;
}

export function createRound(input: CreateRoundInput): RoundState {
  return {
    schemaVersion: ROUND_SCHEMA_VERSION,
    id: input.id,
    phase: "draft",
    baseImagePath: input.baseImagePath,
    channelUrl: input.channelUrl
  };
}

export function applyRoundEvent(round: RoundState, event: RoundEvent): RoundState {
  if (
    event.type === "attention-required" &&
    round.phase !== "completed" &&
    round.phase !== "stopped" &&
    round.phase !== "needs-attention"
  ) {
    return { ...round, phase: "needs-attention", attentionReason: event.reason };
  }

  if (round.phase === "draft" && event.type === "base-submission-started") {
    return { ...round, phase: "submitting-base" };
  }

  if (round.phase === "submitting-base" && event.type === "base-submission-confirmed") {
    return {
      ...round,
      phase: "collecting-feedback",
      baseMessageUrl: event.baseMessageUrl,
      feedbackOpensAt: event.feedbackOpensAt,
      feedbackClosesAt: event.feedbackClosesAt
    };
  }

  if (round.phase === "collecting-feedback" && event.type === "feedback-collection-closed") {
    return { ...round, phase: "creating-poll", candidates: event.candidates };
  }

  if (round.phase === "collecting-feedback" && event.type === "feedback-collection-empty") {
    return { ...round, phase: "stopped", candidates: [] };
  }

  if (round.phase === "creating-poll" && event.type === "poll-created") {
    return { ...round, phase: "polling", pollMessageUrl: event.pollMessageUrl };
  }

  if (round.phase === "polling" && event.type === "poll-finalized") {
    return { ...round, phase: "ready-to-generate", selectedFeedback: event.selectedFeedback };
  }

  if (round.phase === "polling" && event.type === "poll-finalized-empty") {
    return { ...round, phase: "stopped", selectedFeedback: [] };
  }

  if (round.phase === "ready-to-generate" && event.type === "generation-started") {
    return { ...round, phase: "generating" };
  }

  if (round.phase === "generating" && event.type === "generation-confirmed") {
    return { ...round, phase: "generated", resultImagePath: event.resultImagePath };
  }

  if (round.phase === "generated" && event.type === "publication-started") {
    return { ...round, phase: "publishing" };
  }

  if (round.phase === "publishing" && event.type === "publication-confirmed") {
    return { ...round, phase: "completed", resultMessageUrl: event.resultMessageUrl };
  }

  throw new Error(`Invalid round transition: ${round.phase} + ${event.type}`);
}
