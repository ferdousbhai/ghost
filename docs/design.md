# Ghost — design

Ghost is a local AI persona for one owner: character, private continuity,
conversations, tools, and access to the owner's real Omarchy desktop. It runs on
the owner's machine; no Ghost service holds a cloud copy.

Status and unfinished work live in GitHub issues (#17 is the beta gate). Stable
storage, wire, runtime, and package boundaries live in
[`CONTRACTS.md`](../CONTRACTS.md). Code owns behavior.

## Desired end state

An owner installs Ghost, creates a named persona, chooses a provider, and talks
through the HUD or `ghost` CLI. Pi is the default runtime; an installed Claude
Code is an optional native runtime. Both feel like the same ghost because they
receive the same character, private memory policy, machine skills, Obsidian
policy, and trusted-project snapshot. The runtime still owns its native way of
working.

The official repository stays a narrow, opinionated core. Owners extend a ghost
with readable instructions, skills, rules, Markdown commands/prompts, models,
and MCP. Executable project extensions wait for a real per-session isolation
boundary. Generic capabilities should graduate into core or upstream rather
than becoming parallel Ghost frameworks.

## Decisions that are not obvious from code

- **Three persistence scopes.** Character and subjective continuity are
  ghost-private. Owner-visible knowledge, preferences, decisions, notes, plans,
  and tasks are shared through Obsidian. Projects and machine artifacts remain
  owned by their native facility.
- **Obsidian owns shared state.** Ghost admits the upstream `obsidian-cli`
  through normal machine-skill discovery and uses the official CLI exclusively.
  It has no notes database, task store, plan mode, Documents index, vault-path
  convention, or raw vault-file adapter.
- **Files over an application database.** Personas and inspectable policy stay
  greppable and backup-friendly. Derived runtime state is isolated under
  `.pi/`; credential values live only in Linux Secret Service.
- **Runtime-native behavior wins.** Ghost projects policy through Pi and Claude
  Code's supported settings/hooks. It adds machinery only for product boundaries
  the runtimes do not own: persona lifecycle, daemon sessions, the HUD, browser
  relay, desktop sidecar, shared authentication policy, and recoverable moves.
- **One visible browser.** Ghost drives the owner's signed-in Chromium through
  the opt-in relay. A second ghost profile was removed because the owner could
  not see it and the tab is the useful isolation unit.
- **Quickshell, not a web-app window.** The HUD and bar indicator belong to the
  Omarchy desktop. The remote viewer is deliberately narrower and opt-in over
  Tailscale Serve.
- **Owner-local trust.** There is one owner role. Remote guests are read-only;
  project trust is explicit and filesystem-identity bound; ambient provider
  credentials and executable project code are not discovered.
- **No artificial throttles.** Ghost surfaces provider/runtime limits and uses
  their retry/fallback chains. It does not impose turn, concurrency, hosted
  session, or spend caps.
- **Apache-2.0 and a fresh public history.** The predecessor history carried
  private identifiers; this repository is the open collaboration boundary.

## Product shape

The useful idea is an always-available AI teammate with a name, a chat thread,
tools, and continuity. Ghost's distinction is local custody: the persona works
on the owner's actual Linux desktop, its private state is readable, shared notes
remain the owner's Obsidian vault, and credentials remain in machine-native
stores.

Onboarding is: install and verify Obsidian CLI/skill → create a ghost → choose a
free, subscription, API-key, or local model → summon the HUD → talk. Packaging
must not call this supported until the owner-level Obsidian readiness gate in
#54 is implemented.
