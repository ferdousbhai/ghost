# Work from a phone

The phone client is the [summonghost.com](https://summonghost.com) page. Serve
Ghost to your tailnet with Tailscale's own command,
`tailscale serve --bg --https=443 http://127.0.0.1:7717` (your ghost can run it for you),
then open the `app` link `ghost status` prints,
`https://summonghost.com/#add=<hostname>`, on a phone signed into the
tailnet: the page adds this machine, then finds your other machines running
Ghost. The host must remain awake, logged in, and connected. A
missing host cannot run work or deliver alerts.

Remote access is HTTPS only, since the page is served over HTTPS: `ghost status`
says `remote on` only for an HTTPS Serve entry. Tailscale refuses one until
the tailnet has HTTPS certificates (Tailscale admin console → DNS → HTTPS
Certificates), and may ask for the operator right (`sudo tailscale set
--operator=$USER`). `tailscale serve --https=443 off` turns it off. Chrome asks once to allow
local network access. The page has no server; it calls each machine's
Tailscale Serve address directly, admitted by your Tailscale identity. Ghost
itself serves no page there. Set `remote.apps` to `[]` in the config to refuse
the page, which leaves no remote client.

Only your own Tailscale login gets in. See `CONTRACTS.md` for the wire contract.

## The page

It works as a messaging app does. The first screen lists your machines, each
with its ghost's name, the last message and when, and a mark when there is
something you have not read. Opening a machine opens its one conversation:
your messages on the right, the ghost's on the left, the newest at the bottom;
scroll up for earlier ones. While the ghost works, a typing bubble shows the
command it is running. Each reply has a small line above it, such as "Thought,
ran 3 commands": tap it to see the ghost's reasoning and every command with
all it printed.

Send while the ghost is working and your message waits its turn; the send
button with nothing typed stops the turn and hands back what was waiting. When
the ghost asks you something, its answers are buttons above the message box,
its recommendation first, and you can type any other answer. The camera button
attaches photos. "Start over…" in the chat's menu moves the conversation to
that machine's Trash and begins a new one with your next message.

## Completion alerts

Turn them on in the page: "Alert this device when a ghost finishes", on the
machines screen. The browser asks to allow notifications, and one of your
machines sends a test alert. One switch covers every machine you own; a
machine added later is told when the page next reaches it. On an iPhone, add
SummonGhost to the Home Screen first and open it from there: Safari only
allows alerts for a Home Screen app.

Each machine sends its own alerts, straight to your browser's push service
(Apple, Google, Mozilla or Microsoft), encrypted so that only your device can
read them. summonghost.com is not involved and stores nothing. An alert
carries the ghost's name and a short excerpt of the reply, and opens
that machine's conversation, `https://summonghost.com/#/<hostname>`.
Cancelled turns stay quiet. The machine must be awake and online to send one;
a device that is offline gets it within a day. A failed delivery is logged
and is not retried. Turn the switch off to stop them.

The page marks a reply read only after displaying its transcript while visible
and focused. Opening another machine does not acknowledge it.

## Remote desktop is separate

Ghost does not stream the desktop or accept remote input. Use existing VNC
software such as [wayvnc](https://github.com/any1/wayvnc) for that, with its
own access controls.
