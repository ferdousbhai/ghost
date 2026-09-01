#!/usr/bin/env python3
# ghost-tray — the ghost shell's StatusNotifierItem (system-tray) bridge.
#
# WHY THIS EXISTS AS A SEPARATE PROCESS
# Quickshell 0.3.0 can *consume* a StatusNotifierItem (Quickshell.Services.
# SystemTray) and *consume* a DBusMenu, but it exposes no primitive for
# *producing* either — there is no generic D-Bus object/adaptor or bus-name
# API anywhere in its QML surface (verified against the installed .qmltypes:
# SystemTray, DBusMenu and Mpris are all consumer-only, and core has no DBus
# type). An SNI item is a D-Bus *service*: an object at /StatusNotifierItem
# implementing org.kde.StatusNotifierItem plus a com.canonical.dbusmenu object,
# registered with org.kde.StatusNotifierWatcher. None of that is reachable from
# Quickshell QML, so the shell spawns this tiny helper and drives it.
#
# HOW IT TALKS TO THE SHELL (no second connection to ghostd)
# All ghost state already lives in the shell's one Ghostd singleton. Rather
# than open a second client here, the shell PUSHES state down our stdin as one
# JSON object per line, and we PUSH user intents (left-click, menu choices)
# back up our stdout as one JSON object per line. This helper is a dumb D-Bus
# transport; every ghost decision stays in QML. See qml/TrayBridge.qml.
#
#   stdin  (shell -> here): {"reachable":bool,"streaming":bool,
#                            "activeGhost":str,"activity":str,
#                            "ghosts":[{"name":str},...],
#                            "sessions":[{"id":str,"title":str|null,
#                                         "unread":bool},...],
#                            "colors":{"idle":"#rrggbb","streaming":"#rrggbb",
#                                      "danger":"#rrggbb"}}
#   stdout (here -> shell): {"action":"toggle"}            left click
#                           {"action":"ghost","name":..} ghost menu entry
#                           {"action":"conversation","name":..,
#                            "sessionId":..}               conversation entry
#                           {"action":"new","name":..}  new conversation
#                           {"action":"switcher"}          choose a model
#                           {"action":"quit"}              quit
#
# DEPENDENCIES: python3 + dbus-python + PyGObject (GLib). Both bindings ship on
# a stock Arch/Omarchy desktop (python-dbus, python-gobject). dbus-python is the
# concise, still-maintained way to *serve* D-Bus objects from Python; the
# freedesktop preference for Gio would mean hand-writing introspection XML and a
# call dispatcher for the same result. The icon is drawn procedurally (no image
# library, no asset files) so the whole helper is self-contained.

import json
import math
import os
import struct
import sys
import warnings


def _dependency_error(package, error):
    message = (
        "System tray support needs %s. Install it with "
        "`sudo pacman -S --needed %s`, then restart the ghost shell."
        % (package, package)
    )
    sys.stderr.write("ghost-tray-error:" + json.dumps({
        "kind": "dependency",
        "message": message,
        "detail": str(error),
    }) + "\n")
    sys.stderr.flush()
    raise SystemExit(78)

# GLib.unix_fd_add_full works on every PyGObject we target; its newer alias
# (GLibUnix.fd_add_full) does not exist on older ones, so keep the call and mute
# only its deprecation notice — otherwise it lands on the shell's log as noise.
warnings.filterwarnings("ignore", message=r".*unix_fd_add_full.*")

try:
    import dbus
    import dbus.service
    from dbus.mainloop.glib import DBusGMainLoop
except ImportError as error:
    _dependency_error("python-dbus", error)

try:
    from gi.repository import GLib
except ImportError as error:
    _dependency_error("python-gobject", error)

SNI_IFACE = "org.kde.StatusNotifierItem"
MENU_IFACE = "com.canonical.dbusmenu"
PROPS_IFACE = "org.freedesktop.DBus.Properties"
WATCHER_NAME = "org.kde.StatusNotifierWatcher"
WATCHER_PATH = "/StatusNotifierWatcher"
ITEM_PATH = "/StatusNotifierItem"
MENU_PATH = "/MenuBar"


