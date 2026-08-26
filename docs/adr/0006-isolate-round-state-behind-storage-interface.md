---
status: accepted
---

# Isolate each round behind a storage-neutral interface

Keep `RoundStateStore` as the storage-neutral `get`/`list`/`save` boundary and `RoundArtifactStore` as the separate image-validation boundary. Implement JSON first with one Round State Capsule per round beneath `.state/rounds/<round-id>/`. This prevents one round from rewriting another round's JSON or image artifacts while preserving a direct future path to a local SQLite state adapter that implements the same interface. Command and domain code know neither adapter's filesystem root. JSON remains the default until measured concurrency, query, recovery, or performance needs justify SQLite.
