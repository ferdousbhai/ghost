# Ghost hooks

Ghost owns an awaited lifecycle boundary around each pass of a
conversation turn. A coding agent the ghost runs from its shell (Claude Code,
Codex, …) keeps its own native hook behavior;
Ghost does not translate, duplicate, or await those hooks.

Ghost supports two events. `session_stop` runs after a
pass ends and before Ghost emits the turn's terminal `done` frame. It
can accept the pass or return context for a continuation pass. `turn_end` runs once
after the whole streamed turn succeeds or fails, including queued passes and owner
commands; cancelled turns are quiet. It is for the owner's own delivery of a
completion, and cannot continue or block the turn.

## Configuration

User hooks live beside the daemon config, normally
`~/.config/ghost/hooks.json`; `GHOSTD_CONFIG` moves both and `GHOSTD_HOOKS`
names this file alone.

```json
{
  "hooks": {
    "session_stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/check-final-answer",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Ghost reads the file at startup and again whenever `PUT /api/hooks/config`
replaces it; `ghost hooks set` edits it through that route, and no
restart is needed for those edits. An edit made to the file by hand still
needs a restart. Groups and handlers run in file order. A document naming an
unknown event, or any top-level key other than `hooks`, is refused, at startup
and by `PUT /api/hooks/config`.
Configured command strings must be non-empty and contain no NUL byte, and a
command's `timeout` (seconds, default 30) must be greater than 0 and at most
600. `name` (≤ 80 chars) and `description` (≤ 240) are optional, default per
event, and are what `ghost hooks` shows. While a `session_stop` handler runs, the turn
stream carries `hook_start`/`hook_end` with its `name` and `event`. It runs
out of sight: the reply already reads as finished, and only a continuation
shows. The first `session_stop` handler that requests a continuation wins.

Ghost registers no built-in hooks and starts no idle handoff or next-work turns.

`ghost hooks show` prints `{ path, document }` and `ghost hooks set <file>` replaces the
document with the file, which must be the document itself (`hooks` at its top level), so a
ghost asked for a hook can write one. This file configures Ghost's machine-level
awaited command hooks. They run for every conversation,
and commands run with the daemon user's permissions. It is therefore
a trusted machine configuration
surface, not portable ghost data.

There is no second hook mechanism. A ghost home carries no executable
extension code; everything a hook does is a command in `hooks.json`.

Each machine command runs in an owned process group. Abort, timeout, or more than 1 MiB of stdout terminates the whole
descendant tree (TERM, then KILL after 3 s) and drains its pipes before the
lifecycle boundary returns; the last 8 KiB of stderr is kept for a block
reason. A hook ends with its own process: output still arriving 2 s
after it exits is dropped, so a descendant that left the group (`setsid job &`)
and still holds the pipes cannot hold the daemon's hook promise open. Synchronous spawn failures, process-start
errors, and unexpected command-runner rejection are generically logged and
fail open for every event; they never fail the owner turn or expose the
command/error payload.

## `session_stop` protocol

A command receives JSON on stdin. `messages` contains only the current assistant
pass, not the session history or prior tool results; `last_assistant_message`
contains the same message directly:

```json
{
  "type": "session_stop",
  "owner_prompt": "Please verify the result.",
  "messages": [{
    "role": "assistant",
    "content": [{ "type": "text", "text": "The answer." }]
  }],
  "turn_id": "95d8e048-e69e-4a0e-95a4-f10ad22f42d7",
  "last_assistant_message": {
    "role": "assistant",
    "content": [{ "type": "text", "text": "The answer." }]
  },
  "session_id": "conversation-a",
  "transcript_path": "/home/me/ghosts/casper/sessions/conversation-a/.conversation.jsonl",
  "stop_hook_active": false,
  "ghost_name": "casper",
  "ghost_home": "/home/me/ghosts/casper",
  "cwd": "/home/me/ghosts/casper/sessions/conversation-a",
  "conversation_id": "conversation-a"
}
```

`messages` exposes only that
pass, its content Ghost's assistant parts (`thinking`, `text`, and `toolCall`
with its `output`, and `failed: true` on a call that failed).
`owner_prompt` is the owner's request and `turn_id` a UUID naming it; both
stay fixed across hook continuations, and every owner request, a queued
follow-up included, gets a fresh `turn_id`.
A blocking result is injected the way Codex and Claude Code inject Stop feedback: a
user-role prompt whose text is `Stop hook feedback:` plus the reason, so the
latest instruction is the hook's reason rather than a repeat of `owner_prompt`.
`transcript_path` is the conversation log on disk
([`conversation_log.rs`](../packages/daemon/src/conversation_log.rs)), one JSON
object per line, so a hook can review the whole owner turn, not just the
current pass: an owner message is `{"type":"user","text"}` with no `origin`; a
follow-up or hook continuation carries `origin` `"follow_up"` or `"hook"`.
Logs from earlier versions may also hold record types ghostd no longer writes;
skip any type you do not know. It is untrusted content exactly like `messages`.

Exit 0 with no output or `{}` accepts the pass. Either response below requests a
continuation:

```json
{ "continue": true, "additionalContext": "Revise the answer and verify the claim." }
```

```json
{ "decision": "block", "reason": "The final answer failed policy X." }
```

`continue`/`decision` without non-empty context is ignored. Exit 2 also blocks,
using stderr as the reason. Other exit codes, malformed output, thrown handlers,
and timeouts are logged and fail open.
Handlers are cancelled when the turn is stopped.

The owner's queued follow-up outranks a hook: Ghost skips `session_stop` for a
pass while a follow-up waits, and drops a continuation when one arrives while
the hook runs, so a hook never needs to watch for the owner typing. Nor is
`session_stop` asked while the ghost's own question (its `ask` tool) is open: the
turn is waiting on the owner, and a continuation is not their answer. Ghost sets
`stop_hook_active: true` on continuation passes. The hook owns its
continuation policy, the same way Codex Stop hooks do: Ghost will keep honoring
a blocking result until the hook accepts, the turn is stopped, or the hook fails
open. Use `stop_hook_active` to avoid a loop that will never resolve. The
continuation reason is a Codex-style user-role prompt (`Stop hook feedback:`)
and Ghost shows it in the transcript as a dim "Stop hook" row.

Trusted command hooks that need a classifier can invoke
`ghostd hook-complete`. It reads
`{ "prompt": "..." }` from stdin (other fields are ignored), asks the
daemon (`POST /api/complete`, at the port and
token a hook's environment names), and returns `{ "text": "..." }`: one
completion on the daemon's own loaded [local model](../CONTRACTS.md#local-model), with no persona,
conversation, or tools, so a hook's prompt stays on the machine. It is
refused with no local model configured, and so is a call when the daemon is not
running. `hook-complete` sets no deadline of its own: the calling hook's
`timeout` kills its process group, which closes the request and stops the
completion.

## Status and editing

The hooks that run are exactly the handlers in the `hooks.json` the daemon
admitted. The owner-only `GET /api/hooks/config` returns `{ path, document }`:
that file as one object and its absolute path; `ghost hooks` reads it there, showing a handler without a `name` or
`description` with the defaults above. `PUT
/api/hooks/config` with a whole document validates it with the same loader,
which refuses a top-level key other than `hooks` (so a pasted `{ path,
document }` reply cannot empty the file), writes it atomically, and swaps the
live command hooks. A rejected document
is a 400 naming the offending field and changes nothing. `session_stop` and
`turn_end` changes apply at the next boundary.

## `turn_end` protocol

An opt-in command receives the usual `ghost_name`, `ghost_home`, `cwd`,
`conversation_id`, `session_id`, `transcript_path`, and `turn_id` fields (the
`turn_id` of the owner request the final pass answered), plus:

```json
{
  "type": "turn_end",
  "outcome": "done",
  "title": "Prepare the report",
  "excerpt": "The report is ready.",
  "url": "https://summonghost.com/#/ghostbox.example.ts.net/c1"
}
```

`outcome` is `done` or `error`; `title` is at most 160 characters and the
whitespace-normalized `excerpt` at most 280. `url` opens the conversation in the first
`remote.apps` app (`<origin>/#/<hostname>/<id>`, each segment
URI-encoded), never a bearer token; it is null while remote access is off, or
when `remote.apps` is `[]`, and with no `turn_end` handler Ghost never looks
it up. Failed turns use the failure message. Handlers run in order,
under the existing timeout/output bounds, after the terminal stream frame and
outside the conversation's busy state, so they never delay the next prompt.
Their output cannot change the result; failures fail open and are logged. Removing the
handler through `ghost hooks set` disables delivery at the
next boundary. A handler that posts to a service sends it conversation text,
so configure one only when the owner wants that delivery. Alerts to the
owner's devices need no hook: the app turns them on
([mobile.md](mobile.md#completion-alerts)).
