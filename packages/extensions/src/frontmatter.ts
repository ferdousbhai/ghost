/**
 * YAML frontmatter support for legacy document migration.
 *
 * Live ghost-home/v2 docs never enter through this parser. Hosted v1 exports
 * used a fixed scalar/list vocabulary. The hand-rolled reader keeps that
 * migration byte-predictable without introducing a general YAML writer.
 */
import { GhostError } from "./errors.js";

export type FrontmatterValue = string | number | boolean | string[];
export type FrontmatterRecord = Record<string, FrontmatterValue>;

const FENCE = "---";
const RESERVED_FILENAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const PLAIN_YAML_SCALAR = /^[A-Za-z0-9][A-Za-z0-9 _./-]*$/;
const AMBIGUOUS_YAML_SCALAR = /^(y|n|yes|no|true|false|on|off|null|nan|-?\d+(\.\d+)?)$/i;

export function yamlScalar(value: string): string {
  if (
    value.length > 0
    && value === value.trim()
    && PLAIN_YAML_SCALAR.test(value)
    && !AMBIGUOUS_YAML_SCALAR.test(value)
  ) {
    return value;
  }
  return `"${
    value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
  }"`;
}

export function yamlFlowList(values: readonly string[]): string {
  return `[${values.map(yamlScalar).join(", ")}]`;
}

export function sanitizePathSegment(segment: string): string {
  let printable = "";
  for (const character of segment) {
    const codePoint = character.codePointAt(0) ?? 0;
    printable += codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  }
  const cleaned = printable
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim();
  if (!cleaned) return "untitled";
  return RESERVED_FILENAMES.test(cleaned) ? `${cleaned}-file` : cleaned;
}

export interface SplitDocument {
  readonly lines: readonly string[];
  readonly body: string;
  readonly hadFrontmatter: boolean;
}

/**
 * Split a markdown document into frontmatter lines and a **byte-faithful** body.
 *
 * Exactly one newline after the closing fence is consumed — the separator
 * `renderDocument` writes — so `renderDocument(lines, split(text).body)` is the
 * identity on anything this module produced.
 */
export function splitFrontmatter(text: string): SplitDocument {
  const firstBreak = text.indexOf("\n");
  const firstLine = (firstBreak === -1 ? text : text.slice(0, firstBreak)).replace(/\r$/, "");
  if (firstLine !== FENCE) {
    return { lines: [], body: text, hadFrontmatter: false };
  }
  if (firstBreak === -1) {
    throw new GhostError("invalid_format", "Unterminated frontmatter: no closing --- line.");
  }

  const lines: string[] = [];
  let cursor = firstBreak + 1;
  while (cursor <= text.length) {
    const lineBreak = text.indexOf("\n", cursor);
    const raw = lineBreak === -1 ? text.slice(cursor) : text.slice(cursor, lineBreak);
    const line = raw.replace(/\r$/, "");
    const afterLine = lineBreak === -1 ? text.length : lineBreak + 1;
    if (line === FENCE) {
      let body = text.slice(afterLine);
      if (body.startsWith("\r\n")) body = body.slice(2);
      else if (body.startsWith("\n")) body = body.slice(1);
      return { lines, body, hadFrontmatter: true };
    }
    lines.push(line);
    if (lineBreak === -1) break;
    cursor = afterLine;
  }
  throw new GhostError("invalid_format", "Unterminated frontmatter: no closing --- line.");
}

export function renderDocument(lines: readonly string[], body: string): string {
  return `${FENCE}\n${lines.join("\n")}\n${FENCE}\n\n${body}`;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    let out = "";
    for (let index = 1; index < value.length - 1; index += 1) {
      const character = value[index];
      if (character !== "\\") {
        out += character;
        continue;
      }
      index += 1;
      const escaped = value[index];
      out += escaped === "n" ? "\n"
        : escaped === "r" ? "\r"
        : escaped === "t" ? "\t"
        : (escaped ?? "");
    }
    return out;
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index] as string;
    if (quote) {
      current += character;
      if (character === "\\" && quote === '"') {
        index += 1;
        current += inner[index] ?? "";
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0 || items.length > 0) items.push(current);
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

function parseValue(raw: string): FrontmatterValue {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return splitFlowItems(trimmed.slice(1, -1)).map(unquote);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return unquote(trimmed);
}

/**
 * Parse frontmatter lines into a record. Unknown keys are kept: a doc written
 * by a newer version of the app must survive a round trip through an older one.
 */
export function parseFrontmatterLines(lines: readonly string[]): FrontmatterRecord {
  const record: FrontmatterRecord = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator < 0) {
      throw new GhostError(
        "invalid_format",
        `Invalid frontmatter line "${trimmed}". Frontmatter lines look like \`key: value\`.`,
      );
    }
    record[trimmed.slice(0, separator).trim()] = parseValue(trimmed.slice(separator + 1));
  }
  return record;
}

export interface ParsedDocument {
  readonly frontmatter: FrontmatterRecord;
  readonly body: string;
  readonly hadFrontmatter: boolean;
}

export function parseDocument(text: string): ParsedDocument {
  const split = splitFrontmatter(text);
  return {
    frontmatter: parseFrontmatterLines(split.lines),
    body: split.body,
    hadFrontmatter: split.hadFrontmatter,
  };
}

export function readBoolean(record: FrontmatterRecord, key: string): boolean {
  return record[key] === true;
}

export function readString(record: FrontmatterRecord, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function readStringList(record: FrontmatterRecord, key: string): string[] {
  const value = record[key];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}
