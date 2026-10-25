# Per-run resource reporting

The harness menu's **Resources…**, the tailnet viewer, and `ghost show
--resources` inspect the latest successful run without adding messages to chat.
Ghost-supplied instructions and forwarded MCP names are separate from
harness-reported skills, plugins, tools, and connected MCP servers. Only
categories with evidence are shown. Current parsers report skills/plugins/MCP
as described below and compatible Claude init tool names; other categories
remain unknown until native output supplies evidence. No scanner or second discovery process is used.

Every successful run replaces the snapshot, including unknown inventories;
failed attempts retain the dated last successful run. A catalog is availability,
not proof of loaded skill bodies or a complete prompt/token-cost report.
Legacy resource records remain inspectable but never render as chat messages.
The MCP navbar manages only this ghost's additional configuration; it does not
edit harness-owned settings or prove a server connected. Pi/OMP forwarding
behavior is unchanged.

## Parser evidence

The following native-output checks produced the reduced fixtures in
`packages/daemon/test/fixtures/harness/` (2026-10-13). They establish parser
coverage for those versions, not ongoing authentication or compatibility.
Probes used scratch directories and inert skills; fixtures omit credentials,
private paths, and owner conversation content. Schema-derived tests are labelled.

| Harness / checked version | Supported evidence and limits |
|---|---|
| Claude 2.1.296 | Init reported skills, plugins, and explicit MCP inventory. Compatible init tool names are accepted. |
| Grok 1.0.52 | Init reported skills and explicit MCP inventory; plugins unknown. |
| Copilot 1.0.96 | Native MCP load/status events were observed. Skills/extensions events are schema-supported but were not emitted in the probe. Count enabled skills, running source-qualified extensions, and connected servers only; ignore subagent inventory. |
| Codex 0.162.1 | JSON stdout had no inventory. The reported session's rendered skill catalog supplies names only when a fresh turn-context record attributes it to this run. Plugins/MCP remain unknown. |
| Cursor Agent 2026.10.01-e373342 | Init had no inventory. Future compatible inventory fields can use the shared parser. |
| OMP 18.10.3 | JSON print path emitted no inventory; internal resource-loader/RPC access is not evidence on that path. |
| Antigravity 1.3.4 | Init/step/result stream had no skill/plugin inventory. |
| OpenCode 1.19.0 | JSON step/text stream had no inventory; session DB inspection supplies model metadata only. |
| Muse 1.4.7-R6101.1 | Offline and model runs emitted no inventory. Separate MSP list methods are not the exec path; MCP configuration/auth is not connection readiness. |
| Pi 1.2.0 | Successful JSON print run emitted no inventory. Pi supports owner-configured MCP, but Ghost's row does not forward its servers. |
| Crush | Not checked, at the owner's request. |

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
