# Ghost browser relay (Chromium extension)

An agent works **tabs it created in the browser you are already signed into**.
That is the whole product. There are two ways to instruct it, and they share one
implementation of the tabs:

- **Chat in the side panel**, on your own OpenRouter account. Needs nothing else
  installed; the default model is free.
- **Hand the tabs to a ghost** running in `ghostd` on the same machine, over a
  loopback socket. Needs [Ghost](https://github.com/ferdousbhai/ghost).

Every page operation names the tab it acts on. A browser workspace — one per
ghost, one for the side panel — may hold several tabs, and one workspace never
sees another's. Point either side at the other's tab and it is refused by name.

This is the only browser a ghost has. There is no second profile to fall back to,
so until this extension pairs, browser calls fail and say so; if Chromium is not
running, the ghost starts it from the shell like anything else. That is the point:
the pages worked on are your session — read
the thing behind the login, fill the form on the site that knows who you are,
check the dashboard you never log out of.

## How it fits together

```
ghost tool call
  → GhostBrowserSession        url policy, ref bookkeeping, read budget, idle timer
    → RelayBrowserBackend      packages/extensions/.../browser-relay-backend.ts
      → RelayHub               packages/daemon/src/relay.ts, ws://127.0.0.1:7717/relay
        → this extension       background.js dials OUT, ops.js drives the named tab
          → chrome.debugger    real CDP input into a ghost-owned tab
```

The extension **dials out**. A service worker cannot listen on a socket, so
ghostd is the server. Nothing has to start in a particular order: ghostd restarts
and the extension reconnects, Chromium closes and the relay simply reports as
disconnected.

## Install

```sh
packages/chromium-extension/contrib/install.sh        # copy to ~/.local/share/ghost/
packages/chromium-extension/contrib/install.sh --link # symlink, for hacking on it
```

Then, in the browser you actually use: `chrome://extensions` → Developer mode →
**Load unpacked** → the printed directory.

There is deliberately no attempt to install into your running browser
automatically. `--load-extension` only applies to a process started with it, and
Chrome ≥ 137 ignores it for the default profile without a policy allowlist —
which means any script claiming to do it either restarts your browser or edits
your profile behind your back. Four clicks, once, is the honest version.

On Omarchy the relevant browser is the `chromium` package (`sudo pacman -S
chromium`); the extension also works in Chrome and Brave. It needs Chrome ≥ 125
for flat `chrome.debugger` sessions.

## Chat here

Click the toolbar icon, then **Open chat**. **Connect OpenRouter** authorizes
this browser against your own OpenRouter account with OAuth PKCE; the secret half
of the exchange never leaves the browser, and the key it mints is kept in
`chrome.storage.local` and sent to `openrouter.ai` and nowhere else.

If the one-click path cannot complete — a callback URL an authorization server
will not accept is a real possibility, and this one is not ours to fix — the
manual path always works: **Open authorization page** shows a code on
OpenRouter's own page, and pasting it here finishes the same exchange. Pasting an
`sk-or-…` key you already have works too.

The default model is `openrouter/free`, OpenRouter's free router: it picks a free
model that can call tools and reports which one answered. The picker lists every
tool-capable model in the catalog, free first. A paid model works the moment your
OpenRouter balance covers it and says so, in OpenRouter's own words, when it does
not. Each turn ends with the model that actually answered and what it cost.

The agent acts only in tabs it opened, and finds them again after Chrome reaps
and restarts the extension's worker, whether or not a ghost ever pairs. **New**
closes them and starts a fresh workspace; **Disconnect** forgets the key.
**Pause** in the popup stops a turn mid-flight and refuses everything until you
resume — the same switch that refuses the ghost. **Stop** ends a turn at its next
step; the relay has no cancel for a page action Chromium has already been
handed, and the button says "Stopping…" while that finishes.

The free router names the model it picked in its first answer, and the rest of
that turn is pinned to it: a router swapping models between steps would do so
invisibly, and a pinned model that is rate-limited fails honestly instead.

The turn loop runs in the panel document, not in the service worker, because a
worker is reaped after thirty idle seconds and a conversation is not. The visible
consequence is that closing the panel ends the turn, like pressing **Stop**. What
already happened is saved.

### Proving it live

```sh
bun contrib/smoke.mjs --local                      # no ghost, no key: the tab path
OPENROUTER_API_KEY=sk-or-… bun contrib/smoke.mjs --local   # plus one real free-router turn
```

The unit tests stub the network and fake the tabs. This does neither: a
throwaway Chromium, the real side panel opened by the real API, the panel's own
message path driving `open`/`read`/`find`/`click`/`screenshot`, and a forced
worker reap followed by an op that must still find the tab. With a key it also
sends one message and reads the usage line back. The extension is pointed at a
dead loopback port first, so its pairing dial never reaches a live ghostd.
Verified 2026-09-20 on Chromium 153 without a key. The two paid-model criteria
(funded key: usage shown; unfunded key: OpenRouter's insufficient-credit
sentence) are a by-hand check with a real account and are not automated.

### Packaging

```sh
contrib/package.sh          # dist/ghost-browser-relay-<version>.zip
```

The zip is `extension/` and nothing else, with no build step, so the bytes a
store reviewer reads are the bytes that run. Listing copy, permission
justifications, and the data disclosure are in [`STORE.md`](STORE.md); the
privacy policy is [`PRIVACY.md`](PRIVACY.md).

## Pair

Nothing to copy. An unpaired extension asks ghostd to pair and shows a
six-digit code in its popup (click the icon, or press `Alt+Shift+G`). Open the
HUD (`Super+Ctrl+G`): it shows the same code with **Allow** and **Deny**. Allow
only when the two match. ghostd then hands the extension its token over the
socket, the badge turns `on`, and the token is kept in `chrome.storage.local`,
so this is a once-per-browser step. From a terminal instead:

```sh
ghost browser              # "pairing requested: code 482913" while one waits
ghost browser allow 482913
ghost browser deny 482913
```

A denied browser stops asking until you press **Try again** in its popup. A
request nobody answers expires after ten minutes and the extension asks again
with a new code. The manual path is still there under **Advanced** in the popup:
`ghostd relay-token` prints the token (`--rotate` mints a new one and unpairs
every browser), and pasting it pairs without the prompt. The worker answers only
the real toolbar popup: `popup.html` opened as a tab shows "not paired" and
cannot save or pair, which is what keeps a page from pairing on your behalf.

On Omarchy the browser already reads `~/.config/chromium-flags.conf`, and its
own extensions load from a `--load-extension=` line there; append this
directory to that line and the relay loads on the next Chromium start with no
`chrome://extensions` visit. The badge reads `on`
only after a compatible ghostd has answered the protocol handshake, `||` when
that authenticated connection is paused, and `off` otherwise.

The popup is disposable UI: the background worker serializes settings changes
and stores a revisioned recovery copy before acknowledging them. A timed-out old
Chromium write therefore cannot overwrite a newer choice after the popup closes.
Badge updates are cosmetic and never block connection or alarm retries.

The current relay protocol is 4. An older daemon or extension is refused
before either side accepts browser work; update the older Ghost package. The
extension probes again after a one-minute cool-down, or reload it from
`chrome://extensions` to retry immediately after updating either side.

The token lives at `$XDG_STATE_HOME/ghost/relay-token` (default
`~/.local/state/ghost/relay-token`), mode `0600`.
The pasted copy lives in Chromium's profile under `chrome.storage.local`;
Chromium owns that on-disk layout and the extension cannot assign it a separate
POSIX mode. Anyone who can read the browser profile should be treated as able to
recover the relay token. It authorizes only this loopback relay, not the daemon
HTTP API, and `--rotate` invalidates both copies immediately.

## The security model

The daemon's other routes have their own bearer token, read from a `0600` file
by clients that can read files (CONTRACTS.md). The relay cannot borrow that
secret, because the peer is a *browser*: the token ends up in the extension's
storage, somewhere you do not fully control, and a leak there must not also
hand out the API. Any page you visit can open `ws://127.0.0.1:7717/relay`. So
the relay gets a second token of its own, delivered over the socket once you
have matched a pairing code by eye:

| Gate | Stops |
| --- | --- |
| Bound to `127.0.0.1` | Anything off this machine. |
| `Origin` must be `chrome-extension://…` or absent | A web page opening the socket from a tab you are visiting. |
| 32-byte token, compared in constant time | Everything else, including another extension. |
| Pairing code matched by the owner | Another extension pairing itself: a code-only socket receives nothing until the owner allows that exact code in the HUD or CLI. |
| One connection at a time | A second browser driving the same tabs behind this one's back. |
| Closed, validated op set | Arbitrary CDP frames and script hidden in another verb; `javascript` remains one explicit capability. |

And on the extension side:

- **No `tabs`, no `activeTab`, no `host_permissions`, no `chrome.scripting`, no
  content scripts.** The five standing grants are `debugger`, `storage`,
  `alarms`, `sidePanel`, and `identity`; the last two show no warning and grant
  no reach into a page. OpenRouter answers extension origins under ordinary
  CORS, which is why chatting needs no host grant either.
  The required `debugger` permission can enumerate target
  URL/title metadata even before attachment; the relay uses that capability only
  to describe and validate tab ids it created. Page content and actions require
  an attached debugger session, where Chrome draws its own un-suppressable "is
  being debugged" banner. Dismissing that banner detaches the debugger and locks
  the relay out of the tab until it navigates.
- **Only tabs created by the ghost.** It never adopts a tab you opened. The
  `tabs` operation can create, select, or close one of those tabs. Conversations
  of the same ghost share that workspace; terminal ghost teardown attempts every
  tab in it, leaving other ghosts' tabs and the browser itself open.
- **Only your workspace.** The side panel's workspace id is stamped by the
  service worker, never chosen by the caller, and only the extension's own
  chrome-owned popup and panel documents can ask for one. A page — including one
  of these documents opened as an ordinary tab — is ignored.
- **The page-script op asks, every time.** In side-panel chat `javascript` shows
  the exact code with **Run it** / **Don't** before anything runs. There is no
  remembered answer; the code is different each time, and reading *this* code is
  the point. Every other op the model is offered is a fixed action and runs
  direct. Two ops are not offered to it at all: `close` (workspace teardown is
  the **New** button's) and `upload`, which would hand the browser model-chosen
  paths on your disk on the say-so of a model reading untrusted pages — a ghost
  already has your shell, so for it the op is nothing new; for the chat it would
  be the extension's only reach into the filesystem, and no confirmation card
  makes a path safe to vet.
- **Pause** in the popup refuses every request instantly, without unpairing, on
  both sides.
- The extension re-checks the URL scheme itself: it does not have to trust the
  daemon in order to be safe to install.

What this does *not* protect against:

- The ghost is genuinely acting as you, in your session, with your cookies. That
  is the feature. Pause in the popup, or close the tab, for anything you would
  not do yourself.
- **DNS rebinding.** Ghost resolves a hostname and checks the answers before it
  navigates, but the browser resolves it again independently. A short-TTL name
  that answers publicly to the daemon and `127.0.0.1` to Chromium will load.
- **Subresources.** Only the URL the ghost asks for is checked. A public page's
  own `fetch`, XHR, and iframes are never seen by Ghost, so a page can reach
  private-network addresses from inside your browser.
- **Redirects that already fired.** A redirect to a private address is caught
  when Ghost rechecks where it landed, so the ghost cannot read the response —
  but the request was already made, with your cookies.

The backend that could enforce these per-request — a browser Ghost launched and
proxied — was removed on purpose. Restoring them belongs here, in the extension,
which already has `chrome.debugger` and could pause requests with `Fetch.enable`;
that is a deliberate not-yet, not an oversight.

## Behaviour worth knowing

No build step: plain ES modules under `extension/`, requesting `debugger`,
`storage`, and `alarms` and nothing else. Edit and hit reload in
`chrome://extensions`.

Each relay request carries a deadline. The extension applies it around the whole
operation and drops a late result if the socket that requested it has gone away.
Chromium's `chrome.debugger.sendCommand()` Promise has no cancellation signal,
and the relay protocol has no cancel frame, so a deadline bounds the reply but
does not claim to abort a CDP command already accepted by Chromium. A terminal
Ghost-workspace close first publishes a durable retirement marker, then makes bounded
attempts against every known tab. Late tab creation observes that marker and
removes itself; uncertain removals remain owned and are retried by the keepalive
alarm even after ghostd has rotated to a fresh browser owner id. Tombstones are
discarded only once no late create handler can still produce a tab. Chrome
settings and ownership storage calls are bounded as well, so one silent API call
cannot pin the reconnect loop or extension popup indefinitely.

Settings, uncertain-tab recovery, and daemon identity are revisioned in two
independent local slots. A late write from a reaped MV3 worker can regress at
most one slot, so the next worker keeps the newer acknowledged state; the
second-written slot is the commit record for an equal-revision race. If settings
cannot be verified, only status works. Page actions stay locked out until
recovery succeeds.

Ownership recovery is scoped to Chromium's current browser session. An MV3
worker restart recovers the same ghost-owned tabs, while a full Chromium restart
mints a fresh identity and never adopts a reused numeric tab id from the prior
browser process. Both uncertain-tab slots are cleared for that new identity
before it is published. Recovery accepts at most 1,024 owned tabs and checks no
more than 16 at once under a shared five-second deadline.

Each ghostd process also announces a fresh incarnation in the protocol-4
welcome. The extension retires claims left by an earlier crashed process before
it sends hello or accepts new work; an ordinary reconnect to the same process
keeps the ghost's workspace intact.

## Element refs

`find` mints `e1`, `e2`, … without writing attributes or expandos onto the
owner's DOM. Its isolated world keeps element → ref in a `WeakMap` and ref →
element in a `Map` of `WeakRef` records. Resolution is an O(1) lookup followed by
identity and tag checks: a collected, different, or tag-changed node cannot take
over a ref. A page can still semantically change the same surviving same-tag
element, as with any live DOM. Each `find` replaces the registry, and navigation
destroys the isolated world; only refs from the current results on the current
document resolve.

The relay keeps `find` bounded by walking at most 10,000 elements and returning
at most 100. Its CSS-selector path deliberately rejects `:scope`, the CSS nesting
selector `&`, CSS comments, and CSS escapes outside quoted strings: those forms
can change token identity or document scoping in ways a lazy per-element match
cannot reproduce without a full CSS parser. Quoted attribute values remain
opaque, so selectors such as `[data-label=":scope"]` and `[data-label="&"]`
still work. Use an ordinary selector or visible text for the rejected forms.

## Provenance

The icon assets are raster sizes of Lucide's ISC-licensed `ghost` glyph, already
used as the shell mascot, in the shell's fixed `ghostAmber` brand colour. The
required copyright and permission text is in the root
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md#lucide).

The relay shape — MV3 extension dialing out over WebSocket, the reconnect and
service-worker-keepalive loop, the `attached`/`banned`/`attaching` attach state
machine with ban-on-failure and clear-on-navigation, the viewport-clipped
`elementFromPoint` actionability probe — is ported from the MIT-licensed
`browser-relay` package in [oh-my-pi](https://github.com/can1357/oh-my-pi). No
code is vendored: their server half is Bun-only and their protocol is raw CDP
rather than the semantic verbs used here.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Badge stays `off` | ghostd is not running, or the port is wrong. The popup says which. |
| "That pairing token is not this daemon's" | Token rotated, or `$XDG_STATE_HOME` differs between the shell and the daemon. Clear the token under **Advanced** and pair again. |
| Popup shows a code but the HUD shows nothing | The HUD polls only while open; open it, or run `ghost browser`. The relay may also be off (`GHOSTD_RELAY`). |
| "Ghost denied this browser" | You pressed Deny. **Try again** asks with a new code. |
| "A browser is already connected" | Another Chromium profile has the extension paired. Only one at a time. |
| "Browser ownership … is indeterminate" | A storage failure interrupted tab creation. Close the named ghost-created tab; the relay retries automatically. |
| "Chromium refused to attach its debugger" | DevTools is open on that tab, or another extension is debugging it. |
| Worked, then stopped after a while | You dismissed the debugger banner. It recovers when the tab navigates. |
| "belongs to a ghost's browser workspace" | You pointed the chat at a tab a ghost opened, or the reverse. Each side drives only its own tabs. |
| Chat says OpenRouter has insufficient credits | That model is not free and the account's balance does not cover it. Fund it at openrouter.ai, or pick a free model. |
| "OpenRouter did not return a code" | The one-click callback did not complete. Use **Connect manually instead** — it is the same exchange. |
| The turn stopped when the panel closed | The loop lives in the panel. Reopen it; the conversation is still there. |
