pragma ComponentBehavior: Bound

// Machine-global Tailscale Serve access for the remote app. The daemon owns
// setup and persisted intent; this surface only shows its exact state and the
// app link, and asks it to flip the one enabled bit.
import Quickshell
import QtQuick
import "../services"

Rectangle {
    id: root

    readonly property var status: Ghostd.remoteStatus || ({})
    readonly property var problem: root.status.problem || null
    readonly property bool remoteOn: root.status.state === "on"
    readonly property string statusLine: root.problem !== null
        ? String(root.problem.message || "Remote access is unavailable")
        : (Ghostd.remoteError !== "" ? Ghostd.remoteError
            : (root.remoteOn ? "On — " + String(root.status.hostname || "") : "Off"))

    signal closeRequested()

    implicitWidth: Theme.pad * 48
    implicitHeight: Theme.pad * 34
    color: Theme.background
    clip: true

    Keys.onEscapePressed: event => {
        root.closeRequested();
        event.accepted = true;
    }

    // A read-only value in a film box with a copy button at its right edge.
    component CopyField: Rectangle {
        id: copyField

        required property string value
        required property string label
        property string textName: ""
        property string copyName: ""

        function copy(): void {
            if (copyField.value !== "") Quickshell.clipboardText = copyField.value;
        }

        width: parent.width
        height: Math.max(Theme.controlHeight, fieldText.implicitHeight + Theme.gap)
        radius: Theme.radius
        color: Theme.film(0.05)
        border.width: 1
        border.color: Theme.border

        TextEdit {
            id: fieldText
            objectName: copyField.textName
            anchors.left: parent.left
            anchors.leftMargin: Theme.pad / 2
            anchors.right: fieldCopy.left
            anchors.rightMargin: Theme.gap / 2
            anchors.verticalCenter: parent.verticalCenter
            text: copyField.value
            readOnly: true
            selectByMouse: true
            activeFocusOnTab: true
            textFormat: TextEdit.PlainText
            color: Theme.foregroundBright
            selectionColor: Theme.selection
            selectedTextColor: Theme.foregroundBright
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSize
            wrapMode: TextEdit.WrapAnywhere
            Accessible.name: copyField.label
            Accessible.description: "Select or copy this"
        }

        Rectangle {
            id: fieldCopy
            objectName: copyField.copyName
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            width: Theme.controlHeight
            height: Theme.controlHeight
            radius: Theme.radius
            color: copyArea.containsMouse ? Theme.film(0.09) : "transparent"
            border.width: fieldCopy.activeFocus ? 1 : 0
            border.color: Theme.amber(0.55)
            activeFocusOnTab: true

            Accessible.role: Accessible.Button
            Accessible.name: "Copy " + copyField.label.toLowerCase()

            CopyGlyph {
                anchors.centerIn: parent
                size: 16
                tint: copyArea.containsMouse || fieldCopy.activeFocus
                    ? Theme.foreground : Theme.foregroundFaint
            }

            MouseArea {
                id: copyArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: copyField.copy()
            }

            Keys.onPressed: event => {
                if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                        || event.key === Qt.Key_Space) {
                    copyField.copy();
                    event.accepted = true;
                }
            }
        }
    }

    // A QR code for `url`, fetched by Ghostd as an authenticated data URL.
    component QrCode: Item {
        id: qrCode

        required property string imageName
        required property string source
        required property bool loading
        required property string url

        width: parent.width
        height: 230

        Image {
            objectName: qrCode.imageName
            anchors.centerIn: parent
            width: 220
            height: 220
            source: qrCode.source
            sourceSize.width: 220
            sourceSize.height: 220
            fillMode: Image.PreserveAspectFit
            asynchronous: true
            cache: false
            Accessible.role: Accessible.Graphic
            Accessible.name: "QR code for " + qrCode.url
        }

        Text {
            anchors.centerIn: parent
            visible: qrCode.loading || qrCode.source === ""
            text: qrCode.loading ? "Loading QR code…" : "QR code unavailable"
            textFormat: Text.PlainText
            color: Theme.foregroundFaint
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSize
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

    PaneHeader {
        id: header
        anchors.left: parent.left
        anchors.leftMargin: Theme.pad
        anchors.right: parent.right
        anchors.rightMargin: Theme.pad
        anchors.top: parent.top
        anchors.topMargin: Theme.pad
        title: "Remote access"
        subtitle: "Reach Ghost from the app on your phone or another device, served privately to your tailnet by Tailscale."
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
                                text: "Serve to your tailnet"
                                textFormat: Text.PlainText
                                color: Theme.foregroundBright
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSubtitle
                                font.weight: Font.DemiBold
                            }

                            Text {
                                objectName: "remoteStatusText"
                                width: parent.width
                                text: root.statusLine
                                textFormat: Text.PlainText
                                color: root.problem !== null || Ghostd.remoteError !== ""
                                    ? Theme.warn
                                    : (root.remoteOn ? Theme.ok : Theme.foregroundDim)
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSize
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
                            enabled: !Ghostd.remoteMutating
                            opacity: enabled ? 1 : 0.55

                            Accessible.role: Accessible.CheckBox
                            Accessible.name: "Remote access"
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
                                anchors.fill: parent
                                enabled: remoteSwitch.enabled
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: remoteSwitch.activate()
                            }

                            Keys.onPressed: event => {
                                if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                        || event.key === Qt.Key_Space) {
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
                        font.pixelSize: Theme.fontSize
                    }

                    Column {
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
                            font.pixelSize: Theme.fontSize
                            wrapMode: Text.WordWrap
                        }

                        CopyField {
                            label: "Terminal command"
                            value: root.problem && root.problem.action ? String(root.problem.action) : ""
                            textName: "remoteActionCommand"
                            copyName: "remoteActionCopy"
                        }
                    }

                    Text {
                        objectName: "remoteHttpsText"
                        width: parent.width
                        visible: root.problem !== null && root.problem.code === "https_required"
                        text: "The app needs HTTPS. Turn on HTTPS Certificates on the DNS page of the Tailscale admin console, then flip the switch again."
                        textFormat: Text.PlainText
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize
                        wrapMode: Text.WordWrap
                    }

                    Text {
                        objectName: "remoteNoAppText"
                        width: parent.width
                        visible: root.remoteOn && Ghostd.remoteAppOrigin === ""
                        text: "remote.apps is empty in the Ghost config, so no app can reach Ghost remotely."
                        textFormat: Text.PlainText
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize
                        wrapMode: Text.WordWrap
                    }

                    Text {
                        objectName: "remoteAudienceText"
                        width: parent.width
                        visible: root.remoteOn
                        text: "Owner: " + (root.status.owner || "not reported")
                            + " · Guests: " + (root.status.guests === "read-only"
                                ? "read-only" : "none")
                        textFormat: Text.PlainText
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize
                        wrapMode: Text.WordWrap
                    }
                }
            }

            Rectangle {
                objectName: "remoteAppCard"
                width: parent.width
                height: appContent.implicitHeight + Theme.pad * 2
                visible: root.remoteOn && Ghostd.remoteAppOrigin !== ""
                radius: Theme.radius
                color: Theme.surface
                border.width: 1
                border.color: Theme.border

                Column {
                    id: appContent
                    x: Theme.pad
                    y: Theme.pad
                    width: parent.width - Theme.pad * 2
                    spacing: Theme.gap

                    Text {
                        width: parent.width
                        text: "Add to " + Ghostd.remoteAppOrigin.replace(/^https:\/\//, "")
                        textFormat: Text.PlainText
                        color: Theme.foregroundBright
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSubtitle
                        font.weight: Font.DemiBold
                    }

                    CopyField {
                        visible: Ghostd.remoteAppUrl !== ""
                        label: "App link"
                        value: Ghostd.remoteAppUrl
                        textName: "remoteAppUrlText"
                        copyName: "remoteAppUrlCopy"
                    }

                    QrCode {
                        visible: Ghostd.remoteAppUrl !== ""
                        imageName: "remoteAppQrImage"
                        source: Ghostd.remoteAppQrSource
                        loading: Ghostd.remoteAppQrLoading
                        url: Ghostd.remoteAppUrl
                    }
                }
            }
        }
    }
}
