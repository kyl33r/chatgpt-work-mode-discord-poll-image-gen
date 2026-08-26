import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_SKILLS = [
  "configure-discord-channel",
  "continue-from-result",
  "discord-image-paste",
  "get-discord-polls",
  "image-gen",
  "observe-discord-conversation",
  "round-start",
  "submit-base-image"
] as const;

const DISCOVERY_CUES: Record<(typeof EXPECTED_SKILLS)[number], readonly string[]> = {
  "configure-discord-channel": ["configure", "discord", "channel", "allowlist"],
  "continue-from-result": ["continue", "previous", "result", "discord"],
  "discord-image-paste": ["paste", "discord", "image", "clipboard"],
  "get-discord-polls": ["messages", "poll", "boundary"],
  "image-gen": ["edit", "base image", "feedback"],
  "observe-discord-conversation": ["observe", "discord", "conversation", "allowlist"],
  "round-start": ["start", "resume", "discord"],
  "submit-base-image": ["submit", "base image", "feedback"]
};

const IMPLICIT_TRIGGER_GROUPS: Record<
  (typeof EXPECTED_SKILLS)[number],
  readonly (readonly string[])[]
> = {
  "configure-discord-channel": [
    ["configure", "select", "switch", "use"],
    ["discord"],
    ["channel", "allowlist"]
  ],
  "continue-from-result": [
    ["continue", "start", "improve"],
    ["previous", "latest", "last"],
    ["result", "image"],
    ["round", "discord"]
  ],
  "discord-image-paste": [["paste", "attach", "upload"], ["discord"], ["image", "clipboard"]],
  "get-discord-polls": [["collect", "scan", "close"], ["message", "poll", "feedback"]],
  "image-gen": [["edit", "generate", "publish"], ["image"], ["feedback", "poll"]],
  "observe-discord-conversation": [
    ["read", "observe", "scan"],
    ["message", "conversation"],
    ["boundary"],
    ["allowlisted"],
    ["discord"]
  ],
  "round-start": [["start", "resume", "run"], ["round", "workflow"], ["discord"]],
  "submit-base-image": [["submit", "post", "start"], ["image"], ["feedback", "discord"]]
};

const REQUIRED_COMMANDS: Record<(typeof EXPECTED_SKILLS)[number], readonly string[]> = {
  "configure-discord-channel": ["configure:channel"],
  "continue-from-result": [
    "prepare-continuation",
    "confirm-base-submission",
    "mark-attention"
  ],
  "discord-image-paste": [],
  "get-discord-polls": [
    "plan-next",
    "get-round",
    "collect-messages",
    "prepare-prompt-synthesis",
    "confirm-synthesized-prompt",
    "confirm-collection-closed",
    "mark-attention"
  ],
  "round-start": [
    "migrate:channel-allowlist",
    "plan-next",
    "prepare-prompt-synthesis",
    "confirm-synthesized-prompt",
    "prepare-generation",
    "confirm-generation",
    "prepare-publication",
    "confirm-publication",
    "mark-attention"
  ],
  "image-gen": [
    "plan-next",
    "prepare-generation",
    "confirm-generation",
    "prepare-publication",
    "confirm-publication",
    "mark-attention"
  ],
  "observe-discord-conversation": ["parse-conversation"],
  "submit-base-image": [
    "prepare-base-submission",
    "confirm-base-submission",
    "mark-attention"
  ]
};

const FORBIDDEN_SKILL_TERMS: Partial<
  Record<(typeof EXPECTED_SKILLS)[number], readonly string[]>
> = {
  "get-discord-polls": [
    "collect-feedback",
    "confirm-poll-created",
    "record-poll-results",
    "native Discord poll"
  ]
};

