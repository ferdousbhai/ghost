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
- A running command's output streams into the turn, so a coding agent's
  steps show as the window's status line. Claude prints its steps only as
  streamed JSON, so its command pipes that through `jq`.
- `ghost smoke` is deleted.
- The daemon and the `ghost` command are Rust, built with the window from
  one cargo workspace. The package needs no Bun.

Not done:

- Inkling 2 Mini answers through the loop on the owner's M1 Max, but slowly:
  about 8 tokens a second, a minute for a one-command answer and six for a
  three-command one at the model's default reasoning effort
  (`docs/local-models.md`). Ghost now sends `low` (`local.reasoningEffort`).
- Ghost still starts its own `llama-server`. Omarchy's model engine does not
  run on this machine yet; when it does, Ghost and Lastbook should both use
  its endpoint.

The last release is 0.12.0, the first since the work resumed and the last
one in TypeScript. Master is ahead of it with the Rust daemon, unreleased. Omarchy's
package repository still carries 0.11.9: its recipe is the old two-package
one, and takes 0.12.0 only once the single-package recipe
(`packaging/omarchy/`) is merged there. Until then
`curl -fsSL https://ferdousbhai.com/ghost/install.sh | bash` installs it.
0.12.0 and the summonghost.com page changed together: the page no longer
reaches a machine on 0.11.9. The page's code moved into this repository on
2026-11-25 (`packages/web`); it is published by `packages/web/publish.sh`, on
the owner's go, and the CloudChef project it once lived in only receives
that. Earlier plans are in Git history.

## Upgrading from 0.11.9

A machine upgraded from 0.11.9 has leftovers to remove by
hand: `ghost-timer-*` units in `~/.config/systemd/user/`, the watch scripts in
`~/.config/ghost/`, `~/.config/ghost/cli.json`, and any Omarchy hook that
calls `ghost event` (for example `hooks/battery-low.d/ghost-event.sh`),
and the HUD's plugin link, `~/.config/omarchy/plugins/ferdousbhai.ghost`
(`omarchy plugin remove ferdousbhai.ghost --yes`), with any Hyprland line
that sources its `ghost.conf` or `ghost.lua`.

## Open issues worth keeping

- #54: expose packaged Ghost under Omarchy Install > AI with a reversible
  lifecycle.
- #105: collaboration between persistent ghosts with visible handoffs (moot
  while there is one ghost).
