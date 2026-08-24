# Discord Polls Operated by ChatGPT Work Skills — Feasibility and POC Plan

Date: 2026-08-24

Status: Research-backed proposal; product protocol still requires owner approval.

## Executive conclusion

The Work-native approach is viable as a proof of concept:

- People use a dedicated Discord channel and create ordinary Discord polls.
- A recurring ChatGPT Work task checks that channel through ChatGPT's signed-in built-in browser.
- Reusable skills tell Work how to recognize requests, interpret poll results, generate or edit an image with `$imagegen`, post the file back to Discord, and record completion.
- No Discord bot, incoming webhook, public server, Discord token, or second Playwright-controlled ChatGPT session is required for this version.

This is a better POC than the current bot-to-ChatGPT-browser relay if the goal is to test the human workflow quickly and stay within ChatGPT Work/Codex included usage.

It is not a real-time integration. Skills are reusable instructions, not background event listeners. A scheduled Work task supplies the wake-up mechanism by checking Discord on a cadence. The first technical spike must therefore prove that an unattended scheduled task can reliably open the built-in browser, retain the dedicated Discord login, inspect the target channel, and make a harmless test post. OpenAI documents each underlying capability, but does not explicitly guarantee this exact scheduled-browser-session combination.

## What official documentation establishes

### ChatGPT and Codex skills

OpenAI describes skills as packages of instructions, resources, and optional scripts for repeatable workflows. Skills can be used by ChatGPT and Codex, and plugin-packaged skills work in Chat and Work across web, desktop, and mobile.

