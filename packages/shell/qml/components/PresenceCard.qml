// PresenceCard — the work in progress, then the reply, where the prompt was.
//
// While the turn runs it is one line: the HUD's own ActivityLine when Ghostd's
// live projection is this conversation, plain "Working" when the window has
// moved the projection elsewhere. The reply replaces it, scrolled past half
// the screen. Esc or × forgets it; Open shows the conversation in the window;
// summoning again follows up.
import QtQuick
import "../services"
import "MarkdownCompat.js" as MarkdownCompat

Rectangle {
    id: root

    property real maxHeight: 600
    readonly property int inner: Theme.ch(72)

    width: root.inner + Theme.pad * 2
    height: Math.min(root.maxHeight, column.implicitHeight + Theme.pad * 2)
    color: Theme.background
    border.width: 1
    // A failure frames the card; a question needs only its own red dot.
    border.color: Presence.phase === "failed" ? Theme.rose(0.6) : Theme.film(0.22)
    radius: Theme.radius
    focus: true

    Keys.onEscapePressed: Presence.clear()
    // 1-6 pick one of the question's suggested answers.
    Keys.onPressed: event => {
        if (event.key >= Qt.Key_1 && event.key <= Qt.Key_6 && questionLine.choose(event.key - Qt.Key_1))
            event.accepted = true;
    }

    Column {
        id: column
        anchors.fill: parent
        anchors.margins: Theme.pad
        spacing: Theme.gap

        Item {
            width: parent.width
            height: Theme.controlHeight

            Text {
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                text: Presence.ghost
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeCaption
            }

            Row {
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                spacing: Theme.gap * 2

                Repeater {
                    model: [
                        { label: "open", act: () => Presence.openInWindow() },
                        { label: "×", act: () => Presence.clear() }
                    ]

                    Text {
                        required property var modelData
                        text: modelData.label
                        color: linkArea.containsMouse ? Theme.foregroundBright : Theme.foregroundFaint
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeCaption

                        MouseArea {
                            id: linkArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: parent.modelData.act()
                        }
                    }
                }
            }
        }

        ActivityLine {
            width: parent.width
            maxHeight: Theme.controlHeight * 3
            visible: Presence.working && Presence.projected
        }

        Text {
            width: parent.width
            visible: Presence.working && !Presence.projected
            text: "Working…"
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSize
        }

        Text {
            width: parent.width
            visible: Presence.phase === "failed"
            text: Presence.failure
            color: Theme.ghostRose
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSize
            wrapMode: Text.Wrap
        }

        Flickable {
            id: answerScroll
            width: parent.width
            visible: Presence.phase === "answered"
            height: Math.min(answer.implicitHeight,
                root.maxHeight - Theme.pad * 2 - Theme.controlHeight - Theme.gap)
            contentWidth: width
            contentHeight: answer.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds

            Text {
                id: answer
                width: answerScroll.width
                text: MarkdownCompat.normalize(Presence.answer, Theme.ghostAmber, Theme.info)
                textFormat: Text.MarkdownText
                color: Theme.foregroundBright
                linkColor: Theme.ghostAmber
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
                lineHeight: Theme.lineHeight
                wrapMode: Text.Wrap
                onLinkActivated: link => ExternalLinks.openModelUrl(link)
            }
        }

        QuestionLine {
            id: questionLine
            width: parent.width
            question: Presence.question
            onAnswered: text => Presence.answerQuestion(text)
            onDismissed: Presence.dismissQuestion()
        }
    }
}
