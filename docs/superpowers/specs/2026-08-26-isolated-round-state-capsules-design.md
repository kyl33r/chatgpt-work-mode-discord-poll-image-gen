# Isolated Round State Capsules

Status: Approved for implementation on 2026-08-26.

## Purpose

Persist every Feedback Round as an isolated durable unit. Starting or updating one round must never rewrite another round's JSON or image artifacts. Keep behavior and CLI commands independent of the physical store so JSON can later be replaced by SQLite without changing the workflow.

## Storage interface

`RoundStateStore` remains the application-facing boundary:

```ts
interface RoundStateStore {
  get(roundId: string): Promise<RoundState | undefined>;
  list(): Promise<RoundState[]>;
  save(round: RoundState): Promise<void>;
}
```

CLI commands and round-domain modules depend only on this interface. `JsonRoundStateStore` is the first adapter. A future `SqliteRoundStateStore` must implement the same observable contract: unique round identity, deterministic listing, per-round replacement, schema validation, and fail-closed malformed-state handling. Database selection must not change round phases, command payloads, browser boundaries, or public Discord messages.

## JSON layout

Schema version four stores one Round State Capsule per identifier:

```text
.state/
└── rounds/
    ├── <round-id>/
    │   ├── round.json
    │   ├── base-image.<ext>
    │   ├── result-image.<ext>
    │   └── migrations/
    └── <another-round-id>/
        └── ...
```

Each `round.json` contains exactly one schema-version-four `RoundState`, not a shared array. `save(round)` atomically replaces only `.state/rounds/<round-id>/round.json`. `get(roundId)` resolves only that validated identifier. `list()` enumerates capsule directories, validates every present `round.json`, and returns rounds in deterministic identifier order.

A capsule directory may temporarily contain a staged Base Image before its first `round.json` is written. Listing ignores such a directory only when `round.json` is absent; malformed or mismatched JSON fails closed. Round identifiers are restricted to the existing safe filename form and path resolution must remain beneath `.state/rounds/`.

## Round-scoped artifacts

The Base Image and Result Image must resolve beneath the same capsule directory as their owning round. The CLI rejects cross-round paths, parent traversal, and symlink escapes. Disposable command inputs remain beneath `.runtime/` and are never part of durable state.

Completed, stopped, and needs-attention capsules remain persisted. Starting a new round is allowed only when no nonterminal capsule exists, but it never deletes or rewrites terminal capsules.

## Version-three migration

The explicit migration accepts only the current supported shared schema:

```text
.state/rounds.json
.state/base-images/
.state/migrations/
```

It validates the shared schema-three file and exactly one supported active round, stages a complete schema-four capsule in a sibling temporary directory, copies the Base Image and relevant migration backups into that capsule, writes `round.json` with unchanged phase and workflow data, then atomically renames the complete capsule into `.state/rounds/<round-id>/`.

The old shared files remain untouched for recovery. A complete matching destination is recognized as already migrated. Any partial temporary capsule is safe to discard and retry because no destination artifact is visible before the directory rename.

The current live round must remain in `synthesizing-feedback`; migration performs no Discord post, image generation, phase transition, or prompt synthesis.

## SQLite seam

SQLite is deliberately not implemented in this version. If later justified, it may store each `RoundState` as a row or normalized aggregate while image files remain round-scoped local artifacts. Adapter conformance tests must be reusable against both implementations. No caller may inspect JSON paths or rely on file enumeration outside the JSON adapter and migration code.

## Testing seams

Tests exercise public behavior through:

- the `RoundStateStore` contract;
- CLI commands with an injected store;
- round-scoped Base Image and Result Image validation; and
- the explicit schema-three-to-schema-four migration interface.

Required coverage proves:

- saving round B does not modify round A's file or state;
- updating round A changes only A's `round.json`;
- listing survives a new adapter instance and is deterministic;
- duplicate, malformed, mismatched, traversal, and symlink cases fail closed;
- terminal capsules remain after a later round starts;
- artifacts cannot cross capsule boundaries;
- the supported live schema-three round migrates without changing phase or data; and
- failed or interrupted migration leaves no visible partial destination capsule.
