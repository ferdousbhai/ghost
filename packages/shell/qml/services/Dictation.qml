pragma Singleton

// Dictation — Omarchy's Voxtype, driven from the composer.
//
// Ghost ships no speech stack. Omarchy installs Voxtype on request (Install →
// AI → Dictation), runs it as a user service, and binds F9 push-to-talk and
// Super+Ctrl+X toggle in Hyprland; whatever it hears is typed into the focused
// window, which is the composer when the HUD has the keyboard. All this
// service adds is start, stop, and cancel without leaving the composer, a
// mirror of its state file, so the composer can say it is listening, and the
// failure of a `voxtype record` command it ran. Voxtype reports no failed
// transcription, so neither does this. No state file means no Voxtype, and
// the composer shows nothing.
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
    /** The mic can start or stop; never while it transcribes. */
    readonly property bool toggleable: DictationState.micAction(root.state) !== ""
    readonly property bool cancellable: DictationState.cancellable(root.state)
    /** Why the last `voxtype record` command failed; cleared by the next attempt. */
    property string failure: ""
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

    /** Start when idle, stop when recording; nothing while it transcribes. */
    function toggle(): void {
        root.run(DictationState.micAction(root.state));
    }

    /** Discard the recording or transcription in progress, typing nothing. */
    function cancel(): void {
        if (root.cancellable) root.run("cancel");
    }

    function run(action: string): void {
        if (action === "" || recordCommand.running) return;
        root.failure = "";
        recordCommand.action = action;
        recordCommand.didStart = false;
        recordCommand.command = DictationState.command(action);
        recordCommand.running = true;
    }

    Process {
        id: recordCommand
        objectName: "dictationCommand"

        property string action: ""
        property bool didStart: false

        onStarted: recordCommand.didStart = true
        onExited: (exitCode, exitStatus) => {
            root.failure = DictationState.failure(recordCommand.action, exitCode, exitStatus);
        }
        onRunningChanged: {
            if (!recordCommand.running && !recordCommand.didStart)
                root.failure = DictationState.failure(recordCommand.action, -1, 0);
        }
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
