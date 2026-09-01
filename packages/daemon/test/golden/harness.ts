/**
 * Golden end-to-end session fixtures — the tripwire for issue #3's strip phase.
 *
 * The unit suites next door assert *properties* ("the persona contains the
 * character body", "the memory writer persists a file"). Those survive a refactor that
 * quietly changes everything else about a turn. These fixtures assert the
 * opposite thing: this exact scripted conversation produces this exact
 * observable behaviour, byte for byte, and any drift shows up as a diff.
 *
 * That makes them the safety net for deleting vendored OMP subsystems: a strip
 * that silently drops a prompt section, reorders the tool surface, changes an
 * event shape, or stops writing a file fails here even though no property test
 * was ever written for it.
 *
 * ## What a fixture records
 *
 * Only surfaces Ghost owns or can pin:
 *
 * - **The complete system prompt** sent through the provider-neutral Pi path.
 * - **The tool surface**, both as advertised on the wire and as the session's
 *   active registry reports it.
 * - **The pi-messages event stream** of every turn, canonicalised.
 * - **The rendered transcript** and the conversation listing.
 * - **The ghost home on disk** after the conversation, including the names of
 *   opaque runtime artifacts owned there.
 *
 * ## What is deliberately excluded, and why
 *
 * - **`agentDir` internals** — `.pi/models.db`, the `sessions/*.jsonl`
 *   transcripts. Binary/SQLite and full of ids and clock values; the rendered
 *   transcript is the same information in a stable shape.
 * - **Wall-clock everything**: entry timestamps, `createdAt`/`updatedAt`, the
 *   greeting's `localTime`. Normalised to placeholders (the greeting fixture
 *   pins a clock explicitly instead, so the prompt text stays real).
 * - **Entry ids** are content-addressed hashes over timestamped entries, so
 *   they are re-mapped to first-seen ordinals `#1`, `#2`, … which still pins
 *   the parent/child *shape* of the branch tree.
 * - **Absolute paths**: the temp ghosts root is a fresh mkdtemp every run.
 * - **Tool presentation.** Ghost composes Pi's native tools with its custom
 *   tools. The fixture records a *presence table* over a named universe of
 *   tools (`toolSurfaceTable`) rather than the raw list, so a strip that drops
 *   or renames a tool still fails without pinning unrelated catalogue growth.
 *   Ambient machine MCP is no longer a source of variation: focused SessionHost
 *   tests pin the visible ghost config plus the explicitly bound project
 *   snapshot.
 *
 * Tool-call ids (`call_1`, …) and token usage are NOT normalised: the mock
 * provider mints both deterministically, so a change there is a real change.
 *
 * ## Regenerating
 *
 *     UPDATE_GOLDEN=1 pnpm --filter @ghost/daemon test test/golden
 *
 * Review the resulting diff like any other diff — that diff *is* the behavioural
 * change the strip introduced.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { GHOST_AGENT_DIRNAME, GHOST_SESSIONS_DIRNAME } from "../../src/ghosts.js";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

export const REGENERATE_HINT =
  "To accept this as the new expected behaviour, regenerate the fixtures with:\n"
  + "  UPDATE_GOLDEN=1 pnpm --filter @ghost/daemon test test/golden\n"
  + "and review the resulting diff.";

function updating(): boolean {
  return process.env.UPDATE_GOLDEN === "1" || process.env.UPDATE_GOLDEN === "true";
}


const CLOCK_KEYS = new Set([
  "timestamp",
  "timestamps",
  "createdAt",
  "updatedAt",
  "startedAt",
  "finishedAt",
  "expires",
  "expiresAt",
]);

const DURATION_KEYS = new Set(["durationMs", "elapsedMs", "tookMs", "latencyMs"]);

const ENTRY_ID_KEYS = new Set(["entryId", "parentId", "resultEntryId", "previousTargetId", "nextTargetId"]);

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

/**
 * Today, plus its neighbours, as `YYYY-MM-DD`. Three days rather than one so a
 * run that straddles midnight — or a writer that stamps UTC while the machine
 * is not on it — still normalises to the same placeholder.
 */
function todayish(): ReadonlySet<string> {
  const now = Date.now();
  return new Set([-86_400_000, 0, 86_400_000].map((offset) => {
    const date = new Date(now + offset);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }));
}

/**
 * Rewrites the volatile parts of one run into placeholders. One instance per
 * fixture, so the entry-id ordinals are scoped to that conversation.
 */
export class Normalizer {
  private readonly paths: Array<[string, string]> = [];
  private readonly entryIds = new Map<string, string>();

  path(absolute: string, placeholder: string): this {
    this.paths.push([absolute, placeholder]);
    this.paths.sort((a, b) => b[0].length - a[0].length);
    return this;
  }

  entryId(raw: string | null): string {
    if (raw === null) return "<none>";
    const existing = this.entryIds.get(raw);
    if (existing) return existing;
    const label = `#${this.entryIds.size + 1}`;
    this.entryIds.set(raw, label);
    return label;
  }

  text(value: string): string {
    let out = value;
    for (const [absolute, placeholder] of this.paths) {
      out = out.split(absolute).join(placeholder);
    }
    return out.replace(ISO_TIMESTAMP, "<timestamp>");
  }