def _rgb(hex_color, fallback):
    """'#rrggbb' or Qt's '#aarrggbb' -> (r, g, b) ints, tolerant of junk."""
    try:
        h = hex_color.lstrip("#")
        if len(h) == 8:          # Qt serialises non-opaque colors as #aarrggbb
            h = h[2:]
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except (ValueError, IndexError, AttributeError, TypeError):
        return fallback


def _ghost_pixmap(size, rgb):
    """A ghost silhouette as ARGB32 (network byte order) for SNI IconPixmap.

    Drawn at 4x supersampling and boxed down so the dome and feet stay smooth at
    tray sizes. The eyes are punched out (alpha 0) so the shape reads on any
    tray background. Returns (size, size, dbus.ByteArray)."""
    ss = 4
    n = size * ss
    r, g, b = rgb
    cx = 0.5
    half = 0.33          # body half-width
    eye_r = 0.072
    coverage = [0.0] * (size * size)

    for py in range(n):
        y = (py + 0.5) / n
        for px in range(n):
            x = (px + 0.5) / n
            dx = x - cx
            inside = False
            if abs(dx) <= half:
                # Rounded dome on top: above the shoulder line (y<0.5) the shape
                # follows a circle; below it the sides are straight down to a
                # scalloped hem with three feet.
                if y < 0.5:
                    inside = (dx * dx + (y - 0.5) ** 2) <= (half * half)
                else:
                    hem = 0.86 - 0.07 * abs(math.sin(3.0 * math.pi * (dx + half) / (2.0 * half)))
                    inside = y <= hem
            if inside:
                # Punch the two eyes back out.
                for ex in (cx - 0.13, cx + 0.13):
                    if (x - ex) ** 2 + (y - 0.40) ** 2 <= eye_r * eye_r:
                        inside = False
                        break
            if inside:
                oy = py // ss
                ox = px // ss
                coverage[oy * size + ox] += 1.0

    out = bytearray(size * size * 4)
    denom = float(ss * ss)
    for i in range(size * size):
        a = int(round(255 * (coverage[i] / denom)))
        if a > 255:
            a = 255
        # ARGB32, big-endian: bytes are A, R, G, B.
        struct.pack_into("BBBB", out, i * 4, a, r, g, b)
    return (size, size, dbus.ByteArray(bytes(out)))


def _pixmap_variant(pixmaps):
    """[(w,h,bytes),...] -> dbus a(iiay)."""
    arr = dbus.Array([], signature="(iiay)")
    for w, h, data in pixmaps:
        arr.append(dbus.Struct(
            [dbus.Int32(w), dbus.Int32(h), dbus.ByteArray(data)],
            signature="iiay"))
    return arr


