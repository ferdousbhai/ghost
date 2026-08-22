// Ghost indicator for Omarchy's bar — install at
// ~/.config/omarchy/bar/modules/ghost.qml and add
// { "id": "ghost", "type": "qml" } to a bar.layout section in
// ~/.config/omarchy/shell.json.
//
// This file runs inside the omarchy-shell PROCESS, not ours. It therefore
// cannot see @ghost/shell's Ghostd or Theme singletons, and must not import
// qs.Commons / qs.Ui either — those resolve only inside Omarchy's own module
// tree and would make this file unlintable and version-fragile. Everything it
// needs arrives through the injected `bar` object, and the ghost state comes
// back over the shell's own IPC.
//
// Polling rather than streaming is deliberate: a bar dot does not need
// per-token fidelity, and a persistent SSE connection opened from inside the
// user's whole desktop shell is a much bigger thing to get wrong than a
// 2-second subprocess.
import QtQuick
import Quickshell.Io

Item {
    id: root

    // Injected by Bar.qml after load.
    property var bar
    property string moduleName: "ghost"
    property var settings

    property bool reachable: false
    property bool streaming: false
    property string ghost: ""
    property string activity: ""

    readonly property color fg: root.bar ? root.bar.foreground : "#a9b1d6"
    readonly property color urgent: root.bar ? root.bar.urgent : "#f7768e"

    implicitWidth: row.implicitWidth + 8
    implicitHeight: root.bar ? root.bar.barSize : 26

    Row {
        id: row
        anchors.centerIn: parent
        spacing: 6

        Rectangle {
            anchors.verticalCenter: parent.verticalCenter
            width: 8
            height: 8
            radius: 4
            color: !root.reachable ? root.urgent : root.fg
            opacity: root.streaming ? 1.0 : 0.45

            SequentialAnimation on opacity {
                running: root.streaming
                loops: Animation.Infinite
                NumberAnimation { to: 0.3; duration: 650; easing.type: Easing.InOutQuad }
                NumberAnimation { to: 1.0; duration: 650; easing.type: Easing.InOutQuad }
            }
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            visible: !(root.bar && root.bar.vertical)
            text: root.ghost === "" ? "ghost" : root.ghost
            color: root.fg
            font.family: root.bar ? root.bar.fontFamily : "monospace"
            font.pixelSize: 12
        }
    }

    MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        onClicked: if (root.bar) root.bar.run("qs -c ghost ipc call ghost toggle")
        onEntered: if (root.bar) root.bar.showTooltip(root, root.tooltip())
        onExited: if (root.bar) root.bar.hideTooltip(root)
    }

    function tooltip(): string {
        if (!root.reachable) return "ghost shell not running";
        if (root.streaming) return (root.ghost || "ghost") + " — " + (root.activity || "thinking");
        return (root.ghost || "no ghost") + " — idle";
    }

    Timer {
        interval: 2000
        running: true
        repeat: true
        triggeredOnStart: true
        onTriggered: if (!poll.running) poll.running = true
    }

    Process {
        id: poll
        command: ["qs", "-c", "ghost", "ipc", "call", "ghost", "status"]

        // A failed `qs ipc call` (shell not running) exits non-zero with an
        // empty stdout, so the empty-text branch covers it. onExited is
        // deliberately not handled: its QProcess::ExitStatus parameter has no
        // QML type export, which makes the handler uncompilable and noisy
        // under qmllint for no information we do not already have here.
        stdout: StdioCollector {
            onStreamFinished: {
                try {
                    const status = JSON.parse(this.text.trim());
                    root.reachable = true;
                    root.ghost = status.ghost || "";
                    root.streaming = Boolean(status.streaming);
                    root.activity = status.activity || "";
                } catch (error) {
                    root.reachable = false;
                    root.streaming = false;
                }
            }
        }
    }
}
