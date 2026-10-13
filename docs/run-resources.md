# Per-run resource reporting

Ghost reports evidence from the answering harness, not a scan of installed
skills, plugin directories, or enabled MCP configuration. Each attempt starts
unknown, including fallback and resumed attempts. Only successful passes with
named resources produce a notice, after the reply; unknown and empty fields
are omitted. Internally `null` means unknown and `[]` explicitly empty. Old
transcripts are reprojected with the same filtering. A skill catalog can
contain descriptions rather than full skill bodies; this is not a token-cost
estimate or a list of skills actually invoked.

## Agent audit — 2026-10-13

Probes used scratch working directories with an inert `resource-audit-marker`
skill, a request to reply `OK` without tools or changes, bounded process-group
lifetimes, and no Ghost daemon. Initial Muse probes used its offline echo
provider and private HOME/XDG paths. Initial Copilot probes used a release
unpacked only under `/tmp`, not installed or added to PATH. After the owner
set up authentication, the populated Copilot/OpenCode installations and
Antigravity, Muse, Claude, Pi, Cursor, and OMP were rechecked. No tools were
called in the successful model probes and Crush was skipped at the owner's
request. Fixtures retain only relevant fields
and shorten catalogs; they never retain credentials, plugin paths, or owner
conversation content.

| Agent / checked version | Evidence and reporting |
|---|---|
| Claude 2.1.296 | An authenticated headless run succeeded and reported 45 skills (including the scratch marker), five plugins, and an explicitly empty MCP list in init. The parser returned all three inventory fields. The reduced fixture retains names only. |
| Grok 1.0.52 | A successful headless probe emitted `skills` (names) and `mcp_servers` (explicitly empty) in `system/init`. Both are handled. No `plugins` field was reported, so extensions remain unknown. |
| Copilot 1.0.96 | Successful headless probes, including the owner's installed binary after sign-in, emitted `session.mcp_servers_loaded` and status changes, with `github-mcp-server` connected. Its published schema and bundled runtime also define `session.skills_loaded` and `session.extensions_loaded`; the parser handles them if emitted, but neither appeared in these probes. Those fields therefore stay unknown, not empty. Only enabled skills, running extensions (source-qualified IDs), and connected MCP servers count. |
| Codex 0.162.1 | `exec --json` emitted no inventory. The exact session's rollout did contain the rendered skill catalog in `world_state.state.host_skills.body`, including the scratch marker. Ghost reads names from that catalog after the pass, provided a fresh `turn_context` proves this attempt reached context construction. Plugins and MCP connections remain unknown: disabled plugin IDs and plugin recommendations are not evidence of loaded plugins. |
| Cursor Agent 2026.10.01-e373342 | After completing sign-in, native `status` confirmed authentication and the scratch run succeeded. Init contained type/subtype/auth-source/cwd/session/model/permission fields, with no skill/plugin/MCP inventory, confirming the installed `7000.index.js` emitter. The shared parser would accept compatible inventory fields if a future version adds them; current inventory remains unknown. |
| OMP 18.10.3 | After signing into its default profile's OpenAI Codex provider, the scratch run succeeded with `OK`. Its JSON stream contained a session header, advisor-cost event, and agent/turn/message events, with no resource inventory, confirming the inspected embedded `packages/coding-agent/src/modes/print-mode.ts`. RPC/internal resource-loader access is not evidence on Ghost's JSON print path. Inventory remains unknown. |
| Antigravity 1.3.4 | After sign-in, the native run succeeded with `OK`; its stream was init/step-update/result. Init contained only cwd/tools/permission fields, not a skill/plugin inventory. The parsed inventory remains unknown. |
| OpenCode 1.19.0 | After installation/sign-in, the native run succeeded with `OK`; JSON contained step-start/text/step-finish, no inventory. This confirms the inspected version-tagged `run.ts` path. The existing session DB inspection reads model metadata only. Remains unknown. |
| Crush | Excluded from further checks at the owner's request. No runtime integration or installation was changed. |
| Muse 1.4.7-R6101.1 | Both the offline echo probe and the subsequent authenticated model run succeeded with `OK` and emitted no inventory. The real-model run also emitted model configuration metadata. The binary's exported MSP schema offers session-scoped `skill/list` and `plugin/list`, but `mcpServer/list` is explicitly configuration/auth facts, not connection readiness. Those separate RPC surfaces are not Ghost's `exec --json` path. Remains unknown. |
| Pi 1.2.0 | The configured Anthropic default returned an authentication error (despite CLI exit 0). A retry explicitly selecting the current session's ready OpenAI OAuth provider/model succeeded with `OK`, but the JSON header/events contained no inventory. No default or credential setting was changed; Ghost still has no inventory extraction for its JSON print path. Its current `--help` does expose native MCP support; the older claim that Pi has no MCP client was corrected. Ghost's Pi row still does not forward Ghost MCP servers. |

### Protocol evidence

- [Copilot generated session event types](https://github.com/github/copilot-sdk/blob/b19d3ef043ebfeaeb794339173c39ad6c8eb29ca/nodejs/src/generated/session-events.ts):
  loaded inventory events are transient, with enablement/status fields and
  optional `agentId`. Ghost ignores subagent inventories and never derives a
  complete list from a single status event.
- [OpenCode v1.19.0 JSON run emitter](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/cli/cmd/run.ts).
- `codex app-server generate-ts` and `muse schema generate-ts --experimental`
  export the installed binaries' protocols without model requests. Their
  list/RPC methods were inspected, not invoked as substitute Ghost backends.
- Reduced recorded fixtures: `claude-init-resources.jsonl`,
  `grok-init-resources.jsonl`, `copilot-resources.jsonl`,
  `codex-world-state.jsonl`, `cursor-init-no-inventory.jsonl`, and
  `omp-header-no-inventory.jsonl` under
  `packages/daemon/test/fixtures/harness/`. Additional schema-based tests are
  labelled as such; they are not claimed as recorded native events.

Missing inventories should be filled from future native output or narrowly
attributed session metadata, not by asking the model what it loaded, running a
second discovery process, or changing Ghost into a second agent loop.
