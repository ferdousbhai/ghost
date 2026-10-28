pragma ComponentBehavior: Bound

// PresenceOverlay — Presence drawn on the desktop.
//
// Edges glow on every monitor, and the ticker and card appear on the one the
// summon came from: layers that take no keyboard unasked (the card takes it
// when clicked, so a reply can be dismissed with Esc). The prompt, which does
// take the keyboard, is a window instead: Hyprland maps it on the focused
// monitor and sizes it there (DesktopKeys' rules), and as the focused window
// it is what SUPER+W closes, never the app behind it.
import Quickshell
import Quickshell.Wayland
import QtQuick
import "services"
import "components"
import "services/DesktopKeys.js" as Desk

Scope {
    // The prompt: the whole monitor, so a click outside the pill dismisses it
    // the way Esc does.
    FloatingWindow {
        id: promptWindow
        visible: Presence.composing
        title: Desk.PROMPT_TITLE
        color: "transparent"
        implicitWidth: 1280
        implicitHeight: 800

        // Hyprland closed it (SUPER+W): that is a dismissal.
        onVisibleChanged: if (!promptWindow.visible && Presence.composing) Presence.dismiss()

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
}
