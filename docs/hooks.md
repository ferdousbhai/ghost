# Ghost hooks

Ghost owns an awaited lifecycle boundary above its model harnesses. A hook has
the same behavior whether a conversation uses pi or the owner-local Claude Code
runtime.

The first supported event is `session_stop`: it runs after an assistant pass and
before Ghost emits the turn's terminal `done` frame. A hook can accept the pass
or return model-visible context for a hidden continuation. This follows OMP's
contract rather than trying to infer completion from notification-only
`agent_end` events.

## Configuration

User hooks live in `$XDG_CONFIG_HOME/ghost/hooks.json` (normally
`~/.config/ghost/hooks.json`). Override the file with `GHOSTD_HOOKS`.

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

Restart `ghostd` after changing the file. Groups and handlers run in file order.
The first handler that requests a continuation wins.

Ghost deliberately does not discover executable hooks inside a ghost home. A
home can come from an imported archive, so treating files under it as code would
turn data import into arbitrary code execution. The user-level hook file is a
trusted machine configuration surface. Commands run with the daemon user's
permissions.

## `session_stop` protocol

A command receives JSON on stdin:

```json
{
  "type": "session_stop",
  "messages": [],
  "turn_id": 3,
  "last_assistant_message": {
    "role": "assistant",
    "content": [{ "type": "text", "text": "The answer." }]
  },
  "session_id": "...",
  "session_file": "...",
  "stop_hook_active": false,
  "ghost_name": "casper",
  "cwd": "/home/me/Ghosts/casper",
  "runtime": "pi"
}
```

`runtime` is `pi` or `claude-code`. Claude Code exposes the current assistant
pass in `messages`; its full transcript remains owned by Claude Code.

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
and timeouts are logged and fail open, matching OMP's `session_stop` policy.
Handlers are cancelled when the client aborts the turn.

Ghost sets `stop_hook_active: true` on continuation passes and permits at most
eight consecutive hidden continuations. Hook authors should normally stop after
one revision. A continuation reason is in model context; an informational
notification alone is not.

## In-process API

Library users can construct a `GhostHookRunner`, register an async factory, and
pass it to `SessionHost({ hooks })`:

```ts
const hooks = new GhostHookRunner();
await hooks.register((api) => {
  api.on("session_stop", async (event) => {
    if (event.stop_hook_active) return;
    return { decision: "block", reason: "Run one final verification pass." };
  });
});
```

Factories and handlers are awaited. Handlers run sequentially with a 30-second
default budget.
