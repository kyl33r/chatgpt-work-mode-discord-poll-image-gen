# Clipboard Feedback Image Acquisition

## Status

Approved design, ready for implementation planning.

## Goal

Replace the unreliable browser media-download step for Participant Reference Images with one exact **Copy Image** action against each selected visible Discord attachment and a deterministic macOS clipboard reader. The resulting image must become a private, validated artifact in the owning Round State Capsule without exposing clipboard bytes, Discord content, private identifiers, or local paths.

## Scope

This change affects only acquisition of Participant Reference Images during an active Feedback Round. It preserves the existing Text Poll, prompt synthesis, generation, publication, and storage-neutral state/artifact boundaries.

The collector still considers only:

- the allowlisted Discord channel recorded for the active round;
- visible messages after that round's recorded Base Image boundary;
- the first `FEEDBACK_MESSAGE_LIMIT` qualifying ordinary non-empty text messages;
- attachments belonging to those qualifying messages;
- at most `FEEDBACK_IMAGE_LIMIT_PER_MESSAGE` supported images per message; and
- at most `FEEDBACK_IMAGE_LIMIT_PER_ROUND` supported images for the round.

The retained values are five messages, two images per message, and five images per round. Selection remains Discord message order followed by displayed attachment order. Attachment-only messages do not qualify. Unsupported and excess attachments are ignored as already disclosed publicly.

This feature does not add Discord APIs, bot credentials, CDN fetching, arbitrary clipboard import, background monitoring, cross-round acquisition, image publication, or a reusable Discord conversation parser. The parser is a separate branch and design.

## Architecture

The browser and local halves form one governed acquisition operation but have separate responsibilities:

1. The `get-discord-polls` skill owns signed-in browser navigation, visible-message observation, deterministic selection, and the single **Copy Image** action on the exact selected attachment.
2. A clipboard acquisition application service coordinates durable intent, the expected clipboard change token, restart behavior, and the next permitted action.
3. `ClipboardImageSource` is a narrow platform seam. Its macOS adapter reads `NSPasteboard.general.changeCount`, requires one unambiguous image item after a copy, decodes it, and emits canonical PNG bytes without logging them.
4. `RoundArtifactStore` owns private staging, full image decoding, destination naming, containment checks, permissions, and atomic installation in the active capsule.
5. `RoundStateStore` persists the message/attachment selection and acquisition receipt before the normal collection transition. This prevents a restart from copying an already accepted attachment again.

The browser skill never receives a caller-selected destination. The clipboard reader never receives a filesystem path. CLI and domain code do not construct `.state/rounds/<round-id>/` paths; only the JSON artifact adapter knows that layout.

### Clipboard image semantics

Before the browser copy, the local adapter records the current integer pasteboard change count. The intent is persisted before the browser performs the external action. After the single copy, capture succeeds only when the pasteboard change count is exactly the recorded count plus one.

The pasteboard must contain exactly one item that AppKit can decode as an image. Multiple image items, no image item, an unreadable image, or any additional change-count advancement is ambiguous and fails closed. Multiple representations of the same single pasteboard item are not separate images: the adapter decodes that item once and emits canonical PNG bytes. Canonicalization avoids trusting a browser-provided filename or extension and gives the artifact boundary one deterministic format to validate.

Clipboard text, filenames, URLs, and non-image representations are ignored and never returned. The adapter returns bytes and the observed change count only in memory. It writes no files and emits no diagnostic payload containing clipboard content.

## State and Interfaces

The round schema advances from version 6 to version 7. Version-6 rounds migrate with no acquisition in progress. Existing `CapturedMessage.contextImages` data remains unchanged.

Add one optional active-round acquisition record. Conceptually:

```ts
interface FeedbackCaptureBatch {
  boundaryMessageUrl: string;
  messages: Array<{
    messageUrl: string;
    messageOrdinal: number;
    selectedAttachments: Array<{
      attachmentIndex: number;
      mediaType: "image/png" | "image/jpeg" | "image/webp";
      status: "selected" | "copy-intent-recorded" | "accepted";
      expectedClipboardChangeCount?: number;
      imagePath?: string;
    }>;
  }>;
}
```

The concrete schema must retain the existing strict validation style: reject extra keys, invalid ordinals or indexes, duplicate message identities, duplicate attachment indexes, order changes, unsupported media types, limits above the configured values, mismatched boundaries, and accepted entries without a valid artifact path. A batch is valid only while its round is in `collecting-messages`.

