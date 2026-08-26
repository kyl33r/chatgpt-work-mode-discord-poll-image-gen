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

  it("does not route the existing text-poll scan prompt to the conversation observer", () => {
    const textPollPrompt = "Scan the Discord text poll for its first five messages.";

    expect(matchesSkillPrompt("get-discord-polls", textPollPrompt)).toBe(true);
    expect(matchesSkillPrompt("observe-discord-conversation", textPollPrompt)).toBe(false);
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
