# ADR 0008: Use bounded participant images as supporting context

## Status

Accepted.

## Decision

Allow the first configured qualifying text messages to contribute optional PNG, JPEG, or WebP attachments. Selection is deterministic in Discord message and attachment order, with limits owned by `src/constants.ts`: two images per qualifying message and five images for the round.

Selected files are acquired only from exact visible attachments through the signed-in browser, validated by capsule ownership, real-file identity, extension, and file signature, and stored in the owning Round State Capsule. The generation contract lists the Base Image first as the edit target, then participant images as supporting visual context.

## Consequences

- Attachment-only messages remain ineligible and unsupported or excess attachments are ignored as publicly disclosed.
- Missing, ambiguous, incomplete, symlinked, aliased, or format-mismatched selected images pause the round as `needs-attention`.
- The JSON schema advances to version six; version-five Captured Messages migrate with empty `contextImages` arrays.
- A future SQLite state adapter can preserve the same storage-neutral state and artifact interfaces.
