pragma ComponentBehavior: Bound

// One place for the two capabilities that intentionally cross the machine's
// boundary: remote live voice and relay collaboration. Each URL remains
// selectable but is never logged; risky mutations are gated by explicit typed
// confirmation.
import QtQuick
import qs.services
import "ConnectState.js" as ConnectState

Rectangle {
    id: root

    property bool pendingWritable: false
    property string relayUrl: ""

    readonly property string liveTranscript: ConnectState.transcript(Ghostd.liveStatus)
    readonly property bool liveActive: ConnectState.liveActive(Ghostd.liveStatus)
        && !Ghostd.liveNotSupported
    readonly property bool collabActive: ConnectState.collabActive(Ghostd.collabStatus)
    readonly property string readOnlyUrl: ConnectState.readOnlyUrl(Ghostd.collabStatus)
    readonly property string writableUrl: ConnectState.writableUrl(Ghostd.collabStatus)

    implicitWidth: Theme.pad * 50
    implicitHeight: Theme.pad * 34
    color: Theme.background
    clip: true

    component UrlField: Rectangle {
        id: urlField

        required property string label
        required property string value

        width: parent ? parent.width : 0
        height: urlColumn.implicitHeight + Theme.pad
        radius: Theme.radius
        color: Theme.film(0.04)
        border.width: 1
        border.color: Theme.border

        Column {
            id: urlColumn
            anchors.left: parent.left
            anchors.leftMargin: Theme.pad / 2
            anchors.right: parent.right
            anchors.rightMargin: Theme.pad / 2
            anchors.verticalCenter: parent.verticalCenter
            spacing: 3

            Text {
                width: parent.width
                text: urlField.label + " · select and copy"
                color: Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeCaption
            }

            TextEdit {
                width: parent.width
                text: urlField.value
                readOnly: true
                selectByMouse: true
                color: Theme.foregroundBright
                selectionColor: Theme.selection
                selectedTextColor: Theme.foregroundBright
                font.family: Theme.fontFamilyMono
                font.pixelSize: Theme.fontSizeSmall
                wrapMode: TextEdit.WrapAnywhere
                textFormat: TextEdit.PlainText
            }
        }
    }

    Component.onCompleted: if (Ghostd.activeGhost !== "") Ghostd.fetchConnect(false)
    onVisibleChanged: if (root.visible && Ghostd.activeGhost !== "") Ghostd.fetchConnect(false)

    Timer {
        interval: 1000
        repeat: true
        running: root.visible && (root.liveActive || root.collabActive)
        onTriggered: {
            if (root.liveActive) Ghostd.fetchLive(true);
            if (root.collabActive) Ghostd.fetchCollab(true);
        }
    }

    Connections {
        target: Ghostd

        function onActiveGhostChanged(): void {
            root.pendingWritable = false;
            root.relayUrl = "";
            // Ghostd clears the old ghost's cached/request state in the same
            // selection turn. Defer until that transition has settled so the
            // new requests are not mistaken for the old ones and aborted.
            Qt.callLater(function () {
                if (root.visible && Ghostd.activeGhost !== "") Ghostd.fetchConnect(false);
            });
        }

        function onCollabActionFinished(action: string, writable: bool, ok: bool): void {
            if (action !== "start" || !writable) return;
            if (ok || Ghostd.collabNotSupported) root.pendingWritable = false;
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

        Row {
            width: parent.width
            spacing: Theme.gap

            Column {
                width: parent.width - refreshButton.width - Theme.gap
                spacing: Theme.gap / 3
                Text {
                    width: parent.width
                    text: "Remote"
                    color: Theme.foregroundBright
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeHeading
                    font.weight: Font.DemiBold
                }
                Text {
                    width: parent.width
                    text: "Speak live or invite someone through a relay."
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }
            }

            ActionButton {
                id: refreshButton
                label: Ghostd.liveLoading || Ghostd.collabLoading ? "Refreshing…" : "Refresh"
                enabled: Ghostd.activeGhost !== "" && !Ghostd.liveLoading
                    && !Ghostd.collabLoading && !Ghostd.liveMutating && !Ghostd.collabMutating
                onClicked: Ghostd.fetchConnect(true)
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

    Flickable {
        id: pageScroll
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: headerRule.bottom
        anchors.bottom: parent.bottom
        contentWidth: width
        contentHeight: page.implicitHeight + Theme.pad * 2
        clip: true
        interactive: contentHeight > height
        boundsBehavior: Flickable.StopAtBounds

        Column {
            id: page
            x: Theme.pad
            y: Theme.pad
            width: pageScroll.width - Theme.pad * 2
            spacing: Theme.sectionGap

            Rectangle {
                width: parent.width
                height: liveContent.implicitHeight + Theme.pad * 2
                radius: Theme.radius
                color: Theme.surface
                border.width: 1
                border.color: Theme.border

                Column {
                    id: liveContent
                    x: Theme.pad
                    y: Theme.pad
                    width: parent.width - Theme.pad * 2
                    spacing: Theme.gap

                    Row {
                        width: parent.width
                        spacing: Theme.gap
                        Column {
                            width: parent.width - liveActions.width - Theme.gap
                            spacing: 2
                            Text {
                                width: parent.width
                                text: "Live voice"
                                color: Theme.foregroundBright
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSubtitle
                                font.weight: Font.DemiBold
                            }
                            Text {
                                width: parent.width
                                text: "Remote OpenAI live voice for this conversation requires an OpenAI Codex OAuth connection. Audio leaves this machine while the session runs."
                                color: Theme.foregroundDim
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                wrapMode: Text.WordWrap
                            }
                        }
                        Row {
                            id: liveActions
                            spacing: Theme.gap / 2
                            ActionButton {
                                visible: !root.liveActive
                                label: Ghostd.liveMutating ? "Starting…" : "Start"
                                primary: true
                                enabled: !Ghostd.liveMutating && !Ghostd.liveNotSupported
                                    && Ghostd.activeGhost !== ""
                                onClicked: Ghostd.liveAction("start")
                            }
                            ActionButton {
                                visible: root.liveActive
                                label: ConnectState.muted(Ghostd.liveStatus) ? "Unmute" : "Mute"
                                enabled: !Ghostd.liveMutating
                                onClicked: Ghostd.liveAction(ConnectState.muted(Ghostd.liveStatus)
                                    ? "unmute" : "mute")
                            }
                            ActionButton {
                                visible: root.liveActive
                                label: Ghostd.liveMutating ? "Stopping…" : "Stop"
                                danger: true
                                enabled: !Ghostd.liveMutating
                                onClicked: Ghostd.liveAction("stop")
                            }
                        }
                    }

                    Rectangle {
                        width: parent.width
                        height: supportText.implicitHeight + Theme.pad
                        visible: Ghostd.liveNotSupported
                        radius: Theme.radius
                        color: Theme.film(0.05)
                        border.width: 1
                        border.color: Theme.border
                        Text {
                            id: supportText
                            anchors.left: parent.left
                            anchors.leftMargin: Theme.pad / 2
                            anchors.right: parent.right
                            anchors.rightMargin: Theme.pad / 2
                            anchors.verticalCenter: parent.verticalCenter
                            text: ConnectState.supportMessage(Ghostd.liveStatus,
                                "Live voice is not supported by this daemon build.")
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            wrapMode: Text.WordWrap
                        }
                    }

                    Row {
                        width: parent.width
                        visible: !Ghostd.liveNotSupported
                        spacing: Theme.gap
                        Text {
                            text: Ghostd.liveLoading ? "Loading…"
                                : "Phase: " + ConnectState.phaseLabel(Ghostd.liveStatus)
                            color: root.liveActive ? Theme.ghostAmber : Theme.foregroundDim
                            font.family: Theme.fontFamilyMono
                            font.pixelSize: Theme.fontSizeSmall
                        }
                        Rectangle {
                            anchors.verticalCenter: parent.verticalCenter
                            width: Math.max(72, parent.width - parent.children[0].width - Theme.gap)
                            height: 6
                            radius: 3
                            color: Theme.film(0.08)
                            Rectangle {
                                width: parent.width * ConnectState.level(Ghostd.liveStatus)
                                height: parent.height
                                radius: parent.radius
                                color: ConnectState.muted(Ghostd.liveStatus)
                                    ? Theme.foregroundFaint : Theme.ghostAmber
                            }
                        }
                    }

                    Text {
                        width: parent.width
                        visible: Ghostd.liveError !== ""
                        text: Ghostd.liveError
                        color: Theme.danger
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.WordWrap
                    }

                    Rectangle {
                        width: parent.width
                        height: liveTranscriptText.implicitHeight + Theme.pad
                        visible: root.liveTranscript !== ""
                        radius: Theme.radius
                        color: Theme.film(0.04)
                        Text {
                            id: liveTranscriptText
                            anchors.left: parent.left
                            anchors.leftMargin: Theme.pad / 2
                            anchors.right: parent.right
                            anchors.rightMargin: Theme.pad / 2
                            anchors.verticalCenter: parent.verticalCenter
                            text: root.liveTranscript
                            color: Theme.foreground
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            wrapMode: Text.WordWrap
                        }
                    }
                }
            }

            Rectangle {
                width: parent.width
                height: collabContent.implicitHeight + Theme.pad * 2
                radius: Theme.radius
                color: Theme.surface
                border.width: 1
                border.color: Theme.border

                Column {
                    id: collabContent
                    x: Theme.pad
                    y: Theme.pad
                    width: parent.width - Theme.pad * 2
                    spacing: Theme.gap

                    Text {
                        width: parent.width
                        text: "Remote collaboration"
                        color: Theme.foregroundBright
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSubtitle
                        font.weight: Font.DemiBold
                    }
                    Text {
                        width: parent.width
                        text: "For this conversation, a read-only link can observe. A writable link can steer the ghost and use its tools with your authority."
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.WordWrap
                    }

                    Rectangle {
                        width: parent.width
                        height: Theme.controlHeight
                        visible: !root.collabActive && !Ghostd.collabNotSupported
                        radius: Theme.radius
                        color: Theme.film(0.05)
                        border.width: relayInput.activeFocus ? 1 : 0
                        border.color: Theme.amber(0.45)
                        TextInput {
                            id: relayInput
                            anchors.fill: parent
                            anchors.leftMargin: Theme.pad
                            anchors.rightMargin: Theme.pad
                            verticalAlignment: TextInput.AlignVCenter
                            text: root.relayUrl
                            onTextChanged: root.relayUrl = text
                            enabled: !Ghostd.collabMutating
                            color: Theme.foregroundBright
                            selectionColor: Theme.selection
                            font.family: Theme.fontFamilyMono
                            font.pixelSize: Theme.fontSizeSmall
                            clip: true
                            Text {
                                anchors.fill: parent
                                verticalAlignment: Text.AlignVCenter
                                visible: relayInput.text === ""
                                text: "Optional relay URL (use daemon default when blank)"
                                color: Theme.foregroundFaint
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                elide: Text.ElideRight
                            }
                        }
                    }

                    Row {
                        spacing: Theme.gap
                        visible: !Ghostd.collabNotSupported
                        ActionButton {
                            visible: !root.collabActive
                            label: Ghostd.collabMutating ? "Starting…" : "Start read-only"
                            primary: true
                            enabled: !Ghostd.collabMutating && Ghostd.activeGhost !== ""
                            onClicked: Ghostd.collabAction("start", root.relayUrl, false)
                        }
                        ActionButton {
                            visible: !root.collabActive
                            label: "Start writable"
                            danger: true
                            enabled: !Ghostd.collabMutating && Ghostd.activeGhost !== ""
                            onClicked: root.pendingWritable = true
                        }
                        ActionButton {
                            visible: root.collabActive
                            label: Ghostd.collabMutating ? "Stopping…" : "Stop collaboration"
                            danger: true
                            enabled: !Ghostd.collabMutating
                            onClicked: Ghostd.collabAction("stop", "", false)
                        }
                    }

                    Rectangle {
                        width: parent.width
                        height: collabSupportText.implicitHeight + Theme.pad
                        visible: Ghostd.collabNotSupported
                        radius: Theme.radius
                        color: Theme.film(0.05)
                        border.width: 1
                        border.color: Theme.border
                        Text {
                            id: collabSupportText
                            anchors.left: parent.left
                            anchors.leftMargin: Theme.pad / 2
                            anchors.right: parent.right
                            anchors.rightMargin: Theme.pad / 2
                            anchors.verticalCenter: parent.verticalCenter
                            text: ConnectState.supportMessage(Ghostd.collabStatus,
                                "Remote collaboration is not supported by this daemon build.")
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            wrapMode: Text.WordWrap
                        }
                    }

                    Text {
                        width: parent.width
                        visible: Ghostd.collabError !== ""
                        text: Ghostd.collabError
                        color: Theme.danger
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.WordWrap
                    }

                    UrlField {
                        visible: root.readOnlyUrl !== ""
                        label: "Read-only URL"
                        value: root.readOnlyUrl
                    }
                    UrlField {
                        visible: root.writableUrl !== ""
                        label: "Writable URL · grants control"
                        value: root.writableUrl
                    }
                }
            }
        }
    }

    ConfirmDialog {
        anchors.fill: parent
        open: root.pendingWritable
        title: "Start writable collaboration?"
        body: "Anyone with the writable URL can steer this ghost and exercise its tools with your local authority. Treat the link like a password. Type WRITABLE to continue."
        challenge: "WRITABLE"
        challengePlaceholder: "WRITABLE"
        confirmText: "Start writable"
        busy: Ghostd.collabMutating
        error: root.pendingWritable ? Ghostd.collabError : ""
        onConfirmed: Ghostd.collabAction("start", root.relayUrl, true)
        onDismissed: if (!Ghostd.collabMutating) root.pendingWritable = false
    }
}
