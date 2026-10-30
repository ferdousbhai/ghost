/**
 * What the owner was looking at when they summoned the ghost: the HUD records
 * the focused window before its prompt takes focus and sends it with that one
 * prompt. It reaches the harness as hidden context for the turn's first pass
 * and is never logged; see CONTRACTS.md, "Daemon HTTP API".
 */
import { GhostError } from "./errors.js";

export interface DesktopContext {
  /** The window's application id (Hyprland's class). */
  app?: string;
  /** The window title, which can carry a running command's arguments. */
  title?: string;
  /** A focused terminal's shell directory. */
  cwd?: string;
}

const LIMITS = { app: 256, title: 1024, cwd: 4096 } as const;

/** `desktop` from a turn request: absent or null is none; anything malformed is refused. */
export function parseDesktopContext(value: unknown): DesktopContext | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new GhostError("invalid_request", "\"desktop\" must be an object.", 400);
  }
  const context: DesktopContext = {};
  for (const [key, field] of Object.entries(value)) {
    if (!(key in LIMITS)) throw new GhostError("invalid_request", `"desktop.${key}" is not a desktop field.`, 400);
    if (typeof field !== "string" || field.length > LIMITS[key as keyof typeof LIMITS]) {
      throw new GhostError("invalid_request", `"desktop.${key}" must be text of at most ${LIMITS[key as keyof typeof LIMITS]} characters.`, 400);
    }
    if (field.trim() !== "") context[key as keyof DesktopContext] = field.trim();
  }
  return Object.keys(context).length > 0 ? context : null;
}

/**
 * A word naming a secret (also inside a name like `GITHUB_TOKEN`), an auth scheme it may carry, then the value up to
 * the next space or quote: `token=abc`, `Authorization: Bearer abc`, `--password abc`.
 */
const NAMED_SECRET = /(?<![A-Za-z])(pass(?:word|wd)?|secret|token|bearer|api[-_]?key|auth(?:orization)?|key)(?![A-Za-z])([\s:=]+)(?:(bearer|basic|token)\s+)?("[^"]*"|'[^']*'|[^\s'"]+)/giu;
/** A long unbroken run of key-like characters: an access token pasted on a command line. */
const LONG_TOKEN = /[A-Za-z0-9_\-+/=.]{32,}/gu;

/** The title with secret-shaped text blanked: it may show a command a terminal runs. */
export function redactTitle(title: string): string {
  return title
    .replace(NAMED_SECRET, (_match, name: string, gap: string, scheme: string | undefined) => `${name}${gap}${scheme ? `${scheme} ` : ""}[redacted]`)
    .replace(LONG_TOKEN, (run) => (/[0-9]/u.test(run) && /[A-Za-z]/u.test(run) && !run.includes("/") ? "[redacted]" : run));
}

/** The hidden block appended to the turn's first pass. */
export function renderDesktopContext(context: DesktopContext): string {
  const lines = [
    "The owner summoned you from this window; their message may be about it.",
    ...(context.app ? [`app: ${context.app}`] : []),
    ...(context.title ? [`title: ${redactTitle(context.title)}`] : []),
    ...(context.cwd ? [`terminal directory: ${context.cwd}`] : []),
  ];
  return `<desktop-context>\n${lines.join("\n")}\n</desktop-context>`;
}
