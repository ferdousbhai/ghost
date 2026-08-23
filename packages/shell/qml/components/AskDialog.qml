pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Layouts
import qs.services

Rectangle {
    id: root

    required property var interaction
    property var answers: ({})
    property bool submitting: false
    property string error: ""

    signal answered(var answer)
    signal chatRequested()

    implicitHeight: Math.min(askLayout.implicitHeight + Theme.pad * 2, 360)
    radius: Theme.radius
    color: Theme.surface
    border.width: 1
    border.color: Theme.border

    onInteractionChanged: root.answers = ({})

    function answerState(question: var): var {
        return root.answers[question.id] || {
            selectedOptions: [],
            customInput: "",
            note: ""
        };
    }

    function writeState(id: string, state: var): void {
        const copy = {};
        for (const key in root.answers) copy[key] = root.answers[key];
        copy[id] = state;
        root.answers = copy;
    }

    function isSelected(question: var, label: string): bool {
        return root.answerState(question).selectedOptions.indexOf(label) >= 0;
    }

    function toggle(question: var, label: string): void {
        const current = root.answerState(question);
        let selected = current.selectedOptions.slice();
        const index = selected.indexOf(label);
        if (question.multi === true) {
            if (index >= 0) selected.splice(index, 1);
            else selected.push(label);
        } else {
            selected = index >= 0 ? [] : [label];
        }
        root.writeState(question.id, {
            selectedOptions: selected,
            customInput: question.multi === true ? current.customInput : "",
            note: current.note
        });
    }

    function setCustom(question: var, value: string): void {
        const current = root.answerState(question);
        root.writeState(question.id, {
            selectedOptions: question.multi === true ? current.selectedOptions : [],
            customInput: value,
            note: current.note
        });
    }

    function setNote(question: var, value: string): void {
        const current = root.answerState(question);
        root.writeState(question.id, {
            selectedOptions: current.selectedOptions,
            customInput: current.customInput,
            note: value
        });
    }

    function canSubmit(): bool {
        if (!root.interaction || !Array.isArray(root.interaction.questions)) return false;
        for (const question of root.interaction.questions) {
            if (question.multi === true) continue;
            const answer = root.answerState(question);
            if (answer.selectedOptions.length === 0 && answer.customInput.trim() === "") return false;
        }
        return root.interaction.questions.length > 0;
    }

    function submit(): void {
        if (!root.canSubmit() || root.submitting) return;
        const results = [];
        for (const question of root.interaction.questions) {
            const answer = root.answerState(question);
            const result = {
                id: question.id,
                selectedOptions: answer.selectedOptions
            };
            if (answer.customInput.trim() !== "") result.customInput = answer.customInput.trim();
            if (answer.note.trim() !== "") result.note = answer.note.trim();
            results.push(result);
        }
        root.answered({ kind: "submit", results: results });
    }

    ColumnLayout {
        id: askLayout
        anchors.fill: parent
        anchors.margins: Theme.pad
        spacing: Theme.gap

        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.gap

            Rectangle {
                implicitWidth: 3
                implicitHeight: 18
                radius: 1
                color: Theme.accent
            }

            Text {
                Layout.fillWidth: true
                text: "A quick question"
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize + 1
                font.weight: Font.DemiBold
            }

            Text {
                visible: root.interaction && root.interaction.questions
                    && root.interaction.questions.length > 1
                text: root.interaction && root.interaction.questions
                    ? root.interaction.questions.length + " parts" : ""
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }
        }

        Flickable {
            id: askScroll
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.minimumHeight: Math.min(questionsColumn.implicitHeight, 120)
            contentWidth: width
            contentHeight: questionsColumn.implicitHeight
            clip: true
            interactive: contentHeight > height
            boundsBehavior: Flickable.StopAtBounds

            Column {
                id: questionsColumn
                width: askScroll.width
                spacing: Theme.pad

                Repeater {
                    model: root.interaction && Array.isArray(root.interaction.questions)
                        ? root.interaction.questions : []

                    delegate: Column {
                        id: questionBlock
                        required property var modelData
                        readonly property var question: modelData

                        width: questionsColumn.width
                        spacing: Theme.gap / 2

                        Row {
                            width: parent.width
                            spacing: Theme.gap

                            Rectangle {
                                visible: questionBlock.question.header
                                    && questionBlock.question.header.trim() !== ""
                                width: headerText.implicitWidth + Theme.gap
                                height: 20
                                radius: Theme.radius / 2
                                color: Theme.selection

                                Text {
                                    id: headerText
                                    anchors.centerIn: parent
                                    text: questionBlock.question.header || ""
                                    color: Theme.foreground
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    font.weight: Font.DemiBold
                                }
                            }

                            Text {
                                width: parent.width - x
                                text: questionBlock.question.question
                                color: Theme.foregroundBright
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSize
                                wrapMode: Text.Wrap
                            }
                        }

                        Repeater {
                            model: Array.isArray(questionBlock.question.options)
                                ? questionBlock.question.options : []

                            delegate: Rectangle {
                                id: optionRow
                                required property var modelData
                                required property int index
                                readonly property bool chosen: root.isSelected(
                                    questionBlock.question, modelData.label)

                                width: questionBlock.width
                                height: optionText.implicitHeight + Theme.gap
                                radius: Theme.radius / 2
                                color: chosen ? Theme.selection
                                    : (optionArea.containsMouse ? Theme.hover : "transparent")
                                border.width: 0
                                border.color: Theme.border

                                Row {
                                    anchors.fill: parent
                                    anchors.margins: Theme.gap / 2
                                    spacing: Theme.gap

                                    Rectangle {
                                        anchors.top: parent.top
                                        anchors.topMargin: 1
                                        width: 16
                                        height: 16
                                        radius: questionBlock.question.multi === true ? 3 : 8
                                        color: "transparent"
                                        border.width: 1
                                        border.color: optionRow.chosen ? Theme.accent : Theme.borderStrong

                                        Rectangle {
                                            anchors.centerIn: parent
                                            width: questionBlock.question.multi === true ? 8 : 7
                                            height: questionBlock.question.multi === true ? 8 : 7
                                            radius: questionBlock.question.multi === true ? 1 : 4
                                            visible: optionRow.chosen
                                            color: Theme.accent
                                        }
                                    }

                                    Column {
                                        id: optionText
                                        width: parent.width - x
                                        spacing: 2

                                        Text {
                                            width: parent.width
                                            text: optionRow.modelData.label
                                                + (questionBlock.question.recommended === optionRow.index
                                                    && !optionRow.modelData.label.endsWith(" (Recommended)")
                                                    ? " (Recommended)" : "")
                                            color: optionRow.chosen
                                                ? Theme.foregroundBright : Theme.foreground
                                            font.family: Theme.fontFamily
                                            font.pixelSize: Theme.fontSize
                                            font.weight: optionRow.chosen ? Font.DemiBold : Font.Normal
                                            wrapMode: Text.Wrap
                                        }

                                        Text {
                                            visible: optionRow.modelData.description
                                                && optionRow.modelData.description.trim() !== ""
                                            width: parent.width
                                            text: optionRow.modelData.description || ""
                                            color: Theme.foregroundDim
                                            font.family: Theme.fontFamily
                                            font.pixelSize: Theme.fontSizeSmall
                                            wrapMode: Text.Wrap
                                        }

                                        Text {
                                            visible: optionRow.chosen && optionRow.modelData.preview
                                                && optionRow.modelData.preview.trim() !== ""
                                            width: parent.width
                                            text: optionRow.modelData.preview || ""
                                            color: Theme.foregroundDim
                                            font.family: Theme.fontFamily
                                            font.pixelSize: Theme.fontSizeSmall
                                            wrapMode: Text.Wrap
                                        }
                                    }
                                }

                                MouseArea {
                                    id: optionArea
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: root.toggle(questionBlock.question, optionRow.modelData.label)
                                }
                            }
                        }

                        Rectangle {
                            width: questionBlock.width
                            height: Math.max(otherInput.implicitHeight + Theme.gap, 34)
                            radius: Theme.radius / 2
                            color: Theme.surfaceDeep
                            border.width: 1
                            border.color: otherInput.activeFocus ? Theme.accent : Theme.border

                            TextInput {
                                id: otherInput
                                anchors.fill: parent
                                anchors.margins: Theme.gap / 2
                                text: root.answerState(questionBlock.question).customInput
                                color: Theme.foregroundBright
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSize
                                selectByMouse: true
                                clip: true
                                onTextEdited: root.setCustom(questionBlock.question, text)

                                Text {
                                    anchors.fill: parent
                                    visible: otherInput.text === ""
                                    text: "Other (type your own)"
                                    color: Theme.foregroundDim
                                    font: otherInput.font
                                }
                            }
                        }

                        Rectangle {
                            width: questionBlock.width
                            height: Math.max(noteInput.implicitHeight + Theme.gap, 30)
                            radius: Theme.radius / 2
                            color: "transparent"
                            border.width: 1
                            border.color: noteInput.activeFocus ? Theme.accent : Theme.border

                            TextInput {
                                id: noteInput
                                anchors.fill: parent
                                anchors.margins: Theme.gap / 2
                                text: root.answerState(questionBlock.question).note
                                color: Theme.foreground
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                selectByMouse: true
                                clip: true
                                onTextEdited: root.setNote(questionBlock.question, text)

                                Text {
                                    anchors.fill: parent
                                    visible: noteInput.text === ""
                                    text: "Add a note (optional)"
                                    color: Theme.foregroundDim
                                    font: noteInput.font
                                }
                            }
                        }
                    }
                }
            }
        }

        Text {
            visible: root.error !== ""
            Layout.fillWidth: true
            text: root.error
            color: Theme.danger
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.gap

            Rectangle {
                implicitWidth: chatLabel.implicitWidth + Theme.pad
                implicitHeight: 30
                radius: Theme.radius / 2
                color: chatArea.containsMouse ? Theme.hover : "transparent"
                border.width: 0
                border.color: Theme.border
                opacity: root.submitting ? 0.5 : 1

                Text {
                    id: chatLabel
                    anchors.centerIn: parent
                    text: "Chat about this"
                    color: Theme.foreground
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                }

                MouseArea {
                    id: chatArea
                    anchors.fill: parent
                    hoverEnabled: true
                    enabled: !root.submitting
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.chatRequested()
                }
            }

            Item { Layout.fillWidth: true }

            Rectangle {
                implicitWidth: submitLabel.implicitWidth + Theme.pad
                implicitHeight: 30
                radius: Theme.radius / 2
                color: root.canSubmit() ? Theme.accent : Theme.borderStrong
                opacity: root.submitting ? 0.5 : 1

                Text {
                    id: submitLabel
                    anchors.centerIn: parent
                    text: root.submitting ? "Sending…" : "Answer"
                    color: root.canSubmit() ? Theme.onAccent : Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    font.weight: Font.DemiBold
                }

                MouseArea {
                    anchors.fill: parent
                    enabled: root.canSubmit() && !root.submitting
                    cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                    onClicked: root.submit()
                }
            }
        }
    }
}