The batch stores the minimum restart-critical identity and ordering data. Raw message text and author metadata continue through the existing Captured Message flow and are not duplicated merely for acquisition. When `collect-messages` durably incorporates the batch into `CapturedMessage.contextImages`, it clears the batch in the same state transition.

Use narrow public seams equivalent to:

```ts
interface ClipboardImageSource {
  getChangeCount(): Promise<number>;
  readSingleImage(previousChangeCount: number): Promise<{
    observedChangeCount: number;
    pngBytes: Uint8Array;
  }>;
}

interface FeedbackImageAcquirer {
  prepare(request: {
    roundId: string;
    messageOrdinal: number;
    attachmentIndex: number;
  }): Promise<{ action: "copy-visible-image" }>;

  capture(request: {
    roundId: string;
    messageOrdinal: number;
    attachmentIndex: number;
  }): Promise<{ action: "captured" | "needs-attention" }>;
}
```

`prepare` validates that the requested tuple is the next selected, unaccepted attachment, records the current change count as durable copy intent, and returns no Discord identity, private path, or clipboard value. `capture` accepts no image bytes, destination, path, MIME type, URL, or change token from its caller. It resolves all of those facts through persisted state and injected local interfaces.

Extend the artifact boundary with an operation equivalent to:

```ts
acceptFeedbackImageBytes(
  roundId: string,
  messageOrdinal: number,
  attachmentIndex: number,
  pngBytes: Uint8Array
): Promise<string>;
```

The JSON adapter creates a private temporary file in the owning capsule, writes with restrictive permissions, fully decodes the candidate with Sharp, verifies PNG format and nonzero dimensions, and atomically renames it to the existing deterministic `feedback-images/message-<ordinal>-attachment-<index>.png` destination. It rejects symlinks, hard-link aliases, another round's capsule, pre-existing unexpected destinations, incomplete writes, and failed decoding. The returned private path is persisted but never printed.

`requireFeedbackImage` remains the durable read-side validation seam used by collection and generation. The old browser-staged-path acquisition contract is removed from the skill and CLI; arbitrary candidate paths are no longer accepted for newly copied Discord feedback.

## Data Flow

1. `plan-next` and the stored channel allowlist establish the one active round. The skill opens only its recorded Base Image post.
2. The skill observes visible Discord messages after that exact boundary in displayed order. Together with already persisted Captured Messages, it identifies the round's first five qualifying ordinary non-empty text messages. A scan may contribute only the next not-yet-persisted messages; it can never insert a message before or replace a Captured Message. It selects supported attachments belonging only to those five slots, applying two-per-message and five-per-round limits cumulatively across prior scans.
3. Local validation compares the observation with persisted Captured Messages and any active capture batch. A new batch is persisted before acquisition. A rescan must match its message identities, attachment indexes, media types, and order exactly.
4. For the next selected attachment, `prepare` reads the current pasteboard change count and persists `copy-intent-recorded` before returning `copy-visible-image`.
5. The browser skill locates that exact already-observed visible attachment and invokes **Copy Image** exactly once. It does not download, open a media URL, follow a message link, or inspect browser credentials.
6. `capture` requires the change count to have advanced exactly once and requires one decodable clipboard image item. It passes canonical PNG bytes directly to `RoundArtifactStore`.
7. The artifact adapter stages privately, fully decodes, and atomically installs the deterministic file. Only after installation succeeds does round state mark the tuple `accepted` with its private artifact path.
8. Steps 4–7 repeat for each newly selected attachment. Already accepted `(message identity, attachment index)` pairs reuse their persisted artifacts and are never copied again.
9. Once every selected image in the batch is durable, the existing `collect-messages` behavior freezes the messages and their ordered `contextImages`. Generation continues to receive the Base Image first and the flattened Participant Reference Images afterward.

No step reads messages outside the active round's five qualifying slots. Reaching the round-wide image limit stops attachment selection even if later qualifying messages contain images.

## Restart and Exactly-Once Browser Behavior

The clipboard itself is ephemeral, so exactly-once means “never automatically repeat a browser copy whose completion is uncertain,” not transactional exactly-once delivery across macOS and Discord.

- `selected`: safe to call `prepare`; no browser side effect has begun.
- `copy-intent-recorded`: the copy may have happened. A restart or any failure in this state becomes `needs-attention`; automation must not call **Copy Image** again.
- `accepted`: require the deterministic artifact and reuse it. Never copy again.

