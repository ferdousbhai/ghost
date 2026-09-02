# Ghost hooks

Ghost owns an awaited lifecycle boundary above its two principal conversation
harnesses. A hook has the same behavior whether the owner-facing conversation
uses pi or the owner-local Claude Code runtime. Delegated native Pi, Codex, and
Claude coding workers do not enter this Ghost hook lifecycle: each worker keeps
its native project/user hook behavior inside its receipt-bound task scope, and
Ghost does not translate, duplicate, or await those hooks as principal events.

Ghost supports three events. `before_prompt` runs after the user submits a prompt
but before the model request. It can add advisory context to that request without
blocking or creating another model turn. `session_stop` runs after an assistant
pass and before Ghost emits the turn's terminal `done` frame. It can accept the
pass or return model-visible context for a hidden continuation. The stop boundary
is awaited by Ghost rather than inferred from notification-only
`agent_end` events. `conversation_idle` runs in the background after a configured
whole-second interval without owner activity. It cannot block or continue a turn.

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
    ],
    "conversation_idle": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/idle-observer",
            "idleSeconds": 60,
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
needs a restart. Groups and handlers run in file order, after any built-in
hooks Ghost registers in code for the same event.
Configured command strings must be non-empty and contain no NUL byte, and a
command's `timeout` (seconds) must be greater than 0 and at most 600.
All non-empty `before_prompt` contexts are combined. The first `session_stop`
handler that requests a continuation wins. `idleSeconds` is a safe integer from
1 through 86400 and defaults to 60; fractional, zero, and out-of-range values
are rejected when configuration is loaded. Idle registrations keep independent
deadlines: Ghost wakes at the earliest one and dispatches only the registrations
then due. After restart it derives each remaining or overdue delay from the
conversation's durable last-activity time. An optional `registrationId` on a
`conversation_idle` command must match `[A-Za-z0-9][A-Za-z0-9._:-]*`, be at
most 128 characters, and remain
stable when its delivery identity must survive configuration reordering;
otherwise Ghost derives a stable identity from the admitted command fields.

An optional top-level `builtin` object tunes hooks that Ghost registers in
code. Each key names one built-in hook — the `settingsKey` on its status row
— and holds `{ "idleSeconds": <integer 1..86400> }`. `memory_upkeep` tunes
the idle interval before memory maintenance runs (default 60). `anti_slop`
names the built-in anti-slop review but takes no `hooks.json` tuning today:
its per-ghost mode and rule list live in the ghost's own `settings.yml` (see
below). The section is validated with the rest of the file and applies at the
next daemon start, not live: a built-in idle registration's identity includes
its interval and persisted retry state refers to that identity.

```json
{ "hooks": {}, "builtin": { "memory_upkeep": { "idleSeconds": 900 } } }
```

This file configures Ghost's machine-level awaited command hooks. They run for
both principal pi and principal Claude Code conversations, above either model
harness, and commands run with the daemon user's permissions. They never run as
delegated-worker hooks. It is therefore a trusted machine configuration
surface, not portable ghost data.

Ghost-owned hook extensions are a separate, pi-only mechanism. Direct,
non-hidden `.js`/`.ts` regular files in a trusted ghost home's visible
`hooks/pre/` and `hooks/post/` directories are Ghost extension factories
written against `packages/extensions/src/extension-api.ts` (`registerTool`,
`before_agent_start`); they run in-process with the daemon user's permissions
and are adapted to pi by the daemon. Ghost opens the home and each parent
directory without following links,
opens the entry itself with `O_NOFOLLOW`, verifies that it is a regular file,
and imports that pinned descriptor before binding the factory to the session.
All dot-prefixed entries are ignored before extension or file-type checks, so
they neither execute nor produce hook diagnostics. Visible symbolic-link entries
and directories are rejected. Owner-home cwd, bound projects, and hidden
compatibility directories never contribute executable hooks.

