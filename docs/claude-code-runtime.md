# Claude Code runtime

`claude-code/default` runs the official Claude Agent SDK against the owner's
installed, unmodified Claude Code. Ghost orchestrates that harness; it does not
proxy credentials, replace Claude's native tool loop, or claim its billing and
quota.

This is distinct from selecting an Anthropic model through Pi:

| Selection | Harness | Authentication |
|---|---|---|
| `anthropic/<model>` | Pi | pi's own login under the ghost's `.pi/auth.json` |
| `claude-code/default` | Claude Agent SDK + installed `claude` | Any native method for which `claude auth status --json` reports `loggedIn:true` |

## Setup

Install Claude Code 2.1.251 or newer and authenticate it outside Ghost:

```sh
claude auth login
claude auth status --json
```

Install the exact SDK closure under Ghost's versioned XDG data root:

```text
$XDG_DATA_HOME/ghost/claude-agent-sdk/0.3.170/
  package.json
  node_modules/@anthropic-ai/claude-agent-sdk
```

The required versions are `@anthropic-ai/claude-agent-sdk@0.3.170`,
`@anthropic-ai/sdk@0.93.0`, `@modelcontextprotocol/sdk@1.29.0`, and
`zod@4.4.3`. When `XDG_DATA_HOME` is not absolute, the root is
`~/.local/share/ghost/claude-agent-sdk/0.3.170`.

Select the runtime through the model API or HUD:

```sh
curl -X PUT http://127.0.0.1:7717/api/ghosts/casper/model \
  -H "authorization: Bearer $(ghostd api-token --quiet)" \
  -H 'content-type: application/json' \
  --data '{"provider":"claude-code","id":"default"}'
```

The stored role is:

```json
{
  "roles": {
    "chat_model": { "provider": "claude-code", "modelId": "default" }
  }
}
```

There is no `providers.claude-code` entry and no Claude credential in the
ghost's `.pi/auth.json`. `GHOST_CLAUDE_BINARY` may select an explicit owner wrapper when
`claude` is not on the daemon PATH or a native route needs environment setup.
Ghost treats that wrapper as an owner trust boundary and never unwraps it.

## Runtime boundary

Before each admitted owner turn Ghost:

1. validates the exact SDK root, metadata, entry, and required exports;
2. resolves and fingerprints the executable, checks its minimum version, then
   runs isolated `claude auth status --json` and requires `loggedIn:true`;
3. builds or reuses the conversation persona;
4. exposes Ghost tools as one in-process SDK MCP server and translates only the
   credential-free ghost-home MCP rows;
5. routes native `AskUserQuestion` permission callbacks through Ghost's
   conversation-scoped ask broker and existing HUD dialog;
6. starts or reuses one warm SDK query and maps its messages onto Ghost's
   pi-messages protocol;
7. persists opaque resume metadata and actual cwd, runs awaited hooks and
   journals the settled turn, then publishes the terminal event.

The exact probes, timeouts, identity rechecks, process-group teardown, warm
query lifecycle, and resume transaction are executable in
[`claude-code.ts`](../packages/daemon/src/claude-code.ts) and
[`claude-code.test.ts`](../packages/daemon/test/claude-code.test.ts). The wire
adapter is
[`claude-pi-messages.ts`](../packages/daemon/src/claude-pi-messages.ts).

When a ghost runs `claude -p` from its own Bash, that child is a plain Claude
Code process: it retains Claude Code's native project settings, skills, agents,
MCP, tools, persistence, and subagents, and Ghost injects no principal persona
there. Ghost owns nothing about it beyond the Bash job that
systemd scope. Both paths use the same pinned SDK loader and authenticated
installed executable.

### What Claude keeps

- its native system prompt, with Ghost's persona/policy appended;
- Bash, file tools, native image understanding, web tools, subagents,
  background tasks, todos, planning, scheduling, notifications, remote
  triggers, and native working style;
- native `AskUserQuestion`, with Markdown previews and its owner interaction
  handled by Ghost instead of Claude's terminal UI;
- unrestricted local execution under `bypassPermissions`, because the HUD has
  no Claude approval surface;
- the owner installation's native authentication and provider routing.

### What Ghost adds or redirects

Ghost does not deny or replace any tool in Claude's native preset. Native
scheduling, notifications, remote triggers, worktrees, agents, and every other
preset tool retain Claude's own semantics and storage. Ghost's in-process
browser/screen/desktop tools are additive. Claude auto-memory is disabled.
Owner-visible durable knowledge, plans, and tasks live in the owner's documents;
ghost-private continuity uses the ghost home's memory files.

This is a native-first boundary: if the `claude_code` preset already provides a
capability, Claude uses that native tool with its original name, input schema,
output, and behavior. Ghost may project its interaction into an existing UI—as
with `AskUserQuestion`—but does not wrap it in a competing model-facing tool.
Ghost adds a tool only for a Ghost-specific capability absent from the preset,
and additive tools may not shadow native ones. The preset is not enumerated by
Ghost, so compatible Claude Code releases can add native tools without a daemon
change.

Claude's model-facing question signature stays native. Pi's `ask` mirrors the
same `questions`/`header`/`options`/`multiSelect` input and
`answers`/`annotations` output. The pi-messages adapter normalizes the visible
tool name to `ask`, so the daemon route, HUD activity, timeout, dismissal, and
chat-redirect behavior do not depend on which principal runtime is active.

