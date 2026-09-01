# OpenClaw Discord worker setup

This is the operator runbook for the experimental OpenClaw adapter. It runs the
Feedback Round as a dedicated local Discord bot instead of keeping a ChatGPT
Work browser task open.

## What this profile can do

The named `image-feedback-poc` profile is restricted to one configured Discord
server channel and three project-owned tools:

- start a Feedback Round from the verified current Discord message and its one
  Base Image;
- load the frozen feedback for prompt synthesis; and
- persist the synthesized prompt, generate once, and publish one controlled
  outcome back to that same channel.

The profile disables browser, terminal, shell, filesystem, arbitrary messaging,
native Discord commands, direct messages, scheduling, and the OpenClaw control
UI. It does not share configuration, state, ports, or a service identity with
another OpenClaw profile on the same Mac.

This is process isolation, not hostile isolation from other software running as
the same macOS user. Use a separate OS account or container if that stronger
boundary becomes necessary.

## Prerequisites

- the Discord application and bot have already been created and installed in
  the target server;
- the bot can view the configured channel, read message history, send messages,
  and attach files;
- Message Content Intent is enabled for the bot when Discord requires it;
- exactly one server channel has been configured with the repository's
  `configure-discord-channel` skill or `npm run configure:channel` command;
- dependencies have been installed with `npm install`;
- a supported Node executable is available: Node 22.22+, 24.15+, or 25.9+; and
- the operator can complete OpenAI device-code authentication locally.

The Discord bot token and OpenAI authentication must never be pasted into an
agent chat, committed, logged, or stored in the repository `.env` file.

## 1. Select the supported Node runtime

The Mac's default Node installation does not need to change. In the terminal
used for setup, point this project at an absolute supported executable:

```sh
export OPENCLAW_NODE_BIN="<absolute-path-to-supported-node>"
```

Every command below verifies both the Node version and the exact pinned
OpenClaw package version before doing work.

## 2. Prepare and validate the isolated profile

```sh
npm run openclaw:profile -- prepare
npm run openclaw:profile -- validate
```

`prepare` derives the server and channel only from the private project
allowlist. It writes the OpenClaw configuration to the named profile outside
the repository. The private Discord identifiers are not command arguments and
are not printed.

## 3. Seed the Discord credential locally

Copy the Discord bot token yourself in the Discord developer portal, then in
the same terminal run:

```sh
export DISCORD_BOT_TOKEN="<copied-locally>"
npm run openclaw:profile -- seed-secrets
unset DISCORD_BOT_TOKEN
```

The command creates the named profile's secret file with owner-only
permissions and also creates a random Gateway token. It refuses to overwrite
an existing secret file. Token rotation is therefore an explicit operator
action, not an automatic retry.

## 4. Authenticate image generation

```sh
npm run openclaw:profile -- auth
```

Follow the device-code instructions in the terminal. The resulting provider
authentication belongs to the isolated OpenClaw profile and is not written to
this repository.

## 5. Install and start the managed worker

```sh
npm run openclaw:profile -- security
npm run openclaw:profile -- install
npm run openclaw:profile -- start
npm run openclaw:profile -- status
```

The managed service keeps the Discord connection active after the terminal and
Codex task close. A bot is shown as online only while this Gateway service is
running and connected.

To stop it:

```sh
npm run openclaw:profile -- stop
```

## First supervised round

In the configured channel, any Participant may send a natural-language request
to start a Feedback Round with exactly one PNG, JPEG, or WebP Base Image
attached. For the POC, the bot then:

1. posts the controlled start marker and Base Image;
2. captures the first five qualifying non-empty messages;
3. accepts at most two supported images from each qualifying message and five
   Participant Reference Images for the whole round;
4. wakes the model only when a start decision or frozen synthesis is needed;
5. posts the closed marker with the persisted Synthesized Prompt;
6. performs one image edit; and
7. posts one Result Image, refusal, or failure outcome.

Do not run the browser-mediated round skill against the same channel while this
worker is active. The JSON store permits only one active round, but mixing two
external delivery mechanisms creates avoidable receipt ambiguity.

## Recovery boundary

Ordinary collection is durable: after a clean service restart, later inbound
messages are evaluated against the persisted Round State Capsule. A possibly
completed Discord post, image generation, or image upload is never retried
automatically. Such uncertainty moves the round to Needs Attention and requires
manual reconciliation.

The current POC does not promise autonomous re-dispatch of a model turn that
was interrupted after feedback froze. Keep the first live validation
supervised and treat that restart case as an adoption-gate item before calling
the OpenClaw adapter production-ready.

## Private state ownership

```text
OpenClaw named profile
  credentials, sessions, locks, caches, managed-service configuration

<project>/.state/
  authoritative per-round JSON state and image artifacts

<project>/.runtime/openclaw/
  disposable, secret-free integration workspace
```

All three locations are private local data. Only source, tests, and
documentation belong in Git.
