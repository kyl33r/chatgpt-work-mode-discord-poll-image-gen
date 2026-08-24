import { describe, expect, it } from "vitest";

import { createOperationId, planNextAction } from "../src/round/idempotency.js";
import { createRound } from "../src/round/round-state.js";

describe("idempotent planning", () => {
  it("uses stable operation identities and never repeats ambiguous or completed work", () => {
    const draft = createRound({
      id: "R001",
      baseImagePath: "/tmp/base.png",
      channelUrl: "https://discord.test/channels/one"
    });

    expect(planNextAction(draft, "2026-08-24T10:00:00.000Z")).toEqual({
      type: "begin-base-submission",
      operationId: "R001:submitting-base:1:7ab44c7f7e3f"
    });
    expect(
      createOperationId("R001", "submitting-base", 1, "https://discord.test/channels/one")
    ).toBe(
      "R001:submitting-base:1:7ab44c7f7e3f"
    );
    expect(
      planNextAction({ ...draft, phase: "submitting-base" }, "2026-08-24T10:00:00.000Z")
    ).toEqual({
      type: "needs-attention",
      reason: "The base image may already have been posted; reconcile it manually."
    });
    expect(planNextAction({ ...draft, phase: "generating" }, "2026-08-24T10:00:00.000Z")).toEqual({
      type: "needs-attention",
      reason: "Generation may already have occurred; reconcile it manually."
    });
    expect(planNextAction({ ...draft, phase: "publishing" }, "2026-08-24T10:00:00.000Z")).toEqual({
      type: "needs-attention",
      reason: "Result publication may already have occurred; reconcile it manually."
    });
    expect(
      planNextAction({ ...draft, phase: "creating-poll" }, "2026-08-24T10:00:00.000Z")
    ).toEqual({
      type: "needs-attention",
      reason: "The feedback poll may already have been created; reconcile it manually."
    });
    expect(
      planNextAction(
        {
          ...draft,
          phase: "collecting-feedback",
          feedbackClosesAt: "2026-08-24T10:30:00.000Z"
        },
        "2026-08-24T11:00:00.000Z"
      )
    ).toEqual({ type: "collect-feedback" });
    expect(
      planNextAction({ ...draft, phase: "ready-to-generate" }, "2026-08-24T11:00:00.000Z")
    ).toEqual({
      type: "begin-generation",
      operationId: "R001:generating:1:7ab44c7f7e3f"
    });
    expect(
      planNextAction(
        { ...draft, phase: "generated", resultImagePath: "/tmp/result.png" },
        "2026-08-24T11:00:00.000Z"
      )
    ).toEqual({
      type: "begin-publication",
      operationId: "R001:publishing:1:7ab44c7f7e3f"
    });
    expect(planNextAction({ ...draft, phase: "completed" }, "2026-08-24T10:00:00.000Z")).toEqual({
      type: "none",
      reason: "Round is already completed."
    });
  });
});
