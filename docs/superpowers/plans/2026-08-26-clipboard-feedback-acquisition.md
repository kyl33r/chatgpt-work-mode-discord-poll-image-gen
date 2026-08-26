# Clipboard Feedback Image Acquisition Implementation Plan

**Spec:** `docs/superpowers/specs/2026-08-26-clipboard-feedback-acquisition-design.md`

**Branch:** `feature/clipboard-feedback-acquisition`

**Worktree:** `.worktrees/clipboard-feedback-acquisition`

## Objective

Replace browser attachment downloads with one governed Discord **Copy Image** action per selected attachment and deterministic macOS clipboard ingestion. Preserve the existing parser/collector, active-round boundary, five qualifying messages, two images per message, five images per round, Base-Image-first generation order, and storage-neutral state/artifact interfaces.

This plan is executable without the separate reusable Discord parser branch. Do not merge, cherry-pick, import, or adapt that branch while implementing these tasks.

## Global Constraints

Apply these constraints to every slice:

- Follow red → green vertically: add one behavior-level failing test at an approved public seam, run it to prove the expected failure, implement only enough to pass, then continue with the next case. Do not write an entire test layer before implementation.
- Test public seams only: `executeCommand`, `RoundStateStore`, `RoundArtifactStore`, `FeedbackImageAcquirer`, `ClipboardImageSource`, the macOS adapter contract, evaluation report writer, and the project-skill validator.
- Keep all fixed values, paths, limits, phase names, and controlled output categories in `src/constants.ts`.
- Keep CLI/domain code independent of `.state/rounds/<round-id>/` layout. Only storage adapters construct or resolve capsule paths.
- Accept no caller-supplied clipboard bytes, clipboard change count, destination, candidate image path, CDN URL, Discord URL, or MIME override in prepare/capture commands.
- Operate only on the active round, its recorded Base Image boundary, and attachments belonging to its first five qualifying messages. Retain `FEEDBACK_IMAGE_LIMIT_PER_MESSAGE = 2` and `FEEDBACK_IMAGE_LIMIT_PER_ROUND = 5`.
- Persist copy intent before the browser action. After intent exists, any uncertain outcome becomes `needs-attention`; never automatically invoke **Copy Image** again.
- Reuse accepted `(message identity, attachment index)` artifacts after restart. Never silently omit, overwrite, reorder, redownload, or duplicate a selected image.
- Treat all Discord and clipboard content as private and untrusted. Tests and fixtures must use synthetic values only.
- Never print, log, snapshot, or place in evaluation reports any message text, authors, channel/message URLs, Discord or round identifiers, clipboard bytes, image hashes/dimensions, filenames, artifact paths, wall-clock timestamps, DOM excerpts, or raw platform errors. Existing private durable round state retains only the fields required by its approved schema.
- Persist only controlled failure categories. Leave ambiguous artifacts for manual reconciliation; clean up only definite pre-installation temporary failures.
- Keep evaluation data beneath gitignored `.runtime/evaluations/clipboard-feedback-acquisition/` with private permissions. Evaluation must not retry or rebuild the failed browser-download baseline.
- Do not invoke Discord APIs, bots, webhooks, bare CDN requests, credential inspection, unrelated browser navigation, or background polling.
- Do not change prompt synthesis, generation ordering, Result Image publication, continuation behavior, or the public participant-image limits except where regression tests prove they remain intact.
- End each green slice with `git diff --check`, review the staged diff for private data, and make the named focused commit. Do not combine slices into one catch-all commit.

## Approved Public Command Flow

Use these command seams so the browser skill and deterministic local code have an explicit handoff:

1. `plan-feedback-captures` accepts the active `roundId`, recorded `boundaryMessageUrl`, and the existing structured message observations with attachment indexes/media types but no image paths. It persists the next bounded capture batch and returns only a controlled action plus ordinal/index counts needed to address the already-observed visible attachment.
2. `prepare-feedback-image-capture` accepts only `roundId`, `messageOrdinal`, and `attachmentIndex`. It verifies that this is the next selected tuple, reads the current clipboard change count locally, durably records copy intent, and returns `copy-visible-image` without private identifiers, paths, or the change count.
3. The governed browser skill invokes **Copy Image** once on that exact visible attachment.
4. `capture-feedback-image` accepts only the same tuple. It reads the clipboard locally, requires exactly one change-count advancement and one decodable image item, installs canonical PNG bytes through `RoundArtifactStore`, and persists the accepted receipt.
5. After all selected images in the batch are accepted, the existing `collect-messages` command receives observations without caller-supplied image paths. It resolves paths from the persisted capture batch, validates them through `requireFeedbackImage`, freezes `CapturedMessage.contextImages`, and clears the batch atomically.

