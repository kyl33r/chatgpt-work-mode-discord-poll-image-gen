import { join } from "node:path";

export const ROUND_SCHEMA_VERSION = 7;
export const OPERATION_TURN_NUMBER = 1;
export const FEEDBACK_MESSAGE_LIMIT = 5;
export const FEEDBACK_IMAGE_LIMIT_PER_MESSAGE = 2;
export const FEEDBACK_IMAGE_LIMIT_PER_ROUND = 5;
export const DISCORD_SCAN_INTERVAL_MS = 15_000;
export const SYNTHESIZED_PROMPT_MAX_CHARACTERS = 1_200;
export const SUPPORTED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;
export const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const STATE_ROOT = ".state";
export const DISCORD_CHANNEL_ALLOWLIST_SCHEMA_VERSION = 1;
export const DISCORD_CHANNEL_ALLOWLIST_PATH = join(
  STATE_ROOT,
  "discord-channel-allowlist.json"
);
export const DISCORD_CHANNEL_ALLOWLIST_MIGRATION_SCHEMA_VERSION = 1;
export const DISCORD_CHANNEL_ALLOWLIST_MIGRATION_PATH = join(
  STATE_ROOT,
  "migrations",
  "discord-channel-allowlist-v1.json"
);
export const WORKFLOW_LOCK_PATH = join(STATE_ROOT, ".workflow.lock");
export const CLIPBOARD_HELPER_PROTOCOL_VERSION = 1;
export const CLIPBOARD_HELPER_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const ROUND_STATE_ROOT = join(STATE_ROOT, "rounds");
export const ROUND_STATE_FILE_NAME = "round.json";
export const ROUND_MIGRATIONS_DIRECTORY_NAME = "migrations";
export const ROUND_BASE_IMAGE_BASENAME = "base-image";
export const ROUND_RESULT_IMAGE_BASENAME = "result-image";
export const ROUND_FEEDBACK_IMAGES_DIRECTORY_NAME = "feedback-images";
export const ROUND_FEEDBACK_IMAGE_FILENAME_TEMPLATE =
  "message-<messageOrdinal>-attachment-<attachmentIndex>.png";
