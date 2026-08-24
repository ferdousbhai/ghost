# Handoff: Tier 2 — remove the owner-facing browser guardrails

**For:** Codex, working in a fresh git worktree branched from `master`.
**Issue:** #4 (browser). **Depends on:** injection defense increments 1+2 (already merged: commits `8d895c0`, `69f4b74`).
**Branch to create:** `feat/browser-tier2-guardrails`. Do **not** push, open a PR, or merge — leave the work committed on the branch for review.

## Why

`ghost` is a local AI persona that runs as the machine's owner. Its browser tool (`ghost_browser`) drives either the owner's real signed-in Chromium (via the relay extension) or a per-ghost Playwright profile. Tier 1 already added Claude-for-Chrome-parity capability (arbitrary JS, console/network reads, coordinate input, multi-tab, file upload, etc.). Tier 2 removes the guardrails that were confining the **owner's own agent**, now that hostile-content injection **detection** is in place (fencing + heuristic + optional local classifier, merged).

There are two very different kinds of "guardrail" in this stack. Only one comes off:

- **Owner-facing limits** — restrict where the owner's ghost may go. These are REMOVED.
- **Anti-attacker controls** — stop a hostile web page or a visitor from driving the ghost at all. These STAY, and must not be weakened.

## REMOVE (owner-facing, creator scope)

Prefer disabling cleanly (default a budget to 0, make a gate a no-op) over deleting bookkeeping other code reads. Leave no dangling references, and keep the tool schema valid.

1. **URL scheme + private-network policy.** `packages/extensions/src/extensions/browser-policy.ts` (`ALLOWED_PROTOCOLS`, `isPrivateIpv4/6`, `isLocalHostname`, `checkUrl`) and its call site in `browser-session.ts` (the `checkUrl(...)` inside `open`). Allow every scheme the backends can actually open — `http`, `https`, loopback/private hosts, and `file://`. Effectively make the old `allow_local` behavior the default and stop refusing non-http schemes at the session layer. The `allow_local` tool param becomes a no-op (keep or drop it — your call, keep the schema valid).
2. **Domain confinement / acting-origin gate.** `browser-session.ts` — `#gateActing` / `checkActingScope` (`browser-policy.ts`). The ghost may click/type/act across any domain freely. Make the confinement a no-op; the `allow_cross_domain` param becomes a no-op. Origin bookkeeping (`#originUrl`/`#originHops`) can stay if other code reads it, just stop gating on it.
3. **Acting budget.** `browser-session.ts` `DEFAULT_ACTING_BUDGET` (the per-`open` cap on consequential actions, default 12) and its check inside `#gateActing`. Remove the limit (default it to 0 = unlimited, and drop the refusal).
4. **The last "don't touch a tab the creator opened" restriction** in `packages/chromium-extension/extension/ops.js`. Tier 1 already relaxed the one-tab invariant to multi-tab (an owned-tab set). Finish it: the ghost may act on any tab, ghost-opened or pre-existing, treated the same.

## KEEP — do NOT weaken (these protect the owner, they don't restrain them)

- **All relay transport auth and API auth.** `packages/daemon/src/relay-protocol.ts` (`authorizeRelayUpgrade`: loopback-only `remoteAddress`, `Origin` check, subprotocol, token), `relay.ts` (single-connection), `relay-token.ts` (pairing token), and `server.ts` (bearer token, origin, content-type). These stop a malicious LOCAL WEB PAGE from driving the ghost at all (CSRF; issue #485). Leave them exactly as-is. Their tests (`relay-protocol.test.ts` loopback/origin/token, `relay-hub.test.ts`, `relay-server.test.ts`) must stay green **unchanged**.
- **Creator-only scope.** The four locks that keep visitors out of `ghost_browser` — not registered for a visitor (`browserToolNames`), the `tool_call` gate (`createBrowserScopeGate`), the handler `forbidden_scope` throw, and the relay backend throw. A visitor must still get no browser at all.
- **Injection detection + fencing.** The `untrustedTextResult(...)` calls in `browser.ts` (read/javascript/console/network) and the untrusted-content warning sentences in the tool description. Leave the security wording verbatim.
- **Correctness / hygiene:** the isolated-world `data-ghost-ref` registry, the extension's manual pause switch (`background.js`), the extension's `chrome://`/`devtools://` `INELIGIBLE_URL` block (a CDP-attach technical requirement, not an owner limit), and the **idle timeout** (`DEFAULT_IDLE_TIMEOUT_MS` — resource hygiene that closes an unused browser; the ghost reopens on demand). Do not remove these.

## Tool description

Update `browser.ts`'s description to drop the now-false "confined to the registrable domain of the page you last opened" and "only http and https pages are reachable" wording. KEEP the untrusted-content / injection-warning sentences.

## Tests

Rewrite (do not delete) the guardrail tests that assert removed behavior, to assert the NEW behavior instead:
- `packages/extensions/test/browser-policy.test.ts` — scheme/local/private and the acting-scope provenance gate now allow what they used to refuse.
- The confinement / budget / local-URL assertions in `packages/extensions/test/browser-extension.test.ts`.
- Any relay-backend policy test in `browser-relay-backend.test.ts` that pinned the old session-layer limits.
- **Do not touch** the relay-transport-auth tests (`relay-protocol.test.ts`, `relay-hub.test.ts`, `relay-server.test.ts`) — they must stay green as-is.

## Do NOT touch

- `CONTRACTS.md` — the coordinator (Claude) writes the contract change to land with this.
- `packages/extensions/src/untrusted.ts`, `shared.ts` — injection module, owned elsewhere.
- `vendor/`, `packages/daemon/test/golden/`, anything under `packages/shell` or `packages/desktop-helper`.

## Operational

- Fresh worktree has no `node_modules`: run `pnpm install` at the repo root FIRST.
- Full access is fine (the machine is trusted); a sandbox blocks installs/tests.
- Verify green before committing: `pnpm --filter @ghost/extensions test`, `pnpm --filter @ghost/daemon test`, `pnpm --filter @ghost/extensions typecheck`, `pnpm --filter @ghost/daemon typecheck`, `npx biome check packages/extensions packages/daemon packages/chromium-extension`, and `node --check` on any edited `chromium-extension/*.js`.
- Commit on `feat/browser-tier2-guardrails` with a clear message. Report: exactly what was removed (file:line), confirmation that transport auth + scope locks + injection wiring are untouched, which tests were rewritten and to assert what, and the verbatim check results.
