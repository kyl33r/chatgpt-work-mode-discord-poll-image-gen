# Continue from Result Implementation Plan

**Spec:** `docs/superpowers/specs/2026-08-26-continue-from-result-design.md`

**Branch:** `feature/continue-from-result`

**Worktree:** `.worktrees/continue-from-result`

## Preconditions

1. Merge the approved `feature/feedback-poll-poc` foundation into `main` and push `main`.
2. Create this branch and worktree from that exact `main` HEAD.
3. Install dependencies and require `npm run verify` to pass before editing.
4. Record the fixed review point as the branch's merge-base with `main`.

## TDD Slice 1: Version 5 lineage state

**Seam:** `JsonRoundStateStore` plus explicit state migration.

1. Add failing tests in `tests/round-state-store.test.ts`, `tests/state-migration.test.ts`, and `tests/round-state.test.ts` for optional `parentRoundId`, strict unknown-key rejection, and v4-to-v5 migration without inferred lineage.
2. Run the focused tests and capture the red failure.
3. Set `ROUND_SCHEMA_VERSION` to `5` in `src/constants.ts`.
4. Extend `RoundState`, `CreateRoundInput`, strict validation, and migration code with optional `parentRoundId`.
5. Run the focused tests until green.

## TDD Slice 2: Copy a Result Image as a new Base Image

**Seam:** `RoundArtifactStore.copyResultAsBase`.

1. Add failing adapter tests in `tests/round-artifact-store.test.ts` for byte-identical copying into the target capsule.
2. Add failing cases for missing/unsupported sources, source and target capsule symlinks, cross-capsule aliases, an existing target Base Image, and source equals target.
3. Extend `RoundArtifactStore` and `JsonRoundArtifactStore` minimally. Keep all layout, realpath, copy, and collision logic inside the adapter.
4. Require an exclusive target file and private file permissions. Never overwrite either capsule.
5. Run the focused adapter tests until green.

## TDD Slice 3: Deterministic continuation preparation

**Seam:** `executeCommand("prepare-continuation")` with fake stores and artifact adapter.

1. Add failing CLI tests for selecting the completed, successful same-channel round with the latest `collectionStartedAt` and round-ID tie-breaker.
2. Add failing cases for an active round, no completed source, refused/failed outcome, missing Result Image, malformed timestamp, and cross-channel history.
3. Implement a domain helper that selects the source from `RoundStateStore.list()` without filesystem knowledge.
4. Add `prepare-continuation` accepting only `{ "roundId" }`. Resolve the channel from the allowlist, copy through `RoundArtifactStore`, create the new round with `parentRoundId`, persist `submitting-base`, and return the existing `post-base-image` contract.
5. Ensure copy failure leaves no new `round.json` and command retry cannot overwrite an existing capsule.
6. Run `tests/cli.test.ts` and `tests/cli-lifecycle.test.ts` until green.

## TDD Slice 4: Continuation skill

**Seam:** project skill validator and explicit/implicit trigger matcher.

1. Add failing expectations for `continue-from-result`, its discovery symlink, `prepare-continuation`, `discord-image-paste`, Base Image confirmation, and `round-start` delegation.
2. Scaffold canonical `skills/continue-from-result/` with `SKILL.md` and `agents/openai.yaml`.
3. Add `.agents/skills/continue-from-result` as a relative symlink only.
4. Update `round-start`, README, Discord setup, domain language, and constants references without duplicating child-skill procedures.
5. Run `tests/skills.test.ts` until green.

## Verification and Integration

1. Run `npm run verify` and `git diff --check`.
2. Run a two-axis branch review against the recorded merge-base using the approved spec and `AGENTS.md`/ADRs.
3. Fix every Critical or Important finding test-first and rerun the review.
4. Commit and push `feature/continue-from-result`.
5. Merge into local `main` with a non-fast-forward merge, rerun `npm run verify`, and push `main`.
6. Do not delete the worktree until the participant-image branch has been created from the updated `main`.
