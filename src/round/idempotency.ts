import { createHash } from "node:crypto";

import { DISCORD_SCAN_INTERVAL_MS, OPERATION_TURN_NUMBER } from "../constants.js";
import type { RoundPhase, RoundState } from "./round-state.js";

export type PlannedAction =
  | { type: "begin-base-submission"; operationId: string }
  | { type: "scan-messages"; scanIntervalMs: number }
  | { type: "begin-generation"; operationId: string }
  | { type: "begin-outcome-publication"; operationId: string }
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

export function planNextAction(round: RoundState): PlannedAction {
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
  if (round.phase === "collecting-messages") {
    return { type: "scan-messages", scanIntervalMs: DISCORD_SCAN_INTERVAL_MS };
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
  if (round.phase === "outcome-ready") {
    return {
      type: "begin-outcome-publication",
      operationId: createOperationId(
        round.id,
        "publishing-outcome",
        OPERATION_TURN_NUMBER,
        round.channelUrl
      )
    };
  }
  const ambiguousReason = ambiguousPhaseReason(round.phase);
  if (ambiguousReason) {
    return { type: "needs-attention", reason: ambiguousReason };
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
  if (round.phase === "stopped") {
    return { type: "none", reason: "Round is stopped." };
  }
  return { type: "none", reason: `No automatic action is safe from ${round.phase}.` };
}

function ambiguousPhaseReason(phase: RoundPhase): string | undefined {
  if (phase === "submitting-base") {
    return "The Base Image may already have been posted; reconcile it manually.";
  }
  if (phase === "closing-collection") {
    return "The collection-closed marker may already have been posted; reconcile it manually.";
  }
  if (phase === "generating") {
    return "Generation may already have occurred; reconcile it manually.";
  }
  if (phase === "publishing-outcome") {
    return "The generation outcome may already have been posted; reconcile it manually.";
  }
  return undefined;
}
