pragma ComponentBehavior: Bound

// Read-only inline Documents content supplied by ghostd. This component owns
// no filesystem primitive: reload is another authenticated daemon request and
// opening the live path externally is an explicit owner action. Authenticated
// bytes stay literal: no rich-text parser gets an opportunity to resolve an
// image, link, data URL, or raw HTML resource behind ghostd's boundary.
import QtQuick
import qs.services
import "Highlighter.js" as Highlighter

Item {
    id: root

    required property string filePath
    required property string source
    property string modifiedAt: ""
    property int byteSize: 0

    signal reloadRequested()
    signal externalRequested()
    signal closed()

    readonly property string fileName: Highlighter.baseName(root.filePath)

    Rectangle {
        id: header
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        height: Theme.controlHeight + Theme.gap
        color: "transparent"

        Column {
            anchors.left: parent.left
            anchors.leftMargin: Theme.pad
            anchors.right: actions.left
            anchors.rightMargin: Theme.gap
            anchors.verticalCenter: parent.verticalCenter
            spacing: 1

            Text {
                width: parent.width
                text: root.fileName
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
                font.weight: Font.DemiBold
                elide: Text.ElideMiddle
            }
            Text {
                width: parent.width
                text: "Read-only · " + root.byteSize + " B"
                color: Theme.foregroundFaint
                font.family: Theme.fontFamilyMono
                font.pixelSize: Theme.fontSizeSmall - 1
                elide: Text.ElideRight
            }
        }

        Row {
            id: actions
            anchors.right: parent.right
            anchors.rightMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            spacing: Theme.pad

            Repeater {
                model: [
                    { label: "↻", name: "Reload inline content" },
                    { label: "↗", name: "Open externally" },
                    { label: "×", name: "Close document" }
                ]
                delegate: Text {
                    id: action
                    required property var modelData
                    required property int index
                    text: action.modelData.label
                    color: pointer.containsMouse ? Theme.ghostAmberBright : Theme.foregroundFaint
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                    activeFocusOnTab: true
                    Accessible.role: Accessible.Button
                    Accessible.name: action.modelData.name

                    function activate(): void {
                        if (action.index === 0) root.reloadRequested();
                        else if (action.index === 1) root.externalRequested();
                        else root.closed();
                    }

                    MouseArea {
                        id: pointer
                        anchors.fill: parent
                        anchors.margins: -Theme.gap / 2
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: action.activate()
                    }
                    Keys.onPressed: event => {
                        if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                || event.key === Qt.Key_Space) {
                            action.activate();
                            event.accepted = true;
                        }
                    }
                }
            }
        }

        Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            height: 1
            color: Theme.border
        }
    }

    Item {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        anchors.bottom: parent.bottom
        clip: true

        Flickable {
            id: literalScroll
            anchors.fill: parent
            clip: true
            contentWidth: width
            contentHeight: literalText.implicitHeight + Theme.pad * 2
            boundsBehavior: Flickable.StopAtBounds

            Text {
                id: literalText
                objectName: "documentsInlineLiteralText"
                x: Theme.pad
                y: Theme.pad
                width: parent.width - Theme.pad * 2
                text: root.source
                textFormat: Text.PlainText
                color: Theme.foreground
                font.family: Theme.fontFamilyMono
                font.pixelSize: Theme.fontSize
                lineHeight: Theme.lineHeight
                wrapMode: Text.WrapAnywhere
                Accessible.role: Accessible.StaticText
                Accessible.name: "Literal read-only document content"
            }
        }
    }
}
