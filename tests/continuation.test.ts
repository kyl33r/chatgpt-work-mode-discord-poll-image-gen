import { describe, expect, it } from "vitest";

import { selectContinuationSource } from "../src/round/continuation.js";
import { createRound, type RoundState } from "../src/round/round-state.js";

const CHANNEL = "https://discord.test/channels/allowlisted";

describe("selectContinuationSource", () => {
  it("uses the round ID as a deterministic tie-breaker", () => {
    expect(
      selectContinuationSource(
        [completed("R001", "2026-08-24T10:00:00.000Z"), completed("R002", "2026-08-24T10:00:00.000Z")],
        CHANNEL
      ).id
    ).toBe("R002");
  });

  it("ignores unsuccessful and cross-channel history", () => {
    const refused = {
      ...completed("R003", "2026-08-24T12:00:00.000Z"),
      generationOutcome: { kind: "refused", publicReason: "No image was produced." } as const
    };
    expect(
      selectContinuationSource(
        [refused, completed("R004", "2026-08-24T13:00:00.000Z", "https://discord.test/channels/other"), completed("R001", "2026-08-24T10:00:00.000Z")],
        CHANNEL
      ).id
    ).toBe("R001");
  });

  it("fails closed on malformed eligible history", () => {
    expect(() => selectContinuationSource([completed("R001", "not-a-date")], CHANNEL)).toThrow(
      "Completed continuation history has an invalid collection timestamp."
    );
  });
});

function completed(id: string, collectionStartedAt: string, channelUrl = CHANNEL): RoundState {
  return {
    ...createRound({
      id,
      baseImagePath: `/state/${id}/base-image.png`,
      channelUrl,
      messageLimit: 5
    }),
    phase: "completed",
    collectionStartedAt,
    generationOutcome: {
      kind: "succeeded",
      resultImagePath: `/state/${id}/result-image.png`
    },
    outcomeMessageUrl: `${id}-outcome`
  };
}
