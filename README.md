# ChatGPT Work Mode Discord Poll Image Generation

A Work-native proof of concept for collaborative image editing in Discord.

The owner supplies a base image either as a ChatGPT attachment or by linking its exact Discord message. Participants submit text feedback after seeing that image. ChatGPT Work turns the submissions into a native Discord poll, reads the finalized results through its signed-in browser, edits the base image with `$imagegen`, and posts exactly one result back into the same channel.

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

1. Post one base image into one allowlisted Discord channel.
2. Collect one replaceable `FEEDBACK:` submission per participant.
3. Publish an exact feedback index and a multi-select poll.
4. Select up to three highest-voted nonzero candidates.
5. Edit the base image once with the exact selected feedback.
6. Post and visibly confirm one result without duplicating side effects.

Participant reference images and subsequent edit rounds are deferred until this path is proven.

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
- [First POC design](docs/superpowers/specs/2026-08-24-discord-work-skill-poc-design.md)
- [ADR 0001: local JSON before SQLite](docs/adr/0001-local-json-state-before-sqlite.md)
- [ADR 0002: browser-mediated Discord access](docs/adr/0002-browser-mediated-discord-access-for-poc.md)

The existing bot-based experiment remains separate in `kyl33r/discord-image-feedback-relay`.
