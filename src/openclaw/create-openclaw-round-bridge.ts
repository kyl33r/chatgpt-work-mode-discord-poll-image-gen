import { isAbsolute, join, resolve } from "node:path";

import {
  DISCORD_CHANNEL_ALLOWLIST_PATH,
  ROUND_STATE_ROOT,
  WORKFLOW_LOCK_PATH
} from "../constants.js";
import { JsonDiscordChannelAllowlistStore } from "../config/discord-channel-allowlist.js";
import { FeedbackRoundCoordinator } from "../messaging/feedback-round-coordinator.js";
import { JsonInboundAttachmentStore } from "../messaging/inbound-attachment-store.js";
import { JsonRoundArtifactStore } from "../round/round-artifact-store.js";
import { JsonRoundStateStore } from "../round/round-state-store.js";
import { FileWorkflowLock } from "../workflow-lock.js";
import { JsonGeneratedResultStore } from "../generation/generated-result-store.js";
import { OpenClawRoundBridge } from "./openclaw-round-bridge.js";

export function createOpenClawRoundBridge(projectRoot: string): OpenClawRoundBridge {
  if (!isAbsolute(projectRoot)) {
    throw new Error("The OpenClaw plugin requires an absolute project root.");
  }
  const root = resolve(projectRoot);
  const roundsRoot = join(root, ROUND_STATE_ROOT);
  return new OpenClawRoundBridge(
    new FeedbackRoundCoordinator({
      allowlist: new JsonDiscordChannelAllowlistStore(
        join(root, DISCORD_CHANNEL_ALLOWLIST_PATH)
      ),
      artifacts: new JsonRoundArtifactStore(roundsRoot),
      inboundAttachments: new JsonInboundAttachmentStore(roundsRoot),
      generatedResults: new JsonGeneratedResultStore(roundsRoot),
      store: new JsonRoundStateStore(roundsRoot),
      workflowLock: new FileWorkflowLock(join(root, WORKFLOW_LOCK_PATH))
    })
  );
}
