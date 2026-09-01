import { describe, expect, it } from "vitest";

import { buildOpenClawProfilePatch } from "../src/openclaw/openclaw-profile-config.js";

describe("OpenClaw isolated profile config", () => {
  it("allows one Discord channel and only the bounded workflow tool", () => {
    const patch = buildOpenClawProfilePatch({
      projectRoot: "/project",
      guildId: "111111111111111111",
      channelId: "222222222222222222"
    });

    expect(patch).toMatchObject({
      gateway: {
        mode: "local",
        port: 21789,
        bind: "loopback",
        auth: {
          mode: "token",
          token: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_GATEWAY_TOKEN"
          }
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
          "start_image_feedback_round",
          "prepare_image_feedback_synthesis",
          "complete_image_feedback_round"
        ]
      },
      plugins: {
        allow: ["image-feedback-round", "openai"],
        load: { paths: ["/project/extensions/image-feedback-round"] },
        entries: {
          "image-feedback-round": { enabled: true },
          openai: { enabled: true }
        }
      },
      channels: {
        discord: {
          enabled: true,
          token: {
            source: "env",
            provider: "default",
            id: "DISCORD_BOT_TOKEN"
          },
          dmPolicy: "disabled",
          groupPolicy: "allowlist",
          configWrites: false,
          joinIntro: false,
          guilds: {
            "111111111111111111": {
              channels: {
                "222222222222222222": {
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
    });
  });
});
