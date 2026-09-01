import { describe, expect, it, vi } from "vitest";

import {
  FeedbackRoundCoordinator,
  UnsupportedBaseImageError
} from "../src/messaging/feedback-round-coordinator.js";
import {
  InvalidInboundImageError,
  type InboundAttachmentStore
} from "../src/messaging/inbound-attachment-store.js";
import type { GeneratedResultStore } from "../src/generation/generated-result-store.js";
import type { ImageGenerator } from "../src/generation/image-generator.js";
import type { DiscordChannelAllowlistStore } from "../src/config/discord-channel-allowlist.js";
import type { RoundArtifactStore } from "../src/round/round-artifact-store.js";
import {
  applyRoundEvent,
  createRound,
  type RoundState
} from "../src/round/round-state.js";
import type { RoundStateStore } from "../src/round/round-state-store.js";
import { InMemoryWorkflowLock } from "../src/workflow-lock.js";

describe("FeedbackRoundCoordinator", () => {
  it("admits a start action only through the configured channel", async () => {
    const store = new MemoryRoundStore();
    const coordinator = new FeedbackRoundCoordinator({
      allowlist: allowlist("https://discord.com/channels/guild-1/channel-1"),
      artifacts: passthroughArtifacts(),
      inboundAttachments: importedAttachments(),
      generatedResults: generatedResults(),
      store,
      workflowLock: new InMemoryWorkflowLock()
    });

    const directive = await coordinator.executeAction({
      action: { type: "start-feedback-round" },
      source: {
        provider: "discord",
        destination: {
          kind: "discord-channel",
          guildId: "guild-1",
          channelId: "channel-1"
        },
        messageId: "message-1",
        senderId: "participant-1",
        occurredAt: "2026-09-01T08:00:00.000Z",
        text: "Start a feedback round",
        attachments: [
          { index: 0, path: "/staging/base.png", mediaType: "image/png" }
        ]
      }
    });

    expect(directive).toMatchObject({
      type: "deliver-round-start",
      mediaPath: expect.stringMatching(/\/base-image\.png$/)
    });
    expect(directive.roundId).toMatch(/^oc_[a-f0-9]{24}$/);
    expect(await store.get(directive.roundId)).toMatchObject({
      phase: "submitting-base",
      channelUrl: "https://discord.com/channels/guild-1/channel-1"
    });
  });

  it("rejects destination authority supplied by the model", async () => {
    const coordinator = new FeedbackRoundCoordinator({
      allowlist: allowlist("https://discord.com/channels/guild-1/channel-1"),
      artifacts: passthroughArtifacts(),
      inboundAttachments: importedAttachments(),
      generatedResults: generatedResults(),
      store: new MemoryRoundStore(),
      workflowLock: new InMemoryWorkflowLock()
    });

    await expect(
      coordinator.executeAction({
        action: {
          type: "start-feedback-round",
          channelUrl: "https://discord.com/channels/untrusted/channel"
        } as { type: "start-feedback-round" },
        source: {
          provider: "discord",
          destination: {
            kind: "discord-channel",
            guildId: "guild-1",
            channelId: "channel-1"
          },
          messageId: "message-1",
          senderId: "participant-1",
          occurredAt: "2026-09-01T08:00:00.000Z",
          text: "Start a feedback round",
          attachments: [
            { index: 0, path: "/staging/base.png", mediaType: "image/png" }
          ]
        }
      })
    ).rejects.toThrow("Feedback Round action contains unsupported fields.");
  });

  it("claims a collecting message before agent dispatch", async () => {
    const store = new MemoryRoundStore();
    const channelUrl = "https://discord.com/channels/guild-1/channel-1";
    const started = applyRoundEvent(
      applyRoundEvent(
        createRound({
          id: "ROUND1",
          baseImagePath: "/state/ROUND1/base-image.png",
          channelUrl,
          messageLimit: 5
        }),
        { type: "base-submission-started" }
      ),
      {
        type: "base-submission-confirmed",
        baseMessageUrl: `${channelUrl}/boundary`,
        collectionStartedAt: "2026-09-01T08:00:00.000Z"
      }
    );
    await store.save(started);
    const coordinator = new FeedbackRoundCoordinator({
      allowlist: allowlist(channelUrl),
      artifacts: passthroughArtifacts(),
      inboundAttachments: importedAttachments(),
      generatedResults: generatedResults(),
      store,
      workflowLock: new InMemoryWorkflowLock()
    });

    await expect(
      coordinator.handleMessage({
        provider: "discord",
        destination: {
          kind: "discord-channel",
          guildId: "guild-1",
          channelId: "channel-1"
        },
        messageId: "message-1",
        senderId: "participant-1",
        occurredAt: "2026-09-01T08:01:00.000Z",
        text: "Increase the contrast",
        attachments: []
      })
    ).resolves.toEqual({
      type: "claimed",
      roundId: "ROUND1",
      capturedCount: 1,
      requestAgentTurn: false
    });
    expect(await store.get("ROUND1")).toMatchObject({
      capturedMessages: [{ text: "Increase the contrast" }]
    });
  });

  it("claims later messages without another agent turn while a round is completing", async () => {
    const store = new MemoryRoundStore();
    const channelUrl = "https://discord.com/channels/guild-1/channel-1";
    let round = applyRoundEvent(
      applyRoundEvent(
        createRound({
          id: "ROUND1",
          baseImagePath: "/state/ROUND1/base-image.png",
          channelUrl,
          messageLimit: 5
        }),
        { type: "base-submission-started" }
      ),
      {
        type: "base-submission-confirmed",
        baseMessageUrl: `${channelUrl}/boundary`,
        collectionStartedAt: "2026-09-01T08:00:00.000Z"
      }
    );
    round = applyRoundEvent(round, {
      type: "message-collection-filled",
      capturedMessages: Array.from({ length: 5 }, (_, index) => ({
        messageUrl: `${channelUrl}/message-${index + 1}`,
        authorId: `participant-${index + 1}`,
        authorName: "Participant",
        timestamp: `2026-09-01T08:0${index + 1}:00.000Z`,
        text: `change ${index + 1}`,
        contextImages: []
      }))
    });
    await store.save(round);
    const coordinator = new FeedbackRoundCoordinator({
      allowlist: allowlist(channelUrl),
      artifacts: passthroughArtifacts(),
      inboundAttachments: importedAttachments(),
      generatedResults: generatedResults(),
      store,
      workflowLock: new InMemoryWorkflowLock()
    });

    await expect(
      coordinator.handleMessage({
        provider: "discord",
        destination: {
          kind: "discord-channel",
          guildId: "guild-1",
          channelId: "channel-1"
        },
        messageId: "message-6",
        senderId: "participant-6",
        occurredAt: "2026-09-01T08:06:00.000Z",
        text: "This arrived after collection closed",
        attachments: []
      })
    ).resolves.toEqual({
      type: "claimed",
      roundId: "ROUND1",
      capturedCount: 5,
      requestAgentTurn: false
    });
  });

  it("persists Needs Attention when inbound media is ambiguous during collection", async () => {
    const store = new MemoryRoundStore();
    const channelUrl = "https://discord.com/channels/guild-1/channel-1";
    const collecting = applyRoundEvent(
      applyRoundEvent(
        createRound({
          id: "ROUND1",
          baseImagePath: "/state/ROUND1/base-image.png",
          channelUrl,
          messageLimit: 5
        }),
        { type: "base-submission-started" }
      ),
      {
        type: "base-submission-confirmed",
        baseMessageUrl: `${channelUrl}/boundary`,
        collectionStartedAt: "2026-09-01T08:00:00.000Z"
      }
    );
    await store.save(collecting);
    const coordinator = new FeedbackRoundCoordinator({
      allowlist: allowlist(channelUrl),
      artifacts: passthroughArtifacts(),
      inboundAttachments: importedAttachments(),
      generatedResults: generatedResults(),
      store,
      workflowLock: new InMemoryWorkflowLock()
    });

    await coordinator.handleInboundAmbiguity("discord", "channel-1", {
      category: "media",
      hasQualifyingText: true,
      potentialSupportedImageCount: 1,
      stagedUsableSupportedImageCount: 0
    });

    expect(await store.get("ROUND1")).toMatchObject({
      phase: "needs-attention",
      attentionReason:
        "Inbound Discord attachment staging is incomplete or ambiguous; reconcile the round manually."
    });
  });

  it("ignores ambiguity that cannot affect collection selection", async () => {
    const store = new MemoryRoundStore();
    const channelUrl = "https://discord.com/channels/guild-1/channel-1";
    let collecting = applyRoundEvent(
      applyRoundEvent(
        createRound({
          id: "ROUND1",
          baseImagePath: "/state/ROUND1/base-image.png",
          channelUrl,
          messageLimit: 5
        }),
        { type: "base-submission-started" }
      ),
      {
        type: "base-submission-confirmed",
        baseMessageUrl: `${channelUrl}/boundary`,
        collectionStartedAt: "2026-09-01T08:00:00.000Z"
      }
    );
    await store.save(collecting);
    const coordinator = new FeedbackRoundCoordinator({
      allowlist: allowlist(channelUrl),
      artifacts: passthroughArtifacts(),
      inboundAttachments: importedAttachments(),
      generatedResults: generatedResults(),
      store,
      workflowLock: new InMemoryWorkflowLock()
    });

    await coordinator.handleInboundAmbiguity("discord", "channel-1", {
      category: "media",
      hasQualifyingText: false,
      potentialSupportedImageCount: 1,
      stagedUsableSupportedImageCount: 0
    });
    expect(await store.get("ROUND1")).toMatchObject({ phase: "collecting-messages" });

    collecting = applyRoundEvent(collecting, {
      type: "message-collection-progressed",
      capturedMessages: [
        {
          messageUrl: `${channelUrl}/message-1`,
          authorId: "participant-1",
          authorName: "Participant",
          timestamp: "2026-09-01T08:01:00.000Z",
          text: "five references already selected",
          contextImages: Array.from({ length: 5 }, (_, index) => ({
            attachmentIndex: index,
            mediaType: "image/png",
            imagePath: `/state/ROUND1/reference-${index}.png`
          }))
        }
      ]
    });
    await store.save(collecting);
    await coordinator.handleInboundAmbiguity("discord", "channel-1", {
      category: "media",
      hasQualifyingText: true,
      potentialSupportedImageCount: 1,
      stagedUsableSupportedImageCount: 0
    });
    expect(await store.get("ROUND1")).toMatchObject({ phase: "collecting-messages" });

    const synthesizing = applyRoundEvent(collecting, {
      type: "message-collection-filled",
      capturedMessages: Array.from({ length: 5 }, (_, index) => ({
        messageUrl: `${channelUrl}/message-${index + 1}`,
        authorId: `participant-${index + 1}`,
        authorName: "Participant",
        timestamp: `2026-09-01T08:0${index + 1}:00.000Z`,
        text: `change ${index + 1}`,
        contextImages: []
      }))
    });
    await store.save(synthesizing);
    await coordinator.handleInboundAmbiguity("discord", "channel-1", {
      category: "identity",
      hasQualifyingText: true,
      potentialSupportedImageCount: 0,
      stagedUsableSupportedImageCount: 0
    });
    expect(await store.get("ROUND1")).toMatchObject({ phase: "synthesizing-feedback" });
  });

  it("quarantines every conflicting active round", async () => {
    const store = new MemoryRoundStore();
    const channelUrl = "https://discord.com/channels/guild-1/channel-1";
    const collecting = applyRoundEvent(
      applyRoundEvent(
        createRound({
          id: "ROUND1",
          baseImagePath: "/state/ROUND1/base-image.png",
          channelUrl,
          messageLimit: 5
        }),
        { type: "base-submission-started" }
      ),
      {
        type: "base-submission-confirmed",
        baseMessageUrl: `${channelUrl}/boundary`,
        collectionStartedAt: "2026-09-01T08:00:00.000Z"
      }
    );
    await store.save(collecting);
    await store.save({
      ...collecting,
      id: "ROUND2",
      baseImagePath: "/state/ROUND2/base-image.png"
    });
    const coordinator = new FeedbackRoundCoordinator({
      allowlist: allowlist(channelUrl),
      artifacts: passthroughArtifacts(),
      inboundAttachments: importedAttachments(),
      generatedResults: generatedResults(),
      store,
      workflowLock: new InMemoryWorkflowLock()
    });

    await coordinator.handleInboundAmbiguity("discord", "channel-1", {
      category: "identity",
      hasQualifyingText: true,
      potentialSupportedImageCount: 0,
      stagedUsableSupportedImageCount: 0
    });

    expect(await store.get("ROUND1")).toMatchObject({ phase: "needs-attention" });
    expect(await store.get("ROUND2")).toMatchObject({ phase: "needs-attention" });
  });

  it("maps invalid staged Base Image bytes to the controlled refusal error", async () => {
    const coordinator = new FeedbackRoundCoordinator({
      allowlist: allowlist("https://discord.com/channels/guild-1/channel-1"),
      artifacts: passthroughArtifacts(),
      inboundAttachments: {
        async importBaseImage() {
          throw new InvalidInboundImageError();
        },
        async importFeedbackImage() {
          throw new Error("not used");
        }
      },
      generatedResults: generatedResults(),
      store: new MemoryRoundStore(),
      workflowLock: new InMemoryWorkflowLock()
    });

    await expect(
      coordinator.executeAction({
        action: { type: "start-feedback-round" },
        source: {
          ...roundSource(),
          attachments: [
            { index: 0, path: "/staging/corrupt.png", mediaType: "image/png" }
          ]
        }
      })
    ).rejects.toBeInstanceOf(UnsupportedBaseImageError);
  });

  it("confirms a submitted Base Image from the exact Discord delivery receipt", async () => {
    const store = new MemoryRoundStore();
    const channelUrl = "https://discord.com/channels/guild-1/channel-1";
    const coordinator = new FeedbackRoundCoordinator({
      allowlist: allowlist(channelUrl),
      artifacts: passthroughArtifacts(),
      inboundAttachments: importedAttachments(),
      generatedResults: generatedResults(),
      store,
      workflowLock: new InMemoryWorkflowLock()
    });
    const source = {
      provider: "discord" as const,
      destination: {
        kind: "discord-channel" as const,
        guildId: "guild-1",
        channelId: "channel-1"
      },
      messageId: "message-1",
      senderId: "participant-1",
      occurredAt: "2026-09-01T08:00:00.000Z",
      text: "Start a feedback round",
      attachments: [
        { index: 0, path: "/staging/base.png", mediaType: "image/png" }
      ]
    };
    const directive = await coordinator.executeAction({
      action: { type: "start-feedback-round" },
      source
    });

    await coordinator.confirmRoundStart({
      roundId: directive.roundId,
      source,
      receiptMessageId: "1751862888969322496"
    });

    expect(await store.get(directive.roundId)).toMatchObject({
      phase: "collecting-messages",
      baseMessageUrl: `${channelUrl}/1751862888969322496`,
      collectionStartedAt: expect.stringMatching(/^20\d\d-/)
    });
    await expect(
      coordinator.isConfiguredConversation("discord", "channel-1")
    ).resolves.toBe(true);
  });

  it("runs the frozen synthesis, one image generation, and controlled publication", async () => {
    const store = new MemoryRoundStore();
    const channelUrl = "https://discord.com/channels/guild-1/channel-1";
    let round = applyRoundEvent(
      applyRoundEvent(
        createRound({
          id: "ROUND1",
          baseImagePath: "/state/ROUND1/base-image.png",
          channelUrl,
          messageLimit: 5
        }),
        { type: "base-submission-started" }
      ),
      {
        type: "base-submission-confirmed",
        baseMessageUrl: `${channelUrl}/1751862888969322496`,
        collectionStartedAt: "2026-09-01T08:00:00.000Z"
      }
    );
    round = applyRoundEvent(round, {
      type: "message-collection-filled",
      capturedMessages: Array.from({ length: 5 }, (_, index) => ({
        messageUrl: `${channelUrl}/message-${index + 1}`,
        authorId: `participant-${index + 1}`,
        authorName: "Participant",
        timestamp: `2026-09-01T08:0${index + 1}:00.000Z`,
        text: `change ${index + 1}`,
        contextImages: []
      }))
    });
    await store.save(round);
    const generator: ImageGenerator = {
      generate: vi.fn().mockResolvedValue({
        kind: "succeeded",
        bytes: Buffer.from("generated-image"),
        mediaType: "image/png"
      })
    };
    const artifacts = passthroughArtifacts();
    const acceptedBase = vi.spyOn(artifacts, "acceptBaseImage");
    const coordinator = new FeedbackRoundCoordinator({
      allowlist: allowlist(channelUrl),
      artifacts,
      inboundAttachments: importedAttachments(),
      generatedResults: generatedResults(),
      store,
      workflowLock: new InMemoryWorkflowLock()
    });
    const source = {
      provider: "discord" as const,
      destination: {
        kind: "discord-channel" as const,
        guildId: "guild-1",
        channelId: "channel-1"
      },
      messageId: "message-5",
      senderId: "participant-5",
      occurredAt: "2026-09-01T08:05:00.000Z",
      text: "change 5",
      attachments: []
    };
    const prompt =
      "Edit the supplied base image using this synthesized participant feedback:\n" +
      "Apply all five requested visual changes as one coherent edit.\n" +
      "Preserve unrelated content. Produce exactly one edited image.";

    await expect(coordinator.prepareSynthesis(source)).resolves.toEqual({
      roundId: "ROUND1",
      feedbackTexts: ["change 1", "change 2", "change 3", "change 4", "change 5"],
      contextImageCount: 0
    });
    const close = await coordinator.prepareRoundCompletion({
      source,
      synthesizedPrompt: prompt
    });
    expect(close).toMatchObject({
      type: "deliver-collection-closed",
      roundId: "ROUND1"
    });
    await coordinator.confirmCollectionClosed({
      roundId: "ROUND1",
      source,
      receiptMessageId: "1751862888969322497"
    });
    const publication = await coordinator.generateAndPreparePublication({
      roundId: "ROUND1",
      source,
      generator
    });

    expect(generator.generate).toHaveBeenCalledTimes(1);
    expect(acceptedBase).toHaveBeenCalledWith(
      "ROUND1",
      "/state/ROUND1/base-image.png"
    );
    expect(generator.generate).toHaveBeenCalledWith({
      prompt,
      baseImagePath: "/state/ROUND1/base-image.png",
      contextImagePaths: []
    });
    expect(publication).toEqual({
      type: "deliver-generation-outcome",
      operationId: expect.any(String),
      roundId: "ROUND1",
      caption: "===== RESULT: ROUND1 =====",
      mediaPath: "/state/ROUND1/result-image.png"
    });
    await coordinator.confirmPublication({
      roundId: "ROUND1",
      source,
      receiptMessageId: "1751862888969322498"
    });
    expect(await store.get("ROUND1")).toMatchObject({ phase: "completed" });
  });

  it("persists Needs Attention when generated output cannot be staged", async () => {
    const store = new MemoryRoundStore();
    const channelUrl = "https://discord.com/channels/guild-1/channel-1";
    await store.save(readyToGenerateRound(channelUrl));
    const coordinator = new FeedbackRoundCoordinator({
      allowlist: allowlist(channelUrl),
      artifacts: passthroughArtifacts(),
      inboundAttachments: importedAttachments(),
      generatedResults: {
        async stage() {
          throw new Error("simulated staging failure");
        }
      },
      store,
      workflowLock: new InMemoryWorkflowLock()
    });

    await expect(
      coordinator.generateAndPreparePublication({
        roundId: "ROUND1",
        source: roundSource(),
        generator: {
          async generate() {
            return {
              kind: "succeeded",
              bytes: Buffer.from("generated-image"),
              mediaType: "image/png"
            };
          }
        }
      })
    ).rejects.toThrow("Image generation did not produce an unambiguous outcome.");
    expect(await store.get("ROUND1")).toMatchObject({
      phase: "needs-attention"
    });
  });
});

