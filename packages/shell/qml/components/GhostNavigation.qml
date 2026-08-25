pragma ComponentBehavior: Bound

// The fixed context rail: one quiet, full-height edge shared by chat and the
// the ghost's home and OMP capabilities. The host owns routing; this component owns only
// selection, keyboard traversal, and the active/hover treatment.
import QtQuick
import qs.services

FocusScope {
    id: root

    /** The route currently shown by the host. */
    property string currentSection: "chat"

    /** A destination was chosen by pointer or keyboard. */
    signal selected(string section)

    readonly property var destinations: [
        { id: "chat", label: "Chat", mark: "C" },
        { id: "docs", label: "Docs", mark: "D" },
        { id: "memory", label: "Memory", mark: "M" },
        { id: "agents", label: "Wisps", mark: "W" },
        { id: "commands", label: "Commands", mark: "/" },
        { id: "character", label: "Character", mark: "ID" }
    ]

    implicitWidth: 64
    implicitHeight: Theme.pad * 30
    clip: true
    activeFocusOnTab: true

    function activate(index: int): void {
        const destination = root.destinations[index];
        if (!destination) return;
        root.selected(destination.id);
    }

    function moveFocus(from: int, delta: int): void {
        const count = root.destinations.length;
        const next = (from + delta + count) % count;
        const item = navItems.itemAt(next);
        if (item) item.forceActiveFocus();
    }

    Rectangle {
        anchors.fill: parent
        color: Theme.surface

        Rectangle {
            anchors.left: parent.left
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            width: 1
            color: Theme.border
        }
    }

    Column {
        anchors.centerIn: parent
        spacing: Theme.gap / 2

        Repeater {
            id: navItems
            model: root.destinations

            Rectangle {
                id: destinationButton

                required property var modelData
                required property int index
                readonly property var destination: destinationButton.modelData
                readonly property bool active:
                    root.currentSection === destinationButton.destination.id

                width: Theme.controlHeight + Theme.gap
                height: Theme.controlHeight + Theme.gap
                radius: Theme.radius
                color: destinationButton.active
                    ? Theme.amber(0.14)
                    : (pointer.containsMouse ? Theme.film(0.05) : "transparent")
                border.width: destinationButton.activeFocus ? 1 : 0
                border.color: Theme.amber(0.55)
                focus: destinationButton.active
                scale: destinationButton.active ? 1.04 : 1

                Accessible.role: Accessible.Button
                Accessible.name: destinationButton.destination.label
                Accessible.description: destinationButton.active
                    ? "Current destination" : "Open " + destinationButton.destination.label

                Behavior on color {
                    enabled: !Theme.reducedMotion
                    ColorAnimation { duration: Theme.durFast }
                }

                Behavior on scale {
                    enabled: !Theme.reducedMotion
                    NumberAnimation {
                        duration: Theme.durFast
                        easing.type: Easing.OutCubic
                    }
                }

                // A soft film rather than a graphical blur: it preserves the
                // precursor's amber halo without adding an effects dependency.
                Rectangle {
                    anchors.fill: parent
                    anchors.margins: -Theme.gap / 2
                    z: -1
                    radius: Theme.radius
                    visible: destinationButton.active
                    color: Theme.amber(0.06)
                }

                Column {
                    anchors.centerIn: parent
                    spacing: 0

                    Text {
                        anchors.horizontalCenter: parent.horizontalCenter
                        text: destinationButton.destination.mark
                        color: destinationButton.active
                            ? Theme.ghostAmberBright
                            : (pointer.containsMouse ? Theme.foreground : Theme.foregroundDim)
                        font.family: Theme.fontFamilyMono
                        font.pixelSize: Theme.fontSizeSmall
                        font.weight: Font.DemiBold
                    }

                    Text {
                        anchors.horizontalCenter: parent.horizontalCenter
                        text: destinationButton.destination.label === "Character"
                            ? "Char" : destinationButton.destination.label
                        color: destinationButton.active
                            ? Theme.ghostAmber
                            : Theme.foregroundFaint
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall - 3
                    }
                }

                MouseArea {
                    id: pointer
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        destinationButton.forceActiveFocus();
                        root.activate(destinationButton.index);
                    }
                }

                Keys.onPressed: event => {
                    if (event.key === Qt.Key_Up || event.key === Qt.Key_Left) {
                        root.moveFocus(destinationButton.index, -1);
                        event.accepted = true;
                    } else if (event.key === Qt.Key_Down || event.key === Qt.Key_Right) {
                        root.moveFocus(destinationButton.index, 1);
                        event.accepted = true;
                    } else if (event.key === Qt.Key_Home) {
                        const first = navItems.itemAt(0);
                        if (first) first.forceActiveFocus();
                        event.accepted = true;
                    } else if (event.key === Qt.Key_End) {
                        const last = navItems.itemAt(root.destinations.length - 1);
                        if (last) last.forceActiveFocus();
                        event.accepted = true;
                    } else if (event.key === Qt.Key_Return
                            || event.key === Qt.Key_Enter
                            || event.key === Qt.Key_Space) {
                        root.activate(destinationButton.index);
                        event.accepted = true;
                    }
                }
            }
        }
    }
}
