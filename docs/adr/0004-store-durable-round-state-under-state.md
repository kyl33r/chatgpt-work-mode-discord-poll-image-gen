---
status: accepted
---

# Store durable round state under `.state/`

Keep all restart-critical round data beneath the worktree-local, gitignored `.state/` directory: atomic JSON state, Base Images, Result Images, and migration backups. Reserve `.runtime/` for disposable command payloads and results. Continue using JSON behind the `RoundStateStore` boundary until measured concurrency, query, recovery, or performance needs justify a local `.state/rounds.sqlite` database.