Command errors and success results expose controlled action/status fields and aggregate counts only. The skill retains its private in-memory observation to map the returned ordinal/index to the visible Discord attachment.

## Likely File Map

Create:

- `src/clipboard/clipboard-image-source.ts`
- `src/clipboard/macos-clipboard-image-source.ts`
- `src/round/feedback-image-acquirer.ts`
- `src/evaluation/feedback-acquisition-evaluation.ts`
- `scripts/read-macos-clipboard.swift`
- `tests/feedback-image-acquirer.test.ts`
- `tests/macos-clipboard-image-source.test.ts`
- `tests/feedback-acquisition-evaluation.test.ts`

Modify:

- `src/constants.ts`
- `src/cli.ts`
- `src/round/message-collector.ts`
- `src/round/round-artifact-store.ts`
- `src/round/round-state.ts`
- `src/round/round-state-store.ts`
- `src/round/state-migration.ts`
- `tests/message-collector.test.ts`
- `tests/round-artifact-store.test.ts`
- `tests/round-state.test.ts`
- `tests/round-state-store.test.ts`
- `tests/state-migration.test.ts`
- `tests/cli.test.ts`
- `tests/cli-lifecycle.test.ts`
- `tests/skills.test.ts`
- `skills/get-discord-polls/SKILL.md`
- `README.md`
- `docs/discord-setup.md`
- `CONTEXT.md`
- `docs/adr/0008-bounded-participant-image-context.md`

Adjust this list only when the red test demonstrates a narrower existing home. Do not add a generic parser abstraction or touch the parser worktree.

## Preconditions

1. Confirm the current directory is the clipboard worktree and `git branch --show-current` returns `feature/clipboard-feedback-acquisition`.
2. Read `AGENTS.md`, `CONTEXT.md`, the approved spec, ADRs 0002/0004/0006/0007/0008, and `skills/get-discord-polls/SKILL.md` before editing.
3. Require a clean worktree and record the fixed review point:

   ```sh
   git status --short
   git merge-base HEAD main
   ```

4. Install dependencies if needed, then prove the baseline:

   ```sh
   npm run verify
   git diff --check
   ```

5. Record the already-failed browser-download baseline only in the approved spec/evaluation model. Do not repeat the live download action.

## TDD Slice 1: Persist a bounded capture batch in schema version 7

**Public seams:** `executeCommand("plan-feedback-captures")`, `JsonRoundStateStore`, and explicit state migration.

**Files:** `src/constants.ts`, `src/cli.ts`, `src/round/message-collector.ts`, `src/round/round-state.ts`, `src/round/round-state-store.ts`, `src/round/state-migration.ts`, `tests/message-collector.test.ts`, `tests/round-state.test.ts`, `tests/round-state-store.test.ts`, `tests/state-migration.test.ts`, `tests/cli.test.ts`.

1. Add one failing worked-example test proving that existing Captured Messages plus new observations select only the remaining slots among the first five qualifying text messages. Assert literal message ordinals and attachment indexes under two-per-message and five-per-round limits; include attachment-only, unsupported, excess, repeated-author, and post-limit observations.
2. Run the focused test and require the failure to show that no capture plan exists yet:

   ```sh
   npm test -- tests/message-collector.test.ts
   ```

3. Add the smallest selection result needed by `plan-feedback-captures`. Reuse the existing `DiscordMessageObservation` parser and ordering checks; remove the requirement for a caller-supplied `imagePath` from attachment observations used for new acquisition.
4. Add a failing CLI test proving `plan-feedback-captures` rejects the wrong round/boundary, order drift, duplicate identities/indexes, unsupported batch media, inactive phase, and any payload attachment path. Assert that output contains only controlled action and ordinal/index/count fields.
5. Add failing state/migration tests for `ROUND_SCHEMA_VERSION = 7`, optional `FeedbackCaptureBatch`, strict status-specific fields, one in-progress tuple at most, ascending unique ordinals/indexes, cumulative limits, active-round-only validity, and v6→v7 migration with no batch.
6. Implement the minimal schema, validation, migration, event transition, and command. Persist a newly selected batch before returning any copy action.
7. Run until green:

   ```sh
   npm test -- tests/message-collector.test.ts tests/round-state.test.ts tests/round-state-store.test.ts tests/state-migration.test.ts tests/cli.test.ts
   npm run build
   git diff --check
   ```

