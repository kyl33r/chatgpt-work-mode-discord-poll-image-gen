# ChatGPT Work Mode Discord Poll Image Generation

A Work-native proof of concept for collaborative image editing in Discord.

The owner starts a round from ChatGPT with a Base Image attached here or linked from one exact Discord message. ChatGPT Work posts it to the allowlisted channel, captures the first configured number of ordinary non-empty text messages after that boundary, synthesizes and publicly records one final prompt, attempts one edit with `$imagegen`, and returns one controlled success, refusal, or failure outcome to Discord.

The POC deliberately uses no Discord bot, Discord token, incoming webhook, OpenAI API key, or second Playwright-controlled ChatGPT browser.

## Skills

Canonical skill source lives under:

```text
skills/
├── configure-discord-channel/
├── round-start/
├── submit-base-image/
├── get-discord-polls/
└── image-gen/
```

Repo-discovery symlinks under `.agents/skills/` point to those folders. Shared TypeScript code owns state transitions, feedback normalization, poll mapping, JSON persistence, and duplicate prevention.

## First POC

1. Start from an explicit owner instruction in ChatGPT.
2. Post one Base Image and start marker into one allowlisted Discord channel.
3. Capture the first five ordinary non-empty text messages, including repeated authors and random text.
4. Synthesize all five messages into one sanitized prompt and post it with the closed marker; later messages are ignored.
5. Attempt one Base Image edit here using that exact persisted prompt.
6. Post and visibly confirm one Result Image or sanitized refusal/failure status without duplicating side effects.

Participant reference images, native voting, and subsequent edit rounds are deferred until this path is proven.

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
- [Isolated Round State Capsules design](docs/superpowers/specs/2026-08-26-isolated-round-state-capsules-design.md)

The existing bot-based experiment remains separate in `kyl33r/discord-image-feedback-relay`.
