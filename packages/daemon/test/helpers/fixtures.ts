/**
 * Temp-directory fixtures: a ghosts root, a ghost home, and the SSE reader
 * the pinned pi-messages client uses.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GhostRegistry, ghostPaths } from "../../src/ghosts.js";
import { openAiCompatiblePreset, writeGhostModels } from "../../src/models.js";
import type { PiMessagesEvent } from "../../src/pi-messages.js";

export interface TempGhosts {
  root: string;
  registry: GhostRegistry;
  cleanup(): void;
}

export function makeTempGhosts(): TempGhosts {
  const root = mkdtempSync(join(tmpdir(), "ghostd-test-"));
  return {
    root,
    registry: new GhostRegistry(root),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface SeedGhostOptions {
  name?: string;
  character?: string;
  notes?: Record<string, string>;
  memory?: Record<string, string>;
  /** Wire the ghost to a mock provider. */
  provider?: { baseUrl: string; modelId: string; providerId?: string };
}

/** A ghost home with a persona, optional notes/memory, and a models.json. */
export function seedGhost(root: string, options: SeedGhostOptions = {}): string {
  const name = options.name ?? "casper";
  const dir = join(root, name);
  const paths = ghostPaths(dir);
  mkdirSync(join(dir, "notes"), { recursive: true });
  mkdirSync(join(dir, "memory"), { recursive: true });
  mkdirSync(join(dir, "conversations"), { recursive: true });
  writeFileSync(
    paths.characterFile,
    options.character
      ?? `---\npublic: true\ntitle: ${name}\n---\n\n# ${name}\n\nYou are ${name}, a letterpress printer.\n`,
    "utf8",
  );
  for (const [path, content] of Object.entries(options.notes ?? {})) {
    const full = join(dir, "notes", path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  for (const [path, content] of Object.entries(options.memory ?? {})) {
    writeFileSync(join(dir, "memory", path), content, "utf8");
  }
  if (options.provider) {
    mkdirSync(paths.agentDir, { recursive: true });
    writeGhostModels(
      paths.agentDir,
      openAiCompatiblePreset({
        providerId: options.provider.providerId ?? "ghost-local",
        baseUrl: options.provider.baseUrl,
        modelId: options.provider.modelId,
        // Keyless local server; pi still wants a non-empty key on the wire.
        apiKey: "not-needed",
      }),
    );
  }
  return dir;
}

/**
 * Parse an SSE body exactly the way `@earendil-works/pi-ai`'s pi-messages
 * client does: split on a blank line, take the first `data:` line of each
 * frame, ignore `[DONE]`, ignore frames with no data line (keepalives).
 */
export function parseSseStream(body: string): PiMessagesEvent[] {
  const events: PiMessagesEvent[] = [];
  for (const frame of body.replace(/\r\n/g, "\n").split("\n\n")) {
    if (!frame.trim()) continue;
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim();
    if (!data || data === "[DONE]") continue;
    events.push(JSON.parse(data) as PiMessagesEvent);
  }
  return events;
}
