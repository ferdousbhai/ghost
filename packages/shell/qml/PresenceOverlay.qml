pragma ComponentBehavior: Bound

// PresenceOverlay — Presence drawn on every screen.
//
// Edges glow on every monitor; the prompt, ticker and card appear only on the
// one the summon came from. The prompt is the only surface that takes the
// keyboard unasked, and only while it is open. The ticker and card take it
// when clicked, so a reply can be dismissed with Esc.
import Quickshell
import Quickshell.Wayland
import QtQuick
import "services"
import "components"

Variants {
    model: Quickshell.screens

    Scope {
        id: screenScope

        required property ShellScreen modelData
        readonly property bool home: Presence.screenName === ""
            ? screenScope.modelData === Quickshell.screens[0]
            : screenScope.modelData.name === Presence.screenName

        /** Full while summoned, a shimmer while working, dark otherwise. */
        readonly property real strength: Presence.composing ? 1
            : Presence.working ? 0.22 : 0
        property real shown: screenScope.strength
        Behavior on shown { NumberAnimation { duration: Theme.durSlow; easing.type: Easing.OutCubic } }

        property real phase: 0
        NumberAnimation on phase {
            from: 0; to: 1
            loops: Animation.Infinite
            duration: Presence.composing ? 6000 : 14000
            running: screenScope.shown > 0.01
        }

        PresenceEdge { screen: screenScope.modelData; edge: "top"; strength: screenScope.shown; phase: screenScope.phase }
        PresenceEdge { screen: screenScope.modelData; edge: "bottom"; strength: screenScope.shown; phase: screenScope.phase }
        PresenceEdge { screen: screenScope.modelData; edge: "left"; strength: screenScope.shown; phase: screenScope.phase }
        PresenceEdge { screen: screenScope.modelData; edge: "right"; strength: screenScope.shown; phase: screenScope.phase }

        // The prompt: the whole screen, so a click outside the pill dismisses
        // it the way Esc does.
        WlrLayershell {
            screen: screenScope.modelData
            visible: Presence.composing && screenScope.home
            // Quickshell's typeinfo declares the edge anchors without their members.
            anchors { top: true; bottom: true; left: true; right: true } // qmllint disable missing-property
            color: "transparent"
            exclusionMode: ExclusionMode.Ignore
            namespace: "ghost-presence-prompt"
            layer: WlrLayer.Overlay
            keyboardFocus: WlrKeyboardFocus.Exclusive

            MouseArea {
                anchors.fill: parent
                onClicked: Presence.dismiss()
            }

            PresencePrompt {
                anchors.horizontalCenter: parent.horizontalCenter
                anchors.bottom: parent.bottom
                anchors.bottomMargin: parent.height * 0.12
                active: Presence.composing
            }
        }

        // The ticker, then the card, where the prompt was.
        WlrLayershell {
            id: cardWindow
            screen: screenScope.modelData
            visible: !Presence.composing && Presence.phase !== "" && screenScope.home
            anchors.bottom: true // qmllint disable missing-property
            margins.bottom: screenScope.modelData.height * 0.12
            implicitWidth: card.width
            implicitHeight: card.height
            color: "transparent"
            exclusionMode: ExclusionMode.Ignore
            namespace: "ghost-presence-card"
            layer: WlrLayer.Overlay
            // Never taken unasked: only a click gives the card the keyboard.
            keyboardFocus: WlrKeyboardFocus.OnDemand

            PresenceCard {
                id: card
                maxHeight: screenScope.modelData.height * 0.5
            }
        }
    }
}
