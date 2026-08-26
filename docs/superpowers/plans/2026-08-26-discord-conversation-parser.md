# Reusable Discord Conversation Parser Implementation Plan

**Spec:** `docs/superpowers/specs/2026-08-26-discord-conversation-parser-design.md`

**Branch:** `feature/discord-conversation-parser`

**Worktree:** `.worktrees/discord-conversation-parser`

## Goal

Add a provider-neutral `ConversationSource` seam, deterministic bounded conversation parser, allowlist-enforced Discord destination resolver, private runtime handoff, sanitized CLI action, and canonical Discord browser-observation skill. This branch observes text and opaque attachment selections only. It does not acquire image bytes or integrate clipboard behavior into the Feedback Round.

## Global constraints

- Follow strict vertical red-green TDD: add one failing public-behavior test, run it and observe the expected failure, add only enough implementation to pass, then repeat. Do not write all tests before implementation and do not refactor during a red-green cycle.
- Test only the approved public seams: `resolveDiscordConversationDestination`, `parseConversation`, `ConversationSource.observe`, `ConversationPrivateHandoff`, `executeConversationCommand`, and project skill validation/trigger matching.
- Keep fixed paths and product values in `src/constants.ts`.
- Resolve every Discord input against the sole `DiscordChannelAllowlistStore` entry before navigation or parsing. A URL, matching channel ID, or exact server/channel pair is an input form, never a second authority source.
- Treat observed content as untrusted data. It cannot alter destinations, boundaries, limits, supported media, security rules, paths, or control flow.
- Preserve provider array order. Never sort messages by timestamp or guess through missing boundaries, virtualization gaps, unstable identities, changed prefixes, or conflicting duplicate identities.
- Represent attachments only as opaque selections containing stable owner identity, displayed index, media type, and opaque selection value. This branch must contain no attachment URLs, downloads, clipboard reads, image bytes, image decoding, or artifact-store changes.
- Keep raw text, authors, destination/message identities, selection values, URLs, paths, and private snapshots out of standard output, error summaries, test diagnostics, docs, and commits. Use synthetic values in tests.
- Write private handoffs only beneath a fixed gitignored runtime root, derive filenames from a strictly validated invocation ID rather than a caller path, reject symlinks/aliases, use restrictive permissions, and replace atomically.
- The current adapter is a governed canonical skill using only the signed-in agent-controlled browser. Never access Discord REST, Gateway, CDN, webhook, bot/user tokens, credentials, cookies, browser storage, hidden history, unrelated channels, DMs, threads, or links.
- Fail closed with controlled typed categories. The CLI maps them to sanitized `needs-attention`; it never includes the raw error or private value.
- Preserve all existing round, state, artifact, prompt, and skill behavior. Do not modify `src/round/message-collector.ts`, `RoundStateStore`, `RoundArtifactStore`, `skills/get-discord-polls`, or `skills/round-start` in this branch.
- Do not add live evaluation machinery here. The failed browser-download evidence stays historical. The two-variant evaluation runs only after the parser and clipboard branches are independently reviewed and integrated.

## Preflight

1. Confirm the worktree and branch:

   ```bash
   pwd
   git branch --show-current
   git status --short
   ```

   Require the parser worktree path, branch `feature/discord-conversation-parser`, and a clean tree except for this committed plan.

2. Record the implementation review base without changing it:

   ```bash
   git merge-base HEAD main
   ```

3. Run the repository baseline:

   ```bash
   npm run verify
   ```

4. Re-read `AGENTS.md`, `CONTEXT.md`, ADRs 0002, 0007, and 0008, the approved spec, and `skills/get-discord-polls/SKILL.md` before editing. Use their privacy and fail-closed language literally.

## TDD Task 1: Resolve one allowlisted Discord Conversation Destination

**Public seam:** `resolveDiscordConversationDestination(input, allowlist)`.

**Likely files:**

