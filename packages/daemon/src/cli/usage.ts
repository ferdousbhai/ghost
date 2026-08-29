export interface CommandDocumentation {
  verb: string;
  usage: string;
  summary: string;
  example: string;
}

export interface ExitCodeDocumentation {
  code: number;
  meaning: string;
}

function plainRows(commands: readonly CommandDocumentation[]): string {
  const width = Math.max(...commands.map((command) => command.usage.length));
  return commands
    .map((command) => `  ${command.usage.padEnd(width)}  ${command.summary}`)
    .join("\n");
}

export function renderUsage(commands: readonly CommandDocumentation[]): string {
  return `ghost — talk to a ghost through ghostd

Usage:
  ghost <verb> [args] [flags]
  ghost help [command|exit-codes]

Commands:
${plainRows(commands)}

Common flags:
  -g, --ghost <name>       Select a ghost
  -s, --session <id>       Select by public/raw id or unique prefix
      --json               Emit API JSON (streams use one object per line)
  -q, --quiet              Suppress secondary output
  -h, --help               Show command help
  -v, --version            Show the ghost package version

ghostd runs the machine (api-token, remote, login, import); ghost talks to a ghost.
`;
}

export function renderCommandHelp(command: CommandDocumentation): string {
  return `Usage: ghost ${command.usage}\n\n${command.summary}\n\nExample: ${command.example}\n`;
}

export function renderExitCodes(exitCodes: readonly ExitCodeDocumentation[]): string {
  const width = Math.max(...exitCodes.map(({ code }) => String(code).length));
  return `ghost exit codes\n\n${exitCodes
    .map(({ code, meaning }) => `  ${String(code).padStart(width)}  ${meaning}`)
    .join("\n")}\n`;
}

export function markdownCommandTable(commands: readonly CommandDocumentation[]): string {
  return [
    "| command | purpose | example |",
    "|---|---|---|",
    ...commands.map((command) =>
      `| \`ghost ${command.verb}\` | ${command.summary} | \`${command.example}\` |`),
  ].join("\n");
}

export function markdownExitCodeTable(exitCodes: readonly ExitCodeDocumentation[]): string {
  return [
    "| code | meaning |",
    "|---:|---|",
    ...exitCodes.map(({ code, meaning }) => `| ${code} | ${meaning} |`),
  ].join("\n");
}
