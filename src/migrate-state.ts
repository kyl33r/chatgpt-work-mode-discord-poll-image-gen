import {
  LEGACY_SHARED_BASE_IMAGE_ROOT,
  LEGACY_SHARED_MIGRATION_ROOT,
  LEGACY_SHARED_ROUND_STATE_PATH,
  ROUND_STATE_ROOT
} from "./constants.js";
import { migrateSharedRoundState } from "./round/state-migration.js";

const result = await migrateSharedRoundState({
  legacyStatePath: LEGACY_SHARED_ROUND_STATE_PATH,
  legacyBaseImageRoot: LEGACY_SHARED_BASE_IMAGE_ROOT,
  legacyMigrationRoot: LEGACY_SHARED_MIGRATION_ROOT,
  roundsRoot: ROUND_STATE_ROOT
});

process.stdout.write(`${JSON.stringify(result)}\n`);
