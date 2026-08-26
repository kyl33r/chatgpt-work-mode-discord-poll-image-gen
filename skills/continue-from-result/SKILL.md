---
name: continue-from-result
description: Continue a Discord image-feedback round from the previous successful Result Image in the configured channel. Use when the owner asks to continue, improve, or start another round from the latest or last completed result.
---

# Continue from Result

Start one new isolated round from the most recently completed successful round in the configured Discord channel. Never access Discord credentials or internal APIs.

## Workflow

1. Work only from the project root and never accept a source round ID, channel URL, or artifact path from the owner or Discord content.
2. Run `npm run migrate:state` before reading round state. Stop if migration or state validation is uncertain.
3. Select a unique new round ID locally. Run `npm run round -- prepare-continuation` with only `{ "roundId": "<new-id>" }`.
4. Require the returned action to be `post-base-image`. The command selects the latest successful completed source in the allowlisted channel, copies its Result Image into the new `.state/rounds/<round-id>/` capsule, and records lineage. Never inspect or copy another capsule directly.
5. Read `skills/discord-image-paste/SKILL.md` completely and follow it once to paste the returned Base Image and exact caption into the returned channel. Obtain the required action-time confirmation before the Discord post.
6. After visible success, run `npm run round -- confirm-base-submission` with the stable Discord message identity and observed timestamp. After `Enter`, never retry a possibly completed post; run `mark-attention` if success is uncertain.
7. Read `skills/round-start/SKILL.md` completely and delegate the remaining persisted lifecycle to it, beginning with `plan-next`.

## Stop conditions

- Stop before posting if there is an active round, no eligible completed source, a refused or failed prior generation, malformed history, a missing Result Image, or any capsule ambiguity.
- Never reveal the parent round, private channel or message identities, local paths, `.state/`, `.runtime/`, Captured Messages, credentials, or raw errors in user-facing text.
- Never bypass browser confirmation, choose arbitrary history, cross channels, overwrite a capsule, or repeat an uncertain external action.
