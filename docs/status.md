# Status: resumed on 2026-11-24 as the hub

The owner reopened Ghost on 2026-11-24 with a narrower aim: the one place
that shows and answers from the owner's own data, whichever product holds it
(the iCloud apps, the Cloud apps, WhatsApp, and now Google). What they said
it must be:

- A local model answers, always. Its tools stay minimal: search, and running
  shell commands.
- Coding agents run in the background, with their work visible in Ghost as a
  sub-agent's is in a coding agent.
- No release without the owner's go.

Done since:

- Google in Connect (`google`, `google-drive`, `google-workspace`) and in the
  sources (`keep`, `google-drive`, `google-photos`).
- The local model's harness is minimal: the whole persona, one tool (`bash`,
  unsandboxed, unconfirmed), no cap on rounds, no forced answer, no trimming.
  Its former tools (`search`, `read`, `save_note`, `add_reminder`, `delegate`)
  are gone; a coding agent is run from the shell by its own one-shot command
  (`claude -p`), as the owner chose; `ghost delegate` and its receipts log
  are gone too.
- The HUD (`packages/shell`) is deleted: the window is the only chat
  surface. With it went the `desktop` field of a message, the QR route
  (`/api/remote/qr.svg`) and the `qrencode` dependency, and the
  `ghost`/`ghost-runtime` package split: one package, `ghost`, replaces both.
- Every turn runs on the local model. The table of ten cloud agent CLIs, the
  failover between them, their usage display, `ghost harness`, `ghost switch`,
  `ghost harnesses`, `settings.yml`, and the persona files written into each
  conversation directory are deleted; with no `local.model` configured no
  turn runs.
- The package builds the daemon from the release's source archive; the
  prebuilt runtime archive and its verifiers are deleted.
- The window is on omui 0.5.7, its composer has the keyboard when Ask shows,
  and Escape empties a source page's search.

Not done:

- Inkling 2 Mini answers through the loop on the owner's M1 Max, but slowly:
  about 8 tokens a second, a minute for a one-command answer and six for a
  three-command one at the model's default reasoning effort
  (`docs/local-models.md`). Ghost now sends `low` (`local.reasoningEffort`).
- Ghost still starts its own `llama-server`. Omarchy's model engine does not
  run on this machine yet; when it does, Ghost and Lastbook should both use
  its endpoint.
- The rest of "Unfinished" below.
- A running command's output now streams into the turn, so a coding agent's
  steps show as the window's status line. Claude
  prints its steps only as streamed JSON, so its command pipes that through
  `jq`; the model ran it so on the owner's machine.

What follows is the freeze of 2026-11-20, kept for what it records.

## Frozen on 2026-11-20

Ghost is frozen. No feature work, no releases. The last release is 0.11.9
(also the version in Omarchy's package repository); `master` is ahead of it
and unreleased.

## Why

Official Omarchy 4.5 ships most of what Ghost did: an Agents panel with every
subscription's limits, several accounts per agent with automatic switching,
`omarchy agent` for the default agent, `omarchy agent --local` for local
models (`omarchy-local-ai`), and Install > AI entries for OpenClaw and Hermes
in the persona, phone and messaging role. What only Ghost does (a persona,
one history across agents, the HUD (deleted since), hooks, phone reach through
summonghost.com) no longer justifies continued work.

The owner will reassess after their machine moves from the Omarchy Mac fork
(4.0.2) to official Omarchy: archive Ghost, or cut it to a thin layer over
Omarchy's own agent plumbing.

## What master holds beyond 0.11.9

- The GTK window (`packages/window`): one view over the owner's own data, on
  omui 0.5.7, with scripted QA in `pnpm verify`. Never released.
- Lastbook in the product catalog (`ghost help products`).
- The first stage of a shrink the owner approved the same day, which deleted:
  routines (per-ghost systemd timers), external events (`ghost event`),
  the machine-watch and crash-watch recipes, per-ghost MCP servers, and the
  verbs for creating, renaming, removing and choosing ghosts. There is one
  ghost; its home layout and the `/api/ghosts/:name/…` wire are unchanged, so
  the summonghost.com app still works against master.

A machine upgraded from 0.11.9 to a build of master has leftovers to remove by
hand: `ghost-timer-*` units in `~/.config/systemd/user/`, the watch scripts in
`~/.config/ghost/`, `~/.config/ghost/cli.json`, and any Omarchy hook that
calls `ghost event` (for example `hooks/battery-low.d/ghost-event.sh`),
and the HUD's plugin link, `~/.config/omarchy/plugins/ferdousbhai.ghost`
(`omarchy plugin remove ferdousbhai.ghost --yes`), with any Hyprland line
that sources its `ghost.conf` or `ghost.lua`.

## Unfinished

Approved by the owner but not started when the freeze came:

- Replacing the local model's own tool loop (`local-turn.ts`) with pi as the
  local runtime, with Ghost's `search` and `read` as a pi extension.
  Superseded on 2026-11-24 by the minimal loop above.

Undecided: owner hooks stay, because the owner's keep-going product runs on
the `session_stop` hook through `ghostd hook-complete`.

## A thin-layer Ghost

Keep: the persona and its memory (`character.md`, the owner's `Notes` and
`Reminders`), one conversation history shared across agents, and the phone
bridge (Tailscale Serve and the summonghost.com app).

Delete: the harness table, usage tracking, failover between harnesses, and
the local model (Omarchy owns all four now), plus everything under
"Unfinished" above.

## Open issues worth keeping

- #54: expose packaged Ghost under Omarchy Install > AI with a reversible
  lifecycle.
- #105: collaboration between persistent ghosts with visible handoffs (moot
  while there is one ghost).
