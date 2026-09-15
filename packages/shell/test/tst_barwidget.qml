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

    // What the host injects: Bar exposes exactly these two geometry members to
    // a third-party widget.
    QtObject {
        id: horizontalBar
        readonly property bool vertical: false
        readonly property int barSize: 26
    }

    QtObject {
        id: verticalBar
        readonly property bool vertical: true
        readonly property int barSize: 28
    }

    Component {
        id: widgetComponent
        GhostBarWidget {}
    }

    // Style.bar.iconSlot: the length a host icon button reserves along the bar.
    readonly property real iconSlot: 27

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
