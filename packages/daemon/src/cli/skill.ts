import { flagBoolean, parseArgs, requirePositionals } from "./args.js";
import { writeJson } from "./output.js";
import type { CliRuntime } from "./types.js";
import { commandHelp } from "./usage.js";

export const SKILL_TEXT = `---
name: ghost
description: Talk to local AI personas through the authenticated ghostd HTTP daemon.
---

# ghost terminal client

Use \`ghost\` for persona work. \`ghostd\` runs the machine (api-token, remote,
login, import); \`ghost\` talks to a ghost. Commands never prompt.

## Addressing

Ghost selection is \`-g\`, then \`$GHOST\`, then the \`ghost use\` default, then
the sole installed ghost. Session selection is \`-s\` with an id or unique
public/raw-id prefix, then the most recently updated session. Destructive
commands require \`--yes\`.

## Commands

- \`ghost say "Hello"\` — send a turn and stream the reply.
- \`ghost say --new "Start fresh"\` — start a new conversation.
- \`ghost say --steer "Check tests first" -s abc\` — steer a live turn.
- \`ghost list\` — list ghosts and their directories.
- \`ghost new sage\` — create a ghost.
- \`ghost rm sage --yes\` — move a ghost to recoverable Trash.
- \`ghost use sage\` — persist the default ghost.
- \`ghost sessions\` — list conversations.
- \`ghost show -s abc\` — render a transcript as Markdown.
- \`ghost title "Release notes" -s abc\` — set a conversation title.
- \`ghost fork entry-123 -s abc\` — fork before a user entry.
- \`ghost pin -s abc\` / \`ghost unpin -s abc\` — change pin state.
- \`ghost ask -s abc\` — show a pending question.
- \`ghost ask answer 1 -s abc\` — submit an option by index or label.
- \`ghost ask chat -s abc\` / \`ghost ask skip -s abc\` — redirect or cancel.
- \`ghost jobs -s abc\` — list session background jobs.
- \`ghost jobs show job-1 -s abc\` — print job output.
- \`ghost jobs cancel job-1 -s abc\` — cancel a job.
- \`ghost plan -s abc\` — show planning state and todo.
- \`ghost plan start -s abc\` — enter planning mode; stop/clear also work.
- \`ghost todo -s abc\` — show task status.
- \`ghost model\` — show the current model.
- \`ghost model openai/gpt-5\` — set provider/id.
- \`ghost model --list --q claude\` — search available models.
- \`ghost memory\` — list memory index entries.
- \`ghost memory show owner-name\` — read indexed memory content.
- \`ghost watch --exit-on-first\` — stream invalidation events as JSON lines.
- \`ghost status\` — check URL, auth, token, ghosts, default, and remote.
- \`ghost smoke --no-turn\` — exercise a throwaway daemon without a provider.
- \`ghost skill\` — print this reference.
- \`ghost help exit-codes\` — print the stable exit-code table.

## Machine-readable output

Every command accepts \`--json\`. Non-streaming commands preserve the daemon API
shape; streaming commands write one complete JSON event per line. Use \`-q\` to
suppress secondary human output.

## Exit codes

0 ok; 1 failed turn/action; 2 usage; 3 daemon unreachable; 4 unauthorized;
5 not found; 6 busy/conflict.
`;

export function skillCommand(argv: readonly string[], runtime: CliRuntime): number {
  const parsed = parseArgs(argv);
  if (flagBoolean(parsed, "help")) {
    runtime.stdout.write(commandHelp("skill"));
    return 0;
  }
  requirePositionals(parsed, 0, 0, "ghost skill [--json] [-q]");
  if (flagBoolean(parsed, "json")) writeJson(runtime.stdout, { skill: SKILL_TEXT });
  else if (!flagBoolean(parsed, "quiet")) runtime.stdout.write(SKILL_TEXT);
  return 0;
}
