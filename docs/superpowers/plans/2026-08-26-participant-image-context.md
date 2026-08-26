# Participant Image Context Implementation Plan

**Spec:** `docs/superpowers/specs/2026-08-26-participant-image-context-design.md`

**Branch:** `feature/participant-image-context`

**Worktree:** `.worktrees/participant-image-context`

## Preconditions

1. Require `feature/continue-from-result` to be reviewed and merged into `main`.
2. Create this branch and worktree from the updated `main` HEAD.
3. Install dependencies and require `npm run verify` to pass before editing.
4. Record the fixed review point as the branch's merge-base with `main`.

## TDD Slice 1: Configurable limits and public disclaimer

**Seam:** exported constants and the CLI Base Image post contract.

1. Add failing tests for `FEEDBACK_IMAGE_LIMIT_PER_MESSAGE = 2`, `FEEDBACK_IMAGE_LIMIT_PER_ROUND = 5`, and the exact poll-start disclaimer interpolating both limits and supported formats.
2. Add the constants and update `MESSAGE_COLLECTION_INSTRUCTIONS_TEMPLATE` in `src/constants.ts`.
3. Update the Base Image preparation output and run focused CLI tests until green.

## TDD Slice 2: Version 6 captured-image state

**Seam:** `CapturedMessage`, `JsonRoundStateStore`, and explicit state migration.

1. Add failing tests for ordered `contextImages` entries containing `attachmentIndex` and `imagePath`.
2. Add strict failures for negative/non-integer indexes, empty paths, extra keys, duplicate indexes within one message, and total persisted images beyond the configured round limit.
3. Add v5-to-v6 migration tests that insert `contextImages: []` without changing lineage or other fields.
4. Set `ROUND_SCHEMA_VERSION` to `6` and implement the minimal types, validation, and migration.
5. Run state and migration tests until green.

## TDD Slice 3: Deterministic message and attachment selection

**Seam:** `collectMessages` domain function.

1. Extend observation fixtures with ordered attachment candidates and add a literal worked example covering five messages, two images per message, and five total images.
2. Add failing tests for unsupported attachments, attachment-only messages, repeated authors, excess attachments, duplicate rescans, and messages after the frozen limit.
3. Select text messages in existing arrival order. Within each captured message, select the first supported attachments remaining under both limits.
4. Persist stable `attachmentIndex` ordering and ensure rescans cannot add an earlier unobserved image to a frozen message.
5. Run `tests/message-collector.test.ts` until green.

## TDD Slice 4: Participant image artifact boundary

**Seam:** `RoundArtifactStore.acceptFeedbackImage` and `requireFeedbackImage`.

1. Add failing tests for valid capsule-scoped images and private permissions.
2. Add failures for outside-root paths, another round's capsule, symlinks and aliases, missing files, unsupported extensions, and bytes whose PNG/JPEG/WebP signature disagrees with the extension.
3. Implement format detection and deterministic capsule ownership inside the JSON adapter only.
4. Keep CLI and domain code independent of `.state/rounds/` layout.
5. Run artifact tests until green.

## TDD Slice 5: Collection and generation CLI contracts

**Seam:** `collect-messages`, prompt preparation/confirmation, and `prepare-generation`.

1. Add failing parser and lifecycle tests for attachment candidates carrying `attachmentIndex` and capsule-staged paths.
2. Validate selected artifacts through `RoundArtifactStore` before persisting filled collection state.
3. Make `prepare-prompt-synthesis` return private ordered context paths separately from feedback text.
4. Require the deterministic participant-reference sentence in the persisted Synthesized Prompt only when at least one context image exists.
5. Make `prepare-generation` return the Base Image plus flattened context paths in message and attachment order while preserving the exact instruction.
6. Add text-only regression tests proving unchanged behavior.
7. Run CLI, prompt, and lifecycle tests until green.

## TDD Slice 6: Browser and image-generation skills

**Seam:** project skill validator and trigger matcher.

1. Add failing skill-contract checks requiring the two constants, public disclaimer, visible-attachment acquisition, supported-media filtering, bounded download order, fail-closed acquisition, and Base-Image-first generation order.
2. Update `get-discord-polls` to download only selected visible attachments through the supported signed-in browser media surface and stage them in the active capsule.
3. Update `image-gen` and `round-start` to pass the Base Image first and ordered participant images afterward in one `$imagegen` invocation.
4. Update README, Discord setup, domain language, and relevant ADR documentation.
5. Run skill tests until green.

## Verification and Integration

1. Run `npm run verify` and `git diff --check`.
2. Run a two-axis branch review against the recorded merge-base using the approved spec and `AGENTS.md`/ADRs.
3. Fix every Critical or Important finding test-first and rerun the review.
4. Commit and push `feature/participant-image-context`.
5. Merge into local `main` with a non-fast-forward merge, rerun `npm run verify`, and push `main`.
6. Run the requested final two-axis integration review from the pre-feature foundation commit through final `main` HEAD and report both axes separately.
