import { isAbsolute, join, resolve } from "node:path";

import {
  OPENCLAW_COMPLETE_ROUND_TOOL_NAME,
  OPENCLAW_DISCORD_TOKEN_ENV,
  OPENCLAW_GATEWAY_PORT,
  OPENCLAW_GATEWAY_TOKEN_ENV,
  OPENCLAW_PLUGIN_DIRECTORY,
  OPENCLAW_PLUGIN_ID,
  OPENCLAW_PREPARE_SYNTHESIS_TOOL_NAME,
  OPENCLAW_PROVIDER_PLUGIN_ID,
  OPENCLAW_RUNTIME_ROOT,
  OPENCLAW_START_ROUND_TOOL_NAME,
  OPENCLAW_WORKSPACE_DIRECTORY
} from "../constants.js";

export interface OpenClawProfilePatchInput {
  projectRoot: string;
  guildId: string;
  channelId: string;
}

export function buildOpenClawProfilePatch(
  input: OpenClawProfilePatchInput
): Record<string, unknown> {
  if (!isAbsolute(input.projectRoot)) {
    throw new Error("The OpenClaw project root must be absolute.");
  }
  requireDiscordSnowflake(input.guildId);
  requireDiscordSnowflake(input.channelId);
  const root = resolve(input.projectRoot);
  return {
    agents: {
      defaults: {
        workspace: join(
          root,
          OPENCLAW_RUNTIME_ROOT,
          OPENCLAW_WORKSPACE_DIRECTORY
        )
      }
    },
    gateway: {
      mode: "local",
      port: OPENCLAW_GATEWAY_PORT,
      bind: "loopback",
      auth: {
        mode: "token",
        token: secretEnvironmentReference(OPENCLAW_GATEWAY_TOKEN_ENV)
      },
      tailscale: { mode: "off" },
      controlUi: { enabled: false },
      cliAgents: { enabled: false },
      terminal: { enabled: false }
    },
    browser: { enabled: false },
    tools: {
      profile: "minimal",
      allow: [
        OPENCLAW_START_ROUND_TOOL_NAME,
        OPENCLAW_PREPARE_SYNTHESIS_TOOL_NAME,
        OPENCLAW_COMPLETE_ROUND_TOOL_NAME
      ]
    },
    plugins: {
      allow: [OPENCLAW_PLUGIN_ID, OPENCLAW_PROVIDER_PLUGIN_ID],
      load: { paths: [join(root, OPENCLAW_PLUGIN_DIRECTORY)] },
      entries: {
        [OPENCLAW_PLUGIN_ID]: { enabled: true },
        [OPENCLAW_PROVIDER_PLUGIN_ID]: { enabled: true }
      }
    },
    channels: {
      discord: {
        enabled: true,
        token: secretEnvironmentReference(OPENCLAW_DISCORD_TOKEN_ENV),
        dmPolicy: "disabled",
        groupPolicy: "allowlist",
        configWrites: false,
        joinIntro: false,
        allowBots: false,
        commands: { native: false },
        guilds: {
          [input.guildId]: {
            channels: {
              [input.channelId]: {
                enabled: true,
                requireMention: false,
                users: ["*"]
              }
            }
          }
        }
      }
    },
    messages: { groupChat: { visibleReplies: "message_tool" } },
    commands: { native: false }
  };
}

function secretEnvironmentReference(id: string) {
  return { source: "env", provider: "default", id } as const;
}

function requireDiscordSnowflake(value: string): void {
  if (!/^\d{15,20}$/.test(value)) {
    throw new Error("A Discord server and channel ID are required.");
  }
}
