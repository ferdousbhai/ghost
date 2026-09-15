# Ghost hooks

Ghost owns an awaited lifecycle boundary above its two principal conversation
harnesses. A hook has the same behavior whether the owner-facing conversation
uses pi or the owner-local Claude Code runtime. A `pi`, `codex`, or `claude -p`
child the ghost runs from Bash keeps its own native hook behavior; Ghost does
not translate, duplicate, or await those hooks as principal events.

Ghost supports two events. `before_prompt` runs after the user submits a prompt
but before the model request. It can add advisory context to that request without
blocking or creating another model turn. `session_stop` runs after an assistant
pass and before Ghost emits the turn's terminal `done` frame. It can accept the
pass or return model-visible context for a hidden continuation. The stop boundary
is awaited by Ghost rather than inferred from notification-only
`agent_end` events.

## Configuration

User hooks live in `$XDG_CONFIG_HOME/ghost/hooks.json` (normally
`~/.config/ghost/hooks.json`). Override the file with `GHOSTD_HOOKS`.

```json
{
  "hooks": {
    "before_prompt": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/advisory-context",
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
command's `timeout` (seconds) must be greater than 0 and at most 600.
All non-empty `before_prompt` contexts are combined. The first `session_stop`
handler that requests a continuation wins.

Ghost registers no built-in hooks. An optional top-level `builtin` object is
accepted only when empty, so an older `hooks.json` still parses.

`ghost hooks show` prints it and `ghost hooks set <file>` replaces it, so a
ghost asked for a hook can write one. This file configures Ghost's machine-level
awaited command hooks. They run for every principal conversation, above the
model harness, and commands run with the daemon user's permissions. It is therefore
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
fail open for all three events; they never fail the owner turn or expose the
command/error payload.

## `before_prompt` protocol

A command receives the user prompt, session metadata, runtime, ghost name,
explicit ghost-home storage root, and operational working directory:

```json
{
  "type": "before_prompt",
  "prompt": "Continue.",
  "turn_id": 4,
  "session_id": "...",
  "session_file": "...",
  "ghost_name": "casper",
  "ghost_home": "/home/me/ghosts/casper",
  "cwd": "/home/me/project",
  "runtime": "pi",
  "conversation_id": "conversation-a",
  "conversation_runtime": "pi"
}
```

Exit 0 with no output or `{}` adds nothing. To add model-visible guidance to the
same user-initiated model request, return:

```json
{ "additionalContext": "Avoid the style warning from the previous reply." }
```

`before_prompt` cannot block and does not accept continuation decisions. Errors,
timeouts, and malformed output fail open. Context is hidden from the chat UI: it
is a non-displayed custom context message in the pi session.

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
  "session_id": "...",
  "session_file": "...",
  "transcript_path": "...",
  "stop_hook_active": false,
  "ghost_name": "casper",
  "ghost_home": "/home/me/ghosts/casper",
  "cwd": "/home/me/project",
  "runtime": "pi",
  "conversation_id": "conversation-a",
  "conversation_runtime": "pi"
}
```

`runtime` is `pi`. `messages` exposes only the current
assistant pass; conversation history remains owned by the runtime.
`owner_prompt` is required and immutable across hidden continuation passes.
`transcript_path`, when present, is the pi session file on disk, so a hook can
review the whole owner turn, not just the current pass. It is omitted when no transcript exists yet, and is untrusted
content exactly like `messages`.

Exit 0 with no output or `{}` accepts the pass. Either response below requests a
hidden continuation:

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

Ghost sets `stop_hook_active: true` on continuation passes. As with the native
stop-hook conventions of Codex and Claude Code, the hook owns its continuation
policy, and Ghost honors a blocking result up to `MAX_SESSION_STOP_CONTINUATIONS`
times per owner turn (`hooks.ts`), then accepts the pass and logs it. Hook
authors should still use `stop_hook_active` and normally stop after one
revision. A continuation reason is in model
context; an informational notification alone is not.

Trusted command hooks that need a fast classifier can invoke
`ghostd hook-smol-complete`. It reads `{ "ghost_home": "/absolute/home",
"prompt": "...", "role": "smol_model" }` from stdin and returns
`{ "text": "..." }`. `role` may be `smol_model` or `advisor_model` and defaults
to `smol_model`, preserving the cheapest-usable behavior for existing callers.
An unbound advisor role follows Ghost's advisor preference list instead of the
cheap-model fallback. The command performs one raw completion. It does not
create a session, expose tools, name a concrete provider model, or override the
model's default reasoning level.

## Status

Authenticated `GET /api/hooks` returns only `{ active, total, events, hooks }`.
Event rows contain `{ event, count }`; hook rows contain
`{ event, source, name, description }`, where `source` is `config` for a
`hooks.json` command and `builtin` for an in-process registration made by a
library embedder. Commands, source paths, arguments, prompts,
injected context, errors, receipts, and scheduler state never cross that route.

## Editing

Authenticated `GET /api/hooks/config` returns `{ path, document }`: the
admitted `hooks.json` as one object and its absolute path. `PUT
/api/hooks/config` with a whole document validates it with the same loader,
writes it atomically, and swaps the live command hooks. A rejected document
is a 400 naming the offending field and changes nothing. `before_prompt` and
`session_stop` changes apply at the next boundary.

## In-process API

Library users can construct a `GhostHookRunner`, register an async factory, and
pass it to `SessionHost({ hooks })`:

```ts
const hooks = new GhostHookRunner();
await hooks.register((api) => {
  api.on("before_prompt", async () => ({
    additionalContext: "Remember the advisory from the prior reply.",
  }));
  api.on("session_stop", async (event) => {
    if (event.stop_hook_active) return;
    return { decision: "block", reason: "Run one final verification pass." };
  });
});
```

Factories and handlers are awaited. Handlers run sequentially with a 30-second
default budget.