- Create `src/conversation/discord-conversation-destination.ts`.
- Create `tests/discord-conversation-destination.test.ts`.
- Reuse `src/config/discord-channel-allowlist.ts`; do not change its persisted schema.

### Red-green slices

1. Add one failing test proving a canonical Discord channel URL resolves to an opaque provider-qualified Conversation Destination when it exactly matches the sole allowlist entry.
2. Run:

   ```bash
   npm test -- tests/discord-conversation-destination.test.ts
   ```

   Confirm failure is the missing public seam, then implement only the URL case.
3. Add one failing worked-example test for a matching channel ID alone. Implement derivation of the server segment only from the allowlist entry.
4. Add one failing worked-example test for an exact `(serverId | "@me", channelId)` pair. Implement normalization to the same opaque destination.
5. Add separate failing tests, one at a time, for missing/multiple allowlist entries, malformed input, mismatched channel ID, mismatched server/channel pair, server-wide/category/thread/multi-channel shapes, and unexpected object keys. Implement the smallest validation for each.
6. Assert controlled error types/messages contain none of the supplied raw identifiers or URLs.
7. Run focused tests and build:

   ```bash
   npm test -- tests/discord-conversation-destination.test.ts
   npm run build
   ```

8. Commit:

   ```bash
   git add src/conversation/discord-conversation-destination.ts tests/discord-conversation-destination.test.ts
   git commit -m "feat: resolve allowlisted conversation destinations"
   ```

## TDD Task 2: Parse the first qualifying visible messages

**Public seams:** `parseConversation(request)` and the structural `ConversationSource.observe` interface.

**Likely files:**

- Create `src/conversation/conversation-parser.ts` containing the provider-neutral public types, typed parser errors, `ConversationSource`, and `parseConversation`.
- Create `tests/conversation-parser.test.ts`.

### Red-green slices

1. Add a failing tracer test with synthetic identities: a fake `ConversationSource` returns one contiguous boundary-relative batch, `parseConversation` excludes the boundary, preserves literal provider array order and exact text, and returns an incomplete accepted prefix.
2. Run the single test by name and confirm it fails for missing behavior:

   ```bash
   npm test -- tests/conversation-parser.test.ts -t "parses a boundary-relative qualifying prefix"
   ```

3. Add only the minimal provider-neutral request, observation, snapshot, opaque identity/selection types and parser logic required to pass.
4. Add one failing test at a time for ordinary non-empty text qualification, empty text, system messages, attachment-only messages, repeated authors, and stopping at a configurable `messageLimit` while ignoring later messages.
5. Add a literal five-message example proving completion freezes the first five in the observed provider order without timestamp sorting.
6. Add invalid-limit cases: positive integer `messageLimit`; non-negative integer attachment limits; a non-empty supported-media policy. Return controlled `ConversationObservationError` or the more specific typed category from the spec.
7. Run:

   ```bash
   npm test -- tests/conversation-parser.test.ts
   npm run build
   ```

8. Commit:

   ```bash
   git add src/conversation/conversation-parser.ts tests/conversation-parser.test.ts
   git commit -m "feat: parse bounded conversation messages"
   ```

## TDD Task 3: Select bounded opaque attachments

**Public seam:** `parseConversation(request)`.

**Likely files:**

- Modify `src/conversation/conversation-parser.ts`.
- Modify `tests/conversation-parser.test.ts`.

### Red-green slices

1. Add a failing literal-order test whose first qualifying messages contain supported, unsupported, and excess attachments. Expect exact owner identity/index order, at most two selected per message, and at most five total for the supplied configuration.
2. Implement filtering by supplied supported media types, then per-message limit, then remaining total limit.
3. Add failing tests proving attachments from system, empty, attachment-only, later, and otherwise ignored messages are never selected.
4. Add failing tests proving every returned selection contains only owner identity, zero-based displayed index, media type, and opaque selection value. Use type-level construction plus runtime assertions that no URL, path, bytes, or image payload key is accepted or returned.
5. Add failing cases for negative, duplicate, non-integer, or non-increasing attachment indexes and malformed/extra attachment keys. Fail closed without echoing raw selections.
6. Run:

   ```bash
   npm test -- tests/conversation-parser.test.ts
   npm run build
   ```