const OBSERVE_DISCORD_CONVERSATION_CONTRACTS = [
  "Private allowlist resolution is complete before browser navigation.",
  "existing signed-in, agent-controlled Discord browser session",
  "exact optional boundary",
  "contiguous visible segment",
  "displayed provider order",
  "first configured qualifying-message count",
  "opaque selections",
  "Never download, paste, copy to the clipboard, acquire",
  "Discord REST, Gateway, CDN, webhook, bot, or user-token interfaces",
  "virtualization gap",
  "edited or deleted",
  "identity is missing or unstable",
  "messages or attachments appear reordered",
  "destination does not match",
  "missing-boundary",
  "destination-mismatch",
  "Never automatically retry an uncertain observation.",
  "Do not reproduce its destination, boundary, message limit, or any CLI handoff/output"
] as const;

const OBSERVATION_SKILL_NAME = "observe-discord-conversation";
const POLL_OR_ROUND_COLLECTION_PATTERN = /\b(?:poll|feedback|round|collection)\b/i;

export function matchesSkillPrompt(skillName: string, prompt: string): boolean {
  if (!EXPECTED_SKILLS.includes(skillName as (typeof EXPECTED_SKILLS)[number])) {
    return false;
  }
  const explicitlyInvokedSkills = EXPECTED_SKILLS.filter((expectedSkill) =>
    prompt.includes(`$${expectedSkill}`)
  );
  if (explicitlyInvokedSkills.length > 0) {
    return explicitlyInvokedSkills.includes(skillName as (typeof EXPECTED_SKILLS)[number]);
  }
  const normalizedPrompt = prompt.toLowerCase();
  const isImplicitObservationPrompt =
    !POLL_OR_ROUND_COLLECTION_PATTERN.test(normalizedPrompt) &&
    matchesImplicitPrompt(OBSERVATION_SKILL_NAME, normalizedPrompt);
  if (skillName === OBSERVATION_SKILL_NAME) {
    return isImplicitObservationPrompt;
  }
  if (skillName === "get-discord-polls" && isImplicitObservationPrompt) {
    return false;
  }
  return matchesImplicitPrompt(skillName as (typeof EXPECTED_SKILLS)[number], normalizedPrompt);
}

function matchesImplicitPrompt(
  skillName: (typeof EXPECTED_SKILLS)[number],
  normalizedPrompt: string
): boolean {
  return IMPLICIT_TRIGGER_GROUPS[skillName].every((group) =>
    group.some((term) => normalizedPrompt.includes(term))
  );
}

export function referencesObservationSkill(markdown: string): boolean {
  return markdown.includes(OBSERVATION_SKILL_NAME);
}

