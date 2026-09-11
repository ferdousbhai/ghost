import QtQuick
import QtTest
import qs.components
import qs.services

// The copy glyph, the edit pencil and the trail count are controls, not words.
// They used to be placed on the reply's final text line from a hidden
// TextEdit's end cursor, which cannot agree with a markdown block that owns its
// own layout — so they landed on top of the text. They get a row of their own
// now, and these pin both halves: never over the words, and not in the way
// until the pointer is on the message.
TestCase {
    id: tc
    name: "MessageActions"
    when: windowShown
    width: 700
    height: 600
    visible: true

    readonly property var fourCalls: [
        { id: "t1", name: "bash", status: "complete", summary: "" },
        { id: "t2", name: "read", status: "complete", summary: "" },
        { id: "t3", name: "glob", status: "complete", summary: "" },
        { id: "t4", name: "edit", status: "complete", summary: "" }
    ]

    // Every shape a settled reply takes, including the ones whose last line is
    // laid out by Qt's markdown renderer rather than by plain wrapping.
    readonly property var shapes: [
        "short one",
        "you can have it hand the file over, or you can rather drive it yourself",
        "a longer reply that wraps at least once before it ends, so the final line starts fresh and you can rather drive it yourself",
        "para one here\n\nand a second paragraph that wraps a little before it ends so you can rather drive it yourself",
        "- bullet one\n- bullet two that runs on a while and you can rather drive it yourself",
        "here is the fix\n\n```sh\nmv old new\n```",
        "| file | state |\n| --- | --- |\n| march.pdf | scanned |",
        "**bold lead in** and then regular text that would rather drive it yourself"
    ]

    Bubble {
        id: reply

        width: 420
        speaker: "assistant"
        body: "short one"
        activities: tc.fourCalls
        failure: ""
        busy: false
        sourceEntryId: "e1"
        rowIndex: 0
    }

    // Every painted text block, not the binding the row is positioned by:
    // a change back toward computed placement has to fail this.
    function bodyRects(): var {
        const view = findChild(reply, "replyTail").parent;
        const rects = [];
        for (let i = 0; i < view.children.length; i++) {
            const child = view.children[i];
            if (!child.visible || child.height <= 0) continue;
            const at = reply.mapFromItem(child, 0, 0);
            rects.push({ top: at.y, bottom: at.y + child.height,
                left: at.x, right: at.x + child.width });
        }
        return rects;
    }

    function test_actionsClearTheTextInEveryShape(): void {
        const row = findChild(reply, "messageActions");
        verify(row !== null);
        for (const shape of tc.shapes) {
            reply.body = shape;
            wait(120);
            const at = reply.mapFromItem(row, 0, 0);
            const rect = { top: at.y, bottom: at.y + row.height,
                left: at.x, right: at.x + row.width };
            const rects = tc.bodyRects();
            verify(rects.length > 0, "no painted body for " + JSON.stringify(shape));
            for (const block of rects) {
                const overlaps = rect.top < block.bottom && rect.bottom > block.top
                    && rect.left < block.right && rect.right > block.left;
                verify(!overlaps, "actions overlap painted text for "
                    + JSON.stringify(shape) + ": row " + rect.top + "-" + rect.bottom
                    + " vs block " + block.top + "-" + block.bottom);
            }
        }
    }

    function test_theHoverRegionCoversTheControlsOwnHitAreas(): void {
        // Each control overhangs its own bounds by Theme.gap / 2 so it is easy
        // to hit. The HoverHandler that reveals them watches `message`, so an
        // overhang reaching past that edge would fade the control out exactly
        // as the pointer arrived on it from below.
        reply.body = "short one";
        wait(120);
        const row = findChild(reply, "messageActions");
        const hoverRegion = findChild(reply, "messageHoverArea");
        verify(hoverRegion !== null);
        const topLeft = hoverRegion.mapFromItem(row, 0, 0);
        const overhang = Theme.gap / 2;
        verify(topLeft.y + row.height + overhang <= hoverRegion.height + 0.01,
            "hit area overhangs the bottom edge");
        verify(topLeft.x - overhang >= -0.01,
            "hit area overhangs the left edge: " + (topLeft.x - overhang));
        verify(topLeft.x + row.width + overhang <= hoverRegion.width + 0.01,
            "hit area overhangs the right edge: "
                + (topLeft.x + row.width + overhang) + " > " + hoverRegion.width);
    }

    function test_aTurnWithNoTextStillShowsItsTrail(): void {
        // A turn spent entirely on tool calls has no text to hover over. The
        // count is the only thing in the row, so hiding it leaves a strip that
        // reserves height, paints nothing, and strands the trail.
        reply.body = "";
        reply.toolsOpen = false;
        wait(120);
        const trail = findChild(reply, "trailToggle");
        verify(reply.hasActions);
        verify(trail.visible);
        compare(trail.opacity, 1);
        reply.body = "short one";
    }

    function test_theTrailCountWaitsForThePointerLikeItsNeighbours(): void {
        reply.body = "short one";
        reply.toolsOpen = false;
        wait(120);
        const trail = findChild(reply, "trailToggle");
        verify(trail !== null);
        compare(trail.opacity, 0);
    }

    function test_anOpenTrailKeepsTheWayToCloseIt(): void {
        // A control that vanishes on mouse-out would strand an open trail.
        reply.body = "short one";
        reply.toolsOpen = true;
        wait(120);
        const trail = findChild(reply, "trailToggle");
        compare(trail.opacity, 1);
        compare(trail.text, "hide");
        reply.toolsOpen = false;
    }
}