8. Commit only this green slice:

   ```sh
   git add src/constants.ts src/cli.ts src/round/message-collector.ts src/round/round-state.ts src/round/round-state-store.ts src/round/state-migration.ts tests/message-collector.test.ts tests/round-state.test.ts tests/round-state-store.test.ts tests/state-migration.test.ts tests/cli.test.ts
   git commit -m "feat: persist bounded feedback capture plans"
   ```

## TDD Slice 2: Accept canonical feedback bytes through the artifact boundary

**Public seam:** `RoundArtifactStore.acceptFeedbackImageBytes` and `requireFeedbackImage`.

**Files:** `src/constants.ts`, `src/round/round-artifact-store.ts`, `tests/round-artifact-store.test.ts`.

1. Add one failing adapter test that supplies synthetic valid PNG bytes and expects the deterministic active-capsule destination, fully decodable bytes, and `0600` permissions.
2. Run the focused test and require red:

   ```sh
   npm test -- tests/round-artifact-store.test.ts
   ```

3. Add failing cases one at a time for corrupt/truncated/non-PNG bytes, zero-sized decode, unsafe round ID, invalid ordinal/index, another capsule, symlinked capsule/directory, hard-link alias, pre-existing destination, and simulated staging/rename failure. Assert definite temporary failures are cleaned and unexpected destinations are never overwritten.
4. Extend `RoundArtifactStore` with the byte-oriented operation. In `JsonRoundArtifactStore`, create a private unique temporary file under the owning `feedback-images/` directory, write canonical bytes exclusively, fully decode with Sharp, verify PNG/nonzero dimensions, then atomically rename to `message-<ordinal>-attachment-<index>.png`.
5. Retain `requireFeedbackImage` as the read-side validation seam. Remove the arbitrary browser-staged-path acceptance path only after all callers move in later slices; do not temporarily weaken it.
6. Run until green:

   ```sh
   npm test -- tests/round-artifact-store.test.ts
   npm run build
   git diff --check
   ```

7. Commit:

   ```sh
   git add src/constants.ts src/round/round-artifact-store.ts tests/round-artifact-store.test.ts
   git commit -m "feat: accept clipboard image bytes atomically"
   ```

## TDD Slice 3: Coordinate prepare and capture with a fake clipboard

**Public seams:** `ClipboardImageSource`, `FeedbackImageAcquirer.prepare`, `FeedbackImageAcquirer.capture`, `executeCommand("prepare-feedback-image-capture")`, and `executeCommand("capture-feedback-image")`.

**Files:** `src/clipboard/clipboard-image-source.ts`, `src/round/feedback-image-acquirer.ts`, `src/cli.ts`, `src/round/round-state.ts`, `tests/feedback-image-acquirer.test.ts`, `tests/cli.test.ts`.

1. Create a fake `ClipboardImageSource` only in the test file. Add a failing happy-path test proving `prepare` reads the baseline count, persists `copy-intent-recorded` before returning `copy-visible-image`, and exposes neither the count nor private state.
2. Run and require red:

   ```sh
   npm test -- tests/feedback-image-acquirer.test.ts
   ```

3. Define the interface and implement the minimal `prepare` path through injected `RoundStateStore` and `ClipboardImageSource`. Only the next `selected` tuple is eligible.
4. Add a failing `capture` test with a one-step change count and one synthetic PNG. Assert the service passes bytes to the artifact seam, persists the returned path as `accepted` only after installation, and returns a controlled result without the path.
5. Implement the minimal capture path and command wiring. Commands accept exactly the tuple fields; strict payload parsing rejects bytes, paths, change counts, media types, URLs, and extra keys.
6. Add CLI contract tests that inspect JSON results for forbidden private fields and prove an inactive/mismatched round cannot access the clipboard.
7. Run until green:

   ```sh
   npm test -- tests/feedback-image-acquirer.test.ts tests/cli.test.ts
   npm run build
   git diff --check
   ```

