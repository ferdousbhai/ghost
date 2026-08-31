import QtQuick
import QtQuick.Window
import qs.services
import "../qml/components" as Components

Window {
    id: root
    width: 640
    height: 480
    visible: true

    readonly property string fixtureUrl: {
        const args = Qt.application.arguments;
        return args.length > 1 ? args[args.length - 1] : "";
    }

    Loader {
        id: browserLoader
        anchors.fill: parent
        active: false
        sourceComponent: Components.HooksBrowser {}
    }

    Component.onCompleted: {
        Ghostd.activeHooks = [{
            event: "conversation_idle",
            source: "builtin",
            name: "![remote](" + root.fixtureUrl + "/markdown-name.png) "
                + "<img src=\"file:///etc/passwd\">",
            description: "<img src=\"" + root.fixtureUrl + "/raw-description.png\"> "
                + "![data](data:image/svg+xml,<svg onload='fetch(1)'/>) "
                + "[local](file:///etc/shadow)",
            idleSeconds: 60
        }];
        Ghostd.hookEvents = [{ event: "conversation_idle", count: 1 }];
        Ghostd.activeHookCount = 1;
        Ghostd.hooksLoaded = true;
        Ghostd.hooksLoading = false;
        Ghostd.hooksError = "<img src=\"" + root.fixtureUrl + "/raw-error.png\">";
        browserLoader.active = true;
    }

    Timer {
        interval: 300
        running: true
        onTriggered: Qt.exit(0)
    }
}
