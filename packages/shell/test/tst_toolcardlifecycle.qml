import QtQuick
import QtTest
import "../qml/components" as Components

TestCase {
    id: tc
    name: "ToolCardLifecycle"

    ListModel { id: transcript }

    Item {
        Repeater {
            id: rows
            model: transcript
            delegate: Item {
                required property var toolActivity

                // Bubble recovers a nested QQmlListModel role into the real JS
                // array that its card Repeater consumes.
                readonly property var shownActivities: {
                    const value = toolActivity;
                    if (!value) return [];
                    if (Array.isArray(value)) return value;
                    const list = [];
                    for (let i = 0; i < value.count; i++) list.push(value.get(i));
                    return list;
                }

                Repeater {
                    model: parent.shownActivities
                    delegate: Components.ToolCard {
                        required property var modelData
                        width: 500
                        activity: modelData
                    }
                }
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
        ignoreWarning(new RegExp("ghostd is not answering on http://127.0.0.1:17717"));
        failOnWarning(/ToolCard\.qml:[0-9]+: TypeError/);

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
