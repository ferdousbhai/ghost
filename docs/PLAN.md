# Ghost — Plan

## Vision

A ghost is an AI persona — character, memory, tools, and access to the owner's
Documents — that lives entirely on its owner's machine as an Omarchy-native
desktop app: an OMP engine over owner-readable files, summoned with a keystroke,
and extended with bounded declarative skills and project context. It is an
owner-local desktop application, not a network-facing agent service. No server
holds a copy.
"Your ghost, not our copy of it."

## Design goal: modifiable, infinitely extensible

**The ghost is modifiable and infinitely extensible. Oh My Pi showed the
way.** The official repo is the point of collaboration on a narrow,
opinionated core — ghost home, daemon, shell, and built-in extensions. Today an
owner can modify the visible instructions, skills, rules, Markdown commands and
prompts, model roles, and MCP owned by a ghost or explicitly trusted project.
Executable project plugins, hooks, custom tools, LSP, and Pi subagents stay
disabled until #31 supplies a per-session isolation boundary; trusted visible
ghost hook factories are the narrow in-process exception. Core stays small and
holds the contracts. A capability generic enough for every ghost graduates into
core or upstream OMP; safe private executable additions follow the isolation
boundary rather than being discovered implicitly from cwd. The measure of
success is what owners can extend without surrendering the local trust model.

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

- **Owner-local (IN PROGRESS).** Feature-complete ghost:
  multi-ghost plain-file homes, persona and memory extensions, a shared shallow
  Documents index, explicit project snapshots, `ghostd`, the Quickshell HUD
  (Super+G) + bar widget + notifications, hosted-export import, the optional
  owner-local Claude Code runtime, and AUR packaging. The integrated workspace
  remains pre-beta and the executable project-extension boundary is unfinished.
- **Transition (predecessor platform).** summonghost.com → one-pager +
  sign-in-gated "Download my ghost" export (shipped); hosted stack frozen,
  then drained (W10 engine + residue verification). Details:
  `~/github.com/ferdousbhai/summon-ghost/docs/sovereignty-migration.md`.

## Contracts

`../CONTRACTS.md` is binding: the **ghost-home/v2** layout and the localhost
**pi-messages daemon API**. Change deliberately, one commit, all consumers.

## Key decisions (one-line rationales)

- **Build on modern OMP by default, never maintain a fork; keep the pinned patch
  set narrow and add official harnesses at explicit runtime boundaries** —
  `createAgentSession` plus explicit Ghost snapshots express the normal path.
  `claude-code/default` is the narrow exception: the
  official Claude Agent SDK invokes an installed, unmodified Claude Code so the
  owner can use their own plan. Both receive the same Ghost persona, memory,
  Documents, and declarative layers and emit the pi-messages wire, while each
  keeps its native tool harness. Neither dependency is maintained as a fork.
- **Model-agnostic like OMP; bring any provider.** Two named requirements:
  existing **OpenAI Codex/ChatGPT subscriptions usable as auth**
  through OMP's Codex OAuth, **Claude plans through the Claude Code harness**
  (a separate runtime from OMP's Anthropic provider), and **OpenRouter
  first-class** with its free models as a zero-cost onboarding option.
- **Owner-readable files, not an application database** — Markdown content and
  inspectable JSON/YAML policy remain greppable and backup-friendly. OMP's
  machine-only credential/catalog database stays isolated under `.pi/` rather
  than becoming Ghost's content store.
- **No stored indexes** — the memory index and shallow owner Documents index
  are derived per session; files edited out-of-band cannot go stale against a
  persisted catalog.
- **Documents and skills coexist without sharing lifecycle** — Documents are
  live owner-wide files, while OMP-native skills are bounded declarative
  instructions from a ghost or trusted project. Pi supports explicit
  `/skill:<name>` invocation without treating Documents as a package root.
- **Two browser modes**: "My browser" (relay into the owner's real signed-in Chromium via MV3 extension + chrome.debugger) and "Ghost's browser" (per-ghost Playwright profile, isolated/autonomous), one backend-agnostic tool surface.
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
- **Claude subscription use**: RESOLVED for Phase 1 owner-local —
  `claude-code/default` uses the T3-style official Agent SDK harness and the
  owner's external Claude Code login. OMP's `anthropic` provider remains a
  separate accounting path. Recheck
  Anthropic policy before every release that advertises plan accounting.
- **Teach-by-demonstration** — the Wayland-native version (screen capture +
  input observation → draft skill); v1 fallback is "save this session as a
  skill".
- **Ghost-to-ghost** — local interaction and trust model undesigned.
- **Packaging** — AUR specifics, systemd unit polish, non-Omarchy Linux
  support (works anywhere Hyprland+Quickshell runs, but supported where?).
