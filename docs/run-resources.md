# Per-run resource reporting

Ghost reports evidence from the answering harness, not a scan of installed
skills, plugin directories, or enabled MCP configuration. Each attempt starts
unknown, including fallback and resumed attempts. **Not reported** means
unknown; **none** means an explicitly empty inventory. A skill catalog can
contain descriptions rather than full skill bodies; this is not a token-cost
estimate or a list of skills actually invoked.

## Agent audit — 2026-10-13

Probes used scratch working directories with an inert `resource-audit-marker`
skill, a request to reply `OK` without tools or changes, bounded process-group
lifetimes, and no Ghost daemon. Muse used its offline echo provider and private
HOME/XDG paths. The Copilot release was unpacked only under `/tmp`, not installed
or added to PATH: the owner's Copilot and OpenCode commands were mise wrappers
with no populated runtime installation. Fixtures retain only relevant fields
and shorten catalogs; they never retain credentials, plugin paths, or owner
conversation content.

| Agent / checked version | Evidence and reporting |
|---|---|
| Claude | Its compatible init schema is handled by the original PR: `skills`, `plugins`, `mcp_servers`. No new Claude probe in this audit. |
| Grok 1.0.52 | A successful headless probe emitted `skills` (names) and `mcp_servers` (explicitly empty) in `system/init`. Both are handled. No `plugins` field was reported, so extensions remain unknown. |
| Copilot 1.0.96 | Successful headless probes emitted `session.mcp_servers_loaded` and status changes, with `github-mcp-server` connected. Its published schema and bundled runtime also define `session.skills_loaded` and `session.extensions_loaded`; the parser handles them if emitted, but neither appeared in these probes. Those fields therefore stay unknown, not empty. Only enabled skills, running extensions (source-qualified IDs), and connected MCP servers count. |
| Codex 0.162.1 | `exec --json` emitted no inventory. The exact session's rollout did contain the rendered skill catalog in `world_state.state.host_skills.body`, including the scratch marker. Ghost reads names from that catalog after the pass, provided a fresh `turn_context` proves this attempt reached context construction. Plugins and MCP connections remain unknown: disabled plugin IDs and plugin recommendations are not evidence of loaded plugins. |
| Cursor Agent 2026.10.01-e373342 | Native probe refused authentication before init. The installed `7000.index.js` headless emitter constructs init with session/model/permission fields, without skill/plugin/MCP inventory. The shared parser would accept compatible inventory fields if a future version adds them; no current runtime inventory is verified. |
| OMP 18.10.3 | Native probe stopped before output because no default model/authentication was selected. Its embedded `packages/coding-agent/src/modes/print-mode.ts` writes a session header and agent events; the header carries no resource inventory. RPC/internal resource-loader access exists but is not evidence on Ghost's JSON print path. Remains unknown. |
| Antigravity 1.3.4 | Probe required authentication and was stopped without completing sign-in. The previously recorded init shape has cwd/tools/permission fields, not an inventory. No successful run-specific inventory is verified; remains unknown. |
| OpenCode 1.19.0 | No populated installation for a native probe. The version-tagged `run.ts` JSON path emits tool/step/text/reasoning/error parts, not a startup inventory. The existing session DB inspection reads model metadata only. Remains unknown. |
| Crush 0.98.1 | The installed `run --help` exposes text/quiet/verbose output, not structured inventory; Ghost's existing recorded stdout fixture is text only. No new authenticated turn was attempted. Remains unknown. |
| Muse 1.4.7-R6101.1 | A successful offline echo run emitted lifecycle/output/task events, with no inventory. The binary's exported MSP schema offers session-scoped `skill/list` and `plugin/list`, but `mcpServer/list` is explicitly configuration/auth facts, not connection readiness. Those separate RPC surfaces are not Ghost's `exec --json` path. Remains unknown. |
| Pi 1.2.0 | Not re-probed for inventory in this audit. Ghost still has no inventory extraction for its JSON print path. Its current `--help` does expose native MCP support; the older claim that Pi has no MCP client was corrected. Ghost's Pi row still does not forward Ghost MCP servers. |

### Protocol evidence

- [Copilot generated session event types](https://github.com/github/copilot-sdk/blob/b19d3ef043ebfeaeb794339173c39ad6c8eb29ca/nodejs/src/generated/session-events.ts):
  loaded inventory events are transient, with enablement/status fields and
  optional `agentId`. Ghost ignores subagent inventories and never derives a
  complete list from a single status event.
- [OpenCode v1.19.0 JSON run emitter](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/cli/cmd/run.ts).
- `codex app-server generate-ts` and `muse schema generate-ts --experimental`
  export the installed binaries' protocols without model requests. Their
  list/RPC methods were inspected, not invoked as substitute Ghost backends.
- Reduced recorded fixtures: `grok-init-resources.jsonl`,
  `copilot-resources.jsonl`, and `codex-world-state.jsonl` under
  `packages/daemon/test/fixtures/harness/`. Additional schema-based tests are
  labelled as such; they are not claimed as recorded native events.

Missing inventories should be filled from future native output or narrowly
attributed session metadata, not by asking the model what it loaded, running a
second discovery process, or changing Ghost into a second agent loop.