class Menu(dbus.service.Object):
    """com.canonical.dbusmenu — a flat menu the host renders on right-click.

    The layout is rebuilt from shell state; every rebuild bumps `revision` and
    emits LayoutUpdated so the host re-fetches. Item ids are stable per slot:
    fixed ids for the standing entries, 100+ for the per-ghost switch rows."""

    def __init__(self, bus, on_action):
        super().__init__(bus, MENU_PATH)
        self._on_action = on_action
        self._revision = 1
        self._items = []          # ordered [(id, props, action)]
        self._ghosts = []
        self._active = ""
        self.rebuild([], "", [])

    def rebuild(self, ghosts, active, sessions):
        self._ghosts = ghosts
        self._active = active
        items = []
        named_ghosts = [ghost for ghost in ghosts if ghost.get("name")]
        if len(named_ghosts) > 1:
            for i, ghost in enumerate(named_ghosts):
                name = ghost.get("name", "")
                items.append((100 + i, {
                    "label": name,
                    "toggle-type": "radio",
                    "toggle-state": 1 if name == active else 0,
                }, ("ghost", {"name": name})))
            items.append((2, {"type": "separator"}, None))
        for i, session in enumerate(sessions[:5]):
            session_id = session.get("id", "")
            if not session_id:
                continue
            title = session.get("title") or "New conversation"
            if session.get("unread"):
                title = "• " + title
            items.append((200 + i, {"label": title}, ("conversation", {
                "name": active,
                "sessionId": session_id,
            })))
        items.append((7, {"label": "New conversation"}, ("new", {"name": active})))
        items.append((3, {"type": "separator"}, None))
        items.append((4, {"label": "Choose a model…"}, ("switcher", None)))
        items.append((5, {"type": "separator"}, None))
        items.append((6, {"label": "Quit ghost shell"}, ("quit", None)))
        self._items = items
        self._revision += 1
        self.LayoutUpdated(dbus.UInt32(self._revision), dbus.Int32(0))

    def _props_dict(self, props, names):
        out = dbus.Dictionary({}, signature="sv")
        for key, value in props.items():
            if names and key not in names:
                continue
            if key == "toggle-state":
                out[key] = dbus.Int32(value)
            elif isinstance(value, bool):
                out[key] = dbus.Boolean(value)
            else:
                out[key] = dbus.String(str(value))
        return out

    def _child_struct(self, item_id, props, names):
        node = dbus.Struct(
            [dbus.Int32(item_id), self._props_dict(props, names),
             dbus.Array([], signature="v")],
            signature="ia{sv}av", variant_level=1)
        return node

    @dbus.service.method(MENU_IFACE, in_signature="iias", out_signature="u(ia{sv}av)")
    def GetLayout(self, parentId, recursionDepth, propertyNames):
        names = list(propertyNames)
        children = dbus.Array([], signature="v")
        if parentId == 0 and recursionDepth != 0:
            for item_id, props, _action in self._items:
                children.append(self._child_struct(item_id, props, names))
        root = dbus.Struct(
            [dbus.Int32(0),
             dbus.Dictionary({"children-display": dbus.String("submenu")}, signature="sv"),
             children],
            signature="ia{sv}av")
        return dbus.UInt32(self._revision), root

    @dbus.service.method(MENU_IFACE, in_signature="asas", out_signature="a(ia{sv})")
    def GetGroupProperties(self, ids, propertyNames):
        names = list(propertyNames)
        wanted = set(int(i) for i in ids) if ids else None
        result = dbus.Array([], signature="(ia{sv})")
        for item_id, props, _action in self._items:
            if wanted is not None and item_id not in wanted:
                continue
            result.append(dbus.Struct(
                [dbus.Int32(item_id), self._props_dict(props, names)],
                signature="ia{sv}"))
        return result

    @dbus.service.method(MENU_IFACE, in_signature="is", out_signature="v")
    def GetProperty(self, item_id, name):
        for iid, props, _action in self._items:
            if iid == item_id and name in props:
                return dbus.String(str(props[name]))
        return dbus.String("")

    @dbus.service.method(MENU_IFACE, in_signature="isvu", out_signature="")
    def Event(self, item_id, eventId, data, timestamp):
        if eventId != "clicked":
            return
        for iid, _props, action in self._items:
            if iid == item_id and action:
                self._on_action(action)
                return

    @dbus.service.method(MENU_IFACE, in_signature="a(isvu)", out_signature="ai")
    def EventGroup(self, events):
        for item_id, eventId, data, timestamp in events:
            if eventId == "clicked":
                self.Event(item_id, eventId, data, timestamp)
        return dbus.Array([], signature="i")

    @dbus.service.method(MENU_IFACE, in_signature="i", out_signature="b")
    def AboutToShow(self, item_id):
        return dbus.Boolean(False)

    @dbus.service.method(MENU_IFACE, in_signature="ai", out_signature="aiai")
    def AboutToShowGroup(self, ids):
        return dbus.Array([], signature="i"), dbus.Array([], signature="i")

    @dbus.service.method(PROPS_IFACE, in_signature="ss", out_signature="v")
    def Get(self, iface, prop):
        return self.GetAll(iface).get(prop, dbus.String(""))

    @dbus.service.method(PROPS_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, iface):
        return dbus.Dictionary({
            "Version": dbus.UInt32(3),
            "Status": dbus.String("normal"),
            "TextDirection": dbus.String("ltr"),
            "IconThemePath": dbus.Array([], signature="s"),
        }, signature="sv")

    @dbus.service.signal(MENU_IFACE, signature="ui")
    def LayoutUpdated(self, revision, parent):
        pass

    @dbus.service.signal(MENU_IFACE, signature="a(ia{sv})a(ias)")
    def ItemsPropertiesUpdated(self, updated, removed):
        pass


