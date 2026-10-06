import QtTest
import "../qml/services/Attachments.js" as Attachments

TestCase {
    name: "Attachments"

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
        verify(!Attachments.isAttachmentPath("/etc/passwd"));
    }
}
