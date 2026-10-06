import QtTest
import "../qml/services/Attachments.js" as Attachments

TestCase {
    name: "Attachments"

    function test_composeNamesEachImageAfterTheText(): void {
        compare(Attachments.compose("  look at this \n", ["attachments/a.png", "attachments/b.jpg"]),
            "look at this\n![image](attachments/a.png)\n![image](attachments/b.jpg)");
        compare(Attachments.compose("", ["attachments/a.png"]), "![image](attachments/a.png)");
        compare(Attachments.compose("just text", []), "just text");
        compare(Attachments.compose("", []), "");
    }

    function test_splitLiftsImageLinesOutOfAPrompt(): void {
        const parts = Attachments.split("look at this\n![image](attachments/a.png)\n![x](attachments/b.jpg)");
        compare(parts.text, "look at this");
        compare(parts.images, ["attachments/a.png", "attachments/b.jpg"]);
        compare(Attachments.split("![image](attachments/a.png)").text, "");
    }

    function test_splitLeavesEverythingElseVerbatim(): void {
        const plain = "see ![inline](attachments/a.png) here\n![web](https://x.dev/a.png)\n";
        compare(Attachments.split(plain).text, plain);
        compare(Attachments.split(plain).images, []);
    }

    function test_pathsNeverLeaveTheConversation(): void {
        compare(Attachments.split("![x](attachments/../../character.md)").images, []);
        compare(Attachments.split("![x](attachments/sub/a.png)").images, []);
        compare(Attachments.split("![x](/etc/passwd)").images, []);
        compare(Attachments.compose("hi", ["../a.png", "attachments/ok.png"]), "hi\n![image](attachments/ok.png)");
    }

    function test_onlyImagesTheDaemonTakes(): void {
        verify(Attachments.isImageFile("/tmp/shot.PNG"));
        verify(Attachments.isImageFile("/tmp/p.jpeg"));
        verify(!Attachments.isImageFile("/tmp/notes.md"));
        verify(!Attachments.isImageFile("/tmp/photo.heic"));
    }
}
