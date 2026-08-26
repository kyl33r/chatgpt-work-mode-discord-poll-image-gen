# Reusable Discord Conversation Parser

Date: 2026-08-26

Status: Approved design pending implementation-plan review.

## Goal

Extract the existing Discord message-reading rules into a reusable, provider-neutral conversation layer. A caller identifies an allowlisted destination, optionally supplies a stable lower boundary, and receives the first configured qualifying messages plus bounded opaque attachment selections in deterministic visible order.

The first adapter continues to use only the signed-in, agent-controlled Discord browser. The reusable layer observes and selects attachments; it does not acquire image bytes. The clipboard feedback-acquisition branch remains independent until both branches have been reviewed.

## Scope

This feature provides:

- a small `ConversationSource` seam for provider adapters;
- provider-neutral request, observation, checkpoint, and snapshot types;
- a deterministic core that validates ordering, qualification, limits, deduplication, and restart consistency;
- a Discord browser adapter contract expressed by one canonical project skill;
- a CLI action that bridges private browser observations to the deterministic core without printing conversation content or private identifiers; and
- extension points for a different agent-controlled browser or an explicitly sanctioned bot adapter later.

This feature does not:

- download, paste, decode, validate, or persist attachment bytes;
- change `RoundArtifactStore`, participant-image acquisition, prompt synthesis, or generation;
- call Discord REST, Gateway, CDN, webhook, bot, or user-token interfaces;
- inspect cookies, browser storage, credentials, hidden history, other channels, unrelated DMs or threads, or links;
- crawl server-wide history;
- add background monitoring; or
- merge the clipboard and parser branches as part of initial delivery.

## Domain language

The existing `CONTEXT.md` vocabulary remains authoritative for Feedback Rounds, Text Polls, Captured Messages, and Participant Reference Images. This module adds implementation-facing terms without changing that domain glossary:

- **Conversation Destination**: an opaque provider-qualified reference to exactly one conversation surface. For Discord it resolves to one server channel or DM channel.
- **Stable Message Identity**: a provider-qualified opaque value that identifies the same message across repeated observations. It is private state, not display text.
- **Observation Boundary**: an optional Stable Message Identity excluded from results; only messages after it may be returned.
- **Conversation Observation**: one provider-neutral description of a visible message and its displayed attachments. It contains no attachment URL or local file path.
- **Attachment Selection**: an opaque reference to one displayed attachment by owning Stable Message Identity and zero-based displayed attachment index. It is permission to identify the attachment later, not acquired media.
- **Conversation Checkpoint**: the accepted prefix from an earlier scan that must remain unchanged on restart.
- **Conversation Snapshot**: the validated, deterministically ordered qualifying prefix returned by the core.

An Observation Boundary is broader than the existing Base Image post boundary. The Feedback Round adapter will supply its Base Image Stable Message Identity as the Observation Boundary during later integration.

## Chosen architecture

Use a provider-neutral observation seam plus one deep deterministic parser module:

```text
private destination request
        |
        v
allowlist resolver ---- rejects before navigation
        |
        v
ConversationSource seam
  Discord browser adapter (canonical skill)
        |
        v
ordered, contiguous visible observations
        |
        v
ConversationParser
  validates + qualifies + limits + deduplicates + resumes
        |
        v
ConversationSnapshot
  text + opaque attachment selections only
```

The `ConversationSource` adapter owns provider-specific navigation and visible-page interpretation. The parser owns every rule that must remain identical across adapters. Callers do not sort, filter, deduplicate, or apply attachment limits themselves.

This is preferred over putting all behavior in the Discord skill because a skill-only implementation would duplicate deterministic rules across future agents and be difficult to test. It is also preferred over a Discord-specific parser because message qualification and restart consistency do not depend on Discord. A bot-first design is deferred because it introduces credentials and permissions that are forbidden for the current proof of concept.

## Public interfaces

The exact module names may follow repository conventions, but the implementation must preserve this semantic interface:

```ts
export interface ConversationSource {
  observe(request: ConversationObservationRequest): Promise<ConversationObservationBatch>;
}

export interface ConversationObservationRequest {
  destination: ConversationDestination;
  boundary?: StableMessageIdentity;
  stopAfterQualifyingMessages: number;
}

export interface ConversationParseRequest {
  destination: ConversationDestination;
  boundary?: StableMessageIdentity;
  messageLimit: number;
  attachmentLimitPerMessage: number;
  attachmentLimitTotal: number;
  supportedAttachmentMediaTypes: readonly string[];
  checkpoint?: ConversationCheckpoint;
  observation: ConversationObservationBatch;
}

export interface ConversationSnapshot {
  destination: ConversationDestination;
  boundary?: StableMessageIdentity;
  complete: boolean;
  messages: readonly QualifyingConversationMessage[];
}
```

