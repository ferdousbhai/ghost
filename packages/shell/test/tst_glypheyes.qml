import QtQuick
import QtTest
import "../qml/components"

// The bar can be translucent over the wallpaper, so a filled ghost's eyes have
// to be holes in the body, not dots painted in some guess at the colour behind.
TestCase {
    id: tc
    name: "GhostGlyphEyes"
    when: windowShown
    width: 100
    height: 100
    visible: true

    // Anything but Theme.background: what a translucent bar shows through.
    readonly property color wallpaper: "#5b3590"

    Rectangle { anchors.fill: parent; color: tc.wallpaper }
    Component { id: glyphC; GhostGlyph { size: 48; tint: "#7aa2f7" } }

    function near(a, b): bool {
        return Math.abs(a.r - b.r) < 0.06 && Math.abs(a.g - b.g) < 0.06 && Math.abs(a.b - b.b) < 0.06;
    }

    function test_aFilledGhostKeepsItsEyesOverAnyBackground(): void {
        const glyph = createTemporaryObject(glyphC, tc);
        waitForRendering(glyph);
        // Idle first, then filled: the bar's mark changes state in place.
        glyph.filled = true;
        waitForRendering(glyph);
        const image = grabImage(glyph);
        // At size 48 a viewBox unit is 2px: the eyes sit at (9,10) and (15,10).
        verify(near(image.pixel(18, 20), tc.wallpaper), "left eye shows " + image.pixel(18, 20));
        verify(near(image.pixel(30, 20), tc.wallpaper), "right eye shows " + image.pixel(30, 20));
        verify(near(image.pixel(24, 30), glyph.tint), "body shows " + image.pixel(24, 30));

        glyph.filled = false;
        waitForRendering(glyph);
        const outline = grabImage(glyph);
        verify(near(outline.pixel(18, 20), glyph.tint), "outline eye shows " + outline.pixel(18, 20));
        verify(near(outline.pixel(24, 30), tc.wallpaper), "outline body shows " + outline.pixel(24, 30));
    }
}
