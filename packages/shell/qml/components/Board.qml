pragma ComponentBehavior: Bound

// The owner's board, read-only: Documents/board.md as columns of cards. Every
// harness and the owner move cards by editing the file; this pane only shows
// it, and hands the file to the workbench when the owner wants to edit here.
import QtQuick
import QtQuick.Layouts
import "../services"

Rectangle {
    id: root

    readonly property var board: Ghostd.board
    readonly property bool hasBoard: root.board !== null && root.board.exists
    readonly property string statusLine: Ghostd.boardError !== "" ? Ghostd.boardError
        : (root.board === null ? (Ghostd.boardLoading ? "Reading the board…" : "")
            : (!root.board.exists
                ? "No board yet. Create " + root.board.path + " with ## columns and - cards."
                : (root.board.truncated ? "Showing the first part of a very large board." : "")))

    signal closeRequested()

    implicitWidth: Theme.pad * 48
    implicitHeight: Theme.pad * 34
    color: Theme.background
    clip: true

    Keys.onEscapePressed: event => {
        root.closeRequested();
        event.accepted = true;
    }

    // Edits happen in the file; poll it while the pane is up so a card a
    // harness just moved shows within seconds.
    Timer {
        interval: 5000
        repeat: true
        running: root.visible
        onTriggered: Ghostd.refreshBoard()
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Theme.pad
        spacing: Theme.gap

        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.gap

            ColumnLayout {
                Layout.fillWidth: true
                spacing: Theme.gap / 2

                Text {
                    text: root.hasBoard && root.board.title !== "" ? root.board.title : "Board"
                    color: Theme.foregroundBright
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeHeading
                    font.weight: Font.DemiBold
                }

                Text {
                    Layout.fillWidth: true
                    text: root.hasBoard
                        ? root.board.path + (root.board.modified !== ""
                            ? " · " + Qt.formatDateTime(new Date(root.board.modified), "ddd HH:mm") : "")
                        : "Columns are ## headings, cards are - items, notes are indented lines."
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    elide: Text.ElideMiddle
                }
            }

            ActionButton {
                label: root.hasBoard ? "Edit" : "Create"
                primary: true
                enabled: root.board !== null
                onClicked: Workbench.open(root.board.path)
            }

            ActionButton {
                label: Ghostd.boardLoading ? "Refreshing" : "Refresh"
                enabled: !Ghostd.boardLoading
                onClicked: Ghostd.refreshBoard()
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 1
            color: Theme.border
        }

        Text {
            Layout.fillWidth: true
            visible: root.statusLine !== ""
            text: root.statusLine
            color: Ghostd.boardError !== "" ? Theme.danger : Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.WordWrap
        }

        Flickable {
            id: lanes

            // Few columns share the pane; many scroll sideways at a readable width.
            readonly property int columnCount: root.hasBoard ? root.board.columns.length : 0
            readonly property real columnWidth: columnCount === 0 ? 0
                : Math.max(Theme.pad * 9, Math.min(Theme.pad * 14,
                    (width - Theme.gap * (columnCount - 1)) / columnCount))

            Layout.fillWidth: true
            Layout.fillHeight: true
            contentWidth: columns.implicitWidth
            contentHeight: height
            clip: true
            flickableDirection: Flickable.HorizontalFlick

            Row {
                id: columns
                height: parent.height
                spacing: Theme.gap

                Repeater {
                    model: root.hasBoard ? root.board.columns : []

                    Rectangle {
                        id: columnBox

                        required property var modelData
                        width: lanes.columnWidth
                        height: columns.height
                        radius: Theme.radius
                        color: Theme.film(0.04)
                        border.width: 1
                        border.color: Theme.border

                        ColumnLayout {
                            anchors.fill: parent
                            anchors.margins: Theme.gap
                            spacing: Theme.gap / 2

                            Text {
                                Layout.fillWidth: true
                                text: columnBox.modelData.title + " · " + columnBox.modelData.cards.length
                                color: Theme.foregroundBright
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                font.weight: Font.DemiBold
                                font.capitalization: Font.AllUppercase
                                font.letterSpacing: 0.5
                                elide: Text.ElideRight
                            }

                            Flickable {
                                Layout.fillWidth: true
                                Layout.fillHeight: true
                                contentHeight: cards.implicitHeight
                                clip: true

                                Column {
                                    id: cards
                                    width: parent.width
                                    spacing: Theme.gap / 2

                                    Repeater {
                                        model: columnBox.modelData.cards

                                        Rectangle {
                                            id: cardBox

                                            required property var modelData
                                            width: cards.width
                                            implicitHeight: cardText.implicitHeight + Theme.gap
                                                + (cardNotes.visible ? cardNotes.implicitHeight + Theme.gap / 2 : 0)
                                            radius: Theme.radius
                                            color: Theme.surface
                                            border.width: 1
                                            border.color: Theme.film(0.10)

                                            Text {
                                                id: cardText
                                                anchors.left: parent.left
                                                anchors.right: parent.right
                                                anchors.top: parent.top
                                                anchors.margins: Theme.gap / 2
                                                text: (cardBox.modelData.done === true ? "✓ "
                                                    : (cardBox.modelData.done === false ? "○ " : ""))
                                                    + cardBox.modelData.text
                                                color: cardBox.modelData.done === true
                                                    ? Theme.foregroundDim : Theme.foreground
                                                font.family: Theme.fontFamily
                                                font.pixelSize: Theme.fontSizeSmall
                                                font.strikeout: cardBox.modelData.done === true
                                                wrapMode: Text.WordWrap
                                            }

                                            Text {
                                                id: cardNotes
                                                anchors.left: parent.left
                                                anchors.right: parent.right
                                                anchors.top: cardText.bottom
                                                anchors.margins: Theme.gap / 2
                                                anchors.topMargin: Theme.gap / 4
                                                visible: cardBox.modelData.notes.length > 0
                                                text: cardBox.modelData.notes.join("\n")
                                                color: Theme.foregroundDim
                                                font.family: Theme.fontFamily
                                                font.pixelSize: Theme.fontSizeSmall
                                                wrapMode: Text.WordWrap
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
