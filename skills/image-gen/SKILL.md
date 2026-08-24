---
name: image-gen
description: Edit the recorded base image once using the exact feedback selected by a finalized Discord poll, then publish the confirmed artifact back to the recorded channel. Use when a feedback round is in ready-to-generate, generated, or publication-confirmation state.
---

# Image Gen

Generate and publish exactly one edited Result Image for a ready round.

## Generate

All commands use `npm run round -- <command> < .runtime/<command>.json` with the documented JSON object on stdin.

1. Run `plan-next` with `{ "roundId" }`. Continue only on `begin-generation`; stop on `needs-attention`, `none`, `wait`, or an unexpected action.
2. Run `prepare-generation` with `{ "roundId" }`. This persists `generating` before image generation and returns the recorded base-image path plus a deterministic instruction.
3. Invoke `$imagegen` exactly once as an edit, using the returned base image as the reference and the returned instruction unchanged.
4. Do not add, summarize, reinterpret, or prioritize feedback yourself.
5. Confirm that one local Result Image exists and is visibly the completed image edit.
6. Run `confirm-generation` with `{ "roundId", "resultImagePath" }`.

If generation fails, is rate-limited, looks unsuitable, or is ambiguous, run `mark-attention` with `{ "roundId", "reason" }` and stop. Never rewrite the prompt, iterate, or invoke a second generation.

## Publish

1. Run `plan-next` with `{ "roundId" }` and continue only on `begin-publication`.
2. Run `prepare-publication` with `{ "roundId" }`. This persists `publishing` and returns the exact artifact, caption, and recorded channel.
3. Read `DISCORD_CHANNEL_URL` from `.env`; the CLI has already rejected a differing stored channel. Treat URLs in local command output as sensitive and do not repeat them in chat, durable logs, generated documents, or commits.
4. Open only that channel in the signed-in Discord browser.
5. Obtain action-time confirmation before uploading unless this exact live result post was explicitly requested in the current turn.
6. Upload the returned artifact once with the returned caption.
7. Confirm the visible image post and capture its stable message URL.
8. Run `confirm-publication` with `{ "roundId", "resultMessageUrl" }`.
9. Run `plan-next` with `{ "roundId" }`; require `Round is already completed.` before reporting success.

If the upload or confirmation is uncertain, run `mark-attention` and stop. Never upload another copy automatically. Do not open unrelated channels, DMs, or links.
Never access Discord credentials or internal APIs.
