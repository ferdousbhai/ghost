pragma ComponentBehavior: Bound

// QuestionLine — what the ghost asked the owner (`ghost ask`) and is waiting
// on: the question in the blocked state's red, its suggested answers as
// buttons, and a way to withdraw it unanswered. Any message the owner sends to
// the conversation answers it, so a typed reply works as well as a button;
// the buttons only save typing. Shown on the presence card and above the chat
// composer.
import QtQuick
import "../services"

Column {
    id: root

    /** `{ text, options, askedAt }` from the conversation's listing row, or null. */
    property var question: null

    /** An answer was chosen; the caller sends it as the owner's message. */
    signal answered(string text)
    signal dismissed()

    /** Answer with suggestion `index` (from 0), as the number keys do. */
    function choose(index: int): bool {
        const options = root.question && root.question.options ? root.question.options : [];
        if (index < 0 || index >= options.length) return false;
        root.answered(options[index]);
        return true;
    }

    visible: root.question !== null && root.question !== undefined
    spacing: Theme.gap

    // The dot, the question, and `dismiss` held to the right edge whatever
    // the question's length.
    Item {
        width: root.width
        height: questionText.height

        Rectangle {
            id: blockedDot
            anchors.left: parent.left
            y: (questionMetrics.height - height) / 2
            width: 6
            height: 6
            radius: 3
            color: Theme.danger
        }

        Text {
            id: questionText
            anchors.left: blockedDot.right
            anchors.leftMargin: Theme.gap
            anchors.right: dismiss.left
            anchors.rightMargin: Theme.gap * 2
            text: root.question ? root.question.text : ""
            color: Theme.foregroundBright
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSize
            wrapMode: Text.Wrap

            FontMetrics {
                id: questionMetrics
                font: questionText.font
            }
        }

        Text {
            id: dismiss
            anchors.right: parent.right
            anchors.top: parent.top
            text: "dismiss"
            color: dismissArea.containsMouse ? Theme.foregroundBright : Theme.foregroundFaint
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeCaption

            MouseArea {
                id: dismissArea
                anchors.fill: parent
                anchors.margins: -Theme.gap
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.dismissed()
            }
        }
    }

    Flow {
        width: root.width
        spacing: Theme.gap
        visible: root.question !== null && root.question !== undefined
            && (root.question.options || []).length > 0

        Repeater {
            model: root.question && root.question.options ? root.question.options : []

            Rectangle {
                id: answer

                required property string modelData
                required property int index

                width: answerRow.implicitWidth + Theme.pad
                height: Theme.controlHeight
                radius: Theme.controlRadius
                color: answerArea.containsMouse ? Theme.menuSelectedBackground : Theme.film(0.06)
                border.width: 1
                border.color: answerArea.containsMouse ? Theme.menuSelectedText : Theme.film(0.18)
                Accessible.role: Accessible.Button
                Accessible.name: answer.modelData

                // The number key that picks it, quieter than the answer itself.
                Row {
                    id: answerRow
                    anchors.centerIn: parent
                    spacing: Theme.gap

                    Text {
                        text: String(answer.index + 1)
                        color: Theme.foregroundFaint
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize
                    }

                    Text {
                        text: answer.modelData
                        color: answerArea.containsMouse ? Theme.menuSelectedText : Theme.menuText
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize
                    }
                }

                MouseArea {
                    id: answerArea
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.answered(answer.modelData)
                }
            }
        }
    }
}
