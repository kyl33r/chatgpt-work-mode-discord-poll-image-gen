# Continue a Feedback Round from the Previous Result

## Status

Approved design pending implementation-plan review.

## Goal

Let the owner start a new Feedback Round from the Result Image of the most recently completed round in the configured Discord channel. The new round remains an isolated state capsule and never mutates, links to, or uploads artifacts from the source capsule directly.

## Scope

This feature adds:

- a storage-neutral continuation command;
- explicit parent-round lineage in durable state;
- a `continue-from-result` project skill and discovery metadata;
- schema migration and lifecycle tests.

It does not add branching histories, arbitrary source selection, cross-channel continuation, database storage, or automatic Discord publication without the host's required action-time confirmation.

## Domain Rules

“Previous” means the completed round in the configured channel with the greatest valid `collectionStartedAt`; the round ID is the deterministic tie-breaker. The source must have a successful Generation Outcome and a validated Result Image.

The new round:

- receives a unique new round ID selected locally;
- records `parentRoundId`;
- copies the source Result Image into its own capsule as its Base Image;
- begins at the existing `submitting-base` boundary;
- follows the existing five-message workflow without special later behavior.

An active nonterminal round prevents continuation. A stopped, needs-attention, refused, failed, missing, malformed, cross-channel, or image-less round cannot be a continuation source.

## Storage and State

Increment the round schema from version 4 to version 5. Add optional `parentRoundId` to `RoundState`; owner-supplied rounds omit it. The v4-to-v5 migration preserves every existing field and adds no inferred lineage.

Extend `RoundArtifactStore` with a storage-neutral operation equivalent to:

```ts
copyResultAsBase(sourceRoundId: string, targetRoundId: string, sourcePath: string): Promise<string>
```

The JSON adapter validates both capsules by real path, rejects symlinks and aliases, requires a supported source image, creates only the target capsule, copies bytes into the target, and returns the target-owned Base Image path. Command and domain code never construct capsule paths.

The command resolves the configured channel through the existing allowlist boundary, selects the source through `RoundStateStore.list()`, copies the artifact, creates the new state, persists `submitting-base`, and returns the existing controlled Base Image post contract. A failed copy must not leave a persisted new round.

## Skill Workflow

Create canonical `skills/continue-from-result/` metadata plus the `.agents/skills/` discovery symlink. It triggers on requests such as “continue from the previous result” and orchestrates:

1. require no active round;
2. run the continuation preparation command with only the new round ID;
3. read and follow `skills/discord-image-paste/SKILL.md`;
4. post the copied Base Image and returned poll-start caption once;
5. confirm the stable boundary through the existing Base Image confirmation command;
6. delegate the remaining lifecycle to `skills/round-start/SKILL.md`.

The skill never reads another capsule directly or prints a source round, private channel, artifact path, or message identity.

## Failure Handling

Selection, channel identity, source outcome, artifact validation, copy completion, and destination containment must be unambiguous before the new state is persisted. Any ambiguity fails without posting. After a Discord send begins, existing `needs-attention` and no-retry rules apply.

## Tests

Use red-green TDD at these public seams:

- state migration and strict schema validation;
- `RoundArtifactStore.copyResultAsBase` byte equality and capsule isolation;
- rejection of source/target symlinks, missing files, unsupported images, and aliases;
- latest-completed same-channel selection and deterministic tie-breaking;
- refusal when no valid source exists or another round is active;
- CLI lifecycle from preparation through Base Image confirmation;
- explicit and implicit skill triggers and required child-skill boundaries.

Run the full repository verifier before review and merge.

## Delivery

Implement in `feature/continue-from-result` in its own worktree. Review the branch against this spec and repository standards, then merge it to `main` before creating the participant-image-context branch.
