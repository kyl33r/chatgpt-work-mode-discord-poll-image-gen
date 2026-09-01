# OpenClaw messaging-agent POC implementation plan

Date: 2026-09-01

Design: [OpenClaw messaging-agent POC design](../specs/2026-09-01-openclaw-messaging-agent-poc-design.md)

## Constraints

- Work only on `feature/openclaw-messaging-agent-poc` in its isolated worktree.
- Pin OpenClaw to the researched stable release; do not use `latest` at runtime.
- Run OpenClaw with a supported isolated Node runtime without changing the
  machine's default Node installation.
- Keep fixed values and paths in `src/constants.ts`.
- Keep `.state/`, `.runtime/`, credentials, private identifiers, and raw
  messages out of commits and test output.
- Add one behavior test before each minimal implementation slice.
- Test only through the approved coordinator, delivery, agent, and adapter
  seams.

## Slice 1: normalized inbound admission

1. Add a failing test showing that an authorized, fully staged Discord event
   becomes a normalized `InboundMessage` while incomplete or malformed media
   fails closed.
2. Add opaque messaging types and an OpenClaw event normalizer.
3. Keep provider-specific fields inside the adapter.

## Slice 2: governed round actions

1. Add a failing test showing that an LLM-requested start action is admitted
   only for the configured channel and one valid Base Image.
2. Add `FeedbackRoundCoordinator.executeAction` as a deep wrapper over the
   existing command/store/artifact interfaces.
3. Derive destination authority from the allowlist, not from model arguments.
4. Return controlled directives rather than performing posts inside the
   coordinator.

## Slice 3: deterministic collection before LLM dispatch

1. Add a failing test showing that collection messages are claimed by the
   inbound hook and never reach the fake `AgentRuntime`.
2. Route normalized collecting events into the existing message collector.
3. Ignore replayed stable message identities.
4. Trigger one synthesis action only when the configured prefix freezes.

## Slice 4: persisted delivery

1. Add a failing test showing that delivery rejects unpersisted, mismatched, or
   model-authored destinations.
2. Add `MessagingDelivery` and an OpenClaw current-conversation adapter.
3. Confirm state transitions only from an unambiguous delivery receipt.
4. Persist Needs Attention on an ambiguous result without retrying.

## Slice 5: OpenClaw plugin contract

1. Pin the OpenClaw release and compile against its published plugin SDK.
2. Add a repository-local plugin manifest and entry point.
3. Register only the bounded round tools and required message hooks.
4. Add contract fixtures for inbound media, no-LLM dispatch claiming, tool
   gating, and outbound media delivery.
5. Keep the plugin's interface small and delegate domain behavior to the
   coordinator.

## Slice 6: isolated runtime operations

1. Add a validated, secret-free profile template with a unique named profile,
   loopback binding, dedicated port, minimal tool policy, one plugin allowlist,
   disabled terminal, and one Discord channel configuration seam.
2. Add setup/status scripts that always include the profile and verify the
   selected OpenClaw and Node versions.
3. Keep credentials in the profile's trusted secret source and document the
   manual secret-entry step without printing values.
4. Add a managed-service runbook for install, start, stop, status, security
   audit, and removal.

## Slice 7: restart boundary and full verification

1. Preserve collection across clean service restart and document that
   autonomous synthesis re-dispatch remains an adoption-gate item.
2. Run the complete repository verifier.
3. Inspect the diff for secrets, private identifiers, generated state, and
   accidental broad tool permissions.
4. Perform code review and address blocking findings.
5. Commit and push the implementation to draft PR #9.
6. Keep the live Discord test gated on manual credential configuration and an
   explicit supervised invocation.
