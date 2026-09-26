import QtQuick
import QtQuick.Layouts
import "../services"

// The HUD's left column: the ghost roster stacked over this ghost's
// conversations, each in its own scroller so a long list never crowds the
// other out, and a footer button that starts a new conversation.
ColumnLayout {
    id: root

    /** Something was picked or finished; the keyboard goes back to the composer. */
    signal refocused()
    signal ghostDeleteRequested(string name)
    signal conversationDeleteRequested(string sessionId, string title)

    spacing: Theme.sectionGap

    Flickable {
        id: rosterScroll
        Layout.fillWidth: true
        // Prefer the roster's own height, but cap it with a fixed ceiling so a
        // long ghost list never starves the conversations below; both scroll
        // past their share. The cap is a constant on purpose — deriving it from
        // the column's height feeds the layout's size back into a child hint
        // and trips a recursive rearrange.
        Layout.preferredHeight: Math.min(roster.implicitHeight, 220)
        contentWidth: width
        contentHeight: roster.implicitHeight
        clip: true
        interactive: contentHeight > height
        boundsBehavior: Flickable.StopAtBounds

        Roster {
            id: roster
            width: rosterScroll.width
            onPicked: {
                // The open file lives in the ghost we just left.
                Workbench.close();
                root.refocused();
            }
            onRefocused: root.refocused()
            onDeleteRequested: name => root.ghostDeleteRequested(name)
        }
    }

    Conversations {
        id: conversations
        Layout.fillWidth: true
        Layout.fillHeight: true
        onPicked: root.refocused()
        onRefocused: root.refocused()
        onDeleteRequested: (sessionId, title) => root.conversationDeleteRequested(sessionId, title)
    }

    // Footer, Notes-style: the one button that adds to the list. It lives
    // outside the conversations' scroller so it stays put while they scroll.
    Item {
        Layout.fillWidth: true
        Layout.preferredHeight: Theme.controlHeight
        visible: Ghostd.activeGhost !== ""

        Rectangle {
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            width: Theme.controlHeight
            height: Theme.controlHeight
            radius: width / 2
            color: composeArea.containsMouse ? Theme.amber(0.15) : Theme.amber(0.10)
            border.width: 1
            border.color: composeArea.containsMouse ? Theme.amber(0.30) : Theme.amber(0.20)

            Behavior on color {
                enabled: !Theme.reducedMotion
                ColorAnimation { duration: Theme.durFast }
            }

            Text {
                anchors.centerIn: parent
                // "+" over a compose glyph: it is in every sans-serif, so it
                // never falls back to tofu.
                text: "+"
                color: Theme.ghostAmberBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeHeading
            }

            MouseArea {
                id: composeArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    conversations.reset();
                    Ghostd.newConversation();
                    root.refocused();
                }
            }
        }
    }
}
