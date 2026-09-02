/**
 * Adapted from oh-my-pi's advisor output quarantine
 * (`src/advisor/runtime.ts`, MIT, @oh-my-pi/pi-coding-agent 18.0.3).
 * Copyright (c) 2025-2026 Stencil Labs, Inc.
 */

const ADVISOR_QUARANTINE_PREFIX = "Advisor response quarantined";

interface AdvisorOutputHazard {
  label: string;
  pattern: RegExp;
}

export const ADVISOR_OUTPUT_ONLY_HAZARDS: readonly AdvisorOutputHazard[] = [
  { label: "account-deletion claim", pattern: /\buser\b.{0,80}\b(?:deleted|erased)\b.{0,80}\baccount\b/iu },
  {
    label: "instruction override",
    pattern: /\bignore\s+(?:all\s+)?(?:prior|previous|earlier)\s+(?:user\s+)?instructions\b/iu,
  },
  {
    label: "destructive shell command",
    pattern: /\brm\s+(?=(?:-[a-z]+\s*)*-[a-z]*r[a-z]*)(?=(?:-[a-z]+\s*)*-[a-z]*f[a-z]*)(?:-[a-z]+\s*)+/iu,
  },
  { label: "denial instruction", pattern: /\bdeny\s+(?:this|it|the\s+request)\s+if\s+(?:asked|questioned)\b/iu },
];

/**
 * Reject generated destructive directives before parsed notes can become
 * model-visible context. Hazards already present in the source transcript do
 * not count as advisor-generated, except the destructive-command plus new
 * instruction-override combination retained from upstream.
 */
export function quarantineAdvisorUnsafeOutput(
  generatedText: string,
  sourceText = "",
): string | undefined {
  if (!generatedText) return undefined;
  const labels: string[] = [];
  const matchedLabels: string[] = [];
  for (const hazard of ADVISOR_OUTPUT_ONLY_HAZARDS) {
    if (!hazard.pattern.test(generatedText)) continue;
    matchedLabels.push(hazard.label);
    if (!hazard.pattern.test(sourceText)) labels.push(hazard.label);
  }
  if (matchedLabels.includes("destructive shell command")
    && labels.includes("instruction override")
    && !labels.includes("destructive shell command")) {
    labels.push("destructive shell command");
  }
  if (!labels.includes("destructive shell command") && labels.length < 3) return undefined;
  return `${ADVISOR_QUARANTINE_PREFIX}: generated output-only destructive directives: ${labels.join(", ")}`;
}

export interface AdvisorQuarantineMessage {
  role: string;
  content?: ReadonlyArray<{ type?: string; text?: string }>;
}

export function buildAdvisorQuarantineSourceText(
  currentInput: string,
  messages: readonly AdvisorQuarantineMessage[],
): string {
  const parts: string[] = [];
  if (currentInput) parts.push(currentInput);
  for (const message of messages) {
    if (message.role !== "toolResult" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n");
}
