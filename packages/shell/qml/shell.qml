pragma ComponentBehavior: Bound

// @ghost/shell — the Quickshell entry point.
//
// Run it with:  qs -c ghost           (installed to ~/.config/quickshell/ghost)
//               qs -p packages/shell/qml/shell.qml   (from a checkout)
//
// One process owns every ghost surface so they can share one Ghostd client:
// the HUD's live stream is the same state the bar dot reads, with no polling
// and no second connection to the daemon.
//
// AppId is an *instance* pragma: it can only live in the root shell.qml, and it
// sets the Wayland app-id (the window class Hyprland sees) for this process. The
// chat HUD is the one toplevel window here, so this is what makes it show up as
// `class: ghost` in `hyprctl clients` and lets a user write windowrules against
// it. The bar/tray surfaces are layer/SNI and ignore the app-id.
//@ pragma AppId ghost
import Quickshell
import Quickshell.Io
import QtQuick
import qs.services

ShellRoot {
    id: shell

    GhostHud {
        id: hud
    }

    // System-tray presence (StatusNotifierItem). Runs a helper process for the
    // one thing Quickshell 0.3.0 cannot do itself — expose an SNI item over
    // D-Bus — and routes its clicks back into the same HUD this shell owns.
    TrayBridge {
        hud: hud
    }

    // Opt-in fallback strip; see GhostBarSurface.qml for why it is not default.
    LazyLoader {
        id: barLoader
        active: Boolean(Quickshell.env("GHOST_BAR_SURFACE"))

        GhostBarSurface {
            onActivated: hud.toggle()
        }
    }

    // ---- IPC ------------------------------------------------------------
    // `qs -c ghost ipc call ghost toggle`
    //
    // IpcHandler reflects over *typed* members only — an untyped function is
    // silently skipped — and the argument/return types are limited to string,
    // int, bool, real and color. Hence `: void` and `: string` everywhere.
    //
    // Naming rule learned the hard way: an IPC function must not share a name
    // with a `qs` or `qs ipc` subcommand. CLI11 lets subcommands fall through
    // positional arguments, so `qs ipc call ghost show` silently ran `qs ipc
    // show` and printed this listing instead of opening the HUD. Avoid
    // show/call/wait/listen/prop/log/list/kill/ipc/msg — hence open/close.
    IpcHandler {
        target: "ghost"

        function toggle(): void {
            hud.toggle();
        }

        function open(): void {
            hud.open();
        }

        function close(): void {
            hud.close();
        }

        /** Summon the HUD already pointed at a particular ghost. */
        function summon(name: string): void {
            if (name !== "") Ghostd.selectGhost(name);
            hud.open();
        }

        /** Send a prompt without opening the HUD; the reply arrives as a notification. */
        function ask(prompt: string): void {
            Ghostd.send(prompt);
        }

        /** Open the HUD on the "Connect a model" panel for the active ghost. */
        function login(): void {
            hud.open();
            hud.openLogin();
        }

        /** Open the HUD on the model switcher for the active ghost. */
        function switcher(): void {
            hud.open();
            hud.openSwitcher();
        }

        /** Open the panel and begin a specific login straight away. */
        function loginTo(provider: string, authType: string): void {
            hud.open();
            hud.openLogin();
            if (provider !== "") Ghostd.startLogin(provider, authType === "" ? "oauth" : authType);
        }

        function status(): string {
            return JSON.stringify({
                ghost: Ghostd.activeGhost,
                shown: hud.shown,
                streaming: Ghostd.streaming,
                reachable: Ghostd.reachable,
                activity: Ghostd.activity,
                error: Ghostd.lastError
            });
        }

        function refresh(): void {
            Ghostd.refresh();
            Theme.reload();
        }
    }

    // ---- Notifications ----------------------------------------------------
    // Only when the HUD is shut. If the user is looking at the stream, a
    // toast saying what they just watched arrive is noise.
    Connections {
        target: Ghostd

        function onTurnFinished(ghost: string, text: string): void {
            if (!hud.shown) Notifier.turnFinished(ghost, text);
        }

        function onTurnFailed(ghost: string, message: string): void {
            if (!hud.shown) Notifier.turnFailed(ghost, message);
        }
    }

    // ghostd may well start after the shell does (both are user units with no
    // ordering between them). Retry the roster until it answers, then stop.
    Timer {
        interval: 4000
        running: !Ghostd.reachable
        repeat: true
        onTriggered: Ghostd.refresh()
    }
}
