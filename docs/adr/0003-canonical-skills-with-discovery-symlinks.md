---
status: accepted
---

# Keep canonical skills at the project root with discovery symlinks

Keep all project-skill content exclusively under `<project-root>/skills/`, including each `SKILL.md`, metadata, scripts, references, and assets. Retain `.agents/skills/` only as a Codex discovery index containing relative symlinks to those canonical folders, because Codex scans repository `.agents/skills/` locations for skills while `AGENTS.md` guidance alone does not register a root-level `skills/` folder for automatic triggering. See the [Codex skills documentation](https://developers.openai.com/codex/skills/).

## Considered options

- **Use only `skills/` and reference it from `AGENTS.md`: rejected.** Agents could manually follow the instruction, but Codex would lose repository-skill discovery and automatic explicit or implicit triggering.
- **Duplicate each skill under `.agents/skills/`: rejected.** Two editable copies would drift and make it unclear which one is authoritative.
- **Move canonical content beneath `.agents/skills/`: rejected.** This would violate the project's deliberate, user-facing top-level `skills/` structure.

## Consequences

`skills/` is the sole editable source. `.agents/skills/` must contain symlinks only and must never contain copied or independently edited skill content. Root `AGENTS.md` documents this boundary for contributors, while automated validation verifies that every discovery link resolves to its matching canonical skill.
