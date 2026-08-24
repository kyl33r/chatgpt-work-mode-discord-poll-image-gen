import {
  FEEDBACK_CANDIDATE_LABEL_PREFIX,
  FEEDBACK_PREFIX,
  MAX_FEEDBACK_CANDIDATES,
  MAX_SELECTED_FEEDBACK
} from "../constants.js";

export interface FeedbackMessage {
  messageUrl: string;
  authorId: string;
  authorName: string;
  timestamp: string;
  kind: "feedback";
  roundId: string;
  text: string;
}

export interface FeedbackCandidate {
  label: string;
  messageUrl: string;
  participantId: string;
  participantName: string;
  submittedAt: string;
  text: string;
}

export interface CollectFeedbackInput {
  roundId: string;
  opensAt: string;
  closesAt: string;
  messages: FeedbackMessage[];
}

export interface RankableFeedbackCandidate {
  label: string;
  text: string;
  submittedAt: string;
}

export interface SelectFeedbackInput {
  finalized: boolean;
  candidates: RankableFeedbackCandidate[];
  votes: Record<string, number>;
}

export interface SelectedFeedback {
  label: string;
  text: string;
  votes: number;
}

export function collectFeedbackCandidates(input: CollectFeedbackInput): FeedbackCandidate[] {
  const opensAt = Date.parse(input.opensAt);
  const closesAt = Date.parse(input.closesAt);
  if (!Number.isFinite(opensAt) || !Number.isFinite(closesAt) || closesAt < opensAt) {
    throw new Error("Feedback collection requires a valid time window.");
  }
  const newestByParticipant = new Map<string, FeedbackMessage>();

  for (const message of input.messages) {
    const timestamp = Date.parse(message.timestamp);
    if (
      !Number.isFinite(timestamp) ||
      timestamp < opensAt ||
      timestamp > closesAt ||
      message.kind !== "feedback" ||
      message.roundId !== input.roundId ||
      !message.text.startsWith(FEEDBACK_PREFIX)
    ) {
      continue;
    }

    const feedback = message.text.slice(FEEDBACK_PREFIX.length).trim();
    if (feedback.length === 0) {
      continue;
    }

    const existing = newestByParticipant.get(message.authorId);
    if (!existing || Date.parse(existing.timestamp) < timestamp) {
      newestByParticipant.set(message.authorId, message);
    }
  }

  return [...newestByParticipant.values()]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .slice(0, MAX_FEEDBACK_CANDIDATES)
    .map((message, index) => ({
      label: `${FEEDBACK_CANDIDATE_LABEL_PREFIX}${index + 1}`,
      messageUrl: message.messageUrl,
      participantId: message.authorId,
      participantName: message.authorName,
      submittedAt: message.timestamp,
      text: message.text.slice(FEEDBACK_PREFIX.length).trim()
    }));
}

export function selectFeedback(input: SelectFeedbackInput): SelectedFeedback[] {
  if (!input.finalized) {
    throw new Error("Poll must be finalized before feedback can be selected.");
  }

  return input.candidates
    .map((candidate) => ({ ...candidate, votes: input.votes[candidate.label] ?? 0 }))
    .filter((candidate) => Number.isInteger(candidate.votes) && candidate.votes > 0)
    .sort(
      (left, right) =>
        right.votes - left.votes || Date.parse(left.submittedAt) - Date.parse(right.submittedAt)
    )
    .slice(0, MAX_SELECTED_FEEDBACK)
    .map(({ label, text, votes }) => ({ label, text, votes }));
}
