import QtQuick
import QtTest
import "../qml/components/ModelRouting.js" as Routing

TestCase {
    name: "ModelRouting"

    readonly property var routes: [
        { role: "chat_model", source: "auto", effective: { provider: "openai", id: "chat" } },
        { role: "smol_model", source: "explicit", primary: { provider: "fast", id: "small" } },
        { role: "advisor_model", source: "unavailable", effective: null },
        { role: "research_model", source: "explicit", primary: { provider: "legacy", id: "research" } }
    ]

    function test_groupsBuiltinsAndConfiguredCompatibility(): void {
        const rows = Routing.rows(routes);
        compare(rows.filter(function (row) { return row.header; })
            .map(function (row) { return row.label; }).join(","),
            "Conversation,Everyday work,Automation,Compatibility");
        compare(rows.filter(function (row) { return !row.header; })
            .map(function (row) { return row.route.role; }).join(","),
            "chat_model,smol_model,advisor_model,research_model");
    }

    function test_sourceLineMakesAutomaticResolutionVisible(): void {
        compare(Routing.sourceLine(routes[0]), "Auto → openai/chat");
        compare(Routing.sourceLine(routes[1]), "Explicit · fast/small");
        compare(Routing.sourceLine(routes[2]), "Auto → unavailable");
    }

    function test_removeAndReorderProduceCompleteImmutableChains(): void {
        const chain = [
            { provider: "one", id: "a" },
            { provider: "two", id: "b" },
            { provider: "three", id: "c" }
        ];
        compare(Routing.removeFallback(chain, 1).map(function (row) { return row.id; }).join(","), "a,c");
        compare(Routing.moveFallback(chain, 2, -1).map(function (row) { return row.id; }).join(","), "a,c,b");
        compare(chain.map(function (row) { return row.id; }).join(","), "a,b,c");
    }
}
