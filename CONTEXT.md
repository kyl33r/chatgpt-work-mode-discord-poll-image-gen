# Discord Image Feedback

This context describes one collaborative round in which a Base Image is posted, the first configured Discord text messages are captured, and one controlled generation outcome is returned.

## Language

**Base Image**:
The owner-supplied image shown to participants and used as the source for one edit.
_Avoid_: Seed image, starting asset

**Feedback Round**:
The bounded collaboration that begins with one Base Image and ends with one Result Image, a stop decision, or a failure requiring attention.
_Avoid_: Session, job, workflow

**Participant**:
A Discord member whose ordinary text message may be captured after the round boundary. One Participant may occupy multiple message slots.
_Avoid_: User, reviewer

**Text Poll**:
The marker-bounded collection of the first configured number of ordinary non-empty Discord messages after the Base Image post. It has no voting UI, author deduplication, prefix, or deadline.
_Avoid_: Native poll, survey, ballot

**Captured Message**:
The exact first-observed visible text and stable identity of one eligible Discord message in the Text Poll. Captured Messages remain frozen in arrival order as the source for one Synthesized Prompt.
_Avoid_: Candidate, vote, selected feedback

**Synthesized Prompt**:
The single sanitized visual-edit instruction derived from every frozen Captured Message, posted with the closed marker, persisted once, and used unchanged for the image edit.
_Avoid_: Feedback summary, regenerated prompt, raw message compilation

**Durable Round State**:
The restart-critical JSON record and image artifacts stored beneath the worktree-local `.state/` directory.
_Avoid_: Runtime payload, database

**Result Image**:
The single edited image produced when the image-edit attempt succeeds.
_Avoid_: Generation, output asset

**Generation Outcome**:
The confirmed result of the single image-edit attempt: `succeeded` with one Result Image, `refused`, or `failed`. Discord receives exactly one controlled public representation of this outcome.
_Avoid_: Raw provider response, diagnostic

**Needs Attention**:
A paused safety outcome indicating that external state is ambiguous and a person must reconcile it before any action is repeated.
_Avoid_: Failed, retrying
