pragma ComponentBehavior: Bound

// Redacted lifecycle-hook metadata. The daemon deliberately withholds command
// text, arguments, paths, prompts, and injected context from this surface.
import QtQuick
import qs.services
import "../services/HookStatus.js" as HookStatus

Rectangle {
    id: root

    implicitWidth: Theme.pad * 48
    implicitHeight: Theme.pad * 34
    color: Theme.background
    clip: true

    Component.onCompleted: Ghostd.fetchHooks(false)
    onVisibleChanged: if (root.visible) Ghostd.fetchHooks(false)

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
                    objectName: "hooksTitle"
                    width: parent.width
                    text: "Hooks"
                    textFormat: Text.PlainText
                    color: Theme.foregroundBright
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize + 3
                    font.weight: Font.DemiBold
                }

                Text {
                    objectName: "hooksSummary"
                    width: parent.width
                    text: Ghostd.activeHookCount === 0
                        ? "No lifecycle hooks are loaded."
                        : Ghostd.activeHookCount + (Ghostd.activeHookCount === 1
                            ? " lifecycle hook is loaded."
                            : " lifecycle hooks are loaded.")
                    textFormat: Text.PlainText
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }
            }

            Rectangle {
                id: refreshButton
                objectName: "hooksRefreshButton"
                width: refreshLabel.implicitWidth + Theme.pad * 1.5
                height: Theme.controlHeight
                radius: Theme.radius
                color: refreshArea.containsMouse ? Theme.film(0.08) : Theme.film(0.04)
                border.width: activeFocus ? 1 : 0
                border.color: Theme.amber(0.55)
                activeFocusOnTab: true
                enabled: !Ghostd.hooksLoading

                Accessible.role: Accessible.Button
                Accessible.name: "Refresh hooks"
                Accessible.description: "Reload redacted daemon-global hook metadata"

                Text {
                    id: refreshLabel
                    anchors.centerIn: parent
                    text: Ghostd.hooksLoading ? "Refreshing" : "Refresh"
                    textFormat: Text.PlainText
                    color: refreshButton.enabled ? Theme.foreground : Theme.foregroundFaint
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                }

                MouseArea {
                    id: refreshArea
                    anchors.fill: parent
                    enabled: refreshButton.enabled
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: Ghostd.fetchHooks(true)
                }

                Keys.onPressed: event => {
                    if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                            || event.key === Qt.Key_Space) && refreshButton.enabled) {
                        Ghostd.fetchHooks(true);
                        event.accepted = true;
                    }
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
        visible: Ghostd.hooksError !== ""
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
            text: Ghostd.hooksError
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
        visible: !Ghostd.hooksLoaded && Ghostd.activeHooks.length === 0
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
        visible: Ghostd.hooksLoaded && Ghostd.activeHooks.length === 0
        text: "No lifecycle hooks are loaded by the daemon."
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
        visible: Ghostd.activeHooks.length > 0
        clip: true
        spacing: Theme.gap
        boundsBehavior: Flickable.StopAtBounds
        model: Ghostd.activeHooks

        delegate: Rectangle {
            id: hookCard
            required property var modelData

            width: ListView.view.width
            height: hookColumn.implicitHeight + Theme.pad * 1.5
            radius: Theme.radius
            color: Theme.film(0.04)
            border.width: 1
            border.color: Theme.border

            Accessible.role: Accessible.StaticText
            Accessible.name: hookCard.modelData.name
            Accessible.description: hookCard.modelData.description + ". "
                + HookStatus.trigger(hookCard.modelData.event,
                    Ghostd.hookContinuationCap, hookCard.modelData.idleSeconds || 0)

            Column {
                id: hookColumn
                anchors.left: parent.left
                anchors.leftMargin: Theme.pad
                anchors.right: parent.right
                anchors.rightMargin: Theme.pad
                anchors.verticalCenter: parent.verticalCenter
                spacing: Theme.gap / 3

                Text {
                    objectName: "hookName"
                    width: parent.width
                    text: hookCard.modelData.name
                    textFormat: Text.PlainText
                    color: Theme.foregroundBright
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                    font.weight: Font.DemiBold
                    wrapMode: Text.Wrap
                }

                Text {
                    objectName: "hookDescription"
                    width: parent.width
                    text: hookCard.modelData.description
                    textFormat: Text.PlainText
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }

                Text {
                    objectName: "hookTrigger"
                    width: parent.width
                    text: HookStatus.trigger(hookCard.modelData.event,
                        Ghostd.hookContinuationCap, hookCard.modelData.idleSeconds || 0)
                    textFormat: Text.PlainText
                    color: Theme.ghostAmber
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall - 1
                    wrapMode: Text.WordWrap
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
        visible: Ghostd.activeHooks.length > 0
        text: Ghostd.hooksStale
            ? "Showing the last verified status. Hook implementation details remain private."
            : "Only labels, triggers, and timing are shown. Commands and model context remain private."
        textFormat: Text.PlainText
        color: Theme.foregroundFaint
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeSmall
        wrapMode: Text.WordWrap
    }
}
