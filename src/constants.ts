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
  /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?\b/i,
  /discord\.com\/channels\//i,
  /<[@#][^>]+>/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:^|\s)@[A-Za-z0-9_.-]{2,32}\b/,
  /@(?:everyone|here)\b/i,
  /\b\d{15,20}\b/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  /\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/,
  /\.(?:env|runtime|state)(?:[\\/]|\b)/i,
  /(?:\/Users\/|\/home\/|[A-Za-z]:\\)/,
  /=====/,
  /\[[^\]]+\]\([^)]+\)/,
  /\b(?:password|secret|token|api[-_ ]?key|cookie|credential)\b/i,
  /(?:prepare|confirm|collect|stop|mark|plan|get)-(?:base|collection|generation|publication|messages|round|attention|next|prompt-synthesis|synthesized-prompt)/i,
  /\b(?:ignore|override|bypass|disable|change|switch|set|increase|decrease|raise|lower|remove|alter)\b.{0,50}\b(?:channel|limit|security|workflow|control flow)\b/i,
  /\b(?:channel|limit|security|workflow|control flow)\b.{0,50}\b(?:ignore|override|bypass|disable|change|switch|set|increase|decrease|raise|lower|remove|alter)\b/i
] as const;
