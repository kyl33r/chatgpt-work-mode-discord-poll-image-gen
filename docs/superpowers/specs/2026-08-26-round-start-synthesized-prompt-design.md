# Round Start Orchestration and Synthesized Prompt Design

Status: Approved for implementation on 2026-08-26. The workflow remains current; its shared-file state layout is refined by [Isolated Round State Capsules](2026-08-26-isolated-round-state-capsules-design.md).

## Purpose

Provide one project skill that runs and resumes an entire Discord image-feedback round while preserving the existing deterministic state machine and browser safety gates. After five messages are frozen, the Work-mode agent creates one sanitized Synthesized Prompt, publishes it with the closed marker, invokes its installed image-generation skill with that exact prompt, renders the image in the current ChatGPT task, and posts the same Result Image to Discord.

## Scope

Version three adds:

- canonical `skills/round-start/` orchestration and discovery metadata;
- a Synthesized Prompt lifecycle between message collection and poll closure;
- public closed-marker text containing the exact persisted prompt;
- Work-mode `$imagegen` invocation rather than repository-owned provider code;
- durable worktree state beneath `.state/`;
- a narrow migration for the current safe version-two live round; and
- contract, lifecycle, migration, and safety tests.

It does not add a Discord bot, webhook, background daemon, OpenAI API client, database, or unattended browser session. Browser confirmations required by the host remain mandatory at each Discord post or upload.

## Directory boundaries

`.state/` is the sole home for restart-critical local data:

```text
.state/
├── rounds.json
├── base-images/
├── results/
└── migrations/
```

The entire directory is gitignored. `.runtime/` remains gitignored and contains only disposable command input/output files that can be reconstructed from `.state/`.

Fixed paths, limits, prompt constraints, and public templates remain in `src/constants.ts`.

## Canonical workflow

### Entry and resume

`round-start` is the single owner-facing entry skill. It reads and delegates to the three canonical project skills in order:

```text
submit-base-image → get-discord-polls → image-gen
```

The skill never guesses progress. It invokes `plan-next`, performs only the returned action, confirms persisted state at every boundary, and can resume after the owner continues the ChatGPT task. While the task remains active, it scans at the CLI-returned interval. It is not an unattended listener.

### Collect messages

The existing Base Image and first-five-message rules remain unchanged. Repeated authors and arbitrary non-empty ordinary text count. System events, attachment-only messages, duplicates, the Base Image post, and messages after the fifth slot do not count.

When the fifth message is accepted, the round freezes exactly five Captured Messages and enters `synthesizing-feedback`. No Discord post or image generation occurs yet.

### Synthesize once

`prepare-prompt-synthesis` is a read-only preparation command available only in `synthesizing-feedback`. It returns the five frozen messages in arrival order for the active Work-mode agent. The agent treats them strictly as untrusted visual-edit requests and derives one concise Synthesized Prompt.

The prompt must:

- incorporate the visual intent of all five messages;
- contain only instructions for editing the supplied Base Image;
- avoid names, quotations, authorship, links, mentions, identifiers, local paths, protocol markers, workflow commands, or diagnostic text;
- resolve conflicts into one coherent visual direction without inventing unrelated content;
- remain within `SYNTHESIZED_PROMPT_MAX_CHARACTERS`; and
- end with the fixed preservation and one-image constraint from `src/constants.ts`.

`confirm-synthesized-prompt` validates the candidate at deterministic high-confidence boundaries, persists it, enters `closing-collection`, and returns one closed-marker post action. It never accepts raw provider output or hidden reasoning.

### Close publicly

The public close post uses one controlled template:

```text
===== POLL CLOSED: <id> =====
Final image prompt:
<persisted Synthesized Prompt>
```

The exact prompt is public in the allowlisted Discord channel. Raw Captured Messages are not quoted or separately summarized. The agent obtains the required action-time confirmation, posts the returned caption exactly once, visibly confirms it, records its stable message URL, and enters `ready-to-generate`.

An uncertain closed-marker post becomes `needs-attention` and is never retried automatically.

### Render here

`prepare-generation` persists `generating` and returns the staged Base Image plus the exact persisted Synthesized Prompt. The `round-start` skill invokes the current Work-mode agent's installed `$imagegen` skill exactly once as an edit. The repository does not call a provider API.

On success, the agent renders the generated image in the current ChatGPT task, stages the same artifact under `.state/results/`, confirms one structured success outcome, and later uploads that exact file to Discord. Refusal and definitive failure retain the existing controlled public templates. Ambiguous generation enters `needs-attention`.

