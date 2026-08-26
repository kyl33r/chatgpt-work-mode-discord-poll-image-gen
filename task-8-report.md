# Task 8 Report

## Red-green evidence

- Observer trigger exclusivity: `npm test -- tests/skills.test.ts -t "does not route the existing text-poll scan prompt"` first failed because the text-poll scan prompt matched the observer. After requiring both `boundary` and `allowlisted` for implicit observation prompts, the same test passed.
- Controlled source failures: `npm test -- tests/conversation-command.test.ts -t "supports controlled failures"` first failed because `missing-boundary` and `destination-mismatch` were absent from the controlled category list. After adding those categories, the contract test and the controlled-command cases passed.
- Integration guard: `npm test -- tests/skills.test.ts -t "recognizes observation-skill integration"` first failed because no guard helper existed. After adding the shared name-based guard, canonical-path, `$` invocation, bare-name, and imperative-invocation cases passed while unrelated text remained allowed.

## Verification

- Focused skills and conversation-command suites: 45 tests passed.
- Skill validation: 8 canonical skills validated.
- Type check: passed.
- Full repository verification: passed after this report was added.

## Scope

The observation skill remains independent of `get-discord-polls` and `round-start`; the validator rejects any reference to its canonical skill name in either workflow.
