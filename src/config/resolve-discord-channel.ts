import type { DiscordChannelAllowlistStore } from "./discord-channel-allowlist.js";

export async function resolveDiscordChannel(
  allowlist: DiscordChannelAllowlistStore
): Promise<string> {
  const configured = await allowlist.getAll();
  if (configured.length === 1 && configured[0]) {
    return configured[0];
  }
  if (configured.length > 1) {
    throw new Error("The current workflow requires exactly one configured Discord channel.");
  }

  throw new Error("Configure one Discord channel before running a round command.");
}