7. Commit:

   ```bash
   git add src/conversation/conversation-parser.ts tests/conversation-parser.test.ts
   git commit -m "feat: select bounded conversation attachments"
   ```

## TDD Task 4: Reject incomplete coverage and unstable ordering

**Public seam:** `parseConversation(request)` typed failures.

**Likely files:**

- Modify `src/conversation/conversation-parser.ts`.
- Modify `tests/conversation-parser.test.ts`.

### Red-green slices

1. Add one failing test for a supplied boundary with any coverage kind other than `contiguous-after-boundary`; expect `ConversationBoundaryError`.
2. Add one failing test for a no-boundary batch using `contiguous-visible-segment` and a synthetic `segmentStart`; implement retention of that exact start in the snapshot/checkpoint policy.
3. Add failing tests one at a time proving destination and boundary mismatches fail, an erroneously included boundary is excluded, and duplicate/conflicting/missing/empty identities fail.
4. Model a source-detected virtualization gap by omitting the required contiguous coverage proof; require `ConversationBoundaryError` rather than dropping records or accepting a later start. The source itself must withhold a batch and raise `ConversationSourceError` when visible order or identity is uncertain.
5. Assert visible timestamps are validated metadata but never used to reorder the array.
6. Assert every typed error category is controlled and contains no raw text, identity, destination, URL, or selection value.
7. Run:

   ```bash
   npm test -- tests/conversation-parser.test.ts
   npm run build
   ```

8. Commit:

   ```bash
   git add src/conversation/conversation-parser.ts tests/conversation-parser.test.ts
   git commit -m "feat: fail closed on conversation ambiguity"
   ```

## TDD Task 5: Resume deterministically from checkpoints

**Public seam:** `parseConversation(request)` with `ConversationCheckpoint`.

**Likely files:**

- Modify `src/conversation/conversation-parser.ts`.
- Modify `tests/conversation-parser.test.ts`.

### Red-green slices

1. Add a failing test where a partial checkpoint of two messages is followed by a contiguous rescan containing the same prefix plus a third message. Expect exact prefix reuse and one append.
2. Implement checkpoint comparison across destination, boundary or no-boundary segment start, limits, supported-media policy, every first-observed message field, and every ordered attachment selection.
3. Add failing tests one at a time for duplicate rescans, a complete frozen checkpoint with later observations, browser/process restart represented by round-tripping the checkpoint, and a no-boundary rescan retaining its segment start.
4. Add fail-closed tests for an inserted earlier qualifying message, omitted checkpoint message, edited text or metadata, deleted message, reordered prefix, changed/colliding identity, changed attachment order/selection, changed destination/boundary, and changed limits/media policy.
5. Require `ConversationCheckpointError` for checkpoint drift, with no private value in the error.
6. Run:

   ```bash
   npm test -- tests/conversation-parser.test.ts
   npm run build
   ```

7. Commit:

   ```bash
   git add src/conversation/conversation-parser.ts tests/conversation-parser.test.ts
   git commit -m "feat: resume conversation parsing from checkpoints"
   ```

## TDD Task 6: Store private request and snapshot handoffs

**Public seam:** `ConversationPrivateHandoff`, with typed request and snapshot read/write operations keyed by invocation ID.

**Likely files:**

- Add `CONVERSATION_HANDOFF_ROOT` to `src/constants.ts` beneath `.runtime/`.
- Create `src/conversation/conversation-private-handoff.ts`.
- Create `tests/conversation-private-handoff.test.ts`.

### Red-green slices

