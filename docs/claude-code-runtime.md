# Claude Code harness runtime

Status: owner-local integration with the complete owner-installed Claude Code
harness. Last documentation review: 2026-08-31.

This is the selected Option C boundary: Ghost orchestrates the unrestricted,
unmodified owner-installed CLI and does not substitute a reduced Claude
runtime, credential proxy, or subprocess sandbox.

## What this path buys us

Selecting `claude-code/default` makes Ghost run the official Claude Agent SDK
against the owner's installed, unmodified Claude Code executable. The
owner configures or signs into that executable directly; Ghost never receives a
Claude credential through its API and never stores one in Ghost state.

The external harness remains distinct from an Anthropic provider configured
through pi. The boundary is explicit:

| selection | harness | authentication | accounting path |
|---|---|---|---|
| `anthropic/<model>` | pi | Ghost Secret Service item selected by the ghost's account policy | the provider account's current API/OAuth terms |
| `claude-code/default` | official Claude Agent SDK + installed `claude` | whatever native method that CLI reports logged in: Claude.ai, Console/API, Bedrock, Vertex, Foundry, gateway/router, or a future method | SDK-reported per-turn usage/cost when present; billing and limits remain those of the selected external account/provider |

Ghost does not infer remaining quota. A `total_cost_usd` or token count in an
SDK result is turn accounting only and can be absent or inapplicable for a
native provider route. Policy and product behavior can change; check
Anthropic's current
[authentication](https://code.claude.com/docs/en/authentication) and
[cost-management](https://code.claude.com/docs/en/costs) documentation before
making a pricing promise.

## Setup

Install the official Claude Code CLI version 2.1.251 or newer, then configure or
authenticate it outside Ghost:

```bash
claude auth login
claude auth status --json
```

The second command must report `"loggedIn": true`. `authMethod` and
`apiProvider` are descriptive and are not checked against an allowlist. Select
the runtime through the normal model API:

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
Ghost's Secret Service schema. `default` delegates model selection to the
configured Claude Code installation. Set `GHOST_CLAUDE_BINARY` when `claude` is
not on the daemon's `PATH`. During default discovery, Ghost resolves an
Omarchy/mise `claude` launcher and gives the Agent SDK the underlying
executable; this avoids launcher notices corrupting the SDK's JSON stream. An
explicit `GHOST_CLAUDE_BINARY` remains opaque and is never unwrapped, so it may
be the owner's own environment-exporting wrapper.

The daemon's systemd service does not automatically inherit non-secret selector
variables exported later in a terminal; update its launch environment and
restart it when one of the reviewed selectors below must change. Ghost does not
copy credential values into the Claude environment. When the native auth route
requires an environment-only credential, point `GHOST_CLAUDE_BINARY` at an
owner-installed wrapper that obtains the credential from the owner's mechanism,
exports it after Ghost's launch boundary, and `exec`s the official CLI. This is
also the escape hatch for a new native variable Ghost has not reviewed. The
wrapper may pass its credential to Claude's Bash, hook, MCP, and subagent
children; that inheritance is owned by the wrapper and CLI, not Ghost. Do not
put credential values in `models.json`, Ghost's daemon config, a session file,
the wrapper script, or a systemd unit.

## Runtime and security boundary

The implementation is in `packages/daemon/src/claude-code.ts`; its wire
adapter is `packages/daemon/src/claude-pi-messages.ts`.

Ghost has two deliberately different Claude boundaries. The principal remains
the owner-facing Ghost; delegated Claude is a subordinate native coding worker:

| boundary | principal Claude conversation | delegated native Claude task |
|---|---|---|
| trust and cwd | owner home or one Ghost-trusted project plus its immutable declarative snapshot | one exact project cwd from a freshly revalidated task-binding receipt |
| environment and credentials | finite `claude-principal` profile; a literal owner wrapper may inject its own credentials after Ghost launches it | finite `claude-native` profile; the same wrapper rule applies, and Ghost does not copy credentials into the task |
| tools and execution policy | native preset plus Ghost tools; the explicit exclusions and permission callback below apply | native defaults; only bypass permission mode and its required acknowledgement are set |
| settings, hooks, MCP, plugins, and skills | filesystem setting sources and native plugin/skill discovery are disabled; Ghost supplies its accepted snapshot, translated MCP, and in-process tools | native project/user discovery remains enabled; Ghost supplies none of these fields and may pass only an optional opaque native agent name |
| auto-memory and persistence | auto-memory disabled; Ghost keeps its Claude sidecar, transcript continuity, and one warm query | native defaults remain enabled, including native persistence; Ghost retains only the bounded durable task record and does not resume the worker |
| process ownership | warm SDK child and descendants use the principal process-group retirement boundary | one receipt-bound transient systemd user scope derived from the durable task id; task completion waits for confirmed scope inactivity |

Both paths load the same pinned SDK and admit the same installed executable,
but restrictions documented for the principal must not be projected onto a
delegated worker, and native worker defaults must not expand the principal.

For each turn Ghost:

1. loads the exact owner-installed SDK, resolves and fingerprints the executable
   boundary, and runs `claude --version`. It accepts only one canonical stable
   `<major>.<minor>.<patch> (Claude Code)` line for version 2.1.251 or newer;
2. runs `claude --setting-sources '' --safe-mode --strict-mcp-config auth
   status --json` (the isolation options are global CLI options and precede the
   subcommand), then fingerprints the executable again. Only exit 0 with
   `loggedIn:true` or exit 1 with `loggedIn:false` is valid. A timeout, signal,
   exit 2 or greater, malformed status, exit/JSON disagreement, or executable
   replacement fails closed even when stdout claims `loggedIn:true`. Catalogue
   reads may cache the result for five seconds; every owner turn bypasses that
   cache and performs a fresh, single-flight probe;
3. requires only the boolean `loggedIn` status. Bounded `authMethod`,
   `apiProvider`, and `subscriptionType` values are identity/display metadata,
   not an authorization vocabulary;
4. reuses the conversation's persona — the character file, the memory index
   from the ghost home, and the shallow index from the owner's shared XDG
   Documents root — derived once when the daemon first ran a turn for that
   conversation and held until explicit close or idle expiry, then rebuilds the
   Omarchy CLI-first computer-use policy, the owner-deliverable policy, the
   scheduled-work policy rendered from ghostd's one resolved systemd user-unit
   directory, the machine/ghost/project skill index, and the always-active
   declarative instructions;
5. applies the conversation's pre-turn project binding: owner home when
   unbound, or the trusted project cwd plus its approved declarative snapshot;
6. captures the Ghost-specific `@ghost/extensions` tool definitions and
   exposes them as one in-process SDK MCP server whose deterministic name does
   not collide with any opaque project MCP name;
7. reuses the conversation's live Agent SDK query, starting one only if there
   is none, and pushes the prompt into that query's open input channel, mapping
   the SDK's async message stream onto Ghost's existing pi-messages SSE
   protocol until that turn's `result` frame;
8. persists the opaque Claude session id, listing metadata, and actual cwd,
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
- SDK plugin and skill discovery are pinned to empty, strict MCP configuration
  rejects every ambient MCP source, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
  prevents an ambient Claude memory store from entering the session. The only
  MCP configuration is Ghost's explicit translated project MCP plus its
  in-process tool server;
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
- `permissionMode: "bypassPermissions"` and
  `allowDangerouslySkipPermissions: true` are explicit because the HUD has no
  Claude approval UI. Ghost also supplies the SDK's native `canUseTool`
  fallback, which allows every permission request that survives
  `disallowedTools` without inspecting, rewriting, logging, or persisting its
  input. Claude retains any native safety check it performs before the callback;
- before the global pi scrub, Ghost captures one immutable Claude-only
   environment. The external CLI probe, mise resolution, and every warm or cold
   SDK query receive that same snapshot. It starts empty, copies a fixed
   operational allowlist, then copies only the exact reviewed non-secret
   selector inventory below. It adds only
   `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and
   `CLAUDE_AGENT_SDK_CLIENT_APP=ghostd/0.0.1`. Generic package and registry
   tokens, GitHub tokens, database and Docker configuration, arbitrary
   credential values, Ghost, pi, Codex, unrelated-provider, test, and
   runtime-injection variables are excluded. Ghost never logs, returns, or
   persists copied values;
- Ghost does not set Claude's subprocess environment scrub and does not wrap the
  CLI in `bwrap` or another subprocess sandbox. The unmodified owner-installed
  harness keeps its complete native Bash/tool behavior. The daemon globally
  removes the Claude/cloud families and every other ambient provider credential
  before pi is constructed, but it does not alter variables a literal owner
  wrapper injects after Ghost starts it.

The finite operational inventory copied from ghostd's launch environment is:

```text
COLORTERM
DBUS_SESSION_BUS_ADDRESS
DESKTOP_SESSION
DISPLAY
HOME
HYPRLAND_INSTANCE_SIGNATURE
LANG
LANGUAGE
LC_ALL
LC_COLLATE
LC_CTYPE
LC_MESSAGES
LC_MONETARY
LC_NUMERIC
LC_TIME
LOGNAME
NO_COLOR
PATH
SHELL
SSH_AGENT_PID
SSH_AUTH_SOCK
TEMP
TERM
TERM_PROGRAM
TERM_PROGRAM_VERSION
TMP
TMPDIR
TZ
USER
WAYLAND_DISPLAY
XAUTHORITY
XDG_CACHE_HOME
XDG_CONFIG_HOME
XDG_CURRENT_DESKTOP
XDG_DATA_HOME
XDG_RUNTIME_DIR
XDG_SESSION_CLASS
XDG_SESSION_DESKTOP
XDG_SESSION_TYPE
XDG_STATE_HOME
```

The exact direct non-secret selector inventory is:

```text
ANTHROPIC_AWS_BASE_URL
ANTHROPIC_AWS_WORKSPACE_ID
ANTHROPIC_BASE_URL
ANTHROPIC_BEDROCK_BASE_URL
ANTHROPIC_BEDROCK_MANTLE_BASE_URL
ANTHROPIC_BEDROCK_REGION_PREFIX
ANTHROPIC_BEDROCK_SERVICE_TIER
ANTHROPIC_BETAS
ANTHROPIC_CUSTOM_MODEL_OPTION
ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION
ANTHROPIC_CUSTOM_MODEL_OPTION_NAME
ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES
ANTHROPIC_CONFIG_DIR
ANTHROPIC_DEFAULT_FABLE_MODEL
ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION
ANTHROPIC_DEFAULT_FABLE_MODEL_NAME
ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES
ANTHROPIC_DEFAULT_HAIKU_MODEL
ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION
ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME
ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES
ANTHROPIC_DEFAULT_MODEL
ANTHROPIC_DEFAULT_OPUS_MODEL
ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION
ANTHROPIC_DEFAULT_OPUS_MODEL_NAME
ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES
ANTHROPIC_DEFAULT_SONNET_MODEL
ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION
ANTHROPIC_DEFAULT_SONNET_MODEL_NAME
ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES
ANTHROPIC_FEDERATION_RULE_ID
ANTHROPIC_FOUNDRY_BASE_URL
ANTHROPIC_FOUNDRY_RESOURCE
ANTHROPIC_IDENTITY_TOKEN_FILE
ANTHROPIC_MODEL
ANTHROPIC_ORGANIZATION_ID
ANTHROPIC_PROFILE
ANTHROPIC_SCOPE
ANTHROPIC_SERVICE_ACCOUNT_ID
ANTHROPIC_SMALL_FAST_MODEL
ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
ANTHROPIC_UNIX_SOCKET
ANTHROPIC_VERTEX_BASE_URL
ANTHROPIC_VERTEX_PROJECT_ID
ANTHROPIC_WORKSPACE_ID
AWS_CA_BUNDLE
AWS_CONFIG_FILE
AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
AWS_DEFAULT_REGION
AWS_EC2_METADATA_DISABLED
AWS_EC2_METADATA_SERVICE_ENDPOINT
AWS_ENDPOINT
AWS_ENDPOINT_URL
AWS_PROFILE
AWS_REGION
AWS_ROLE_ARN
AWS_ROLE_SESSION_NAME
AWS_SDK_LOAD_CONFIG
AWS_SHARED_CREDENTIALS_FILE
AWS_WEB_IDENTITY_TOKEN_FILE
AZURE_AUTHORITY_HOST
AZURE_CLIENT_CERTIFICATE_PATH
AZURE_CLIENT_ID
AZURE_CLIENT_SEND_CERTIFICATE_CHAIN
AZURE_FEDERATED_TOKEN_FILE
AZURE_TENANT_ID
AZURE_TOKEN_CREDENTIALS
AZURE_USERNAME
CLAUDE_CODE_API_KEY_HELPER_TTL_MS
CLAUDE_CODE_AWS_CHAIN_RESOLVE_TIMEOUT_MS
CLAUDE_CODE_CERT_STORE
CLAUDE_CODE_CLIENT_CERT
CLAUDE_CODE_CLIENT_KEY
CLAUDE_CODE_API_BASE_URL
CLAUDE_CODE_AUTO_MODE_MODEL
CLAUDE_CODE_BG_CLASSIFIER_MODEL
CLAUDE_CODE_CUSTOM_OAUTH_URL
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
CLAUDE_CODE_GB_BASE_URL
CLAUDE_CODE_OAUTH_CLIENT_ID
CLAUDE_CODE_OAUTH_SCOPES
CLAUDE_CODE_ORGANIZATION_UUID
CLAUDE_CODE_PROXY_RESOLVES_HOSTS
CLAUDE_CODE_REMOTE
CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH
CLAUDE_CODE_SKIP_AWS_CRED_CACHE
CLAUDE_CODE_SKIP_BEDROCK_AUTH
CLAUDE_CODE_SKIP_FOUNDRY_AUTH
CLAUDE_CODE_SKIP_MANTLE_AUTH
CLAUDE_CODE_SKIP_VERTEX_AUTH
CLAUDE_CODE_SUBAGENT_MODEL
CLAUDE_CODE_USE_ANTHROPIC_AWS
CLAUDE_CODE_USE_BEDROCK
CLAUDE_CODE_USE_FOUNDRY
CLAUDE_CODE_USE_MANTLE
CLAUDE_CODE_USE_VERTEX
CLAUDE_CONFIG_DIR
CLAUDE_LOCAL_OAUTH_API_BASE
CLAUDE_LOCAL_OAUTH_APPS_BASE
CLAUDE_LOCAL_OAUTH_CONSOLE_BASE
CLAUDE_SECURESTORAGE_CONFIG_DIR
CLOUD_ML_REGION
GCLOUD_PROJECT
GOOGLE_APPLICATION_CREDENTIALS
GOOGLE_CLOUD_LOCATION
GOOGLE_CLOUD_PROJECT
HTTP_PROXY
HTTPS_PROXY
NODE_EXTRA_CA_CERTS
NO_PROXY
USE_VERTEX
VERTEX_REGION_CLAUDE_3_5_HAIKU
VERTEX_REGION_CLAUDE_3_5_SONNET
VERTEX_REGION_CLAUDE_3_7_SONNET
VERTEX_REGION_CLAUDE_4_0_OPUS
VERTEX_REGION_CLAUDE_4_0_SONNET
VERTEX_REGION_CLAUDE_4_1_OPUS
VERTEX_REGION_CLAUDE_4_5_OPUS
VERTEX_REGION_CLAUDE_4_5_SONNET
VERTEX_REGION_CLAUDE_4_6_OPUS
VERTEX_REGION_CLAUDE_4_6_SONNET
VERTEX_REGION_CLAUDE_4_7_OPUS
VERTEX_REGION_CLAUDE_4_8_OPUS
VERTEX_REGION_CLAUDE_5_OPUS
VERTEX_REGION_CLAUDE_5_SONNET
VERTEX_REGION_CLAUDE_FABLE_5
VERTEX_REGION_CLAUDE_HAIKU_4_5
http_proxy
https_proxy
no_proxy
```

Names such as credential/config/certificate-file paths and account, project,
region, model, route, and proxy selectors are copied as opaque values. A name
whose value is itself an API key, access/bearer/auth/OAuth/refresh/session token,
password/passphrase, secret key, authorization/custom header, or custom request
body is not in the inventory.

Default executable discovery resolves relative `PATH` entries against ghostd's
startup cwd, follows links, and, only when the discovered launcher is a mise
Claude shim, resolves mise's installed executable. Probe and query then share
that one absolute canonical result. An explicit `GHOST_CLAUDE_BINARY` is instead
honored as the literal owner boundary and is never mise-unwrapped or replaced by
its real path; this preserves an owner-supplied wrapper's execution and auth
behavior. In both cases Ghost fingerprints the boundary and resolved target's
device, inode, type, size, and nanosecond change/modify times before and after
auth, and immediately before a new query. Replacement or link retargeting fails
closed and retires warm state. The validated CLI version remains private probe
state and is not added to the model API.

Default mise resolution, version inspection, and auth inspection run through
the same immutable environment in fresh private mode-`0700` scratch working
directories, never the daemon startup or project cwd. Each owned command has a
hard deadline and bounded output. It runs as a detached Linux process group;
cleanup sends TERM and then KILL only to that captured group, drains its pipes,
confirms the group is gone, and removes the scratch directory after success or
failure.

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
  The snapshot owns the timer independently of the query, so a cancellation,
  terminal error, or startup failure cannot retain it forever after the process
  is gone. Turn admission clears the timer synchronously before auth, persona,
  hook, or MCP setup can yield; an admitted turn cannot expire its own session.
- **Changed startup options or external identity.** Everything the query was
  built from — the executable path and fingerprint, validated CLI version,
  bounded authentication/provider/subscription metadata, private account
  fingerprint, cwd, model, whole system prompt, ghost tool names, and project
  MCP configuration — is compared before reuse. The account fingerprint is a
  private SHA-256 digest of a bounded stable account/user id or email plus any
  organization context; it is never logged, persisted, returned, or exposed in
  the model catalogue. When auth status supplies no stable account identity,
  the current turn remains usable but the next turn retires the old query and
  resumes cold. An observed logout or failed auth probe retires immediately, as
  does a changed mise target or explicit wrapper. The SDK has no
  `setSystemPrompt`, so a query that disagrees is retired rather than allowed to
  answer under a stale prompt. Anything added to `queryOptions` that the SDK
  fixes at startup belongs in that identity too.
- **Cancellation, active close, or a terminal SDK error.** Cancellation and
  active close use the SDK abort controller plus forceful `close`; Ghost does
  not race an interrupt control request against teardown of that request's
  transport. Close also aborts and drains a turn that is still in pre-query
  setup, then retires session state a second time before returning. Every
  terminal non-success result is persisted for accounting and resume, then
  retired.
- **Post-result failure.** Validation, metadata persistence, hook
  acknowledgement/session-stop handling, and maintenance must all settle
  before reuse. Any failure retires the query so another prompt cannot advance
  its in-memory transcript beyond Ghost's durable sidecar state.
- **`close`, ghost close, conversation delete, and daemon shutdown.**

The SDK's public `Query.close()` is fire-and-forget. Ghost therefore uses the
SDK's public `spawnClaudeCodeProcess` option and starts the one CLI child as the
leader of a detached Linux process group. Retirement closes the query, sends
TERM to that captured group, waits a bounded grace, then sends KILL to the same
group if any CLI, Bash, hook, MCP, or subagent descendant survives. Close drains
admitted setup and waits for every generation's entire group to disappear. If
that cannot be confirmed within 10 seconds, the operation fails with retryable
`503 claude_code_exit_unconfirmed`; a ghost home has not moved, and retry waits
on the same quiescence boundary. Root-child `exit`, a sent signal,
`ChildProcess.killed`, or an abort signal alone is not acknowledgement. Ghost
never signals its own group or a PID discovered by name or pattern.

Ghost keeps T3's important lifecycle — typed startup/stream failures,
async-iterable streaming, authoritative cancellation/close, and scoped
finalization — without the `effect` dependency. A failed or malformed resume
metadata file is still an explicit error; Ghost does not silently start a
replacement conversation.

Session-stop continuations are ordinary extra passes through the same warm
query rather than new queries. The hook owns its continuation policy and ends
the loop by accepting a stop.

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

The ready sidecar is never replaced merely because another prompt started.
Before every SDK pass, including hidden session-stop continuations, Ghost
atomically writes and fsyncs `<sidecar>.started`. Listing and durable counts
continue to come from the ready sidecar, but resume is blocked while only that
marker describes the uncertain pass; retry starts a fresh SDK session with the
ready sidecar's counters and project snapshot. After a valid result, Ghost
writes the exact candidate as `<sidecar>.settling`, fsyncs it, atomically
publishes the candidate as ready, removes both markers, and fsyncs the
directory. Restart recovery may publish an exact settling candidate; it never
guesses past a started-only marker. Session listing performs the same recovery
before returning rows, including when a first turn left only the settling
candidate. Conversation deletion removes all three files.

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
`settingSources: []`, `plugins: []`, `skills: []`, and
`strictMcpConfig: true`; declarative skills are not enabled
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

Ghost's public runtime does not contain the Agent SDK. For this optional
owner-installed integration, install the exact SDK and peers beneath Ghost's
versioned owner-data boundary:

```sh
if [[ ${XDG_DATA_HOME:-} == /* ]]; then
  sdk_data_root=$XDG_DATA_HOME
else
  sdk_data_root=$HOME/.local/share
fi
sdk_root="$sdk_data_root/ghost/claude-agent-sdk/0.3.170"
install -d -m700 "$sdk_root"
pnpm add --dir "$sdk_root" --save-exact \
  @anthropic-ai/claude-agent-sdk@0.3.170 \
  @anthropic-ai/sdk@0.93.0 \
  @modelcontextprotocol/sdk@1.29.0 \
  zod@4.4.3
```

When `XDG_DATA_HOME` is relative or unset, Ghost uses
`~/.local/share/ghost/claude-agent-sdk/0.3.170`. It resolves no SDK from the
conversation cwd, a project, global modules, or the checkout. A pnpm package
link is accepted only when its target stays beneath that versioned directory,
and Ghost validates the exact root, package, metadata, and entry identity on
every use. It caches the imported module only while that identity remains
stable. A missing or malformed install found before Ghost attempts a dynamic
import can be repaired without restarting; the shared Claude availability probe
may keep its failure for up to five seconds, after which the repaired install
becomes available. Once an import is attempted, however, an import failure
requires a `ghostd` restart after repair because Bun may cache the failed module
graph. Removal or replacement after a successful load also disables Claude turns
immediately and permanently marks that daemon's loader restart-required; it
never returns the stale module or hot-loads the replacement. Repair the install
if needed, then restart `ghostd` to create a fresh loader. The runtime error and
model-catalog warning expose that required action. This is a stable location
boundary, not isolation from code deliberately installed by the same OS owner.
None of this affects Pi.

## Project interpretation and legal boundary

Anthropic's current [legal and compliance guidance for Claude Code](https://code.claude.com/docs/en/legal-and-compliance)
says offering Claude Code inside a product requires its Commercial Terms
(unless otherwise agreed), requires each end user to authenticate and be billed
directly, and forbids intermediating credentials or reselling access. The
design above uses external owner configuration, an unmodified executable,
owner-only execution, and no credential transport or storage in Ghost.

Ghost treats this as driving the owner's complete, unmodified Claude Code
harness: the owner installs it, selects its native auth, and is billed by the
selected external account/provider. The Agent SDK itself is governed by
Anthropic's commercial terms. This is the project's engineering
interpretation, not Anthropic endorsement or legal advice; re-review the linked
terms before distributing a materially different hosted or multi-user flow.
