import { fileURLToPath } from "node:url";

import {
  DISCORD_CHANNEL_ALLOWLIST_PATH,
  ROUND_STATE_ROOT,
  WORKFLOW_LOCK_PATH
} from "./constants.js";
import {
  JsonDiscordChannelAllowlistStore,
  normalizeDiscordChannelUrl,
  type DiscordChannelAllowlistStore
} from "./config/discord-channel-allowlist.js";
import type { RoundStateStore } from "./round/round-state-store.js";
import { JsonRoundStateStore } from "./round/round-state-store.js";
import { FileWorkflowLock, type WorkflowLock } from "./workflow-lock.js";

export interface ConfigureChannelResult {
  configured: true;
  channelCount: 1;
}

export async function configureDiscordChannel(
  payload: unknown,
  rounds: RoundStateStore,
  allowlist: DiscordChannelAllowlistStore,
  lock: WorkflowLock
): Promise<ConfigureChannelResult> {
  return lock.runExclusive(async () => {
    const record = requireRecord(payload);
    if (Object.keys(record).some((key) => key !== "channelUrl")) {
      throw new Error("Configuration payload contains unsupported fields.");
    }
    const channelUrl = normalizeDiscordChannelUrl(
      requireString(record.channelUrl, "payload.channelUrl")
    );
    const activeRound = (await rounds.list()).find((round) => !isTerminal(round.phase));
    if (activeRound) {
      throw new Error("Discord channel configuration is locked while a round is active.");
    }
    await allowlist.replace([channelUrl]);
    return { configured: true, channelCount: 1 };
  });
}

function isTerminal(phase: string): boolean {
  return phase === "completed" || phase === "stopped" || phase === "needs-attention";
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("payload must be an object.");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

async function main(): Promise<void> {
  let rawPayload = "";
  for await (const chunk of process.stdin) {
    rawPayload += chunk.toString();
  }
  const result = await configureDiscordChannel(
    JSON.parse(rawPayload) as unknown,
    new JsonRoundStateStore(ROUND_STATE_ROOT),
    new JsonDiscordChannelAllowlistStore(DISCORD_CHANNEL_ALLOWLIST_PATH),
    new FileWorkflowLock(WORKFLOW_LOCK_PATH)
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
