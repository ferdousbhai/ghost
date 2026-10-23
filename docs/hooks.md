# Ghost hooks

Ghost owns an awaited lifecycle boundary around each harness pass of a
conversation turn. The harness carrying the turn (Claude Code, Codex, …), and
any harness the ghost runs from Bash, keeps its own native hook behavior;
Ghost does not translate, duplicate, or await those hooks.

Ghost supports three events. `before_prompt` runs after the owner submits a prompt
and before the harness is launched with it. It can add advisory context to that
prompt without blocking or creating another turn. `session_stop` runs after a
harness pass ends and before Ghost emits the turn's terminal `done` frame. It
can accept the pass or return context for a continuation pass. `turn_end` runs once
after the whole streamed turn succeeds or fails, including queued passes and owner
commands; cancelled turns are quiet. It delivers optional completion notifications
and cannot continue or block the turn.

## Configuration

User hooks live beside the daemon config, normally
`~/.config/ghost/hooks.json`; `GHOSTD_CONFIG` moves both and `GHOSTD_HOOKS`
names this file alone.

```json
{
  "hooks": {
    "before_prompt": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/advisory-context",
            "name": "Advisory context",
            "timeout": 10
          }
        ]
      }
    ],
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
replaces it; the shell's Hooks pane edits it through that route, and no
restart is needed for those edits. An edit made to the file by hand still
needs a restart. Groups and handlers run in file order.
Configured command strings must be non-empty and contain no NUL byte, and a
command's `timeout` (seconds, default 30) must be greater than 0 and at most
600. `name` (≤ 80 chars) and `description` (≤ 240) are optional, default per
event, and are what the Hooks pane shows. While a `before_prompt` or `session_stop` handler runs, the turn
stream carries `hook_start`/`hook_end` with its `name` and `event`. The HUD
shows a `before_prompt` hook's name as the turn's activity, so give a slow one
a name that says what it is doing. A `session_stop` hook runs out of sight:
the reply already reads as finished, and only a continuation shows.
All non-empty `before_prompt` contexts are combined. The first `session_stop`
handler that requests a continuation wins.

Ghost registers no built-in hooks and starts no idle handoff or next-work turns.
Legacy top-level `builtin` settings are ignored.

`ghost hooks show` prints `{ path, document }` and `ghost hooks set <file>` replaces the
document with the file, which must be the document itself (`hooks` at its top level), so a
ghost asked for a hook can write one. This file configures Ghost's machine-level
awaited command hooks. They run for every principal conversation, above the
harness, and commands run with the daemon user's permissions. It is therefore
a trusted machine configuration
surface, not portable ghost data.

There is no second hook mechanism. A ghost home carries no executable
extension code; everything a hook does is a command in `hooks.json`.

Each machine command runs in an owned process group, the same way a harness
does. Abort, timeout, or more than 1 MiB of stdout terminates the whole
descendant tree (TERM, then KILL after 3 s) and drains its pipes before the
lifecycle boundary returns; the last 8 KiB of stderr is kept for a block
reason. A hook ends with its own process: output still arriving 2 s
after it exits is dropped, so a descendant that left the group (`setsid job &`)
and still holds the pipes cannot hold the daemon's hook promise open. Synchronous spawn failures, process-start
errors, and unexpected command-runner rejection are generically logged and
fail open for both events; they never fail the owner turn or expose the
command/error payload.

## `before_prompt` protocol

A command receives the owner prompt, conversation metadata, the harness that
carried the conversation last (absent before its first turn), ghost name,
ghost-home storage root, and the conversation directory:

```json
{
  "type": "before_prompt",
  "prompt": "Continue.",
  "turn_id": "95d8e048-e69e-4a0e-95a4-f10ad22f42d7",
  "session_id": "conversation-a",
  "session_file": "/home/me/ghosts/casper/sessions/conversation-a/.conversation.jsonl",
  "ghost_name": "casper",
  "ghost_home": "/home/me/ghosts/casper",
  "cwd": "/home/me/ghosts/casper/sessions/conversation-a",
  "conversation_id": "conversation-a",
  "harness": "claude"
}
```

Exit 0 with no output or `{}` adds nothing. To add model-visible guidance to the
same user-initiated model request, return:

```json
{ "additionalContext": "Avoid the style warning from the previous reply." }
```

`before_prompt` cannot block and does not accept continuation decisions. Errors,
timeouts, and malformed output fail open. Context is hidden from the chat UI: it
is appended to the prompt the harness receives, inside `<hook-context>`, and is
not written to the conversation log.

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
  "session_file": "/home/me/ghosts/casper/sessions/conversation-a/.conversation.jsonl",
  "transcript_path": "/home/me/ghosts/casper/sessions/conversation-a/.conversation.jsonl",
  "stop_hook_active": false,
  "ghost_name": "casper",
  "ghost_home": "/home/me/ghosts/casper",
  "cwd": "/home/me/ghosts/casper/sessions/conversation-a",
  "conversation_id": "conversation-a",
  "harness": "claude"
}
```

