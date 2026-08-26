import type { RoundState } from "./round-state.js";

export type SuccessfulContinuationSource = RoundState & {
  generationOutcome: { kind: "succeeded"; resultImagePath: string };
};

export function selectContinuationSource(
  rounds: readonly RoundState[],
  channelUrl: string
): SuccessfulContinuationSource {
  const candidates = rounds.filter(
    (round) =>
      round.channelUrl === channelUrl &&
      round.phase === "completed" &&
      round.generationOutcome?.kind === "succeeded"
  ) as SuccessfulContinuationSource[];
  for (const candidate of candidates) {
    if (!candidate.collectionStartedAt || !Number.isFinite(Date.parse(candidate.collectionStartedAt))) {
      throw new Error("Completed continuation history has an invalid collection timestamp.");
    }
  }
  candidates.sort((left, right) => {
    const timeDifference =
      Date.parse(right.collectionStartedAt as string) -
      Date.parse(left.collectionStartedAt as string);
    return timeDifference === 0 ? right.id.localeCompare(left.id) : timeDifference;
  });
  const source = candidates[0];
  if (!source) {
    throw new Error("No completed successful round is available in the configured channel.");
  }
  return source;
}
