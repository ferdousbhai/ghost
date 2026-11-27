# Status: resumed on 2026-11-24

The owner reopened Ghost on 2026-11-24 with a narrower aim: the one place
that shows and answers from the owner's own data, whichever product holds it
(the iCloud apps, the Cloud apps, WhatsApp, and now Google). On 2026-11-25
they dropped the showing: "stopped making ghost the interface to all my
data: which is fine, as each of those apps already provide their own
interface and can be easily found by the user". The ghost answers from that
data and works with it through each app's command line; the apps show it.
What they said it must be:

- A local model answers, always. Its tools stay minimal: a shell, and a
  question to the owner.
- Coding agents run in the background, with their work visible in Ghost as a
  sub-agent's is in a coding agent.
- No release without the owner's go.

Done since:

- 2026-11-27, one conversation, at the owner's word ("what if there's one
  continuous conversation - not separate threads"): the daemon, the `ghost`
  command and the bar hold exactly one, with no ids, titles, pins or list.
  It is `conversation/` in the ghost home (`sessions/<id>/` before), the
  routes are `/api/conversation…`, `-s` and `$GHOST_SESSION` are gone, and
  `ghost new --yes` starts over by moving it to Trash. An upgraded machine
  keeps its old `sessions/` unread; with ghostd stopped,
  `mv sessions/<id> conversation` carries one over by hand (its log and
  attachments; an open question and the read mark are not carried). The
  page (`packages/web`) still calls the old routes until it is redone.
- 2026-11-27, handoff keeps a document per topic, at the owner's word ("The
  ghost makes use of handoff to maintain documents for context and
  continuity as conversation topics change"): at a handoff the ghost first
  brings `topics/` in the ghost home up to date with its shell (one Markdown
  file per topic, its first line a summary), then writes only a short note
  of where things stand; a note of a note no longer lets old topics fade.
  A turn's first message lists the documents (ghostd derives the list from
  the directory when a conversation starts and when a note is written, and
  the log keeps it, so nothing the model has read changes between turns) and
  the ghost `cat`s one when the conversation returns to its topic. They
  outlive `ghost new`; the owner reads, edits and deletes them as files, and
  `ghost status` says where they are and how many. `ghost stop` now stops a
  handoff too, since one runs commands. Not tried on a real model: whether
  Inkling 2 Mini keeps good documents, and whether a quarter of the context
  is room enough to write them, are unproven.
- 2026-11-27, the window is gone, at the owner's word ("the ghost should
  literally feel like it lives in the computer, not an app"): `ghost-bar`
  (`packages/bar`, formerly `packages/window`) is a prompt pinned to the
  bottom of the screen with the whole answer above it, one conversation,
  Up and Down through it, `--listen` to start Omarchy's dictation with it.
  The owner tried it the same day and set how it behaves: the prompt goes
  on Enter and the shortcut brings it back; the whole answer stays until
  Escape or turning to another window, neither of which stops the ghost;
  Ctrl+C stops a turn, as in a terminal; the bar sits above Voxtype's
  indicator, which had covered it. The window's chat list and its showing
  of reasoning and command output went with it; `ghost show` still lists
  those. Not checked on a real desktop yet: dictation into the bar, and
  turning to another window putting it away.
- 2026-11-26, a second cleanup, agreed with the owner: the turn_end hook
  (push alerts replaced its one use), the read-only guest role (only the
  owner reaches Ghost), the ghosts root (the home is
  `~/.local/share/ghost`, the ghost named by its persona's title). The model's state is now
  saved at each stop and restored at the next start.
- 2026-11-25, a cleanup of what only wrapped something else: the window's
  Sources and Connect pages and their adapters (each product has its own
  app, and the ghost reaches data from its shell), `ghost remote` (Serve is
  Tailscale's own command, which `ghost status` names), `ghost ask` (the
  model has the tool), and the coding-agent choice beyond Omarchy's default.
  The window is the conversation.
- The local model's harness is minimal: the whole persona, two tools (`bash`,
  unsandboxed, unconfirmed, and `ask`, added 2026-11-25 at the owner's
  request: a question to the owner with 2 to 4 ways forward, the recommended
  one first, which ends the turn), no cap on rounds, no forced answer, no trimming.
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
  (its source pages, since removed, emptied their search on Escape).
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
- Alerts are Web Push, sent by ghostd to the owner's devices (added
  2026-11-25, replacing the ntfy recipe); see `CONTRACTS.md` "Push alerts".
  The daemon gained the RustCrypto crates for it and posts with `curl`.
- Ghost follows Omarchy for the model, the owner decided on 2026-11-26:
  Omarchy's engine (`omarchy-local-ai`, `omarchy models use best text`)
  picks, pins and serves the recommended model, so Ghost names none and
  downloads none. That engine does not support Apple Silicon yet. Until it
  runs on the owner's machine Ghost still starts its own `llama-server`
  from `local.model`; when it does, Ghost (and Lastbook) should use its
  endpoint, and `local_model.rs` goes.

The last release is 0.13.0, the first with the daemon and the `ghost`
command in Rust; 0.12.0 was the last one in TypeScript. Omarchy's
package repository still carries 0.11.9: its recipe is the old two-package
one, and takes a newer release only once the single-package recipe
(`packaging/omarchy/`) is merged there. Until then
`curl -fsSL https://ferdousbhai.com/ghost/install.sh | bash` installs it.
0.12.0 and the summonghost.com page changed together: the page no longer
reaches a machine on 0.11.9. The page's code moved into this repository on
2026-11-25 (`packages/web`); it is published by `packages/web/publish.sh`, on
the owner's go, and the CloudChef project it once lived in only receives
that. Earlier plans are in Git history.

## Compatibility

Until 1.0 nothing is kept for an earlier version: not its config keys, its
log records or parts, its home layout, nor the TypeScript daemon's text
semantics (lengths are now characters). The owner decided this on
2026-11-26. A machine upgraded across a break is set right by hand. The one
exception is packaging: the recipe still `replaces` and `conflicts` with
`ghost-runtime`, because without it `omarchy update` would stop on a file
conflict for anyone who installed 0.11.9 from Omarchy's repository.

## Open issues worth keeping

- #54: expose packaged Ghost under Omarchy Install > AI with a reversible
  lifecycle.
- #105: collaboration between persistent ghosts with visible handoffs (moot
  while there is one ghost).
