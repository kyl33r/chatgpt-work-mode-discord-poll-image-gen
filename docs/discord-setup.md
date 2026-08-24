# Discord setup for the supervised POC

This POC uses the signed-in Discord web UI. It does not need a bot, webhook, Discord token, or Discord developer application.

## Prepare Discord

1. Choose one private test channel, group DM, or DM.
2. Make sure the participating people can view messages, upload images, create polls, and vote there.
3. Sign into Discord manually in the ChatGPT Work browser.
4. Open the exact target conversation and copy its full `https://discord.com/channels/...` URL.
5. Copy `.env.example` to `.env` and set `DISCORD_CHANNEL_URL` to that URL.

The `.env` file is ignored by Git. Never place a Discord password, token, cookie, browser profile, or other credential in it.

## Prepare the project

From the implementation worktree, install dependencies and verify the local behavior:

```sh
npm install
npm run verify
```

PNG, JPEG, and WebP are supported. Supply the base image in either of these ways:

- attach it to the current ChatGPT conversation; or
- paste the exact Discord message link containing one image in the allowlisted channel.

The skill stages the selected image under gitignored `.runtime/base-images/`. It does not crawl the channel for images, and it rejects ambiguous messages containing multiple images. A bare Discord CDN URL is rejected when it cannot be tied to the allowlisted channel.

## Run one supervised round

1. Invoke `$submit-base-image` with the ChatGPT attachment or exact Discord message link.
2. Let participants reply in the same conversation with `FEEDBACK: <requested change>`.
3. At the deadline, invoke `$get-discord-polls` to publish the exact feedback index and native multi-select poll.
4. End the poll early for a supervised test, or wait for its one-hour duration.
5. Invoke `$get-discord-polls` again to record finalized votes.
6. Invoke `$image-gen` to make one edit and publish one Result Image.

The skills request confirmation at live posting boundaries when required. If Discord login, destination, poll state, image generation, or upload confirmation is ambiguous, the round pauses as `needs-attention` and does not retry automatically.

## Local state and troubleshooting

Round state lives at `.runtime/rounds.json` inside this worktree. It is ignored by Git and contains no credentials.

- Do not delete or hand-edit state during an active round.
- Run `npm run round -- plan-next` with a JSON payload containing the round ID to inspect the next safe action.
- A `needs-attention` round requires manual reconciliation before any external action is repeated.
- Run the full tests after changing a skill or shared command.