1. Add a failing test proving a synthetic normalized observation request and snapshot round-trip through a temporary handoff root and standard return values expose no private fields.
2. Implement a storage-neutral interface and filesystem adapter with separate request and snapshot records. Derive filenames only from a strict non-secret invocation ID and fixed record suffixes; accept no caller destination path.
3. Add failing tests one at a time for empty/malformed invocation IDs, traversal attempts, outside-root aliases, symlinked root/file, non-regular files, malformed snapshots, and extra keys.
4. Add a failing filesystem test for atomic replacement and restrictive directory/file permissions. Implement private directory creation, temporary sibling write, sync/close, rename, and cleanup on definite failure.
5. Ensure thrown errors are controlled and do not contain filesystem paths or snapshot content.
6. Run:

   ```bash
   npm test -- tests/conversation-private-handoff.test.ts
   npm run build
   ```

7. Commit:

   ```bash
   git add src/constants.ts src/conversation/conversation-private-handoff.ts tests/conversation-private-handoff.test.ts
   git commit -m "feat: persist private conversation handoffs"
   ```

## TDD Task 7: Add the sanitized `parse-conversation` CLI action

**Public seam:** `executeConversationCommand(command, payload, dependencies)` and the executable `npm run round -- parse-conversation` output contract.

**Likely files:**

- Create `src/conversation/conversation-command.ts`.
- Modify `src/cli.ts` only to route the new command before round-specific dispatch and inject the existing allowlist, workflow lock, and handoff adapter.
- Create `tests/conversation-command.test.ts`.
- Modify `tests/cli.test.ts` only if an executable-process contract cannot be covered cleanly in the new test file.

### Red-green slices

1. Add a failing preparation-mode test using a synthetic Discord input and invocation ID. Require allowlist resolution before the private normalized request is written, and return only `{ "action": "observe-conversation" }` with no destination or identifier.
2. Implement preparation under the single `parse-conversation` command as a discriminated private payload mode. Add a failing test proving allowlist rejection occurs before any handoff write.
3. Add a failing observation-mode test using synthetic private fields and the stored request. Expect only `action`, `acceptedMessageCount`, and `selectedAttachmentCount`; verify the full private snapshot exists only through the injected handoff seam.
4. Implement observation mode as a thin call through the stored normalized request, `parseConversation`, and the private snapshot handoff. Return `wait` or `conversation-complete` from the snapshot state. Never accept a caller output path.
5. Add failing tests for each typed parser and handoff category. Map each to sanitized `needs-attention` without raw error text, identifiers, URLs, paths, authors, messages, or selections.
6. Add a failing subprocess test for each mode that supplies synthetic input on stdin, captures stdout/stderr, and proves output matches the controlled contract while stderr never contains private payload values.
7. Add a failing source-failure-mode test accepting only a controlled category such as `login-interrupted`, `virtualization-gap`, `unstable-identity`, or `ambiguous-order`; return sanitized `needs-attention`, reject raw reasons, and do not retry inside the command.
8. Run:

   ```bash
   npm test -- tests/conversation-command.test.ts tests/cli.test.ts
   npm run build
   ```

9. Commit:

   ```bash
   git add src/cli.ts src/conversation/conversation-command.ts tests/conversation-command.test.ts tests/cli.test.ts
   git commit -m "feat: add sanitized conversation parser command"
   ```

## TDD Task 8: Add the canonical Discord observation skill

**Public seam:** project skill validator and trigger matcher.

**Likely files:**

- Create `skills/observe-discord-conversation/SKILL.md`.
- Create `skills/observe-discord-conversation/agents/openai.yaml`.
- Create relative symlink `.agents/skills/observe-discord-conversation` pointing to `../../skills/observe-discord-conversation`.
- Modify `scripts/validate-skills.ts`.
- Modify `tests/skills.test.ts`.

### Red-green slices