  /**
   * Canonicalise a value for serialisation: keys sorted, volatile fields
   * replaced, strings path-normalised. Arrays keep their order — order is
   * behaviour.
   */
  value(input: unknown): unknown {
    if (typeof input === "string") return this.text(input);
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map((item) => this.value(item));
    const source = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const raw = source[key];
      if (raw === undefined) continue;
      if (CLOCK_KEYS.has(key)) {
        out[key] = "<time>";
      } else if (DURATION_KEYS.has(key)) {
        out[key] = "<duration>";
      } else if (ENTRY_ID_KEYS.has(key)) {
        out[key] = typeof raw === "string" ? this.entryId(raw) : this.entryId(null);
      } else {
        out[key] = this.value(raw);
      }
    }
    return out;
  }

  line(input: unknown): string {
    return JSON.stringify(this.value(input));
  }

  json(input: unknown): string {
    return JSON.stringify(this.value(input), null, 2);
  }
}

/**
 * Every plain file under a ghost home, as `--- path ---` then its content,
 * sorted by path.
 *
 * Two directories are listed by name only, never by content:
 * `.pi/` (derived Pi runtime state) and `sessions/` (raw Pi transcripts, full
 * of ids and clock values; the rendered transcript covers the same ground in
 * a stable shape). Listing their *filenames* still pins the contract that
 * sessions and derived agent state live inside the ghost home — and that
 * credentials do not: no `agent.db` is created there any more.
 *
 * The remaining visible files pin this fixture's ghost-owned persona, memory,
 * and policy state. Owner-shared Obsidian notes and Claude's native transcript
 * have separate lifecycles and deliberately are not represented here.
 */
export function ghostHomeSnapshot(
  dir: string,
  normalizer: Normalizer,
  opaqueDirs: readonly string[] = [GHOST_AGENT_DIRNAME, GHOST_SESSIONS_DIRNAME],
): string {
  const blocks: string[] = [];
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      const isDir = statSync(full).isDirectory();
      if (isDir && current === dir && opaqueDirs.includes(entry)) {
        // SQLite's -wal/-shm sidecars come and go with checkpointing, so their
        // presence is not behaviour; everything else in these directories is.
        const names = readdirSync(full)
          .filter((name) => !/-(?:wal|shm|journal)$/.test(name))
          .sort()
          .join(", ");
        blocks.push(`--- ${entry}/ (contents not compared) ---\n${names || "(empty)"}`);
        continue;
      }
      if (isDir) {
        walk(full);
        continue;
      }
      files.push(full);
    }
  };
  walk(dir);
  for (const full of files.sort()) {
    const rel = relative(dir, full).split(sep).join("/");
    // Normalize dated metadata from runtime sidecars. Memory files contain only
    // their fact, so no writer-stamped frontmatter date exists here.
    const content = normalizer
      .text(readFileSync(full, "utf8"))
      .replace(
        /^(updated|created|date):[ \t]*(\d{4}-\d{2}-\d{2})(.*)$/gm,
        (whole, key: string, date: string, rest: string) =>
          (todayish().has(date) ? `${key}: <today>${rest}` : whole),
      );
    blocks.push(`--- ${rel} ---\n${content}`);
  }
  return blocks.length > 0 ? blocks.join("\n") : "(empty)";
}

/**
 * A presence table over a named universe of tool names.
 *
 * `registry` is what `session.getActiveToolNames()` reports; `wire` is what was
 * advertised to the model in the request body. Ghost registers its custom
 * tools directly beside Pi's native tools, so the fixture pins both views and
 * makes any accidental divergence visible.
 *
 * Names outside `universe` are counted, never listed — see the header on why a
 * session's raw tool list is not portable.
 */
export function toolSurfaceTable(
  universe: readonly string[],
  registry: readonly string[],
  wire: readonly string[],
  resolvable?: (name: string) => boolean,
): string {
  const inRegistry = new Set(registry);
  const onWire = new Set(wire);
  const width = Math.max(...universe.map((name) => name.length));
  const yn = (value: boolean) => (value ? "yes" : "no ");
  const rows = [...universe].sort().map((name) =>
    `${name.padEnd(width)}  registry=${yn(inRegistry.has(name))}  wire=${yn(onWire.has(name))}`
    + (resolvable ? `  invokable=${yn(resolvable(name)).trimEnd()}` : ""));
  // Deliberately not a count: how many extras a machine contributes is exactly
  // the part that is not portable.
  rows.push("(tools outside this universe are not compared)");
  return rows.join("\n");
}


export interface GoldenSection {
  readonly title: string;
  readonly body: string;
}

const RULE = "=".repeat(78);

function render(name: string, sections: readonly GoldenSection[]): string {
  const header = [
    RULE,
    `GOLDEN FIXTURE: ${name}`,
    RULE,
    "Generated by packages/daemon/test/golden — do not hand-edit.",
    "Regenerate: UPDATE_GOLDEN=1 pnpm --filter @ghost/daemon test test/golden",
    "",
  ].join("\n");
  const body = sections
    .map((section) => `${"-".repeat(78)}\n[${section.title}]\n${"-".repeat(78)}\n${section.body.replace(/\s+$/, "")}\n`)
    .join("\n");
  return `${header}\n${body}`;
}

/**
 * Compare a rendered document against `fixtures/<name>.golden.txt`.
 *
 * With `UPDATE_GOLDEN=1` the fixture is (re)written and the assertion is
 * skipped; otherwise a mismatch fails with vitest's diff plus the regeneration
 * command.
 */
export function expectGolden(name: string, sections: readonly GoldenSection[]): void {
  const actual = render(name, sections);
  const file = join(FIXTURE_DIR, `${name}.golden.txt`);
  if (updating()) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(file, actual, "utf8");
    return;
  }
  if (!existsSync(file)) {
    throw new Error(`Missing golden fixture ${file}.\n${REGENERATE_HINT}`);
  }
  const expected = readFileSync(file, "utf8");
  expect(
    actual,
    `Golden fixture "${name}" no longer matches observed behaviour.\n${REGENERATE_HINT}`,
  ).toBe(expected);
}
