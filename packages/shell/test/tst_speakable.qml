import QtQuick
import QtTest
import "../qml/services/Speakable.js" as Speakable
import "../qml/services/SpeechVoices.js" as Voices

// What of a reply is read aloud, and the voices on offer.
TestCase {
    name: "Speakable"

    function test_theOpeningIsTheFirstParagraphAsSaid(): void {
        compare(Speakable.opening("It's **Friday** at 4pm, see [the board](https://x.y).\n\nMore detail here.", 600),
            "It's Friday at 4pm, see the board.");
        // A heading leads into the paragraph under it.
        compare(Speakable.opening("# Done\n\nI renamed `three` files.", 600), "Done I renamed three files.");
        // A list opening reads its items' words, not their marks.
        compare(Speakable.opening("- one\n- two", 600), "one two");
        // A bare address is not spelled out.
        compare(Speakable.opening("Open https://example.com/a/b now.", 600), "Open a link now.");
    }

    function test_codeIsMentionedNotRead(): void {
        compare(Speakable.opening("```sh\nrm -rf x\n```\n\nThen run it.", 600), Speakable.CODE_ON_SCREEN);
        compare(Speakable.opening("| a | b |\n| - | - |\n\nAfter the table.", 600), "After the table.");
    }

    function test_aLongOpeningIsCutAtASentence(): void {
        const long = "First sentence here. " + "Second sentence goes on and on. ".repeat(10);
        const cut = Speakable.opening(long, 80);
        verify(cut.length <= 80);
        verify(cut.endsWith("."));
        // No sentence end in reach: cut at a word.
        verify(Speakable.opening("word ".repeat(40), 30).endsWith("…"));
    }

    function test_onlyFinishedSentencesAreReady(): void {
        compare(Speakable.sentences("Hello there. How are"), { done: ["Hello there."], rest: "How are" });
        compare(Speakable.sentences("Yes! Really? Fine."), { done: ["Yes!", "Really?"], rest: "Fine." });
        compare(Speakable.sentences(""), { done: [], rest: "" });
    }

    function test_voicesComeWithASampleAndADownload(): void {
        compare(Voices.modelUrl("en_GB-jenny_dioco-medium"),
            "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium");
        compare(Voices.sampleUrl("en_US-ryan-medium"),
            "https://rhasspy.github.io/piper-samples/samples/en/en_US/ryan/medium/speaker_0.mp3");
        compare(Voices.modelUrl("not a voice"), "");
        // The catalogue first, then the owner's own voices; each says whether it is here.
        const offered = Voices.offered(["en_US-amy-medium", "de_DE-thorsten-medium"]);
        compare(offered.length, Voices.CATALOGUE.length + 1);
        verify(offered.find(v => v.id === "en_US-amy-medium").installed);
        verify(!offered.find(v => v.id === "en_US-ryan-medium").installed);
        compare(offered[offered.length - 1].id, "de_DE-thorsten-medium");
        verify(!offered[offered.length - 1].sample);
    }
}