If the process stops after atomic artifact installation but before the accepted receipt is persisted, the existing deterministic destination is evidence of an uncertain partially completed operation, not permission to infer success. The round enters `needs-attention` for manual reconciliation. This conservative rule prevents accidental substitution or duplication.

## Failure Policy

Persist `needs-attention` and stop immediately for any of the following:

- the Base Image boundary is missing or differs from the active round;
- message or attachment order is ambiguous or changes after selection;
- the observed selection differs from the persisted batch;
- the exact attachment can no longer be identified visibly;
- the clipboard change count is unchanged, advances by more than one, or cannot be read;
- the pasteboard has zero or multiple image items;
- AppKit or Sharp cannot fully decode the image;
- a capture is invoked without matching durable copy intent;
- a selected artifact is missing, symlinked, aliased, outside its capsule, pre-existing unexpectedly, or otherwise invalid;
- the process restarts with a copy intent whose outcome was not durably accepted; or
- the round, channel, message ordinal, attachment index, media type, or configured limit does not match persisted state.

The workflow never silently omits a selected image and never automatically retries **Copy Image**, clipboard capture, artifact installation after ambiguity, generation, or Discord posting. Unsupported and excess attachments are intentionally ignored before selection and do not cause attention.

Failures return only controlled reason categories. Command output, logs, tests, documentation, and review comments must not contain clipboard bytes, captured text, author data, message/channel URLs, Discord identifiers, artifact paths, pasteboard contents, or raw platform errors. Temporary files are removed after definite pre-installation failures when safe; uncertain or unexpectedly pre-existing artifacts are left for manual reconciliation rather than overwritten.

## Governed Skill Changes

`skills/get-discord-polls/SKILL.md` remains the authority for the browser portion. Update it to replace every visible-media-download instruction with the prepare/copy/capture protocol. The skill must explicitly require:

- active-round and allowlist checks before navigation;
- selection from only the five qualifying messages after the recorded boundary;
- exact message and attachment order with the retained limits;
- one **Copy Image** action only after durable intent;
- no automatic repeat after copy begins;
- no download surface, CDN request, Discord API, credential access, or unrelated browsing; and
- immediate `mark-attention` behavior for any uncertain selection or clipboard outcome.

The ordinary repository code does not automate the signed-in Discord UI. The browser action remains governed because it depends on visible state and the host browser session. Deterministic local code owns everything after that explicit UI action.

## TDD Seams

Implement with red-green-refactor at these public seams:

- `ClipboardImageSource` fakes for unchanged, exactly-once, over-advanced, empty, multiple-item, and undecodable clipboard states;
- a Darwin-only adapter integration test using a generated local image placed on a test pasteboard, with no private clipboard data printed;
- selection tests proving literal message/attachment order, five qualifying messages, two-per-message, five-per-round, unsupported-media filtering, and attachment-only exclusion;
- state migration and strict validation for capture batches, status transitions, duplicate tuples, order drift, and limits;
- acquisition service tests proving intent is persisted before the copy action is returned, only the next tuple can be captured, accepted tuples are reused, and an unresolved intent cannot be prepared again;
- artifact tests for private temporary staging, full Sharp decoding, atomic rename, deterministic filename, `0600` files, capsule containment, symlinks, aliases, pre-existing destinations, and cleanup;
- CLI contract tests proving no arbitrary paths or bytes are accepted and no private values appear in output;
- restart tests at every boundary: before intent, after intent, after artifact installation, after accepted receipt, and after collection persistence;
- skill-contract tests proving exact selection, one-copy behavior, no-download language, fail-closed handling, and the existing generation order; and
- the full text-only and participant-image round lifecycle suites.

The Darwin integration test may be skipped on non-macOS hosts; all domain, service, storage, CLI, and skill-contract tests remain platform-independent. Run the full repository verifier before handoff.

## Evaluation

### Fixed baseline

The browser media-download approach has already failed in the current environment. The exact visible attachment was identified and the browser action completed, but the workflow received no verifiable local path and could not prove that a durable artifact existed. The round therefore entered `needs-attention`.

Treat that result as the fixed baseline. Evaluation must not automatically retry the download, reconstruct it with a CDN fetch, or rebuild a second download implementation. The baseline is recorded as incomplete, unverifiable, one browser acquisition action, manual intervention required, and recovery classified as `needs-attention`.

### Live candidate

