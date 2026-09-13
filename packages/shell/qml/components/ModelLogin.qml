pragma ComponentBehavior: Bound

// ModelLogin — "Connect a model": sign the active ghost into a provider
// (an OpenAI Codex / ChatGPT subscription, OpenRouter, an API key, …) without
// a terminal. It drives the daemon's login state machine through the Ghostd
// service: pick a provider, then follow whatever step the daemon reports —
// open an auth URL, read a device code, paste a code or key, or choose an
// option — to a ghost that lands ready to chat.
//
// Every step to show comes from Ghostd.loginState (the daemon's view); this
// component only renders it and posts the user's answers back. Secrets are
// typed into a masked field and sent straight to the daemon — never held here
// beyond the keystroke.
import QtQuick
import QtQuick.Layouts
import "../services"

Rectangle {
    id: root

    signal closeRequested()

    property string requestedProvider: ""

    // The current daemon-reported step, unpacked with guards (no nested access
    // on a possibly-empty object).
    readonly property var view: Ghostd.loginState
    readonly property bool picking: Ghostd.loginId === ""
    readonly property string status: root.view && root.view.status ? root.view.status : ""
    readonly property string authUrl: root.view && root.view.authUrl ? root.view.authUrl : ""
    readonly property string authInstructions: root.view && root.view.authInstructions ? root.view.authInstructions : ""
    readonly property string deviceCode: root.view && root.view.deviceCode ? root.view.deviceCode : ""
    readonly property string verificationUrl: root.view && root.view.verificationUrl ? root.view.verificationUrl : ""
    readonly property var prompt: root.view && root.view.prompt ? root.view.prompt : null
    readonly property string message: root.view && root.view.message ? root.view.message : ""
    readonly property string errorText: (root.view && root.view.error ? root.view.error : "") || Ghostd.loginError

    radius: Theme.radius
    color: Theme.background

    function open(provider: string): void {
        codeField.text = "";
        root.requestedProvider = provider;
        Ghostd.resetLogin();
        Ghostd.fetchProviders();
        Qt.callLater(root.focusRequestedProvider);
    }

    function close(): void {
        codeField.text = "";
        Ghostd.cancelLogin();
        root.closeRequested();
    }

    function focusRequestedProvider(): void {
        if (!root.visible || !root.picking || root.requestedProvider === "") return;
        for (let index = 0; index < providerRepeater.count; index += 1) {
            const provider = Ghostd.providers[index];
            if (!provider || provider.id !== root.requestedProvider) continue;
            const row = providerRepeater.itemAt(index);
            if (!row) return;
            row.focus = true;
            row.forceActiveFocus();
            const top = row.y;
            const bottom = top + row.height;
            if (top < providerList.contentY) providerList.contentY = top;
            else if (bottom > providerList.contentY + providerList.height)
                providerList.contentY = Math.max(0, bottom - providerList.height);
            return;
        }
    }

    onVisibleChanged: if (!visible) {
        codeField.text = "";
        root.requestedProvider = "";
        Ghostd.cancelLogin();
    }
    Component.onDestruction: Ghostd.cancelLogin()

    // A provider restart, ghost switch, or external reset can end the flow
    // without changing this persistent component's visibility. The generation
    // deliberately stays stable during a same-flow rename pause, so a rejected
    // submit may remain editable there but never cross into a different flow.
    Connections {
        target: Ghostd
        function onLoginGenerationChanged(): void { codeField.text = ""; }
        function onProvidersChanged(): void {
            Qt.callLater(root.focusRequestedProvider);
        }
    }

    function submitCurrentInput(): void {
        const value = codeField.text;
        if (value === "") return;
        if (Ghostd.submitLoginInput(value)) codeField.text = "";
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Theme.pad
        spacing: Theme.gap

        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.gap

            Text {
                text: "Connect a model"
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSubtitle
                font.weight: Font.DemiBold
            }

            Text {
                text: Ghostd.activeGhost === "" ? "" : "· " + Ghostd.activeGhost
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }

            Item { Layout.fillWidth: true }

            Text {
                text: "Close"
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.close()
                }
            }
        }

        Flickable {
            id: providerList
            objectName: "providerList"
            visible: root.picking
            Layout.fillWidth: true
            Layout.fillHeight: true
            contentWidth: width
            contentHeight: providerColumn.implicitHeight
            clip: true
            interactive: contentHeight > height
            onContentHeightChanged: Qt.callLater(root.focusRequestedProvider)

            Column {
                id: providerColumn
                width: parent.width
                spacing: Theme.gap

                Text {
                    visible: Ghostd.providers.length === 0
                    width: parent.width
                    text: Ghostd.loginError !== ""
                        ? Ghostd.loginError
                        : "Loading providers…"
                    color: Ghostd.loginError !== "" ? Theme.danger : Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                    wrapMode: Text.Wrap
                }

                Repeater {
                    id: providerRepeater
                    model: Ghostd.providers

                    Rectangle {
                        id: providerRow
                        required property var modelData

                        objectName: "provider-" + providerRow.modelData.id
                        activeFocusOnTab: true

                        readonly property bool hasOauth: (providerRow.modelData.authTypes || []).indexOf("oauth") >= 0
                        readonly property bool hasApiKey: (providerRow.modelData.authTypes || []).indexOf("api_key") >= 0

                        width: providerColumn.width
                        implicitHeight: 46
                        radius: Theme.radius / 2
                        color: Theme.surface
                        border.width: providerRow.activeFocus ? 1 : 0
                        border.color: Theme.accent

                        function startPrimaryLogin(): void {
                            Ghostd.startLogin(providerRow.modelData.id,
                                providerRow.hasOauth ? "oauth" : "api_key");
                        }

                        Keys.onReturnPressed: providerRow.startPrimaryLogin()
                        Keys.onEnterPressed: providerRow.startPrimaryLogin()
                        Keys.onSpacePressed: providerRow.startPrimaryLogin()

                        RowLayout {
                            anchors.fill: parent
                            anchors.leftMargin: Theme.pad
                            anchors.rightMargin: Theme.gap
                            spacing: Theme.gap

                            ColumnLayout {
                                spacing: 0
                                Layout.fillWidth: true

                                Text {
                                    text: providerRow.modelData.name
                                    color: Theme.foregroundBright
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSize
                                    elide: Text.ElideRight
                                    Layout.fillWidth: true
                                }

                                Text {
                                    readonly property string tags: {
                                        const parts = [];
                                        if (providerRow.modelData.subscription) parts.push("subscription");
                                        if (providerRow.modelData.billingNote) parts.push(providerRow.modelData.billingNote);
                                        if (providerRow.modelData.configured) parts.push("connected");
                                        return parts.join(" · ");
                                    }
                                    visible: text !== ""
                                    text: tags
                                    color: providerRow.modelData.configured ? Theme.ok : Theme.foregroundDim
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    elide: Text.ElideRight
                                    Layout.fillWidth: true
                                }
                            }

                            // Primary action: OAuth sign-in when offered, else API key.
                            Rectangle {
                                implicitWidth: primaryLabel.implicitWidth + Theme.pad
                                implicitHeight: 26
                                radius: Theme.radius / 2
                                color: Theme.accent
                                border.width: 0
                                border.color: Theme.accent
                                opacity: primaryArea.containsMouse ? 0.88 : 1

                                Text {
                                    id: primaryLabel
                                    anchors.centerIn: parent
                                    text: providerRow.hasOauth
                                        ? (providerRow.modelData.loginLabel || "Sign in")
                                        : "Paste API key"
                                    color: Theme.onAccent
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                }

                                MouseArea {
                                    id: primaryArea
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: providerRow.startPrimaryLogin()
                                }
                            }

                            // Secondary: API key, when a provider offers both.
                            Text {
                                visible: providerRow.hasOauth && providerRow.hasApiKey
                                text: "API key"
                                color: Theme.foregroundDim
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                MouseArea {
                                    anchors.fill: parent
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: Ghostd.startLogin(providerRow.modelData.id, "api_key")
                                }
                            }
                        }
                    }
                }
            }
        }

        Flickable {
            visible: !root.picking
            Layout.fillWidth: true
            Layout.fillHeight: true
            contentWidth: width
            contentHeight: flowColumn.implicitHeight
            clip: true
            interactive: contentHeight > height

            Column {
                id: flowColumn
                width: parent.width
                spacing: Theme.gap

                // Success / failure banners.
                Text {
                    visible: root.status === "succeeded"
                    width: parent.width
                    text: "Signed in"
                        + (root.view && root.view.modelBound
                            ? " · chat model " + root.view.modelBound.modelId
                            : ".")
                    color: Theme.ok
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                    wrapMode: Text.Wrap
                }

                Text {
                    visible: root.status === "failed" || (root.errorText !== "" && root.status !== "succeeded")
                    width: parent.width
                    text: root.errorText !== "" ? root.errorText : "Login failed."
                    color: Theme.danger
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                    wrapMode: Text.Wrap
                }

                // A progress line while the daemon works.
                Text {
                    visible: root.message !== "" && root.status !== "succeeded" && root.status !== "failed"
                    width: parent.width
                    text: root.message
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.Wrap
                }

                // Auth URL to open (callback flows show this AND a paste field).
                Column {
                    visible: root.authUrl !== "" && root.status !== "succeeded"
                    width: parent.width
                    spacing: Theme.gap / 2

                    Text {
                        text: "Open this URL to sign in:"
                        color: Theme.foreground
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                    }

                    TextEdit {
                        width: parent.width
                        text: root.authUrl
                        readOnly: true
                        selectByMouse: true
                        wrapMode: TextEdit.WrapAnywhere
                        color: Theme.accent
                        selectionColor: Theme.selection
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                    }

                    Text {
                        visible: root.authInstructions !== ""
                        width: parent.width
                        text: root.authInstructions
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.Wrap
                    }

                    Rectangle {
                        implicitWidth: openLabel.implicitWidth + Theme.pad
                        implicitHeight: 28
                        radius: Theme.radius / 2
                        color: Theme.accent
                        border.width: 0
                        border.color: Theme.accent
                        opacity: openArea.containsMouse ? 0.88 : 1
                        Text {
                            id: openLabel
                            anchors.centerIn: parent
                            text: "Open in browser"
                            color: Theme.onAccent
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                        }
                        MouseArea {
                            id: openArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: Ghostd.openLoginUrl(root.authUrl)
                        }
                    }
                }

                // Device code to enter at a verification URL.
                Column {
                    visible: root.deviceCode !== "" && root.status !== "succeeded"
                    width: parent.width
                    spacing: Theme.gap / 2

                    Text {
                        text: "Enter this code at " + root.verificationUrl + ":"
                        color: Theme.foreground
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.Wrap
                        width: parent.width
                    }

                    Text {
                        text: root.deviceCode
                        color: Theme.foregroundBright
                        font.family: Theme.fontFamilyMono
                        font.pixelSize: Theme.fontSizeHeading
                        font.weight: Font.DemiBold
                    }

                    Rectangle {
                        visible: root.verificationUrl !== ""
                        implicitWidth: deviceOpenLabel.implicitWidth + Theme.pad
                        implicitHeight: 28
                        radius: Theme.radius / 2
                        color: Theme.accent
                        border.width: 0
                        border.color: Theme.accent
                        opacity: deviceOpenArea.containsMouse ? 0.88 : 1
                        Text {
                            id: deviceOpenLabel
                            anchors.centerIn: parent
                            text: "Open verification page"
                            color: Theme.onAccent
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                        }
                        MouseArea {
                            id: deviceOpenArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: Ghostd.openLoginUrl(root.verificationUrl)
                        }
                    }
                }

                // A text/secret/manual_code prompt: a field to type into.
                Column {
                    visible: root.prompt !== null && (root.prompt.kind === "text"
                        || root.prompt.kind === "secret" || root.prompt.kind === "manual_code")
                    width: parent.width
                    spacing: Theme.gap / 2

                    Text {
                        width: parent.width
                        text: root.prompt ? root.prompt.message : ""
                        color: Theme.foreground
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.Wrap
                    }

                    Rectangle {
                        width: parent.width
                        implicitHeight: 40
                        radius: Theme.radius / 2
                        color: Theme.surfaceDeep
                        border.width: 1
                        border.color: codeField.activeFocus ? Theme.accent : Theme.border

                        TextInput {
                            id: codeField
                            objectName: "loginCodeField"
                            anchors.fill: parent
                            anchors.leftMargin: Theme.pad
                            anchors.rightMargin: Theme.pad
                            verticalAlignment: TextInput.AlignVCenter
                            color: Theme.foregroundBright
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                            selectByMouse: true
                            selectionColor: Theme.selection
                            echoMode: (root.prompt && root.prompt.secret)
                                ? TextInput.Password
                                : TextInput.Normal
                            onAccepted: root.submitCurrentInput()

                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                visible: codeField.text === ""
                                text: root.prompt && root.prompt.placeholder
                                    ? root.prompt.placeholder
                                    : (root.prompt && root.prompt.secret ? "paste secret…" : "paste here…")
                                color: Theme.foregroundDim
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSize
                            }
                        }
                    }

                    Rectangle {
                        implicitWidth: submitLabel.implicitWidth + Theme.pad
                        implicitHeight: 28
                        radius: Theme.radius / 2
                        color: Theme.accent
                        border.width: 0
                        border.color: Theme.accent
                        opacity: submitArea.containsMouse ? 0.88 : 1
                        Text {
                            id: submitLabel
                            anchors.centerIn: parent
                            text: "Submit"
                            color: Theme.onAccent
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                        }
                        MouseArea {
                            id: submitArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.submitCurrentInput()
                        }
                    }
                }

                // A select prompt: one button per option.
                Column {
                    visible: root.prompt !== null && root.prompt.kind === "select"
                    width: parent.width
                    spacing: Theme.gap / 2

                    Text {
                        width: parent.width
                        text: root.prompt ? root.prompt.message : ""
                        color: Theme.foreground
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.Wrap
                    }

                    Repeater {
                        model: root.prompt && root.prompt.options ? root.prompt.options : []

                        Rectangle {
                            id: optionRow
                            required property var modelData

                            width: flowColumn.width
                            implicitHeight: 36
                            radius: Theme.radius / 2
                            color: optionArea.containsMouse ? Theme.hover : Theme.surface
                            border.width: 0
                            border.color: Theme.border

                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                anchors.left: parent.left
                                anchors.leftMargin: Theme.pad
                                anchors.right: parent.right
                                anchors.rightMargin: Theme.pad
                                text: optionRow.modelData.label
                                    + (optionRow.modelData.description ? " — " + optionRow.modelData.description : "")
                                color: Theme.foreground
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                elide: Text.ElideRight
                            }

                            MouseArea {
                                id: optionArea
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: Ghostd.submitLoginInput(optionRow.modelData.id)
                            }
                        }
                    }
                }

                // Terminal actions.
                Row {
                    visible: root.status === "succeeded" || root.status === "failed"
                    spacing: Theme.gap

                    Rectangle {
                        implicitWidth: doneLabel.implicitWidth + Theme.pad
                        implicitHeight: 28
                        radius: Theme.radius / 2
                        color: Theme.accent
                        border.width: 0
                        border.color: Theme.accent
                        opacity: doneArea.containsMouse ? 0.88 : 1
                        Text {
                            id: doneLabel
                            anchors.centerIn: parent
                            text: root.status === "succeeded" ? "Done" : "Back"
                            color: Theme.onAccent
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                        }
                        MouseArea {
                            id: doneArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                if (root.status === "succeeded") root.close();
                                else Ghostd.resetLogin();
                            }
                        }
                    }
                }
            }
        }
    }
}
