export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgsError";
  }
}

export interface ArgsSpec {
  boolean?: readonly string[];
  value?: readonly string[];
  aliases?: Readonly<Record<string, string>>;
}

export interface ParsedCliArgs {
  positionals: string[];
  flags: Record<string, boolean | string>;
}

const COMMON_ALIASES: Readonly<Record<string, string>> = {
  h: "help",
  q: "quiet",
  g: "ghost",
  s: "session",
  m: "message",
  v: "version",
};

function canonicalFlag(raw: string, aliases: Readonly<Record<string, string>>): string {
  return aliases[raw] ?? raw;
}

export function parseArgs(argv: readonly string[], spec: ArgsSpec = {}): ParsedCliArgs {
  const boolean = new Set(["help", "json", "quiet", ...(spec.boolean ?? [])]);
  const value = new Set([...(spec.value ?? [])]);
  const aliases = { ...COMMON_ALIASES, ...(spec.aliases ?? {}) };
  const positionals: string[] = [];
  const flags: Record<string, boolean | string> = {};
  let terminated = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (terminated || arg === "-" || !arg.startsWith("-") || arg === "") {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      terminated = true;
      continue;
    }

    let rawName: string;
    let inlineValue: string | undefined;
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("=");
      rawName = arg.slice(2, equal < 0 ? undefined : equal);
      if (equal >= 0) inlineValue = arg.slice(equal + 1);
    } else {
      if (arg.length !== 2) throw new ArgsError(`Unknown option: ${arg}`);
      rawName = arg.slice(1);
    }
    const name = arg.startsWith("--") ? rawName : canonicalFlag(rawName, aliases);
    if (boolean.has(name)) {
      if (inlineValue !== undefined) throw new ArgsError(`--${name} does not take a value.`);
      flags[name] = true;
      continue;
    }
    if (!value.has(name)) throw new ArgsError(`Unknown option: ${arg}`);
    let flagValue = inlineValue;
    if (flagValue === undefined) {
      flagValue = argv[index + 1];
      if (flagValue === undefined || (flagValue.startsWith("-") && flagValue !== "-")) {
        throw new ArgsError(`${arg} requires a value.`);
      }
      index += 1;
    }
    if (flagValue === "") throw new ArgsError(`${arg} requires a value.`);
    flags[name] = flagValue;
  }

  return { positionals, flags };
}

export function flagBoolean(parsed: ParsedCliArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

export function flagString(parsed: ParsedCliArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}
