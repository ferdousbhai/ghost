import { openGhostHome } from "@ghost/extensions";
import type { AgentSource } from "./declarative-types.js";

export interface GhostContextCharacter {
  path: "character.md";
  title: string | null;
}

export interface GhostContextMemory {
  path: string;
  slug: string;
  description: string;
  content: string;
  updated: string;
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
  section: "memory";
  path: string;
  reason: string;
}

export interface GhostContextSnapshot {
  character: GhostContextCharacter;
  memory: GhostContextMemory[];
  agents: GhostContextAgent[];
  skipped: GhostContextSkipped[];
}

export async function readGhostContext(dir: string): Promise<GhostContextSnapshot> {
  const home = openGhostHome(dir);
  const [character, memoryListing] = await Promise.all([
    home.readCharacter(),
    home.listMemory(),
  ]);

  const memory = memoryListing.files
    .map<GhostContextMemory>((record) => ({
      path: `memory/${record.slug}.md`,
      slug: record.slug,
      description: record.description,
      content: record.content,
      updated: record.updated,
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
  const skipped: GhostContextSkipped[] = [
    ...memoryListing.skipped.map((entry) => ({ section: "memory" as const, ...entry })),
  ].sort((left, right) => left.path.localeCompare(right.path));

  return {
    character: { path: "character.md", title: character?.title ?? null },
    memory,
    agents: [],
    skipped,
  };
}
