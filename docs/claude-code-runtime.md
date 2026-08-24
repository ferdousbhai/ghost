# Claude Code plan runtime

Status: implemented for creator-local sessions. Last policy review: 2026-08-22.

## What this path buys us

Selecting `claude-code/default` makes Ghost run the official Claude Agent SDK
against the creator's installed, unmodified Claude Code executable. The
creator signs into that executable directly with `claude auth login`; Ghost
never receives or stores the Claude credential.

Anthropic currently says Claude Agent SDK usage can draw from a user's Claude
plan limits. That external plan-authenticated runtime remains distinct from an
Anthropic provider configured through OMP. The boundary is explicit:

| selection | harness | authentication | accounting path |
|---|---|---|---|
| `anthropic/<model>` | OMP | per-ghost `.pi/agent.db` | the provider account's current API/OAuth terms |
| `claude-code/default` | official Claude Agent SDK + installed `claude` | creator's external Claude Code login | creator's Claude plan limits, subject to Anthropic's current policy and any enabled overage |

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

Equivalently, the resulting `<ghost>/.pi/models.json` role is:

```json
{
  "providers": {},
  "roles": {
    "chat_model": { "provider": "claude-code", "modelId": "default" }
  }
}
```

There is deliberately no `providers.claude-code` entry and no Claude token in
Ghost's `.pi/agent.db`. `default` delegates model selection to the authenticated
Claude Code installation. Set `GHOST_CLAUDE_BINARY` when `claude` is not on
the daemon's `PATH`. On Omarchy systems where `~/.local/bin/claude` is a mise
launcher, Ghost resolves and gives the Agent SDK the underlying executable;
this avoids launcher notices corrupting the SDK's JSON stream.

## Runtime and security boundary

The implementation is in `packages/daemon/src/claude-code.ts`; its wire
adapter is `packages/daemon/src/claude-pi-messages.ts`.

For each turn Ghost:

1. resolves the installed executable and runs the token-free
   `claude auth status --json` preflight;
2. requires Claude.ai plan auth rather than accepting an API-key-backed
   status;
3. rebuilds the persona, memory index, and doc catalogue from the ghost home;
4. captures the Ghost-specific `@ghost/extensions` tool definitions and
   exposes them as one in-process SDK MCP server;
5. starts an Effect-scoped Agent SDK query and maps the SDK's async message
   stream onto Ghost's existing pi-messages SSE protocol;
6. persists only the opaque Claude session id and listing metadata before it
   emits the terminal `done`, then closes the query process.

The query is deliberately unrestricted for its local creator:

- Claude Code's native system prompt is preserved and the Ghost persona is
  appended;
- the native Claude Code tool preset, including Bash/Read/Edit/Write, web
  search, subagents, and background work, remains enabled;
- user/project settings, instructions, skills, plugins, and MCP servers use
  Claude Code's normal discovery;
- Ghost's own browser, desktop, character, and structured memory writer are
  added through an in-process MCP server;
- `bypassPermissions` is explicit because the HUD has no Claude approval UI;
- inherited provider credential variables are still scrubbed from the child
  environment, including Anthropic API and OAuth token variables.

The ghost tool set contains no vision tool at all. `ghost_screen` returns the
actual image block and Claude consumes it directly. No OMP `ModelRegistry` is
fabricated as a fallback.

The backend is owner-local by construction. If a session is resolved with a
visitor scope, it fails with `claude_code_owner_only`; Phase 2 visitor traffic
must authenticate as that visitor or use a creator-funded API/provider path.
The creator's plan is never shared, proxied, or resold.

## Why one Effect scope per turn

T3 Code keeps a long-lived query fed by an Effect queue. That is correct for a
coding session whose system instructions are stable. A Ghost system prompt is
not stable: memory files and doc visibility are derived again before every
turn. Keeping one query alive would freeze those indexes.

Ghost therefore retains T3's important lifecycle—typed startup/stream
failures, `Stream.fromAsyncIterable`, interruption through the SDK query, and
scoped finalization—but closes after one turn. The next turn resumes with the
opaque Claude session id and a freshly derived system prompt. A failed or
malformed resume metadata file is an explicit error; Ghost does not silently
start a replacement conversation.

Claude owns the actual transcript under its normal `~/.claude/projects/`
storage. Ghost stores a `0600` metadata sidecar in `<ghost>/.sessions/` so a
conversation can resume after daemon restart and can appear in the existing
session list. This is an explicit exception to “the ghost directory is the
whole backup”: backing up only the ghost home does not back up Claude's own
transcript. We do not copy that transcript because doing so would couple Ghost
to Claude Code's private storage format.

## T3 Code provenance and adaptation

Source reviewed and adapted at T3 Code commit
[`2c4158f87a1b6a586d0aa5e0338f122cb7887c4f`](https://github.com/pingdotgg/t3code/tree/2c4158f87a1b6a586d0aa5e0338f122cb7887c4f),
under T3 Code's MIT license. The required copyright and license text is kept
in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). The adapted sources
are:

- [`ClaudeAdapter.ts`](https://github.com/pingdotgg/t3code/blob/2c4158f87a1b6a586d0aa5e0338f122cb7887c4f/apps/server/src/provider/Layers/ClaudeAdapter.ts):
  injected `query()` seam, SDK option construction, Effect-scoped
  AsyncIterable streaming, interrupt/close lifecycle, resume id handling, and
  partial-event normalization;
- [`ClaudeExecutable.ts`](https://github.com/pingdotgg/t3code/blob/2c4158f87a1b6a586d0aa5e0338f122cb7887c4f/apps/server/src/provider/Drivers/ClaudeExecutable.ts):
  explicit installed-executable boundary (Ghost retains the Linux/Omarchy
  subset and adds mise-launcher unwrapping for this desktop environment);
- T3's parent-tool-use filtering: subagent text/thinking is never merged into
  the parent response.

The full T3 provider graph, approvals UI, and long-lived queue were not copied;
Claude Code's own coding tools, project settings, plugins, skills, MCP, and
subagents are used directly instead of reimplementing T3's surfaces.
The dependency versions match the reviewed T3 implementation:
`@anthropic-ai/claude-agent-sdk@0.3.170`,
`@anthropic-ai/sdk@0.93.0`, `@modelcontextprotocol/sdk@1.29.0`,
`effect@4.0.0-beta.103`, and `zod@4.4.3`.

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
