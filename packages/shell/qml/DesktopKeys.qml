// DesktopKeys — Ghost's shortcuts, asked of Hyprland at runtime.
//
// Two things a keyboard needs from the compositor, which the plugin sets up
// itself so that every install has them and no config file is edited:
//
//   summon key   SUPER+CTRL+G toggles the presence, bound with `hyprctl eval`
//                when no bind of the owner's holds it (one already bound to
//                this plugin, from the contrib snippet, counts as ours).
//                Re-made after every Hyprland config reload, which drops
//                runtime binds; withdrawn when the plugin unloads.
//   key mode     While the summon prompt or the HUD holds the keyboard,
//                Hyprland runs the "ghost" submap: its close shortcuts close
//                Ghost instead of the window underneath, and the rest wait.
//                Hyprland's own hook resets it once no modal Ghost layer is
//                mapped, so a crashed shell never strands the owner's keys.
//
// Mounted by Service.qml, the half of the plugin that is always loaded.
import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import "services"
import "services/Plugin.js" as Plugin
import "services/DesktopKeys.js" as Keys

Item {
    id: root

    /** The summon key's last known state: "", "free", "ours", or "taken". */
    property string summonKey: ""
    /** This plugin bound the summon key, so it unbinds it on the way out. */
    property bool boundSummon: false

    /** An overlay holds the keyboard. */
    readonly property bool modal: Presence.composing || Ghostd.hudVisible

    onModalChanged: Hyprland.dispatch(Keys.submapDispatch(root.modal))

    Component.onCompleted: root.setUp()
    Component.onDestruction: {
        if (root.modal) Hyprland.dispatch(Keys.submapDispatch(false));
        if (root.boundSummon) root.evaluate(Keys.summonUnbindLua());
    }

    function setUp(): void {
        root.evaluate(Keys.submapLua(Plugin.ID));
        if (!bindsProbe.running) bindsProbe.running = true;
    }

    /** Run Lua in the compositor, detached: nothing waits on it. */
    function evaluate(lua: string): void {
        Quickshell.execDetached(["hyprctl", "eval", lua]);
    }

    function claim(state: string): void {
        root.summonKey = state;
        if (state === "free") {
            root.evaluate(Keys.summonBindLua(Plugin.ID));
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
                root.claim(Keys.summonKeyState(binds, Plugin.ID));
            }
        }
    }

    // A config reload drops every runtime bind and submap: make them again.
    Connections {
        target: Hyprland
        function onRawEvent(event: var): void {
            if (event.name !== "configreloaded") return;
            root.boundSummon = false;
            root.setUp();
            if (root.modal) Hyprland.dispatch(Keys.submapDispatch(true));
        }
    }
}
