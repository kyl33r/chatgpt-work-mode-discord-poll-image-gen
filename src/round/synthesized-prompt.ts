import {
  IMAGE_EDIT_SUFFIX,
  PARTICIPANT_REFERENCE_INSTRUCTION,
  SYNTHESIZED_PROMPT_MAX_CHARACTERS,
  SYNTHESIZED_PROMPT_PREAMBLE,
  SYNTHESIZED_PROMPT_PROHIBITED_PATTERNS
} from "../constants.js";

export function validateSynthesizedPrompt(
  candidate: string,
  requiresParticipantContext = false
): string {
  const prompt = candidate.trim();
  const requiredPrefix = requiresParticipantContext
    ? `${SYNTHESIZED_PROMPT_PREAMBLE}\n${PARTICIPANT_REFERENCE_INSTRUCTION}\n`
    : `${SYNTHESIZED_PROMPT_PREAMBLE}\n`;
  if (
    !prompt.startsWith(requiredPrefix) ||
    !prompt.endsWith(`\n${IMAGE_EDIT_SUFFIX}`)
  ) {
    throw new Error("Synthesized prompt must use the required image-edit framing.");
  }
  if (prompt.length > SYNTHESIZED_PROMPT_MAX_CHARACTERS) {
    throw new Error("Synthesized prompt exceeds the configured public length limit.");
  }
  if (SYNTHESIZED_PROMPT_PROHIBITED_PATTERNS.some((pattern) => pattern.test(prompt))) {
    throw new Error("Synthesized prompt contains prohibited public content.");
  }
  return prompt;
}
