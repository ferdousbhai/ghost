import QtQuick
import QtTest
import "../qml/components" as Components

TestCase {
    id: tc
    name: "DocumentView"

    readonly property string hostileMarkup:
        "# Literal document\n\n"
        + "![remote](https://resource.invalid/pixel.png)\n"
        + "![local](file:///etc/passwd)\n"
        + "![relative](../private/image.png)\n"
        + "![data](data:image/svg+xml,<svg onload='fetch(1)'/>)\n"
        + "<img src=\"https://resource.invalid/raw.png\">\n"
        + "<img src=\"file:///home/owner/.ssh/id_ed25519\">\n"
        + "[remote link](https://resource.invalid/click)\n"
        + "[local link](file:///etc/shadow)\n"

    Component {
        id: viewComponent
        Components.DocumentView {
            width: 640
            height: 480
            filePath: "/home/owner/Documents/hostile.md"
            source: tc.hostileMarkup
            byteSize: tc.hostileMarkup.length
        }
    }

    function test_markupImagesHtmlAndLinksStayLiteralWithoutResourceSurface(): void {
        const view = createTemporaryObject(viewComponent, tc);
        verify(view !== null);
        const literal = findChild(view, "documentsInlineLiteralText");
        verify(literal !== null);
        compare(literal.textFormat, Text.PlainText);
        compare(literal.text, hostileMarkup);
        verify(literal.text.indexOf("![remote](https://resource.invalid/pixel.png)") >= 0);
        verify(literal.text.indexOf("![local](file:///etc/passwd)") >= 0);
        verify(literal.text.indexOf("![data](data:image/svg+xml") >= 0);
        verify(literal.text.indexOf("<img src=\"https://resource.invalid/raw.png\">") >= 0);
        verify(literal.text.indexOf("[local link](file:///etc/shadow)") >= 0);

        // PlainText has no document-resource or link activation surface. The
        // exact hostile bytes remain the only rendered value after layout.
        wait(50);
        compare(literal.textFormat, Text.PlainText);
        compare(literal.text, hostileMarkup);
    }
}
