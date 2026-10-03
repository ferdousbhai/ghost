# Ghost hooks

Ghost owns an awaited lifecycle boundary around each harness pass of a
conversation turn. The harness carrying the turn (Claude Code, Codex, …), and
any harness the ghost runs from Bash, keeps its own native hook behavior;
Ghost does not translate, duplicate, or await those hooks.

Ghost supports two events. `before_prompt` runs after the owner submits a prompt
and before the harness is launched with it. It can add advisory context to that
prompt without blocking or creating another turn. `session_stop` runs after a
harness pass ends and before Ghost emits the turn's terminal `done` frame. It
can accept the pass or return context for a continuation pass.

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
event, and are what the Hooks pane shows.
All non-empty `before_prompt` contexts are combined. The first `session_stop`
handler that requests a continuation wins.

Ghost registers no built-in hooks. An optional top-level `builtin` object is
accepted only when empty, so an older `hooks.json` still parses.

`ghost hooks show` prints it and `ghost hooks set <file>` replaces it, so a
ghost asked for a hook can write one. This file configures Ghost's machine-level
awaited command hooks. They run for every principal conversation, above the
harness, and commands run with the daemon user's permissions. It is therefore
a trusted machine configuration
surface, not portable ghost data.

There is no second hook mechanism. A ghost home carries no executable
extension code; everything a hook does is a command in `hooks.json`.

Each machine command runs in an owned process group. Abort, timeout, or the
bounded 1 MiB stdout/stderr limit terminates the whole descendant tree (TERM,
then KILL after the grace period) and drains its pipes before the lifecycle
boundary returns. A background grandchild therefore cannot outlive its hook or
hold the daemon's hook promise open. Synchronous spawn failures, process-start
errors, and unexpected command-runner rejection are generically logged and
fail open for both events; they never fail the owner turn or expose the
command/error payload.

## Host storage metadata

ghostd always sends `ghost_home` and the conversation log's path. A host with
no filesystem ghost home (hosted SummonGhost)
omits those fields and sends `storage: { kind: "backend", ghost_id, session_id }`
instead; a command must not treat those identifiers as local paths.

## `before_prompt` protocol

A command receives the owner prompt, conversation metadata, the harness that
carried the conversation last (absent before its first turn), ghost name,
ghost-home storage root, and the conversation directory:

```json
{
  "type": "before_prompt",
  "prompt": "Continue.",
  "turn_id": 4,
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
  "turn_id": 3,
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
`owner_prompt` is the owner's original request for this turn and does not
change across continuations (it is how keep-going keys the tally). A blocking
result is injected the way Codex and Claude Code inject Stop feedback: a
user-role prompt whose text is `Stop hook feedback:` plus the reason, so the
latest instruction is the hook's reason rather than a repeat of `owner_prompt`.
`transcript_path` is the conversation log on disk
([`conversation-log.ts`](../packages/daemon/src/conversation-log.ts)), one JSON
object per line, so a hook can review the whole owner turn, not just the
current pass: an owner message is `{"type":"user","text"}` with no `origin`; a
follow-up or hook continuation carries `origin` `"follow_up"` or `"hook"`. It
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
Handlers are cancelled when the client aborts the turn.

The owner's queued follow-up outranks a hook: Ghost skips `session_stop` for a
pass while a follow-up waits, and drops a continuation when one arrives while
the hook runs, so a hook never needs to watch for the owner typing. Ghost sets
`stop_hook_active: true` on continuation passes. The hook owns its
continuation policy, the same way Codex Stop hooks do: Ghost will keep honoring
a blocking result until the hook accepts, the client aborts, or the hook fails
open. Use `stop_hook_active` to avoid a loop that will never resolve. The
continuation reason is a Codex-style user-role prompt (`Stop hook feedback:`)
and Ghost shows it in the transcript as a dim "Stop hook" row. An
informational notification alone is not.

Trusted command hooks that need a classifier can invoke
`ghostd hook-smol-complete` (the name predates harnesses). It reads
`{ "ghost_home": "/absolute/home", "prompt": "..." }` from stdin and returns
`{ "text": "..." }`: one headless run of the ghost's preferred eligible
harness, in the order a turn would pick, in a scratch directory with no
persona, conversation, or Ghost tools; a harness that fails hands the prompt
to the next. An older `role` field is ignored.

## Status

Authenticated `GET /api/hooks` returns only `{ active, total, events, hooks }`.
Event rows contain `{ event, count }`; hook rows contain
`{ event, name, description }`. Commands, source paths, arguments, prompts,
injected context, and errors never cross that route.

## Editing

Authenticated `GET /api/hooks/config` returns `{ path, document }`: the
admitted `hooks.json` as one object and its absolute path. `PUT
/api/hooks/config` with a whole document validates it with the same loader,
writes it atomically, and swaps the live command hooks. A rejected document
is a 400 naming the offending field and changes nothing. `before_prompt` and
`session_stop` changes apply at the next boundary.
