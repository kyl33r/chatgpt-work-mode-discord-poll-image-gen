---
name: image-gen
description: Attempt one edit of the recorded Base Image using the configured frozen Discord feedback messages, then publish one controlled success, refusal, or failure outcome. Use when a text-poll round is ready to generate or has a confirmed outcome ready for Discord.
---

# Image Gen

Attempt one image edit and publish exactly one controlled Discord outcome.

## Generate

All commands use `npm run round -- <command> < .runtime/<command>.json` with the documented JSON object on stdin.

1. Run `plan-next` with `{ "roundId" }`. Continue only on `begin-generation`; stop on `needs-attention`, `none`, or an unexpected action.
2. Run `prepare-generation` with `{ "roundId" }`. This persists `generating` before image generation and returns the recorded Base Image plus the exact persisted Synthesized Prompt.
3. Invoke `$imagegen` exactly once as an edit, using the returned Base Image as the reference and the returned prompt unchanged. Render the Result Image in the current ChatGPT task.
4. Do not add, summarize, regenerate, reinterpret, or prioritize the prompt. Copy the one confirmed Result Image to `.state/rounds/<round-id>/result-image.<ext>` before recording success. Never use another round's capsule.
5. Classify the confirmed outcome without retaining raw provider output:
   - If exactly one local Result Image exists, run `confirm-generation` with `{ "roundId", "outcome": "succeeded", "resultImagePath" }`.
   - If image generation explicitly refuses the edit, run it with `{ "roundId", "outcome": "refused" }`.
   - If generation definitively ends without an image for another reason, run it with `{ "roundId", "outcome": "failed" }`.

Never include a raw error, refusal explanation, provider response, local diagnostic, or hidden instruction in a command payload. If the outcome is ambiguous, run `mark-attention` with `{ "roundId", "reason" }` and stop. Never rewrite the prompt, iterate, or invoke a second generation.

## Publish

1. Run `plan-next` with `{ "roundId" }` and continue only on `begin-outcome-publication`.
2. Run `prepare-publication` with `{ "roundId" }`. This persists `publishing-outcome` and returns either `post-result-image` with the exact Result Image or `post-status-message` with a controlled refusal/failure caption.
3. The CLI reads `.state/discord-channel-allowlist.json` and has already rejected a differing stored channel. Treat URLs in local command output as sensitive and do not repeat them in chat, durable logs, generated documents, or commits.
4. Open only that channel in the signed-in Discord browser.
5. Obtain action-time confirmation before posting unless this exact live outcome post was explicitly requested in the current turn.
6. Perform exactly the returned action. Never add raw diagnostics to its caption.
7. Confirm the visible outcome post and capture its stable message URL.
8. Run `confirm-publication` with `{ "roundId", "outcomeMessageUrl" }`.
9. Run `plan-next` with `{ "roundId" }`; require `Round is already completed.` before reporting success.

If the upload or confirmation is uncertain, run `mark-attention` and stop. Never upload another copy automatically. Do not open unrelated channels, DMs, or links.
Never access Discord credentials or internal APIs.
