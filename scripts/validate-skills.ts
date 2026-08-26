import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_SKILLS = [
  "get-discord-polls",
  "image-gen",
  "round-start",
  "submit-base-image"
] as const;

const DISCOVERY_CUES: Record<(typeof EXPECTED_SKILLS)[number], readonly string[]> = {
  "get-discord-polls": ["messages", "poll", "boundary"],
  "image-gen": ["edit", "base image", "feedback"],
  "round-start": ["start", "resume", "discord"],
  "submit-base-image": ["submit", "base image", "feedback"]
};

const IMPLICIT_TRIGGER_GROUPS: Record<
  (typeof EXPECTED_SKILLS)[number],
  readonly (readonly string[])[]
> = {
  "get-discord-polls": [["collect", "scan", "close"], ["message", "poll", "feedback"]],
  "image-gen": [["edit", "generate", "publish"], ["image"], ["feedback", "poll"]],
  "round-start": [["start", "resume", "run"], ["round", "workflow"], ["discord"]],
  "submit-base-image": [["submit", "post", "start"], ["image"], ["feedback", "discord"]]
};

const REQUIRED_COMMANDS: Record<(typeof EXPECTED_SKILLS)[number], readonly string[]> = {
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

export function matchesSkillPrompt(skillName: string, prompt: string): boolean {
  if (!EXPECTED_SKILLS.includes(skillName as (typeof EXPECTED_SKILLS)[number])) {
    return false;
  }
  if (prompt.includes(`$${skillName}`)) {
    return true;
  }
  const normalizedPrompt = prompt.toLowerCase();
  return IMPLICIT_TRIGGER_GROUPS[skillName as (typeof EXPECTED_SKILLS)[number]].every((group) =>
    group.some((term) => normalizedPrompt.includes(term))
  );
}

export async function validateSkills(repositoryRoot: string): Promise<string[]> {
  const issues: string[] = [];
  const agentInstructions = await readFile(resolve(repositoryRoot, "AGENTS.md"), "utf8");
  for (const requiredPolicy of [
    "Never expose secrets or private identifiers",
    "The sole canonical project-skill source is `<project-root>/skills/`",
    "`.agents/skills/` is only a Codex discovery index of symlinks",
    "Never put raw image-generation errors"
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
    if (!skillMarkdown.includes("npm run round")) {
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
    if (skillName === "round-start") {
      for (const childSkill of ["submit-base-image", "get-discord-polls", "image-gen"]) {
        if (!skillMarkdown.includes(`skills/${childSkill}/SKILL.md`)) {
          issues.push(`round-start: child skill ${childSkill} is not referenced.`);
        }
      }
      if (!skillMarkdown.includes("$imagegen")) {
        issues.push("round-start: Work-mode imagegen invocation is missing.");
      }
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