export async function validateSkills(repositoryRoot: string): Promise<string[]> {
  const issues: string[] = [];
  const agentInstructions = await readFile(resolve(repositoryRoot, "AGENTS.md"), "utf8");
  const constantsSource = await readFile(resolve(repositoryRoot, "src/constants.ts"), "utf8");
  for (const constant of [
    "export const FEEDBACK_IMAGE_LIMIT_PER_MESSAGE",
    "export const FEEDBACK_IMAGE_LIMIT_PER_ROUND"
  ]) {
    if (!constantsSource.includes(constant)) {
      issues.push(`src/constants.ts is missing configured image limit: ${constant}`);
    }
  }
  for (const requiredPolicy of [
    "Never expose secrets or private identifiers",
    "The sole canonical project-skill source is `<project-root>/skills/`",
    "`.agents/skills/` is only a Codex discovery index of symlinks",
    "Never put raw image-generation errors",
    "storage-neutral `RoundStateStore` and `RoundArtifactStore` interfaces",
    "Persist each Feedback Round in its own `.state/rounds/<round-id>/` capsule",
    "Persist the single Discord Channel Allowlist in `.state/discord-channel-allowlist.json`"
  ]) {
    if (!agentInstructions.includes(requiredPolicy)) {
      issues.push(`AGENTS.md is missing required policy: ${requiredPolicy}`);
    }
  }
  const skillsRoot = resolve(repositoryRoot, "skills");
  const actualSkills = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (JSON.stringify(actualSkills) !== JSON.stringify([...EXPECTED_SKILLS].sort())) {
    issues.push(`Expected canonical skills ${EXPECTED_SKILLS.join(", ")}; found ${actualSkills.join(", ")}.`);
  }

  for (const skillName of EXPECTED_SKILLS) {
    const skillRoot = resolve(skillsRoot, skillName);
    const skillMarkdown = await readFile(resolve(skillRoot, "SKILL.md"), "utf8");
    const metadata = parseFrontmatter(skillMarkdown);
    if (metadata.name !== skillName) {
      issues.push(`${skillName}: frontmatter name must exactly match the directory.`);
    }
    if (!metadata.description) {
      issues.push(`${skillName}: frontmatter description is required.`);
    }
    for (const cue of DISCOVERY_CUES[skillName]) {
      if (!metadata.description?.toLowerCase().includes(cue)) {
        issues.push(`${skillName}: description must include the discovery cue ${JSON.stringify(cue)}.`);
      }
    }
    if (
      skillName !== "configure-discord-channel" &&
      skillName !== "discord-image-paste" &&
      !skillMarkdown.includes("npm run round")
    ) {
      issues.push(`${skillName}: deterministic CLI boundary is missing.`);
    }
    for (const command of REQUIRED_COMMANDS[skillName]) {
      if (!skillMarkdown.includes(command)) {
        issues.push(`${skillName}: required CLI boundary ${command} is missing.`);
      }
    }
    for (const term of FORBIDDEN_SKILL_TERMS[skillName] ?? []) {
      if (skillMarkdown.includes(term)) {
        issues.push(`${skillName}: obsolete workflow term ${term} must be removed.`);
      }
    }
    if (!/stop|fail|reject|never/i.test(skillMarkdown)) {
      issues.push(`${skillName}: fail-closed behavior is not documented.`);
    }
    if (!skillMarkdown.includes("Never access Discord credentials or internal APIs.")) {
      issues.push(`${skillName}: Discord credential and internal-API prohibition is missing.`);
    }
    if (
      (skillName === "submit-base-image" ||
        skillName === "continue-from-result" ||
        skillName === "image-gen" ||
        skillName === "round-start") &&
      !skillMarkdown.includes(".state/rounds/<round-id>/")
    ) {
      issues.push(`${skillName}: isolated Round State Capsule path is missing.`);
    }
    if (skillName === "round-start") {
      for (const childSkill of [
        "configure-discord-channel",
        "continue-from-result",
        "discord-image-paste",
        "submit-base-image",
        "get-discord-polls",
        "image-gen"
      ]) {
        if (!skillMarkdown.includes(`skills/${childSkill}/SKILL.md`)) {
          issues.push(`round-start: child skill ${childSkill} is not referenced.`);
        }
      }
      if (!skillMarkdown.includes("$imagegen")) {
        issues.push("round-start: Work-mode imagegen invocation is missing.");
      }
    }
    if (skillName === "discord-image-paste") {
      for (const clipboardContract of [
        'presentationStyle: "attachment"',
        'mimeType: "image/png"',
        "Focus Text Area",
        "press `Tab` exactly once",
        "active element",
        "Meta+V",
        "After `Enter`, never",
        "reset the override"
      ]) {
        if (!skillMarkdown.includes(clipboardContract)) {
          issues.push(`discord-image-paste: clipboard contract ${clipboardContract} is missing.`);
        }
      }
    }
    if (
      (skillName === "submit-base-image" ||
        skillName === "continue-from-result" ||
        skillName === "image-gen") &&
      !skillMarkdown.includes("skills/discord-image-paste/SKILL.md")
    ) {
      issues.push(`${skillName}: shared Discord clipboard-paste skill is not referenced.`);
    }
    if (
      skillName === "continue-from-result" &&
      !skillMarkdown.includes("skills/round-start/SKILL.md")
    ) {
      issues.push("continue-from-result: round-start delegation is missing.");
    }
    if (
      skillName === "get-discord-polls" &&
      (!skillMarkdown.includes("`authorId`") || !skillMarkdown.includes("`authorName`"))
    ) {
      issues.push("get-discord-polls: exact message author fields are missing.");
    }
    if (skillName === "get-discord-polls") {
      for (const contract of [
        "FEEDBACK_IMAGE_LIMIT_PER_MESSAGE",
        "FEEDBACK_IMAGE_LIMIT_PER_ROUND",
        "supported visible media-download surface",
        "bare CDN URL",
        "feedback-images/",
        "message-<one-based-slot>-attachment-<attachmentIndex>.<ext>",
        "attachmentIndex",
        "never redownload",
        "Participant reference images are supporting visual context"
      ]) {
        if (!skillMarkdown.includes(contract)) {
          issues.push(`get-discord-polls: participant-image contract ${contract} is missing.`);
        }
      }
    }
    if (skillName === "image-gen") {
      for (const contract of ["Base Image first", "contextImagePaths", "supporting visual context"] ) {
        if (!skillMarkdown.includes(contract)) {
          issues.push(`image-gen: ordered participant-image contract ${contract} is missing.`);
        }
      }
    }
    if (skillName === "observe-discord-conversation") {
      for (const contract of OBSERVE_DISCORD_CONVERSATION_CONTRACTS) {
        if (!skillMarkdown.includes(contract)) {
          issues.push(`observe-discord-conversation: required contract ${contract} is missing.`);
        }
      }
    }
    if (
      skillName === "round-start" &&
      !skillMarkdown.includes("Keep the ChatGPT task active")
    ) {
      issues.push("round-start: active-task polling lifecycle is missing.");
    }
    if (
      (skillName === "round-start" || skillName === "get-discord-polls") &&
      !skillMarkdown.includes(
        "Edit the supplied base image using this synthesized participant feedback:"
      )
    ) {
      issues.push(`${skillName}: exact Synthesized Prompt preamble is missing.`);
    }

    const agentYaml = await readFile(resolve(skillRoot, "agents/openai.yaml"), "utf8");
    for (const field of ["display_name", "short_description", "default_prompt"] as const) {
      if (!readQuotedYamlScalar(agentYaml, field)) {
        issues.push(`${skillName}: agents/openai.yaml is missing interface.${field}.`);
      }
    }
    const defaultPrompt = readQuotedYamlScalar(agentYaml, "default_prompt");
    if (!defaultPrompt?.includes(`$${skillName}`)) {
      issues.push(`${skillName}: default_prompt must explicitly invoke $${skillName}.`);
    }
    if (defaultPrompt && !matchesSkillPrompt(skillName, defaultPrompt)) {
      issues.push(`${skillName}: default_prompt does not pass explicit trigger matching.`);
    }

    const agentLink = resolve(repositoryRoot, ".agents/skills", skillName);
    if (!(await lstat(agentLink)).isSymbolicLink()) {
      issues.push(`${skillName}: .agents discovery entry must be a symlink.`);
    } else if ((await realpath(agentLink)) !== (await realpath(skillRoot))) {
      issues.push(`${skillName}: .agents discovery link does not resolve to the canonical skill.`);
    }
  }

  for (const integratedSkill of ["get-discord-polls", "round-start"] as const) {
    const skillMarkdown = await readFile(resolve(skillsRoot, integratedSkill, "SKILL.md"), "utf8");
    if (referencesObservationSkill(skillMarkdown)) {
      issues.push(`${integratedSkill}: must not integrate the conversation observation skill.`);
    }
  }

  return issues;
}

function parseFrontmatter(markdown: string): {
  name: string | undefined;
  description: string | undefined;
} {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) {
    return { name: undefined, description: undefined };
  }
  return {
    name: readPlainYamlScalar(match[1], "name"),
    description: readPlainYamlScalar(match[1], "description")
  };
}

function readPlainYamlScalar(yaml: string, field: string): string | undefined {
  return yaml.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

function readQuotedYamlScalar(yaml: string, field: string): string | undefined {
  return yaml.match(new RegExp(`^\\s*${field}:\\s*["'](.+)["']\\s*$`, "m"))?.[1];
}

async function main(): Promise<void> {
  const issues = await validateSkills(process.cwd());
  if (issues.length > 0) {
    throw new Error(issues.join("\n"));
  }
  process.stdout.write(`Validated ${EXPECTED_SKILLS.length} project skills.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
