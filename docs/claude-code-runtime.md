# Claude Code runtime

`claude-code/default` runs the official Claude Agent SDK against the owner's
installed, unmodified Claude Code. Ghost orchestrates that harness; it does not
proxy credentials, replace Claude's native tool loop, or claim its billing and
quota.

This is distinct from selecting an Anthropic model through Pi:

| Selection | Harness | Authentication |
|---|---|---|
| `anthropic/<model>` | Pi | Ghost-selected Secret Service account |
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

There is no `providers.claude-code` entry and no Claude credential in Ghost's
keyring schema. `GHOST_CLAUDE_BINARY` may select an explicit owner wrapper when
`claude` is not on the daemon PATH or a native route needs environment setup.
Ghost treats that wrapper as an owner trust boundary and never unwraps it.

## Runtime boundary

Before each admitted owner turn Ghost:

1. validates the exact SDK root, metadata, entry, and required exports;
2. resolves and fingerprints the executable, checks its minimum version, then
   runs isolated `claude auth status --json` and requires `loggedIn:true`;
3. builds or reuses the conversation persona and trusted-project snapshot;
4. exposes Ghost tools as one in-process SDK MCP server and translates only the
   admitted, credential-free project MCP rows;
5. starts or reuses one warm SDK query and maps its messages onto Ghost's
   pi-messages protocol;
6. persists opaque resume metadata and actual cwd, runs awaited hooks and
   maintenance, then publishes the terminal event.

The exact probes, timeouts, identity rechecks, process-group teardown, warm
query lifecycle, and resume transaction are executable in
[`claude-code.ts`](../packages/daemon/src/claude-code.ts) and
[`claude-code.test.ts`](../packages/daemon/test/claude-code.test.ts). The wire
adapter is
[`claude-pi-messages.ts`](../packages/daemon/src/claude-pi-messages.ts).

### What Claude keeps

- its native system prompt, with Ghost's persona/policy appended;
- Bash, file tools, web tools, subagents, todos, planning, and native working
  style;
- unrestricted local execution under `bypassPermissions`, because the HUD has
  no Claude approval surface;
- the owner installation's native authentication and provider routing.

### What Ghost removes or replaces

`AskUserQuestion`, native cron/scheduling, push notifications, remote triggers,
and scheduled wakeups are disabled because Ghost owns those surfaces or has no
safe route for them. Claude auto-memory is disabled. Owner-visible durable
knowledge, plans, and tasks use Obsidian; ghost-private continuity uses the
ghost home's memory files.

Filesystem setting sources, SDK plugin/skill discovery, and ambient MCP are
empty. Ghost supplies only the explicit machine/ghost/project declarative
snapshot, credential-free project MCP, and its in-process tools. Executable
project hooks/plugins/tools, LSP, and project agent definitions remain disabled
pending the isolation boundary in #31.

The shared prompt links
`~/.agents/skills/obsidian-cli/SKILL.md`. Claude uses `obsidian` exclusively,
with the current CLI vault by default or `vault=<name>` when the owner names
one. It never scans for a vault, assumes `~/Documents`, or edits vault files
directly. Missing skill/CLI/application readiness is reported as incomplete
setup.

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
TTL, explicit close, project transition, ghost move, runtime change, or daemon
shutdown. A failed turn is retired unless its result was fully settled.

Ghost stores an opaque Claude session id and resume fence under the ghost
home. The actual Claude transcript remains in Claude Code's own storage, so the
Ghost transcript endpoint and Pi branching are not available for this runtime.
Project binding is fixed after Claude's first published message; changing it
requires a new conversation. Background jobs exposed by Claude's native harness
remain native; Ghost's own process-local job API applies to Pi sessions.

`authMethod`, `apiProvider`, `subscriptionType`, SDK token usage, and
`total_cost_usd` are descriptive turn/status metadata. Ghost does not infer
quota, subscription entitlement, or remaining spend from them. Consult
Anthropic's current documentation before making pricing claims.
