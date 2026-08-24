import { createHash } from "node:crypto";

import { OPERATION_TURN_NUMBER } from "../constants.js";
import type { RoundPhase, RoundState } from "./round-state.js";

export type PlannedAction =
  | { type: "begin-base-submission"; operationId: string }
  | { type: "collect-feedback" }
  | { type: "begin-generation"; operationId: string }
  | { type: "begin-publication"; operationId: string }
  | { type: "wait"; reason: string }
  | { type: "needs-attention"; reason: string }
  | { type: "none"; reason: string };

export function createOperationId(
  roundId: string,
  phase: RoundPhase,
  turnNumber: number,
  target: string
): string {
  const targetHash = createHash("sha256").update(target).digest("hex").slice(0, 12);
  return `${roundId}:${phase}:${turnNumber}:${targetHash}`;
}

export function planNextAction(round: RoundState, now: string): PlannedAction {
  if (round.phase === "draft") {
    return {
      type: "begin-base-submission",
      operationId: createOperationId(
        round.id,
        "submitting-base",
        OPERATION_TURN_NUMBER,
        round.channelUrl
      )
    };
  }

  if (round.phase === "generating") {
    return {
      type: "needs-attention",
      reason: "Generation may already have occurred; reconcile it manually."
    };
  }

  if (round.phase === "submitting-base") {
    return {
      type: "needs-attention",
      reason: "The base image may already have been posted; reconcile it manually."
    };
  }

  if (round.phase === "creating-poll") {
    return {
      type: "needs-attention",
      reason: "The feedback poll may already have been created; reconcile it manually."
    };
  }

  if (round.phase === "publishing") {
    return {
      type: "needs-attention",
      reason: "Result publication may already have occurred; reconcile it manually."
    };
  }

  if (round.phase === "collecting-feedback") {
    const closesAt = round.feedbackClosesAt ? Date.parse(round.feedbackClosesAt) : Number.NaN;
    const observedAt = Date.parse(now);
    if (!Number.isFinite(closesAt) || !Number.isFinite(observedAt)) {
      return {
        type: "needs-attention",
        reason: "The feedback deadline is missing or invalid."
      };
    }
    if (observedAt >= closesAt) {
      return { type: "collect-feedback" };
    }
    return { type: "wait", reason: "The feedback deadline has not passed." };
  }

  if (round.phase === "polling") {
    return { type: "wait", reason: "The feedback poll is not finalized yet." };
  }

  if (round.phase === "ready-to-generate") {
    return {
      type: "begin-generation",
      operationId: createOperationId(
        round.id,
        "generating",
        OPERATION_TURN_NUMBER,
        round.baseMessageUrl ?? round.channelUrl
      )
    };
  }

  if (round.phase === "generated") {
    return {
      type: "begin-publication",
      operationId: createOperationId(
        round.id,
        "publishing",
        OPERATION_TURN_NUMBER,
        round.channelUrl
      )
    };
  }

  if (round.phase === "needs-attention") {
    return {
      type: "needs-attention",
      reason: round.attentionReason ?? "The round requires manual reconciliation."
    };
  }

  if (round.phase === "completed") {
    return { type: "none", reason: "Round is already completed." };
  }

  return { type: "none", reason: `No automatic action is safe from ${round.phase}.` };
}
