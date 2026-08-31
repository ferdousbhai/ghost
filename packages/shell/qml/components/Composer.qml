pragma ComponentBehavior: Bound

// The input field. Enter sends, Shift+Enter opens a new line, Esc bubbles up
// to the HUD so a half-typed prompt is never a reason you can't dismiss.
//
// Plain TextEdit rather than QtQuick.Controls TextArea: Controls would pull in
// a style whose colours would compete with the shared neutral design tokens.
import QtQuick
import Qt5Compat.GraphicalEffects
import qs.services

Item {
    id: root

    signal submitted(string text)

    property alias text: field.text

    readonly property bool hasDraft: field.text.trim() !== ""

    implicitHeight: Math.min(Math.max(field.implicitHeight + Theme.pad, 48), 160)

    function take(): void {
        field.forceActiveFocus();
    }

    // Focus halo: the warm bloom the old app put behind a focused input. It
    // sits outside the surface bounds and under it, so it never tints the film.
    RadialGradient {
        anchors.fill: surface
        anchors.margins: -Theme.pad
        horizontalRadius: width / 2
        verticalRadius: height / 2
        opacity: field.activeFocus ? 1 : 0
        gradient: Gradient {
            GradientStop { position: 0.0; color: Theme.amber(0.10) }
            GradientStop { position: 0.45; color: Theme.ember(0.05) }
            GradientStop { position: 0.78; color: Theme.rose(0.04) }
            GradientStop { position: 1.0; color: "transparent" }
        }

        Behavior on opacity {
            enabled: !Theme.reducedMotion
            NumberAnimation { duration: Theme.durSlow; easing.type: Easing.OutCubic }
        }
    }

    Rectangle {
        id: surface

        anchors.fill: parent
        radius: Theme.radiusLarge
        color: field.activeFocus ? Theme.film(0.07) : Theme.film(0.05)
        border.width: 1
        border.color: field.activeFocus ? Theme.film(0.20) : Theme.film(0.10)

        Behavior on color {
            enabled: !Theme.reducedMotion
            ColorAnimation { duration: Theme.durMed }
        }

        Behavior on border.color {
            enabled: !Theme.reducedMotion
            ColorAnimation { duration: Theme.durMed }
        }

        Flickable {
            anchors.fill: parent
            anchors.margins: Theme.pad / 2
            contentWidth: width
            contentHeight: field.implicitHeight
            clip: true
            interactive: contentHeight > height

            TextEdit {
                id: field

                width: parent.width
                focus: true
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
                wrapMode: TextEdit.Wrap
                selectByMouse: true
                selectionColor: Theme.selection
                selectedTextColor: Theme.foregroundBright
                enabled: Ghostd.pendingAsk === null

                Keys.onPressed: event => {
                    const enter = event.key === Qt.Key_Return || event.key === Qt.Key_Enter;
                    if (enter && !(event.modifiers & Qt.ShiftModifier)) {
                        if (!Ghostd.streaming && !Ghostd.stopSubmitting) {
                            root.submitted(field.text);
                            field.text = "";
                        }
                        event.accepted = true;
                    }
                }

                Text {
                    anchors.fill: parent
                    visible: field.text === ""
                    text: Ghostd.activeGhost === ""
                        ? "No ghost selected"
                        : (Ghostd.stopSubmitting
                            ? "Stopping " + Ghostd.activeGhost + "…"
                            : (Ghostd.streaming
                            ? "Press Esc to stop before sending another message"
                            : "Message " + Ghostd.activeGhost + "…")
                        )
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                    elide: Text.ElideRight
                }
            }
        }
    }
}
