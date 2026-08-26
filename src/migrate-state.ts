import {
  BASE_IMAGE_STAGING_ROOT,
  LEGACY_BASE_IMAGE_STAGING_ROOT,
  LEGACY_ROUND_STATE_PATH,
  ROUND_STATE_PATH,
  STATE_MIGRATION_ROOT
} from "./constants.js";
import { migrateLegacyState } from "./round/state-migration.js";

const result = await migrateLegacyState({
  legacyStatePath: LEGACY_ROUND_STATE_PATH,
  newStatePath: ROUND_STATE_PATH,
  legacyBaseImageRoot: LEGACY_BASE_IMAGE_STAGING_ROOT,
  newBaseImageRoot: BASE_IMAGE_STAGING_ROOT,
  migrationRoot: STATE_MIGRATION_ROOT
});

process.stdout.write(`${JSON.stringify(result)}\n`);
