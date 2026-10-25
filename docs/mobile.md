# Work from a phone

Enable the existing Tailscale viewer with `ghost remote on`; open the URL from
`ghost remote status` on a phone signed into the tailnet. The host must remain
awake, logged in, and connected. A missing host cannot run work or deliver alerts.

The conversation tools menu contains resources and routines.
Owners can edit, pause/resume, run, remove, and recover routines. Guests retain
read-only conversation access and cannot access routine controls or
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

Ghost does not stream the desktop or add remote input routes. Existing VNC
software is the first candidate for a separately requested takeover workflow:
[wayvnc](https://github.com/any1/wayvnc) attaches to compatible Wayland sessions,
serves one display, and supports virtual input. Its upstream recommendation is
loopback access through an SSH tunnel; authentication and compositor protocol
compatibility need their own validation. No remote-desktop server was installed
or enabled for this work, and Hyprland compatibility is not asserted. Before
adopting one, verify observation and input against nested Hyprland, then check
the phone client and explicit disconnect/disable behavior. Keep that facility's
access controls independent of Ghost's read-only guests.
