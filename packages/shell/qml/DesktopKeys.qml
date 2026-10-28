// DesktopKeys — what Ghost asks of Hyprland at runtime, so every install has
// it and no config file is edited:
//
//   summon key     SUPER+CTRL+G toggles the presence, bound with `hyprctl eval`
//                  when no bind of the owner's holds it (one already bound to
//                  this plugin, from the contrib snippet, counts as ours).
//                  Withdrawn when the plugin unloads.
//   window rules   The HUD and the presence prompt are ordinary windows that
//                  Hyprland floats, pins, sizes to their monitor and leaves
//                  undecorated. Being the focused window is what makes SUPER+W
//                  close Ghost rather than the app behind it, while every
//                  other shortcut keeps working.
//
// A Hyprland config reload drops runtime binds and rules; both are made again.
// Mounted by Service.qml, the half of the plugin that is always loaded.
import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import "services/Plugin.js" as Plugin
import "services/DesktopKeys.js" as Desk

Item {
    id: root

    /** The summon key's last known state: "", "free", "ours", or "taken". */
    property string summonKey: ""
    /** This plugin bound the summon key, so it unbinds it on the way out. */
    property bool boundSummon: false

    Component.onCompleted: root.setUp()
    Component.onDestruction: if (root.boundSummon) root.evaluate(Desk.summonUnbindLua())

    function setUp(): void {
        root.evaluate(Desk.windowRulesLua());
        if (!bindsProbe.running) bindsProbe.running = true;
    }

    /** Run Lua in the compositor, detached: nothing waits on it. */
    function evaluate(lua: string): void {
        Quickshell.execDetached(["hyprctl", "eval", lua]);
    }

    function claim(state: string): void {
        root.summonKey = state;
        if (state === "free") {
            root.evaluate(Desk.summonBindLua(Plugin.ID));
            root.boundSummon = true;
        } else if (state === "taken") {
            console.info("ghost: SUPER+CTRL+G is bound to something else; summon with `omarchy-shell shell toggle "
                + Plugin.ID + "` or bind another key (contrib/hyprland)");
        }
    }

    // `hyprctl binds -j` is several lines of JSON; joined into one, it is one read.
    Process {
        id: bindsProbe
        command: ["sh", "-c", "hyprctl binds -j | tr -d '\\n'"]
        stdout: SplitParser {
            onRead: data => {
                let binds = [];
                try {
                    binds = JSON.parse(data);
                } catch (error) {
                    console.warn("ghost: unreadable `hyprctl binds -j`; leaving the summon key alone");
                    return;
                }
                root.claim(Desk.summonKeyState(binds, Plugin.ID));
            }
        }
    }

    Connections {
        target: Hyprland
        function onRawEvent(event: var): void {
            if (event.name !== "configreloaded") return;
            root.boundSummon = false;
            root.setUp();
        }
    }
}