export const ROUND_FEEDBACK_IMAGE_TEMPORARY_FILENAME_PREFIX = ".feedback-image-";
export const ROUND_FEEDBACK_IMAGE_FILENAME_PATTERN =
  /^message-[1-9]\d*-attachment-\d+\.(?:png|jpe?g|webp)$/;
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const FEEDBACK_ACQUISITION_EVALUATION_SCHEMA_VERSION = 1;
export const FEEDBACK_ACQUISITION_EVALUATION_REPORT_ROOT = join(
  ".runtime",
  "evaluations",
  "clipboard-feedback-acquisition"
);
export const FEEDBACK_ACQUISITION_EVALUATION_FILE_PREFIX = "evaluation-";
export const FEEDBACK_ACQUISITION_EVALUATION_FILE_EXTENSION = ".json";
export const FEEDBACK_ACQUISITION_EVALUATION_FILE_ATTEMPT_LIMIT = 999_999;
export const FEEDBACK_ACQUISITION_EVALUATION_PHASES = [
  "preparation",
  "browser-action",
  "clipboard-read-decode",
  "artifact-validation-install",
  "collection-handoff"
] as const;
export const FEEDBACK_ACQUISITION_EVALUATION_COMPLETIONS = [
  "complete",
  "incomplete"
] as const;
export const FEEDBACK_ACQUISITION_EVALUATION_CORRECTNESS_VALUES = [
  "verified",
  "unverifiable",
  "incorrect"
] as const;
export const FEEDBACK_ACQUISITION_EVALUATION_RECOVERIES = [
  "automatic",
  "resume",
  "needs-attention",
  "terminal"
] as const;
export const FEEDBACK_ACQUISITION_EVALUATION_INTERRUPTION_BOUNDARIES = [
  "none",
  "before-intent",
  "after-intent-before-copy",
  "after-copy-before-capture",
  "during-staging",
  "after-install-before-receipt",
  "after-receipt-before-collection",
  "after-collection"
] as const;
export const FEEDBACK_ACQUISITION_EVALUATION_SCENARIO_CODES = [
  "single-valid-image",
  "multiple-valid-images",
  "unsupported-or-excess-attachments",
  "clipboard-unchanged",
  "clipboard-over-advanced",
  "clipboard-unreadable",
  "clipboard-empty",
  "clipboard-multiple-images",
  "browser-copy-control-missing",
  "visible-attachment-ambiguous",
  "selection-order-changed",
  "interrupted-before-intent",
  "interrupted-after-intent-before-copy",
  "interrupted-after-copy-before-capture",
  "interrupted-during-staging",
  "interrupted-after-install-before-receipt",
  "interrupted-after-receipt-before-collection",
  "interrupted-after-collection",
  "restart-selected",
  "restart-unresolved-intent",
  "restart-accepted-artifact",
  "restart-collected-batch",
  "artifact-missing",
  "artifact-corrupt",
  "artifact-symlinked",
  "artifact-aliased",
  "artifact-outside-capsule",
  "artifact-pre-existing",
  "host-unsupported",
  "pasteboard-unavailable",
  "browser-download-baseline"
] as const;
export const BASE_IMAGE_STAGING_ROOT = ROUND_STATE_ROOT;
export const RESULT_IMAGE_STAGING_ROOT = ROUND_STATE_ROOT;
export const LEGACY_SHARED_ROUND_STATE_PATH = join(STATE_ROOT, "rounds.json");
export const LEGACY_SHARED_BASE_IMAGE_ROOT = join(STATE_ROOT, "base-images");
export const LEGACY_SHARED_MIGRATION_ROOT = join(STATE_ROOT, "migrations");
export const ROUND_MIGRATION_STAGING_DIRECTORY = ".round-migration-v4";
export const LEGACY_V3_STATE_BACKUP_FILE = "rounds-v3.json";
export const LEGACY_V4_ROUND_BACKUP_FILE = "round-v4.json";
export const LEGACY_V5_ROUND_BACKUP_FILE = "round-v5.json";
export const LEGACY_V6_ROUND_BACKUP_FILE = "round-v6.json";
export const LEGACY_V2_STATE_BACKUP_FILE = "rounds-v2.json";
export const RESULT_MARKER_TEMPLATE = "===== RESULT: <id> =====";
export const POLL_START_MARKER_TEMPLATE = "===== POLL START: <id> =====";
export const POLL_CLOSED_MARKER_TEMPLATE = "===== POLL CLOSED: <id> =====";
export const FINAL_IMAGE_PROMPT_LABEL = "Final image prompt:";
export const GENERATION_REFUSED_TEMPLATE =
  "===== GENERATION REFUSED: <id> ===== — No image was produced.";
export const GENERATION_FAILED_TEMPLATE =
  "===== GENERATION FAILED: <id> ===== — No image was produced.";
export const MESSAGE_COLLECTION_INSTRUCTIONS_TEMPLATE =
  "The next <messageLimit> ordinary non-empty text messages in this channel will be used as image-edit feedback. Each qualifying message may contribute up to <perMessageImageLimit> supported images, with at most <roundImageLimit> images accepted for the whole round. Later attachments beyond either limit are ignored in Discord arrival and attachment order. Supported formats: PNG, JPEG, and WebP.";
export const IMAGE_EDIT_SUFFIX =
  "Preserve unrelated content. Produce exactly one edited image.";
export const SYNTHESIZED_PROMPT_PREAMBLE =
  "Edit the supplied base image using this synthesized participant feedback:";
export const PARTICIPANT_REFERENCE_INSTRUCTION =
  "Participant reference images are supporting visual context for the requested edits; keep the Base Image as the edit target.";
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
