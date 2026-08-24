# ChatGPT Work Mode Discord Poll Image Generation

A Work-native proof of concept for collaborative image editing in Discord.

The owner starts a round from ChatGPT with a Base Image attached here or linked from one exact Discord message. ChatGPT Work posts it to the allowlisted channel, captures the first configured number of ordinary non-empty text messages after that boundary, attempts one edit with `$imagegen`, and returns one controlled success, refusal, or failure outcome to Discord.

The POC deliberately uses no Discord bot, Discord token, incoming webhook, OpenAI API key, or second Playwright-controlled ChatGPT browser.

## Skills

Canonical skill source lives under:

```text
skills/
├── submit-base-image/
├── get-discord-polls/
└── image-gen/
```

Repo-discovery symlinks under `.agents/skills/` point to those folders. Shared TypeScript code owns state transitions, feedback normalization, poll mapping, JSON persistence, and duplicate prevention.

## First POC

1. Start from an explicit owner instruction in ChatGPT.
2. Post one Base Image and start marker into one allowlisted Discord channel.
3. Capture the first five ordinary non-empty text messages, including repeated authors and random text.
4. Post and confirm one closed marker; later messages are ignored.
5. Attempt one Base Image edit using all five exact messages in arrival order.
6. Post and visibly confirm one Result Image or sanitized refusal/failure status without duplicating side effects.

Participant reference images, native voting, and subsequent edit rounds are deferred until this path is proven.

## Local state

The first implementation persists state to gitignored `.runtime/rounds.json` inside an isolated worktree. Storage is accessed through a replaceable boundary; local SQLite is introduced only if real concurrency, transactional, query, or performance needs demonstrate that JSON is no longer sustainable.

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

The existing bot-based experiment remains separate in `kyl33r/discord-image-feedback-relay`.
