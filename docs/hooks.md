# Ghost hooks

Ghost owns an awaited lifecycle boundary above its model harnesses. A hook has
the same behavior whether a conversation uses OMP or the owner-local Claude Code
runtime.

Ghost supports two events. `before_prompt` runs after the user submits a prompt
but before the model request. It can add advisory context to that request without
blocking or creating another model turn. `session_stop` runs after an assistant
pass and before Ghost emits the turn's terminal `done` frame. It can accept the
pass or return model-visible context for a hidden continuation. The stop boundary
follows OMP's contract rather than inferring completion from notification-only
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

Restart `ghostd` after changing the file. Groups and handlers run in file order.
All non-empty `before_prompt` contexts are combined. The first `session_stop`
handler that requests a continuation wins.

Ghost deliberately does not discover executable hooks inside a ghost home. A
home can come from an imported archive, so treating files under it as code would
turn data import into arbitrary code execution. The user-level hook file is a
trusted machine configuration surface. Commands run with the daemon user's
permissions.

## `before_prompt` protocol

A command receives the user prompt, session metadata, runtime, ghost name, and
working directory:

```json
{
  "type": "before_prompt",
  "prompt": "Continue.",
  "turn_id": 4,
  "session_id": "...",
  "session_file": "...",
  "ghost_name": "casper",
  "cwd": "/home/me/Ghosts/casper",
  "runtime": "omp"
}
```

Exit 0 with no output or `{}` adds nothing. To add model-visible guidance to the
same user-initiated model request, return:

```json
{ "additionalContext": "Avoid the style warning from the previous reply." }
```

`before_prompt` cannot block and does not accept continuation decisions. Errors,
timeouts, and malformed output fail open. Context is hidden from the chat UI. In
the OMP runtime it is a non-displayed custom context message; in the Claude Code
runtime it is a synthetic, non-querying message paired with the real user prompt.

## `session_stop` protocol

A command receives JSON on stdin. `messages` contains only the current assistant
pass, not the session history or prior tool results; `last_assistant_message`
contains the same message directly:

```json
{
  "type": "session_stop",
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
  "stop_hook_active": false,
  "ghost_name": "casper",
  "cwd": "/home/me/Ghosts/casper",
  "runtime": "omp"
}
```

`runtime` is `omp` or `claude-code`. Both runtimes expose only the current
assistant pass in `messages`; conversation history remains owned by the runtime.

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
two consecutive hidden continuations. Hook authors should normally stop after
one revision. A continuation reason is in model context; an informational
notification alone is not.

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
