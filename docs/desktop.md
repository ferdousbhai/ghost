# ghost-desktop

`ghost-desktop` is computer use for a Hyprland desktop, served over stdio MCP.
Ghost runs it for its own conversations, and any MCP client can run it
directly:

```sh
claude mcp add --scope user desktop -- ghost-desktop
```

It has two tools. Their full descriptions and schemas are in
[`server.ts`](../packages/desktop/src/server.ts), which is the single source;
this page covers what the schemas cannot.

- **`desktop_look`** never changes the desktop. With no arguments it returns
  monitors, windows, overlay layers (launchers, notifications, on-screen
  keyboards), and the cursor. Name a window to add its accessibility tree
  (`ui`) or a screenshot (`image`), or screenshot a region or monitor.
- **`desktop_act`** runs ordered `steps` and stops at the first failure,
  returning what was done before it. `then` looks again in the same call.

## Coordinates

Everything is in desktop (logical) coordinates, the ones `hyprctl` reports. A
screenshot at the default scale 1 has one image pixel per desktop unit, so an
image pixel plus the image's `geometry` origin is the screen point to click.
A control from `ui` carries its center as `at`.

## What it uses

| Need | How | Fails as |
| --- | --- | --- |
| Windows, focus, workspaces, launching | `hyprctl` in the session's dispatch grammar (Lua on 0.56+, legacy strings before); every value is a Lua string literal, never raw code | `unavailable` outside Hyprland |
| Screenshots | `grim -T` reads a window's own buffer, covered or on another workspace; a window on screen whose buffer cannot be read falls back to the screen region and says so; a hidden one is refused | `unavailable` |
| Controls | the AT-SPI bus, over ghost-desktop's own D-Bus client | `unavailable`, with how to start the bus or enable Chromium's tree |
| Pointer | Hyprland moves the cursor; a `zwlr_virtual_pointer_v1` device per step clicks, drags, and scrolls, then is destroyed | `unavailable` if the compositor lacks the protocol |
| Keys | `send_shortcut` to the named window, no focus change. Hyprland names keys from the last keyboard's keymap, which after a `type` is wtype's, so a refused chord falls back to focusing the window and `wtype` | |
| Text | `wtype` into the focused field, the text as an argument (from stdin wtype drops characters past ~100); layout-independent | |
| Clipboard, notifications | `wl-clipboard`, `notify-send` | `unavailable` if missing |

Every step reports what it disturbed: `focus`, `pointer`, or `workspace`.

A key chord reaches the window, never Hyprland's own bindings: `super+shift+3`
sent to a terminal types `#`. Workspace and window moves are `desktop_act`
steps; anything else bound in Hyprland is an `omarchy` command.

## Safety

- **Locked session.** `desktop_act` does nothing unless both Hyprland and
  logind can be asked and neither says locked; an unknown state counts as
  locked.
- **One driver at a time.** The lease in `CONTRACTS.md` ("Ghosts run
  unthrottled"): another caller's `desktop_act` fails `busy` until the holder
  has been idle 15 s.
- **Untrusted content.** Window titles, on-screen text, and control names are
  data. Ghost fences them before its model reads them; another client should
  treat them the same way.

## Errors

A failed call is an MCP error result whose text starts with a code:
`unavailable`, `locked`, `busy`, `not_found`, `invalid`, or `failed`. The rest
of the text is written for the model and names the next move.

The Wayland wire protocol is ported from
[hypruse](https://github.com/IlyasKhallouki/hypruse) (MIT, Ilyas Khallouki).