Treat a ghost home containing those visible hook files as executable code. Do
not place an unreviewed archive or somebody else's hook extension there; remove
the hook files before opening a session if the home is not trusted. The
machine-level `hooks.json` commands and ghost-owned extensions do not share
configuration, ordering, or cross-runtime semantics.

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
timeouts, and malformed output fail open. Context is hidden from the chat UI. In
the pi runtime it is a non-displayed custom context message; in the Claude Code
runtime it is a synthetic, non-querying message paired with the real user prompt.

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

`runtime` is `pi` or `claude-code`. Both runtimes expose only the current
assistant pass in `messages`; conversation history remains owned by the runtime.
`owner_prompt` is required and immutable across hidden continuation passes.
`transcript_path`, when present, is the runtime's native transcript on disk — the
pi session file for pi conversations, the Claude Code SDK session file for Claude
Code conversations — so a hook can review the whole owner turn, not just the
current pass. It is omitted when no transcript exists yet, and is untrusted
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
policy: Ghost keeps honoring a
blocking result until the hook accepts the stop. Hook authors must use
`stop_hook_active` or their own bounded counter to avoid an unbounded loop and
should normally stop after one revision. A continuation reason is in model
context; an informational notification alone is not.

Trusted command hooks that need a fast classifier can invoke
`ghostd hook-smol-complete`. It reads `{ "ghost_home": "/absolute/home",
"prompt": "..." }` from stdin and returns `{ "text": "..." }`. The command
resolves that home's `smol_model` lane (including Ghost's normal cheapest-usable
fallback) and performs one raw completion. It does not create a session, expose
tools, name a concrete provider model, or override the model's default
reasoning level.

Ghost's built-in anti-slop review is a `session_stop` hook (`settingsKey:
anti_slop`) that deterministically lints the final assistant reply with the
engine ported from `ferdousbhai/slop-detector`. It is configured per ghost in
the ghost home's `settings.yml`, not in `hooks.json`:

```yaml
antiSlop:
  mode: strict          # off (default) | advisory | strict
  disabledRules:        # optional rule ids to skip
    - em-dash-density