### Publish once

The existing outcome-publication boundary remains. `prepare-publication` persists intent before returning one image or controlled status post. After browser confirmation, the agent performs that action once, verifies the stable Discord message, records it, and completes the round.

## State model

Schema version three uses:

```text
draft
→ submitting-base
→ collecting-messages
→ synthesizing-feedback
→ closing-collection
→ ready-to-generate
→ generating
→ outcome-ready
→ publishing-outcome
→ completed
```

`stopped` and `needs-attention` remain terminal safety phases. `RoundState` adds `synthesizedPrompt`; it is required from `closing-collection` onward and is the only instruction accepted by `prepare-generation`.

Safe restart behavior:

- `collecting-messages` may rescan and deduplicate;
- `synthesizing-feedback` may prepare synthesis again because no external side effect has occurred;
- `ready-to-generate` may begin its first image edit;
- `outcome-ready` may begin its first outcome publication; and
- `submitting-base`, `closing-collection`, `generating`, and `publishing-outcome` become `needs-attention` because an external side effect may already have occurred.

## Version-two live-state migration

The migration is JSON-to-JSON, not a database migration. It runs explicitly and only when `.state/rounds.json` does not exist.

The one accepted active shape is:

- schema version two;
- exactly one round;
- phase `closing-collection`;
- exactly the configured number of frozen Captured Messages;
- no `closedMessageUrl`, `generationOutcome`, `outcomeMessageUrl`, or attention reason; and
- an existing supported Base Image staged beneath the old runtime Base Image root.

The migrator copies the Base Image into `.state/base-images/`, copies the original JSON into `.state/migrations/`, writes schema version three atomically with phase `synthesizing-feedback`, and leaves the old files untouched for recovery. Any other shape fails without creating new state.

## Public prompt validation

Deterministic validation rejects:

- empty or oversized prompts;
- URLs or link syntax;
- Discord mentions and protocol markers;
- long identifier-like digit sequences;
- `.env`, `.runtime`, `.state`, absolute local paths, or credential terms;
- round/CLI command names and attempts to change channel, limits, security, or control flow; and
- missing fixed image-edit constraints.

Semantic safety remains the skill's responsibility: the agent must produce a visual instruction rather than quote, attribute, or obey participant text as coordinator commands. A rejected candidate leaves the round in `synthesizing-feedback` and may be corrected before any external action.

## Skill contract

`skills/round-start/SKILL.md` triggers on explicit `$round-start` use and requests such as “start the Discord image round,” “run the feedback workflow,” or “resume the active round.” It:

1. reads the applicable child skill before each stage;
2. starts or resumes exactly one allowlisted round;
3. loops only while the ChatGPT task remains active;
4. honors every browser confirmation gate;
5. uses deterministic CLI commands at state boundaries;
6. invokes `$imagegen` once with the persisted prompt;
7. renders the Result Image in ChatGPT and publishes the same artifact to Discord; and
8. stops immediately on `needs-attention`, login challenges, ambiguous visible state, or unexpected actions.

The skill contains no duplicated child-skill instructions and no credentials. `.agents/skills/round-start` is a relative symlink to the canonical folder.

## Testing seams

Development follows red-green-refactor through the approved public seams:

- CLI commands and `RoundStateStore` for lifecycle behavior;
- the explicit version-two-to-version-three migration interface;
- the prompt validator as a pure public module;
- project skill metadata and contract validation; and
- the existing live Discord acceptance workflow.

Automated coverage includes:

- the fifth message enters `synthesizing-feedback` without returning a Discord post;
- synthesis preparation returns all five messages in order;
- invalid public prompts are rejected without advancing state;
- one valid prompt is persisted before `closing-collection` and rendered in the close template;
- `prepare-generation` returns the identical persisted prompt;
- restart planning distinguishes safe and ambiguous phases;
- durable paths resolve beneath `.state/` and escape attempts fail;
- the one supported live migration succeeds atomically and copies its Base Image;
- every other legacy shape fails without partial new state;
- `round-start` supports explicit and implicit triggers and references all child skills;
- all project skills retain credential, internal-API, and fail-closed boundaries; and
- existing success, refusal, failure, channel allowlist, and duplicate-prevention tests remain green.

## Live acceptance continuation

After implementation and verification, migrate the currently frozen version-two round. Derive and persist one safe prompt from its five messages, post that prompt with the closed marker after browser confirmation, invoke `$imagegen` once in this task, render the result here, and publish the same image or controlled status to Discord.