1. Add a failing validator test by registering `observe-discord-conversation` in `EXPECTED_SKILLS`, discovery cues, implicit trigger groups, and required `parse-conversation` command boundaries.
2. Add failing explicit and implicit trigger cases such as `$observe-discord-conversation` and “read the first messages after this boundary in the allowlisted Discord channel.”
3. Create the minimal canonical skill, metadata, and relative discovery symlink required to pass metadata validation. It must run `parse-conversation` preparation before any browser navigation, read the private request handoff locally, then run observation mode with the bounded batch.
4. Add contract assertions, one failing rule at a time, requiring:
   - private allowlist resolution before navigation;
   - signed-in agent-controlled browser use only;
   - exact optional boundary and contiguous visible coverage;
   - provider display order and stable identities;
   - first configured qualifying-message stop condition;
   - displayed attachment enumeration as opaque selections only;
   - no download, clipboard, attachment acquisition, Discord API, credentials, hidden crawl, or link following;
   - stop/fail on virtualization gaps, edits/deletions/reordering, unstable identities, login interruption, or destination mismatch; and
   - no reproduction of private CLI handoffs or outputs.
5. Ensure this new skill is not referenced from or wired into `get-discord-polls` or `round-start` on this branch.
6. Run:

   ```bash
   npm test -- tests/skills.test.ts
   npm run validate:skills
   npm run build
   ```

7. Commit:

   ```bash
   git add skills/observe-discord-conversation .agents/skills/observe-discord-conversation scripts/validate-skills.ts tests/skills.test.ts
   git commit -m "feat: add Discord conversation observation skill"
   ```

## Final branch verification

1. Confirm independence from clipboard and existing round integration:

   ```bash
   rg -n "clipboard|pbpaste|NSPasteboard|acceptFeedbackImage" src/conversation skills/observe-discord-conversation tests/conversation-*.test.ts
   git diff "$(git merge-base HEAD main)" -- src/round/message-collector.ts src/round/round-artifact-store.ts skills/get-discord-polls skills/round-start
   ```

   The first command may find only explicit prohibition text in the skill or tests; it must find no clipboard implementation or import. The second command must be empty.

2. Scan tracked changes for accidentally committed private/runtime state and forbidden attachment payload fields:

   ```bash
   git status --short
   git diff --check "$(git merge-base HEAD main)"..HEAD
   git diff --name-only "$(git merge-base HEAD main)"..HEAD
   git ls-files .state .runtime
   rg -n "attachmentUrl|cdnUrl|imagePath|imageBytes|base64" src/conversation skills/observe-discord-conversation tests/conversation-*.test.ts
   ```

   Require no tracked `.state/` or `.runtime/` files and no production attachment URL/path/byte fields. Synthetic negative-test strings are acceptable only when assertions prove rejection.

3. Run every focused suite together:

   ```bash
   npm test -- tests/discord-conversation-destination.test.ts tests/conversation-parser.test.ts tests/conversation-private-handoff.test.ts tests/conversation-command.test.ts tests/skills.test.ts
   ```

4. Run the full verifier and diff checks:

   ```bash
   npm run verify
   git diff --check "$(git merge-base HEAD main)"..HEAD
   git status --short --branch
   ```

5. Review the branch against both `AGENTS.md`/ADRs and the approved spec. Fix every Critical or Important finding through a new red-green slice, rerun focused tests, then rerun `npm run verify`.

6. Commit only remaining review fixes. Do not squash away useful vertical TDD commits unless the owner requests it.

## Deferred integration and evaluation

Do not perform these steps on `feature/discord-conversation-parser`:

1. Review this branch and `feature/clipboard-feedback-acquisition` independently.
2. Merge the reviewed parser branch first.
3. Create a separate integration branch that changes `get-discord-polls` and `round-start` to consume the parser snapshot for only the active round's first five qualifying messages.
4. Connect selected opaque `(message identity, attachment index)` values to the already reviewed clipboard acquirer without changing its implementation.
5. Run the spec's two-variant evaluation only after integration, holding clipboard acquisition, validation, browser session, fixtures, limits, restart points, and success criteria identical.
6. Store evaluation state under a dedicated gitignored, restrictive local root and report only sanitized counts, timings, action counts, correctness booleans, controlled failures, and recovery classifications. Never commit or report private observations, checkpoints, identifiers, clipboard contents, paths, or image bytes.