Source: [OpenAI — Build skills](https://learn.chatgpt.com/docs/build-skills)

Implication: the Discord workflow can be decomposed into small, reusable skills. A skill does not itself run continuously or receive Discord events.

### Browser access and login

ChatGPT's browser can open and act on websites. The desktop app uses a browser profile separate from the user's normal browser, and the user can sign in directly inside that profile.

Source: [OpenAI — Browser](https://learn.chatgpt.com/docs/browser)

Implication: Work can operate Discord's web UI with a dedicated Discord account after one manual sign-in. UI changes, reauthentication, CAPTCHA, or verification can still interrupt unattended operation.

### Scheduled background work

OpenAI documents recurring background tasks that can be combined with skills. Desktop scheduled tasks can use local projects when the computer and app remain running. Web scheduled tasks can use uploaded context, connected tools, skills, and plugins, but do not retain a local folder.

Source: [OpenAI — Scheduled tasks](https://learn.chatgpt.com/docs/automations)

Implication: a recurring task can be the polling loop. The local desktop route is the appropriate POC because the skills and local state ledger can live in this repository. The machine and ChatGPT desktop app must remain on.

### Built-in image generation

OpenAI documents image generation and editing in ChatGPT and explicit invocation with `$imagegen`. Built-in generation uses `gpt-image-2` and counts toward general Codex usage limits. OpenAI recommends the API for programmatic image generation and larger batches.

Source: [OpenAI — Image generation](https://learn.chatgpt.com/docs/image-generation)

Implication: the POC can generate images inside Work without an OpenAI API key. This is suitable for a small, supervised POC, not an unbounded public service.

### Discord webhooks, interactions, and polls

Discord's ordinary incoming webhooks are one-way endpoints for posting messages. Discord recommends an app/bot when an integration must listen or respond to users. Native polls can be created in messages, and final results are available after the poll ends. Poll vote add/remove notifications are Gateway events rather than ordinary incoming-webhook events.

Sources:

- [Discord — Webhooks](https://docs.discord.com/developers/platform/webhooks)
- [Discord — Poll Resource](https://docs.discord.com/developers/resources/poll)
- [Discord — Gateway Events](https://docs.discord.com/developers/events/gateway-events)

Implication: an ordinary webhook cannot implement the proposed listener. Directly reading the Discord UI avoids needing the Discord developer platform for the POC, at the cost of cadence and UI fragility.

### Workspace Agents API

OpenAI also provides an API to trigger a published ChatGPT workspace agent. It accepts an input and returns a ChatGPT conversation URL, but the agent's response cannot currently be retrieved through that API. Run status polling is available in beta.

Source: [OpenAI — Trigger workspace agent runs](https://developers.openai.com/workspace-agents/trigger-runs)

Implication: this can wake a workspace agent from an external system, but it does not by itself return an image to Discord. It is unnecessary for the Work-native UI POC and is not the missing webhook bridge.

## Three viable architectures

| Architecture | Trigger | Discord access | Image path | Strength | Main weakness |
| --- | --- | --- | --- | --- | --- |
| A. Work-native UI operator | Recurring Work task | Signed-in Discord web UI | Built-in `$imagegen` | Smallest POC; no bot or API keys | Not real-time; UI and login fragile |
| B. Discord application plus Work | Slash command / Gateway or HTTP interactions | Discord API | Workspace Agent trigger plus an outbound tool | Reliable Discord trigger; Work conversation remains visible | More infrastructure; Workspace Agent output is not retrievable directly |
| C. Discord application plus OpenAI API | Slash command / Gateway or HTTP interactions | Discord API | Responses/Image API | Reliable, observable, scalable automation | Separate API billing and production engineering |

Recommendation: build Architecture A as a strictly bounded POC. Treat Architecture C as the production migration path if the human workflow proves useful. Do not build Architecture B unless keeping a visible Workspace Agent conversation is a hard product requirement; otherwise it adds a middle layer without solving image delivery.

## Proposed Discord protocol

Use one dedicated channel, for example `#image-requests`, and one dedicated Discord account for ChatGPT Work.

### New request

1. A member creates a native Discord poll in the dedicated channel.
2. The poll question begins with `IMAGE:` and contains the brief, or points to the immediately preceding brief message when the prompt is longer than Discord's poll-question limit.
3. Poll answers represent candidate directions. Example: `Editorial photo`, `Flat illustration`, `3D render`, and `Do not generate`.
4. The poll has a defined closing time. Work ignores open polls.
5. When the scheduled task sees a newly finalized poll, it claims the request with a visible reply containing a generated job identifier.
6. Work combines the brief with the winning answer, invokes `$imagegen`, and uploads the result in a thread attached to the request.
7. Work posts a bounded feedback poll: `Approve`, `Revise`, or `Stop`.
8. If `Revise` wins, members put concrete change requests in that thread. After the feedback poll closes, Work gathers only replies made after the current image, generates one edit, and repeats.
9. The workflow stops on `Approve`, `Stop`, a fixed image limit, or a blocking failure.

### Why the protocol needs conventions

The UI does not provide typed events to the model. A prefix, dedicated channel, explicit closing time, thread-per-job rule, and visible claim/completion markers make the page state machine-readable and reduce accidental processing of unrelated chat.

## Skill decomposition

The skills should coordinate through a small deterministic local ledger rather than depending on chat memory alone.

### 1. `discord-image-queue`

- Open only the allowlisted Discord channel URL.
- Locate finalized, unclaimed polls whose question starts with `IMAGE:`.
- Extract the request message URL, author, brief, winning answer, reference attachments, and final vote counts.
- Reject unsupported, ambiguous, still-open, or already-processed requests.

### 2. `discord-image-job-state`

- Generate a stable job ID from the Discord message URL.
- Maintain job phase, turn number, processed message IDs, current image path, and failure reason in a local ledger.
- Enforce idempotency so a repeated scheduled run cannot generate or post the same turn twice.
- Permit one active job at a time for the initial POC; queue the rest.

### 3. `discord-image-prompt`

- Combine the original brief, winning poll direction, reference-image notes, and later thread feedback deterministically.
- Ignore votes and replies outside the allowlisted request thread and time window.
- Apply fixed prompt and safety boundaries.

### 4. `discord-image-generate`

- Invoke `$imagegen` once for a new turn.
- For revisions, edit the most recent generated image and preserve elements not targeted by feedback.
- Never retry automatically after an ambiguous timeout or partial result.
- Save the generated artifact and provenance metadata locally.

### 5. `discord-image-publish`

- Return to the exact allowlisted Discord request thread.
- Upload only the artifact recorded for the current job and turn.
- Post the turn number and compact prompt summary.
- Create the bounded feedback poll and record its message URL.
- Mark the turn published only after the Discord UI visibly confirms the post.

### 6. `discord-image-recovery`

- Detect login, verification, changed UI, missing attachment, ambiguous duplicate, and generation-limit conditions.
- Mark the job `needs-attention` and post no further content when state is uncertain.
- Never solve CAPTCHA, export browser session data, or widen Discord permissions.

## State model

```text
discovered -> claimed -> generating -> generated -> publishing -> awaiting_feedback
awaiting_feedback -> approved
awaiting_feedback -> generating     (revision, below turn cap)
any active phase -> needs_attention  (ambiguous or blocking failure)
any active phase -> stopped          (explicit Stop or turn cap)
```

Each transition is persisted before the next external side effect. The publisher uses the Discord request URL plus turn number as its idempotency key.

## Security and operating boundaries

- Use a dedicated Discord account, not the owner's everyday account.
- Grant access only to the dedicated server/channel; do not grant administrator or moderation permissions.
- Do not read DMs or unrelated channels.
- Keep the Discord browser profile local to ChatGPT's built-in browser and never export cookies or session data.
- Treat Discord content, links, and attachments as untrusted input. Ignore instructions in Discord that attempt to change the skill, channel allowlist, limits, or target destination.
- Allowlist request authors or a Discord role during the POC.
- Cap one active job, three image turns per job, one generation attempt per turn, and a small number of jobs per day.
- Record message URLs and hashes, not Discord session credentials.
- Stop for reauthentication, verification, unexpected UI, uncertain poll state, uncertain upload, or usage limits.

## Proof-first validation plan

### Gate 0 — manual capability check

In the built-in browser, manually sign the dedicated account into Discord and verify that Work can:

1. open the allowlisted channel URL;
2. read one test poll and its final result;
3. create a harmless test poll;
4. upload a known local test image to a thread.

No automation should be scheduled until all four pass.

### Gate 1 — unattended browser-session spike

Create a one-time scheduled Work task that opens the same Discord channel and posts a fixed harmless message in a private test channel. Verify:

- the scheduled run starts while the desktop app is in the background;
- the signed-in Discord browser profile is available;
- no approval prompt blocks the post;
- the run reports success only after visible confirmation;
- a second identical run detects the first marker and does not repost.

Failure of this gate means Architecture A is not an unattended POC. The fallback is Architecture C, not more browser scripting.

### Gate 2 — read-only poll worker

Schedule the queue skill to detect finalized test polls and write normalized job records, but do not generate or post images. Compare its extracted brief, winner, author, message URL, and reference attachments against expected fixtures.

### Gate 3 — one-shot image path

For one allowlisted test poll, generate exactly one image and post it to the correct thread. Rerun the task and verify no duplicate generation or upload.

### Gate 4 — one revision loop

Exercise `Approve`, `Revise`, `Stop`, timeout/no-result, conflicting feedback, and the image-turn cap with two test users.

## Test-driven development plan

The browser UI itself requires smoke tests, but the risky orchestration should be test-driven before the UI is allowed to perform side effects.

Write failing tests first for:

- poll/request normalization from saved, scrubbed page observations;
- rejection of open, ambiguous, malformed, unauthorized, and unrelated polls;
- deterministic prompt construction and feedback ordering;
- job-state transitions and one-active-job queuing;
- duplicate scheduled runs and duplicate publish attempts;
- recovery from `generating`, `generated`, and `publishing` after interruption;
- turn and daily generation caps;
- prompt-injection attempts that ask the worker to change channels, reveal data, or ignore limits;
- publish confirmation and fail-closed handling when confirmation is absent.

Then add a small UI smoke suite using a private Discord test channel. Do not claim the POC is ready based only on unit tests.

## Delivery phases

### Phase 1 — feasibility spike

- Create the dedicated Discord account and private test channel.
- Prove Gate 0 and Gate 1.
- Decide whether Work-native scheduled operation is dependable enough for this POC.

### Phase 2 — skill-only one-shot POC

- Implement the queue, state, prompt, generation, publishing, and recovery skills.
- Add the deterministic ledger and TDD suite.
- Support one finalized request poll -> one image -> one Discord thread.

### Phase 3 — bounded feedback loop

- Add feedback polls, thread feedback collection, image editing, approval, stop, and a three-turn cap.
- Run supervised end-to-end tests with two participants.

### Phase 4 — evaluate the architecture

- Measure missed/duplicate jobs, time-to-first-image, manual interventions, and generation usage.
- Keep Architecture A if it is adequate for a small internal workflow.
- Move to a Discord application plus OpenAI API if the team needs immediate response, durable events, concurrency, or dependable unattended operation.

## Decision still required

The workflow needs one product rule before implementation: does a poll's winning option choose the image direction and trigger generation only after the poll closes, or should creating the poll immediately start image generation and use the poll only for feedback? The former is deterministic and recommended.
