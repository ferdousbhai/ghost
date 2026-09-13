pragma ComponentBehavior: Bound

// AskDialog — the daemon's `ask` tool, rendered where the composer normally sits.
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
import "../services"

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

    /**
     * A question's options, however QML handed them over. A Repeater delivers
     * its `modelData` as a variant map, whose nested arrays index and measure
     * like arrays but fail `Array.isArray` — and every delegate here reads its
     * question that way, while the keyboard paths read the JS original. One
     * accessor, or the two halves of this form disagree about what is selected:
     * the screen shows nothing chosen while Enter submits the recommendation.
     */
    function optionsOf(question: var): var {
        const options = question ? question.options : undefined;
        const count = options && typeof options.length === "number" ? options.length : 0;
        const out = [];
        for (let i = 0; i < count; i++) out.push(options[i]);
        return out;
    }

    // Every option in the interaction, flattened to one sequence, so Up/Down
    // run past the end of a question into the next one instead of stopping at
    // a boundary the reader cannot see.
    readonly property var rows: {
        const out = [];
        for (let q = 0; q < root.questions.length; q++) {
            const count = root.optionsOf(root.questions[q]).length;
            for (let o = 0; o < count; o++) out.push({ question: q, option: o });
        }
        return out;
    }

    property int cursor: 0
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
    // `Date.parse` of anything unparseable is NaN, and NaN fails `> 0`.
    readonly property real deadline: root.timeoutAt === "" ? 0 : Date.parse(root.timeoutAt)
    readonly property bool timed: root.deadline > 0
    property real clock: Date.now()
    readonly property real remaining: (root.deadline - root.clock) / 1000

    // A two-minute deadline counted down from 2:00 is a clock the owner has to
    // watch, and for most of that wait the number says nothing they can act on.
    // So the line stays a sentence until `lead` seconds are left, becomes a
    // count only then, and only goes amber inside `urgent`. The tick timer
    // follows the same rule: running it for the whole wait is 120 wakeups spent
    // redrawing a number nobody needed.
    readonly property int lead: 30
    readonly property int urgent: 10
    readonly property bool counting: root.timed && root.remaining <= root.lead

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

    // Both timers below stop while this is hidden, so the clock it comes back
    // with is as old as the time spent away.
    onVisibleChanged: if (root.visible) root.clock = Date.now();

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
        const options = root.optionsOf(question);
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


    /** `rows` opens with question 0's options in order, so the recommended
        option's index is already the row index — nothing to search for. */
    function defaultCursor(): int {
        const first = root.questions.length > 0 ? root.questions[0] : undefined;
        if (first === undefined) return 0;
        const count = root.optionsOf(first).length;
        const wanted = typeof first.recommended === "number" ? first.recommended : 0;
        return wanted >= 0 && wanted < count ? wanted : 0;
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
        const question = root.questions[row.question];
        const option = root.optionsOf(question)[row.option];
        if (option === undefined) return;
        root.toggle(question, option.label);
    }

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
        return Math.max(0, Math.round(seconds)) + "s";
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

    // Only ever running behind a number that is on screen and still moving.
    Timer {
        interval: 1000
        repeat: true
        running: root.visible && root.counting && root.remaining > 0
        onTriggered: root.clock = Date.now()
    }

    // The quiet part of the wait costs one wakeup. It moves the clock, which is
    // what turns the sentence into a count and starts the ticker above.
    Timer {
        interval: Math.max(0, root.deadline - root.clock - root.lead * 1000)
        running: root.visible && root.timed && !root.counting
        onTriggered: root.clock = Date.now()
    }

    // An inline component sees nothing of the file around it, so each of these
    // takes what it needs as properties and reports back as signals.

    // Two fields, one shape: a wrapping answer field and, under it, the note.
    // Enter answers from either — Shift+Enter breaks the line, as in the
    // composer — and Tab/Backtab hand the caret back to whoever owns the order.
    // `quiet` is the whole of the difference between them.
    component Field: Rectangle {
        id: fieldRoot

        required property string placeholder
        property string value: ""
        property bool quiet: false

        signal edited(string text)
        signal accepted()
        signal tabbed()
        signal backtabbed()

        function take(): void {
            fieldEdit.forceActiveFocus();
        }

        height: Math.max(fieldEdit.implicitHeight + Theme.gap, fieldRoot.quiet ? 30 : 34)
        radius: Theme.radius / 2
        color: fieldRoot.quiet ? "transparent" : Theme.surfaceDeep
        border.width: 1
        border.color: fieldEdit.activeFocus ? Theme.accent : Theme.border

        TextEdit {
            id: fieldEdit
            anchors.fill: parent
            anchors.margins: Theme.gap / 2
            text: fieldRoot.value
            color: fieldRoot.quiet ? Theme.foreground : Theme.foregroundBright
            font.family: Theme.fontFamily
            font.pixelSize: fieldRoot.quiet ? Theme.fontSizeSmall : Theme.fontSize
            wrapMode: TextEdit.Wrap
            selectByMouse: true
            selectionColor: Theme.selection
            selectedTextColor: Theme.foregroundBright
            onTextChanged: fieldRoot.edited(text)

            Keys.onPressed: event => {
                const enter = event.key === Qt.Key_Return || event.key === Qt.Key_Enter;
                if (enter && !(event.modifiers & Qt.ShiftModifier)) {
                    event.accepted = true;
                    fieldRoot.accepted();
                } else if (event.key === Qt.Key_Tab) {
                    event.accepted = true;
                    fieldRoot.tabbed();
                } else if (event.key === Qt.Key_Backtab) {
                    event.accepted = true;
                    fieldRoot.backtabbed();
                }
            }

            Text {
                anchors.fill: parent
                visible: fieldEdit.text === ""
                text: fieldRoot.placeholder
                color: Theme.foregroundDim
                font: fieldEdit.font
                wrapMode: Text.Wrap
            }
        }
    }

    // The way in to a folded-away field. Deliberately not a button: it is an
    // offer, and a bordered control would read louder than the field it hides.
    component Reveal: Text {
        id: revealRoot

        signal picked()

        color: revealArea.containsMouse ? Theme.foreground : Theme.foregroundDim
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeSmall

        MouseArea {
            id: revealArea
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: revealRoot.picked()
        }
    }

    // One control, three settings. Only the primary one wears the accent, and
    // only while there is something to send; `armed` decides both the fill and
    // whether the pointer is offered at all, `faded` says a send is in flight.
    component ActionButton: Rectangle {
        id: buttonRoot

        required property string label
        property color ink: Theme.foreground
        property bool primary: false
        property bool armed: true
        property bool faded: false

        signal activated()

        implicitWidth: buttonLabel.implicitWidth + Theme.pad
        implicitHeight: 30
        radius: Theme.radius / 2
        color: buttonRoot.primary
            ? (buttonRoot.armed ? Theme.accent : Theme.borderStrong)
            : (buttonArea.containsMouse ? Theme.hover : "transparent")
        opacity: buttonRoot.faded ? 0.5 : 1

        Text {
            id: buttonLabel
            anchors.centerIn: parent
            text: buttonRoot.label
            color: buttonRoot.primary
                ? (buttonRoot.armed ? Theme.onAccent : Theme.foregroundDim)
                : buttonRoot.ink
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            font.weight: buttonRoot.primary ? Font.DemiBold : Font.Normal
        }

        MouseArea {
            id: buttonArea
            anchors.fill: parent
            hoverEnabled: true
            enabled: buttonRoot.armed && !buttonRoot.faded
            cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
            onClicked: buttonRoot.activated()
        }
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
                font.pixelSize: Theme.fontSizeSubtitle
                font.weight: Font.DemiBold
                // fillWidth without this is a floor, not a ceiling: in a narrow
                // HUD the title keeps its whole implicit width and runs under
                // the deadline beside it. The deadline is the line that has to
                // stay whole — it is the one saying the clock is running.
                elide: Text.ElideRight
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
            // and not decoration — but a warning is only information near the
            // end, which is where the number appears.
            Text {
                visible: root.timed
                text: root.remaining <= 0 ? "out of time"
                    : root.counting ? "auto-answers in " + root.countdown(root.remaining)
                    : "answers itself if nobody replies"
                color: root.remaining <= root.urgent ? Theme.warn : Theme.foregroundDim
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
                        readonly property var options: root.optionsOf(modelData)
                        readonly property bool hasOptions: options.length > 0
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
                                    customField.take();
                                } else if (root.focusTarget.field === "note") {
                                    questionBlock.noteOpen = true;
                                    noteField.take();
                                }
                            }
                        }

                        Row {
                            width: parent.width
                            spacing: Theme.gap

                            Rectangle {
                                // Absent fields arrive as `undefined`, which is
                                // not a bool: coerced here, or every render
                                // costs a QML warning for a field nobody sent.
                                visible: (questionBlock.question.header || "").trim() !== ""
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
                            model: questionBlock.options

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
                                border.width: optionRow.atCursor && root.activeFocus ? 1 : 0
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
                                            visible: (optionRow.modelData.description
                                                || "").trim() !== ""
                                            width: parent.width
                                            text: optionRow.modelData.description || ""
                                            color: Theme.foregroundDim
                                            font.family: Theme.fontFamily
                                            font.pixelSize: Theme.fontSizeSmall
                                            wrapMode: Text.Wrap
                                        }

                                        Text {
                                            visible: optionRow.chosen
                                                && (optionRow.modelData.preview || "").trim() !== ""
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
                                        color: optionRow.atCursor && root.activeFocus
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

                        // "Type your own" is where the answer nobody anticipated
                        // goes, and it is the only field a text-only question
                        // has. Tab from it reaches the note; Backtab gives the
                        // keyboard back to the form.
                        Field {
                            id: customField
                            width: questionBlock.width
                            visible: questionBlock.customOpen
                            placeholder: questionBlock.hasOptions
                                ? "Type your own answer" : "Type your answer"
                            value: root.answerState(questionBlock.question).customInput
                            onEdited: written => root.setCustom(questionBlock.question, written)
                            onAccepted: root.submit()
                            onTabbed: {
                                questionBlock.noteOpen = true;
                                noteField.take();
                            }
                            onBacktabbed: root.forceActiveFocus()
                        }

                        Field {
                            id: noteField
                            width: questionBlock.width
                            visible: questionBlock.noteOpen
                            quiet: true
                            placeholder: "A note for the ghost (optional)"
                            value: root.answerState(questionBlock.question).note
                            onEdited: written => root.setNote(questionBlock.question, written)
                            onAccepted: root.submit()
                            onTabbed: root.forceActiveFocus()
                            onBacktabbed: {
                                questionBlock.customOpen = true;
                                customField.take();
                            }
                        }

                        // The way in to the folded-away fields, under whichever
                        // of them is already open. Tab does the same thing and
                        // says so, because this row leaves once both are out.
                        Row {
                            width: parent.width
                            spacing: Theme.pad
                            visible: !questionBlock.customOpen || !questionBlock.noteOpen

                            Reveal {
                                visible: !questionBlock.customOpen
                                text: "Something else…  Tab"
                                onPicked: {
                                    questionBlock.customOpen = true;
                                    customField.take();
                                }
                            }

                            Reveal {
                                visible: !questionBlock.noteOpen
                                text: "Add a note"
                                onPicked: {
                                    questionBlock.noteOpen = true;
                                    noteField.take();
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
            ActionButton {
                label: "Dismiss  Esc"
                ink: Theme.foregroundDim
                faded: root.submitting
                onActivated: root.dismiss()
            }

            ActionButton {
                label: "Chat about this"
                faded: root.submitting
                onActivated: root.chatRequested()
            }

            Item { Layout.fillWidth: true }

            ActionButton {
                primary: true
                label: root.submitting ? "Sending…" : "Answer  ↵"
                armed: root.canSubmit()
                faded: root.submitting
                onActivated: root.submit()
            }
        }
    }
}
