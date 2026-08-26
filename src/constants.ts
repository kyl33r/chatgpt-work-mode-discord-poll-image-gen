import { join } from "node:path";

export const ROUND_SCHEMA_VERSION = 3;
export const OPERATION_TURN_NUMBER = 1;
export const FEEDBACK_MESSAGE_LIMIT = 5;
export const DISCORD_SCAN_INTERVAL_MS = 15_000;
export const SYNTHESIZED_PROMPT_MAX_CHARACTERS = 1_200;
export const SUPPORTED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;
export const STATE_ROOT = ".state";
export const ROUND_STATE_PATH = join(STATE_ROOT, "rounds.json");
export const BASE_IMAGE_STAGING_ROOT = join(STATE_ROOT, "base-images");
export const RESULT_IMAGE_STAGING_ROOT = join(STATE_ROOT, "results");
export const STATE_MIGRATION_ROOT = join(STATE_ROOT, "migrations");
export const LEGACY_ROUND_STATE_PATH = join(".runtime", "rounds.json");
export const LEGACY_BASE_IMAGE_STAGING_ROOT = join(".runtime", "base-images");
export const RESULT_MARKER_TEMPLATE = "===== RESULT: <id> =====";
export const POLL_START_MARKER_TEMPLATE = "===== POLL START: <id> =====";
export const POLL_CLOSED_MARKER_TEMPLATE = "===== POLL CLOSED: <id> =====";
export const FINAL_IMAGE_PROMPT_LABEL = "Final image prompt:";
export const GENERATION_REFUSED_TEMPLATE =
  "===== GENERATION REFUSED: <id> ===== — No image was produced.";
export const GENERATION_FAILED_TEMPLATE =
  "===== GENERATION FAILED: <id> ===== — No image was produced.";
export const MESSAGE_COLLECTION_INSTRUCTIONS_TEMPLATE =
  "The next <limit> non-empty text messages in this channel will be used as image-edit feedback.";
export const IMAGE_EDIT_SUFFIX =
  "Preserve unrelated content. Produce exactly one edited image.";
export const SYNTHESIZED_PROMPT_PREAMBLE =
  "Edit the supplied base image using this synthesized participant feedback:";
export const SYNTHESIZED_PROMPT_PROHIBITED_PATTERNS = [
  /https?:\/\//i,
  /www\./i,
  /discord\.com\/channels\//i,
  /<[@#][^>]+>/,
  /@(?:everyone|here)\b/i,
  /\b\d{15,20}\b/,
  /\.(?:env|runtime|state)(?:[\\/]|\b)/i,
  /(?:\/Users\/|\/home\/|[A-Za-z]:\\)/,
  /=====/,
  /\b(?:password|secret|token|api[-_ ]?key|cookie|credential)\b/i,
  /(?:prepare|confirm|collect|stop|mark|plan)-(?:base|collection|generation|publication|messages|round|attention|next)/i
] as const;