class StatusNotifierItem(dbus.service.Object):
    """org.kde.StatusNotifierItem — the tray icon itself."""

    def __init__(self, bus, on_action):
        super().__init__(bus, ITEM_PATH)
        self._on_action = on_action
        self._status = "Active"
        self._title = "ghost"
        self._tooltip = "ghost shell"
        self._icon = _pixmap(( 0xa9, 0xb1, 0xd6))

    def set_icon(self, rgb):
        self._icon = _pixmap(rgb)
        self.NewIcon()

    def set_tooltip(self, title, description):
        self._title = title or "ghost"
        self._tooltip = description or ""
        self.NewToolTip()

    @dbus.service.method(PROPS_IFACE, in_signature="ss", out_signature="v")
    def Get(self, iface, prop):
        return self.GetAll(iface).get(prop, dbus.String(""))

    @dbus.service.method(PROPS_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, iface):
        empty_px = dbus.Array([], signature="(iiay)")
        return dbus.Dictionary({
            "Category": dbus.String("ApplicationStatus"),
            "Id": dbus.String("ghost"),
            "Title": dbus.String(self._title),
            "Status": dbus.String(self._status),
            "WindowId": dbus.Int32(0),
            "IconName": dbus.String(""),
            "IconPixmap": _pixmap_variant(self._icon),
            "OverlayIconName": dbus.String(""),
            "OverlayIconPixmap": empty_px,
            "AttentionIconName": dbus.String(""),
            "AttentionIconPixmap": empty_px,
            "AttentionMovieName": dbus.String(""),
            "IconThemePath": dbus.String(""),
            "ItemIsMenu": dbus.Boolean(False),
            "Menu": dbus.ObjectPath(MENU_PATH),
            "ToolTip": dbus.Struct(
                [dbus.String(""), dbus.Array([], signature="(iiay)"),
                 dbus.String(self._title), dbus.String(self._tooltip)],
                signature="sa(iiay)ss"),
        }, signature="sv")

    @dbus.service.method(PROPS_IFACE, in_signature="ssv", out_signature="")
    def Set(self, iface, prop, value):
        pass

    @dbus.service.method(SNI_IFACE, in_signature="ii", out_signature="")
    def Activate(self, x, y):
        self._on_action(("toggle", None))

    @dbus.service.method(SNI_IFACE, in_signature="ii", out_signature="")
    def SecondaryActivate(self, x, y):
        self._on_action(("toggle", None))

    @dbus.service.method(SNI_IFACE, in_signature="ii", out_signature="")
    def ContextMenu(self, x, y):
        # The host renders the DBusMenu itself from the Menu property; nothing
        # to do here, but the method must exist.
        pass

    @dbus.service.method(SNI_IFACE, in_signature="is", out_signature="")
    def Scroll(self, delta, orientation):
        pass

    @dbus.service.method(SNI_IFACE, in_signature="s", out_signature="")
    def ProvideXdgActivationToken(self, token):
        pass

    @dbus.service.signal(SNI_IFACE, signature="")
    def NewIcon(self):
        pass

    @dbus.service.signal(SNI_IFACE, signature="")
    def NewToolTip(self):
        pass

    @dbus.service.signal(SNI_IFACE, signature="")
    def NewTitle(self):
        pass

    @dbus.service.signal(SNI_IFACE, signature="s")
    def NewStatus(self, status):
        pass


# Icon cache keyed by rgb so a status flip is a dict hit, not a redraw.
_ICON_CACHE = {}


def _pixmap(rgb):
    key = tuple(rgb)
    cached = _ICON_CACHE.get(key)
    if cached is None:
        cached = [_ghost_pixmap(22, rgb), _ghost_pixmap(44, rgb)]
        _ICON_CACHE[key] = cached
    return cached


