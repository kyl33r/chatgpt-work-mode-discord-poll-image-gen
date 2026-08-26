import { chmod, mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface WorkflowLock {
  runExclusive<T>(action: () => Promise<T>): Promise<T>;
}

export class InMemoryWorkflowLock implements WorkflowLock {
  private active = false;

  public async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.active) {
      throw workflowBusy();
    }
    this.active = true;
    try {
      return await action();
    } finally {
      this.active = false;
    }
  }
}

export class FileWorkflowLock implements WorkflowLock {
  public constructor(private readonly lockPath: string) {}

  public async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const parent = dirname(this.lockPath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    let handle;
    try {
      handle = await open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw workflowBusy();
      }
      throw error;
    }
    try {
      return await action();
    } finally {
      await handle.close();
      await rm(this.lockPath, { force: true });
    }
  }
}

function workflowBusy(): Error {
  return new Error("Another workflow mutation is already in progress.");
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
