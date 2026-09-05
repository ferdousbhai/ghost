import type { ConversationRuntime } from "./conversation-identity.js";
import type { EffectiveProjectMcpRead } from "./mcp-catalog.js";
import type { ProjectDeclarativeSnapshot } from "./project-resources.js";
import { isAbsolute, join, resolve } from "node:path";

export type SessionResourceSource = "machine" | "ghost" | "project";
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

export function projectSessionSkillGroup(
  source: SessionResourceSource,
  precedence: number,
  snapshot: ProjectDeclarativeSnapshot,
  diagnostics: readonly SessionResourceDiagnostic[] = snapshot.warnings
    .filter((warning) => !snapshot.mcpWarnings.includes(warning))
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

export interface SessionMcpGroup {
  source: Exclude<SessionResourceSource, "machine">;
  precedence: number;
  root: string;
  effective: EffectiveProjectMcpRead;
}

export interface SessionMcpView {
  name: string;
  path: string;
  source: Exclude<SessionResourceSource, "machine">;
  precedence: number;
  enabled: boolean;
  status: SessionResourceStatus;
  shadowedBy?: string;
  reason?: string;
}

export interface SessionResourceView {
  runtime: ConversationRuntime;
  skills: SessionSkillView[];
  diagnostics: SessionResourceDiagnostic[];
  mcpServers: SessionMcpView[];
  mcpDiagnostics: SessionResourceDiagnostic[];
}

function byPrecedenceThenName(
  left: { precedence: number; name: string },
  right: { precedence: number; name: string },
): number {
  return left.precedence - right.precedence || left.name.localeCompare(right.name);
}

function skillView(
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

function skippedName(path: string): string | undefined {
  const marker = "#mcpServers.";
  const index = path.indexOf(marker);
  return index < 0 ? undefined : path.slice(index + marker.length) || undefined;
}

function mcpSourcePath(group: SessionMcpGroup, path?: string): string {
  if (!path) return join(group.root, group.source === "project" ? ".omp/mcp.json" : "mcp.json");
  const hash = path.indexOf("#");
  const pathname = hash < 0 ? path : path.slice(0, hash);
  const fragment = hash < 0 ? "" : path.slice(hash);
  return `${isAbsolute(pathname) ? pathname : resolve(group.root, pathname)}${fragment}`;
}

function mcpViews(
  groups: readonly SessionMcpGroup[],
): { rows: SessionMcpView[]; diagnostics: SessionResourceDiagnostic[] } {
  const claims = [...groups].sort((left, right) => left.precedence - right.precedence)
    .flatMap((group) => {
      const skipped = new Map(
        group.effective.skipped.flatMap((entry) => {
          const name = skippedName(entry.path);
          return name ? [[name, entry] as const] : [];
        }),
      );
      return group.effective.claimedNames.map((name) => {
        const server = group.effective.servers.find((candidate) => candidate.name === name);
        const disabled = group.effective.disabled?.find((candidate) => candidate.name === name);
        const diagnostic = skipped.get(name);
        return {
          name,
          source: group.source,
          precedence: group.precedence,
          path: server?.source.absolutePath ?? disabled?.source.absolutePath
            ?? mcpSourcePath(group, diagnostic?.path),
          server,
          disabled: disabled !== undefined,
          diagnostic,
        };
      });
    });
  const winners = new Map<string, typeof claims[number]>();
  for (const claim of claims) winners.set(claim.name, claim);
  const rows = claims.map((claim): SessionMcpView => {
    const winner = winners.get(claim.name) ?? claim;
    const resource = {
      name: claim.name,
      path: claim.path,
      source: claim.source,
      precedence: claim.precedence,
    };
    if (winner !== claim) {
      return {
        ...resource,
        enabled: claim.server !== undefined && claim.server.errors.length === 0,
        status: "shadowed",
        shadowedBy: winner.path,
      };
    }
    const serverErrors = claim.server?.errors ?? [];
    if (claim.diagnostic || serverErrors.length > 0) {
      return {
        ...resource,
        enabled: false,
        status: "skipped",
        reason: claim.diagnostic?.reason ?? serverErrors.join("; "),
      };
    }
    if (claim.disabled || !claim.server) {
      return {
        ...resource,
        enabled: false,
        status: "disabled",
        reason: "Disabled in the admitted configuration.",
      };
    }
    return {
      ...resource,
      enabled: true,
      status: "admitted",
    };
  });
  const diagnostics = groups.flatMap((group) =>
    group.effective.skipped.filter((entry) => skippedName(entry.path) === undefined)
      .map((entry) => ({
        source: group.source,
        path: mcpSourcePath(group, entry.path),
        reason: entry.reason,
      })));
  return {
    rows: rows.sort(byPrecedenceThenName),
    diagnostics,
  };
}

export function buildSessionResourceView(input: {
  runtime: ConversationRuntime;
  skillGroups: readonly SessionSkillGroup[];
  mcpGroups?: readonly SessionMcpGroup[];
  mcpServers?: readonly SessionMcpView[];
  mcpDiagnostics?: readonly SessionResourceDiagnostic[];
}): SessionResourceView {
  const diagnostics = input.skillGroups.flatMap((group) => group.diagnostics ?? []);
  const skills = skillView(input.skillGroups);
  const mcp = input.mcpGroups
    ? mcpViews(input.mcpGroups)
    : { rows: [...(input.mcpServers ?? [])], diagnostics: [...(input.mcpDiagnostics ?? [])] };
  return {
    runtime: input.runtime,
    skills,
    diagnostics,
    mcpServers: mcp.rows,
    mcpDiagnostics: mcp.diagnostics,
  };
}

export function replaceSessionMcpView(
  current: SessionResourceView,
  groups: readonly SessionMcpGroup[],
): SessionResourceView {
  const mcp = mcpViews(groups);
  return {
    ...current,
    mcpServers: mcp.rows,
    mcpDiagnostics: mcp.diagnostics,
  };
}
