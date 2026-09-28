import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Skill } from "./declarative-types.js";

export const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";

function parseSkillInvocation(prompt: string): { name: string; args: string } | null {
  const match = /^\/skill:([A-Za-z0-9_.-]+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  return match ? { name: match[1] ?? "", args: (match[2] ?? "").trim() } : null;
}

/**
 * Preserve the explicit `/skill:name args` command surface. The prompt lets
 * the model discover skills; this path is the owner's force-invocation, which
 * sends the admitted skill bytes as an owner-attributed message.
 */
export async function promptPiSession(
  session: AgentSession,
  prompt: string,
  skills: readonly Skill[],
): Promise<void> {
  const invocation = parseSkillInvocation(prompt);
  const skill = invocation ? skills.find((candidate) => candidate.name === invocation.name) : undefined;
  if (invocation && skill && skill.snapshotContent !== undefined) {
    const content = [
      `<skill name=${JSON.stringify(skill.name)} path=${JSON.stringify(skill.filePath)}>`,
      skill.snapshotContent,
      "</skill>",
      ...(invocation.args ? [`Arguments: ${invocation.args}`] : []),
    ].join("\n");
    await session.sendCustomMessage({
      customType: SKILL_PROMPT_MESSAGE_TYPE,
      content,
      display: true,
      details: { attribution: "user", skill: skill.name },
    }, { triggerTurn: true, deliverAs: "steer" });
    return;
  }
  // pi expands `/name args` against the admitted Markdown commands the loader
  // was given (`promptsOverride`); everything else is the owner's message.
  await session.prompt(prompt);
}

