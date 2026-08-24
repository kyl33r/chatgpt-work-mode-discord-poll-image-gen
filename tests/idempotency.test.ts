import { describe, expect, it } from "vitest";

import { planNextAction } from "../src/round/idempotency.js";
import { createRound } from "../src/round/round-state.js";

describe("idempotent planning", () => {
  it("plans safe first actions and pauses every ambiguous side-effect phase", () => {
    const draft = createRound({
      id: "R001",
      baseImagePath: "/tmp/base.png",
      channelUrl: "https://discord.test/channels/one",
      messageLimit: 5
    });

    expect(planNextAction(draft)).toEqual({
      type: "begin-base-submission",
      operationId: "R001:submitting-base:1:7ab44c7f7e3f"
    });
    expect(planNextAction({ ...draft, phase: "collecting-messages" })).toEqual({
      type: "scan-messages",
      scanIntervalMs: 15_000
    });
    expect(planNextAction({ ...draft, phase: "closing-collection" })).toEqual({
      type: "needs-attention",
      reason: "The collection-closed marker may already have been posted; reconcile it manually."
    });
    expect(planNextAction({ ...draft, phase: "outcome-ready" })).toEqual({
      type: "begin-outcome-publication",
      operationId: "R001:publishing-outcome:1:7ab44c7f7e3f"
    });
  });
});
