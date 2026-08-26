---
status: accepted
---

# Store the Discord Channel Allowlist in JSON state

Persist exactly one owner-selected Discord channel URL in gitignored `.state/discord-channel-allowlist.json`. Configure it only through the `configure-discord-channel` skill and `configure:channel` command, which validate a controlled canonical Discord channel page, atomically replace the JSON record, and return no private identifiers. Round commands require the storage-neutral allowlist interface rather than an environment variable, caller payload, or hardcoded URL. Channel configuration and round mutations share one fail-closed workflow lock, and channel changes are rejected while a Feedback Round is nonterminal. A missing allowlist can migrate only through the explicit `migrate:channel-allowlist` command from exactly one trusted legacy active round. A private `0600` migration marker records consumption without storing the URL; after consumption, a missing allowlist never bootstraps again.
