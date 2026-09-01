import { isAbsolute, resolve } from "node:path";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  OPENCLAW_PLUGIN_ID,
  OPENCLAW_PLUGIN_PROJECT_ROOT_RELATIVE_PATH
} from "../../src/constants.js";
import { createOpenClawRoundBridge } from "../../src/openclaw/create-openclaw-round-bridge.js";
import { OpenClawImageGenerator } from "../../src/openclaw/openclaw-image-generator.js";
import {
  registerOpenClawRoundAdapter
} from "../../src/openclaw/openclaw-plugin-adapter.js";

export default definePluginEntry({
  id: OPENCLAW_PLUGIN_ID,
  name: "Image Feedback Round",
  description: "Runs the bounded image-feedback workflow in one Discord channel.",
  register(api) {
    if (!api.rootDir || !isAbsolute(api.rootDir)) {
      throw new Error("The Image Feedback Round plugin root is unavailable.");
    }
    const projectRoot = resolve(
      api.rootDir,
      OPENCLAW_PLUGIN_PROJECT_ROOT_RELATIVE_PATH
    );
    registerOpenClawRoundAdapter(
      api,
      createOpenClawRoundBridge(projectRoot),
      (context) =>
        new OpenClawImageGenerator({
          generate: api.runtime.imageGeneration.generate,
          config: context.runtimeConfig ?? context.config ?? api.config,
          ...(context.agentDir === undefined ? {} : { agentDir: context.agentDir })
        })
    );
  }
});
