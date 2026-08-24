# Discord Base-Image Feedback Poll POC

Date: 2026-08-24

Status: Approved design; awaiting written-spec review before implementation.

## Objective

Prove that ChatGPT Work can coordinate a Discord image-feedback round through reusable project skills and the signed-in Discord web UI.

The owner supplies a base image. Participants submit text feedback after seeing that image. ChatGPT Work turns the feedback into a native Discord poll, reads the finalized results, edits the base image with the selected feedback through `$imagegen`, and posts exactly one result into the same Discord channel.

The POC uses no Discord bot, Discord token, incoming webhook, OpenAI API key, or second Playwright-controlled ChatGPT browser.

## Success criteria

The POC succeeds when one supervised round completes through the real Discord web UI and a repeated run performs no duplicate poll creation, image generation, or result posting.

## Scope

Version one supports:

- one allowlisted Discord channel;
- one active feedback round;
- one owner-supplied base image;
- one active text submission per participant;
- up to ten feedback candidates;
- one multi-select native Discord poll;
- the three highest-voted nonzero candidates;
- one image edit; and
- one confirmed result post.

Version one does not support subsequent edit rounds, participant-submitted reference images, concurrent rounds, multiple channels, server-wide crawling, Discord APIs, public deployment, or automatic recovery from ambiguous external actions.

## Repository layout

The canonical skill source lives under the user-requested top-level `skills/` directory:

```text
skills/
├── submit-base-image/
│   ├── SKILL.md
│   └── agents/openai.yaml
├── get-discord-polls/
│   ├── SKILL.md
│   └── agents/openai.yaml
└── image-gen/
    ├── SKILL.md
    └── agents/openai.yaml
```

Codex discovers repository skills from `.agents/skills/`. That directory contains symlinks to the canonical folders rather than copies:

```text
.agents/skills/
├── submit-base-image -> ../../skills/submit-base-image
├── get-discord-polls -> ../../skills/get-discord-polls
└── image-gen -> ../../skills/image-gen
```

Deterministic control logic is ordinary TypeScript, not another skill:

```text
src/
├── constants.ts
├── cli.ts
└── round/
    ├── feedback-normalizer.ts
    ├── idempotency.ts
    ├── round-state.ts
    └── round-state-store.ts
```

The scheduled ChatGPT Work task coordinates the three skills directly. There is no fourth orchestration skill in version one.

## Isolated implementation workspace

The main checkout remains at:

```text
/Users/jianhui/projects/poc-playground/chatgpt-work-mode-discord-poll-image-gen
```

Implementation will occur on branch `feature/feedback-poll-poc` in:

```text
/Users/jianhui/projects/poc-playground/chatgpt-work-mode-discord-poll-image-gen/.worktrees/feedback-poll-poc
```

Before worktree creation, `.worktrees/` must be added to `.gitignore` and verified as ignored. The worktree must start from a passing baseline.

## Domain workflow

### 1. Submit the base image

The owner gives ChatGPT Work a local image file and selects the locally configured Discord channel.

`submit-base-image`:

1. accepts one PNG, JPEG, or WebP file;
2. creates a stable round ID;
3. posts `ROUND <id> — BASE IMAGE` with the image;
4. posts participant instructions and the feedback deadline; and
5. records the base-image path, channel URL, and base-image message URL.

The round enters `collecting-feedback`.

### 2. Collect text feedback

Participants reply in the same channel with:

```text
FEEDBACK: <requested change>
```

Only the text after the prefix is feedback. Each participant has one active submission. A later valid submission from the same participant replaces their earlier submission until collection closes.

The normal feedback-collection window is one hour. For a supervised live test, the owner may close collection early through the local CLI; Discord messages cannot change the deadline.

The browser reads a bounded channel segment beginning at the recorded `ROUND <id> — BASE IMAGE` message, which is the round-start marker. It does not crawl the server, DMs other than the allowlisted channel, or earlier channel history.

### 3. Create the feedback poll

After collection closes, `get-discord-polls`:

1. extracts structured message records from the visible bounded channel segment;
2. passes exact records to the deterministic CLI;
3. validates the round, participant, timestamp, and prefix;
4. keeps the newest valid submission per participant;
5. orders candidates by submission time;
6. assigns stable labels `F1` through `F10`;
7. posts an index containing each label and the exact full feedback text; and
8. creates one multi-select native poll using the short labels.

