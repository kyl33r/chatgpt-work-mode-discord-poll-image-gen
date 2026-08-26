import { describe, expect, it } from "vitest";

import { InMemoryWorkflowLock } from "../src/workflow-lock.js";

describe("InMemoryWorkflowLock", () => {
  it("fails closed when another workflow mutation is in progress", async () => {
    const lock = new InMemoryWorkflowLock();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = lock.runExclusive(async () => {
      entered();
      await blocked;
    });
    await started;

    await expect(lock.runExclusive(async () => undefined)).rejects.toThrow(
      "Another workflow mutation is already in progress."
    );
    release();
    await first;
  });
});
