# Work from a phone

Enable the existing Tailscale viewer with `ghost remote on`; open the URL from
`ghost remote status` on a phone signed into the tailnet. The host must remain
awake, logged in, and connected. A missing host cannot run work or deliver alerts.

Or open the `app` link `ghost remote status` prints (the HUD's Remote access
pane shows it with a QR code),
`https://summonghost.com/#add=<hostname>`: the app adds this machine, then
finds your other machines running Ghost, all in one page. It needs the tailnet's
HTTPS certificates (Tailscale admin console → DNS → HTTPS Certificates, then
`ghost remote on` again), and Chrome asks once to allow local network access.
The app has no server; its page calls each machine directly. Set
`remote.apps` to `[]` in the config to refuse it.

The conversation tools menu contains resources and routines.
Owners can edit, pause/resume, run, remove, and recover routines. Guests, only
when `remote.guests` is `"read-only"`, can read conversations and cannot access routine controls or
machine-local tool routes. See `CONTRACTS.md` for the wire contract.

## Completion alerts

`ghost help notifications` explains opt-in delivery through a command hook and
an existing service, with a curl/ntfy example. Follow [ntfy's publishing
instructions](https://docs.ntfy.sh/publish/) for your server's authentication and
[phone subscription setup](https://docs.ntfy.sh/subscribe/phone/). No service,
phone destination, or credentials are preconfigured. The selected service
receives the conversation title and completion/failure excerpt.

Alerts contain a link to the exact ghost and conversation when remote access is
available. Removing the hook disables delivery; cancellations stay quiet.
Delivery failures are logged and do not change the work's outcome. There is no
retry queue. The subscribed phone app handles notifications with the viewer
closed; platform/server delivery restrictions still apply.

The viewer marks a reply read only after displaying its transcript while visible
and focused. Opening an unrelated conversation does not acknowledge it. Missing
linked conversations produce an error, preserving the requested URL. Network
failures remain visible and work is not silently resubmitted to another host.

## Remote desktop is separate

Ghost does not stream the desktop or accept remote input. Use existing VNC
software such as [wayvnc](https://github.com/any1/wayvnc) for that, with its
own access controls.
