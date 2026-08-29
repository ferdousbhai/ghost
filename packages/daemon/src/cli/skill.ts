import type { ParsedCliArgs } from "./args.js";
import { emit } from "./output.js";
import type { CliContext } from "./types.js";
import {
  markdownCommandTable,
  markdownExitCodeTable,
  type CommandDocumentation,
  type ExitCodeDocumentation,
} from "./usage.js";

export function renderSkillText(
  commands: readonly CommandDocumentation[],
  exitCodes: readonly ExitCodeDocumentation[],
): string {
  return `---
name: ghost
description: Talk to local AI personas through the authenticated ghostd HTTP daemon.
---

# ghost terminal client

## Addressing

Ghost selection is \`-g\`, then \`$GHOST\`, then the private \`ghost use\`
default, then the sole installed ghost. Session selection is \`-s\` with an
exact id or unique public/raw-id prefix, then the most recently updated session.
Destructive commands require \`--yes\`; commands never prompt.

## Commands

${markdownCommandTable(commands)}

## Machine-readable output

Use \`--json\` for daemon API shapes or one complete stream event per line. Use
\`-q\` to suppress secondary human output.

## Exit codes

${markdownExitCodeTable(exitCodes)}
`;
}

export function skillCommand(
  _parsed: ParsedCliArgs,
  ctx: CliContext,
  skill: string,
): number {
  emit(ctx, { skill }, ({ skill: text }) => text);
  return 0;
}
