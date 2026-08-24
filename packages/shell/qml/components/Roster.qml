pragma ComponentBehavior: Bound

// The ghost roster: who exists, who the HUD is talking to, and ways to summon a
// new one or banish an old one. Names come from GET /api/ghosts; creating posts
// back, deleting sends a DELETE the typed name has to confirm.
import QtQuick
import qs.services

Item {
    id: root

    /** Emitted after a ghost is picked, so the HUD can return focus to the composer. */
    signal picked()

    property bool naming: false

    /** The one row armed for deletion, or "". Deleting a ghost erases a home
        directory, so unlike every other row action it is never one click: the
        armed row asks for the name back before the Delete action does anything. */
    property string confirmingGhost: ""

    /** Put the roster back to rest. Called on Esc, on any other click that
        lands in the list, and whenever the active ghost changes. */
    function disarm(): void {
        root.confirmingGhost = "";
        Ghostd.ghostDeleteError = "";
    }

    // Switching ghosts is a different intent than deleting one; a strip armed
    // for the row left behind would be a loaded gun on somebody else's name.
    Connections {
        target: Ghostd
        function onActiveGhostChanged(): void {
            root.disarm();
        }

        // A name that is no longer in the listing (deleted here or elsewhere)
        // has no row left to arm.
        function onGhostsChanged(): void {
            if (root.confirmingGhost === "") return;
            const alive = Ghostd.ghosts.some(function (ghost) {
                return ghost.name === root.confirmingGhost;
            });
            if (!alive) root.disarm();
        }
    }

    // Names that have already made their entrance. Ghostd.ghosts is replaced
    // wholesale on every poll, which rebuilds every delegate; without this the
    // roster would re-emerge on each refresh.
    property var summoned: ({})

    implicitWidth: 190
    implicitHeight: column.implicitHeight

    Column {
        id: column
        width: root.width
        spacing: Theme.gap

        Item {
            width: root.width
            height: summonButton.height

            Text {
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                text: "Ghosts"
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall - 1
                font.weight: Font.DemiBold
                font.capitalization: Font.AllUppercase
                font.letterSpacing: 1
            }

            // Summoning is rare, so it lives in the header corner the way
            // Notes tucks away New Folder: faint at rest, amber on hover, and
            // the naming row below only exists while a name is being typed.
            // A second click while naming cancels, like Escape.
            Rectangle {
                id: summonButton
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                width: 18
                height: 18
                radius: Theme.radius / 2
                color: summonArea.containsMouse ? Theme.amber(0.15) : "transparent"

                Behavior on color {
                    enabled: !Theme.reducedMotion
                    ColorAnimation { duration: Theme.durFast }
                }

                Text {
                    anchors.centerIn: parent
                    text: "+"
                    color: summonArea.containsMouse || root.naming
                        ? Theme.ghostAmberBright
                        : Theme.foregroundFaint
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                }

                MouseArea {
                    id: summonArea
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        root.disarm();
                        if (root.naming) {
                            nameField.text = "";
                            root.naming = false;
                            root.picked();
                        } else {
                            root.naming = true;
                            nameField.forceActiveFocus();
                        }
                    }
                }
            }
        }

        Repeater {
            model: Ghostd.ghosts

            Rectangle {
                id: entry

                required property var modelData
                required property int index

                readonly property bool active: entry.modelData.name === Ghostd.activeGhost
                readonly property bool armed: root.confirmingGhost === entry.modelData.name
                readonly property bool deleting: Ghostd.deletingGhost === entry.modelData.name
                /** The typed name matches byte for byte — what the daemon demands. */
                readonly property bool confirmed: confirmField.text === entry.modelData.name

                width: root.width
                height: layout.implicitHeight
                radius: Theme.radius / 2
                color: entry.active ? Theme.film(0.10)
                    : (entryArea.containsMouse ? Theme.film(0.06) : "transparent")

                Behavior on color {
                    enabled: !Theme.reducedMotion
                    ColorAnimation { duration: Theme.durFast }
                }

                Behavior on height {
                    enabled: !Theme.reducedMotion
                    NumberAnimation { duration: Theme.durFast; easing.type: Easing.OutCubic }
                }

                // Rise into place, staggered down the list, the first time this
                // name is seen.
                transform: Translate { id: rise }

                Component.onCompleted: {
                    const seen = root.summoned[entry.modelData.name] === true;
                    root.summoned[entry.modelData.name] = true;
                    if (seen || Theme.reducedMotion)
                        return;
                    entry.opacity = 0;
                    rise.y = 4;
                    emerge.start();
                }

                SequentialAnimation {
                    id: emerge
                    PauseAnimation { duration: entry.index * 40 }
                    ParallelAnimation {
                        NumberAnimation {
                            target: entry
                            property: "opacity"
                            to: 1
                            duration: Theme.durMed
                            easing.type: Easing.OutCubic
                        }
                        NumberAnimation {
                            target: rise
                            property: "y"
                            to: 0
                            duration: Theme.durMed
                            easing.type: Easing.OutCubic
                        }
                    }
                }

                Column {
                    id: layout
                    width: entry.width
                    spacing: 0

                    Item {
                        id: nameRow
                        width: parent.width
                        height: Theme.controlHeight

                        Row {
                            z: 1
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.left: parent.left
                            anchors.leftMargin: Theme.gap
                            anchors.right: parent.right
                            anchors.rightMargin: Theme.gap
                            spacing: Theme.gap

                            // Every row is a little ghost; only the active one is lit.
                            GhostGlyph {
                                anchors.verticalCenter: parent.verticalCenter
                                size: 14
                                strokeWidth: 2
                                tint: entry.active ? Theme.ghostAmber : Theme.foregroundFaint
                            }

                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                width: parent.width - 14 - banish.width - Theme.gap * 2
                                text: entry.modelData.name
                                color: entry.active ? Theme.foregroundBright : Theme.foreground
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSize
                                elide: Text.ElideRight
                            }

                            Rectangle {
                                id: banish
                                anchors.verticalCenter: parent.verticalCenter
                                // Reserve the width whether or not the glyph is
                                // painted, so the name does not shift on hover.
                                width: 16
                                height: Theme.controlHeight
                                visible: entryArea.containsMouse || banishArea.containsMouse
                                    || entry.armed || entry.deleting
                                z: 2
                                radius: Theme.radius / 2
                                color: banishArea.containsMouse || entry.armed
                                    ? Theme.rose(0.10)
                                    : "transparent"

                                Behavior on color {
                                    enabled: !Theme.reducedMotion
                                    ColorAnimation { duration: Theme.durFast }
                                }

                                Text {
                                    anchors.centerIn: parent
                                    text: "×"
                                    color: banishArea.containsMouse || entry.armed
                                        ? Theme.ghostRose
                                        : Theme.foregroundFaint
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSize
                                }

                                MouseArea {
                                    id: banishArea
                                    anchors.fill: parent
                                    enabled: !entry.deleting
                                    hoverEnabled: true
                                    cursorShape: Qt.PointingHandCursor
                                    // Arms the row, never deletes: the × is the
                                    // question, the typed name is the answer.
                                    onClicked: {
                                        if (entry.armed) {
                                            root.disarm();
                                        } else {
                                            root.disarm();
                                            root.confirmingGhost = entry.modelData.name;
                                            confirmField.text = "";
                                            confirmField.forceActiveFocus();
                                        }
                                    }
                                }
                            }
                        }

                        MouseArea {
                            id: entryArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                root.disarm();
                                Ghostd.selectGhost(entry.modelData.name);
                                root.picked();
                            }
                        }
                    }

                    // ---- Typed-name confirmation ------------------------------
                    // Only ever one of these: root.confirmingGhost holds a single
                    // name. Deliberately plain — a rare, destructive question, not
                    // a control the eye should land on while reading the roster.
                    Item {
                        visible: entry.armed
                        width: parent.width
                        height: confirmColumn.implicitHeight + Theme.gap

                        Column {
                            id: confirmColumn
                            x: Theme.gap
                            width: parent.width - Theme.gap * 2
                            spacing: Theme.gap / 2

                            Text {
                                width: parent.width
                                text: entry.deleting
                                    ? "Deleting…"
                                    : "Name this ghost to banish it. Its memories, docs, and conversations will be moved to the trash."
                                color: Theme.foregroundDim
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                wrapMode: Text.Wrap
                            }

                            Item {
                                width: parent.width
                                height: Theme.controlHeight - Theme.gap
                                opacity: entry.deleting ? 0.5 : 1

                                Behavior on opacity {
                                    enabled: !Theme.reducedMotion
                                    NumberAnimation { duration: Theme.durFast }
                                }

                                Rectangle {
                                    anchors.left: parent.left
                                    anchors.right: confirmAction.left
                                    anchors.rightMargin: Theme.gap / 2
                                    height: parent.height
                                    radius: Theme.radius / 2
                                    color: Theme.film(0.06)
                                    border.width: 1
                                    border.color: entry.confirmed
                                        ? Theme.rose(0.50)
                                        : Theme.film(0.10)

                                    // Plain TextInput, not a Controls TextField:
                                    // the shell themes itself from Omarchy and
                                    // will not carry a style stack for one field.
                                    TextInput {
                                        id: confirmField
                                        anchors.fill: parent
                                        anchors.leftMargin: Theme.gap / 2
                                        anchors.rightMargin: Theme.gap / 2
                                        verticalAlignment: TextInput.AlignVCenter
                                        enabled: !entry.deleting
                                        color: Theme.foregroundBright
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSizeSmall
                                        selectByMouse: true
                                        selectionColor: Theme.selection
                                        clip: true
                                        onAccepted: {
                                            if (entry.confirmed && !entry.deleting)
                                                Ghostd.deleteGhost(entry.modelData.name);
                                        }
                                        Keys.onEscapePressed: event => {
                                            event.accepted = true;
                                            root.disarm();
                                        }
                                        // Focus leaving the field is the click
                                        // that landed somewhere else; a delete in
                                        // flight owns the row until it answers.
                                        onActiveFocusChanged: {
                                            if (!confirmField.activeFocus && entry.armed
                                                && !entry.deleting)
                                                root.disarm();
                                        }
                                    }
                                }

                                Text {
                                    id: confirmAction
                                    anchors.right: parent.right
                                    anchors.verticalCenter: parent.verticalCenter
                                    text: "Delete"
                                    color: entry.confirmed && !entry.deleting
                                        ? Theme.ghostRose
                                        : Theme.foregroundFaint
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    font.weight: Font.DemiBold

                                    Behavior on color {
                                        enabled: !Theme.reducedMotion
                                        ColorAnimation { duration: Theme.durFast }
                                    }

                                    MouseArea {
                                        anchors.fill: parent
                                        anchors.margins: -Theme.gap / 2
                                        enabled: entry.confirmed && !entry.deleting
                                        cursorShape: Qt.PointingHandCursor
                                        onClicked: Ghostd.deleteGhost(entry.modelData.name)
                                    }
                                }
                            }

                            // The daemon's own words (ghost_busy names what is
                            // still running), so they are shown, not translated.
                            Text {
                                visible: Ghostd.ghostDeleteError !== ""
                                width: parent.width
                                text: Ghostd.ghostDeleteError
                                color: Theme.danger
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                wrapMode: Text.Wrap
                            }
                        }
                    }
                }
            }
        }

        Text {
            visible: Ghostd.ghosts.length === 0
            width: root.width
            text: Ghostd.reachable ? "No ghosts haunt this machine yet." : "ghostd unreachable"
            color: Ghostd.reachable ? Theme.foregroundDim : Theme.danger
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        // ---- Naming a new ghost -------------------------------------------
        // Exists only while the header's + is armed; the roster carries no
        // standing summon row.

        Rectangle {
            visible: root.naming
            width: root.width
            height: Theme.controlHeight
            radius: Theme.radius
            color: Theme.film(0.05)
            border.width: 1
            border.color: Theme.amber(0.50)

            TextInput {
                id: nameField
                anchors.fill: parent
                anchors.margins: Theme.gap
                verticalAlignment: TextInput.AlignVCenter
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
                selectByMouse: true
                selectionColor: Theme.selection
                onAccepted: {
                    Ghostd.createGhost(text);
                    text = "";
                    root.naming = false;
                    root.picked();
                }
                Keys.onEscapePressed: {
                    nameField.text = "";
                    root.naming = false;
                    root.picked();
                }
            }
        }
    }
}