```

`off` (also absent or unknown) does nothing. `advisory` logs one bounded line
of rule ids and counts — never reply text — and accepts the pass. `strict`
with at least one major finding returns one continuation whose context lists
the findings (rule id, message, fix instruction, short excerpt, capped near
2,000 characters) and instructs the model to rewrite the reply or keep it and
state an overrule reason in one sentence. Minor-only findings in strict mode
log like advisory and accept. The rewrite is bounded to one pass:
`stop_hook_active: true` accepts unconditionally. Only the `text` content
blocks of the final assistant message are analyzed — tool payloads, thinking,
and other content parts never reach the linter, and fenced code blocks inside
the text are skipped. Streamed honesty: the review context itself is injected
hidden like any continuation, but the rewritten reply streams as a visible
continuation of the same turn — text already shown to the owner is never
replaced. Settings or engine failures log once and fail open.

The review also prevents slop before it streams. When the mode is `advisory`
or `strict` at session open, both runtimes append a bounded style-contract
section to the session system prompt — a digest of the rule catalog, minus
`disabledRules`, keeping the rule ids a strict continuation references. That
section is session-static like the rest of the prompt: a `settings.yml` edit
reaches the prompt at the next session open, while the stop-time review reads
the file at each stop boundary and follows the edit at the next reply.

Each reviewed reply with findings also arms one next-turn nudge: the hook's
`before_prompt` handler adds a single line of rule ids and counts from the
previous reply ("chatbot-phrase ×2, hedging-ratio") and clears the record, so
each offending turn produces at most one nudge. A clean final pass clears any
pending nudge. The state is in-process rule-id counts only — never reply text
— bounded to 64 conversations, and non-durable: a daemon restart forgets it,
which merely skips one nudge.

## `conversation_idle` protocol

The event carries the same explicit path and runtime fields plus durable
conversation-maintenance identity:

```json
{
  "type": "conversation_idle",
  "session_id": "conversation-a",
  "session_file": "...",
  "ghost_name": "casper",
  "ghost_home": "/home/me/ghosts/casper",
  "cwd": "/home/me/project",
  "runtime": "pi",
  "conversation_id": "conversation-a",
  "conversation_runtime": "pi",
  "conversation_incarnation": "68c7477b-c759-4a4e-a747-c908159080c2",
  "sequence": 9,
  "source_revision": "pi-leaf:leaf-id",
  "idle_for_ms": 60000,
  "last_turn_outcome": "completed"
}
```

`conversation_runtime` is the durable runtime (`pi` or `claude-code`), while
`runtime` names the awaited-hook harness (`pi` or `claude-code`). The `cwd` is
the actual operational directory after the settled turn; `ghost_home` remains
the separate storage root. `last_turn_outcome` is `completed` or `failed`.
For Pi, `session_id` is the raw Ghost conversation id and `session_file` is its
exact native Pi transcript. For Claude Code, `session_id` is the persisted SDK
resume id while `conversation_id` remains the raw Ghost id, and `session_file`
is that raw id's exact Claude v3 metadata sidecar. Equal raw ids across runtimes
therefore never share a session id/path pair, including after restart.
Command output is ignored and exit 2 cannot block. Errors and timeouts are
logged and fail open.

Ghost's built-in idle-memory hook uses `smol_model` and only memory list/read/
search plus one receipt-journaled write. Transcript text is fenced as untrusted
data. It cannot access Obsidian, character, deletion, network/MCP,
shell, or general session tools. A new owner action, conversation delete,
whole-home move, or shutdown aborts and drains background work before
proceeding. Its exact mode-0600 v1 state is stored per runtime-qualified
conversation beside the transcript and is never cloned during fork. Recovery
replays only the exact journaled bytes when the current memory still matches
the stored `before` digest; it never asks a model to reconstruct an interrupted
write. A transient, aborted, or model failure which leaves pending turns arms
one fixed 60-second retry, including after restart, rather than a zero-delay
loop.

That retry invokes only the built-in memory registration by its exact
registration identity. A command or observer registered at the same 60-second
deadline runs once when ordinarily due and is not repeated with the memory
retry.

For each owner-activity generation, Ghost durably claims a command or observer
before invoking it. This is at-most-once across restart: it prevents duplicate
side effects, while a daemon crash after the claim and before execution may
skip that hook. Built-in memory upkeep is different because its exact receipt
journal makes replay safe: Ghost persists its identity and retry deadline
before invocation and retries it at least once until the pending turn settles.
A new owner action resets both delivery progress and retry state.

A successfully admitted owner action which reaches no model (for example a
native command) records only its operational cwd and last-activity time. It
creates no synthetic transcript turn or pending memory input, but restarts idle
deadlines so hooks observe inactivity from the real owner action. Admission and
its pre-action drain are strict; after the native action succeeds, this record
is fail-open bookkeeping. A write failure is logged and leaves prior pending
maintenance untouched without hiding the successful result or undoing a
durable cwd change.

## Status

Authenticated `GET /api/hooks` returns only `{ active, total, events, hooks }`.
Event rows contain `{ event, count }`; hook rows
contain `{ event, source, name, description }` plus `idleSeconds` only for an
idle hook and `settingsKey` only for a built-in row, where `source` is
`builtin` for an in-process registration and `config` for a `hooks.json`
command. Commands, source paths, arguments, prompts,
injected context, errors, receipts, and scheduler state never cross that route.

## Editing

Authenticated `GET /api/hooks/config` returns `{ path, document }`: the
admitted `hooks.json` as one object and its absolute path. `PUT
/api/hooks/config` with a whole document validates it with the same loader,
writes it atomically, and swaps the live command hooks. A rejected document
is a 400 naming the offending field and changes nothing. `before_prompt` and
`session_stop` changes apply at the next boundary. A changed idle registration
arms from the next owner activity; a deadline already armed against a retired
registration settles as a no-op rather than an error. Built-in hooks such as
memory upkeep are registered in code; the document's `builtin` section tunes
them and applies at the next start.

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
  api.on("conversation_idle", async (event) => {
    console.log(`idle sequence ${event.sequence}`);
  }, {
    idleSeconds: 60,
    registrationId: "my.idle-observer.v1",
    name: "Idle observer",
    description: "Records idle events.",
  });
});
```

Factories and handlers are awaited. Handlers run sequentially with a 30-second
default budget.
