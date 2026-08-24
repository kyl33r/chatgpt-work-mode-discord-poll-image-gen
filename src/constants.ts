import { join } from "node:path";

export const ROUND_SCHEMA_VERSION = 2;
export const OPERATION_TURN_NUMBER = 1;
export const FEEDBACK_MESSAGE_LIMIT = 5;
export const DISCORD_SCAN_INTERVAL_MS = 15_000;
export const SUPPORTED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;
export const ROUND_STATE_PATH = join(".runtime", "rounds.json");
export const BASE_IMAGE_STAGING_ROOT = join(".runtime", "base-images");
export const RESULT_MARKER_TEMPLATE = "===== RESULT: <id> =====";
export const POLL_START_MARKER_TEMPLATE = "===== POLL START: <id> =====";
export const POLL_CLOSED_MARKER_TEMPLATE = "===== POLL CLOSED: <id> =====";
export const GENERATION_REFUSED_TEMPLATE =
  "===== GENERATION REFUSED: <id> ===== — No image was produced.";
export const GENERATION_FAILED_TEMPLATE =
  "===== GENERATION FAILED: <id> ===== — No image was produced.";
export const MESSAGE_COLLECTION_INSTRUCTIONS_TEMPLATE =
  "The next <limit> non-empty text messages in this channel will be used as image-edit feedback.";
export const IMAGE_EDIT_PREAMBLE =
  "Edit the supplied base image using all of these Discord messages as requested changes:";
export const IMAGE_EDIT_SUFFIX =
  "Preserve unrelated content. Produce exactly one edited image.";