### Principal capability parity

| Capability | Pi principal | Claude Code principal |
|---|---|---|
| Native tool preset | Pi's admitted native tools | Claude's complete unfiltered `claude_code` preset |
| Owner questions | Ghost `ask`, using the native Claude signature and result | Native `AskUserQuestion`, routed through the same broker and HUD |
| Image understanding | Model-native when the chat model accepts images; otherwise `inspect_image` | Native vision; no redundant `inspect_image` |
| Browser, screen, desktop | Ghost runtime-neutral tools | The same Ghost tools through the SDK MCP bridge |
| Files, search, shell | Pi-native tools; Ghost wraps Bash in `GhostJob` | Claude-native tools and background tasks |
| Skills, rules, prompts | Admitted declarative snapshot | The same admitted bytes appended to Claude's native prompt |
| MCP | Every ghost-home row through Ghost's MCP manager | Credential-free ghost-home rows only; the rest report as skipped |
| Ghost-home executable hook extensions | Pi-native extension factories | Not admitted |
| Transcript, branches, commands, job API | Daemon-visible Pi session state | Native opaque Claude session state; the transcript API serves a thin settled-turn presentation journal, the rest stays unsupported |

The last three differences are boundaries, not substitute tools. MCP is a
real remaining capability gap: the current Claude snapshot cannot persist
secret-bearing rows and the SDK configuration cannot express Ghost's
per-server cwd. Ghost-home executable hook extensions are coupled to Pi's
extension API. Branching, command expansion, and background-task state are
runtime mechanics that Ghost does not emulate on top of Claude's opaque
session; the presentation journal is a daemon-owned display record, not an
emulation of Claude's transcript.

Filesystem setting sources, SDK plugin/skill discovery, and ambient MCP are
empty. Ghost supplies only the explicit machine/ghost declarative snapshot,
credential-free ghost-home MCP, and its in-process tools. Nothing is discovered
from the working directory.

Claude reads and writes the owner's XDG Documents directory with its own
native file and search tools; the owner-context policy names the directory and
nothing more.

### As the advisor

Claude Code also serves the review teacher, bound as `roles.advisor_model`.
That query is not a principal session: no persona, no Ghost tools, no warm query, no resume metadata, and nothing written to Claude
Code's own session storage. It goes through the same SDK loader, executable
probe, and reviewed child environment as the principal path, and it is
independent of which runtime drives the ghost — a Pi-driven ghost gets Claude
as its teacher exactly as a Claude-driven one does. A missing or signed-out
`claude` makes the binding raise the same unusable-model error an explicit
unusable smol binding raises; the review pass around it then fails open.
`CONTRACTS.md` states the exact query it runs; the pipeline it feeds is in
[`docs/hooks.md`](hooks.md), and the code is
[`hook-claude-complete.ts`](../packages/daemon/src/hook-claude-complete.ts).

## Environment and credential isolation

Ghost captures a Claude child environment before globally scrubbing provider
credentials for Pi. The child starts empty and receives only operational OS
variables plus the reviewed non-secret provider selectors in
`CLAUDE_CODE_SAFE_ENV_VARS`. API keys, bearer/auth/OAuth/session tokens,
passwords, secret keys, custom authorization headers/bodies, package registry
credentials, arbitrary daemon variables, and Ghost/Pi/Codex variables do not
enter it.

The same immutable environment is used only for executable discovery, version
and auth probes, and SDK queries. Values are never logged, persisted, or
returned. If a native provider requires an environment-only credential, an
owner-controlled `GHOST_CLAUDE_BINARY` wrapper may obtain and export it after
Ghost's launch boundary before `exec`ing the official CLI. Inheritance by
Claude's Bash, hooks, MCP, or subagents is then the wrapper/CLI owner's
responsibility.

The normative allowlist and negative credential corpus are in
[`claude-code.ts`](../packages/daemon/src/claude-code.ts),
[`env-scrub.ts`](../packages/daemon/src/env-scrub.ts), and their tests.

## Session behavior

One query remains warm per conversation so Claude's native session context,
subagents, and tool state survive turns. It expires after the configured idle
TTL, explicit close, ghost move, runtime change, or daemon shutdown. A failed turn is retired unless its result was fully settled.

Ghost stores an opaque Claude session id and resume fence under the ghost
home. The actual Claude transcript remains in Claude Code's own storage; Pi
branching stays unavailable for this runtime. The Ghost transcript endpoint,
however, serves a presentation journal the daemon appends after each settled
turn: the owner prompt and the final assistant text, without tool activity or
intermediate messages. A conversation that predates the journal reads as empty
with `historyTruncated: true`, which the HUD renders as an
earlier-history-unavailable notice; a failed journal write never fails the
turn and surfaces the same way.
The working directory is fixed by Claude's resume metadata after its first
published message; a new conversation starts in the ghost's configured cwd.
Background jobs exposed by Claude's native harness
remain native; Ghost's own process-local job API applies to Pi sessions.

`authMethod`, `apiProvider`, `subscriptionType`, SDK token usage, and
`total_cost_usd` are descriptive turn/status metadata. Ghost does not infer
quota, subscription entitlement, or remaining spend from them. Consult
Anthropic's current documentation before making pricing claims.
