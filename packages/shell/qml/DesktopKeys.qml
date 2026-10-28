// DesktopKeys — what Ghost asks of Hyprland at runtime, so every install has
// it and no config file is edited:
//
//   summon key     SUPER+CTRL+G toggles the presence, bound with `hyprctl eval`
//                  when nothing else holds it. The owner's own bind for Ghost
//                  (the contrib snippet) and anyone else's are left alone.
//   window rules   The HUD and the presence prompt are ordinary windows that
//                  Hyprland floats, pins, sizes to their monitor and leaves
//                  undecorated. Being the focused window is what makes SUPER+W
//                  close Ghost rather than the app behind it, while every
//                  other shortcut keeps working.
//
// Both are withdrawn when the plugin unloads, and made again after a Hyprland
// config reload, which drops them. `summonKey` says who holds the key; the
// `ghost status` IPC reports it.
// Mounted by Service.qml, the half of the plugin that is always loaded.
import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import "services/Plugin.js" as Plugin
import "services/DesktopKeys.js" as Desk

Item {
    id: root

    /** Who holds the summon key: "" until read, then "shell" (this shell bound it), "owner", or "taken". */
    property string summonKey: ""
    /** This shell bound the summon key, so it unbinds it on the way out. */
    property bool boundSummon: false
    /** Marks this shell's setup in the compositor; see Desk.setUpLua. */
    readonly property string token: Plugin.ID + ":" + Date.now() + ":" + Math.floor(Math.random() * 1e9)
    /** A config reload arrived while the binds were being read. */
    property bool reprobe: false
    property var pending: []

    Component.onCompleted: root.setUp()
    // Detached: this item, and any Process it owns, is going away. Whatever is
    // still queued goes first, in the same chunk, so the withdrawal lands last.
    Component.onDestruction: Quickshell.execDetached(["hyprctl", "eval",
        root.pending.concat([Desk.withdrawLua(root.token, root.boundSummon)]).join("; ")])

    function setUp(): void {
        root.evaluate(Desk.setUpLua(root.token));
        if (bindsProbe.running) root.reprobe = true;
        else bindsProbe.running = true;
    }

    /** Run Lua in the compositor, one chunk at a time, in order. */
    function evaluate(lua: string): void {
        root.pending = root.pending.concat([lua]);
        if (!evaluator.running) root.next();
    }

    function next(): void {
        if (evaluator.running || root.pending.length === 0) return;
        evaluator.command = ["hyprctl", "eval", root.pending[0]];
        root.pending = root.pending.slice(1);
        evaluator.running = true;
    }

    function claim(state: string): void {
        root.boundSummon = state === "free" || state === "shell";
        root.summonKey = root.boundSummon ? "shell" : state;
        if (root.boundSummon) root.evaluate(Desk.summonBindLua(Plugin.ID));
        else if (state === "taken")
            console.info("ghost: SUPER+CTRL+G is bound to something else; summon with `omarchy-shell shell toggle "
                + Plugin.ID + "` or bind another key (contrib/hyprland)");
    }

    // `hyprctl eval` answers "ok", or why it refused the chunk.
    Process {
        id: evaluator
        objectName: "evaluator"
        stdout: StdioCollector {
            onStreamFinished: if (text.trim() !== "ok") console.warn("ghost: hyprctl eval refused Ghost's setup: " + text.trim())
        }
        // Once this exit has settled, as the probe's restart below.
        onExited: Qt.callLater(root.next)
    }

    Process {
        id: bindsProbe
        objectName: "bindsProbe"
        command: ["hyprctl", "binds", "-j"]
        stdout: StdioCollector {
            onStreamFinished: {
                let binds = null;
                try {
                    binds = JSON.parse(text);
                } catch (error) {
                    console.warn("ghost: unreadable `hyprctl binds -j`; leaving the summon key alone");
                }
                if (binds !== null && !root.reprobe) root.claim(Desk.summonKeyState(binds, Plugin.ID));
            }
        }
        // Restarted once this exit has settled; `running` is still set inside it.
        onExited: if (root.reprobe) {
            root.reprobe = false;
            Qt.callLater(() => bindsProbe.running = true);
        }
    }

    Connections {
        target: Hyprland
        function onRawEvent(event: var): void {
            if (event.name !== "configreloaded") return;
            // The reload dropped everything; what was queued for before it is
            // stale (a bind could replace one the owner just added).
            root.pending = [];
            root.boundSummon = false;
            root.setUp();
        }
    }
}
