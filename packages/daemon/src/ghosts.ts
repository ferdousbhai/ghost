/**
 * Ghost registry — discovery, creation, and validation of ghost homes.
 *
 * A ghost is one directory under the ghosts root (default `~/Ghosts/`), laid
 * out per `ghost-home/v1` in CONTRACTS.md. The registry owns only the shape
 * of that directory; reading its *contents* (character, docs, memory) is
 * `@ghost/extensions`' job.
 *
 * Everything the daemon adds for itself lives in dot-directories inside the
 * ghost home (`.sessions/`, `.pi/`) so the creator's default view of their
 * own ghost stays the plain files they wrote.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** One discovered ghost, as served by `GET /api/ghosts`. */
export interface Ghost {
  name: string;
  dir: string;
  createdAt: string;
}

/** Directory names the daemon owns inside a ghost home. */
export const GHOST_SESSIONS_DIRNAME = ".sessions";
export const GHOST_AGENT_DIRNAME = ".pi";
export const GHOST_CHARACTER_FILENAME = "character.md";

/**
 * Where a deleted ghost goes when the freedesktop home trash is on another
 * filesystem (`EXDEV`) — a dot-directory inside the ghosts root, so `list()`
 * skips it and a trashed ghost is gone from the API while its files are still
 * on disk. The ordinary path is the home trash; see `GhostRegistry.trash`.
 */
export const GHOST_TRASH_DIRNAME = ".trash";

/**
 * Ghost names are both URL path segments and directory names, so the
 * character set is deliberately narrow: no separators, no leading dot, no
 * whitespace, no percent-encoding games.
 */
const GHOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class GhostError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "GhostError";
    this.code = code;
    this.status = status;
  }
}

