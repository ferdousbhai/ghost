import QtQuick
import QtTest
import "../qml/components"
import "../qml/services"

// The composer's dictation controls: the field holds focus before a Voxtype
// command goes out, Esc cancels dictation before it reaches the HUD, and a
// failed command shows whatever the draft or dictation state.
TestCase {
    name: "DictationComposer"
    when: windowShown
    width: 400
    height: 200
    visible: true

    property int escapesReachingHud: 0

    Item {
        id: hud
        anchors.fill: parent
        Keys.onEscapePressed: event => {
            escapesReachingHud += 1;
            event.accepted = true;
        }

        TextInput { id: elsewhere; width: 50; height: 20 }

        Composer {
            id: composer
            y: 100
            width: 400
            height: implicitHeight
        }
    }

    property var recorder: null
    property var field: null
    property var focusAtCommand: []

    Connections {
        target: recorder
        function onCommandChanged(): void { focusAtCommand.push(field.activeFocus); }
    }

    function init(): void {
        recorder = findChild(Dictation, "dictationCommand");
        field = findChild(composer, "composerField");
        verify(recorder !== null && field !== null);
        recorder.running = false;
        recorder.command = [];
        focusAtCommand = [];
        escapesReachingHud = 0;
        Dictation.failure = "";
        Dictation.state = "idle";
    }

    function cleanup(): void {
        recorder.running = false;
        composer.text = "";
        Dictation.failure = "";
        Dictation.state = "";
    }

    function test_micFocusesTheFieldBeforeStarting(): void {
        elsewhere.forceActiveFocus();
        const mic = findChild(composer, "dictationButton");
        tryVerify(() => mic.visible && mic.width > 0);
        mouseClick(mic);
        compare(recorder.command, ["voxtype", "record", "start"]);
        compare(focusAtCommand, [true]);
    }

    function test_cancelButtonOnlyWhileBusy(): void {
        const cancel = findChild(composer, "cancelDictation");
        verify(!cancel.visible);
        Dictation.state = "transcribing";
        tryVerify(() => cancel.visible);
        elsewhere.forceActiveFocus();
        mouseClick(cancel);
        compare(recorder.command, ["voxtype", "record", "cancel"]);
        compare(focusAtCommand, [true]);
    }

    function test_escapeCancelsDictationThenBubbles(): void {
        Dictation.state = "recording";
        composer.take();
        keyClick(Qt.Key_Escape);
        compare(recorder.command, ["voxtype", "record", "cancel"]);
        compare(escapesReachingHud, 0);

        recorder.simulateStarted();
        recorder.simulateExited(0);
        Dictation.state = "idle";
        keyClick(Qt.Key_Escape);
        compare(escapesReachingHud, 1);
    }

    function test_micDisabledWhileTranscribingButCancelWorks(): void {
        const mic = findChild(composer, "dictationButton");
        Dictation.state = "transcribing";
        tryVerify(() => !mic.enabled);
        mouseClick(mic);
        compare(recorder.command, []);
        mouseClick(findChild(composer, "cancelDictation"));
        compare(recorder.command, ["voxtype", "record", "cancel"]);
    }

    function test_failureShowsBesideADraftWhileBusyAndClearsOnTheNextAttempt(): void {
        const status = findChild(composer, "dictationFailure");
        const idleHeight = composer.implicitHeight;
        composer.text = "half a thought";
        Dictation.state = "recording";
        mouseClick(findChild(composer, "cancelDictation"));
        recorder.simulateStarted();
        recorder.simulateExited(1);

        tryVerify(() => status.visible);
        compare(status.text, "voxtype record cancel failed (exit 1)");
        verify(status.height > 0);
        verify(composer.implicitHeight >= idleHeight + status.implicitHeight);

        mouseClick(findChild(composer, "dictationButton"));
        compare(recorder.command, ["voxtype", "record", "stop"]);
        tryVerify(() => !status.visible);
        compare(composer.implicitHeight, idleHeight);
    }
}
