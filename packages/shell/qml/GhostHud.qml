pragma ComponentBehavior: Bound

// GhostHud — the summonable overlay. Toggled from a Hyprland keybind through
// Quickshell IPC (see contrib/hyprland/ghost.conf), not by clicking anything.
//
// Surface shape decisions:
//
//   layer: Overlay        it must land above fullscreen windows, because the
//                         point is to reach your ghost from wherever you are.
//   anchors { top }       anchored on one edge only, so the compositor centres
//                         it horizontally. Deliberately NOT a fullscreen scrim:
//                         a HUD that swallows every click on the desktop is a
//                         modal dialog wearing a HUD's clothes.
//   exclusionMode: Ignore an overlay must never reserve screen area or it
//                         would shove every tiled window sideways on summon.
//   keyboardFocus: OnDemand + HyprlandFocusGrab
//                         Exclusive would take the keyboard away from the
//                         compositor too, so SUPER+G could not toggle the HUD
//                         back off. OnDemand plus an explicit focus grab gives
//                         us the keyboard AND click-outside-to-dismiss, while
//                         leaving compositor binds alive. This is the same
//                         pattern Quickshell launchers use on Hyprland.
import Quickshell
import Quickshell.Wayland
import Quickshell.Hyprland
import QtQuick
import QtQuick.Layouts
import qs.services
import qs.components

PanelWindow {
    id: hud

    /** Driven by IPC; see the IpcHandler in shell.qml. */
    property bool shown: false
    property bool rosterOpen: true
    /** The "Connect a model" panel replaces the transcript body when open. */
    property bool loginOpen: false

    visible: hud.shown

    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.namespace: "ghost-hud"
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.OnDemand

    anchors.top: true
    margins.top: 64
    exclusionMode: ExclusionMode.Ignore
    focusable: true
    color: "transparent"

    implicitWidth: 880
    implicitHeight: 620

    function open(): void {
        hud.shown = true;
        hud.loginOpen = false;
        Ghostd.refresh();
        composer.take();
    }

    function close(): void {
        hud.shown = false;
    }

    function openLogin(): void {
        hud.loginOpen = true;
        modelLogin.open();
    }

    function toggle(): void {
        if (hud.shown) hud.close();
        else hud.open();
    }

    // Clicking anywhere outside the grabbed window dismisses. On a compositor
    // without Hyprland's focus-grab protocol this simply never activates and
    // the HUD stays until Esc — degraded, not broken.
    HyprlandFocusGrab {
        active: hud.shown
        windows: [hud]
        onCleared: hud.close()
    }

    Rectangle {
        id: card

        anchors.fill: parent
        radius: Theme.radius * 1.6
        color: Theme.background
        border.width: 1
        border.color: Theme.muted

        focus: true
        Keys.onEscapePressed: event => {
            if (Ghostd.streaming) Ghostd.cancel();
            else hud.close();
            event.accepted = true;
        }

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: Theme.pad
            spacing: Theme.gap

            // ---- Header ---------------------------------------------------
            Item {
                Layout.fillWidth: true
                implicitHeight: 26

                Row {
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Theme.gap

                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        text: "◉"
                        color: Ghostd.reachable ? Theme.accent : Theme.danger
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize + 3
                    }

                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        text: Ghostd.activeGhost === "" ? "ghost" : Ghostd.activeGhost
                        color: Theme.foregroundBright
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize + 1
                        font.bold: true
                    }
                }

                Row {
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Theme.pad

                    Text {
                        id: connectModel
                        anchors.verticalCenter: parent.verticalCenter
                        visible: Ghostd.activeGhost !== ""
                        text: hud.loginOpen ? "back to chat" : "connect a model"
                        color: hud.loginOpen ? Theme.accent : Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall

                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                if (hud.loginOpen) hud.loginOpen = false;
                                else hud.openLogin();
                            }
                        }
                    }

                    Text {
                        id: rosterToggle
                        anchors.verticalCenter: parent.verticalCenter
                        text: hud.rosterOpen ? "hide roster" : "show roster"
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall

                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: hud.rosterOpen = !hud.rosterOpen
                        }
                    }

                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        text: "esc"
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                    }
                }
            }

            Rectangle {
                Layout.fillWidth: true
                implicitHeight: 1
                color: Theme.muted
            }

            // ---- Body -----------------------------------------------------
            RowLayout {
                visible: !hud.loginOpen
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: Theme.pad

                Roster {
                    id: roster
                    visible: hud.rosterOpen
                    Layout.preferredWidth: implicitWidth
                    Layout.fillHeight: true
                    onPicked: {
                        hud.loginOpen = false;
                        composer.take();
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    spacing: Theme.gap

                    ListView {
                        id: transcriptView

                        // Follow the stream, but only while the user is already
                        // at the bottom — yanking the view back down while they
                        // read earlier text is worse than falling behind.
                        property bool pinned: true

                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true
                        spacing: Theme.gap
                        model: Ghostd.transcript
                        cacheBuffer: 400

                        delegate: Bubble {
                            // One required property per ListModel role. qmllint
                            // cannot introspect a dynamically-filled ListModel,
                            // so it reports these as unbound — see dev/README.md
                            // for the expected-warning list.
                            required property string role
                            required property string text
                            required property string tools
                            required property string error
                            required property bool pending

                            width: transcriptView.width
                            speaker: role
                            body: text
                            toolTrail: tools
                            failure: error
                            busy: pending
                        }

                        onContentYChanged: pinned = contentY >= contentHeight - height - 40
                        onCountChanged: if (pinned) positionViewAtEnd()
                        onContentHeightChanged: if (pinned) positionViewAtEnd()

                        Text {
                            anchors.centerIn: parent
                            visible: transcriptView.count === 0
                            width: transcriptView.width * 0.7
                            horizontalAlignment: Text.AlignHCenter
                            text: Ghostd.reachable
                                ? "Nothing said yet."
                                : "ghostd is not answering on " + Ghostd.baseUrl
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                            wrapMode: Text.Wrap
                        }
                    }

                    ActivityLine {
                        Layout.fillWidth: true
                    }

                    Composer {
                        id: composer
                        Layout.fillWidth: true
                        onSubmitted: prompt => Ghostd.send(prompt)
                    }
                }
            }

            // "Connect a model": swaps in over the transcript body.
            ModelLogin {
                id: modelLogin
                visible: hud.loginOpen
                Layout.fillWidth: true
                Layout.fillHeight: true
                onCloseRequested: hud.loginOpen = false
            }
        }
    }
}
