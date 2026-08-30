# Ghost — Design

Durable vision, positioning, and decisions. Status and open work live in the
issue tracker (#17 is the beta gate); contracts live in `../CONTRACTS.md`.

## Vision

A ghost is the owner's digital counterpart — character, memory, tools, and
access to the owner's Documents — that lives entirely on its owner's machine as
an Omarchy-native desktop app. It uses the computer and browser directly, and
orchestrates coding work through isolated native harnesses instead of
pretending every delegated task is part of its own identity. It is an
owner-local desktop application, not a network-facing agent service. No server
holds a copy. "Your ghost, not our copy of it."

## Design goal: modifiable, infinitely extensible

The official repo is the point of collaboration on a narrow, opinionated core —
ghost home, daemon, shell, and built-in extensions. An owner can modify the
visible instructions, skills, rules, Markdown commands and prompts, model roles,
and MCP owned by a ghost or explicitly trusted project. Executable project
plugins, hooks, custom tools, LSP, and agent definitions stay disabled in a
Ghost principal session. Delegated tasks are the #31 isolation boundary: the
owner's installed Claude Code, Codex, or Pi harness discovers its own native
project configuration and agents only in a captured task process after an
explicit project trust decision.
Trusted visible ghost hook factories are the narrow in-process exception. Core
stays small and holds the contracts.
A capability generic enough for every ghost graduates into core or upstream pi;
private executable additions follow the isolation boundary rather than being
discovered implicitly from cwd. The measure of success is what owners can
extend without surrendering the local trust model.

## Positioning

The product shape Grok Bot validated — always-on AI teammates with a messenger
UI, per-bot screens, teach-by-demonstration — but **local, private, open source
(Apache-2.0), and on the OS they skipped (Linux/Omarchy)**. Ghosts are
owner-bound digital counterparts, not generic configured assistants: character,
memory, a chat thread, and check-ins.
Where Grok Bot gives every bot one shared cloud computer and pooled
credentials, each ghost works on your actual Hyprland desktop, with a per-ghost
home and explicit credential policy over machine Secret Service accounts, no
ambient credential discovery, and no cloud custody.

## Key decisions (one-line rationales)

- **Build on upstream pi at explicit runtime boundaries** — `createAgentSession`
  plus explicit Ghost snapshots express the normal path. `claude-code/default`
  is the narrow exception: the official Claude Agent SDK invokes an installed,
  unmodified Claude Code so the owner can use their own plan. Both receive the
  same Ghost persona, memory, Documents, and declarative layers and emit the
  pi-messages wire, while each keeps its native tool harness. Deviations from
  pi are named in `CONTRACTS.md` with the invariant that licenses them (#3).
- **Delegate through native coding harnesses** — `claude-code`, `codex`, and
  `pi` invoke the owner's installed harness with its own configuration at a
  trusted cwd. Ghost owns task lifecycle and normalized progress, not agent
  discovery or a second implementation of those loops.
- **Model-agnostic; bring any provider.** Named requirements: existing **OpenAI
  Codex/ChatGPT subscriptions usable as auth** through pi's Codex OAuth,
  **Claude plans through the Claude Code harness** (a separate runtime from
  pi's Anthropic provider; recheck Anthropic policy before every release that
  advertises plan accounting), and **OpenRouter first-class** with its free
  models as a zero-cost onboarding option.
- **Owner-readable files, not an application database** — Markdown content and
  inspectable JSON/YAML policy remain greppable and backup-friendly. Derived
  runtime/catalog state stays isolated under `.pi/`; credential values live in
  Linux Secret Service and secret-free coordination metadata lives under
  Ghost's XDG state, never in the content store.
- **No stored indexes** — the memory index and shallow owner Documents index
  are derived per session; files edited out-of-band cannot go stale against a
  persisted catalog.
- **Documents and skills coexist without sharing lifecycle** — Documents are
  live owner-wide files, while skills are bounded declarative instructions from
  a ghost or trusted project. pi supports explicit `/skill:<name>` invocation
  without treating Documents as a package root.
- **One browser** — the owner's real signed-in Chromium, reached by an MV3
  extension over `chrome.debugger`, behind a backend-agnostic tool surface. A
  second, ghost-owned profile was tried and removed: it doubled the code for a
  browser the owner never sees, and the tab is a better isolation unit than a
  profile. Prefer a CLI over a web UI wherever one exists.
- **Quickshell shell surfaces, not a webapp window** — Omarchy's own shell is
  Quickshell; an xdg-toplevel HUD plus a layer-shell bar widget stays native to
  the desktop. A chromium "deep workspace" view must earn its way in.
- **Owner-local product boundary** — core does not expose ghosts to remote
  users, meter calls, or operate a money path.
- **Env scrubbing** — a Ghost principal only sees credentials deliberately
  referenced and allowed by its `models.json`; stray shell API keys must never
  leak cloud models into a sovereign ghost. Installed native harnesses are the
  deliberate exception and receive the daemon launcher's preserved environment
  so their native configuration keeps working.
- **No Obsidian integration promises** — plain files make it unnecessary.
- **Apache-2.0, fresh repo** — the predecessor repo's history carries private
  identifiers; the open contribution is this codebase.

## Onboarding

Install the Arch package → create a ghost (name + job → seeded `character.md`)
→ pick a model: OpenRouter free model (zero cost, just an account), an OpenAI
Codex/ChatGPT subscription sign-in, an externally authenticated Claude Code
plan, any API key, or a local model → Super+Ctrl+G, start talking. Existing
summonghost.com users: sign in there, "Download my ghost", import.

## Undesigned

- **Teach-by-demonstration** (#21) — Wayland-native screen capture + input
  observation → draft skill; v1 fallback is "save this session as a skill".
- **Ghost-to-ghost** (#15) — local interaction and trust model.
- **Always-on** (#18) — laptop lids close; "keep working while I'm away" on
  the same machine.
- **Packaging** — non-Omarchy Linux support: works anywhere Hyprland+Quickshell
  runs, but supported where?
