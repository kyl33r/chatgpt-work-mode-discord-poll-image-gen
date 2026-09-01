# OpenClaw messaging-agent POC design

Date: 2026-09-01

Status: Approved for implementation

## Purpose

Replace browser-mediated Discord polling with a continuously running,
LLM-directed messaging runtime while retaining deterministic policy
enforcement. OpenClaw supplies the first messaging and agent-runtime adapters;
it does not become the Feedback Round domain model or state owner.

The POC proves that a Participant can start and complete a Feedback Round from
an allowlisted Discord channel without returning to a Codex or ChatGPT task.

## Goals

- Accept natural-language round requests and Base Images from Discord.
- Let an LLM select only bounded Feedback Round tools.
- Collect ordinary feedback without one LLM request per Captured Message.
- Reuse the existing domain engine, storage interfaces, and isolated Round
  State Capsules.
- Post the controlled closed marker, persisted Synthesized Prompt, and one
  Generation Outcome to the originating allowlisted channel.
- Keep OpenClaw replaceable by another messaging or agent runtime.
- Keep this Gateway isolated from other OpenClaw profiles on the Mac.

## Non-goals

- Forking or modifying OpenClaw core.
- Exposing a general-purpose personal assistant in Discord.
- Enabling shell, filesystem, browser, GitHub, session-spawning, scheduling,
  or arbitrary messaging tools.
- Supporting public or mutually adversarial Discord servers.
- Migrating JSON state to SQLite.
- Treating LLM conversation memory as durable workflow state.
- Adding Slack, Telegram, or a second agent runtime during this spike.

## Architecture

```text
Discord
   |
   v
OpenClaw Discord channel adapter
   |
   v
OpenClaw agent runtime and plugin hooks
   |
   v
ImageFeedbackRoundPlugin
   |
   v
FeedbackRoundCoordinator
   |              |                 |
   v              v                 v
RoundStateStore  RoundArtifactStore  ImageGenerator
   |              |                 |
   +-------- existing deterministic domain --------+
                                      |
                                      v
                         controlled Discord delivery
```

OpenClaw supplies two logical adapter responsibilities:

1. The OpenClaw message normalizer and round bridge convert inbound message and media facts
   into the repository's normalized messaging interface and delivers controlled
   outbound outcomes.
2. The OpenClaw plugin adapter exposes three bounded tools to one configured LLM and
   converts tool calls into coordinator commands.

`FeedbackRoundCoordinator` is the deep module. It hides admission, lifecycle,
locking, idempotency, storage, attachment validation, prompt synthesis,
generation intent, publication intent, and recovery behind a small interface.
OpenClaw cannot directly write round files or invoke an image provider.

## Public seams

These are the proposed implementation and TDD seams. Written-spec approval
confirms them before the first behavior test is added.

### Normalized inbound message

```ts
interface InboundMessage {
  provider: "discord";
  destination: OpaqueDestination;
  messageId: OpaqueMessageId;
  senderId: OpaqueSenderId;
  occurredAt: string;
  text: string;
  attachments: readonly InboundAttachment[];
}
```

Provider identifiers remain opaque and private. The adapter verifies required
facts and rejects missing, malformed, partially staged, or ambiguous media.

### Feedback Round coordinator

```ts
interface FeedbackRoundCoordinator {
  handleMessage(message: InboundMessage): Promise<RoundDirective>;
  executeAction(action: RequestedRoundAction): Promise<RoundActionResult>;
  reconcile(): Promise<readonly ReconciliationDirective[]>;
}
```

`handleMessage` deterministically admits, captures, ignores, or escalates an
inbound event. `executeAction` is the only interface the LLM tools call.
`reconcile` derives safe restart work from persisted state and never retries an
ambiguous external effect.

### Messaging delivery

```ts
interface MessagingDelivery {
  deliver(intent: PersistedDeliveryIntent): Promise<DeliveryReceipt>;
}
```

The interface accepts only a previously persisted, controlled intent. The
adapter cannot accept arbitrary model-authored destination identifiers or raw
Discord content.

### Agent runtime

```ts
interface AgentRuntime {
  decide(input: RoundAgentInput): Promise<RequestedRoundAction>;
}
```

Only normalized, bounded facts enter the agent prompt. The available tools are
`start_image_feedback_round`, `prepare_image_feedback_synthesis`, and
`complete_image_feedback_round`. Raw state records,
credentials, private destination identifiers, and filesystem paths do not.
Every returned action is untrusted until `executeAction` validates it.

### Image generation

The existing `ImageGenerator` seam remains authoritative. It receives the
persisted Synthesized Prompt and validated artifact references exactly once.
The OpenClaw adapter keeps the Base Image as the first independent input and
composes all accepted Participant Reference Images into one deterministic,
row-major contact sheet. This preserves the configured five-image round limit
within the pinned provider's five-total-input limit without silently dropping
context. OpenClaw never calls the provider outside this adapter.

## Message flows

### Starting a round

1. OpenClaw receives a Discord message and stages its attachment.
2. The plugin validates the normalized event and channel admission.
3. If no round is collecting, OpenClaw invokes the LLM once.
4. The LLM may request `start_image_feedback_round`.
5. The coordinator revalidates destination, attachment, active-round state,
   and idempotency independently of the LLM.
6. The coordinator copies the Base Image into a new Round State Capsule and
   persists the public-start intent.
7. The delivery adapter posts only that persisted intent.
8. A confirmed receipt advances the round to collection.

### Collecting feedback

1. OpenClaw's pre-dispatch hook forwards each normalized inbound event to
   `handleMessage` before model dispatch.
2. When the destination has a collecting round, the coordinator applies the
   existing eligibility and bounded-image rules.
