pragma ComponentBehavior: Bound

// The fixed context rail: one quiet, full-height edge shared by chat, the
// ghost's home, and runtime capabilities. The host owns routing; this component
// owns only selection, keyboard traversal, and the active/hover treatment.
import QtQuick
import QtQuick.Shapes
import "../services"

FocusScope {
    id: root

    property string currentSection: "chat"
    property int activeHookCount: 0

    signal selected(string section)

    readonly property var destinations: [
        {
            id: "chat",
            label: "Chat",
            icon: "M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"
        },
        {
            id: "board",
            label: "Board",
            icon: "M9 6h12M9 12h12M9 18h12M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"
        },
        {
            id: "character",
            label: "Character",
            icon: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM16 9h3M16 13h3M10 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4M6 17a4 4 0 0 1 8 0"
        },
        {
            id: "commands",
            label: "Commands",
            icon: "M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM6 9l4 3-4 3M12 15h4"
        },
        {
            id: "hooks",
            label: root.activeHookCount > 0
                ? "Hooks · " + root.activeHookCount + " loaded" : "Hooks",
            icon: "M8 12h8M12 8v8M7 3v4M17 3v4M7 17v4M17 17v4M3 7h4M17 7h4M3 17h4M17 17h4M7 7h10v10H7z"
        },
        {
            id: "mcp",
            label: "MCP",
            icon: "M12 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM5 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 7v5M7.5 17.5l3-5M16.5 17.5l-3-5"
        },
        {
            id: "remote",
            label: "Remote access",
            icon: "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM10 5h4M11 18h2"
        }
    ]
    readonly property real destinationHeight: Math.max(34, Math.min(
        Theme.controlHeight + Theme.gap,
        (root.height - Theme.pad - (root.destinations.length - 1) * Theme.gap / 2)
            / root.destinations.length
    ))

    implicitWidth: 64
    implicitHeight: Theme.pad * 30
    clip: false
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
                readonly property color glyphColor: destinationButton.active
                    ? Theme.ghostAmberBright
                    : (pointer.containsMouse ? Theme.foreground : Theme.foregroundDim)

                width: Theme.controlHeight + Theme.gap
                height: root.destinationHeight
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


                Shape {
                    anchors.centerIn: parent
                    width: 24
                    height: 24
                    antialiasing: true

                    ShapePath {
                        strokeColor: destinationButton.glyphColor
                        fillColor: "transparent"
                        strokeWidth: 1.8
                        capStyle: ShapePath.RoundCap
                        joinStyle: ShapePath.RoundJoin

                        PathSvg {
                            path: destinationButton.destination.icon
                        }
                    }
                }

                Rectangle {
                    visible: destinationButton.destination.id === "hooks"
                        && root.activeHookCount > 0
                    anchors.right: parent.right
                    anchors.rightMargin: 3
                    anchors.top: parent.top
                    anchors.topMargin: 3
                    width: Math.max(14, hookCount.implicitWidth + 6)
                    height: 14
                    radius: 7
                    color: Theme.ghostAmberBright

                    Text {
                        id: hookCount
                        anchors.centerIn: parent
                        text: String(root.activeHookCount)
                        textFormat: Text.PlainText
                        color: Theme.background
                        font.family: Theme.fontFamily
                        font.pixelSize: 9
                        font.weight: Font.Bold
                    }
                }

                Rectangle {
                    id: tooltip

                    anchors.right: parent.left
                    anchors.rightMargin: Theme.gap
                    anchors.verticalCenter: parent.verticalCenter
                    z: 20
                    width: tooltipLabel.implicitWidth + Theme.pad * 1.5
                    height: Theme.controlHeight - Theme.gap / 2
                    radius: Theme.radius / 2
                    color: Theme.surfaceDeep
                    border.width: 1
                    border.color: Theme.borderStrong
                    opacity: pointer.containsMouse ? 1 : 0
                    visible: opacity > 0

                    Behavior on opacity {
                        enabled: !Theme.reducedMotion
                        NumberAnimation { duration: Theme.durFast }
                    }

                    Text {
                        id: tooltipLabel
                        anchors.centerIn: parent
                        text: destinationButton.destination.label
                        textFormat: Text.PlainText
                        color: Theme.foregroundBright
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
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