The one live candidate is the clipboard acquisition protocol in this design combined with the repository's existing Discord message parser and collector. It uses the existing visible-message observations, selection rules, and `collect-messages` boundary; it does not import, merge, depend on, or evaluate the reusable parser branch.

Live evaluation is permitted only against the active round and the allowlisted channel under the same privacy and no-retry rules as production behavior. A candidate run is not permission to repeat an uncertain **Copy Image** action or alter the five-message, two-per-message, or five-per-round limits.

### Sanitized measurements

Add measurement hooks around the application-service and artifact boundaries, not around raw Discord or clipboard content. Each scenario records only:

- completion and correctness: controlled outcome category, expected selected-image count, accepted-artifact count, successful full-decode count, and a boolean that accepted ordinal/index order matched the persisted selection;
- latency: monotonic durations for preparation, the browser-action interval, clipboard read/decode, artifact validation/install, collection handoff, and total elapsed time;
- browser work: count of **Copy Image** actions and count of other browser acquisition actions, which must remain zero;
- restart and intervention: restart count, whether a clean resume occurred, whether manual intervention was required, and the state boundary at which interruption occurred;
- ordering integrity: counts of duplicate, skipped, and reordered artifacts, all expected to be zero; and
- recovery classification: exactly one of `automatic`, `resume`, `needs-attention`, or `terminal`.

Recovery classifications have fixed meanings:

- `automatic`: the current invocation completed normally or handled a definite fault without a restart, a human decision, or repetition of an uncertain browser action;
- `resume`: a later invocation continued from durable state without repeating an uncertain browser action, such as reusing an already accepted artifact;
- `needs-attention`: external or durable state is ambiguous and a person must reconcile it before any further acquisition;
- `terminal`: the environment definitively cannot support the candidate, or a definitive non-ambiguous failure ends evaluation without a safe continuation path.

Hooks use scenario codes, phase names, counts, booleans, enums, and monotonic durations only. They must not record wall-clock timestamps, clipboard bytes or types beyond the controlled result category, image hashes, dimensions, filenames, message text, author data, URLs, Discord identifiers, round identifiers, local paths, raw errors, or browser DOM excerpts.

### Fault scenarios

Exercise at least these cases with fakes or local generated images before any bounded live run:

- one valid selected image and multiple valid selected images in deterministic order;
- unsupported and excess attachments, including enforcement of both retained image limits;
- unchanged, over-advanced, unreadable, empty, and multiple-image-item pasteboards;
- the browser copy control missing, the selected visible attachment becoming ambiguous, and message or attachment order changing after selection;
- interruption before intent, after intent but before copy, after copy but before capture, during private staging, after atomic rename but before the accepted receipt, after the receipt but before collection, and after collection;
- restart with a selected entry, unresolved copy intent, accepted artifact, and fully collected batch;
- missing, corrupt, symlinked, aliased, outside-capsule, and unexpectedly pre-existing artifacts; and
- unsupported host platform or unavailable pasteboard access.

Assertions must cover completion, browser action count, duplicate/skipped/reordered counts, and the expected recovery classification for every scenario. In particular, any interruption after durable copy intent and before durable acceptance is `needs-attention`; accepted artifacts resume without another browser action; failures before intent may resume safely; and a definitively unsupported host is `terminal`.

### Evaluation report handling

Write machine-readable event records and aggregate summaries only beneath `.runtime/evaluations/clipboard-feedback-acquisition/`, which is already covered by the repository's gitignored `.runtime/` rule. Reports must use private file permissions and the sanitized fields above. They must never be copied into source-controlled documents, commits, test snapshots, command output, or chat.

Evaluation commands return only a controlled completion category and report-written boolean. They do not return the report path or its contents. A report that cannot be created privately causes evaluation to stop without emitting measurements elsewhere.

## Delivery

Implement this design only on `feature/clipboard-feedback-acquisition` in its dedicated worktree. The implementation plan should use vertical TDD slices in this order:

1. schema-v7 capture intent and restart invariants;
2. `ClipboardImageSource` and its fake;
3. private byte-oriented artifact acceptance;
4. acquisition service and CLI contracts;
5. macOS pasteboard adapter and gated integration test;
6. `get-discord-polls` workflow and skill-contract updates; and
7. full lifecycle verification, privacy review, and two-axis code review.

Do not merge or couple the reusable Discord conversation parser branch into this worktree. After both branches are reviewed independently, their integration, if desired, requires a separate explicit design decision because both may touch observation and skill boundaries.