8. Commit:

   ```sh
   git add src/clipboard/clipboard-image-source.ts src/round/feedback-image-acquirer.ts src/cli.ts src/round/round-state.ts tests/feedback-image-acquirer.test.ts tests/cli.test.ts
   git commit -m "feat: coordinate one clipboard feedback capture"
   ```

## TDD Slice 4: Fail closed across ambiguity and restart boundaries

**Public seams:** `FeedbackImageAcquirer` and `executeCommand` with fake stores, fake clipboard, and fake artifact adapter.

**Files:** `src/round/feedback-image-acquirer.ts`, `src/cli.ts`, `src/round/round-state.ts`, `src/round/round-state-store.ts`, `tests/feedback-image-acquirer.test.ts`, `tests/cli.test.ts`, `tests/cli-lifecycle.test.ts`.

1. Add one failing test for each clipboard state, implementing only after each red: unchanged count, over-advanced count, unreadable image, empty pasteboard, multiple image items, and adapter read failure. Each case must persist a controlled `needs-attention` reason and perform no artifact acceptance.
2. Add failing operation-order tests for capture without intent, a second prepare while intent is unresolved, a non-next tuple, duplicate capture, changed batch ordering, and wrong active round.
3. Add restart tests at literal boundaries:

   - before intent: a new invocation may prepare safely;
   - after intent/before copy and after copy/before capture: `needs-attention`, zero repeat browser actions;
   - during staging and after atomic rename/before receipt: `needs-attention`, no overwrite or inferred success;
   - after accepted receipt: `resume`, reuse the required artifact, zero repeat browser actions;
   - after collection: no capture action remains.

4. Implement only the transitions needed for each green case. Persist intent before returning the browser action. Convert raw collaborator failures to controlled categories without printing or persisting their messages.
5. Run until green:

   ```sh
   npm test -- tests/feedback-image-acquirer.test.ts tests/cli.test.ts tests/cli-lifecycle.test.ts
   npm run build
   git diff --check
   ```

6. Commit:

   ```sh
   git add src/round/feedback-image-acquirer.ts src/cli.ts src/round/round-state.ts src/round/round-state-store.ts tests/feedback-image-acquirer.test.ts tests/cli.test.ts tests/cli-lifecycle.test.ts
   git commit -m "feat: fail closed on uncertain clipboard capture"
   ```

## TDD Slice 5: Implement the deterministic macOS pasteboard adapter

**Public seam:** `MacOsClipboardImageSource` through the `ClipboardImageSource` contract.

**Files:** `src/clipboard/macos-clipboard-image-source.ts`, `scripts/read-macos-clipboard.swift`, `tests/macos-clipboard-image-source.test.ts`, `src/cli.ts`, `package.json` only if a focused integration command is necessary.

1. Add platform-independent failing contract tests around an injected native-helper runner. Cover numeric baseline count, exactly `previous + 1`, one image item with multiple representations, canonical PNG bytes, malformed helper protocol, helper failure, zero image items, and multiple image items. Assert raw stderr/stdout is never surfaced.
2. Run and require red:

   ```sh
   npm test -- tests/macos-clipboard-image-source.test.ts
   ```

3. Implement a narrow Swift helper using AppKit `NSPasteboard.general`. It must expose a machine protocol consumed only by the TypeScript adapter, select exactly one pasteboard item decodable as an image, canonicalize it to PNG, and never write a file, log content, or inspect non-image data. Binary image output must be captured in memory and never inherited by the terminal.
4. Implement the TypeScript adapter with an injected process runner for unit tests. Reject unsupported platforms definitively as `terminal`; translate all native failures to controlled categories.
5. Add a Darwin-gated integration test using a generated synthetic image on a uniquely named test pasteboard. Let the native helper accept that pasteboard name only through a test-only injected runner; production always selects the general pasteboard internally. If isolation cannot be guaranteed, skip the live pasteboard mutation and test only the injected runner. Never read, replace, save, restore, or print a person's current clipboard.
6. Wire the macOS adapter into the CLI composition root only after its contract is green.
7. Run until green:

   ```sh
   npm test -- tests/macos-clipboard-image-source.test.ts tests/feedback-image-acquirer.test.ts tests/cli.test.ts
   npm run build
   git diff --check
   ```

8. Commit:

   ```sh
   git add src/clipboard/macos-clipboard-image-source.ts scripts/read-macos-clipboard.swift tests/macos-clipboard-image-source.test.ts src/cli.ts package.json
   git commit -m "feat: read one macos clipboard image deterministically"
   ```

