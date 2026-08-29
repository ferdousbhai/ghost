export const EXIT_CODES = `ghost exit codes

  0  ok
  1  turn or action failed
  2  usage error
  3  daemon unreachable
  4  unauthorized
  5  not found
  6  busy or conflict
`;

export const USAGE = `ghost — talk to a ghost through ghostd

Usage:
  ghost <verb> [args] [flags]
  ghost help [command|exit-codes]

Daily:
  say [text]               Send a turn; use --new, --steer, or --follow-up
  sessions                 List conversations
  show                     Print a conversation transcript as Markdown
  ask [answer|chat|skip]   Inspect or resolve a pending question
  jobs [show|cancel]       Inspect background jobs
  plan [start|stop|clear]  Inspect or change planning mode
  todo                     Show the conversation todo
  watch                    Stream conversation invalidations
  status                   Check daemon connectivity and authentication

Ghosts and sessions:
  list                     List ghosts
  new <name>               Create a ghost
  rm <name> --yes          Trash a ghost
  rm -s <id> --yes         Trash a conversation
  use [<name>]             Print or persist the default ghost
  title <text>             Rename a conversation
  fork <entryId>           Fork a conversation before an entry
  pin | unpin              Change conversation pin state

Configuration:
  model [provider/id]      Show or set the chat model; --list lists choices
  memory [show <name>]     List or read ghost memory files
  smoke [--no-turn]        Exercise a throwaway daemon
  skill                    Print the agent-oriented command reference

Common flags:
  -g, --ghost <name>       Select a ghost
  -s, --session <id>       Select by public/raw id or unique prefix
      --json               Emit API JSON (streams use one object per line)
  -q, --quiet              Suppress secondary output
  -h, --help               Show command help
  -v, --version            Show the ghostd package version

ghostd runs the machine (api-token, remote, login, import); ghost talks to a ghost.
`;

const HELP: Readonly<Record<string, string>> = {
  say: `Usage: ghost say [text] [-m <text>] [--new|--steer|--follow-up] [-g <name>] [-s <id>] [--json] [-q]\n\nText comes from -m, positionals, or non-TTY stdin. --json emits every SSE event.\n`,
  list: `Usage: ghost list [--json] [-q]\n\nList ghost names and home directories.\n`,
  new: `Usage: ghost new <name> [--json] [-q]\n\nCreate a ghost through ghostd.\n`,
  rm: `Usage: ghost rm <name> --yes | ghost rm -s <id> --yes [-g <name>] [--json] [-q]\n\nDeletion is recoverable Trash and always requires --yes.\n`,
  use: `Usage: ghost use [<name>] [--json] [-q]\n\nPersist the default in ~/.config/ghost/cli.json (or XDG_CONFIG_HOME), mode 0600.\n`,
  sessions: `Usage: ghost sessions [-g <name>] [--json] [-q]\n\nList conversation ids, titles, relative update times, counts, unread, and pin state.\n`,
  show: `Usage: ghost show [-g <name>] [-s <id>] [--limit <n>] [--offset <n>] [--json] [-q]\n\nRender the daemon transcript as Markdown.\n`,
  title: `Usage: ghost title <text> [-g <name>] [-s <id>] [--json] [-q]\n`,
  fork: `Usage: ghost fork <entryId> [-g <name>] [-s <id>] [--json] [-q]\n`,
  pin: `Usage: ghost pin [-g <name>] [-s <id>] [--json] [-q]\n`,
  unpin: `Usage: ghost unpin [-g <name>] [-s <id>] [--json] [-q]\n`,
  ask: `Usage: ghost ask [answer <option-label-or-index|text>|chat|skip] [-g <name>] [-s <id>] [--json] [-q]\n`,
  jobs: `Usage: ghost jobs [show <jobId>|cancel <jobId>] [-g <name>] [-s <id>] [--json] [-q]\n`,
  plan: `Usage: ghost plan [start|stop|clear] [-g <name>] [-s <id>] [--json] [-q]\n`,
  todo: `Usage: ghost todo [-g <name>] [-s <id>] [--json] [-q]\n`,
  model: `Usage: ghost model [provider/id] [-g <name>] [--json] [-q]\n       ghost model --list [--q <text>] [-g <name>] [--json] [-q]\n`,
  memory: `Usage: ghost memory [show <name>] [-g <name>] [--json] [-q]\n\nList memory files or print one file by slug, path, or name. --json returns the exact memory API body.\n`,
  watch: `Usage: ghost watch [-g <name>] [--exit-on-first] [-q]\n\nPrint daemon event objects as JSON lines until interrupted.\n`,
  status: `Usage: ghost status [--json] [-q]\n\nShow the daemon URL, auth status, token path, ghosts, default, and remote state.\n`,
  smoke: `Usage: ghost smoke [--keep] [--no-turn] [--json] [-q]\n\nStart a scratch ghostd and exercise it. A real turn needs a signed-in provider in the scratch home; CI uses --no-turn.\n`,
  skill: `Usage: ghost skill [--json] [-q]\n\nPrint a concise SKILL.md-style reference for an LLM agent.\n`,
};

export function commandHelp(command: string): string {
  return HELP[command] ?? USAGE;
}
