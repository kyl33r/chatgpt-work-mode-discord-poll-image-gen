# Discord Image Feedback

This context describes one collaborative round in which participants evaluate a visible base image, propose textual changes, vote, and produce one edited result.

## Language

**Base Image**:
The owner-supplied image shown to participants and used as the source for one edit.
_Avoid_: Seed image, starting asset

**Feedback Round**:
The bounded collaboration that begins with one Base Image and ends with one Result Image, a stop decision, or a failure requiring attention.
_Avoid_: Session, job, workflow

**Participant**:
A Discord member who can submit feedback or vote in the allowlisted channel during a Feedback Round.
_Avoid_: User, reviewer

**Feedback Submission**:
A Participant's current text describing a requested change to the Base Image. A newer submission replaces that Participant's earlier submission before collection closes.
_Avoid_: Comment, prompt, vote

**Feedback Candidate**:
A validated Feedback Submission assigned a stable short label for voting.
_Avoid_: Poll answer, option text

**Feedback Poll**:
The finalized Discord poll through which Participants select compatible Feedback Candidates.
_Avoid_: Survey, approval poll

**Selected Feedback**:
The exact full text of the highest-ranked nonzero Feedback Candidates chosen by the Feedback Poll.
_Avoid_: Summary, winning prompt

**Result Image**:
The single edited image produced from the Base Image and Selected Feedback.
_Avoid_: Generation, output asset

**Needs Attention**:
A paused safety outcome indicating that external state is ambiguous and a person must reconcile it before any action is repeated.
_Avoid_: Failed, retrying
