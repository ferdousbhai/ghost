# Ghost — Plan

## Vision

A ghost is an AI persona — character, memory, notes, tools — that lives
entirely on its creator's machine as an Omarchy-native desktop app: a pi
engine over a folder of plain markdown files, summoned with a keystroke,
extended with pi extensions and skills, and (later) shared with visitors on
the creator's terms over a Nostr control plane, with payments going directly
creator ↔ visitor. No server holds a copy. "Your ghost, not our copy of it."

## Design goal: modifiable, infinitely extensible

**The ghost is modifiable and infinitely extensible. pi already showed the
way.** The official repo is the point of collaboration on a narrow,
opinionated core — ghost home, daemon, shell, the built-in extensions — but
ghosts are meant to be modified: creators glob onto the plugin and extension
interfaces (pi extensions, skills, model roles, browser backends, tool
factories) and grow their ghost to whatever their needs are. Core stays
small and holds the contracts; everything else is a creator's extension.
When a capability is generic enough for every ghost, it graduates into core
(or upstream into pi itself); until then it lives in the creator's ghost
home. The measure of success is not what core ships — it is what creators
can bolt on without asking.

## Positioning

The product shape Grok Bot validated — always-on AI teammates with a
messenger UI, per-bot screens, teach-by-demonstration — but **local, private,
open source (Apache-2.0), and on the OS they skipped (Linux/Omarchy)**.
Ghosts are hired teammates, not configured assistants: name, job, a chat
thread, check-ins. Where Grok Bot gives every bot one shared cloud computer
and pooled credentials, each ghost gets a real Hyprland workspace on your
actual machine, per-ghost homes, and structural scope gates, with no credential
pooling and no cloud custody.

## Phases

- **Phase 1 — creator-local (IN PROGRESS).** Feature-complete creator ghost:
  multi-ghost plain-file homes, persona/memory/notes pi extensions, `ghostd`
  daemon, Quickshell HUD (Super+G) + bar widget + notifications, import of
  the hosted export, AUR packaging. Current status: workspace scaffolded;
  `packages/extensions`, `packages/daemon`, `packages/shell` in parallel
  construction; pi SDK path proven by spike (zero fork-risk).
- **Phase 2 — visitors.** Nostr control plane: keypair identity per ghost,
  discovery via committed static manifest (+relays as enrichment),
  presence-before-contact, offline mailbox (encrypted DMs; our libsodium
  crypto stays authoritative). Streaming data plane: the GhostRelay Durable
  Object (already built in the predecessor repo — relays measurably cannot
  carry streamed answers). Visitor sessions: public-notes-only, per-visitor
  memory scopes, bash/browser default-OFF. Paid-call envelope: our own
  microstandard (NIP-90 is dead — measured; NIP-AE PR #2220 is the
  owner↔ghost key-binding template).
- **Phase 3 — payments.** NWC (NIP-47) settlement spine (all-outbound over
  relays — no public endpoint, no NAT problem); **prepaid balances keyed to
  the visitor's npub, metered per call** (per-call payment friction is the
  measured killer); Cashu for sub-cent/offline; x402 only as an optional
  agent-facing adapter.
- **Transition (predecessor platform).** summonghost.com → one-pager +
  sign-in-gated "Download my ghost" export (shipped) + NIP-05 file so every
  existing username survives as `name@summonghost.com`; hosted stack frozen,
  then drained (W10 engine + residue verification). Details:
  `~/github.com/ferdousbhai/summon-ghost/docs/sovereignty-migration.md`.

## Contracts

`../CONTRACTS.md` is binding: the **ghost-home/v1** layout and the localhost
**pi-messages daemon API**. Change deliberately, one commit, all consumers.

## Key decisions (one-line rationales)

- **Build ON pi (pi-coding-agent SDK), never fork** — the spike proved
  `createAgentSession` + extensions express everything; gaps are wrap-or-
  upstream, zero fork-risk.
- **Model-agnostic like pi; bring any provider.** Two named requirements:
  existing **OpenAI Codex/ChatGPT subscriptions usable as auth**
  (Codex-style OAuth sign-in, not only API keys — pi-support verification
  pending), and **OpenRouter first-class** with its always-available free
  models as the intended zero-cost onboarding: anyone can try their ghost
  free with just an OpenRouter account.
- **Files, not a database** — plain markdown + YAML frontmatter is the
  store; owner-readable, greppable, git-friendly; the sync machinery a
  server required simply disappears.
- **No stored indexes** — memory index and note catalog are derived per
  session; files edited out-of-band can never go stale against an index.
- **Quickshell shell surfaces, not a webapp window** — Omarchy's own shell
  is Quickshell; a layer-shell HUD + bar widget is native in a way no app
  window is. A chromium "deep workspace" view must earn its way in.
- **Nostr = control plane only** — identity/discovery/presence/mailbox;
  relays measurably rate-limit streaming, so the GhostRelay DO is the data
  plane.
- **NWC + prepaid balances** for payments — direct creator↔visitor, no
  platform in the money path, no platform revenue required.
- **Terminology: "visitors", never "callers".**
- **Visitor memory at `memory/.visitors/<id>/`** — it IS memory, so it
  lives under `memory/`; dot-folder keeps it out of the creator's default
  view while staying inspectable.
- **Env scrubbing** — a ghost only sees credentials deliberately configured
  in its models.json; stray shell API keys must never leak cloud models
  into a sovereign ghost.
- **No Obsidian integration promises** — plain files make it unnecessary.
- **Apache-2.0, fresh repo** — the predecessor repo's history carries
  private identifiers; the open contribution is this codebase plus the
  ghost-over-Nostr conventions once Phase 2 lands.

## Onboarding (Phase 1 target)

Install from AUR → create a ghost (name + job → seeded `character.md`) →
pick a model: OpenRouter free model (zero cost, just an account), an OpenAI
Codex/ChatGPT subscription sign-in, any API key, or a local model — →
Super+G, start talking. Existing summonghost.com users: sign in there,
"Download my ghost", import.

## Open questions

- **Always-on**: laptop lids close; presence-honesty covers Phase 2, but the
  "keep answering while I'm away" story (remote node? second device?) is
  unresolved and deliberately later.
- **Codex/ChatGPT-subscription OAuth in pi** — requirement recorded;
  pi-support verification in flight.
- **Teach-by-demonstration** — the Wayland-native version (screen capture +
  input observation → draft skill); v1 fallback is "save this session as a
  skill".
- **Ghost-to-ghost** — local first; over Nostr across machines in Phase 2+;
  interaction and trust model undesigned.
- **Packaging** — AUR specifics, systemd unit polish, non-Omarchy Linux
  support (works anywhere Hyprland+Quickshell runs, but supported where?).
- **NIP-AE-style binding** — exact owner↔ghost key-binding and kind
  allocation for the paid-call microstandard.
- **Frozen-platform economics** — does hosted chat go read-only during the
  freeze (decision owned by the predecessor repo's transition plan).