`ConversationDestination` and `StableMessageIdentity` are opaque, provider-qualified values. Callers may compare them through module helpers but may not parse provider internals. The initial Discord adapter accepts a canonical Discord channel URL, a channel ID alone, or an explicit `(serverId | "@me", channelId)` pair at its input edge. A channel ID alone is valid only when it equals the channel segment of the sole allowlist entry; the resolver then derives the server segment from that entry. All accepted forms normalize to the same destination, and every other shape is rejected. Raw IDs and URLs remain private.

`ConversationObservationBatch` contains:

- the exact normalized destination and optional boundary from the request;
- either `coverage: { kind: "contiguous-after-boundary" }` when a boundary was supplied or `coverage: { kind: "contiguous-visible-segment", segmentStart }` when none was supplied;
- messages in visible provider order; and
- for each message, its stable identity, kind, exact visible text, visible author fields, visible timestamp, and attachments in displayed order.

`segmentStart` is the first observed Stable Message Identity and becomes part of any no-boundary checkpoint. A later no-boundary rescan must use the same segment start; it cannot silently move the lower edge.

The initial message kinds are `ordinary-text`, `system`, and `attachment-only`. An observed attachment contains only its zero-based displayed index, visible media type, and an opaque provider selection value. It never contains a URL, byte payload, credential, browser handle serialized from privileged state, or local path.

The snapshot retains exact text and private identity metadata for its caller, but those fields are never part of public CLI output or user-facing summaries.

## Destination and authority rules

All Discord destination forms are canonicalized before browser navigation. The canonical destination must equal the sole entry returned by `DiscordChannelAllowlistStore`; semantic equivalence after normalization is required, not string resemblance.

The resolver fails closed when:

- no allowlist entry exists;
- more than one entry exists;
- the supplied reference is malformed;
- a server/channel pair resolves to a different canonical destination;
- the request attempts a server-wide, category-wide, thread-wide, or multi-channel scan; or
- the normalized destination differs from a checkpoint or observation batch.

The current allowlist continues to store one canonical Discord channel URL. Supporting a server/channel pair is an input convenience only and does not broaden the allowlist or introduce a second source of authority.

Discord content cannot change the destination, boundary, limits, supported media types, or control flow.

## Observation contract

The current Discord adapter is the canonical project skill `skills/observe-discord-conversation/SKILL.md`, with its discovery symlink and metadata. It runs only in the existing signed-in, agent-controlled browser session.

For one observation it must:

1. obtain the privately resolved allowlisted destination and optional boundary from the CLI preparation action;
2. navigate only to that exact destination or stable boundary;
3. establish a contiguous visible segment beginning immediately after the boundary, or at the earliest currently visible message when no boundary was requested;
4. read messages in displayed order until it has observed the configured number of qualifying messages, or has reached the end of the currently loaded contiguous segment;
5. preserve exact visible text and stable identities;
6. enumerate displayed attachments in their visible order without opening, downloading, following, or fetching them;
7. submit the private observation batch to the CLI; and
8. stop on login challenges, missing boundaries, virtualized gaps, ambiguous ordering, unstable identities, or any destination mismatch.

“Visible” means content rendered through ordinary channel navigation. The adapter may scroll within the requested channel to make the bounded segment visible, but it may not inspect hidden page state or crawl unrelated or earlier history. When a boundary is supplied, failure to make that exact boundary and the following contiguous segment visible is an error, not permission to start later.

Without a boundary, a snapshot is relative to the earliest message in the contiguous segment the adapter explicitly establishes for that request. It is not represented as complete channel history. Feedback Round integration always supplies a boundary.

## Deterministic parsing rules

The parser rejects invalid limits; all must be non-negative integers and `messageLimit` must be positive. Production Feedback Round callers derive them from `src/constants.ts`, retaining five messages, two selected images per message, and five selected images per round.

For a valid batch the parser:

