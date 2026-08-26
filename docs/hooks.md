# Ghost hooks

Ghost owns an awaited lifecycle boundary above its model harnesses. A hook has
the same behavior whether a conversation uses OMP or the owner-local Claude Code
runtime.

Ghost supports three events. `before_prompt` runs after the user submits a prompt
but before the model request. It can add advisory context to that request without
blocking or creating another model turn. `session_stop` runs after an assistant
pass and before Ghost emits the turn's terminal `done` frame. It can accept the
pass or return model-visible context for a hidden continuation. The stop boundary
follows OMP's contract rather than inferring completion from notification-only
`agent_end` events. `conversation_idle` runs in the background after a settled
conversation has received no new owner activity for one minute.

Ghost also loads three named built-in handlers. `Conversation continuity` uses
`smol_model` to classify the current pass and sends only uncertain passes to
the selected `advisor_model`. `Memory and docs upkeep` runs `smol_model` after
the idle delay with a restricted context-file tool set. `Maintenance change
context` delivers any resulting changed-file manifest and bounded diff before
the next owner prompt.

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
            "name": "Prompt policy",
            "description": "Adds a small policy reminder before each prompt.",
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
            "name": "Continuity review",
            "description": "Checks whether the current owner request is complete.",
            "timeout": 10
          }
        ]
      }
    ],
    "conversation_idle": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/background-capture",
            "name": "Durable context capture",
            "description": "Updates reusable memory after the conversation settles.",
            "idleSeconds": 60,
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

`name` and `description` are safe owner-facing labels shown in the Hooks UI;
they are limited to 80 and 240 characters. The executable command is never
returned by the status API. A `conversation_idle` hook may set `idleSeconds`
from 1 through 86400; it defaults to 60 and each idle hook keeps its own delay.
Restart `ghostd` after changing the file. Groups
and handlers run in file order.
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
  "conversation_id": "conversation-1",
  "session_id": "...",
  "session_file": "...",
  "ghost_name": "casper",
  "cwd": "/home/me/ghosts/casper",
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

A command receives JSON on stdin. `owner_prompt` contains the current
user-initiated request and remains unchanged across hidden continuations.
`messages` contains only the current assistant pass, not the session history or
prior tool results; `last_assistant_message` contains the same message directly:

```json
{
  "type": "session_stop",
  "conversation_id": "conversation-1",
  "owner_prompt": "Complete the requested change and verify it.",
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
  "cwd": "/home/me/ghosts/casper",
  "runtime": "omp"
}
```

`runtime` is `omp` or `claude-code`. Both runtimes expose only the current owner
prompt and assistant pass; conversation history remains owned by the runtime.

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
six consecutive hidden continuations. Hook authors should normally stop as soon
as the requested outcome is complete. A continuation reason is in model
context; an informational notification alone is not.

The built-in continuity handler calls the advisor at most six times for one
owner turn. Its classifier is the ghost's `smol_model`; its reviewer is the
effective `advisor_model`, including OMP's normal automatic advisor fallback
when the owner has not bound that role explicitly. A classifier or advisor
failure accepts the current pass rather than blocking the conversation.

## `conversation_idle` protocol

When the final assistant pass settles, Ghost starts each idle hook's inactivity
timer for that conversation. The default is 60 seconds. New owner work cancels
the pending timers and aborts a hook that crossed the same boundary, then the
next settled turn starts fresh timers. The event fires once per configured hook:

```json
{
  "type": "conversation_idle",
  "conversation_id": "conversation-1",
  "turn_id": 4,
  "idle_for_ms": 60000,
  "last_turn_outcome": "completed",
  "session_id": "...",
  "session_file": "...",
  "ghost_name": "casper",
  "cwd": "/home/me/ghosts/casper",
  "runtime": "omp"
}
```

`last_turn_outcome` is `completed`, `failed`, or `aborted`. No transcript or
model context is copied into the event. Trusted local consumers may use the
session identity and file reference to do their own bounded background work.
The event cannot alter or continue the reply: stdout and exit 2 are ignored,
while failures and timeouts are logged without surfacing in the conversation.

The built-in memory/docs updater keeps its processed-turn watermark and pending
delta in `sessions/context-maintenance.json`. It supplies `smol_model` only six
operations: list, read, and search context; write a doc; write a memory; and
recoverably delete a doc or memory file. It has no shell, network, browser,
character, MCP, or general session tools.

If that model changes durable files, Ghost queues a changed-path manifest and a
unified diff capped at 4096 bytes. The next owner turn receives the notice as
hidden context. Ghost removes it from the queue only after the runtime confirms
delivery. The hidden message then remains in conversation history, so it is not
repeated on every turn. A no-change run injects nothing.

## Owner-visible status

`GET /api/hooks` returns each hook's owner-facing name, description, trigger
event, aggregate event counts, and the `session_stop` continuation cap. The
shell's Hooks navigation destination shows those labels and badges the total
active count. Idle rows include their configured delay. Commands, arguments,
source paths, and injected context are never returned.

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
  api.on("conversation_idle", async () => {
    // Background work.
  }, { idleSeconds: 600, timeoutSeconds: 120 });
});
```

Factories and handlers are awaited. Handlers run sequentially with a 30-second
default budget; each in-process handler may set `timeoutSeconds` up to 600.
