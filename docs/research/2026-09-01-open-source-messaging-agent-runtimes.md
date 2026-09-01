# Open-source messaging-agent runtimes for the image-feedback POC

Date: 2026-09-01

Status: Research recommendation. No runtime has been adopted yet.

## Conclusion

Use a pinned OpenClaw release for the first spike, without forking OpenClaw.
Add one thin repository-local plugin that delegates every durable rule and side
effect decision to this repository's deterministic TypeScript engine.

OpenClaw is the closest fit because it already supplies a continuously running
Gateway, Discord and other channel adapters, normalized media, an LLM tool
loop, plugin hooks, and controlled outbound delivery. The repository continues
to own channel admission, Feedback Round boundaries, limits, idempotency,
Synthesized Prompt persistence, and `.state/rounds/<round-id>/`.

## Popularity snapshot

GitHub star counts were queried on 2026-09-01. They are a popularity signal,
not a quality score.

| Candidate | Stars | License | Assessment |
| --- | ---: | --- | --- |
| [OpenClaw](https://github.com/openclaw/openclaw) | about 388,400 | MIT | Best fit; TypeScript and the strongest messaging and policy seams |
| [nanobot](https://github.com/HKUDS/nanobot) | about 47,600 | MIT | Best lightweight fallback, but introduces Python |
| [AstrBot](https://github.com/AstrBotDevs/AstrBot) | about 39,900 | AGPL-3.0 | Capable full chatbot platform with a heavier footprint |
| [LangBot](https://github.com/langbot-app/LangBot) | about 17,600 | Apache-2.0 | Strong cross-platform alternative, but also a larger Python platform |

Sources: the projects' GitHub repository pages and repository metadata:
[OpenClaw](https://api.github.com/repos/openclaw/openclaw),
[nanobot](https://api.github.com/repos/HKUDS/nanobot),
[AstrBot](https://api.github.com/repos/AstrBotDevs/AstrBot), and
[LangBot](https://api.github.com/repos/langbot-app/LangBot).

## Why OpenClaw

OpenClaw's Gateway owns channel connections, events, sessions, and agent runs.
Its official Discord adapter uses Discord's bot Gateway, supports guild
channels and direct messages, and includes allowlists and media delivery.

The plugin surface exposes the POC's required interception points:

- normalized inbound messages and ordered media;
- a pre-dispatch hook that can claim collection-only feedback without an LLM
  turn for every message;
- pre-tool policy hooks that can block an LLM-selected action;
- outbound-message hooks that can cancel unsafe output; and
- channel-scoped text and media delivery.

Primary sources:

- [OpenClaw architecture](https://github.com/openclaw/openclaw/blob/main/docs/concepts/architecture.md)
- [OpenClaw Discord adapter](https://github.com/openclaw/openclaw/blob/main/docs/channels/discord.md)
- [OpenClaw plugin hooks](https://github.com/openclaw/openclaw/blob/main/docs/plugins/hooks.md)
- [Building OpenClaw plugins](https://github.com/openclaw/openclaw/blob/main/docs/plugins/building-plugins.md)
- [OpenClaw security model](https://github.com/openclaw/openclaw/blob/main/docs/gateway/security/index.md)

OpenClaw is operationally large. The spike therefore uses a pinned version,
one named profile, one Discord account, one local plugin, a minimal tool
profile, and a unique loopback port. It does not enable general shell,
filesystem, browser, session-management, or automation tools.

## Alternatives

nanobot has a smaller MIT-licensed Python core, Discord/Slack/Telegram
adapters, inbound attachment staging, outbound media, skills, MCP, and basic
channel policies. It is the fallback if OpenClaw cannot satisfy attachment
staging or deterministic pre-dispatch collection. Sources:
[repository](https://github.com/HKUDS/nanobot),
[chat application configuration](https://github.com/HKUDS/nanobot/blob/main/docs/chat-apps.md), and
[Discord runtime](https://github.com/HKUDS/nanobot/blob/main/nanobot/channels/discord/runtime.py).

AstrBot provides official Discord, Slack, and Telegram adapters, multimodal
message chains, agents, MCP, skills, persistence, and a sandbox. It is more
opinionated, Python-based, and AGPL-licensed. Sources:
[repository](https://github.com/AstrBotDevs/AstrBot) and
[Discord adapter](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/core/platform/sources/discord/discord_platform_adapter.py).

LangBot provides official multi-platform adapters, tool-calling agents, MCP,
multimodal conversion, access-control pipelines, and SQLite persistence. It is
Apache-2.0 licensed but brings more bot-management infrastructure than the POC
needs. Sources:
[repository](https://github.com/langbot-app/LangBot),
[Discord platform source](https://github.com/langbot-app/LangBot/blob/master/src/langbot/pkg/platform/sources/discord.py), and
[access-control pipeline](https://github.com/langbot-app/LangBot/blob/master/src/langbot/pkg/pipeline/bansess/bansess.py).

## Acceptance gate

The OpenClaw spike succeeds only if it demonstrates all of the following in a
private allowlisted channel:

1. One natural-language request with one Base Image can start a round.
2. The Base Image is correlated with the exact inbound message.
3. Collection-only messages do not each trigger an LLM request.
4. The first configured number of qualifying messages and images are captured
   in provider order.
5. Replayed inbound events do not duplicate Captured Messages.
6. A disallowed destination cannot start or advance a round.
7. An ambiguous generation or send result pauses as Needs Attention.
8. Restarting the Gateway resumes from `.state/` without regenerating or
   reposting a completed effect.
9. The Result Image is returned through Discord without browser automation.

If OpenClaw fails attachment staging, deterministic collection, or controlled
delivery, run the same bounded spike with nanobot instead of weakening the
round invariants.
