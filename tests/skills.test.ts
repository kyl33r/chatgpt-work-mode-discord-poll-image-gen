import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { matchesSkillPrompt, validateSkills } from "../scripts/validate-skills.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

describe("project skills", () => {
  it("have valid metadata, discovery cues, command boundaries, and canonical links", async () => {
    await expect(validateSkills(repositoryRoot)).resolves.toEqual([]);
  });

  it("governs clipboard acquisition for bounded Discord feedback images", async () => {
    const skill = await readFile(
      fileURLToPath(new URL("../skills/get-discord-polls/SKILL.md", import.meta.url)),
      "utf8"
    );
    const planIndex = skill.indexOf("`plan-feedback-captures`");
    const prepareIndex = skill.indexOf("`prepare-feedback-image-capture`");
    const copyIndex = skill.indexOf("perform exactly one visible **Copy Image** action");
    const captureIndex = skill.indexOf("`capture-feedback-image`");

    expect(planIndex).toBeGreaterThan(-1);
    expect(prepareIndex).toBeGreaterThan(planIndex);
    expect(copyIndex).toBeGreaterThan(prepareIndex);
    expect(captureIndex).toBeGreaterThan(copyIndex);
    expect(skill).toContain("`reuse-accepted-image`");
    expect(skill).toContain("active Feedback Round");
    expect(skill).toContain("first `FEEDBACK_MESSAGE_LIMIT` qualifying messages");
    expect(skill).toContain("FEEDBACK_IMAGE_LIMIT_PER_MESSAGE");
    expect(skill).toContain("FEEDBACK_IMAGE_LIMIT_PER_ROUND");
    expect(skill).toContain("run `mark-attention` immediately and stop");
    expect(skill).toContain(
      "Never use a media-download surface, fetch a bare CDN URL, call a Discord API, access credentials, accept an arbitrary path, or depend on a parser branch."
    );
    expect(skill).toContain("Never automatically retry **Copy Image**");

    for (const obsoleteWorkflow of [
      "supported visible media-download surface",
      "never redownload",
      "retry an uncertain download",
      "message-<one-based-slot>-attachment-<attachmentIndex>.<ext>"
    ]) {
      expect(skill).not.toContain(obsoleteWorkflow);
    }
  });

  it.each([
    ["configure-discord-channel", "$configure-discord-channel"],
    ["continue-from-result", "$continue-from-result"],
    ["discord-image-paste", "$discord-image-paste"],
    ["submit-base-image", "$submit-base-image"],
    ["get-discord-polls", "$get-discord-polls"],
    ["image-gen", "$image-gen"],
    ["round-start", "$round-start"],
    [
      "configure-discord-channel",
      "Configure the currently opened Discord channel as the local allowlisted destination."
    ],
    [
      "continue-from-result",
      "Continue the Discord round from the previous result image."
    ],
    ["discord-image-paste", "Paste this image from the clipboard into Discord."],
    ["submit-base-image", "Post this base image to Discord for participant feedback."],
    ["get-discord-polls", "Scan the Discord text poll for its first five messages."],
    ["image-gen", "Generate an image edit from the winning poll feedback."],
    ["round-start", "Start the Discord image feedback round workflow."]
  ])("matches the %s skill for explicit and implicit prompt %s", (skillName, prompt) => {
    expect(matchesSkillPrompt(skillName, prompt)).toBe(true);
  });
});
