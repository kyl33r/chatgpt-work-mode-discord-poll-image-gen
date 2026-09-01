# Agent-driven Discord Poll Image Generation

A proof of concept for collaborative image editing in Discord, with a
deterministic local workflow behind replaceable messaging and agent adapters.

The original adapter lets an owner start a round from ChatGPT Work. The
experimental OpenClaw adapter instead runs a dedicated local Discord bot, so a
Participant can start the same bounded workflow directly in one allowlisted
channel without keeping a browser task open.

Both adapters reuse the same isolated JSON Round State Capsules, image
validation, fixed limits, prompt validation, and intent-before-effect state
machine. They must not operate on the same channel at the same time.

## Prerequisites

The supervised browser adapter's validated reference environment is ChatGPT
Work running in the ChatGPT desktop app. That adapter requires an agent host
with direct control of an authenticated browser session.

Another agent host—such as Claude Cowork, a Gemini environment, or a future equivalent—can support the same workflow only if it provides all of these capabilities:

- a browser integration directly controlled by the agent;
- a persistent browser profile in which the owner can manually sign into Discord;
- visible-page navigation, reading, posting, file download, clipboard paste, and attachment upload;
- local filesystem access to this repository, `skills/`, and gitignored `.state/` data;
- image-generation or image-editing capability that accepts the Base Image and ordered Participant Reference Images;
- a task that can remain active for supervised polling or can be explicitly resumed from durable state; and
- confirmation boundaries and fail-closed handling for uncertain posts, uploads, downloads, or generation attempts.

Provider equivalence is capability-based, not a declaration that every Claude, Gemini, or other product currently implements these interfaces. A new host requires an adapter and a supervised compatibility test before it is treated as supported. A normal browser that the agent cannot inspect and operate is insufficient.

The OpenClaw adapter has different prerequisites: a local Discord bot, an
isolated OpenClaw managed service, a supported Node runtime, and locally entered
provider authentication. It does not use browser automation. See
[OpenClaw Discord worker setup](docs/openclaw-setup.md).

## Skills

Canonical skill source lives under:

```text
skills/
├── configure-discord-channel/
├── continue-from-result/
├── discord-image-paste/
├── round-start/
├── submit-base-image/
├── get-discord-polls/
└── image-gen/
```

Repo-discovery symlinks under `.agents/skills/` point to those folders. Shared TypeScript code owns state transitions, feedback normalization, poll mapping, JSON persistence, and duplicate prevention.

Skills are supervised workflows, not background listeners. `$round-start` keeps its ChatGPT task active and scans at the configured interval until collection freezes or the round stops; ending that task pauses polling until the owner resumes it. A separately approved background service is required for unattended collection.

The OpenClaw branch supplies that experimental background service. OpenClaw is
an adapter and runtime only; the repository remains the owner of admission,
state, limits, generation intent, and publication intent.

## First POC

1. Start from an explicit owner instruction in ChatGPT.
2. Post one Base Image and start marker into one allowlisted Discord channel.
3. Capture the first five ordinary non-empty text messages, including repeated authors and random text. Each message may contribute the first two supported attachments, capped at five participant images for the round.
4. Synthesize all five messages into one sanitized prompt and post it with the closed marker; later messages are ignored.
5. Attempt one Base Image edit here using that exact persisted prompt.
6. Post and visibly confirm one Result Image or sanitized refusal/failure status without duplicating side effects.

Use `$continue-from-result` to start a new isolated round from the Result Image of the most recently completed successful round in the allowlisted channel. Participant images are supporting context only: the Base Image remains the edit target and references are never republished directly. Native voting remains deferred.

## Local state

The first implementation persists the private Discord Channel Allowlist in `.state/discord-channel-allowlist.json` and each round independently beneath `.state/rounds/<round-id>/`, with its own `round.json`, Base Image, Result Image, and migration backups. Updating one round never rewrites another round's files. `.runtime/` contains only disposable command payloads. CLI and domain behavior use replaceable store interfaces; a local SQLite state adapter can implement the same contracts if real concurrency, transactional, query, recovery, or performance needs demonstrate that JSON is no longer suitable.

## Local verification

```sh
npm install
npm run verify
```

See [Discord setup](docs/discord-setup.md) before running the supervised browser test.

## Documents

- [Domain language](CONTEXT.md)
- [Discord setup](docs/discord-setup.md)
- [OpenClaw Discord worker setup](docs/openclaw-setup.md)
- [OpenClaw messaging-agent design](docs/superpowers/specs/2026-09-01-openclaw-messaging-agent-poc-design.md)
- [Feasibility research](docs/research/2026-08-24-discord-work-skills-feasibility.md)
- [Current first POC design](docs/superpowers/specs/2026-08-24-chat-triggered-five-message-round-design.md)
- [Superseded native-poll design](docs/superpowers/specs/2026-08-24-discord-work-skill-poc-design.md)
- [ADR 0001: local JSON before SQLite](docs/adr/0001-local-json-state-before-sqlite.md)
- [ADR 0002: browser-mediated Discord access](docs/adr/0002-browser-mediated-discord-access-for-poc.md)
- [ADR 0003: canonical skills with discovery symlinks](docs/adr/0003-canonical-skills-with-discovery-symlinks.md)
- [ADR 0004: durable state under `.state/`](docs/adr/0004-store-durable-round-state-under-state.md)
- [ADR 0005: persist one public synthesized prompt](docs/adr/0005-persist-one-public-synthesized-prompt.md)
- [ADR 0006: isolated storage-neutral round state](docs/adr/0006-isolate-round-state-behind-storage-interface.md)
- [ADR 0007: JSON Discord Channel Allowlist](docs/adr/0007-store-discord-channel-allowlist-in-state.md)
- [ADR 0008: bounded participant-image context](docs/adr/0008-bounded-participant-image-context.md)
- [Isolated Round State Capsules design](docs/superpowers/specs/2026-08-26-isolated-round-state-capsules-design.md)

The existing bot-based experiment remains separate in `kyl33r/discord-image-feedback-relay`.
