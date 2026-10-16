import { parseArgs as parseNodeArgs } from "node:util";
import { errorMessage } from "../errors.js";

export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgsError";
  }
}

export interface ArgsSpec {
  boolean?: readonly string[];
  value?: readonly string[];
}

export interface ParsedCliArgs {
  positionals: string[];
  flags: Record<string, boolean | string>;
}

const SHORT: Readonly<Record<string, string>> = { help: "h", quiet: "q", ghost: "g", session: "s", message: "m", version: "v" };

/** `--help`, `--json`, and `--quiet` plus the spec's flags; anything else is an ArgsError. */
export function parseArgs(argv: readonly string[], spec: ArgsSpec = {}): ParsedCliArgs {
  const option = (type: "boolean" | "string") => (name: string) =>
    [name, { type, ...(SHORT[name] ? { short: SHORT[name] } : {}) }] as const;
  const options = Object.fromEntries([
    ...["help", "json", "quiet", ...(spec.boolean ?? [])].map(option("boolean")),
    ...(spec.value ?? []).map(option("string")),
  ]);
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseNodeArgs({ args: [...argv], options, strict: true, allowPositionals: true });
  } catch (error) {
    throw new ArgsError(errorMessage(error));
  }
  for (const [name, value] of Object.entries(parsed.values)) {
    if (value === "") throw new ArgsError(`--${name} requires a value.`);
  }
  return { positionals: parsed.positionals, flags: { ...parsed.values } as Record<string, boolean | string> };
}

export function flagBoolean(parsed: ParsedCliArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

export function flagString(parsed: ParsedCliArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}
