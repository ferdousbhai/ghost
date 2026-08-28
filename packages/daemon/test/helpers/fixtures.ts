/**
 * Temp-directory fixtures: a ghosts root, a ghost home, and the SSE reader
 * the pinned pi-messages client uses.
 */
import { afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GhostRegistry, ghostPaths } from "../../src/ghosts.js";
import { openAiCompatiblePreset, writeGhostModels } from "../../src/models.js";
import type { PiMessagesEvent } from "../../src/pi-messages.js";

export interface TempGhosts {
  root: string;
  xdgDataHome: string;
  /** The freedesktop home trash under it — where a deleted ghost lands. */
  trashDir: string;
  documentsDir: string;
  ownerHome: string;
  registry: GhostRegistry;
  cleanup(): void;
}

/**
 * A temp ghosts root, plus temp XDG data and Documents roots for the duration.
 *
 * Deleting a ghost moves it into the freedesktop home trash, so every test
 * that can reach `trash()` must have `XDG_DATA_HOME` pointed somewhere
 * disposable: a leak here would put test ghosts in the developer's own
 * `~/.local/share/Trash`. Session prompts must likewise never index the
 * developer's real Documents. `cleanup()` restores both previous values.
 */
export function makeTempGhosts(): TempGhosts {
  const root = mkdtempSync(join(tmpdir(), "ghostd-test-"));
  const xdgDataHome = mkdtempSync(join(tmpdir(), "ghostd-test-xdg-"));
  const previousXdg = process.env.XDG_DATA_HOME;
  const previousDocuments = process.env.XDG_DOCUMENTS_DIR;
  const documentsDir = join(root, ".documents");
  const ownerHome = join(root, ".owner");
  mkdirSync(ownerHome, { recursive: true });
  process.env.XDG_DATA_HOME = xdgDataHome;
  process.env.XDG_DOCUMENTS_DIR = documentsDir;
  let restored = false;
  return {
    root,
    xdgDataHome,
    trashDir: join(xdgDataHome, "Trash"),
    documentsDir,
    ownerHome,
    registry: new GhostRegistry(root),
    cleanup: () => {
      // Idempotent: a test may clean up early and the afterEach hook again.
      if (!restored) {
        restored = true;
        if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousXdg;
        if (previousDocuments === undefined) delete process.env.XDG_DOCUMENTS_DIR;
        else process.env.XDG_DOCUMENTS_DIR = previousDocuments;
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(xdgDataHome, { recursive: true, force: true });
    },
  };
}

export interface SeedGhostOptions {
  name?: string;
  character?: string;
  docs?: Record<string, string>;
  memory?: Record<string, string>;
  provider?: { baseUrl: string; modelId: string; providerId?: string };
}

/** A ghost home with a persona, optional legacy docs, memory, and a models.json. */
export function seedGhost(root: string, options: SeedGhostOptions = {}): string {
  const name = options.name ?? "casper";
  const dir = join(root, name);
  const paths = ghostPaths(dir);
  if (options.docs) mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "memory"), { recursive: true });
  mkdirSync(join(dir, "conversations"), { recursive: true });
  writeFileSync(
    paths.characterFile,
    options.character
      ?? `# ${name}\n\nYou are ${name}, a letterpress printer.\n`,
    "utf8",
  );
  for (const [path, content] of Object.entries(options.docs ?? {})) {
    const full = join(dir, "docs", path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  for (const [path, content] of Object.entries(options.memory ?? {})) {
    writeFileSync(join(dir, "memory", path), content, "utf8");
  }
  if (options.provider) {
    mkdirSync(paths.agentDir, { recursive: true });
    writeGhostModels(
      paths.home,
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
 * Parse an SSE body according to Ghost's pi-messages contract: split on a
 * blank line, take the first `data:` line of each
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

/** A LIFO cleanup stack drained after each test in the calling file. */
export function useCleanups(): { push(cleanup: () => void | Promise<void>): void } {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  return { push: (cleanup) => cleanups.push(cleanup) };
}

/** A private temporary directory, removed by `cleanup`. */
export function tempDir(prefix = "ghostd-test-"): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
