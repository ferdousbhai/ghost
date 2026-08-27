import QtQuick
import QtQuick.Window
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

    Components.DocumentView {
        anchors.fill: parent
        filePath: "/owner/Documents/untrusted.md"
        byteSize: source.length
        source: "![remote](" + root.fixtureUrl + "/markdown.png)\n"
            + "![local](file:///etc/passwd)\n"
            + "![relative](../private/image.png)\n"
            + "![data](data:image/svg+xml,<svg onload='fetch(1)'/>)\n"
            + "<img src=\"" + root.fixtureUrl + "/raw.png\">\n"
            + "<img src=\"file:///etc/shadow\">\n"
            + "[remote link](" + root.fixtureUrl + "/click)\n"
            + "[local link](file:///home/owner/.ssh/id_ed25519)\n"
    }

    Timer {
        interval: 300
        running: true
        onTriggered: Qt.exit(0)
    }
}
