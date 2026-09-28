import type { DeclarativeSnapshot } from "./declarative-snapshot.js";

export type SessionResourceSource = "machine" | "ghost";
export type SessionResourceStatus = "admitted" | "shadowed" | "skipped" | "disabled";

export interface SessionResourceDiagnostic {
  source: SessionResourceSource;
  path?: string;
  reason: string;
  shadowedBy?: string;
}

export interface SessionSkillInput {
  name: string;
  path: string;
  description?: string;
  hidden?: boolean;
}

export interface SessionSkillGroup {
  source: SessionResourceSource;
  precedence: number;
  skills: readonly SessionSkillInput[];
  diagnostics?: readonly SessionResourceDiagnostic[];
}

export function sessionSkillGroup(
  source: SessionResourceSource,
  precedence: number,
  snapshot: DeclarativeSnapshot,
  diagnostics: readonly SessionResourceDiagnostic[] = snapshot.warnings
    .map((reason) => ({ source, reason })),
): SessionSkillGroup {
  return {
    source,
    precedence,
    skills: snapshot.skills.map((skill) => ({
      name: skill.name,
      path: skill.filePath,
      description: skill.description,
      hidden: skill.hide,
    })),
    diagnostics,
  };
}

export interface SessionSkillView extends Omit<SessionSkillInput, "hidden"> {
  source: SessionResourceSource;
  precedence: number;
  status: Exclude<SessionResourceStatus, "disabled">;
  shadowedBy?: string;
  reason?: string;
}

function byPrecedenceThenName(
  left: { precedence: number; name: string },
  right: { precedence: number; name: string },
): number {
  return left.precedence - right.precedence || left.name.localeCompare(right.name);
}

export function skillView(
  groups: readonly SessionSkillGroup[],
): SessionSkillView[] {
  const candidates = [...groups].sort((left, right) => left.precedence - right.precedence)
    .flatMap((group) =>
      group.skills.map((skill) => ({
        ...skill,
        source: group.source,
        precedence: group.precedence,
      })));
  const winners = new Map<string, typeof candidates[number]>();
  for (const candidate of candidates) winners.set(candidate.name, candidate);
  const rows = candidates.map((candidate): SessionSkillView => {
    const winner = winners.get(candidate.name) ?? candidate;
    const { hidden, description, ...base } = candidate;
    const resource = {
      ...base,
      ...(description ? { description } : {}),
    };
    if (winner !== candidate) {
      return {
        ...resource,
        status: "shadowed",
        shadowedBy: winner.path,
      };
    }
    if (hidden) {
      return {
        ...resource,
        status: "skipped",
        reason: "Model invocation is disabled by the skill metadata.",
      };
    }
    return {
      ...resource,
      status: "admitted",
    };
  });
  return rows.sort(byPrecedenceThenName);
}

