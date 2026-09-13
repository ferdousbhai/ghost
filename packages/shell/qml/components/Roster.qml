pragma ComponentBehavior: Bound

// The ghost roster: who exists, who the HUD is talking to, and ways to summon a
// new one or banish an old one. Names come from GET /api/ghosts; creating posts
// back, banishing hands the name to the HUD's modal, which is where the typed
// confirmation the daemon demands is collected.
import QtQuick
import "../services"

Item {
    id: root

    signal picked()

    /** The × was clicked: the HUD raises the modal, which asks for the name
        back before anything is sent. Banishing erases a home directory, so it
        is the loudest question the HUD asks — never a row-sized one. */
    signal deleteRequested(string name)

    /** The keyboard has nowhere to be, but nothing about the view changed —
        a rename that ended, or a click on the ghost already selected. */
    signal refocused()

    property bool naming: false

    // Held on the list, not the row: the roster is replaced wholesale on every
    // refresh, which rebuilds every delegate underneath a half-typed name.
    readonly property RenameSession rename: RenameSession {
        commit: (from, draft) => {
            // A renamed ghost is not a new one. Without this the row would rise
            // into place again, as if it had just been summoned.
            root.summoned[draft] = true;
            Ghostd.renameGhost(from, draft);
        }
        onFinished: root.refocused()
    }

    function beginRename(name: string): void {
        if (name === "") return;
        // One name being typed at a time; the summon row is the other.
        root.naming = false;
        Ghostd.ghostRenameError = "";
        root.rename.begin(name, name);
    }

    // Names that have already made their entrance. Ghostd.ghosts is replaced
    // wholesale on every poll, which rebuilds every delegate; without this the
    // roster would re-emerge on each refresh.
    property var summoned: ({})

    implicitWidth: Theme.sidebarMeasure
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
                font.pixelSize: Theme.fontSizeCaption
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
                readonly property bool deleting: Ghostd.deletingGhost === entry.modelData.name
                readonly property bool editing: root.rename.editingKey === entry.modelData.name

                width: root.width
                height: Theme.controlHeight
                radius: Theme.radius / 2
                color: entry.active ? Theme.film(0.10)
                    : (entryArea.containsMouse ? Theme.film(0.06) : "transparent")
                // The same amber ring the summon row wears: this is the roster's
                // one signal that a name is being typed rather than read.
                border.width: entry.editing ? 1 : 0
                border.color: Theme.amber(0.50)

                // A row that already exists when the rename starts. The other
                // path — a refresh rebuilding it mid-edit — is picked up in
                // Component.onCompleted below.
                onEditingChanged: if (entry.editing) renameField.begin(root.rename.draft)

                Behavior on color {
                    enabled: !Theme.reducedMotion
                    ColorAnimation { duration: Theme.durFast }
                }

                // Rise into place, staggered down the list, the first time this
                // name is seen.
                transform: Translate { id: rise }

                Component.onCompleted: {
                    // A refresh rebuilt the row this rename is running on.
                    if (entry.editing) renameField.begin(root.rename.draft);
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
                            visible: !entry.editing
                            width: parent.width - 14 - banish.width - Theme.gap * 2
                            text: entry.modelData.name
                            color: entry.active ? Theme.foregroundBright : Theme.foreground
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                            elide: Text.ElideRight
                        }

                        // The name becomes a field where it is read, and takes
                        // the × with it: a ghost you are renaming is not one
                        // you are about to banish.
                        InlineRename {
                            id: renameField
                            anchors.verticalCenter: parent.verticalCenter
                            visible: entry.editing
                            width: parent.width - 14 - Theme.gap
                            placeholder: "Name this ghost"
                            // Every row carries one of these, and an idle one
                            // reports its own empty text on creation; only the
                            // live one speaks.
                            onEdited: value => { if (entry.editing) root.rename.draft = value; }
                            onCommitted: root.rename.commitRename()
                            onCancelled: root.rename.cancel()
                            onFocusGained: root.rename.editor = renameField
                            onFocusLost: Qt.callLater(root.rename.commitOnBlur)
                        }

                        Rectangle {
                            id: banish
                            anchors.verticalCenter: parent.verticalCenter
                            // Reserve the width whether or not the glyph is
                            // painted, so the name does not shift on hover.
                            width: 16
                            height: Theme.controlHeight
                            visible: !entry.editing
                                && (entryArea.containsMouse || banishArea.containsMouse
                                || entry.deleting)
                            z: 2
                            radius: Theme.radius / 2
                            color: banishArea.containsMouse || entry.deleting
                                ? Theme.rose(0.10)
                                : "transparent"

                            Behavior on color {
                                enabled: !Theme.reducedMotion
                                ColorAnimation { duration: Theme.durFast }
                            }

                            Text {
                                anchors.centerIn: parent
                                text: entry.deleting ? "…" : "×"
                                color: banishArea.containsMouse || entry.deleting
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
                                // Raises the question, never answers it.
                                onClicked: root.deleteRequested(entry.modelData.name)
                            }
                        }
                    }

                    MouseArea {
                        id: entryArea
                        anchors.fill: parent
                        // While the field is up the row is the field; a stray
                        // click on the padding around it must not re-select.
                        enabled: !entry.editing
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                            // `picked` tears down what belonged to the ghost
                            // that was left — the open file most of all — and
                            // clicking the one already selected leaves none.
                            if (entry.modelData.name === Ghostd.activeGhost) {
                                root.refocused();
                                return;
                            }
                            Ghostd.selectGhost(entry.modelData.name);
                            root.picked();
                        }
                        // The first click of the pair still selects the ghost.
                        // That is what a single click there does anyway, and it
                        // is the one you are about to rename.
                        onDoubleClicked: root.beginRename(entry.modelData.name)
                    }
                }
            }
        }

        // A rename the daemon refused — "still answering", most often. It
        // belongs under the row it was typed into rather than in a modal: the
        // name is already back to what it was, and this says why.
        Text {
            visible: Ghostd.ghostRenameError !== ""
            width: root.width
            text: Ghostd.ghostRenameError
            color: Theme.ghostRose
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap

            MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: Ghostd.ghostRenameError = ""
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
