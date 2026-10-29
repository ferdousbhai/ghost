import QtQuick
import QtTest
import "../qml/components"
import "../qml/services"
import "FakeXhr.js" as FakeXhr

// Talking back: a turn asked aloud is marked spoken on the wire, its reply's
// opening is queued a sentence at a time in the ghost's voice, anything that
// silences it empties the queue, and a ghost with no voice never talks.
TestCase {
    id: tc
    name: "Speech"
    when: windowShown
    width: 700
    height: 400
    visible: true

    property var sent: []

    Component {
        id: pickerComponent
        VoicePicker { width: 680; ghost: "casper" }
    }

    function init(): void {
        sent = [];
        Ghostd.requestFactory = () => FakeXhr.make(sent);
        Ghostd.turnStates = ({});
        Ghostd.activeGhost = "casper";
        Ghostd.sessionIds = ({ casper: "" });
        Ghostd.clearTurnProjection();
        Ghostd.adoptConversation("casper", "c1");
        Speech.stop();
        Speech.engine = "/usr/bin/piper-tts";
        Speech.installed = ["en_US-amy-medium"];
        Speech.choices = ({ casper: "en_US-amy-medium" });
        Speech.installing = "";
    }

    function cleanup(): void {
        Speech.stop();
        Speech.engine = "";
        Speech.installed = [];
        Speech.choices = ({});
        Presence.dismiss();
        Presence.clear();
        Ghostd.requestFactory = null;
        Ghostd.turnStates = ({});
        Ghostd.currentSessionId = "";
        Ghostd.clearTurnProjection();
        Dictation.state = "";
    }

    function posted(): var {
        const messages = sent.filter(xhr => xhr.method === "POST" && /\/messages$/.test(xhr.url));
        return JSON.parse(messages[messages.length - 1].body);
    }

    function test_aSpokenTurnSaysSoOnTheWire(): void {
        Ghostd.send("what's on today?", true);
        compare(posted(), { prompt: "what's on today?", sessionId: "c1", spoken: true });
        Ghostd.turnStates = ({});
        Ghostd.clearTurnProjection();
        Ghostd.send("and tomorrow?", false);
        compare(posted().spoken, undefined);
    }

    function test_theOpeningIsQueuedASentenceAtATime(): void {
        Speech.follow("casper", "k1", "Hello there. How are", false);
        // The first sentence is being synthesised; the unfinished one waits.
        verify(Speech.speaking);
        compare(Speech.queued, 1);
        compare(Speech.pending.length, 0);
        Speech.follow("casper", "k1", "Hello there. How are you? Fine", false);
        compare(Speech.queued, 2);
        compare(Speech.pending.map(item => item.text), ["How are you?"]);
        // The reply finished: its last words go too, once.
        Speech.follow("casper", "k1", "Hello there. How are you? Fine", true);
        Speech.follow("casper", "k1", "Hello there. How are you? Fine", true);
        compare(Speech.pending.map(item => item.text), ["How are you?", "Fine"]);
        compare(Speech.pending[0].voice, "en_US-amy-medium");

        Speech.stop();
        verify(!Speech.speaking);
        compare(Speech.pending.length, 0);
    }

    function test_aGhostWithNoVoiceOrNoPiperStaysSilent(): void {
        Speech.follow("wisp", "k1", "Hello there. ", true);
        verify(!Speech.speaking);
        Speech.engine = "";
        verify(!Speech.canSpeak("casper"));
        Speech.follow("casper", "k1", "Hello there. ", true);
        verify(!Speech.speaking);
        // A chosen voice that is no longer installed is no voice.
        Speech.engine = "/usr/bin/piper-tts";
        Speech.installed = [];
        compare(Speech.voiceFor("casper"), "");
    }

    function test_theOwnerSpeakingAgainSilencesIt(): void {
        Speech.follow("casper", "k1", "One. Two. Three. ", true);
        verify(Speech.speaking);
        Dictation.state = "recording";
        verify(!Speech.speaking);
    }

    // The prompt: what was said aloud is asked aloud; what was typed is not.
    function test_thePromptMarksASpokenQuestion(): void {
        Dictation.state = "idle";
        Presence.summon();
        Dictation.state = "recording";
        Dictation.state = "transcribing";
        Dictation.state = "idle";
        Presence.send("remind me at five");
        verify(posted().spoken);

        Presence.clear();
        Ghostd.turnStates = ({});
        Ghostd.clearTurnProjection();
        Presence.summon();
        Presence.send("typed this one");
        verify(posted().spoken === undefined);
    }

    // Asked aloud of a silent ghost, nothing about speech reaches it.
    function test_aSilentGhostIsNeverToldItIsHeard(): void {
        Speech.choose("casper", "");
        Dictation.state = "idle";
        Presence.summon();
        Dictation.state = "transcribing";
        Dictation.state = "idle";
        Presence.send("remind me at five");
        verify(posted().spoken === undefined);
    }

    function test_thePickerDownloadsChoosesAndSilences(): void {
        const picker = createTemporaryObject(pickerComponent, tc);
        waitForRendering(picker);
        // An installed voice is this ghost's at a click.
        Speech.choose("casper", "");
        mouseClick(findChild(picker, "voice-en_US-amy-medium"));
        compare(Speech.voiceFor("casper"), "en_US-amy-medium");
        // One not yet here downloads for this ghost; a second click cancels.
        mouseClick(findChild(picker, "voice-en_US-ryan-medium"));
        compare(Speech.installing, "en_US-ryan-medium");
        // Silent is a choice too.
        Speech.installing = "";
        mouseClick(findChild(picker, "voice-silent"));
        compare(Speech.voiceFor("casper"), "");
    }

    function test_removingAVoiceSilencesTheGhostsThatUsedIt(): void {
        Speech.choices = ({ casper: "en_US-amy-medium", wisp: "en_US-amy-medium" });
        Speech.remove("en_US-amy-medium");
        compare(Speech.installed, []);
        compare(Speech.choices, ({}));
    }
}
