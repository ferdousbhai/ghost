# Claude Code plan runtime

Status: implemented for the owner-local runtime. Last policy review: 2026-08-22.

## What this path buys us

Selecting `claude-code/default` makes Ghost run the official Claude Agent SDK
against the owner's installed, unmodified Claude Code executable. The
owner signs into that executable directly with `claude auth login`; Ghost
never receives or stores the Claude credential.

Anthropic currently says Claude Agent SDK usage can draw from a user's Claude
plan limits. That external plan-authenticated runtime remains distinct from an
Anthropic provider configured through pi. The boundary is explicit:

| selection | harness | authentication | accounting path |
|---|---|---|---|
| `anthropic/<model>` | pi | Ghost Secret Service item selected by the ghost's account policy | the provider account's current API/OAuth terms |
| `claude-code/default` | official Claude Agent SDK + installed `claude` | owner's external Claude Code login | owner's Claude plan limits, subject to Anthropic's current policy and any enabled overage |

Policy and product behavior can change. Before making a pricing promise, check
Anthropic's current [Agent SDK plan-usage help page](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

## Setup

Install the official Claude Code CLI, then authenticate outside Ghost:

```bash
claude auth login
claude auth status --json
```

The second command should report `"loggedIn": true` and
`"authMethod": "claude.ai"`. Select the runtime through the normal model API:

```bash
curl -X PUT http://127.0.0.1:7717/api/ghosts/casper/model \
  -H "authorization: Bearer $(ghostd api-token --quiet)" \
  -H 'content-type: application/json' \
  --data '{"provider":"claude-code","id":"default"}'
```

Equivalently, the resulting `<ghost>/models.json` role is:

```json
{
  "providers": {},
  "roles": {
    "chat_model": { "provider": "claude-code", "modelId": "default" }
  }
}
```

There is deliberately no `providers.claude-code` entry and no Claude token in
Ghost's Secret Service schema. `default` delegates model selection to the authenticated
Claude Code installation. Set `GHOST_CLAUDE_BINARY` when `claude` is not on
the daemon's `PATH`. On Omarchy systems where `~/.local/bin/claude` is a mise
launcher, Ghost resolves and gives the Agent SDK the underlying executable;
this avoids launcher notices corrupting the SDK's JSON stream.

## Runtime and security boundary

The implementation is in `packages/daemon/src/claude-code.ts`; its wire
adapter is `packages/daemon/src/claude-pi-messages.ts`.

For each turn Ghost:

1. reads a daemon-shared, five-second executable and token-free
   `claude auth status --json` snapshot (single-flight across catalogue reads
   and turns, and invalidated after a successful login/auth refresh);
2. requires Claude.ai plan auth rather than accepting an API-key-backed
   status;
3. reuses the conversation's persona — the character file, the memory index
   from the ghost home, and the shallow index from the owner's shared XDG
   Documents root — derived once when the daemon first ran a turn for that
   conversation and held until explicit close or idle expiry, then rebuilds the
   Omarchy CLI-first computer-use policy, the owner-deliverable policy, the
   scheduled-work policy rendered from ghostd's one resolved systemd user-unit
   directory, the machine/ghost/project skill index, and the always-active
   declarative instructions;
4. applies the conversation's pre-turn project binding: owner home when
   unbound, or the trusted project cwd plus its approved declarative snapshot;
5. captures the Ghost-specific `@ghost/extensions` tool definitions and
   exposes them as one in-process SDK MCP server;
6. reuses the conversation's live Agent SDK query, starting one only if there
   is none, and pushes the prompt into that query's open input channel, mapping
   the SDK's async message stream onto Ghost's existing pi-messages SSE
   protocol until that turn's `result` frame;
7. persists the opaque Claude session id, listing metadata, and actual cwd,
   completes post-result hooks and maintenance, then emits the terminal event.
   Only a fully settled success leaves the query warm and arms its idle timer.

The query is deliberately unrestricted for its local owner:

- Claude Code's native system prompt is preserved and the Ghost persona is
  appended;
- the native Claude Code tool preset, including Bash/Read/Edit/Write, web
  search, subagents, and background work, remains enabled, with one subtraction:
  `disallowedTools` removes the native tools that would keep durable state or
  reach the owner outside Ghost's surfaces — `CronCreate`, `CronDelete`,
  `CronList`, `ScheduleWakeup`, `EnterPlanMode`, `ExitPlanMode`,
  `AskUserQuestion`, `PushNotification`, and `RemoteTrigger`. Ghost owns
  scheduling as a systemd user timer and plan mode as a pi-only boundary, and
  the daemon has no handler or HUD surface for a native ask. Nothing that is
  merely Claude's own working style is removed, and this is not a throttle;
- filesystem setting sources are pinned to none, so changing cwd cannot admit
  owner/project executable settings, hooks, plugins, or arbitrary MCP;
