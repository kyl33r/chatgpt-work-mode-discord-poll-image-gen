# Discord setup for the supervised POC

This POC uses the signed-in Discord web UI. It does not need a bot, webhook, Discord token, or Discord developer application.

## Agent-host prerequisites

ChatGPT Work in the ChatGPT desktop app is the validated reference host for this POC. The host must give the agent direct control of an authenticated browser and local access to this repository. Opening Discord in an ordinary browser tab is not sufficient if the agent cannot inspect the visible page, navigate to the allowlisted channel, paste or upload images, read bounded messages and attachments, and verify the resulting posts.

An equivalent environment from another model or provider—including a Claude Cowork or Gemini-based environment—may be adapted when it supplies the same browser-control, local-filesystem, durable-state, image-editing, and confirmation capabilities. These names are examples of possible host categories, not a guarantee of current compatibility.

Before using another host, verify that it can:

1. use a persistent browser profile and let the owner sign into Discord manually without exposing credentials;
2. open the privately stored allowlisted channel from a fresh browser state;
3. inspect visible Discord messages and attachments without Discord tokens or internal APIs;
4. paste or upload the Base Image and Result Image and confirm the stable posted message;
5. download selected visible attachments into the owning Round State Capsule;
6. read and execute the canonical project skills under `skills/`;
7. read and update the worktree-local, gitignored `.state/` records;
8. edit images using the Base Image first and Participant Reference Images as ordered supporting context;
9. remain active during supervised polling or resume deterministically from durable state; and
10. stop for confirmation or enter `needs-attention` whenever an external action is ambiguous.

Until that compatibility test passes, treat the alternate host as unsupported and do not perform live Discord side effects with it.

## Prepare Discord

1. Choose one private test channel, group DM, or DM.
2. Make sure the participating people can view messages, upload images, create polls, and vote there.
3. Sign into Discord manually in the ChatGPT Work browser.
4. Open the exact target conversation in the in-app browser.
5. Ask Codex to use `$configure-discord-channel` for the currently opened channel.

The skill verifies the controlled browser tab and atomically stores exactly one private URL in gitignored `.state/discord-channel-allowlist.json`. It never prints or commits the URL. Never place a Discord password, token, cookie, browser profile, or other credential in the project.

## Prepare the project

From the implementation worktree, install dependencies and verify the local behavior:

```sh
npm install
npm run verify
```

PNG, JPEG, and WebP are supported. Supply the base image in either of these ways:

- attach it to the current ChatGPT conversation; or
- paste the exact Discord message link containing one image in the allowlisted channel.

The skill stages the selected image inside its gitignored `.state/rounds/<round-id>/` capsule. It does not crawl the channel for images, and it rejects ambiguous messages containing multiple images. A bare Discord CDN URL is rejected when it cannot be tied to the allowlisted channel.

## Run one supervised round

1. Invoke `$round-start` with the ChatGPT attachment or exact Discord message link.
2. Let any participants post ordinary non-empty text after the Base Image boundary. No prefix is required and repeated authors count.
3. Keep the supervised task active for bounded scans until the configured five-message limit is reached. Skills are not background listeners; ending the task pauses collection until the owner resumes it or separately approves a background service.
4. Confirm the returned closed-marker post containing the sanitized final prompt; later messages no longer count.
5. Let `$round-start` invoke `$imagegen` here exactly once using that persisted prompt.
6. Publish exactly one controlled outcome: the Result Image, sanitized refusal, or sanitized failure status.

The skills request confirmation at live posting boundaries when required. If Discord login, destination, poll state, image generation, or upload confirmation is ambiguous, the round pauses as `needs-attention` and does not retry automatically.

## Local state and troubleshooting

Restart-critical state lives inside this worktree. `.state/discord-channel-allowlist.json` owns the single private destination, while isolated `.state/rounds/<round-id>/` capsules own each round's `round.json`, Base Image, Result Image, and migration backups. All are ignored by Git and contain no credentials. `.runtime/` contains only disposable command payloads.

- Do not delete or hand-edit state during an active round.
- Channel changes are locked until every round is terminal.
- For the one pre-allowlist active round only, run `npm run migrate:channel-allowlist`; later missing configuration must be restored explicitly with the configuration skill.
- Run `npm run round -- plan-next` with a JSON payload containing the round ID to inspect the next safe action.
- A `needs-attention` round requires manual reconciliation before any external action is repeated.
- Run the full tests after changing a skill or shared command.