export function isValidGhostName(name: string): boolean {
  if (!GHOST_NAME_PATTERN.test(name)) return false;
  // The pattern already forbids a leading dot, but be explicit about the
  // traversal shapes: a name is never allowed to mean "somewhere else".
  return name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

export function assertValidGhostName(name: string): void {
  if (!isValidGhostName(name)) {
    throw new GhostError(
      "invalid_name",
      `Ghost names must be 1-64 characters of letters, digits, ".", "_", or "-", `
        + `and may not start with a dot (got ${JSON.stringify(name)}).`,
      400,
    );
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A directory is a ghost home when it exists and holds a `character.md`.
 * The persona file is the one thing a ghost cannot be without — docs,
 * memory, and conversations are all optional and may be empty.
 */
export function isGhostHome(dir: string): boolean {
  return isDirectory(dir) && isFile(join(dir, GHOST_CHARACTER_FILENAME));
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** `20260824-153000` — local time, sortable, and safe in a directory name. */
function trashStamp(now: Date): string {
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`
    + `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
}

/**
 * The freedesktop "home trash": `$XDG_DATA_HOME/Trash`, defaulting to
 * `~/.local/share/Trash`. Read at call time, not at import, so a test (or a
 * user changing their XDG layout) is honoured by the next deletion.
 */
export function homeTrashDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share");
  return join(base, "Trash");
}

/**
 * `.trashinfo` `Path=` is a URI path: percent-encode everything a URI path may
 * not carry raw, keep `/` as the separator. `encodeURIComponent` gives UTF-8
 * percent-encoding for non-ASCII and control characters; putting the slashes
 * back is what makes it a path rather than one escaped segment.
 */
function encodeTrashInfoPath(path: string): string {
  return encodeURIComponent(path).replaceAll("%2F", "/");
}

/** `2026-08-24T15:30:00` — local time with no zone suffix, per the spec. */
function deletionDate(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
    + `T${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

function createdAtOf(dir: string): string {
  const stats = statSync(dir);
  // birthtime is 0 on filesystems that do not record it; mtime is the
  // honest fallback.
  const birth = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
  return new Date(birth).toISOString();
}

/** Absolute paths the daemon derives from a ghost home. */
export function ghostPaths(dir: string): {
  home: string;
  agentDir: string;
  sessionDir: string;
  characterFile: string;
} {
  const home = resolve(dir);
  const agentDir = join(home, GHOST_AGENT_DIRNAME);
  return {
    home,
    agentDir,
    sessionDir: join(home, GHOST_SESSIONS_DIRNAME),
    characterFile: join(home, GHOST_CHARACTER_FILENAME),
  };
}

const SEEDED_CHARACTER = (name: string) => `---
title: ${name}
---

# ${name}

You are ${name}.

## Voice

Write in the first person. Be specific and concrete; prefer the detail you
actually remember over a general statement you could have made about anything.

## What you know

Your docs and memory files are yours. Read them before you answer a question
they cover, and write a memory file when you learn something worth keeping.
`;

/**
 * The character file's raw bytes, or null when the ghost has none.
 *
 * Raw rather than parsed on purpose: both callers are asking "has the owner
 * been here yet", which is a question about the file as written, not about the
 * persona it parses into.
 */
export function readCharacterFile(dir: string): string | null {
  try {
    return readFileSync(ghostPaths(dir).characterFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * True when `text` is still the file `GhostRegistry.create` wrote — the ghost
 * has been summoned but never met.
 *
 * A populated character file is the durable "this ghost has been onboarded"
 * latch. There is deliberately no flag file beside it: a flag would be a second
 * source of truth about a question the character file already answers, and the
 * two would drift the first time somebody edited one of them by hand.
 *
 * Missing and blank both count as seeded. An empty character.md is not a persona
 * somebody wrote; it is the same "the owner has not been here" the seed means.
 *
 * The comparison is exact. `@ghost/extensions` has its own advisory
 * `isSeededCharacterBody` (it cannot import the daemon, so it matches marker
 * lines instead); this is the authoritative one, and it is deliberately the
 * stricter of the two — being wrong here means offering onboarding to a ghost
 * that has already been written, which is worse than missing it once.
 */
export function isSeededCharacter(name: string, text: string | null | undefined): boolean {
  if (text === null || text === undefined) return true;
  if (text.trim() === "") return true;
  return text === SEEDED_CHARACTER(name);
}

export class GhostRegistry {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Create the ghosts root if it does not exist yet. Idempotent. */
  ensureRoot(): void {
    mkdirSync(this.root, { recursive: true });
  }

  /**
   * Every ghost under the root, name-sorted. Non-directories, dot-directories
   * (the daemon's own state), and directories without a `character.md` are
   * skipped rather than reported as errors — the root is a user directory and
   * may hold anything.
   */
  list(): Ghost[] {
    let entries: string[];
    try {
      entries = readdirSync(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const ghosts: Ghost[] = [];
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      if (!isValidGhostName(name)) continue;
      const dir = join(this.root, name);
      if (!isGhostHome(dir)) continue;
      ghosts.push({ name, dir, createdAt: createdAtOf(dir) });
    }
    return ghosts.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** One ghost by name, or null when it does not exist. */
  find(name: string): Ghost | null {
    if (!isValidGhostName(name)) return null;
    const dir = join(this.root, name);
    if (!isGhostHome(dir)) return null;
    return { name, dir, createdAt: createdAtOf(dir) };
  }

  /** One ghost by name, or a structured 404. */
  get(name: string): Ghost {
    assertValidGhostName(name);
    const ghost = this.find(name);
    if (!ghost) {
      throw new GhostError("not_found", `No ghost named ${JSON.stringify(name)}.`, 404);
    }
    return ghost;
  }

  /**
   * Create `<root>/<name>/` with a seeded `character.md` and the empty
   * `ghost-home/v1` directories. Refuses to overwrite an existing ghost.
   */
  create(name: string): Ghost {
    assertValidGhostName(name);
    const dir = join(this.root, name);
    if (isGhostHome(dir)) {
      throw new GhostError("already_exists", `A ghost named ${JSON.stringify(name)} already exists.`, 409);
    }
    mkdirSync(dir, { recursive: true });
    for (const sub of ["docs", "memory", "conversations"]) {
      mkdirSync(join(dir, sub), { recursive: true });
    }
    writeFileSync(join(dir, GHOST_CHARACTER_FILENAME), SEEDED_CHARACTER(name), {
      encoding: "utf8",
      // Fail rather than clobber a character.md that appeared between the
      // isGhostHome() check and here.
      flag: "wx",
    });
    return { name, dir, createdAt: createdAtOf(dir) };
  }

  /**
   * Move `<root>/<name>/` into the freedesktop home trash and return where it
   * went — `<trash>/files/<name>`, with a `<trash>/info/<name>.trashinfo`
   * recording where it came from. A deleted ghost is therefore an ordinary
   * trashed directory: `gio trash --list`, `gio trash --restore`, and every
   * file manager's Trash see it and can put it back.
   *
   * Deleting a ghost is a rename, never a recursive removal: the ghost home
   * holds the only copy of a persona, its memory, and its docs, and no HTTP
   * route may be one bug away from erasing that. That also fixes the failure
   * mode when the trash is on another filesystem — a cross-device `rename`
   * raises `EXDEV`, and rather than degrade into copy-then-delete we fall back
   * to `<root>/.trash/<name>-<stamp>/`, still a move.
   */
  trash(name: string, now: Date = new Date()): { trash: string } {
    const ghost = this.get(name);
    const trashDir = homeTrashDir();
    const filesDir = join(trashDir, "files");
    const infoDir = join(trashDir, "info");
    // 0700: a trash holds whatever the deleted files held.
    for (const dir of [trashDir, filesDir, infoDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });

    const info = `[Trash Info]\nPath=${encodeTrashInfoPath(ghost.dir)}\n`
      + `DeletionDate=${deletionDate(now)}\n`;
    // Creating the .trashinfo with "wx" IS the claim on the trash name: it is
    // the one atomic step, so two deletions racing for `<name>` cannot both
    // win. `<name>.2`, `<name>.3`, … on collision, gio's convention.
    let trashName = name;
    let infoPath = join(infoDir, `${trashName}.trashinfo`);
    let target = join(filesDir, trashName);
    for (let suffix = 2; ; suffix += 1) {
      try {
        writeFileSync(infoPath, info, { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        trashName = `${name}.${suffix}`;
        infoPath = join(infoDir, `${trashName}.trashinfo`);
        target = join(filesDir, trashName);
        continue;
      }
      // An orphaned `files/` entry with no `.trashinfo` is somebody else's
      // mess, but renaming onto it would still lose their data. Step past it.
      if (!existsSync(target)) break;
      unlinkSync(infoPath);
      trashName = `${name}.${suffix}`;
      infoPath = join(infoDir, `${trashName}.trashinfo`);
      target = join(filesDir, trashName);
    }

    try {
      renameSync(ghost.dir, target);
    } catch (error) {
      // Never leave a .trashinfo describing a file that is not in the trash.
      try {
        unlinkSync(infoPath);
      } catch {
        // Nothing to do about it; the rename's error is the one that matters.
      }
      if ((error as NodeJS.ErrnoException).code === "EXDEV") return this.trashInRoot(ghost, now);
      throw error;
    }
    return { trash: target };
  }

  /**
   * The `EXDEV` fallback: `<root>/.trash/<name>-<stamp>/`, beside the ghosts
   * rather than in the home trash. Invisible to trash tools, but still a move,
   * and `list()` skips dot-directories so the ghost is gone from the API and a
   * plain `mv` brings it back.
   */
  private trashInRoot(ghost: Ghost, now: Date): { trash: string } {
    const trashRoot = join(this.root, GHOST_TRASH_DIRNAME);
    mkdirSync(trashRoot, { recursive: true });
    const base = join(trashRoot, `${ghost.name}-${trashStamp(now)}`);
    let target = base;
    // The stamp has second resolution; a name deleted, re-created, and deleted
    // again inside one second must not overwrite its own earlier copy.
    for (let suffix = 2; existsSync(target); suffix += 1) target = `${base}-${suffix}`;
    renameSync(ghost.dir, target);
    return { trash: target };
  }
}