- the visible ghost home contributes accepted instruction files and rules
  explicitly marked `alwaysApply`; one explicitly trusted project contributes
  the same subset from its immutable snapshot with Pi's exact-name
  project-over-ghost shadowing. Skill, conditional-rule, prompt, and
  Markdown-command bodies do not become always-active instructions. Malformed
  project resources cannot shadow accepted ghost siblings. Valid skills from
  the owner-trusted `~/.agents/skills/` and `~/.pi/agent/skills/` are indexed by
  name, description, and path, but their bodies remain on-demand. Omarchy
  exposes its packaged skills through links in those standard roots. Native SDK
  skill discovery stays empty, and neither cwd nor hidden ghost providers add
  resources;
- because the first-turn MCP translation is persisted for resume, phase 1
  rejects any project MCP row containing environment expansion, stdio env,
  headers, auth/OAuth, or URL userinfo/query before starting Claude. It never
  expands a secret into the sidecar; credential-free stdio/HTTP/SSE rows still
  work. An omitted stdio cwd inherits the query's persisted project cwd; an
  explicit stdio cwd cannot be represented by the SDK translation and is
  rejected with a degraded-state warning rather than run in a different
  directory. MCP timeout values below 1000 milliseconds are likewise rejected
  with an MCP-specific degraded-state warning because the SDK cannot preserve
  them; values at least 1000 are passed through exactly, including on resume;
- project executable extensions, hooks, custom code tools, LSP, and ghost or
  project agent definitions remain disabled pending the per-session isolation
  work in #31. Agent-definition content is never appended to Claude's prompt;
- Ghost's own browser, desktop, and screen tools are added through an in-process
  MCP server. Claude's native `Read`/`Edit`/`Write`/`Glob`/`Grep` preset owns
  character and foreground memory file access;
- `bypassPermissions` is explicit because the HUD has no Claude approval UI;
- inherited provider credential variables are still scrubbed from the child
  environment, including Anthropic API and OAuth token variables.

The ghost tool set contains no vision tool at all. `ghost_screen` returns the
actual image block and Claude consumes it directly. No pi model runtime is
fabricated as a fallback.

The backend is owner-local by construction and uses the owner's external
Claude Code authentication.

## Why the query stays warm

T3 Code keeps a long-lived query fed by an Effect queue. That is correct for a
coding session whose system instructions are stable, and Ghost now agrees.

Ghost originally started one scoped query per turn, because the persona was
re-derived before every turn and keeping a query alive would freeze indexes the
next turn expected to be fresh. That trade is gone: the character file and both
indexes are session-start state, so freezing them is the intended behaviour, not
a hazard. What per-turn queries cost was never mostly cache — it was process
spawn, reloading Claude's transcript from disk, and respawning and
re-handshaking every project stdio MCP server on every single turn.

So a conversation now holds one query. The SDK takes one `AsyncIterable` for the
life of a query, so turns after the first are pushed into that open channel;
the SDK answers each with exactly one `result` frame and leaves the stream open,
which is what lets a turn end without ending the process. `num_turns` is
reported per result rather than cumulatively, so the sidecar's message
accounting is unchanged from the per-turn design.

A warm query is retired — and the next turn starts cold from the sidecar's
resume id — whenever reuse would be wrong or wasteful:

- **Idle.** `CLAUDE_WARM_QUERY_IDLE_TTL_MS`, 30 minutes, deliberately the same
  as a pi hosted session's idle TTL. The timer drops both the process and the
  cached character/index snapshot, so the next turn derives everything again.
- **Changed startup options.** Everything the query was built from — cwd, model,
  the whole system prompt, the ghost tool names, and the project MCP
  configuration — is compared verbatim before reuse. The SDK has no
  `setSystemPrompt`, so a query that disagrees is retired rather than allowed to
  answer under a stale prompt. Anything added to `queryOptions` that the SDK
  fixes at startup belongs in that identity too.
- **Cancellation, active close, or a terminal SDK error.** Cancellation and
  active close use the SDK abort controller plus forceful `close`; Ghost does
  not race an interrupt control request against teardown of that request's
  transport. Every terminal non-success result is persisted for accounting and
  resume, then retired.
- **Post-result failure.** Validation, metadata persistence, hook
  acknowledgement/session-stop handling, and maintenance must all settle
  before reuse. Any failure retires the query so another prompt cannot advance
  its in-memory transcript beyond Ghost's durable sidecar state.
- **`close`, ghost close, conversation delete, and daemon shutdown.**

Ghost keeps T3's important lifecycle — typed startup/stream failures,
async-iterable streaming, authoritative cancellation/close, and scoped
finalization — without the `effect` dependency. A failed or malformed resume
metadata file is still an explicit error; Ghost does not silently start a
replacement conversation.

Session-stop continuations are ordinary extra passes through the same warm
query rather than new queries, capped by
`GHOST_SESSION_STOP_CONTINUATION_CAP` as before.

