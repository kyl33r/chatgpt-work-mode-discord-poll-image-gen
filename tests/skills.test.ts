import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  matchesSkillPrompt,
  referencesObservationSkill,
  validateSkills
} from "../scripts/validate-skills.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

describe("project skills", () => {
  it("have valid metadata, discovery cues, command boundaries, and canonical links", async () => {
    await expect(validateSkills(repositoryRoot)).resolves.toEqual([]);
  });

  it.each([
    ["configure-discord-channel", "$configure-discord-channel"],
    ["continue-from-result", "$continue-from-result"],
    ["discord-image-paste", "$discord-image-paste"],
    ["submit-base-image", "$submit-base-image"],
    ["get-discord-polls", "$get-discord-polls"],
    ["image-gen", "$image-gen"],
    ["observe-discord-conversation", "$observe-discord-conversation"],
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
    [
      "observe-discord-conversation",
      "Read the first messages after this boundary in the allowlisted Discord channel."
    ],
    ["round-start", "Start the Discord image feedback round workflow."]
  ])("matches the %s skill for explicit and implicit prompt %s", (skillName, prompt) => {
    expect(matchesSkillPrompt(skillName, prompt)).toBe(true);
  });

  it.each([
    "Scan the Discord text poll for its first five messages.",
    "Scan the allowlisted Discord poll messages after this boundary.",
    "Collect feedback messages in the allowlisted Discord channel after this boundary.",
    "Close the Discord round poll after this boundary."
  ])("routes poll or round collection prompt only to get-discord-polls: %s", (prompt) => {
    expect(matchesSkillPrompt("get-discord-polls", prompt)).toBe(true);
    expect(matchesSkillPrompt("observe-discord-conversation", prompt)).toBe(false);
  });

  it("routes a bounded allowlisted conversation observation only to the observer", () => {
    const prompt = "Observe the allowlisted Discord conversation messages after this boundary.";

    expect(matchesSkillPrompt("observe-discord-conversation", prompt)).toBe(true);
    expect(matchesSkillPrompt("get-discord-polls", prompt)).toBe(false);
  });

  it("continues to route ordinary round-message collection to get-discord-polls", () => {
    const prompt = "Collect round messages in Discord.";

    expect(matchesSkillPrompt("get-discord-polls", prompt)).toBe(true);
    expect(matchesSkillPrompt("observe-discord-conversation", prompt)).toBe(false);
  });

  it.each([
    ["canonical skill path", "Read skills/observe-discord-conversation/SKILL.md first."],
    ["explicit invocation", "Use $observe-discord-conversation now."],
    ["bare skill name", "Use observe-discord-conversation now."],
    ["imperative invocation", "Invoke observe-discord-conversation for this scan."],
    ["unrelated text", "Continue the current text-poll collection.", false]
  ])("recognizes observation-skill integration through %s", (_kind, markdown, expected = true) => {
    expect(referencesObservationSkill(markdown)).toBe(expected);
  });
});