class Tray:
    def __init__(self):
        self.bus = dbus.SessionBus()
        self.well_known = "org.kde.StatusNotifierItem-%d-1" % os.getpid()
        self.bus_name = dbus.service.BusName(self.well_known, self.bus)
        self.menu = Menu(self.bus, self._emit)
        self.item = StatusNotifierItem(self.bus, self._emit)
        self._colors = {"idle": "#a9b1d6", "streaming": "#7aa2f7", "danger": "#f7768e"}
        self._registered = False
        self.register()
        # If the watcher restarts (tray host reload), register again.
        self.bus.add_signal_receiver(
            self._on_name_owner_changed,
            signal_name="NameOwnerChanged",
            dbus_interface="org.freedesktop.DBus",
            arg0=WATCHER_NAME)

    def register(self):
        try:
            watcher = self.bus.get_object(WATCHER_NAME, WATCHER_PATH)
            watcher.RegisterStatusNotifierItem(
                self.well_known,
                dbus_interface=WATCHER_NAME)
            self._registered = True
        except dbus.DBusException as exc:
            self._registered = False
            sys.stderr.write("ghost-tray: watcher not ready: %s\n" % exc)
            sys.stderr.flush()

    def _on_name_owner_changed(self, name, old, new):
        if name == WATCHER_NAME and new:
            self.register()

    def _emit(self, action):
        verb, arg = action
        msg = {"action": verb}
        if isinstance(arg, dict):
            msg.update(arg)
        elif arg is not None:
            msg["name"] = arg
        try:
            sys.stdout.write(json.dumps(msg) + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, ValueError):
            self.quit()

    def apply(self, state):
        colors = state.get("colors") or {}
        self._colors.update({k: v for k, v in colors.items() if v})
        reachable = bool(state.get("reachable"))
        streaming = bool(state.get("streaming"))
        active = state.get("activeGhost") or ""
        activity = state.get("activity") or ""
        ghosts = state.get("ghosts") or []
        sessions = state.get("sessions") or []

        if not reachable:
            rgb = _rgb(self._colors.get("danger"), (0xf7, 0x76, 0x8e))
        elif streaming:
            rgb = _rgb(self._colors.get("streaming"), (0x7a, 0xa2, 0xf7))
        else:
            rgb = _rgb(self._colors.get("idle"), (0xa9, 0xb1, 0xd6))
        self.item.set_icon(rgb)

        title = active or "ghost"
        if not reachable:
            desc = "ghostd is not answering"
        elif streaming:
            desc = "%s — %s" % (active or "ghost", activity or "thinking")
        else:
            desc = "%s — idle" % (active or "no ghost")
        self.item.set_tooltip(title, desc)
        self.menu.rebuild(ghosts, active, sessions)
        if not self._registered:
            self.register()

    def quit(self):
        try:
            self.loop.quit()
        except AttributeError:
            os._exit(0)


def main():
    DBusGMainLoop(set_as_default=True)
    tray = Tray()
    loop = GLib.MainLoop()
    tray.loop = loop

    # Read shell state pushed on stdin, one JSON object per line. Read the raw
    # fd and split lines ourselves so a partial write can never block us; the
    # shell's HUP (it exited) ends the loop, which lets Qt reap this child.
    fd = sys.stdin.fileno()
    buffer = bytearray()

    def on_stdin(source_fd, condition):
        if condition & (GLib.IOCondition.HUP | GLib.IOCondition.ERR):
            loop.quit()
            return False
        try:
            chunk = os.read(source_fd, 65536)
        except (BlockingIOError, InterruptedError):
            return True
        except OSError:
            loop.quit()
            return False
        if not chunk:            # EOF: shell closed the pipe
            loop.quit()
            return False
        buffer.extend(chunk)
        while b"\n" in buffer:
            raw, _, rest = buffer.partition(b"\n")
            del buffer[:]
            buffer.extend(rest)
            line = raw.strip()
            if not line:
                continue
            try:
                tray.apply(json.loads(line.decode("utf-8")))
            except (ValueError, KeyError, UnicodeDecodeError) as exc:
                sys.stderr.write("ghost-tray: bad state line: %s\n" % exc)
                sys.stderr.flush()
        return True

    GLib.unix_fd_add_full(
        GLib.PRIORITY_DEFAULT, fd,
        GLib.IOCondition.IN | GLib.IOCondition.HUP | GLib.IOCondition.ERR,
        on_stdin)
    try:
        loop.run()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    if sys.argv[1:] == ["--check"]:
        print(json.dumps({"ok": True}))
    else:
        main()
