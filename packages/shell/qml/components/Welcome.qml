import QtQuick
import "../services"

// The empty-conversation card: the ghost on its plinth, its name, and either
// an invitation or — with no daemon — the address that is not answering.
Column {
    id: root

    spacing: Theme.pad

    // Materialize: fade up while swelling past 1 and settling back. Reduced
    // motion gets the end state.
    opacity: Theme.reducedMotion ? 1 : 0
    onVisibleChanged: if (root.visible && !Theme.reducedMotion) materialize.restart()
    Component.onCompleted: if (root.visible && !Theme.reducedMotion) materialize.start()

    ParallelAnimation {
        id: materialize
        NumberAnimation {
            target: root; property: "opacity"
            from: 0; to: 1
            duration: Theme.durSlow
            easing.type: Easing.OutExpo
        }
        SequentialAnimation {
            NumberAnimation {
                target: root; property: "scale"
                from: 0.8; to: 1.05
                duration: 460
                easing.type: Easing.OutExpo
            }
            NumberAnimation {
                target: root; property: "scale"
                to: 1.0
                duration: 240
                easing.type: Easing.OutCubic
            }
        }
    }

    Item {
        id: plinth

        anchors.horizontalCenter: parent.horizontalCenter
        width: 72
        height: 72

        // Still, like the halos: an endless animation would redraw the whole
        // window every frame the empty conversation is open.
        Item {
            width: parent.width
            height: parent.height

            // Two halos, one amber, one ember.
            Glow {
                anchors.centerIn: parent
                width: 200
                visible: Ghostd.reachable
                core: Theme.amber(0.15)
                mid: Theme.amber(0.05)
            }

            Glow {
                anchors.centerIn: parent
                width: 132
                visible: Ghostd.reachable
                core: Theme.ember(0.10)
                mid: Theme.ember(0.04)
            }

            Rectangle {
                anchors.fill: parent
                radius: Theme.bubbleRadius
                color: Theme.film(0.04)
                border.width: 1
                border.color: Theme.film(0.10)

                GhostGlyph {
                    anchors.centerIn: parent
                    size: 36
                    tint: Ghostd.reachable ? Theme.ghostAmberBright : Theme.danger
                }
            }
        }
    }

    Text {
        anchors.horizontalCenter: parent.horizontalCenter
        text: Ghostd.activeGhost === "" ? "ghost" : Ghostd.activeGhost
        color: Theme.foregroundBright
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeDisplay
        font.weight: Font.Medium
    }

    // The invitation. Amber film, so the ghost's own colour asks the question.
    Rectangle {
        anchors.horizontalCenter: parent.horizontalCenter
        visible: Ghostd.reachable
        width: parent.width
        height: invitation.implicitHeight + Theme.pad * 2
        radius: Theme.bubbleRadius
        color: Theme.amber(0.06)
        border.width: 1
        border.color: Theme.amber(0.15)

        Text {
            id: invitation

            anchors.centerIn: parent
            width: parent.width - Theme.pad * 2
            text: "What's on your mind?"
            color: Theme.foreground
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSize
            wrapMode: Text.Wrap
        }
    }

    // The same hero, failed: rose film instead of amber.
    Rectangle {
        anchors.horizontalCenter: parent.horizontalCenter
        visible: !Ghostd.reachable
        width: parent.width
        height: unreachable.implicitHeight + Theme.pad * 2
        radius: Theme.bubbleRadius
        color: Theme.rose(0.08)
        border.width: 1
        border.color: Theme.rose(0.20)

        Text {
            id: unreachable
            anchors.centerIn: parent
            width: parent.width - Theme.pad * 2
            horizontalAlignment: Text.AlignHCenter
            text: "ghostd is not answering on " + Ghostd.baseUrl
            color: Theme.foreground
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSize
            wrapMode: Text.Wrap
        }
    }
}
