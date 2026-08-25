import { basename, join } from "node:path";
import { openGhostHome } from "@ghost/extensions";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentSource } from "@oh-my-pi/pi-coding-agent/task/types";

export interface GhostContextCharacter {
  path: "character.md";
  title: string | null;
}

export interface GhostContextDoc {
  path: string;
  relativePath: string;
  title: string;
  tags: string[];
  archived: boolean;
}

export interface GhostContextMemory {
  path: string;
  slug: string;
  description: string;
  content: string;
  updated: string | null;
}

export interface GhostContextAgent {
  name: string;
  description: string;
  source: AgentSource;
  tools: string[] | null;
  model: string[];
  spawns: string[] | "*" | null;
}

export interface GhostContextSkipped {
  section: "docs" | "memory";
  path: string;
  reason: string;
}

export interface GhostContextSnapshot {
  character: GhostContextCharacter;
  docs: GhostContextDoc[];
  memory: GhostContextMemory[];
  agents: GhostContextAgent[];
  skipped: GhostContextSkipped[];
}

export async function readGhostContext(dir: string): Promise<GhostContextSnapshot> {
  const home = openGhostHome(dir);
  const [character, docListing, memoryListing, discovery, settings] = await Promise.all([
    home.readCharacter(),
    home.listDocs(),
    home.listMemory(),
    discoverAgents(dir),
    Settings.loadReadOnly({ cwd: dir, agentDir: join(dir, ".pi") }),
  ]);

  const disabledAgents = new Set(settings.get("task.disabledAgents"));
  const docs = docListing.docs
    .map<GhostContextDoc>((doc) => ({
      path: `docs/${doc.path}`,
      relativePath: doc.path,
      title: doc.title ?? basename(doc.path, ".md"),
      tags: [...doc.tags],
      archived: doc.archived,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const memory = memoryListing.files
    .map<GhostContextMemory>((record) => ({
      path: `memory/${record.slug}.md`,
      slug: record.slug,
      description: record.description,
      content: record.content,
      updated: record.updated ?? null,
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
  const agents = discovery.agents
    .filter((agent) => !disabledAgents.has(agent.name))
    .map<GhostContextAgent>((agent) => ({
      name: agent.name,
      description: agent.description,
      source: agent.source,
      tools: agent.tools && agent.tools.length > 0 ? [...agent.tools] : null,
      model: agent.model ? [...agent.model] : [],
      spawns: agent.spawns === "*" ? "*" : agent.spawns ? [...agent.spawns] : null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const skipped: GhostContextSkipped[] = [
    ...docListing.skipped.map((entry) => ({ section: "docs" as const, ...entry })),
    ...memoryListing.skipped.map((entry) => ({ section: "memory" as const, ...entry })),
  ].sort((left, right) => left.path.localeCompare(right.path));

  return {
    character: { path: "character.md", title: character?.title ?? null },
    docs,
    memory,
    agents,
    skipped,
  };
}
