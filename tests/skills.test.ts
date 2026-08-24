import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { matchesSkillPrompt, validateSkills } from "../scripts/validate-skills.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

describe("project skills", () => {
  it("have valid metadata, discovery cues, command boundaries, and canonical links", async () => {
    await expect(validateSkills(repositoryRoot)).resolves.toEqual([]);
  });

  it.each([
    ["submit-base-image", "$submit-base-image"],
    ["get-discord-polls", "$get-discord-polls"],
    ["image-gen", "$image-gen"],
    ["submit-base-image", "Post this base image to Discord for participant feedback."],
    ["get-discord-polls", "Scan the Discord text poll for its first five messages."],
    ["image-gen", "Generate an image edit from the winning poll feedback."]
  ])("matches the %s skill for explicit and implicit prompt %s", (skillName, prompt) => {
    expect(matchesSkillPrompt(skillName, prompt)).toBe(true);
  });
});
