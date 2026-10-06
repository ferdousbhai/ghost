import QtQuick
import QtQuick.Layouts
import "../services"

// The HUD's left column: the ghost roster stacked over this ghost's
// conversations, each in its own scroller so a long list never crowds the
// other out.
ColumnLayout {
    id: root

    /** Something was picked or finished; the keyboard goes back to the composer. */
    signal refocused()
    signal ghostDeleteRequested(string name)
    signal conversationDeleteRequested(string sessionId, string title)

    spacing: Theme.sectionGap

    /** The composer's `+`, also Ctrl+N: a fresh conversation, keyboard back in the composer. */
    function startConversation(): void {
        conversations.reset();
        Ghostd.newConversation();
        root.refocused();
    }

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

}
