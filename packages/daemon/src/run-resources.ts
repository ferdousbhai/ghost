/** A harness-reported inventory, not a scan of installed or enabled resources. */
export interface RunResources {
  contextFiles?: string[] | null;
  tools?: string[] | null;
  promptTemplates?: string[] | null;
  skills: string[] | null;
  extensions: string[] | null;
  mcpServers: string[] | null;
}

export function unreportedResources(): RunResources {
  return { skills: null, extensions: null, mcpServers: null };
}

/** Only names cross the wire: never plugin paths, server config, or credentials. */
export function resourceNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 256) return null;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim() || item.length > 256 || [...item].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
    if (!names.includes(item)) names.push(item);
  }
  return names;
}

/** Names from Codex's own rendered skill catalog in a rollout world_state. */
export function codexSkillNames(body: unknown): string[] | null {
  if (typeof body !== "string" || body.length > 200_000) return null;
  const heading = "### Available skills\n";
  const start = body.indexOf(heading);
  if (start < 0) return null;
  const catalog = body.slice(start + heading.length).split(/^### /mu)[0] ?? "";
  const names = catalog.split("\n").filter((line) => line.startsWith("- "))
    .map((line) => /^- (.+?): .+ \(file: .+\)$/u.exec(line)?.[1]);
  if (names.length === 0 && catalog.trim() !== "") return null;
  return resourceNames(names);
}

export function resourceSummary(harness: string, resources: RunResources): string {
  const lines = [
    ["Instructions/context files", resources.contextFiles],
    ["Skills", resources.skills],
    ["Extensions/plugins", resources.extensions],
    ["Connected MCP servers", resources.mcpServers],
    ["Tools", resources.tools],
    ["Prompt templates", resources.promptTemplates],
  ].flatMap(([label, names]) => Array.isArray(names) && names.length ? [`${label}: ${names.join(", ")}`] : []);
  return lines.length ? `${harness} · Run resources\n${lines.join("\n")}` : "";
}

export interface RunResourceSnapshot {
  run: string;
  harness: string;
  at: string;
  resources: RunResources;
  supplied?: { instructions: string[]; mcpServers: string[] };
  summary: string;
}

export function snapshotSummary(snapshot: RunResourceSnapshot): string {
  const sections = [`Last successful run: ${snapshot.harness}\n${snapshot.at}`];
  if (snapshot.supplied) {
    const lines = [
      snapshot.supplied.instructions.length ? `Instructions: ${snapshot.supplied.instructions.join(", ")}` : "",
      snapshot.supplied.mcpServers.length ? `MCP toolsets: ${snapshot.supplied.mcpServers.join(", ")}` : "",
    ].filter(Boolean);
    if (lines.length) sections.push(`Supplied by Ghost\n${lines.join("\n")}`);
  }
  const reported = resourceSummary(snapshot.harness, snapshot.resources).split("\n").slice(1).join("\n");
  sections.push(reported ? `Reported by harness\n${reported}` : "No named resources reported by this run.");
  return sections.join("\n\n");
}