Claude owns the actual transcript under its normal `~/.claude/projects/`
storage. Ghost stores a `0600` metadata sidecar in `<ghost>/sessions/` so a
conversation can resume after daemon restart and can appear in the existing
session list. Every version requires exact canonical ISO `created` and
`modified` timestamps and rejects invalid or noncanonical values before
maintenance reservation or probing Claude. Version 3 records the actual runtime cwd and the exact bounded
first-turn project declarative/MCP snapshot beside the opaque resume id. Every
later turn and daemon restart reuses those stored project bytes without
reopening the project, then merges them over that query's accepted visible
ghost snapshot. A legacy version-1 sidecar resumes unbound at ghost home for
relative-path history safety; version 2 has cwd but no project snapshot. Either
may promote after a successful unbound turn, while a bound legacy sidecar fails
closed and requires a new conversation. This is an explicit
exception to “the ghost directory is the whole backup”: backing up only the
ghost home does not back up Claude's own transcript. We do not copy that
transcript because doing so would couple Ghost to Claude Code's private storage
format.

A new conversation must choose its trusted project before its first owner
turn. The daemon scans and validates that project's declarative/MCP snapshot
once during pre-stream turn admission, then carries the captured snapshot into
the query without reopening project files. Unsupported secret-bearing MCP is a
normal `409` response before SSE or query creation and leaves the draft
unchanged for retry. A successful first turn fixes Claude's project/cwd for the SDK transcript;
subsequent bind, unbind, and reload requests are rejected and require a new
conversation. This prevents a resume id stored under one Claude project from
silently changing the meaning of relative paths.

The sidecar's `messageCount` remains message-shaped for compatibility with
existing listings. Every SDK query that reaches a terminal result (success or
an SDK terminal error such as the maximum-turn limit) persists its resume id
and adds twice its reported `num_turns`; zero is a valid increment, and
session-stop continuation queries count separately. A query that is aborted or
loses its process before any terminal result changes no count. Existing counts
are preserved.

Hook sequencing is deliberately separate. `ownerTurnCount` advances once per
owner-initiated request, so Claude's internal tool/sampling turns and hidden
session-stop continuations cannot skip hook turn ids. A v1 sidecar without this
field is migrated from the old invariant of two displayed messages per owner
request, then every later sidecar write persists the independent count.

## T3 Code provenance and adaptation

Source reviewed and adapted at T3 Code commit
[`2c4158f87a1b6a586d0aa5e0338f122cb7887c4f`](https://github.com/pingdotgg/t3code/tree/2c4158f87a1b6a586d0aa5e0338f122cb7887c4f),
under T3 Code's MIT license. The required copyright and license text is kept
in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). The adapted sources
are:

- [`ClaudeAdapter.ts`](https://github.com/pingdotgg/t3code/blob/2c4158f87a1b6a586d0aa5e0338f122cb7887c4f/apps/server/src/provider/Layers/ClaudeAdapter.ts):
  injected `query()` seam, SDK option construction, scoped
  AsyncIterable streaming, interrupt/close lifecycle, resume id handling, and
  partial-event normalization;
- [`ClaudeExecutable.ts`](https://github.com/pingdotgg/t3code/blob/2c4158f87a1b6a586d0aa5e0338f122cb7887c4f/apps/server/src/provider/Drivers/ClaudeExecutable.ts):
  explicit installed-executable boundary (Ghost retains the Linux/Omarchy
  subset and adds mise-launcher unwrapping for this desktop environment);
- T3's parent-tool-use filtering: subagent text/thinking is never merged into
  the parent response.

The full T3 provider graph, approvals UI, and long-lived queue were not copied.
Claude Code's own coding tools and subagents remain native. Ghost passes
`settingSources: []` and `skills: []`; declarative skills are not enabled
through Claude's live discovery mechanism because the SDK's `skills: "all"`
filter cannot sandbox discovery to machine paths. Ghost appends the shared
CLI-first policy and admitted machine/ghost/project skill index, plus only the
ghost/project instruction files and `alwaysApply` rules from its bounded,
descriptor-confined snapshot and scoped MCP explicitly. Other declarative
project categories remain stored for resume parity but do not enter every query.
Symbolic links, hidden ghost providers, and ambient cwd resources never enter
that snapshot, and executable settings remain disabled.
The dependency versions match the reviewed T3 implementation:
`@anthropic-ai/claude-agent-sdk@0.3.170`,
`@anthropic-ai/sdk@0.93.0`, `@modelcontextprotocol/sdk@1.29.0`, and
`zod@4.4.3`; Ghost does not take T3's `effect` dependency.

## Legal boundary

Anthropic's current [legal and compliance guidance for Claude Code](https://code.claude.com/docs/en/legal-and-compliance)
says offering Claude Code inside a product requires its Commercial Terms (unless
otherwise agreed) and permits an unmodified binary only when each end user
authenticates themselves and is billed directly. It also forbids products from
intermediating Claude.ai credentials or reselling access. The design above
follows those technical constraints: external login, unmodified executable,
owner-only execution, and no credential transport or storage in Ghost.

The Agent SDK itself is governed by Anthropic's commercial terms. This note
records the engineering interpretation, not legal advice; re-review the linked
terms before distributing a materially different hosted or multi-user flow.
