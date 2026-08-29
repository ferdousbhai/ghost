import type { CliWritable } from "./types.js";

export function writeJson(stream: CliWritable, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

export function relativeTime(value: string | number | Date, now = Date.now()): string {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const elapsed = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function durationTime(elapsedMs: number): string {
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed < 1_000) return `${elapsed}ms`;
  if (elapsed < 60_000) return `${Math.round(elapsed / 1_000)}s`;
  return `${Math.floor(elapsed / 60_000)}m`;
}

export function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

export function table(rows: readonly (readonly string[])[], headers?: readonly string[]): string {
  const all = headers ? [headers, ...rows] : [...rows];
  if (all.length === 0) return "";
  const columns = Math.max(...all.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(...all.map((row) => (row[column] ?? "").length)));
  return all.map((row) => row.map((cell, column) => {
    const text = cell ?? "";
    return column === columns - 1 ? text : text.padEnd(widths[column] ?? text.length);
  }).join("  ").trimEnd()).join("\n");
}

export function dim(text: string, enabled: boolean): string {
  return enabled ? `\u001b[2m${text}\u001b[22m` : text;
}

export function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const row = part as { type?: unknown; text?: unknown };
    return row.type === "text" && typeof row.text === "string" ? [row.text] : [];
  }).join("");
}

export function describeErrorBody(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    if (typeof error === "string" && error.trim()) return error;
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}
