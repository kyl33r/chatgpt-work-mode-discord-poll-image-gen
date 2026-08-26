import {
  DISCORD_CHANNEL_ALLOWLIST_MIGRATION_PATH,
  DISCORD_CHANNEL_ALLOWLIST_PATH,
  ROUND_STATE_ROOT,
  WORKFLOW_LOCK_PATH
} from "./constants.js";
import { JsonDiscordChannelAllowlistStore } from "./config/discord-channel-allowlist.js";
import { migrateLegacyDiscordChannelAllowlist } from "./config/migrate-discord-channel-allowlist.js";
import { JsonRoundStateStore } from "./round/round-state-store.js";
import { FileWorkflowLock } from "./workflow-lock.js";

const result = await migrateLegacyDiscordChannelAllowlist(
  new JsonRoundStateStore(ROUND_STATE_ROOT),
  new JsonDiscordChannelAllowlistStore(DISCORD_CHANNEL_ALLOWLIST_PATH),
  DISCORD_CHANNEL_ALLOWLIST_MIGRATION_PATH,
  new FileWorkflowLock(WORKFLOW_LOCK_PATH)
);
process.stdout.write(`${JSON.stringify(result)}\n`);
