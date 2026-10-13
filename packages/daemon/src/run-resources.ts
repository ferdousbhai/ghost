/** A harness-reported inventory, not a scan of installed or enabled resources. */
export interface RunResources {
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

export function resourceSummary(harness: string, resources: RunResources): string {
  const list = (names: string[] | null) => names === null ? "not reported" : names.length ? names.join(", ") : "none";
  return `${harness} · Run resources\nSkills: ${list(resources.skills)}\nExtensions/plugins: ${list(resources.extensions)}\nConnected MCP servers: ${list(resources.mcpServers)}`;
}
