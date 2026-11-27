# Status: resumed on 2026-11-24

The owner reopened Ghost on 2026-11-24 with a narrower aim, and on 2026-11-25
dropped showing their data: "stopped making ghost the interface to all my
data: which is fine, as each of those apps already provide their own
interface and can be easily found by the user". The ghost answers from that
data and works with it through each app's command line; the apps show it.
What they said it must be:

- A local model answers, always. Its tools stay minimal: a shell, and a
  question to the owner.
- Coding agents run in the background, with their work visible in Ghost as a
  sub-agent's is in a coding agent.
- One continuous conversation, not separate threads, whose handoffs keep a
  document per topic (2026-11-27).
- It lives in the computer, not in an app: a bar at the bottom of the screen,
  no window (2026-11-27).
- No release, and no publish of the page, without the owner's go.

What is built is in [`CONTRACTS.md`](../CONTRACTS.md); how it got there is in
Git history.

## Unproven

- Topic documents on a real model: whether Inkling 2 Mini keeps good ones,
  and whether the quarter of the context left at a handoff is room enough to
  write them.
- The bar on a real desktop: dictation into it, and turning to another
  window putting it away.
- The page (`packages/web`) as one chat per machine is not published, and its
  own list of what is unverified is in
  [its README](../packages/web/README.md#not-yet-verified).

## Not done

- Coding agents in the background. What is built is a foreground one-shot
  command inside the turn (`claude -p`, `codex exec` or `agy -p`, whichever is
  Omarchy's default agent): the turn waits for it, and its steps show as the
  command running.
- Speed. Inkling 2 Mini answers through the loop on the owner's M1 Max at
  about 8 tokens a second: a minute for a one-command answer, at reasoning
  effort `low` ([local-models.md](local-models.md)).
- Omarchy's model engine. The owner decided on 2026-11-26 that Ghost follows
  Omarchy for the model: its engine (`omarchy-local-ai`, `omarchy models use
  best text`) picks, pins and serves the recommended one, so Ghost names none
  and downloads none. That engine does not support Apple Silicon yet. Until
  it runs on the owner's machine Ghost starts its own `llama-server` from
  `local.model`; when it does, Ghost (and Lastbook) should use its endpoint,
  and `local_model.rs` goes.

## Releases

The last release is 0.13.0. Omarchy's package repository still carries
0.11.9: its recipe is the old two-package one, and takes a newer release only
once the single-package recipe (`packaging/omarchy/`) is merged there
(omacom/omarchy-pkgs #3712, open). Until
then `curl -fsSL https://ferdousbhai.com/ghost/install.sh | bash` installs
it. The page no longer reaches a machine on 0.11.9. It is published by
`packages/web/publish.sh`, on the owner's go, to the CloudChef project that
serves summonghost.com.

## Compatibility

Until 1.0 nothing is kept for an earlier version: not its config keys, its
log records or parts, nor its home layout. The owner decided this on
2026-11-26. A machine upgraded across a break is set right by hand: one that
still has `sessions/<id>/` in its ghost home carries a conversation over,
with ghostd stopped, by `mv sessions/<id> conversation`. The one exception is
packaging: the recipe still `replaces` and `conflicts` with `ghost-runtime`,
because without it `omarchy update` would stop on a file conflict for anyone
who installed 0.11.9 from Omarchy's repository.

## Open issues worth keeping

- #54: expose packaged Ghost under Omarchy Install > AI with a reversible
  lifecycle.
