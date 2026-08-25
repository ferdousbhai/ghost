# Ghost — Plan

## Vision

A ghost is an AI persona — character, memory, docs, tools — that lives
entirely on its creator's machine as an Omarchy-native desktop app: an OMP
engine over a folder of plain markdown files, summoned with a keystroke,
and extended with OMP extensions and skills. It is an owner-local desktop
application, not a network-facing agent service. No server holds a copy.
"Your ghost, not our copy of it."

## Design goal: modifiable, infinitely extensible

**The ghost is modifiable and infinitely extensible. Oh My Pi showed the
way.** The official repo is the point of collaboration on a narrow,
opinionated core — ghost home, daemon, shell, the built-in extensions — but
ghosts are meant to be modified: creators glob onto the plugin and extension
interfaces (OMP extensions, skills, model roles, browser backends, tool
factories) and grow their ghost to whatever their needs are. Core stays
small and holds the contracts; everything else is a creator's extension.
When a capability is generic enough for every ghost, it graduates into core
(or upstream into OMP itself); until then it lives in the creator's ghost
home. The measure of success is not what core ships — it is what creators
can bolt on without asking.

## Positioning

The product shape Grok Bot validated — always-on AI teammates with a
messenger UI, per-bot screens, teach-by-demonstration — but **local, private,
open source (Apache-2.0), and on the OS they skipped (Linux/Omarchy)**.
Ghosts are hired teammates, not configured assistants: name, job, a chat
thread, check-ins. Where Grok Bot gives every bot one shared cloud computer
and pooled credentials, each ghost gets a real Hyprland workspace on your
actual machine, with per-ghost homes and credentials, no credential pooling,
and no cloud custody.

## Phases

- **Creator-local (IN PROGRESS).** Feature-complete ghost:
  multi-ghost plain-file homes, persona/memory/docs pi extensions, `ghostd`
  daemon, Quickshell HUD (Super+G) + bar widget + notifications, import of
  the hosted export, optional owner-local Claude Code plan runtime, AUR
  packaging. Current status: workspace scaffolded;
  `packages/extensions`, `packages/daemon`, `packages/shell` in parallel
  construction; pi SDK path proven by spike (zero fork-risk).
- **Transition (predecessor platform).** summonghost.com → one-pager +
  sign-in-gated "Download my ghost" export (shipped); hosted stack frozen,
  then drained (W10 engine + residue verification). Details:
  `~/github.com/ferdousbhai/summon-ghost/docs/sovereignty-migration.md`.

## Contracts

`../CONTRACTS.md` is binding: the **ghost-home/v1** layout and the localhost
**pi-messages daemon API**. Change deliberately, one commit, all consumers.

## Key decisions (one-line rationales)

- **Build on modern OMP by default, never fork; add official harnesses at explicit
  runtime boundaries** — the spike proved `createAgentSession` + extensions
  express the normal path. `claude-code/default` is the narrow exception: the
  official Claude Agent SDK invokes an installed, unmodified Claude Code so a
  creator can use their own plan. Both consume the same Ghost system prompt,
  tools, and pi-messages wire; neither dependency is forked.
- **Model-agnostic like OMP; bring any provider.** Two named requirements:
  existing **OpenAI Codex/ChatGPT subscriptions usable as auth**
  through OMP's Codex OAuth, **Claude plans through the Claude Code harness**
  (a separate runtime from OMP's Anthropic provider), and **OpenRouter
  first-class** with its free models as a zero-cost onboarding option.
- **Files, not a database** — plain markdown + YAML frontmatter is the
  store; owner-readable, greppable, git-friendly; the sync machinery a
  server required simply disappears.
- **No stored indexes** — memory index and doc catalog are derived per
  session; files edited out-of-band can never go stale against an index.
- **Docs and skills coexist** — docs are durable ghost-owned knowledge;
  OMP-native skills are reusable procedural instructions. Sessions discover
  both, including explicit `/skill:<name>` invocation.
- **Two browser modes**: "My browser" (relay into the creator's real signed-in Chromium via MV3 extension + chrome.debugger) and "Ghost's browser" (per-ghost Playwright profile, isolated/autonomous), one backend-agnostic tool surface.
- **Quickshell shell surfaces, not a webapp window** — Omarchy's own shell
  is Quickshell; a layer-shell HUD + bar widget is native in a way no app
  window is. A chromium "deep workspace" view must earn its way in.
- **Owner-local product boundary** — core does not expose ghosts to remote
  users, meter calls, or operate a money path.
- **Env scrubbing** — a ghost only sees credentials deliberately configured
  in its models.json; stray shell API keys must never leak cloud models
  into a sovereign ghost.
- **No Obsidian integration promises** — plain files make it unnecessary.
- **Apache-2.0, fresh repo** — the predecessor repo's history carries
  private identifiers; the open contribution is this codebase.

## Onboarding

Install from AUR → create a ghost (name + job → seeded `character.md`) →
pick a model: OpenRouter free model (zero cost, just an account), an OpenAI
Codex/ChatGPT subscription sign-in, an externally authenticated Claude Code
plan, any API key, or a local model — →
Super+G, start talking. Existing summonghost.com users: sign in there,
"Download my ghost", import.

## Open questions

- **Always-on**: laptop lids close; the "keep working while I'm away" behavior
  on the same machine remains to be polished.
- **Codex/ChatGPT-subscription OAuth**: RESOLVED — OMP 18 ships native OAuth
  for `openai-codex` (plus other registry providers), and Ghost exposes the
  same flow in both the shell and terminal.
- **Claude subscription use**: RESOLVED for Phase 1 creator-local —
  `claude-code/default` uses the T3-style official Agent SDK harness and the
  creator's external Claude Code login. OMP's `anthropic` provider remains a
  separate accounting path. Recheck
  Anthropic policy before every release that advertises plan accounting.
- **Teach-by-demonstration** — the Wayland-native version (screen capture +
  input observation → draft skill); v1 fallback is "save this session as a
  skill".
- **Ghost-to-ghost** — local interaction and trust model undesigned.
- **Packaging** — AUR specifics, systemd unit polish, non-Omarchy Linux
  support (works anywhere Hyprland+Quickshell runs, but supported where?).