1. requires exact destination and boundary equality across request, checkpoint, and observation;
2. requires contiguous coverage and unique Stable Message Identities;
3. preserves the observation array as provider order and rejects provider-order ambiguity rather than sorting timestamps;
4. requires attachment indexes within a message to be unique, zero-based, and strictly increasing;
5. considers only `ordinary-text` messages whose visible text is non-empty after trimming;
6. excludes the boundary itself if an adapter erroneously includes it;
7. accepts repeated authors and preserves exact first-observed text and metadata;
8. takes exactly the first `messageLimit` qualifying messages;
9. within those messages only, selects supported attachments in message order and attachment order;
10. applies `attachmentLimitPerMessage` first and then the remaining `attachmentLimitTotal`; and
11. marks the snapshot complete only when exactly `messageLimit` qualifying messages have been accepted.

Attachment-only and system messages do not qualify. Unsupported attachments and supported attachments beyond either configured limit are ignored. No attachment from an ignored, later, or non-qualifying message can be selected.

The parser returns each selected attachment as an `AttachmentSelection` containing the owning Stable Message Identity, displayed attachment index, visible media type, and opaque provider selection value. It does not verify that bytes exist and does not turn a selection into a Participant Reference Image.

## Deduplication and restart semantics

A checkpoint is the entire accepted prefix from the previous snapshot, including every message identity, first-observed field, and selected attachment identity in order. It contains the request destination, boundary or no-boundary segment start, limits, and supported media-type policy used to derive that prefix.

On a rescan:

- an exact previously accepted prefix is reused without mutation;
- repeated observations of a Stable Message Identity count once;
- later messages may append to an incomplete prefix;
- reaching the message limit freezes the snapshot permanently;
- observations after a complete checkpoint cannot change or extend it; and
- no parser execution acquires or reacquires attachments.

The parser fails closed if a rescan inserts a newly discovered qualifying message before the accepted prefix, omits a checkpoint message from otherwise claimed contiguous coverage, changes first-observed text or metadata, changes attachment order or selection values, changes the destination, boundary, limits, or supported-media policy, or presents duplicate identities with conflicting content.

This makes replay deterministic without pretending that a partial browser scan was complete. The caller persists the checkpoint through its own storage-neutral store. Initial Feedback Round integration will store the resulting Captured Messages through `RoundStateStore`; the parser module will not depend on JSON paths or capsule layout.

## CLI contract

Add one CLI action, `parse-conversation`, as a thin adapter over the deterministic parser. It accepts a private JSON payload containing the request, observation batch, and optional checkpoint. It validates the Discord destination against `DiscordChannelAllowlistStore` before parsing.

The command writes the resulting private `ConversationSnapshot` only to a fixed, gitignored runtime handoff owned by the current invocation, with restrictive permissions and atomic replacement. Standard output contains only a controlled envelope:

```json
{
  "action": "wait" | "conversation-complete" | "needs-attention",
  "acceptedMessageCount": 0,
  "selectedAttachmentCount": 0
}
```

It never prints message text, author data, destination or message identities, attachment selection values, URLs, paths, or the private snapshot. The canonical skill may pass the fixed private handoff to the next deterministic command, but must never reproduce it in ChatGPT, Discord, logs, documentation, or review comments.

Preparation of browser navigation remains private and read-only. If implemented as an additional action under the same CLI module, it returns only a controlled action code on standard output and writes destination details to the same restrictive handoff; it is not a second parsing interface.

The CLI does not persist a generic conversation database. Library callers own checkpoint persistence. This keeps the parser independent of Feedback Round state while allowing safe restart through an explicit checkpoint.

## Errors and fail-closed behavior

Expected typed error categories are:

- `ConversationDestinationError`: malformed, non-allowlisted, or mismatched destination;
- `ConversationBoundaryError`: missing, mismatched, or non-contiguous boundary coverage;
- `ConversationOrderError`: duplicate/conflicting identities, ambiguous visible order, or invalid attachment order;
- `ConversationCheckpointError`: a rescan changes an accepted prefix or its policy;
- `ConversationObservationError`: malformed kinds, timestamps, text, media metadata, or opaque selections; and
- `ConversationSourceError`: browser login, navigation, visibility, or extraction failure.

The core has no side effects and throws typed errors. The CLI converts them to `needs-attention` without including raw values in standard output. Feedback Round integration will persist `Needs Attention` through the existing state machine. The skill never automatically retries an uncertain browser observation, because a retry could conceal a changed visible prefix.

