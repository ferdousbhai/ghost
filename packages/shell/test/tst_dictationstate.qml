import QtTest
import "../qml/services"
import "../qml/services/DictationState.js" as DictationState

TestCase {
    name: "DictationState"

    property var recorder: null

    function init(): void {
        recorder = findChild(Dictation, "dictationCommand");
        verify(recorder !== null);
        recorder.running = false;
        recorder.command = [];
        Dictation.failure = "";
        Dictation.state = "idle";
    }

    function cleanup(): void {
        recorder.running = false;
        Dictation.failure = "";
        Dictation.state = "";
    }

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
        compare(DictationState.label("recording"), "Listening… F9 or click to stop, Esc to cancel");
        compare(DictationState.label("transcribing"), "Transcribing… Esc to cancel");
        compare(DictationState.label("idle"), "");
        compare(DictationState.label(""), "");
    }

    function test_micStartsAndStopsButNeverTogglesATranscription(): void {
        Dictation.toggle();
        compare(recorder.command, ["voxtype", "record", "start"]);
        recorder.simulateStarted();
        recorder.simulateExited(0);

        Dictation.state = "recording";
        Dictation.toggle();
        compare(recorder.command, ["voxtype", "record", "stop"]);
        recorder.simulateStarted();
        recorder.simulateExited(0);

        Dictation.state = "transcribing";
        verify(!Dictation.toggleable);
        recorder.command = [];
        Dictation.toggle();
        verify(!recorder.running);
        compare(recorder.command, []);
    }

    function test_cancelOnlyWhileBusy(): void {
        Dictation.cancel();
        verify(!recorder.running);

        for (const busy of ["recording", "transcribing"]) {
            Dictation.state = busy;
            verify(Dictation.cancellable);
            Dictation.cancel();
            compare(recorder.command, ["voxtype", "record", "cancel"]);
            recorder.simulateStarted();
            recorder.simulateExited(0);
        }
        compare(Dictation.failure, "");
    }

    function test_oneCommandAtATime(): void {
        Dictation.toggle();
        recorder.simulateStarted();
        Dictation.state = "recording";
        Dictation.toggle();
        compare(recorder.command, ["voxtype", "record", "start"]);
    }

    function test_failedCommandShowsUntilTheNextAttempt(): void {
        Dictation.toggle();
        recorder.simulateStarted();
        recorder.simulateExited(1);
        compare(Dictation.failure, "voxtype record start failed (exit 1)");
        compare(Dictation.label, "");

        Dictation.toggle();
        compare(Dictation.failure, "");
        recorder.simulateFailedToStart();
        compare(Dictation.failure, "Voxtype did not run");
    }

    function test_crashedCommandIsAFailure(): void {
        Dictation.state = "recording";
        Dictation.cancel();
        recorder.simulateStarted();
        recorder.simulateExited(0, 1);
        compare(Dictation.failure, "voxtype record cancel crashed");
    }
}
