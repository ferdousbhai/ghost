pragma ComponentBehavior: Bound

// AskDialog — OMP's built-in `ask`, rendered where the composer normally sits.
// That placement is the whole design constraint: while this is up there is no
// text field anywhere in the HUD, so anything the mouse can do here the
// keyboard has to do too. Enter answers, Esc gives up, 1–9 pick an option,
// Up/Down walk them, Tab reaches the free-text fields. The form takes the
// keyboard the moment a question arrives, so a yes/no never costs a trip to
// the pointer.
//
// The two free-text fields (a custom answer, a note) used to be rendered
// unconditionally, which put two empty boxes under every yes/no. They are
// folded away behind an affordance instead — and still one Tab away, because
// a hidden control the keyboard cannot reach is worse than a noisy one.
import QtQuick
import QtQuick.Layouts
import QtQuick.Window
import qs.services

Rectangle {
    id: root

    required property var interaction
    property var answers: ({})
    property bool submitting: false
    property string error: ""

    signal answered(var answer)
    signal chatRequested()
    signal dismissed()

    readonly property var questions: root.interaction
        && Array.isArray(root.interaction.questions) ? root.interaction.questions : []

    // Every option in the interaction, flattened to one sequence, so Up/Down
    // run past the end of a question into the next one instead of stopping at
    // a boundary the reader cannot see.
    readonly property var rows: {
        const out = [];
        for (let q = 0; q < root.questions.length; q++) {
            const options = Array.isArray(root.questions[q].options)
                ? root.questions[q].options : [];
            for (let o = 0; o < options.length; o++) out.push({ question: q, option: o });
        }
        return out;
    }

    property int cursor: 0
    /** The form itself holds the keyboard — not one of its text fields. */
    readonly property bool keyboardOnForm: root.activeFocus
    /** Which field wants the caret next; the delegates watch it and answer. */
    property var focusTarget: ({ question: -1, field: "" })

    // A question that outgrows the window scrolls; one that fits does not.
    // Sized against the window rather than a constant, so a tall HUD shows a
    // long question whole instead of scrolling it inside a small box.
    readonly property int maxHeight: Math.round(Math.max(root.Window.height || 0, 520) * 0.62)
    readonly property int questionsMaxHeight: Math.max(120, root.maxHeight
        - (headerRow.implicitHeight + actionRow.implicitHeight + Theme.gap * 2 + Theme.pad * 2)
        - (errorText.visible ? errorText.implicitHeight + Theme.gap : 0))

    readonly property string timeoutAt: root.interaction
        && typeof root.interaction.timeoutAt === "string" ? root.interaction.timeoutAt : ""
    readonly property real deadline: root.timeoutAt === "" ? 0 : Date.parse(root.timeoutAt)
    readonly property bool timed: root.deadline > 0 && Number.isFinite(root.deadline)
    property real clock: Date.now()
    readonly property real remaining: (root.deadline - root.clock) / 1000

    implicitHeight: askLayout.implicitHeight + Theme.pad * 2
    radius: Theme.radius
    color: Theme.surface
    border.width: 1
    border.color: Theme.border

    onInteractionChanged: {
        root.answers = ({});
        root.focusTarget = ({ question: -1, field: "" });
        root.clock = Date.now();
        root.cursor = root.defaultCursor();
        // Deferred: `visible` and `interaction` are separate bindings on the
        // same `pendingAsk` change and settle in no guaranteed order, and an
        // item that is still hidden cannot usefully be handed the keyboard.
        if (root.questions.length > 0) Qt.callLater(root.take);
    }

    function take(): void {
        if (root.questions.length > 0) root.forceActiveFocus();
    }

    function answerState(question: var): var {
        const stored = root.answers[question.id];
        if (stored) return stored;
        // `recommended` is an answer, not a label. The daemon already submits
        // it verbatim when an ask times out (ask-broker's #timedOutResult), so
        // preselecting it only makes Enter agree with the clock. There is no
        // `destructive` flag on the question to hold it back for — reading one
        // out of the option text would be a guess — so this preselects
        // whatever the model recommended, including a recommended "delete".
        const options = Array.isArray(question.options) ? question.options : [];
        const recommended = typeof question.recommended === "number"
            ? options[question.recommended] : undefined;
        return {
            selectedOptions: recommended ? [recommended.label] : [],
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
            // A non-multi question the broker will reject if it carries both.
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

    // ---- Keyboard ---------------------------------------------------------

    function defaultCursor(): int {
        for (let i = 0; i < root.rows.length; i++) {
            if (root.rows[i].question !== 0) break;
            const recommended = root.questions[0].recommended;
            const wanted = typeof recommended === "number" ? recommended : 0;
            if (root.rows[i].option === wanted) return i;
        }
        return 0;
    }

    function isCursor(questionIndex: int, optionIndex: int): bool {
        const row = root.rows[root.cursor];
        return row !== undefined && row.question === questionIndex
            && row.option === optionIndex;
    }

    function moveCursor(delta: int): void {
        if (root.rows.length === 0) return;
        root.cursor = Math.max(0, Math.min(root.rows.length - 1, root.cursor + delta));
        root.forceActiveFocus();
    }

    function cursorQuestion(): int {
        const row = root.rows[root.cursor];
        return row !== undefined ? row.question : 0;
    }

    function toggleCursor(): void {
        const row = root.rows[root.cursor];
        if (row === undefined) return;
        root.toggle(root.questions[row.question],
            root.questions[row.question].options[row.option].label);
    }

    /** 1–9 answer the question the cursor is in, not the first one on screen. */
    function pickNumber(number: int): bool {
        const question = root.cursorQuestion();
        for (let i = 0; i < root.rows.length; i++) {
            if (root.rows[i].question === question && root.rows[i].option === number - 1) {
                root.cursor = i;
                root.toggleCursor();
                return true;
            }
        }
        return false;
    }

    function focusField(field: string): void {
        root.focusTarget = ({ question: root.cursorQuestion(), field: field });
    }

    /** Keep the keyboard cursor inside the scrolled window it moved out of. */
    function revealRow(top: real, rowHeight: real): void {
        if (askScroll.contentHeight <= askScroll.height) return;
        let target = askScroll.contentY;
        if (top < target) target = top;
        else if (top + rowHeight > target + askScroll.height)
            target = top + rowHeight - askScroll.height;
        askScroll.contentY = Math.max(0,
            Math.min(askScroll.contentHeight - askScroll.height, target));
    }

    function canSubmit(): bool {
        for (const question of root.questions) {
            if (question.multi === true) continue;
            const answer = root.answerState(question);
            if (answer.selectedOptions.length === 0 && answer.customInput.trim() === "") return false;
        }
        return root.questions.length > 0;
    }

    function submit(): void {
        if (!root.canSubmit() || root.submitting) return;
        const results = [];
        for (const question of root.questions) {
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

    function dismiss(): void {
        if (root.submitting) return;
        root.dismissed();
    }

    function countdown(seconds: real): string {
        const total = Math.max(0, Math.round(seconds));
        return total >= 60 ? Math.floor(total / 60) + "m " + (total % 60) + "s" : total + "s";
    }

    // Esc gives up from anywhere inside the form, including mid-sentence in a
    // text field. A two-stage Esc (leave the field, then dismiss) would protect
    // a half-typed answer, but it also makes the only way out of an unwanted
    // question depend on where the caret happens to be.
    Keys.onEscapePressed: event => {
        event.accepted = true;
        root.dismiss();
    }
    Keys.onReturnPressed: event => {
        event.accepted = true;
        root.submit();
    }
    Keys.onEnterPressed: event => {
        event.accepted = true;
        root.submit();
    }
    Keys.onUpPressed: event => {
        event.accepted = true;
        root.moveCursor(-1);
    }
    Keys.onDownPressed: event => {
        event.accepted = true;
        root.moveCursor(1);
    }
    Keys.onSpacePressed: event => {
        event.accepted = true;
        root.toggleCursor();
    }
    Keys.onTabPressed: event => {
        event.accepted = true;
        root.focusField("custom");
    }
    Keys.onBacktabPressed: event => {
        event.accepted = true;
        root.focusField("note");
    }
    Keys.onPressed: event => {
        if (event.key < Qt.Key_1 || event.key > Qt.Key_9) return;
        if (event.modifiers & (Qt.ControlModifier | Qt.AltModifier)) return;
        event.accepted = root.pickNumber(event.key - Qt.Key_0);
    }

    // A click on the card's own chrome hands the keyboard back to the form, so
    // Enter still answers after the pointer has been somewhere else. Declared
    // first: every interactive child sits above it and wins the click.
    MouseArea {
        anchors.fill: parent
        onClicked: root.forceActiveFocus()
    }

    Timer {
        interval: 1000
        repeat: true
        running: root.timed && root.visible
        onTriggered: root.clock = Date.now()
    }

    ColumnLayout {
        id: askLayout
        anchors.fill: parent
        anchors.margins: Theme.pad
        spacing: Theme.gap

        RowLayout {
            id: headerRow
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
                visible: root.questions.length > 1
                text: root.questions.length + " parts"
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }

            // The deadline the daemon is already keeping. It answers with the
            // recommended option when this runs out, so saying so is a warning
            // and not decoration.
            Text {
                visible: root.timed
                text: root.remaining > 0
                    ? "auto-answers in " + root.countdown(root.remaining)
                    : "out of time"
                color: root.remaining <= 20 ? Theme.warn : Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }
        }

        Flickable {
            id: askScroll
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.preferredHeight: questionsColumn.implicitHeight
            Layout.maximumHeight: root.questionsMaxHeight
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
                    model: root.questions

                    delegate: Column {
                        id: questionBlock
                        required property var modelData
                        required property int index
                        readonly property var question: modelData
                        readonly property bool hasOptions: Array.isArray(modelData.options)
                            && modelData.options.length > 0
                        // A question with nothing to pick from *is* a text
                        // question, so its field is open from the start.
                        // Answers reset with the interaction, so these two
                        // never have to be reopened from stored content.
                        property bool customOpen: !hasOptions
                        property bool noteOpen: false

                        width: questionsColumn.width
                        spacing: Theme.gap / 2

                        Connections {
                            target: root

                            function onFocusTargetChanged() {
                                if (root.focusTarget.question !== questionBlock.index) return;
                                if (root.focusTarget.field === "custom") {
                                    questionBlock.customOpen = true;
                                    customField.forceActiveFocus();
                                } else if (root.focusTarget.field === "note") {
                                    questionBlock.noteOpen = true;
                                    noteField.forceActiveFocus();
                                }
                            }
                        }

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
                            model: questionBlock.hasOptions ? questionBlock.question.options : []

                            delegate: Rectangle {
                                id: optionRow
                                required property var modelData
                                required property int index
                                readonly property bool chosen: root.isSelected(
                                    questionBlock.question, modelData.label)
                                readonly property bool atCursor: root.isCursor(
                                    questionBlock.index, index)

                                width: questionBlock.width
                                height: optionText.implicitHeight + Theme.gap
                                radius: Theme.radius / 2
                                color: chosen ? Theme.selection
                                    : (optionArea.containsMouse ? Theme.hover : "transparent")
                                // The keyboard cursor, drawn only while the form
                                // holds the keyboard: a ring under the caret in
                                // a text field would point at the wrong thing.
                                border.width: optionRow.atCursor && root.keyboardOnForm ? 1 : 0
                                border.color: Theme.accent

                                Connections {
                                    target: root

                                    function onCursorChanged() {
                                        if (!optionRow.atCursor) return;
                                        root.revealRow(
                                            optionRow.mapToItem(questionsColumn, 0, 0).y,
                                            optionRow.height);
                                    }
                                }

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
                                            - (keyHint.visible ? keyHint.width + parent.spacing : 0)
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

                                    // The number key that picks this row. The
                                    // shortcut is only worth having if it is
                                    // visible without being told about it.
                                    Text {
                                        id: keyHint
                                        anchors.top: parent.top
                                        visible: optionRow.index < 9
                                        text: String(optionRow.index + 1)
                                        color: optionRow.atCursor && root.keyboardOnForm
                                            ? Theme.foreground : Theme.foregroundFaint
                                        font.family: Theme.fontFamilyMono
                                        font.pixelSize: Theme.fontSizeSmall
                                    }
                                }

                                MouseArea {
                                    id: optionArea
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: {
                                        root.cursor = root.rows.findIndex(row =>
                                            row.question === questionBlock.index
                                            && row.option === optionRow.index);
                                        root.forceActiveFocus();
                                        root.toggle(questionBlock.question, optionRow.modelData.label);
                                    }
                                }
                            }
                        }

                        // Wrapping, not a single line: "type your own" is where
                        // the answer nobody anticipated goes, and it is the only
                        // field a text-only question has. Enter still answers —
                        // Shift+Enter breaks the line, as in the composer.
                        Rectangle {
                            width: questionBlock.width
                            height: Math.max(customField.implicitHeight + Theme.gap, 34)
                            visible: questionBlock.customOpen
                            radius: Theme.radius / 2
                            color: Theme.surfaceDeep
                            border.width: 1
                            border.color: customField.activeFocus ? Theme.accent : Theme.border

                            TextEdit {
                                id: customField
                                anchors.fill: parent
                                anchors.margins: Theme.gap / 2
                                text: root.answerState(questionBlock.question).customInput
                                color: Theme.foregroundBright
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSize
                                wrapMode: TextEdit.Wrap
                                selectByMouse: true
                                selectionColor: Theme.selection
                                selectedTextColor: Theme.foregroundBright
                                onTextChanged: root.setCustom(questionBlock.question, text)

                                Keys.onPressed: event => {
                                    const enter = event.key === Qt.Key_Return
                                        || event.key === Qt.Key_Enter;
                                    if (enter && !(event.modifiers & Qt.ShiftModifier)) {
                                        event.accepted = true;
                                        root.submit();
                                    } else if (event.key === Qt.Key_Tab) {
                                        event.accepted = true;
                                        questionBlock.noteOpen = true;
                                        noteField.forceActiveFocus();
                                    } else if (event.key === Qt.Key_Backtab) {
                                        event.accepted = true;
                                        root.forceActiveFocus();
                                    }
                                }

                                Text {
                                    anchors.fill: parent
                                    visible: customField.text === ""
                                    text: questionBlock.hasOptions
                                        ? "Type your own answer" : "Type your answer"
                                    color: Theme.foregroundDim
                                    font: customField.font
                                    wrapMode: Text.Wrap
                                }
                            }
                        }

                        Rectangle {
                            width: questionBlock.width
                            height: Math.max(noteField.implicitHeight + Theme.gap, 30)
                            visible: questionBlock.noteOpen
                            radius: Theme.radius / 2
                            color: "transparent"
                            border.width: 1
                            border.color: noteField.activeFocus ? Theme.accent : Theme.border

                            TextEdit {
                                id: noteField
                                anchors.fill: parent
                                anchors.margins: Theme.gap / 2
                                text: root.answerState(questionBlock.question).note
                                color: Theme.foreground
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                wrapMode: TextEdit.Wrap
                                selectByMouse: true
                                selectionColor: Theme.selection
                                selectedTextColor: Theme.foregroundBright
                                onTextChanged: root.setNote(questionBlock.question, text)

                                Keys.onPressed: event => {
                                    const enter = event.key === Qt.Key_Return
                                        || event.key === Qt.Key_Enter;
                                    if (enter && !(event.modifiers & Qt.ShiftModifier)) {
                                        event.accepted = true;
                                        root.submit();
                                    } else if (event.key === Qt.Key_Tab) {
                                        event.accepted = true;
                                        root.forceActiveFocus();
                                    } else if (event.key === Qt.Key_Backtab) {
                                        event.accepted = true;
                                        questionBlock.customOpen = true;
                                        customField.forceActiveFocus();
                                    }
                                }

                                Text {
                                    anchors.fill: parent
                                    visible: noteField.text === ""
                                    text: "A note for the ghost (optional)"
                                    color: Theme.foregroundDim
                                    font: noteField.font
                                    wrapMode: Text.Wrap
                                }
                            }
                        }

                        // The way in to the folded-away fields, under whichever
                        // of them is already open. Tab does the same thing and
                        // says so, because this row leaves once both are out.
                        Row {
                            width: parent.width
                            spacing: Theme.pad
                            visible: !questionBlock.customOpen || !questionBlock.noteOpen

                            Text {
                                visible: !questionBlock.customOpen
                                text: "Something else…  Tab"
                                color: customReveal.containsMouse
                                    ? Theme.foreground : Theme.foregroundDim
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall

                                MouseArea {
                                    id: customReveal
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: {
                                        questionBlock.customOpen = true;
                                        customField.forceActiveFocus();
                                    }
                                }
                            }

                            Text {
                                visible: !questionBlock.noteOpen
                                text: "Add a note"
                                color: noteReveal.containsMouse
                                    ? Theme.foreground : Theme.foregroundDim
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall

                                MouseArea {
                                    id: noteReveal
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: {
                                        questionBlock.noteOpen = true;
                                        noteField.forceActiveFocus();
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        Text {
            id: errorText
            visible: root.error !== ""
            Layout.fillWidth: true
            text: root.error
            color: Theme.danger
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        RowLayout {
            id: actionRow
            Layout.fillWidth: true
            spacing: Theme.gap

            // Cancel, which the daemon has always accepted and nothing here
            // ever sent: a question you do not want to answer was a dead end
            // with the composer gone.
            Rectangle {
                implicitWidth: dismissLabel.implicitWidth + Theme.pad
                implicitHeight: 30
                radius: Theme.radius / 2
                color: dismissArea.containsMouse ? Theme.hover : "transparent"
                opacity: root.submitting ? 0.5 : 1

                Text {
                    id: dismissLabel
                    anchors.centerIn: parent
                    text: "Dismiss  Esc"
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                }

                MouseArea {
                    id: dismissArea
                    anchors.fill: parent
                    hoverEnabled: true
                    enabled: !root.submitting
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.dismiss()
                }
            }

            Rectangle {
                implicitWidth: chatLabel.implicitWidth + Theme.pad
                implicitHeight: 30
                radius: Theme.radius / 2
                color: chatArea.containsMouse ? Theme.hover : "transparent"
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
                    text: root.submitting ? "Sending…" : "Answer  ↵"
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
