import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { ROUND_SCHEMA_VERSION } from "../constants.js";
import type { RoundState } from "./round-state.js";

interface RoundStateFile {
  schemaVersion: typeof ROUND_SCHEMA_VERSION;
  rounds: RoundState[];
}

export interface RoundStateStore {
  get(roundId: string): Promise<RoundState | undefined>;
  list(): Promise<RoundState[]>;
  save(round: RoundState): Promise<void>;
}

export class JsonRoundStateStore implements RoundStateStore {
  public constructor(private readonly statePath: string) {}

  public async get(roundId: string): Promise<RoundState | undefined> {
    return (await this.list()).find((round) => round.id === roundId);
  }

  public async list(): Promise<RoundState[]> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }

    const parsed = JSON.parse(raw) as Partial<RoundStateFile>;
    if (parsed.schemaVersion !== ROUND_SCHEMA_VERSION || !Array.isArray(parsed.rounds)) {
      throw new Error("Unsupported or malformed round-state file.");
    }
    return parsed.rounds;
  }

  public async save(round: RoundState): Promise<void> {
    const rounds = await this.list();
    const existingIndex = rounds.findIndex((candidate) => candidate.id === round.id);
    if (existingIndex === -1) {
      rounds.push(round);
    } else {
      rounds[existingIndex] = round;
    }

    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    const contents = `${JSON.stringify({ schemaVersion: ROUND_SCHEMA_VERSION, rounds }, null, 2)}\n`;
    const handle = await open(temporaryPath, "wx");

    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporaryPath, this.statePath);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
