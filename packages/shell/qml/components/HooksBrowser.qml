pragma ComponentBehavior: Bound

// Ghost's lifecycle hooks: the ones the daemon registers in code, and the
// owner's own command hooks from hooks.json. A built-in row shows what the
// daemon runs; when hooks.json can tune it (memory upkeep's idle interval),
// clicking it edits that one number, applied when ghostd next starts. A
// command hook is the owner's: click it to edit its fields in place, ×
// removes it, "+ New" adds one. Every edit replaces the whole file through
// the daemon's validating loader, so a refused edit reopens with the daemon's
// reason and nothing is half-written. Model context stays private either way.
//
// While a card is being edited the list is frozen on the cards it had, so a
// status refresh cannot rebuild the delegates under the caret.
import QtQuick
import "../services"
import "../services/HookStatus.js" as HookStatus
import "../services/HookConfig.js" as HookConfig

Rectangle {
    id: root

    /** The card being edited ("draft" for a new one) and the fields as typed. */
    property string editingKey: ""
    property string draftEvent: "session_stop"
    property var fields: HookConfig.blankFields()
    property var frozenCards: []
    /** What the last commit sent, so a refused write can hand the fields back. */
    property var lastAttempt: null

    readonly property var liveCards: HookConfig.cards(Ghostd.activeHooks, Ghostd.hookConfig)
    readonly property bool editing: root.editingKey !== ""
    readonly property bool drafting: root.editingKey === HookConfig.DRAFT_KEY
    readonly property var cards: root.editing ? root.frozenCards : root.liveCards
    readonly property var rows: root.drafting ? [HookConfig.draftCard()].concat(root.cards) : root.cards
    readonly property bool busy: Ghostd.hookConfigBusy
    readonly property bool editable: Ghostd.hookConfigLoaded && Ghostd.hookConfigAvailable
    readonly property string error: Ghostd.hookConfigError !== ""
        ? Ghostd.hookConfigError : Ghostd.hooksError

    implicitWidth: Theme.pad * 48
    implicitHeight: Theme.pad * 34
    color: Theme.background
    clip: true

    function load(force: bool): void {
        Ghostd.fetchHooks(force);
        Ghostd.fetchHookConfig(force);
    }

    function canEdit(card: var): bool {
        return !!card && card.source === "config";
    }

    /** Open one card's form over a frozen list, starting from `fields` as typed. */
    function open(key: string, event: string, fields: var): void {
        if (root.busy || root.editing || !root.editable) return;
        root.frozenCards = root.liveCards;
        root.fields = Object.assign(HookConfig.blankFields(), fields);
        root.draftEvent = event;
        root.editingKey = key;
    }

    function beginEdit(card: var): void {
        if (root.canEdit(card)) root.open(card.key, card.event, card.fields);
    }

    function beginDraft(): void {
        root.open(HookConfig.DRAFT_KEY, "session_stop", null);
    }

    function endEdit(): void {
        root.editingKey = "";
        root.fields = HookConfig.blankFields();
        root.frozenCards = [];
    }

    function setField(name: string, value: string): void {
        const next = Object.assign({}, root.fields);
        next[name] = value;
        root.fields = next;
    }

    /** Save is explicit: a form with several fields cannot treat one field's blur as done. */
    function commitEdit(): void {
        if (!root.editing) return;
        const attempt = { key: root.editingKey, event: root.draftEvent, fields: root.fields };
        const current = Ghostd.hookConfig;
        let document = null;
        if (root.drafting) {
            if (attempt.fields.command.trim() !== "")
                document = HookConfig.withNewHandler(current, attempt.event, attempt.fields);
        } else {
            const card = HookConfig.find(root.frozenCards, attempt.key);
            if (card) {
                document = HookConfig.withHandler(current, card.event, card.groupIndex,
                    card.handlerIndex, attempt.fields);
            }
        }
        root.endEdit();
        if (document === null || HookConfig.same(document, current)) return;
        root.lastAttempt = attempt;
        Ghostd.writeHookConfig(document);
    }

    function remove(card: var): void {
        if (root.busy || root.editing || !card || card.source !== "config") return;
        root.lastAttempt = null;
        Ghostd.writeHookConfig(HookConfig.withoutHandler(Ghostd.hookConfig, card.event,
            card.groupIndex, card.handlerIndex));
    }

    Component.onCompleted: root.load(false)
    onVisibleChanged: {
        if (root.visible) root.load(false);
        else root.endEdit();
    }

    Connections {
        target: Ghostd

        // A refused write hands the fields back rather than losing them: the
        // card reopens with what was typed, under the daemon's reason.
        function onHookConfigWriteFinished(ok: bool): void {
            const attempt = root.lastAttempt;
            root.lastAttempt = null;
            if (!ok && attempt) root.open(attempt.key, attempt.event, attempt.fields);
        }
    }

    // One labelled field of the edit form: an InlineRename in a bordered
    // box. Enter alone does nothing here — a form with several fields saves
    // on Ctrl+Enter, and Esc discards the whole edit.
    component Field: Column {
        id: field
        property string label
        property string name
        property string placeholder
        property bool mono: false
        property bool takeFocus: false

        width: parent.width
        spacing: Theme.gap / 3

        Text {
            width: parent.width
            text: field.label
            textFormat: Text.PlainText
            color: Theme.foregroundFaint
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeCaption
        }

        Rectangle {
            width: parent.width
            height: input.implicitHeight + Theme.gap
            radius: Theme.radius / 2
            color: Theme.film(0.05)
            border.width: 1
            border.color: input.activeFocus ? Theme.amber(0.55) : Theme.border

            InlineRename {
                id: input
                objectName: "hookField-" + field.name
                anchors.left: parent.left
                anchors.leftMargin: Theme.gap
                anchors.right: parent.right
                anchors.rightMargin: Theme.gap
                anchors.verticalCenter: parent.verticalCenter
                placeholder: field.placeholder
                text: root.fields[field.name] || ""
                font.family: field.mono ? Theme.fontFamilyMono : Theme.fontFamily
                Accessible.name: field.label

                onEdited: value => { if (value !== (root.fields[field.name] || "")) root.setField(field.name, value); }
                onCancelled: root.endEdit()
                Keys.onPressed: event => {
                    if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter)
                            && (event.modifiers & Qt.ControlModifier)) {
                        root.commitEdit();
                        event.accepted = true;
                    }
                }
                Component.onCompleted: if (field.takeFocus) input.forceActiveFocus()
            }
        }
    }

    Column {
        id: header
        anchors.left: parent.left
        anchors.leftMargin: Theme.pad
        anchors.right: parent.right
        anchors.rightMargin: Theme.pad
        anchors.top: parent.top
        anchors.topMargin: Theme.pad
        spacing: Theme.gap

        Item {
            width: parent.width
            height: Math.max(titles.implicitHeight, buttons.height)

            Column {
                id: titles
                anchors.left: parent.left
                anchors.right: buttons.left
                anchors.rightMargin: Theme.gap
                spacing: Theme.gap / 3

                Text {
                    objectName: "hooksTitle"
                    width: parent.width
                    text: "Hooks"
                    textFormat: Text.PlainText
                    color: Theme.foregroundBright
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeHeading
                    font.weight: Font.DemiBold
                }

                Text {
                    objectName: "hooksSummary"
                    width: parent.width
                    text: root.busy ? "Saving…"
                        : Ghostd.activeHookCount === 0
                            ? "No lifecycle hooks are loaded."
                            : Ghostd.activeHookCount + (Ghostd.activeHookCount === 1
                                ? " lifecycle hook is loaded."
                                : " lifecycle hooks are loaded.")
                    textFormat: Text.PlainText
                    color: root.busy ? Theme.ghostAmber : Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }
            }

            Row {
                id: buttons
                anchors.right: parent.right
                anchors.top: parent.top
                spacing: Theme.gap

                ActionButton {
                    objectName: "hooksNewButton"
                    label: "+ New"
                    enabled: root.editable && !root.busy && !root.editing
                    Accessible.description: "Add a command hook to hooks.json"
                    onClicked: root.beginDraft()
                }

                ActionButton {
                    objectName: "hooksRefreshButton"
                    label: Ghostd.hooksLoading ? "Refreshing" : "Refresh"
                    enabled: !Ghostd.hooksLoading && !root.editing
                    Accessible.description: "Reload hook status and configuration"
                    onClicked: root.load(true)
                }
            }
        }
    }

    Rectangle {
        id: headerRule
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        anchors.topMargin: Theme.pad
        height: 1
        color: Theme.border
    }

    Rectangle {
        id: errorBanner
        objectName: "hooksErrorBanner"
        anchors.left: parent.left
        anchors.leftMargin: Theme.pad
        anchors.right: parent.right
        anchors.rightMargin: Theme.pad
        anchors.top: headerRule.bottom
        anchors.topMargin: visible ? Theme.pad : 0
        height: visible ? hookError.implicitHeight + Theme.pad : 0
        visible: root.error !== ""
        radius: Theme.radius
        color: Theme.rose(0.08)
        border.width: visible ? 1 : 0
        border.color: Theme.rose(0.18)

        Text {
            id: hookError
            objectName: "hooksErrorText"
            anchors.left: parent.left
            anchors.leftMargin: Theme.pad / 2
            anchors.right: parent.right
            anchors.rightMargin: Theme.pad / 2
            anchors.verticalCenter: parent.verticalCenter
            text: root.error
            textFormat: Text.PlainText
            color: Theme.danger
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.WordWrap
        }
    }

    Text {
        id: initialState
        objectName: "hooksInitialState"
        anchors.left: parent.left
        anchors.leftMargin: Theme.pad * 2
        anchors.right: parent.right
        anchors.rightMargin: Theme.pad * 2
        anchors.top: errorBanner.bottom
        anchors.topMargin: Theme.pad * 2
        visible: !Ghostd.hooksLoaded && root.rows.length === 0
        text: Ghostd.hooksLoading ? "Loading lifecycle hooks…"
            : (Ghostd.hooksError === ""
                ? "Hook status has not loaded yet."
                : "Hook status is unavailable. Retry when ghostd is answering.")
        textFormat: Text.PlainText
        color: Theme.foregroundFaint
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSize
        wrapMode: Text.WordWrap
        horizontalAlignment: Text.AlignHCenter
    }

    Text {
        id: emptyState
        objectName: "hooksEmptyState"
        anchors.left: parent.left
        anchors.leftMargin: Theme.pad * 2
        anchors.right: parent.right
        anchors.rightMargin: Theme.pad * 2
        anchors.top: errorBanner.bottom
        anchors.topMargin: Theme.pad * 2
        visible: Ghostd.hooksLoaded && root.rows.length === 0
        text: root.editable
            ? "No lifecycle hooks are loaded. Add a command hook with + New."
            : "No lifecycle hooks are loaded by the daemon."
        textFormat: Text.PlainText
        color: Theme.foregroundFaint
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSize
        wrapMode: Text.WordWrap
        horizontalAlignment: Text.AlignHCenter
    }

    ListView {
        id: hookList
        objectName: "hooksList"
        anchors.left: parent.left
        anchors.leftMargin: Theme.pad
        anchors.right: parent.right
        anchors.rightMargin: Theme.pad
        anchors.top: errorBanner.bottom
        anchors.topMargin: Theme.pad
        anchors.bottom: privacyNote.top
        anchors.bottomMargin: Theme.pad
        visible: root.rows.length > 0
        clip: true
        spacing: Theme.gap
        boundsBehavior: Flickable.StopAtBounds
        model: root.rows

        delegate: Rectangle {
            id: hookCard
            required property var modelData
            readonly property bool config: hookCard.modelData.source === "config"
            readonly property bool tunable: root.canEdit(hookCard.modelData)
            readonly property bool editing: root.editingKey === hookCard.modelData.key
            readonly property bool draft: hookCard.modelData.key === HookConfig.DRAFT_KEY
            readonly property string event: hookCard.draft ? root.draftEvent : hookCard.modelData.event

            objectName: "hookCard"
            width: ListView.view.width
            height: (hookCard.editing ? editor.height : hookColumn.implicitHeight) + Theme.pad * 1.5
            radius: Theme.radius
            color: hookCard.editing ? Theme.amber(0.08)
                : (cardArea.containsMouse && cardArea.enabled ? Theme.film(0.07) : Theme.film(0.04))
            border.width: 1
            border.color: hookCard.editing ? Theme.amber(0.35) : Theme.border

            Accessible.role: hookCard.tunable ? Accessible.ListItem : Accessible.StaticText
            Accessible.name: hookCard.draft ? "New command hook" : hookCard.modelData.name
            Accessible.description: hookCard.modelData.description + ". "
                + HookStatus.trigger(hookCard.event)

            Behavior on color {
                enabled: !Theme.reducedMotion
                ColorAnimation { duration: Theme.durFast }
            }

            MouseArea {
                id: cardArea
                anchors.fill: parent
                enabled: hookCard.tunable && !hookCard.editing && !root.editing && !root.busy
                hoverEnabled: true
                cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                onClicked: root.beginEdit(hookCard.modelData)
            }

            Column {
                id: hookColumn
                anchors.left: parent.left
                anchors.leftMargin: Theme.pad
                anchors.right: parent.right
                anchors.rightMargin: Theme.pad
                anchors.top: parent.top
                anchors.topMargin: Theme.pad * 0.75
                visible: !hookCard.editing
                spacing: Theme.gap / 3

                // ---- read view
                Row {
                    width: parent.width
                    spacing: Theme.gap

                    Text {
                        objectName: "hookName"
                        width: parent.width - sourceTag.width - deleteButton.width - Theme.gap * 2
                        text: hookCard.modelData.name
                        textFormat: Text.PlainText
                        color: Theme.foregroundBright
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize
                        font.weight: Font.DemiBold
                        wrapMode: Text.Wrap
                    }

                    Text {
                        id: sourceTag
                        objectName: "hookSource"
                        anchors.verticalCenter: parent.verticalCenter
                        text: hookCard.config ? "hooks.json" : "built in"
                        textFormat: Text.PlainText
                        color: Theme.foregroundFaint
                        font.family: Theme.fontFamilyMono
                        font.pixelSize: Theme.fontSizeCaption
                    }

                    Item {
                        id: deleteButton
                        objectName: "hookDeleteButton"
                        anchors.verticalCenter: parent.verticalCenter
                        width: hookCard.config ? Theme.controlHeight - Theme.gap : 0
                        height: Theme.controlHeight - Theme.gap
                        visible: hookCard.config

                        Accessible.role: Accessible.Button
                        Accessible.name: "Remove " + hookCard.modelData.name

                        Rectangle {
                            anchors.fill: parent
                            radius: Theme.radius / 2
                            color: deleteArea.containsMouse && deleteArea.enabled
                                ? Theme.rose(0.12) : "transparent"

                            Text {
                                anchors.centerIn: parent
                                text: "×"
                                color: deleteArea.containsMouse && deleteArea.enabled
                                    ? Theme.danger : Theme.foregroundFaint
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeTitle
                            }

                            MouseArea {
                                id: deleteArea
                                anchors.fill: parent
                                enabled: hookCard.config && !root.busy && !root.editing
                                hoverEnabled: true
                                cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                                onClicked: root.remove(hookCard.modelData)
                            }
                        }
                    }
                }

                Text {
                    objectName: "hookDescription"
                    width: parent.width
                    visible: text !== ""
                    text: hookCard.modelData.description
                    textFormat: Text.PlainText
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }

                Text {
                    objectName: "hookCommand"
                    width: parent.width
                    visible: hookCard.config
                    text: hookCard.modelData.fields.command
                    textFormat: Text.PlainText
                    color: Theme.foreground
                    font.family: Theme.fontFamilyMono
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WrapAnywhere
                }

                Text {
                    objectName: "hookTrigger"
                    width: parent.width
                    text: HookStatus.trigger(hookCard.event)
                    textFormat: Text.PlainText
                    color: Theme.ghostAmber
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeCaption
                    wrapMode: Text.WordWrap
                }
            }

            // ---- edit view
            Loader {
                id: editor
                objectName: "hookEditor"
                anchors.left: parent.left
                anchors.leftMargin: Theme.pad
                anchors.right: parent.right
                anchors.rightMargin: Theme.pad
                anchors.top: parent.top
                anchors.topMargin: Theme.pad * 0.75
                active: hookCard.editing
                visible: active

                sourceComponent: Column {
                    objectName: "hookForm"
                    width: editor.width
                    spacing: Theme.gap

                    Row {
                        objectName: "hookEventChoice"
                        visible: hookCard.draft
                        spacing: Theme.gap / 2

                        Repeater {
                            model: HookStatus.EVENT_ORDER

                            Rectangle {
                                id: chip
                                required property string modelData
                                readonly property bool chosen: root.draftEvent === chip.modelData

                                width: chipLabel.implicitWidth + Theme.pad
                                height: Theme.controlHeight - Theme.gap / 2
                                radius: height / 2
                                color: chip.chosen ? Theme.amber(0.22) : Theme.film(0.05)
                                border.width: 1
                                border.color: chip.chosen ? Theme.amber(0.55) : Theme.border

                                Accessible.role: Accessible.RadioButton
                                Accessible.name: HookStatus.label(chip.modelData)
                                Accessible.checked: chip.chosen

                                Text {
                                    id: chipLabel
                                    anchors.centerIn: parent
                                    text: HookStatus.label(chip.modelData)
                                    textFormat: Text.PlainText
                                    color: chip.chosen ? Theme.ghostAmberBright : Theme.foregroundDim
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                }

                                MouseArea {
                                    anchors.fill: parent
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: root.draftEvent = chip.modelData
                                }
                            }
                        }
                    }

                    Field {
                        label: "Command"
                        name: "command"
                        placeholder: "/absolute/path/to/hook --flag"
                        mono: true
                        takeFocus: true
                    }

                    Field {
                        label: "Name"
                        name: "name"
                        placeholder: "Shown here; the daemon names it if blank"
                    }

                    Field {
                        label: "Description"
                        name: "description"
                        placeholder: "One line on what it does"
                    }

                    Field {
                        width: (parent.width - Theme.gap) / 2
                        label: "Timeout (seconds, default 30)"
                        name: "timeout"
                        placeholder: "30"
                    }

                    Row {
                        spacing: Theme.gap

                        ActionButton {
                            objectName: "hookSaveButton"
                            label: "Save"
                            primary: true
                            enabled: root.fields.command.trim() !== ""
                            onClicked: root.commitEdit()
                        }

                        ActionButton {
                            objectName: "hookCancelButton"
                            label: "Cancel"
                            onClicked: root.endEdit()
                        }

                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            text: "Ctrl+Enter saves · Esc discards"
                            textFormat: Text.PlainText
                            color: Theme.foregroundFaint
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeCaption
                        }
                    }
                }
            }
        }
    }

    Text {
        id: privacyNote
        objectName: "hooksPrivacyNote"
        anchors.left: parent.left
        anchors.leftMargin: Theme.pad
        anchors.right: parent.right
        anchors.rightMargin: Theme.pad
        anchors.bottom: parent.bottom
        anchors.bottomMargin: Theme.pad
        visible: root.rows.length > 0
        text: Ghostd.hooksStale
            ? "Showing the last verified status."
            : root.editable
                ? "Command hooks are yours, in " + Ghostd.hookConfigPath
                    + ". Built-in hooks are part of ghostd. Model context stays private."
                : "Only labels, triggers, and timing are shown. Model context stays private."
        textFormat: Text.PlainText
        color: Theme.foregroundFaint
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeSmall
        wrapMode: Text.WordWrap
    }
}
