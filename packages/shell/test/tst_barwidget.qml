import QtQuick
import QtTest
import "../qml"
import "../qml/services"

// The bar arranges its modules with a Row, which sets x and leaves y alone.
// A widget shorter than its neighbours therefore rides at the top of the bar
// rather than on their centre line, so the only defence is to fill the slot
// the host's own icon buttons fill.
TestCase {
    id: tc
    name: "GhostBarWidget"
    when: windowShown
    width: 200
    height: 60
    visible: true

    // The host's geometry and tooltip facade.
    QtObject {
        id: horizontalBar
        readonly property bool vertical: false
        readonly property int barSize: 26
        property var shell: null
        property var target: null
        property string text: ""
        function showTooltip(item, label): void {
            if (!item.tooltipHovered) return;
            target = item;
            text = label;
        }
        function hideTooltip(item): void {
            if (target !== item) return;
            target = null;
            text = "";
        }
    }

    QtObject {
        id: verticalBar
        readonly property bool vertical: true
        readonly property int barSize: 28
        property var shell: null
        function hideTooltip(item): void {}
    }

    Component {
        id: widgetComponent
        GhostBarWidget {}
    }

    // Style.bar.iconSlot: the length a host icon button reserves along the bar.
    readonly property real iconSlot: 27

    // herdr's agent states, most urgent first, over every conversation.
    function test_theMarkWearsHerdrsStates(): void {
        const widget = createTemporaryObject(widgetComponent, tc, { bar: horizontalBar });
        const mark = findChild(widget, "barMark");
        const was = { reachable: Ghostd.reachable, sessions: Ghostd.sessions };
        try {
            Ghostd.reachable = true;
            Ghostd.sessions = [{ id: "a" }, { id: "b" }];
            compare(widget.agentState, "idle");
            compare(mark.tint, Theme.ok);
            verify(!mark.filled);

            Ghostd.sessions = [{ id: "a", unread: true }, { id: "b" }];
            compare(widget.agentState, "done");
            compare(mark.tint, Theme.info);
            verify(mark.filled);

            Ghostd.sessions = [{ id: "a", unread: true }, { id: "b", running: true }];
            compare(widget.agentState, "working");
            compare(mark.tint, Theme.warn);

            Ghostd.sessions = [{ id: "a", unread: true, question: { text: "Ship it?", options: [] } }, { id: "b", running: true }];
            compare(widget.agentState, "blocked");
            compare(mark.tint, Theme.danger);
            compare(widget.status, "waiting for you");

            Ghostd.reachable = false;
            compare(widget.agentState, "offline");
            verify(!mark.filled);
        } finally {
            Ghostd.reachable = was.reachable;
            Ghostd.sessions = was.sessions;
        }
    }

    // An unread conversation the ghost started on its own (`ghost event`) is
    // a finding: its own tint over an ordinary unread reply, and a count that
    // stays on the mark while a more urgent state tints it.
    function test_findingsAreCountedOnTheMark(): void {
        const widget = createTemporaryObject(widgetComponent, tc, { bar: horizontalBar });
        const mark = findChild(widget, "barMark");
        const badge = findChild(widget, "findingsBadge");
        const count = findChild(widget, "findingsCount");
        const was = { reachable: Ghostd.reachable, sessions: Ghostd.sessions };
        const event = "event-" + "a".repeat(64);
        const other = "event-" + "b".repeat(64);
        try {
            Ghostd.reachable = true;
            Ghostd.sessions = [{ id: event }, { id: "a", unread: true }];
            compare(widget.findings, 0);
            compare(widget.agentState, "done");
            verify(!badge.visible);

            Ghostd.sessions = [{ id: event, unread: true }, { id: "a", unread: true }];
            compare(widget.findings, 1);
            compare(widget.agentState, "found");
            compare(mark.tint, Theme.finding);
            verify(mark.filled);
            verify(badge.visible);
            compare(count.text, "1");
            compare(widget.status, "found something");

            Ghostd.sessions = [{ id: event, unread: true }, { id: other, unread: true, running: true }];
            compare(widget.findings, 2);
            compare(widget.agentState, "working");
            verify(badge.visible);
            compare(count.text, "2");

            Ghostd.sessions = [{ id: event, unread: true }, { id: other, unread: true }];
            compare(widget.status, "found 2 things");

            Ghostd.sessions = Array.from({ length: 12 }, (_, i) => ({ id: "event-" + i, unread: true }));
            compare(count.text, "+");

            Ghostd.reachable = false;
            verify(!badge.visible);
        } finally {
            Ghostd.reachable = was.reachable;
            Ghostd.sessions = was.sessions;
        }
    }

    function test_hostForwardedPressTogglesPanel(): void {
        const calls = [];
        const widget = createTemporaryObject(widgetComponent, tc, {
            bar: { vertical: false, barSize: 26, hideTooltip: function(item) {},
                shell: { toggle: function(id, payload) { calls.push([id, payload]); } } }
        });
        widget.triggerPress(Qt.RightButton);
        compare(calls.length, 0);
        widget.triggerPress(Qt.LeftButton);
        compare(calls.length, 1);
        compare(calls[0][0], "ferdousbhai.ghost");
        compare(calls[0][1], '{"section":"home"}');
        widget.triggerPress(Qt.LeftButton);
        compare(calls.length, 2);
    }

    function test_hostOwnsTooltipLifecycle(): void {
        const widget = createTemporaryObject(widgetComponent, tc, { bar: horizontalBar });
        mouseMove(tc, 150, 50);
        mouseMove(widget, 13, 13);
        tryCompare(widget, "tooltipHovered", true);
        compare(horizontalBar.target, widget);
        compare(horizontalBar.text, widget.tooltipText);

        mouseClick(widget, 13, 13);
        compare(horizontalBar.target, null);
        mouseMove(tc, 150, 50);
        mouseMove(widget, 13, 13);
        tryCompare(horizontalBar, "target", widget);
        mouseMove(tc, 150, 50);
        tryCompare(horizontalBar, "target", null);

        mouseMove(widget, 13, 13);
        tryCompare(horizontalBar, "target", widget);
        widget.visible = false;
        tryCompare(horizontalBar, "target", null);
    }

    function test_theSlotIsAsTallAsTheBarItself(): void {
        const widget = createTemporaryObject(widgetComponent, tc, { bar: horizontalBar });
        verify(widget !== null);
        compare(widget.implicitHeight, horizontalBar.barSize);
        compare(widget.implicitWidth, tc.iconSlot);
    }

    function test_aVerticalBarSwapsTheAxes(): void {
        const widget = createTemporaryObject(widgetComponent, tc, { bar: verticalBar });
        verify(widget !== null);
        compare(widget.implicitWidth, verticalBar.barSize);
        compare(widget.implicitHeight, tc.iconSlot);
    }

    // The host injects `bar` after the widget loads, so the size before that
    // still has to be a bar-sized slot rather than a shrink-wrapped mark.
    function test_theSlotIsBarSizedBeforeTheHostInjectsItself(): void {
        const widget = createTemporaryObject(widgetComponent, tc);
        verify(widget !== null);
        compare(widget.implicitHeight, 26);
        compare(widget.implicitWidth, tc.iconSlot);
    }
}
