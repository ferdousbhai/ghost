import QtQuick
import qs.services

Item {
    id: root
    visible: false

    readonly property string expected: "emoji 👻 and CJK 漢字 stay exact"
    property var state: null
    property var xhr: null
    property int loadingCallbacks: 0
    property bool settled: false

    Timer {
        interval: 5000
        running: true
        onTriggered: root.finish(1, "timed out waiting for byte-split SSE")
    }

    Component.onCompleted: {
        const args = Qt.application.arguments;
        const url = args.length > 1 ? args[args.length - 1] : "";
        if (url.indexOf("http://127.0.0.1:") !== 0) {
            root.finish(1, "missing loopback SSE fixture URL");
            return;
        }

        Ghostd.turnStates = ({});
        Ghostd.liveConversationKeys = [];
        Ghostd.activeGhost = "unicode";
        Ghostd.currentSessionId = "pi:split";
        Ghostd.sessionIds = ({ unicode: "pi:split" });
        root.state = Ghostd.ensureTurnState("unicode", "pi:split", "split", "pi");
        Ghostd.showTurnState("unicode", "pi:split");
        Ghostd.beginTurnFor(root.state);
        Ghostd.appendTurnRow(root.state, {
            role: "user", text: "stream unicode", toolActivity: [],
            error: "", pending: false, entryId: ""
        });
        Ghostd.appendTurnRow(root.state, {
            role: "assistant", text: "", toolActivity: [],
            error: "", pending: true, entryId: ""
        });
        root.state.assistantRow = 1;

        root.xhr = new XMLHttpRequest();
        root.state.request = root.xhr;
        root.xhr.onreadystatechange = function () {
            if (root.xhr.readyState === 3) root.loadingCallbacks += 1;
            Ghostd.readTurnStream(root.xhr, root.state.key,
                "byte-split SSE probe", "missing terminal event");
            if (root.xhr.readyState === 4) Qt.callLater(root.verifyResult);
        };
        root.xhr.open("GET", url);
        root.xhr.send();
    }

    function verifyResult(): void {
        if (root.loadingCallbacks === 0) {
            root.finish(1, "Qt never exposed a streaming readyState-3 callback");
            return;
        }
        if (root.state.streaming || root.state.rows.length !== 2
                || root.state.rows[1].text !== root.expected) {
            root.finish(1, "split UTF-8 was not preserved exactly: "
                + JSON.stringify(root.state.rows));
            return;
        }
        root.finish(0, "");
    }

    function finish(code: int, message: string): void {
        if (root.settled) return;
        root.settled = true;
        if (message !== "") console.error(message);
        Qt.exit(code);
    }
}
