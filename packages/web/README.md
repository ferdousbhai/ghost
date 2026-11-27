# The summonghost.com page

[summonghost.com](https://summonghost.com) is how an owner reaches Ghost on
their machines from a phone or any other device on their tailnet. It is
Ghost's only remote client. The owner's words for it: "myself and every other
user [can] go to a simple domain (summonghost.com), have a one time setup per
machine, and then see all their machines and the ghosts in them, and
converse." A machine has one ghost and a ghost one conversation, so the page
is a messaging app's two screens: the machines, as a chat list, and one
machine's chat; the route is `#/<host>`. The owner on 2026-11-27: "phone page
maintain continuity similar to on whatsapp messages as people are more used to
that flow on phone."

Owners' instructions are in [docs/mobile.md](../../docs/mobile.md).

## Design

- **No backend.** Cloudflare serves `public/` as static assets (a Worker with
  assets and no script). The site stores nothing of anyone's and has no
  accounts, cookies, analytics or server code. Adding any of these is a
  product decision for the owner, not an implementation detail.
- **Straight to the machine.** The browser calls
  `https://<machine>.<tailnet>.ts.net[:port]/api/...` on each machine's
  `ghostd`, through Tailscale Serve, which stamps the caller's Tailscale
  login; ghostd admits the owner by it. There is no token, sign-in or
  pairing, and requests carry no credentials.
- **Ghost's side is in [`CONTRACTS.md`](../../CONTRACTS.md):** `remote.apps`
  admits the `https://summonghost.com` origin, only with a Tailscale identity,
  with CORS and the Private-Network preflight; `GET /api/remote/machines`
  lists the owner's other machines; the rest is the daemon API and turn wire.
  Build against that contract, and change both sides in one commit.
- **The current release only.** The page is published when the owner says
  and packages reach machines later, so it can be ahead of a machine's Ghost;
  until 1.0 it is written for the current release, and a machine it cannot
  talk to is told to update Ghost.
- **One-time setup per machine:** Tailscale's own `tailscale serve --bg
  --https=443 http://127.0.0.1:7717`, then the
  `https://summonghost.com/#add=<host>` link `ghost status` prints. Hosts
  are `host[:port]` and must end in `.ts.net`.
- **Discovery:** after reaching one machine as owner, the page asks it for
  `/api/remote/machines` and probes each online host's `/api/remote/whoami`;
  each that answers as owner is listed.
- **Machine list:** a row per machine, as a chat list shows a contact: the
  ghost's name and the machine's, the last message's words and time, an
  unread mark, `asks` while the ghost's question is open, "working…" while a
  turn runs, and a menu that removes the machine. `GET /api/conversation`
  gives the time and the marks; its `preview` is the conversation's first
  words, so the last message is read from the transcript's last entry.
  `localStorage` (`summonghost.machines.v1`) keeps each machine's host, role,
  ghost name and when it was last seen, wrapped in try/catch so the page works
  without it; nothing of a conversation is stored. Removed hosts are
  remembered, so discovery does not bring them back. An offline machine keeps
  its ghost's last-known name. A link to a machine the browser does not list
  stays in the address bar and says so.
- **A chat** is one continuous thread: the owner's bubbles on the right, the
  ghost's on the left, newest at the bottom. It opens at the bottom on the
  newest 30 messages; scrolling up (or "Earlier messages") reads the page
  before and keeps the reader's place, and the thread follows what arrives
  only for a reader already at the bottom. The transcript carries no times,
  so the thread shows none.
- **A turn's working is folded, never left out.** A ghost bubble closes at
  its words; the reasoning, handoff note and commands that led to them are a
  `<details>` at its top ("Thought, ran 3 commands, 1 failed") that opens to
  each in order, a command whole with all it printed. Working with no words
  yet is the same line without a bubble, and a stop hook's word is a folded
  line of its own. A running turn is drawn through the same code as a
  finished one ([`thread.js`](public/js/thread.js): `fold` turns wire events
  into transcript-shaped messages, `thread` turns those into bubbles), so a
  fold opened while the turn runs is still open when the transcript replaces
  it. Below the thread a typing bubble shows the command running now and for
  how long.
- **What a chat does:** the turn wire and its `resume` frames; photos
  uploaded on send; the follow-up queue (while a turn runs the send button
  queues, and stops when the composer is empty); stop, which hands queued
  text back to the composer; the ghost's open question, its answers as
  buttons above the composer, the first marked; read marking only while the
  page is visible and focused; and starting over, the one destructive act,
  behind the chat's menu and a dialog that says the conversation goes to that
  machine's Trash.
- **Alerts** ([`push.js`](public/js/push.js)): Web Push with no server of
  the site's. The browser makes a signing key, subscribes, and hands both to
  each machine it reaches as owner; each machine's ghostd encrypts and sends
  its own alerts (`CONTRACTS.md` "Push alerts"). The key is in `localStorage`
  (`summonghost.push.v1`). The service worker shows an alert unless that
  machine's chat is open and focused, and a tap opens it. An alert is tagged
  by the machine its link names, so a machine's newer alert replaces its own
  older one and never another machine's.
- **Errors in plain words** ([`net.js`](public/js/net.js)). A browser hides
  why a cross-origin fetch failed, so the page finds out by elimination: the
  `local-network` permission was denied; a `no-cors` request gets an answer,
  so Ghost is too old or `remote.apps` is off ("update Ghost on <machine>");
  otherwise the machine cannot be reached. A 401 means not the owner. When every machine is unreachable, a banner asks whether Tailscale is
  connected.

## Rules

- No third-party JavaScript, no external fonts, no CDN. Everything is served
  from `public/`.
- Keep the strict CSP in [`public/_headers`](public/_headers): `script-src
  'self'`, `style-src 'self'` (no inline style attributes in markup; setting
  styles from JS is fine), and `connect-src 'self' https://*.ts.net:*`.
- Plain HTML, CSS and JS modules, with no build step and no package manager.
- The service worker caches the app shell (its `SHELL` list) and nothing
  else, and never touches requests to machines.
- Light and dark both follow `prefers-color-scheme`. Lay out for phones first
  (390px), and use two columns from 900px.
- No test writes to a real ghost: its one conversation is the owner's. The
  page is walked against a scratch ghostd (below).

## Check and publish

```sh
bash packages/web/check.sh             # part of the gate
bash packages/web/publish.sh --dry-run # what a publish would change
bash packages/web/publish.sh           # publish HEAD's page, and wait for it
```

`check.sh` runs [`check.html`](check.html) in headless Chromium: every script
parses, the service worker's list names exactly the files that exist and an
alert is tagged by its machine, machine names normalize, and
[`thread.js`](public/js/thread.js) holds: the route, the bubbles a transcript
makes and their folded working, a running turn's events against the transcript
they become, a turn cut by `resume` frames, paging, and the list's times.

Publishing is the owner's call, like a release. `publish.sh` replaces the
contents of the CloudChef project `ferdous/summonghost` with `public/` and
`wrangler.jsonc` from HEAD, plus a pointer README and the minimal
`package.json` CloudChef asks of any project; CloudChef publishes a push to
its `main`. Nothing
is edited in that project. summonghost.com and www are custom domains attached
to its Worker in Cloudflare; a CloudChef deploy cannot attach domains, so
`wrangler.jsonc` declares no routes.

A machine only admits the `https://summonghost.com` origin, and only with the
identity Tailscale Serve stamps. Before it is published the page is walked on
loopback, against scratch ghostds and never the owner's:

- a scratch ghostd per machine, started as
  [`packages/bar/dev/stand-in.sh`](../bar/dev/stand-in.sh) does, with
  `remote.owner` set in its config so no Tailscale is asked, and a scripted
  model server as `local.server`;
- one small TLS server standing in for both ends: for `summonghost.com` it
  serves `public/` with the headers of [`_headers`](public/_headers), the CSP
  included; for each `<machine>.<tailnet>.ts.net` it does Serve's part,
  proxying to that ghostd and stamping `Tailscale-User-Login`. The daemon's
  own Origin check, CORS and identity check are what answer;
- headless Chromium over the Chrome DevTools Protocol, on a profile of its
  own, with `--host-resolver-rules` mapping those names to the TLS server and
  everything else to `~NOTFOUND`, and `--ignore-certificate-errors`.

Walked this way on 2026-11-27, at 390x844 and 1200x800, light and dark: adding
machines by link and by name, an unreachable machine, the chat list's last
message, time, unread mark and `asks`; a chat opening at the bottom, paging
upward with the reader's place kept, a turn with reasoning and commands live
and folded, a follow-up queued and handed back by stop, a turn started from
another client appearing while the reader's place holds, the ghost's question
answered by its button, a photo, an owner `!command`, read marking, and
starting over (the conversation was in the scratch machine's Trash).

On the live site the same browser needs the `local-network` permission. In
Chromium 153 granting it over the protocol (`Browser.setPermission`,
`Browser.grantPermissions`) left it denied; what worked was allowing it in the
stopped profile's `Default/Preferences`
(`profile.content_settings.exceptions.local_network`, key
`https://summonghost.com:443,*`, `"setting": 1`). Turn on
`Emulation.setFocusEmulationEnabled` so read marking runs.

## Not yet verified

- The one-chat page on the live site, through a real Tailscale Serve, and on
  a real phone.
- iPhone Safari: it has no Local Network Access prompt, and its behaviour with
  a public origin calling a tailnet address is unknown.
- Discovery listing a second machine: `/api/remote/machines` answers the
  page, but no other machine of the owner's ran Ghost when it was tried.
- A turn long enough to be cut by `resume` frames, against a real ghostd; the
  reader is checked in `check.html` only.
- Alerts on a real phone, Apple's push service, and an alert arriving with
  the app closed. Checked on 2026-11-25 in desktop Chromium only: the page
  subscribed, and a scratch ghostd's test alert and a real turn's alert went
  through Google's push service and were shown by the service worker. Alerts
  from two machines keeping separate tags is checked in `check.html` only.