## TDD Slice 6: Hand accepted artifacts to the existing collector

**Public seams:** `executeCommand("collect-messages")`, `prepare-prompt-synthesis`, `prepare-generation`, and the full CLI lifecycle.

**Files:** `src/cli.ts`, `src/round/message-collector.ts`, `src/round/round-artifact-store.ts`, `src/round/round-state.ts`, `tests/message-collector.test.ts`, `tests/cli.test.ts`, `tests/cli-lifecycle.test.ts`, `tests/round-artifact-store.test.ts`.

1. Add a failing lifecycle test that plans two synthetic attachments, prepares/captures each through fakes, then calls `collect-messages` without image paths. Assert literal `CapturedMessage.contextImages` order, private durable paths resolved internally, and capture-batch removal in the same save.
2. Add a text-only failing regression proving no clipboard command or batch is needed and existing collection behavior is unchanged.
3. Add failing cases for an incomplete batch, missing/corrupt accepted artifact, mismatched observation, duplicate/reordered accepted paths, and cumulative limit drift. Each must return/persist `needs-attention` without silently dropping an image.
4. Implement collection handoff minimally. Validate every accepted path through `requireFeedbackImage`; never take a path from the observation payload.
5. Prove prompt preparation still adds the participant-reference instruction only when images exist and generation returns Base Image first followed by the same flattened message/attachment order.
6. Once all new callers use byte acquisition, remove the old `acceptFeedbackImage(...candidatePath)` acquisition method and browser-staged-path CLI behavior. Keep read-side validation.
7. Run until green:

   ```sh
   npm test -- tests/message-collector.test.ts tests/round-artifact-store.test.ts tests/cli.test.ts tests/cli-lifecycle.test.ts tests/synthesized-prompt.test.ts
   npm run build
   git diff --check
   ```

8. Commit:

   ```sh
   git add src/cli.ts src/round/message-collector.ts src/round/round-artifact-store.ts src/round/round-state.ts tests/message-collector.test.ts tests/round-artifact-store.test.ts tests/cli.test.ts tests/cli-lifecycle.test.ts tests/synthesized-prompt.test.ts
   git commit -m "feat: collect accepted clipboard feedback images"
   ```

## TDD Slice 7: Add sanitized evaluation hooks and local reports

**Public seam:** evaluation recorder/report writer injected into `FeedbackImageAcquirer` and CLI orchestration.

**Files:** `src/constants.ts`, `src/evaluation/feedback-acquisition-evaluation.ts`, `src/round/feedback-image-acquirer.ts`, `src/cli.ts`, `tests/feedback-acquisition-evaluation.test.ts`, `tests/feedback-image-acquirer.test.ts`, `tests/cli-lifecycle.test.ts`.

1. Add a failing test with a fake monotonic clock and in-memory report sink. Assert literal allowed fields for completion/correctness counts, phase durations, browser action counts, restart/manual-intervention flags, duplicate/skipped/reordered counts, and one recovery enum: `automatic`, `resume`, `needs-attention`, or `terminal`.
2. Add a failing denylist test that attempts to supply wall-clock time, clipboard bytes/types, hashes, dimensions, filenames, message/author data, URLs, Discord/round IDs, paths, raw errors, and DOM excerpts. The writer must reject the record rather than redact unpredictably.
3. Implement a closed evaluation event schema and injected recorder. Normal production behavior must not depend on successful evaluation recording.
4. Add failing fault-matrix tests for the scenarios in the spec. Assert controlled completion, browser action count, ordering counts, and recovery classification for every row. In particular, unresolved intent is `needs-attention`, accepted-artifact restart is `resume`, pre-intent recovery is `automatic` or `resume` according to invocation boundary, and unsupported host is `terminal`.
5. Implement the local writer beneath the constant for `.runtime/evaluations/clipboard-feedback-acquisition/`. Create directories/files privately and exclusively. Return only completion category plus `reportWritten`; never return or print the path/content. If private creation fails, emit no fallback report.
6. Encode the historical browser-download baseline as a sanitized fixed evaluation fixture/summary only: incomplete, unverifiable, one browser action, manual intervention true, recovery `needs-attention`. Do not execute or implement a downloader.
7. Run until green:

   ```sh
   npm test -- tests/feedback-acquisition-evaluation.test.ts tests/feedback-image-acquirer.test.ts tests/cli-lifecycle.test.ts
   npm run build
   git diff --check
   ```