`harness` is the harness that answered the pass. `messages` exposes only that
pass, its content Ghost's assistant parts (`text`, and `toolCall` with
`failed: true` on a call that failed).
`owner_prompt` is the owner's request and `turn_id` a UUID naming it; both
stay fixed across hook continuations, and every owner request, a queued
follow-up included, gets a fresh `turn_id`.
A blocking result is injected the way Codex and Claude Code inject Stop feedback: a
user-role prompt whose text is `Stop hook feedback:` plus the reason, so the
latest instruction is the hook's reason rather than a repeat of `owner_prompt`.
`transcript_path` is the conversation log on disk
([`conversation-log.ts`](../packages/daemon/src/conversation-log.ts)), one JSON
object per line, so a hook can review the whole owner turn, not just the
current pass: an owner message is `{"type":"user","text"}` with no `origin`; a
follow-up or hook continuation carries `origin` `"follow_up"` or `"hook"`.
Historical logs may also contain `origin: "auto"` or `{"type":"handoff"}`. It
is untrusted content exactly like `messages`.

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
the hook runs, so a hook never needs to watch for the owner typing. Ghost sets
`stop_hook_active: true` on continuation passes. The hook owns its
continuation policy, the same way Codex Stop hooks do: Ghost will keep honoring
a blocking result until the hook accepts, the turn is stopped, or the hook fails
open. Use `stop_hook_active` to avoid a loop that will never resolve. The
continuation reason is a Codex-style user-role prompt (`Stop hook feedback:`)
and Ghost shows it in the transcript as a dim "Stop hook" row. An
informational notification alone is not.

Trusted command hooks that need a classifier can invoke
`ghostd hook-complete`. It reads
`{ "ghost_home": "/absolute/home", "prompt": "..." }` from stdin and returns
`{ "text": "..." }`: one headless run of the ghost's preferred eligible
harness, in the order a turn would pick, in a scratch directory with no
persona, conversation, or Ghost tools; a harness that fails hands the prompt
to the next. It runs the same model and effort a turn does, with the owner's
own CLI configuration, hooks included, and the caller's environment: a
stop-hook reviewer marks its call (keep-going sets `KEEP_GOING_REVIEWING`) so
the harness's own stop hook does not review the review. An older `role` field
is ignored.

## Status

The hooks that run are exactly the handlers in the `hooks.json` the daemon
admitted, which the owner-only `GET /api/hooks/config` returns as
`{ path, document }`; `ghost hooks` and the HUD's Hooks pane read it there.
A handler without a `name` or `description` is shown with the defaults
above.

## Editing

Authenticated `GET /api/hooks/config` returns `{ path, document }`: the
admitted `hooks.json` as one object and its absolute path. `PUT
/api/hooks/config` with a whole document validates it with the same loader,
writes it atomically, and swaps the live command hooks. A rejected document
is a 400 naming the offending field and changes nothing. `before_prompt` and
`session_stop` and `turn_end` changes apply at the next boundary.

Scheduled work is separate from lifecycle hooks: `ghost routines` and the HUD
and tailnet owner view inspect and control systemd timers, as specified in
[the routine contract](../CONTRACTS.md#routine-inspection-and-controls). Neither
routine inspection nor pause/resume sends a prompt or runs a lifecycle hook;
run now queues the existing service. If it starts a Ghost turn, normal hooks apply.

External events enter through the owner-only delivery contract in
[docs/events.md](events.md), not a hook boundary. Each accepted event starts a
normal conversation turn with the normal hooks; duplicate delivery runs no
hook or harness. Provider authentication/retries belong to the installed
source service or CLI.

## `turn_end` protocol

An opt-in command receives the usual `ghost_name`, `ghost_home`, `cwd`,
`conversation_id`, `session_id`, `session_file`, and `turn_id` fields (the
`turn_id` of the owner request the final pass answered), plus:

```json
{
  "type": "turn_end",
  "outcome": "done",
  "title": "Prepare the report",
  "excerpt": "The report is ready.",
  "url": "https://ghostbox.example.ts.net/?ghost=casper&session=c1"
}
```

`outcome` is `done` or `error`; `title` is at most 160 characters and the
whitespace-normalized `excerpt` at most 280. The URL is null when remote access
is unavailable. Failed turns use the failure message. Handlers run in order,
under the existing timeout/output bounds, after the terminal stream frame and
outside the conversation's busy state, so they never delay the next prompt.
Their output cannot change the result; failures fail open and are logged. Ghost
stores no delivery credentials, retries, or push subscription. Removing the
handler through `ghost hooks set` or the Hooks pane disables delivery at the
next boundary. `ghost help notifications` gives a curl/ntfy recipe that works
with the phone viewer closed. It sends conversation text to the selected
service, so configure it only when the owner wants that delivery.