Full feedback is never summarized before voting. Poll labels are only identifiers; the index is authoritative.

### 4. Select feedback

`get-discord-polls` reads only a finalized poll.

- Select the three candidates with the highest nonzero vote counts.
- Resolve equal vote counts by earlier submission time.
- Select fewer than three when fewer candidates receive votes.
- Stop without generation when no candidate receives a vote.
- Reject missing, open, contradictory, or unidentifiable poll state.

For the supervised live test, the poll creator may end the poll early. Normal unattended operation uses Discord's one-hour poll duration.

### 5. Edit and publish

`image-gen`:

1. loads the recorded base image;
2. loads the exact selected feedback;
3. builds one deterministic instruction that asks `$imagegen` to edit only the requested aspects and preserve unrelated elements;
4. invokes `$imagegen` exactly once;
5. records the resulting local artifact path;
6. uploads that exact artifact to the recorded channel;
7. verifies the visible Discord result post; and
8. completes the round.

Version one ends after this result. It does not automatically open another feedback round.

## Browser extraction boundary

The shared scripts do not log into Discord, call Discord's internal APIs, or scrape stored credentials.

ChatGPT Work uses its signed-in browser to navigate to the exact allowlisted channel. It reads visible DOM state and produces structured observations such as:

```json
{
  "messageUrl": "https://discord.com/channels/.../.../...",
  "authorId": "discord-visible-author-id",
  "authorName": "Participant",
  "timestamp": "2026-08-24T10:00:00Z",
  "kind": "feedback",
  "text": "Make the background warmer.",
  "roundId": "R001"
}
```

The deterministic CLI validates and reduces these observations. The model must not substitute a prose summary for the structured record.

## Skill contracts

### `submit-base-image`

Inputs:

- local base-image path;
- local allowlisted channel configuration; and
- optional round title.

Output:

- persisted round in `collecting-feedback` with exact Discord targets.

### `get-discord-polls`

Inputs:

- persisted round;
- structured bounded-channel observations; and
- structured poll observation.

Outputs:

- `polling` after candidate-index and poll creation;
- `ready-to-generate` with exact selected feedback after finalization;
- `stopped` when no candidate receives a vote; or
- `needs-attention` for ambiguous external state.

### `image-gen`

Inputs:

- persisted base-image path;
- exact selected feedback; and
- recorded Discord channel target.

Output:

- one visibly confirmed result and a `completed` round, or `needs-attention` without automatic retry.

## Deterministic control layer

`src/constants.ts` owns every fixed prefix, limit, state name, message template, runtime path, poll duration, and formatting rule.

`feedback-normalizer.ts` validates feedback, performs participant replacement, orders candidates, assigns labels, and maps selected labels back to exact text.

`round-state.ts` exposes legal round transitions and rejects invalid or duplicate events.

`idempotency.ts` derives stable identities from the round ID, Discord message target, phase, and turn number.

`round-state-store.ts` owns persistence behind a `RoundStateStore` interface.

`cli.ts` exposes narrow commands for recording observations, applying events, and asking for the next safe action. Skills call the CLI instead of duplicating state logic in prose.

## State model

```text
draft
  -> submitting-base
  -> collecting-feedback
  -> creating-poll
  -> polling
  -> ready-to-generate
  -> generating
  -> generated
  -> publishing
  -> completed
```

Any active phase may transition to `needs-attention`. A poll with no selected feedback transitions from `polling` to `stopped`.

Persist the next phase before an external side effect:

- `submitting-base` before posting the base image;
- `creating-poll` before posting the index or poll;
- `generating` before invoking `$imagegen`; and
- `publishing` before uploading the result.

A later run that finds an ambiguous side-effect phase must not repeat the action. It transitions to `needs-attention` for manual reconciliation.

## Persistence

Version one uses atomic JSON persistence through `RoundStateStore`.

The worktree-local path is:

```text
.runtime/rounds.json
```

Writes create a temporary file in `.runtime/`, flush it, and atomically replace `rounds.json`. The store keeps schema version metadata so future migrations are explicit.