function readyToGenerateRound(channelUrl: string): RoundState {
  let round = applyRoundEvent(
    applyRoundEvent(
      createRound({
        id: "ROUND1",
        baseImagePath: "/state/ROUND1/base-image.png",
        channelUrl,
        messageLimit: 5
      }),
      { type: "base-submission-started" }
    ),
    {
      type: "base-submission-confirmed",
      baseMessageUrl: `${channelUrl}/1751862888969322496`,
      collectionStartedAt: "2026-09-01T08:00:00.000Z"
    }
  );
  round = applyRoundEvent(round, {
    type: "message-collection-filled",
    capturedMessages: Array.from({ length: 5 }, (_, index) => ({
      messageUrl: `${channelUrl}/message-${index + 1}`,
      authorId: `participant-${index + 1}`,
      authorName: "Participant",
      timestamp: `2026-09-01T08:0${index + 1}:00.000Z`,
      text: `change ${index + 1}`,
      contextImages: []
    }))
  });
  round = applyRoundEvent(round, {
    type: "synthesized-prompt-confirmed",
    synthesizedPrompt:
      "Edit the supplied base image using this synthesized participant feedback:\n" +
      "Apply all five requested visual changes as one coherent edit.\n" +
      "Preserve unrelated content. Produce exactly one edited image."
  });
  return applyRoundEvent(round, {
    type: "collection-closed",
    closedMessageUrl: `${channelUrl}/1751862888969322497`
  });
}

