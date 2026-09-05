import QtTest
import "../qml/services/DictationState.js" as DictationState

TestCase {
    name: "DictationState"

    function test_parsesVoxtypeStates(): void {
        compare(DictationState.parse("idle\n"), "idle");
        compare(DictationState.parse("  Recording"), "recording");
        compare(DictationState.parse("transcribing"), "transcribing");
    }

    function test_anythingElseMeansNoVoxtype(): void {
        compare(DictationState.parse(""), "");
        compare(DictationState.parse(null), "");
        compare(DictationState.parse("paused"), "");
        compare(DictationState.parse("recording idle"), "");
    }

    function test_labelsOnlyTheStatesWorthSaying(): void {
        compare(DictationState.label("recording"), "Listening… F9 or click to stop");
        compare(DictationState.label("transcribing"), "Transcribing…");
        compare(DictationState.label("idle"), "");
        compare(DictationState.label(""), "");
    }
}
