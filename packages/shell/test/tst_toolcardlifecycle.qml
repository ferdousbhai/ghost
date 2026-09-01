import QtQuick
import QtTest
import qs.components

TestCase {
    id: tc
    name: "ToolCardLifecycle"

    ListModel { id: transcript }

    Item {
        Repeater {
            id: rows
            model: transcript
            // The real Bubble, so its allActivities normalizer — the code that
            // recovers a nested QQmlListModel role into the JS array its card
            // Repeater consumes — is what this lifecycle actually exercises.
            delegate: Bubble {
                required property var toolActivity

                width: 500
                speaker: "assistant"
                body: ""
                toolTrail: ""
                activities: toolActivity
                failure: ""
                busy: true
                sourceEntryId: ""
                rowIndex: 0
            }
        }
    }

    function call(id: string, status: string): var {
        return {
            id: id,
            name: "ask",
            status: status,
            arguments: ({}),
            intent: "Checking " + id,
            summary: "",
            askBranch: { resultEntryId: "result-" + id }
        };
    }

    function test_listModelRoleReplacementDoesNotWarnDuringDelegateTeardown(): void {
        failOnWarning(/ToolCard\.qml:[0-9]+: TypeError/);
        failOnWarning(/Bubble\.qml:[0-9]+: TypeError/);

        transcript.append({ toolActivity: [tc.call("first", "running")] });
        wait(0);
        transcript.setProperty(0, "toolActivity", [
            tc.call("first", "complete"),
            tc.call("second", "running")
        ]);
        wait(0);
        transcript.setProperty(0, "toolActivity", [
            tc.call("first", "complete"),
            tc.call("second", "complete"),
            tc.call("third", "running")
        ]);
        wait(0);
        transcript.setProperty(0, "toolActivity", []);
        wait(0);

        compare(rows.count, 1);
    }

    function cleanup(): void {
        transcript.clear();
    }
}