8. Confirm no evaluation files are tracked:

   ```sh
   git status --short --ignored .runtime/evaluations/clipboard-feedback-acquisition
   git ls-files .runtime
   ```

9. Commit:

   ```sh
   git add src/constants.ts src/evaluation/feedback-acquisition-evaluation.ts src/round/feedback-image-acquirer.ts src/cli.ts tests/feedback-acquisition-evaluation.test.ts tests/feedback-image-acquirer.test.ts tests/cli-lifecycle.test.ts
   git commit -m "feat: record sanitized clipboard acquisition evaluations"
   ```

## TDD Slice 8: Replace the governed browser-download workflow

**Public seam:** project skill validator and full lifecycle contract.

**Files:** `skills/get-discord-polls/SKILL.md`, `tests/skills.test.ts`, `scripts/validate-skills.ts` only if the existing validator cannot express the approved contract, `README.md`, `docs/discord-setup.md`, `CONTEXT.md`, `docs/adr/0008-bounded-participant-image-context.md`, `tests/cli-lifecycle.test.ts`.

1. Add failing skill-contract tests requiring `plan-feedback-captures`, prepare-before-copy, one exact visible **Copy Image**, `capture-feedback-image`, accepted-artifact reuse, active-round five-message scope, retained image limits, and immediate `mark-attention` on ambiguity.
2. Add failing negative contract checks excluding media download, bare CDN fetching, Discord APIs, credentials, arbitrary paths, automatic copy retry, and parser-branch dependencies.
3. Update the canonical `skills/get-discord-polls/SKILL.md` only; do not edit `.agents/skills/` discovery symlinks.
4. Update documentation and ADR 0008 to state that visible browser download has been replaced by clipboard acquisition. Keep private examples and observed failure details out of public documentation except for the sanitized design evaluation baseline.
5. Add/finish a lifecycle contract test proving one browser action is requested per selected image, no browser action for accepted images after restart, and unchanged Base-Image-first generation order.
6. Validate all project skills and focused tests:

   ```sh
   npm test -- tests/skills.test.ts tests/cli-lifecycle.test.ts
   npm run validate:skills
   npm run build
   git diff --check
   ```

7. Commit:

   ```sh
   git add skills/get-discord-polls/SKILL.md tests/skills.test.ts scripts/validate-skills.ts README.md docs/discord-setup.md CONTEXT.md docs/adr/0008-bounded-participant-image-context.md tests/cli-lifecycle.test.ts
   git commit -m "docs: govern clipboard feedback acquisition"
   ```

## Final Verification and Review

1. Run the complete verifier:

   ```sh
   npm run verify
   git diff --check
   ```

2. Run focused privacy and scope scans. Inspect every match; do not paste sensitive matches into chat or review output:

   ```sh
   rg -n "download|cdn|clipboard|copy image|feedbackCapture|imagePath" src tests skills docs scripts
   rg -n "console\.|process\.stdout|process\.stderr" src scripts
   git diff "$(git merge-base HEAD main)" -- . ':!.runtime/**'
   git status --short --ignored .runtime
   ```

3. Confirm from tests and code review that:

   - only the active round and first five qualifying messages can contribute images;
   - two-per-message and five-per-round remain constant-driven;
   - intent is durable before every copy request;
   - unresolved intent never produces an automatic retry;
   - callers cannot provide clipboard data, change counts, destinations, paths, or URLs;
   - accepted artifacts survive restart without duplicate browser actions;
   - staging is private, decoding is complete, rename is atomic, and unexpected files are not overwritten;
   - controlled outputs and evaluation reports contain no private content;
   - the failed browser-download baseline was not rerun or rebuilt;
   - the reusable parser branch is absent from the diff; and
   - Base Image remains first for generation.

4. Run the requested two-axis review from the recorded merge-base: Standards against `AGENTS.md`, project skills, and ADRs; Spec against the approved clipboard design. Fix every Critical or Important finding through a new red → green cycle and rerun all affected focused tests plus `npm run verify`.
5. Ask for code review using the repository's review workflow. Do not merge automatically.
6. After approval, push `feature/clipboard-feedback-acquisition` for integration. Keep the parser branch independent; any future connection requires a separate approved design and plan.
