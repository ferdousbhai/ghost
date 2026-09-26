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

    function open(): void {
        Ghostd.cancelLogin();
        Ghostd.fetchProviders();
    }

    function close(): void {
        Ghostd.cancelLogin();
        root.closeRequested();
    }

    onVisibleChanged: if (!visible) Ghostd.cancelLogin()
    Component.onDestruction: Ghostd.cancelLogin()

    // Every end of a flow — open, close, hide, a provider restart, a ghost
    // switch, an external reset — bumps the generation, so this is the one
    // place the typed field is cleared. The generation deliberately stays
    // stable during a same-flow rename pause, so a rejected submit may remain
    // editable there but never cross into a different flow.
    Connections {
        target: Ghostd
        function onLoginGenerationChanged(): void { codeField.text = ""; }
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
            visible: root.picking
            Layout.fillWidth: true
            Layout.fillHeight: true
            contentWidth: width
            contentHeight: providerColumn.implicitHeight
            clip: true
            interactive: contentHeight > height

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
                            // The row is the Tab stop and already starts this
                            // login from the keyboard.
                            ActionButton {
                                label: providerRow.hasOauth
                                    ? (providerRow.modelData.loginLabel || "Sign in")
                                    : "Paste API key"
                                primary: true
                                activeFocusOnTab: false
                                onClicked: providerRow.startPrimaryLogin()
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

                    ActionButton {
                        label: "Open in browser"
                        primary: true
                        onClicked: Ghostd.openLoginUrl(root.authUrl)
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

                    ActionButton {
                        visible: root.verificationUrl !== ""
                        label: "Open verification page"
                        primary: true
                        onClicked: Ghostd.openLoginUrl(root.verificationUrl)
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

                    ActionButton {
                        label: "Submit"
                        primary: true
                        onClicked: root.submitCurrentInput()
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

                    ActionButton {
                        label: root.status === "succeeded" ? "Done" : "Back"
                        primary: true
                        onClicked: {
                            if (root.status === "succeeded") root.close();
                            else Ghostd.cancelLogin();
                        }
                    }
                }
            }
        }
    }
}