No error includes credentials, private identifiers, raw message text, URLs, local paths, DOM fragments, or browser-session details in a user-facing surface.

## Testing seams and TDD

Implementation follows red-green-refactor. The principal public seams are `ConversationSource.observe`, the pure parser interface, the destination normalizer/allowlist resolver, and `parse-conversation`.

Unit and contract tests cover:

- canonical URL, matching channel ID, and `(serverId | "@me", channelId)` inputs normalize identically;
- malformed, server-wide, multi-channel, and non-allowlisted references fail before navigation;
- an optional boundary is exclusive and must have contiguous following coverage;
- no-boundary snapshots describe only their explicitly established visible segment and retain the same segment start across rescans;
- ordinary non-empty text qualifies while system, empty, and attachment-only messages do not;
- repeated authors count and exact text is preserved privately;
- literal first-message order is retained without timestamp sorting;
- duplicate or conflicting stable identities fail closed;
- message, per-message attachment, and total attachment limits are configurable and deterministic;
- attachments are selected only from the accepted qualifying messages;
- selections contain no URL, byte payload, or local path;
- incomplete checkpoints append safely across rescans;
- complete checkpoints remain frozen;
- inserted, omitted, reordered, or changed checkpoint content fails closed;
- policy changes across a checkpoint fail closed;
- a fake `ConversationSource` drives parser tests without a browser;
- the Discord skill contract enforces exact navigation, bounded visible scanning, and forbidden API/credential behavior;
- CLI output contains only controlled counts and actions; and
- private payloads and handoffs use gitignored, restrictive storage and do not appear in snapshots, test diagnostics, or command summaries.

Integration tests use synthetic identities and content only. A supervised browser acceptance test points the adapter at the allowlisted Discord channel, uses a known stable boundary, verifies the first configured qualifying messages and attachment indexes, and confirms that nothing is downloaded or acquired.

## Future adapters

A different agent-controlled browser adapter may implement `ConversationSource` when it can prove the same contiguous coverage, stable identity, and visible ordering contract. The deterministic parser remains unchanged.

A sanctioned Discord bot adapter may be added only after a separate security and authorization decision covering credentials, intents, permissions, rate limits, retention, and deployment. It must still resolve the same allowlisted destination and produce the same provider-neutral observations. A bot adapter does not weaken the existing browser-only POC by merely existing as a future possibility.

Adapters for other conversation providers may introduce their own destination normalization and source implementation. They may reuse the parser only if they can provide stable identities, deterministic order, explicit contiguous coverage, and opaque attachment selections.

## Evaluation

Evaluation occurs only after the independently reviewed parser and clipboard branches have been integrated. It does not add clipboard code, evaluation fixtures, or runtime instrumentation to the initial parser branch.

### Candidates and controlled variables

The previous browser-media-download approach is recorded as failed baseline evidence: it did not return a deterministic, verifiable local file path. It is not a live candidate, is not rerun, and does not participate in the comparison.

The live comparison uses two integrated variants:

1. **Existing parser baseline**: clipboard acquisition plus the existing skill-driven Discord parsing and selection flow.
2. **Reusable parser candidate**: the identical clipboard acquisition implementation plus the reusable `ConversationSource` and deterministic parser described by this spec.

Both variants must use the same clipboard acquirer, image validation, artifact store, browser session, allowlisted channel, message and attachment fixtures, configured limits, scan interval, restart points, and success criteria. Clipboard behavior, retries, validation, and persistence may not be modified between variants. Only the conversation parsing and checkpoint path varies. This isolates the value and failure modes of the reusable parser rather than comparing two acquisition implementations.

### Scenario matrix

Run both variants against the same synthetic or supervised fixtures covering:

- a normal complete five-message round with supported and unsupported attachments;
- a virtualized browser gap between the boundary and a qualifying message;
- a previously observed message edited before completion;
- a previously observed message deleted before completion;
- messages that appear reordered across scans;
- a provider identity that is missing, changes, or collides;
- browser restart and coordinator-process restart at each safe checkpoint;
- a partial checkpoint with fewer than the configured qualifying messages;
- restart after a complete frozen checkpoint; and
- a login interruption before observation, during bounded scrolling, and before the next scan.

Fixtures use synthetic content and identities wherever possible. A supervised Discord run uses private real values only inside the existing governed local workflow; reports never retain or reproduce them.