3. Qualifying messages are persisted in provider order with stable message
   identity. Duplicate delivery is ignored by identity.
4. Collection-only events are claimed by the hook and do not invoke the LLM.
5. Once the configured prefix is complete, the coordinator freezes it and
   persists one synthesis request.

### Synthesis, generation, and publication

1. One agent turn receives the frozen, sanitized feedback projection.
2. The coordinator validates and persists exactly one Synthesized Prompt.
3. It persists generation intent before calling `ImageGenerator`.
4. A confirmed Generation Outcome is persisted before any Discord delivery.
5. The controlled outcome and, on success, the Result Image are represented by
   one persisted delivery intent.
6. The delivery adapter posts it to the destination already bound to the round.
7. A confirmed receipt completes the round. An ambiguous response moves it to
   Needs Attention and is never retried automatically.

## Runtime isolation

The POC uses a named OpenClaw profile such as `image-feedback-poc`. OpenClaw's
managed macOS service receives a unique configuration, state directory,
workspace, service identity, and loopback base port. The selected port must be
at least twenty ports away from other local OpenClaw Gateway base ports.

OpenClaw runtime state is not stored in the domain `.state/` tree. The two have
different ownership:

```text
<profile state>/
  OpenClaw sessions, locks, caches, and channel credentials

<project>/.state/
  authoritative Feedback Round state and artifacts

<project>/.runtime/openclaw/
  disposable, secret-free integration handoffs only
```

The profile uses loopback binding, Gateway token authentication, a dedicated
Discord bot credential, one allowlisted server/channel, one explicitly allowed
local plugin, and a minimal tool profile. Terminal, shell, filesystem, browser,
GitHub, automation, arbitrary messaging, and session-spawning capabilities are
disabled. Provider credentials live in the profile's trusted secret source,
not in the repository or workspace `.env`.

The named profile prevents operational collisions with other OpenClaw
instances. It is not hostile isolation from processes running as the same
macOS account; a dedicated OS account or container is a later hardening option.

## Persistence and restart behavior

OpenClaw session history is advisory conversation context. The coordinator
reconstructs every workflow decision from `RoundStateStore` and
`RoundArtifactStore` under the existing workflow lock.

The target restart model is a future `reconcile()` pass:

- a collecting round resumes collection;
- a frozen round with no persisted synthesis result requests one agent turn;
- a persisted generation intent with an unknown outcome becomes Needs
  Attention;
- a confirmed result with no publication intent creates that intent;
- a persisted publication intent with an unknown receipt becomes Needs
  Attention; and
- a confirmed completed round performs no external action.

No restart path may infer success from missing information. The initial POC
durably resumes ordinary collection on the next inbound event, but it does not
yet autonomously re-dispatch an interrupted synthesis turn. That limitation is
kept explicit in the setup runbook and remains part of the adoption gate.

## Security model

All inbound messages, attachments, quoted text, and agent output are untrusted.
Neither a Participant nor the LLM can select a destination, change configured
limits, alter workflow state directly, reveal stored data, or introduce an
unapproved tool.

The deterministic policy layer enforces:

- the Discord Channel Allowlist;
- one active round per destination;
- product limits from `src/constants.ts`;
- exact message and attachment identity;
- capsule ownership and real-file validation;
- controlled public templates;
- intent-before-effect ordering; and
- no automatic retry of uncertain external effects.

OpenClaw receives only the credentials necessary for this profile. The plugin
never logs tokens, private IDs, message contents, attachment paths, provider
responses, or raw round state.

## Error handling

Malformed or incomplete inbound events are rejected before domain mutation.
Disallowed destinations are ignored without revealing allowlist information.
Unsupported Base Images return a controlled refusal. Attachment-staging
uncertainty, state disagreement, generation ambiguity, and delivery ambiguity
persist Needs Attention.

Profile preparation atomically replaces every capability-bearing configuration
section from any earlier version of the named profile with the complete bounded
configuration. It refuses to prepare when the selected Gateway port is occupied
or another local listener is fewer than 20 ports away. The operator must stop
the named profile before preparing it again and then repeat authentication.

The plugin may retry transport connection establishment according to
OpenClaw's Gateway behavior. It may not retry a possibly completed Discord
post, image generation, or image upload.

## Testing strategy

Development follows vertical red-green slices through the public seams:

1. A normalized authorized message can request a round; a disallowed message
   cannot cross the coordinator seam.
2. An LLM-requested action is rejected unless deterministic policy admits it.
3. Collecting feedback is claimed before agent dispatch and does not invoke the
   fake agent adapter.
4. Replayed message identities do not duplicate Captured Messages.
5. Partially staged or ambiguous media fails closed.
6. Delivery accepts only a persisted controlled intent bound to its round.
7. Restart reconciliation resumes safe work and pauses unknown effects.
8. A contract fixture matching the pinned OpenClaw plugin interface exercises
   inbound normalization and outbound media delivery without a live Discord
   dependency.

After contract tests pass, one supervised live test runs through the private
allowlisted channel. Raw channel content and identifiers never appear in test
output or committed fixtures.

## Adoption gate

The POC is successful only when it proves:

- natural-language start with one Base Image;
- exact correlation with the originating Discord event;
- zero LLM calls for collection-only messages;
- ordered bounded feedback and image collection;
- replay-safe ingestion;
- deterministic destination and tool enforcement;
- fail-closed generation and delivery ambiguity;
- restart recovery from `.state/` without duplicate effects; and
- controlled Result Image publication without browser automation.

Until those checks pass, ADR-0002 remains the accepted Discord-access decision.
A successful spike will add a superseding ADR for the OpenClaw adapter. A failed
spike will be removed or retained only as explicitly labeled experimental code,
and the same acceptance gate may be tested with nanobot.
