---
status: accepted
---

# Use local JSON state before SQLite

Persist POC round state atomically in the worktree-local, gitignored `.runtime/rounds.json` behind a `RoundStateStore` boundary. JSON keeps the first implementation inspectable and dependency-light; migrate to local `.runtime/rounds.sqlite` only after concurrent writers, transactional recovery, substantial querying, or measured file-performance problems demonstrate that JSON is no longer sustainable.

Both stores remain local and must never contain Discord passwords, tokens, cookies, browser-profile data, or OpenAI credentials.
