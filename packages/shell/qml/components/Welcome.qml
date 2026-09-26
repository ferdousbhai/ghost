import QtQuick
import "../services"

// The empty-conversation card: the ghost on its plinth, its name, and either
// its greeting or — with no daemon — the address that is not answering.
Column {
    id: root

    /** The "connect a model" invitation was clicked. */
    signal loginRequested()

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

        property real bob: 0

        anchors.horizontalCenter: parent.horizontalCenter
        width: 72
        height: 72

        SequentialAnimation on bob {
            running: !Theme.reducedMotion
            loops: Animation.Infinite
            NumberAnimation { to: -6; duration: 3000; easing.type: Easing.InOutSine }
            NumberAnimation { to: 6; duration: 3000; easing.type: Easing.InOutSine }
        }

        Item {
            width: parent.width
            height: parent.height
            y: plinth.bob

            // Two breathing halos, drifting out of phase because their periods
            // differ rather than because either one waits.
            Glow {
                anchors.centerIn: parent
                width: 200
                visible: Ghostd.reachable
                core: Theme.amber(0.15)
                mid: Theme.amber(0.05)
                breathLow: 0.5
                breath: 2000
            }

            Glow {
                anchors.centerIn: parent
                width: 132
                visible: Ghostd.reachable
                core: Theme.ember(0.10)
                mid: Theme.ember(0.04)
                breathLow: 0.45
                breath: 1500
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
    //
    // Instant-then-upgrade: the static line paints the moment the card
    // appears, and the ghost's own greeting — fetched in the background, often
    // a second or two behind — crossfades in over it if it arrives at all. No
    // spinner, because there is nothing to wait for: the card is already usable.
    Rectangle {
        anchors.horizontalCenter: parent.horizontalCenter
        visible: Ghostd.reachable
        width: parent.width
        // A greeting is two or three sentences, so this follows the *wrapped*
        // height of a Text with a fixed width, and glides rather than snapping.
        height: invitation.implicitHeight + Theme.pad * 2
        radius: Theme.bubbleRadius
        color: Theme.amber(0.06)
        border.width: 1
        border.color: Theme.amber(0.15)

        Behavior on height {
            enabled: !Theme.reducedMotion
            NumberAnimation {
                duration: Theme.durMed
                easing.type: Easing.OutCubic
            }
        }

        Text {
            id: invitation

            // A ghost with no model cannot answer, and its greeting is itself
            // model-written, so on a fresh install this card is the first and
            // only thing there is to read. Spend it on the one action that
            // unblocks everything rather than on a question they cannot ask.
            readonly property string line: Ghostd.noModel
                // Short on purpose: this card is centred in the transcript view
                // with no height of its own, so at a narrow HUD its last line
                // clips — and the one line a new owner cannot afford to lose is
                // the instruction. The detail (which providers, what they cost)
                // belongs in the pane this opens.
                ? "Click here to connect a model — free options exist."
                : (Ghostd.greeting !== "" ? Ghostd.greeting : "What's on your mind?")

            anchors.centerIn: parent
            width: parent.width - Theme.pad * 2
            // The card is centred; its sentences are not. A centred rag is the
            // one thing a fixed-width face renders worse than a proportional
            // one, because every line break lands on a column boundary.
            horizontalAlignment: Text.AlignLeft
            // Deliberately unbound: the crossfade swaps the words at the bottom
            // of the opacity dip so neither line is ever half-visible.
            text: "What's on your mind?"
            color: Theme.foreground
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSize
            wrapMode: Text.Wrap

            onLineChanged: {
                // Reduced motion, or a card nobody is looking at, takes the end
                // state.
                if (Theme.reducedMotion || !invitation.visible) {
                    crossfade.stop();
                    invitation.opacity = 1;
                    invitation.text = invitation.line;
                } else {
                    crossfade.restart();
                }
            }
            // A greeting that landed before this card existed changed nothing
            // to listen for.
            Component.onCompleted: invitation.text = invitation.line

            MouseArea {
                anchors.fill: parent
                // Only while it is the call to action; a greeting is not a
                // button. An invisible Item takes no input, so visibility is
                // the whole switch.
                visible: Ghostd.noModel
                cursorShape: Qt.PointingHandCursor
                onClicked: root.loginRequested()
            }

            SequentialAnimation {
                id: crossfade
                NumberAnimation {
                    target: invitation; property: "opacity"
                    to: 0
                    duration: Theme.durMed / 2
                    easing.type: Easing.InCubic
                }
                ScriptAction {
                    script: invitation.text = invitation.line
                }
                NumberAnimation {
                    target: invitation; property: "opacity"
                    to: 1
                    duration: Theme.durMed / 2
                    easing.type: Easing.OutCubic
                }
            }
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
