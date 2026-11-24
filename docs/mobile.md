# Work from a phone

The phone client is the [summonghost.com](https://summonghost.com) app. Turn on
remote access with `ghost remote on`, then open the `app` link
`ghost remote status` prints, `https://summonghost.com/#add=<hostname>`, on a phone signed into the
tailnet: the app adds this machine, then finds your other machines running
Ghost, all in one page. The host must remain awake, logged in, and connected. A
missing host cannot run work or deliver alerts.

Remote access is served over HTTPS only, since the app is an HTTPS page: without
the tailnet's HTTPS certificates `ghost remote on` serves nothing and says to
turn them on (Tailscale admin console → DNS → HTTPS Certificates, then
`ghost remote on` again). Chrome asks once to allow
local network access. The app has no server; its page calls each machine's
Tailscale Serve address directly, admitted by your Tailscale identity. Ghost
itself serves no page there. Set `remote.apps` to `[]` in the config to refuse
the app, which leaves no remote client.

Guests, only when `remote.guests` is `"read-only"`, can read conversations and
cannot act or reach owner-only routes. See `CONTRACTS.md` for the wire contract.

## Completion alerts

`ghost help notifications` explains opt-in delivery through a command hook and
an existing service, with a curl/ntfy example. Follow [ntfy's publishing
instructions](https://docs.ntfy.sh/publish/) for your server's authentication and
[phone subscription setup](https://docs.ntfy.sh/subscribe/phone/). No service,
phone destination, or credentials are preconfigured. The selected service
receives the conversation title and completion/failure excerpt.

Alerts link to the exact conversation in the app,
`https://summonghost.com/#/<hostname>/<ghost>/<conversation>`, while remote
access is on; the link opens on a device that has added this
machine. Removing the hook disables delivery; cancellations stay quiet.
Delivery failures are logged and do not change the work's outcome. There is no
retry queue. The subscribed phone app handles notifications with summonghost.com
closed; platform/server delivery restrictions still apply.

The app marks a reply read only after displaying its transcript while visible
and focused. Opening an unrelated conversation does not acknowledge it.

## Remote desktop is separate

Ghost does not stream the desktop or accept remote input. Use existing VNC
software such as [wayvnc](https://github.com/any1/wayvnc) for that, with its
own access controls.
