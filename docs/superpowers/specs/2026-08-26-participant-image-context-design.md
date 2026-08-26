# Participant Images as Feedback Context

## Status

Approved design pending implementation-plan review.

## Goal

Allow each qualifying Discord feedback message to contribute optional image attachments that become ordered visual context for the single image-edit attempt.

## Scope

This feature adds bounded browser acquisition, durable participant-image artifacts, deterministic selection limits, generation context ordering, a public poll disclaimer, schema migration, and tests. It does not accept attachment-only feedback, unsupported media, links in message text, images from messages outside the first configured text slots, or background Discord APIs.

## Configurable Limits

Define all fixed values in `src/constants.ts`:

```ts
export const FEEDBACK_IMAGE_LIMIT_PER_MESSAGE = 2;
export const FEEDBACK_IMAGE_LIMIT_PER_ROUND = 5;
```

`FEEDBACK_MESSAGE_LIMIT` remains `5`. The poll-start caption states that:

- only ordinary non-empty text messages qualify;
- at most the configured number of supported images is accepted from one message;
- at most the configured total is accepted for the round;
- attachments beyond either limit are ignored in Discord arrival and attachment order;
- supported formats are PNG, JPEG, and WebP.

Changing the constants changes both deterministic collection and the public disclaimer.

## Selection Rules

Process messages in visible Discord arrival order. For each of the first five qualifying messages, inspect attachments in their displayed order and select the first supported images that fit both remaining limits. Unsupported attachments and supported attachments beyond either limit are ignored; the qualifying text still counts. Attachment-only messages do not count.

Persist selection before prompt synthesis. A restart must produce the same message and image order without redownloading or duplicating already accepted artifacts.

## Browser Acquisition

Read only visible attachments belonging to the bounded messages in the allowlisted channel. Use the signed-in browser's supported media-download surface against the exact visible attachment; never call Discord APIs, follow message links, inspect credentials, or fetch a bare CDN URL outside that browser context.

Stage each selected download inside the active capsule before `collect-messages`. Validate it as a real PNG, JPEG, or WebP and reject symlinks, path aliases, missing files, and format mismatches. If a selected image cannot be acquired or validated, persist `needs-attention`; do not silently omit it or continue to generation.

## State and Artifact Model

Build this feature from the continuation-enabled `main` and increment the round schema from version 5 to version 6. Extend each `CapturedMessage` with:

```ts
contextImages: Array<{
  attachmentIndex: number;
  imagePath: string;
}>;
```

The v5-to-v6 migration sets `contextImages: []` on existing Captured Messages. Persist participant images beneath the owning Round State Capsule in deterministic filenames under `feedback-images/`. Paths are private durable state.

Extend `RoundArtifactStore` with storage-neutral participant-image acceptance and requirement operations. CLI and domain logic receive validated paths and never construct filesystem layout.

## Prompt and Generation

Text synthesis still incorporates all five Captured Messages. When at least one participant image exists, the persisted Synthesized Prompt includes this deterministic instruction after its required preamble:

`Participant reference images are supporting visual context for the requested edits; keep the Base Image as the edit target.`

The same persisted prompt is posted publicly and passed unchanged to ImageGen. `prepare-generation` returns the Base Image separately from the flattened participant context paths. Invoke ImageGen exactly once with ordered references:

1. Base Image as the edit target;
2. participant images in Captured Message arrival order;
3. attachment order within each message.

No participant attachment is published again unless it appears naturally inside the generated Result Image.

## Failure Handling

Fail closed on a missing scan boundary, ambiguous message order, ambiguous attachment order, invalid selected image, mismatched round, outside-capsule path, symlink, incomplete download, or changed persisted ordering. Never retry an uncertain download, generation, or Discord post automatically. Ignoring attachments beyond documented limits is expected behavior, not an error.

## Tests

Use red-green TDD at these public seams:

- per-message and per-round limit selection with literal expected order;
- attachment-only and unsupported-media behavior;
- restart deduplication by message identity and attachment index;
- strict v5-to-v6 migration and state validation;
- artifact containment, symlink, format, and missing-file rejection;
- CLI collection and generation plans with ordered context paths;
- required prompt instruction only when participant images exist;
- public disclaimer interpolation from constants;
- full lifecycle compatibility for text-only rounds;
- explicit and implicit skill-contract validation.

Run the full repository verifier before review and merge.

## Delivery

After merging `feature/continue-from-result`, create `feature/participant-image-context` from updated `main` in a separate worktree. Review it against this spec and repository standards, merge it to `main`, then run the requested two-axis integration review from the pre-feature main commit through the final `main` HEAD.
