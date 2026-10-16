import QtQuick
import QtQuick.Window
import "../qml/services"
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
        Ghostd.hookConfig = { hooks: { session_stop: [{ hooks: [{
            type: "command",
            command: "true",
            name: "![remote](" + root.fixtureUrl + "/markdown-name.png) "
                + "<img src=\"file:///etc/passwd\">",
            description: "<img src=\"" + root.fixtureUrl + "/raw-description.png\"> "
                + "![data](data:image/svg+xml,<svg onload='fetch(1)'/>) "
                + "[local](file:///etc/shadow)"
        }] }] } };
        Ghostd.hookConfigLoaded = true;
        Ghostd.hookConfigError = "<img src=\"" + root.fixtureUrl + "/raw-error.png\">";
        browserLoader.active = true;
    }

    Timer {
        interval: 300
        running: true
        onTriggered: Qt.exit(0)
    }
}
