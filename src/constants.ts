import { join } from "node:path";

export const FEEDBACK_PREFIX = "FEEDBACK:";
export const FEEDBACK_CANDIDATE_LABEL_PREFIX = "F";
export const MAX_FEEDBACK_CANDIDATES = 10;
export const MAX_SELECTED_FEEDBACK = 3;
export const ROUND_SCHEMA_VERSION = 1;
export const OPERATION_TURN_NUMBER = 1;
export const SUPPORTED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;
export const FEEDBACK_WINDOW_MS = 60 * 60 * 1000;
export const POLL_DURATION_HOURS = 1;
export const ROUND_STATE_PATH = join(".runtime", "rounds.json");
export const BASE_IMAGE_STAGING_ROOT = join(".runtime", "base-images");
export const ROUND_MARKER_TEMPLATE = "ROUND <id> — BASE IMAGE";
export const FEEDBACK_INDEX_TEMPLATE = "ROUND <id> — FEEDBACK INDEX";
export const POLL_QUESTION_TEMPLATE = "ROUND <id> — SELECT FEEDBACK";
export const RESULT_MARKER_TEMPLATE = "ROUND <id> — RESULT IMAGE";
export const PARTICIPANT_INSTRUCTIONS =
  "Reply in this channel with FEEDBACK: followed by one requested image change. Your newest valid submission replaces your earlier one until collection closes.";
export const IMAGE_EDIT_PREAMBLE =
  "Edit the supplied base image using only these requested changes:";
export const IMAGE_EDIT_SUFFIX =
  "Preserve all unrelated subjects, composition, style, and details. Produce exactly one edited image.";
