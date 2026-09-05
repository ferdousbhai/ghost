pragma Singleton

// Dictation — Omarchy's Voxtype, driven from the composer.
//
// Ghost ships no speech stack. Omarchy installs Voxtype on request (Install →
// AI → Dictation), runs it as a user service, and binds F9 push-to-talk and
// Super+Ctrl+X toggle in Hyprland; whatever it hears is typed into the focused
// window, which is the composer when the HUD has the keyboard. All this
// service adds is a way to toggle it without leaving the mouse and a mirror of
// its state file, so the composer can say it is listening. No state file means
// no Voxtype, and the composer shows nothing.
import Quickshell
import Quickshell.Io
import QtQuick
import "DictationState.js" as DictationState

Singleton {
    id: root

    /** "idle", "recording", "transcribing", or "" when Voxtype is not running. */
    property string state: ""
    readonly property bool available: root.state !== ""
    readonly property bool recording: root.state === "recording"
    readonly property string label: DictationState.label(root.state)

    readonly property string statePath: {
        const runtime = Quickshell.env("XDG_RUNTIME_DIR");
        return runtime ? runtime + "/voxtype/state" : "";
    }

    /** Re-read the state file; the HUD calls this when it opens, so an install made while it was closed shows up. */
    function refresh(): void {
        if (root.statePath === "") return;
        stateFile.reload();
    }

    function toggle(): void {
        if (!root.available) return;
        Quickshell.execDetached(["voxtype", "record", "toggle"]);
    }

    FileView {
        id: stateFile
        path: root.statePath
        blockLoading: true
        watchChanges: true
        printErrors: false
        onLoaded: root.state = DictationState.parse(stateFile.text())
        onLoadFailed: root.state = ""
        onFileChanged: stateFile.reload()
    }
}
