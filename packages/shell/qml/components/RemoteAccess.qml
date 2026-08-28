pragma ComponentBehavior: Bound

// Machine-global Tailscale Serve access. The daemon owns setup and persisted
// intent; this surface only shows its exact state and asks it to flip the one
// enabled bit.
import Quickshell
import QtQuick
import qs.services

Rectangle {
    id: root

    readonly property var status: Ghostd.remoteStatus || ({})
    readonly property var problem: root.status.problem || null
    readonly property bool remoteOn: root.status.enabled === true
        && root.status.state === "on" && typeof root.status.url === "string"
        && root.status.url !== ""
    readonly property bool unsupported: root.problem !== null
        && root.problem.code === "remote_unsupported"
    readonly property string statusLine: root.problem !== null
        ? String(root.problem.message || "Remote access is unavailable")
        : (Ghostd.remoteError !== "" ? Ghostd.remoteError
            : (root.remoteOn ? "On — " + root.status.url : "Off"))

    signal closeRequested()

    implicitWidth: Theme.pad * 48
    implicitHeight: Theme.pad * 34
    color: Theme.background
    clip: true

    Keys.onEscapePressed: event => {
        root.closeRequested();
        event.accepted = true;
    }

    function copy(value: string): void {
        if (value !== "") Quickshell.clipboardText = value;
    }

    component ClipboardButton: Rectangle {
        id: copyButton

        required property string value
        property string accessibleName: "Copy"

        width: Theme.controlHeight
        height: Theme.controlHeight
        radius: Theme.radius
        color: copyArea.containsMouse ? Theme.film(0.09) : "transparent"
        border.width: activeFocus ? 1 : 0
        border.color: Theme.amber(0.55)
        activeFocusOnTab: true

        Accessible.role: Accessible.Button
        Accessible.name: copyButton.accessibleName

        CopyGlyph {
            anchors.centerIn: parent
            size: 16
            tint: copyArea.containsMouse || copyButton.activeFocus
                ? Theme.foreground : Theme.foregroundFaint
        }

        MouseArea {
            id: copyArea
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.copy(copyButton.value)
        }

        Keys.onPressed: event => {
            if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                    || event.key === Qt.Key_Space) {
                root.copy(copyButton.value);
                event.accepted = true;
            }
        }
    }

    Component.onCompleted: {
        if (root.visible) Ghostd.refreshRemote();
        Qt.callLater(function () {
            if (root.visible) remoteSwitch.forceActiveFocus();
        });
    }
    onVisibleChanged: if (root.visible) {
        Ghostd.refreshRemote();
        Qt.callLater(function () { remoteSwitch.forceActiveFocus(); });
    }

    Column {
        id: header
        anchors.left: parent.left
        anchors.leftMargin: Theme.pad
        anchors.right: parent.right
        anchors.rightMargin: Theme.pad
        anchors.top: parent.top
        anchors.topMargin: Theme.pad
        spacing: Theme.gap / 3

        Text {
            objectName: "remoteTitle"
            width: parent.width
            text: "Reach me from my phone"
            textFormat: Text.PlainText
            color: Theme.foregroundBright
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSize + 3
            font.weight: Font.DemiBold
        }

        Text {
            width: parent.width
            text: "Ghost can ask Tailscale to serve this machine privately to your tailnet."
            textFormat: Text.PlainText
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.WordWrap
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
                height: accessContent.implicitHeight + Theme.pad * 2
                radius: Theme.radius
                color: Theme.surface
                border.width: 1
                border.color: Theme.border

                Column {
                    id: accessContent
                    x: Theme.pad
                    y: Theme.pad
                    width: parent.width - Theme.pad * 2
                    spacing: Theme.gap

                    Row {
                        width: parent.width
                        spacing: Theme.gap

                        Column {
                            width: parent.width - remoteSwitch.width - Theme.gap
                            spacing: 2

                            Text {
                                width: parent.width
                                text: "Phone access"
                                textFormat: Text.PlainText
                                color: Theme.foregroundBright
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSize + 1
                                font.weight: Font.DemiBold
                            }

                            Text {
                                objectName: "remoteStatusText"
                                width: parent.width
                                text: root.statusLine
                                textFormat: Text.PlainText
                                color: root.problem !== null || Ghostd.remoteError !== ""
                                    ? (root.unsupported ? Theme.foregroundDim : Theme.warn)
                                    : (root.remoteOn ? Theme.ok : Theme.foregroundDim)
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                elide: Text.ElideRight
                                maximumLineCount: 1
                            }
                        }

                        Rectangle {
                            id: remoteSwitch
                            objectName: "remoteSwitch"

                            readonly property bool checked: root.status.enabled === true

                            function activate(): void {
                                if (remoteSwitch.enabled)
                                    Ghostd.setRemoteEnabled(!remoteSwitch.checked);
                            }

                            anchors.verticalCenter: parent.verticalCenter
                            width: 50
                            height: 28
                            radius: height / 2
                            color: remoteSwitch.checked ? Theme.amber(0.25) : Theme.film(0.08)
                            border.width: remoteSwitch.activeFocus ? 2 : 1
                            border.color: remoteSwitch.checked
                                ? Theme.ghostAmberBright : Theme.borderStrong
                            activeFocusOnTab: true
                            enabled: !Ghostd.remoteMutating && !root.unsupported
                            opacity: enabled ? 1 : 0.55

                            Accessible.role: Accessible.CheckBox
                            Accessible.name: "Remote phone access"
                            Accessible.description: root.statusLine
                            Accessible.checked: remoteSwitch.checked

                            Rectangle {
                                width: 20
                                height: 20
                                radius: 10
                                x: remoteSwitch.checked
                                    ? remoteSwitch.width - width - 4 : 4
                                anchors.verticalCenter: parent.verticalCenter
                                color: remoteSwitch.checked
                                    ? Theme.ghostAmberBright : Theme.foregroundFaint

                                Behavior on x {
                                    enabled: !Theme.reducedMotion
                                    NumberAnimation { duration: Theme.durFast }
                                }
                            }

                            MouseArea {
                                id: switchArea
                                anchors.fill: parent
                                enabled: remoteSwitch.enabled
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: remoteSwitch.activate()
                            }

                            Keys.onPressed: event => {
                                if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                        || event.key === Qt.Key_Space)
                                        && remoteSwitch.enabled) {
                                    remoteSwitch.activate();
                                    event.accepted = true;
                                }
                            }
                        }
                    }

                    Text {
                        width: parent.width
                        visible: Ghostd.remoteMutating || Ghostd.remoteLoading
                        text: Ghostd.remoteMutating ? "Updating Tailscale Serve…" : "Checking remote access…"
                        textFormat: Text.PlainText
                        color: Theme.foregroundFaint
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                    }

                    Column {
                        id: problemAction
                        objectName: "remoteProblemAction"
                        width: parent.width
                        visible: root.problem !== null
                            && typeof root.problem.action === "string"
                            && root.problem.action !== ""
                        spacing: Theme.gap / 2

                        Text {
                            width: parent.width
                            text: "Run this once in a terminal, then flip the switch again"
                            textFormat: Text.PlainText
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            wrapMode: Text.WordWrap
                        }

                        Rectangle {
                            width: parent.width
                            height: Math.max(Theme.controlHeight,
                                remoteActionCommand.implicitHeight + Theme.gap)
                            radius: Theme.radius
                            color: Theme.film(0.05)
                            border.width: 1
                            border.color: Theme.border

                            TextEdit {
                                id: remoteActionCommand
                                objectName: "remoteActionCommand"
                                anchors.left: parent.left
                                anchors.leftMargin: Theme.pad / 2
                                anchors.right: actionCopy.left
                                anchors.rightMargin: Theme.gap / 2
                                anchors.verticalCenter: parent.verticalCenter
                                text: root.problem && root.problem.action
                                    ? String(root.problem.action) : ""
                                readOnly: true
                                selectByMouse: true
                                activeFocusOnTab: true
                                textFormat: TextEdit.PlainText
                                color: Theme.foregroundBright
                                selectionColor: Theme.selection
                                selectedTextColor: Theme.foregroundBright
                                font.family: Theme.fontFamilyMono
                                font.pixelSize: Theme.fontSizeSmall
                                wrapMode: TextEdit.WrapAnywhere
                                Accessible.name: "Terminal command"
                                Accessible.description: "Select or copy this command"
                            }

                            ClipboardButton {
                                id: actionCopy
                                objectName: "remoteActionCopy"
                                anchors.right: parent.right
                                anchors.verticalCenter: parent.verticalCenter
                                value: remoteActionCommand.text
                                accessibleName: "Copy terminal command"
                            }
                        }
                    }
                }
            }

            Rectangle {
                id: connectionCard
                width: parent.width
                height: remoteContent.implicitHeight + Theme.pad * 2
                visible: root.remoteOn
                radius: Theme.radius
                color: Theme.surface
                border.width: 1
                border.color: Theme.border

                Column {
                    id: remoteContent
                    x: Theme.pad
                    y: Theme.pad
                    width: parent.width - Theme.pad * 2
                    spacing: Theme.gap

                    Text {
                        width: parent.width
                        text: "Open on your phone"
                        textFormat: Text.PlainText
                        color: Theme.foregroundBright
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize + 1
                        font.weight: Font.DemiBold
                    }

                    Rectangle {
                        width: parent.width
                        height: Math.max(Theme.controlHeight,
                            remoteUrlText.implicitHeight + Theme.gap)
                        radius: Theme.radius
                        color: Theme.film(0.05)
                        border.width: 1
                        border.color: Theme.border

                        TextEdit {
                            id: remoteUrlText
                            objectName: "remoteUrlText"
                            anchors.left: parent.left
                            anchors.leftMargin: Theme.pad / 2
                            anchors.right: urlCopy.left
                            anchors.rightMargin: Theme.gap / 2
                            anchors.verticalCenter: parent.verticalCenter
                            text: root.remoteOn ? String(root.status.url) : ""
                            readOnly: true
                            selectByMouse: true
                            activeFocusOnTab: true
                            textFormat: TextEdit.PlainText
                            color: Theme.foregroundBright
                            selectionColor: Theme.selection
                            selectedTextColor: Theme.foregroundBright
                            font.family: Theme.fontFamilyMono
                            font.pixelSize: Theme.fontSizeSmall
                            wrapMode: TextEdit.WrapAnywhere
                            Accessible.name: "Remote access URL"
                            Accessible.description: "Select or copy this URL"
                        }

                        ClipboardButton {
                            id: urlCopy
                            objectName: "remoteUrlCopy"
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            value: remoteUrlText.text
                            accessibleName: "Copy remote access URL"
                        }
                    }

                    Item {
                        width: parent.width
                        height: 230

                        Image {
                            id: remoteQrImage
                            objectName: "remoteQrImage"
                            anchors.centerIn: parent
                            width: 220
                            height: 220
                            visible: root.remoteOn
                            source: Ghostd.remoteQrSource
                            sourceSize.width: 220
                            sourceSize.height: 220
                            fillMode: Image.PreserveAspectFit
                            asynchronous: true
                            cache: false
                            Accessible.role: Accessible.Graphic
                            Accessible.name: "QR code for " + remoteUrlText.text
                        }

                        Text {
                            anchors.centerIn: parent
                            visible: Ghostd.remoteQrLoading
                                || (!Ghostd.remoteQrLoading && Ghostd.remoteQrSource === "")
                            text: Ghostd.remoteQrLoading ? "Loading QR code…" : "QR code unavailable"
                            textFormat: Text.PlainText
                            color: Theme.foregroundFaint
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                        }
                    }

                    Column {
                        width: parent.width
                        spacing: 2

                        Text {
                            width: parent.width
                            text: "Who can watch"
                            textFormat: Text.PlainText
                            color: Theme.foregroundBright
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            font.weight: Font.DemiBold
                        }

                        Text {
                            objectName: "remoteAudienceText"
                            width: parent.width
                            text: "Owner: " + (root.status.owner || "not reported")
                                + " · Guests: " + (root.status.guests === "read-only"
                                    ? "read-only" : "none")
                            textFormat: Text.PlainText
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            wrapMode: Text.WordWrap
                        }
                    }
                }
            }
        }
    }
}
