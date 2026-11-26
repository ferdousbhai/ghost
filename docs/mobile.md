# Work from a phone

The phone client is the [summonghost.com](https://summonghost.com) app. Serve
Ghost to your tailnet with Tailscale's own command,
`tailscale serve --bg --https=443 http://127.0.0.1:7717` (your ghost can run it for you),
then open the `app` link `ghost status` prints,
`https://summonghost.com/#add=<hostname>`, on a phone signed into the
tailnet: the app adds this machine, then finds your other machines running
Ghost, all in one page. The host must remain awake, logged in, and connected. A
missing host cannot run work or deliver alerts.

Remote access is HTTPS only, since the app is an HTTPS page: `ghost status`
says `remote on` only for an HTTPS Serve entry. Tailscale refuses one until
the tailnet has HTTPS certificates (Tailscale admin console → DNS → HTTPS
Certificates), and may ask for the operator right (`sudo tailscale set
--operator=$USER`). `tailscale serve --https=443 off` turns it off. Chrome asks once to allow
local network access. The app has no server; its page calls each machine's
Tailscale Serve address directly, admitted by your Tailscale identity. Ghost
itself serves no page there. Set `remote.apps` to `[]` in the config to refuse
the app, which leaves no remote client.

Guests, only when `remote.guests` is `"read-only"`, can read conversations and
cannot act or reach owner-only routes. See `CONTRACTS.md` for the wire contract.

## Completion alerts

Turn them on in the app: "Alert this device when a ghost finishes", on the
machines page. The browser asks to allow notifications, and one of your
machines sends a test alert. One switch covers every machine you own; a
machine added later is told when the app next reaches it. On an iPhone, add
SummonGhost to the Home Screen first and open it from there: Safari only
allows alerts for a Home Screen app.

Each machine sends its own alerts, straight to your browser's push service
(Apple, Google, Mozilla or Microsoft), encrypted so that only your device can
read them. summonghost.com is not involved and stores nothing. An alert
carries the conversation's title and a short excerpt of the reply, and opens
that conversation, `https://summonghost.com/#/<hostname>/<conversation>`.
Cancelled turns stay quiet. The machine must be awake and online to send one;
a device that is offline gets it within a day. A failed delivery is logged
and is not retried. Turn the switch off to stop them.

The app marks a reply read only after displaying its transcript while visible
and focused. Opening an unrelated conversation does not acknowledge it.

## Remote desktop is separate

Ghost does not stream the desktop or accept remote input. Use existing VNC
software such as [wayvnc](https://github.com/any1/wayvnc) for that, with its
own access controls.
