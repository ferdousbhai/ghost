# The summonghost.com page

[summonghost.com](https://summonghost.com) is how an owner reaches Ghost on
their machines from a phone or any other device on their tailnet. It is
Ghost's only remote client. The owner's words for it: "myself and every other
user [can] go to a simple domain (summonghost.com), have a one time setup per
machine, and then see all their machines and the ghosts in them, and
converse." A machine has one ghost, so the page lists machines and opens each
one's conversations directly; the route is `#/<host>/<conversation>`.

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
- **Machine list:** kept in `localStorage` (`summonghost.machines.v1`),
  wrapped in try/catch so the page works without it. Removed hosts are
  remembered, so discovery does not bring them back. An offline machine keeps
  its ghost's last-known name.
- **A conversation:** everything a turn held, in order (the model's
  reasoning, each command whole with all it printed, and what it said), live
  and from the transcript; the newest transcript
  page; read marking only while the page is visible and focused; the turn wire
  and its `resume` frames; photos uploaded on send; the follow-up queue (while
  a turn runs the send button queues, and stops when the composer is empty);
  stop, which hands queued text back to the composer; answering the ghost's
  open question; pin, unpin and delete.
- **Alerts** ([`push.js`](public/js/push.js)): Web Push with no server of
  the site's. The browser makes a signing key, subscribes, and hands both to
  each machine it reaches as owner; each machine's ghostd encrypts and sends
  its own alerts (`CONTRACTS.md` "Push alerts"). The key is in `localStorage`
  (`summonghost.push.v1`). The service worker shows an alert unless its
  conversation is open and focused, and a tap opens that conversation.
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
- A test that writes to a real ghost creates its own conversation and deletes
  it afterwards.

## Check and publish

```sh
bash packages/web/check.sh             # part of the gate
bash packages/web/publish.sh --dry-run # what a publish would change
bash packages/web/publish.sh           # publish HEAD's page, and wait for it
```

`check.sh` runs [`check.html`](check.html) in headless Chromium: every script
parses, the service worker's list names exactly the files that exist, and
machine names normalize.

Publishing is the owner's call, like a release. `publish.sh` replaces the
contents of the CloudChef project `ferdous/summonghost` with `public/` and
`wrangler.jsonc` from HEAD, plus a pointer README and the minimal
`package.json` CloudChef asks of any project; CloudChef publishes a push to
its `main`. Nothing
is edited in that project. summonghost.com and www are custom domains attached
to its Worker in Cloudflare; a CloudChef deploy cannot attach domains, so
`wrangler.jsonc` declares no routes.

A machine only admits the `https://summonghost.com` origin, so the page is
tested against a real ghostd on the live site, in headless Chromium over the
Chrome DevTools Protocol, on a profile of its own. The page needs the
`local-network` permission. In Chromium 153 granting it over the protocol
(`Browser.setPermission`, `Browser.grantPermissions`) left it denied; what
worked was allowing it in the stopped profile's `Default/Preferences`
(`profile.content_settings.exceptions.local_network`, key
`https://summonghost.com:443,*`, `"setting": 1`). Turn on
`Emulation.setFocusEmulationEnabled` so read marking runs.

Walked this way against ghostd 0.13.0 on 2026-11-25: adding a machine by its
link, the conversation list, a new conversation with a command run, a
follow-up queued during the turn, pin, unpin and delete.

## Not yet verified

- iPhone Safari: it has no Local Network Access prompt, and its behaviour with
  a public origin calling a tailnet address is unknown.
- Discovery listing a second machine: `/api/remote/machines` answers the
  page, but no other machine of the owner's ran Ghost when it was tried.
- Photos, stop, answering the ghost's question and read marking, against a
  real ghostd.
- Alerts on a real phone, Apple's push service, and an alert arriving with
  the app closed. Checked on 2026-11-25 in desktop Chromium only: the page
  subscribed, and a scratch ghostd's test alert and a real turn's alert went
  through Google's push service and were shown by the service worker.