function roundSource() {
  return {
    provider: "discord" as const,
    destination: {
      kind: "discord-channel" as const,
      guildId: "guild-1",
      channelId: "channel-1"
    },
    messageId: "message-5",
    senderId: "participant-5",
    occurredAt: "2026-09-01T08:05:00.000Z",
    text: "change 5",
    attachments: []
  };
}

class MemoryRoundStore implements RoundStateStore {
  private readonly rounds = new Map<string, RoundState>();

  public async get(roundId: string): Promise<RoundState | undefined> {
    return this.rounds.get(roundId);
  }

  public async list(): Promise<RoundState[]> {
    return [...this.rounds.values()];
  }

  public async save(round: RoundState): Promise<void> {
    this.rounds.set(round.id, structuredClone(round));
  }
}

function allowlist(channelUrl: string): DiscordChannelAllowlistStore {
  return {
    async getAll() {
      return [channelUrl];
    },
    async replace() {
      throw new Error("not used");
    }
  };
}

function passthroughArtifacts(): RoundArtifactStore {
  return {
    async acceptBaseImage(_roundId, candidatePath) {
      return candidatePath;
    },
    async acceptResultImage(_roundId, candidatePath) {
      return candidatePath;
    },
    async requireResultImage(_roundId, storedPath) {
      return storedPath;
    },
    async acceptFeedbackImage(_roundId, _messageOrdinal, _attachmentIndex, candidatePath) {
      return candidatePath;
    },
    async requireFeedbackImage(_roundId, _messageOrdinal, _attachmentIndex, storedPath) {
      return storedPath;
    },
    async copyResultAsBase(_sourceRoundId, _targetRoundId, sourcePath) {
      return sourcePath;
    },
    async discardUnpersistedBase() {}
  };
}

function importedAttachments(): InboundAttachmentStore {
  return {
    async importBaseImage(roundId) {
      return `/state/${roundId}/base-image.png`;
    },
    async importFeedbackImage(roundId, messageOrdinal, attachmentIndex) {
      return `/state/${roundId}/feedback-images/message-${messageOrdinal}-attachment-${attachmentIndex}.png`;
    }
  };
}

function generatedResults(): GeneratedResultStore {
  return {
    async stage(roundId) {
      return `/state/${roundId}/result-image.png`;
    }
  };
}