### Measurements

For every scenario and variant, record only sanitized aggregates and classifications:

- completion: whether the expected terminal or waiting state was reached;
- correctness: expected qualifying-message count, selected-attachment count, and exact synthetic-order match;
- elapsed latency from observation start to the sanitized parser outcome;
- browser action count, separated into navigation, scroll, inspection, and copy actions;
- restart count and whether manual intervention was required;
- duplicate, skipped, or reordered message and attachment counts;
- number and category of fail-closed outcomes; and
- exactly one recovery classification for the first outcome of the run:
  - `automatic`: deterministic local replay or continuation completes without a person and without repeating an uncertain external action;
  - `resume`: the owner must continue the task, after which the stored safe checkpoint proceeds without reconciliation;
  - `needs-attention`: a person must reconcile ambiguous browser or persisted state before work continues; or
  - `terminal`: the scenario ends in a confirmed completed, stopped, or definitive failure state with no further recovery attempted.

The classifications are mutually exclusive. A run that first enters `needs-attention` remains classified `needs-attention` even if later manual reconciliation reaches a terminal state; the later result is captured separately by completion.

Completion and correctness results expose no message text, author data, destination or message identities, attachment selection values, URLs, paths, clipboard contents, or image bytes. For supervised private fixtures, correctness is computed locally against expected hashes or ordinal labels and only the boolean result and aggregate counts are reported.

### Reporting and interpretation

Evaluation state is stored beneath a dedicated gitignored local evaluation root with restrictive permissions and atomic writes. Raw private browser observations, checkpoints, CLI handoffs, clipboard payloads, and artifacts remain in their existing private stores and are never copied into the evaluation report. The report contains only variant names, scenario names from this specification, timestamps or durations, aggregate counts, boolean checks, controlled error categories, and recovery classifications.

The reusable parser is acceptable when it preserves all expected completion and correctness results, introduces no duplicate/skip/reordering regression, classifies every ambiguous edge case fail-closed, and does not increase clipboard copy actions for an identical fixture. Latency and non-copy browser action counts are comparative evidence rather than hard release gates; material regressions require explanation before integration is accepted.

The evaluation report is local evidence, not a committed artifact. Any human-readable summary must remain sanitized and must not include private payloads or identifiers.

## Delivery and integration sequence

1. Implement this design on `feature/discord-conversation-parser` with parser types, deterministic core, Discord destination normalization, CLI action, canonical skill, and tests.
2. Review the parser branch independently. It must not import clipboard acquisition or modify participant-image artifact behavior.
3. Implement and review `feature/clipboard-feedback-acquisition` independently against its own design.
4. Merge the reviewed parser branch first.
5. In a separate integration change, adapt `get-discord-polls` and `round-start` to use the parser snapshot for the active round's five qualifying messages.
6. Connect only the selected opaque attachments from those frozen messages to the reviewed clipboard acquirer. The acquirer remains responsible for bytes, validation, capsule staging, and idempotent `(message identity, attachment index)` reuse.
7. Run the full repository verifier and supervised Discord acceptance flow after integration.

This sequencing prevents the parser interface from inheriting macOS clipboard assumptions and prevents the clipboard branch from defining conversation semantics.

## Acceptance criteria

- One provider-neutral `ConversationSource` seam supports the current Discord browser adapter and test fakes.
- A supplied Discord channel URL, matching channel ID, or server/channel pair must normalize to the sole private allowlist entry before navigation.
- The parser accepts an optional exclusive Stable Message Identity boundary and requires contiguous visible coverage.
- A complete snapshot returns exactly the first configured qualifying messages in deterministic provider order; an incomplete snapshot returns only the accepted prefix.
- Per-message and total attachment limits are configurable, and only attachments belonging to accepted messages are selected.
- Attachments remain opaque selections; no image bytes, URLs, downloads, paths, or acquisition behavior enter this branch.
- Checkpoints make rescans deterministic, deduplicate stable identities, freeze completed snapshots, and reject changed prefixes.
- The CLI and canonical skill do not expose private conversation content or identifiers.
- The current adapter uses only the signed-in agent-controlled browser and never calls Discord APIs or inspects credentials.
- Future adapters can satisfy the same seam without changing parser or Feedback Round domain logic.
- The parser branch remains independent of the clipboard branch until a separately reviewed integration change.
- Automated tests, build, skill validation, and supervised browser acceptance pass.
