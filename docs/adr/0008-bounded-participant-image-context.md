# ADR 0008: Use bounded participant images as supporting context

## Status

Accepted.

## Decision

Allow the first configured qualifying text messages to contribute optional PNG, JPEG, or WebP attachments. Selection is deterministic in Discord message and attachment order, with limits owned by `src/constants.ts`: two images per qualifying message and five images for the round.

Selected files are acquired only from exact visible attachments through the signed-in browser. The former browser-download workflow is replaced by a clipboard protocol: persist intent, perform exactly one visible **Copy Image** action, decode and validate the clipboard image, then atomically install it in the owning Round State Capsule. The workflow accepts no caller-supplied path, CDN fetch, Discord API access, credential access, or automatic retry after copying begins. Accepted artifacts are reused after restart without another browser action. The generation contract lists the Base Image first as the edit target, then participant images as supporting visual context.

## Consequences

- Attachment-only messages remain ineligible and unsupported or excess attachments are ignored as publicly disclosed.
- Missing, ambiguous, incomplete, symlinked, aliased, or format-mismatched selected images pause the round as `needs-attention`; an unresolved copy intent is never retried automatically.
- The JSON schema advances to version seven; version-six rounds migrate without a capture batch, while previously captured message image references remain unchanged.
- A future SQLite state adapter can preserve the same storage-neutral state and artifact interfaces.
