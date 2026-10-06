import QtQuick
import QtTest
import "../qml/components"
import "../qml/services"

// A prompt's image lines are pictures, not text: the line never reaches the
// bubble's words, and each named attachment becomes one image in the row.
TestCase {
    id: tc
    name: "PromptImages"
    when: windowShown
    width: 700
    height: 400
    visible: true

    Bubble {
        id: prompt

        width: 600
        speaker: "user"
        body: "what is this?\n![image](attachments/a.png)\n![image](attachments/b.png)"
        activities: []
        failure: ""
        busy: false
        rowIndex: 0
    }

    Bubble {
        id: reply

        width: 600
        speaker: "assistant"
        body: "![image](attachments/a.png)"
        activities: []
        failure: ""
        busy: false
        rowIndex: 1
    }

    function test_imageLinesBecomePictures(): void {
        compare(prompt.displayBody, "what is this?");
        compare(prompt.images, ["attachments/a.png", "attachments/b.png"]);
        const pictures = findChild(prompt, "promptImages");
        verify(pictures !== null);
        verify(pictures.visible);
        tryCompare(pictures.children, "length", 3); // two images and the Repeater
    }

    function test_aMissingPhotoSaysSoInOneLine(): void {
        Ghostd.ghosts = [{ name: "casper", dir: "/nonexistent/ghost-home" }];
        Ghostd.activeGhost = "casper";
        Ghostd.currentSessionId = "phone-1";
        const picture = findChild(prompt, "promptImages").children[0];
        tryCompare(picture, "status", Image.Error);
        verify(picture.height < prompt.imageSize * 0.75);
        verify(picture.children[0].visible);
        compare(picture.children[0].text, "Photo unavailable");
        Ghostd.currentSessionId = "";
        Ghostd.activeGhost = "";
        Ghostd.ghosts = [];
    }

    function test_onlyPromptsCarryAttachments(): void {
        compare(reply.images, []);
        verify(!findChild(reply, "promptImages").visible);
    }
}
