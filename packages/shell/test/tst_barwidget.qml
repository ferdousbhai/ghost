import QtQuick
import QtTest
import "../qml"

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
        compare(calls[0][1], "{}");
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
