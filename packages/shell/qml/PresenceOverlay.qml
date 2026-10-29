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
import "services/EdgeGlow.js" as EdgeGlow

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

        Binding {
            target: Presence
            property: "promptFocused"
            value: promptWindow.visible && promptWindow.contentItem.Window.active
        }

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

            /** Full while summoned, softer around the menu on its screen, a shimmer while working, dark otherwise. */
            readonly property real strength: Presence.composing ? 1
                : Ghostd.hudVisible && screenScope.modelData.name === Presence.hudScreen ? 0.55
                : Presence.working ? 0.22 : 0
            property real shown: screenScope.strength
            Behavior on shown { NumberAnimation { duration: Theme.durSlow; easing.type: Easing.OutCubic } }

            property real phase: 0
            NumberAnimation on phase {
                from: 0; to: 1
                loops: Animation.Infinite
                duration: Presence.composing ? 6000 : 14000
                running: screenScope.shown > 0.01 || screenScope.flare > 0
            }

            // An ignition on this screen: the ring lights outward both ways
            // from where the summon came from, bright heads riding the
            // fronts, and settles once they meet opposite it.
            property real from: 0
            property real front: 1
            property real flare: 0
            Connections {
                target: Presence
                function onIgnitionsChanged(): void {
                    if (Presence.ignitionScreen !== screenScope.modelData.name || Theme.reducedMotion) return;
                    screenScope.from = EdgeGlow.origin(Presence.ignitionEdge, Presence.ignitionAt,
                        screenScope.modelData.width, screenScope.modelData.height);
                    ignition.restart();
                }
            }
            SequentialAnimation {
                id: ignition
                PropertyAction { target: screenScope; properties: "front,flare"; value: 0 }
                ParallelAnimation {
                    NumberAnimation { target: screenScope; property: "front"; to: 1; duration: 950; easing.type: Easing.OutQuad }
                    NumberAnimation { target: screenScope; property: "flare"; to: 1; duration: 180; easing.type: Easing.OutQuad }
                }
                NumberAnimation { target: screenScope; property: "flare"; to: 0; duration: 650; easing.type: Easing.InOutSine }
            }

            PresenceEdge { screen: screenScope.modelData; edge: "top"; strength: screenScope.shown; phase: screenScope.phase; from: screenScope.from; front: screenScope.front; flare: screenScope.flare }
            PresenceEdge { screen: screenScope.modelData; edge: "bottom"; strength: screenScope.shown; phase: screenScope.phase; from: screenScope.from; front: screenScope.front; flare: screenScope.flare }
            PresenceEdge { screen: screenScope.modelData; edge: "left"; strength: screenScope.shown; phase: screenScope.phase; from: screenScope.from; front: screenScope.front; flare: screenScope.flare }
            PresenceEdge { screen: screenScope.modelData; edge: "right"; strength: screenScope.shown; phase: screenScope.phase; from: screenScope.from; front: screenScope.front; flare: screenScope.flare }

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