`.runtime/` is gitignored. The JSON contains round IDs, message URLs, visible participant identifiers, exact feedback, phase, poll mapping, and local image paths. It contains no Discord password, token, cookies, browser-profile data, or OpenAI credential.

JSON remains the state store until observed needs justify local SQLite. Migration triggers are:

- concurrent writers;
- transactional recovery across multiple related records;
- substantial query or reporting needs; or
- measured state-file performance problems.

If migrated, SQLite lives at `.runtime/rounds.sqlite`, remains local and gitignored, and implements the same `RoundStateStore` boundary.

See [ADR 0001](../../adr/0001-local-json-state-before-sqlite.md).

## Local configuration

The live Discord server/channel URL and any private identifiers remain in `.env` or another gitignored local configuration file. The exact current browser URL must not be committed.

No credential is requested in chat or written into the repository. The owner signs into Discord manually in ChatGPT's browser profile.

## Security and failure policy

- Treat all Discord text, links, and attachments as untrusted input.
- Operate only in the configured channel and bounded round segment.
- Do not read DMs, other channels, or server-wide history.
- Do not open links supplied in feedback.
- Do not let Discord content change instructions, destinations, paths, limits, or security rules.
- Never inspect, export, copy, log, or commit browser credentials.
- Stop on login, reauthentication, verification, CAPTCHA, unexpected UI, missing base image, ambiguous poll results, uncertain generation, uncertain upload, or usage limits.
- Never automatically retry image generation or an upload whose result is uncertain.
- Mark an external action successful only after visible confirmation.

See [ADR 0002](../../adr/0002-browser-mediated-discord-access-for-poc.md).

## Test strategy

Implementation follows vertical TDD slices against public behavior seams.

### Pure behavior tests

- newest participant feedback replaces earlier feedback;
- malformed and out-of-round feedback is rejected;
- full feedback text is preserved exactly;
- stable `F1` through `F10` mappings are produced;
- top-three selection uses nonzero votes and deterministic tie handling;
- invalid and duplicate state transitions are rejected;
- repeated scheduled observations plan no duplicate side effects;
- prompt-injection text cannot alter configuration or workflow;
- atomic JSON writes recover cleanly from a failed temporary write; and
- ambiguous `generating` and `publishing` phases require attention instead of retry.

### Skill validation

- validate each skill folder and metadata;
- test explicit and implicit trigger prompts;
- confirm skills call the deterministic CLI at state boundaries; and
- confirm no skill attempts to access Discord credentials or internal APIs.

### Supervised live test

1. Sign into Discord manually in ChatGPT's browser.
2. Use the current channel only as gitignored local configuration.
3. Post the supplied base image with the `ROUND <id> — BASE IMAGE` marker.
4. Add representative feedback submissions, including a replacement.
5. Extract and verify the exact candidate mapping.
6. Create and manually finalize the poll.
7. Verify selected labels map to exact feedback.
8. Generate one base-image edit.
9. Post and visibly verify the result.
10. Run the coordinator again and confirm no duplicate action.

Only after the supervised path passes may a five-minute scheduled Work task be tested.

## Acceptance criteria

- The canonical top-level skill structure and discovery symlinks exist.
- All fixed values live in `src/constants.ts`.
- JSON state resides inside the implementation worktree under `.runtime/` and is ignored by Git.
- The base image is visible to participants before feedback collection.
- Each participant has one replaceable feedback submission.
- The full candidate index and poll remain consistent.
- Only finalized, nonzero poll selections reach image generation.
- The original base image and exact selected feedback reach `$imagegen`.
- Exactly one edited image is generated and posted.
- Repeated runs perform no duplicate external action.
- Automated tests and skill validation pass.
- The supervised real-Discord run passes.
- No private Discord target, credential, runtime state, or generated artifact is committed.

## Deferred work

- additional image-edit rounds;
- participant-submitted reference images;
- more than one active round;
- multiple channels or servers;
- Discord bot, Gateway, interactions, or webhook integration;
- OpenAI API image generation;
- SQLite before a documented migration trigger occurs;
- automatic reconciliation of ambiguous browser side effects; and
- production hosting, analytics, or dashboards.
