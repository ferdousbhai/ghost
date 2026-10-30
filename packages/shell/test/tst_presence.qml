import QtQuick
import QtTest
import Quickshell.Hyprland
import "../qml/services"
import "FakeXhr.js" as FakeXhr

// The desktop presence: a summon listens and composes, a send lets go of the
// keyboard and follows that one conversation to its reply, and a summon over
// that reply follows up in the same conversation unless told to start fresh.
TestCase {
    name: "Presence"

    property var sent: []
    property var recorder: null

    function init(): void {
        sent = [];
        Ghostd.requestFactory = () => FakeXhr.make(sent);
        Ghostd.turnStates = ({});
        Ghostd.liveConversationKeys = [];
        Ghostd.activeGhost = "casper";
        Ghostd.ghosts = [{ name: "casper" }];
        Ghostd.sessionIds = ({ casper: "" });
        Ghostd.clearTurnProjection();
        Ghostd.reachable = true;
        // The window has an older conversation open; a blank one would be reused.
        Ghostd.sessions = [{ id: "c1", title: "older", messageCount: 2 }];
        Ghostd.adoptConversation("casper", "c1");
        Hyprland.focusedMonitor = { name: "DP-1" };
        recorder = findChild(Dictation, "dictationCommand");
        recorder.running = false;
        recorder.command = [];
        Dictation.state = "";
        Presence.composing = false;
        Presence.clear();
    }

    function cleanup(): void {
        Ghostd.requestFactory = null;
        Ghostd.turnStates = ({});
        Ghostd.currentSessionId = "";
        Ghostd.clearTurnProjection();
        Presence.composing = false;
        Presence.clear();
    }

    function posts(): var {
        return sent.filter(xhr => xhr.method === "POST" && /\/api\/ghosts\/casper\/messages$/.test(xhr.url));
    }

    function finish(xhr: var, text: string): void {
        xhr.complete(200, "data: {\"type\":\"start\"}\n\n"
            + "data: " + JSON.stringify({ type: "text_delta", contentIndex: 0, delta: text }) + "\n\n"
            + "data: {\"type\":\"done\"}\n\n");
    }

    function test_aSendFollowsItsConversationToTheReply(): void {
        Presence.summon();
        verify(Presence.composing);
        compare(Presence.screenName, "DP-1");

        Presence.send("what's on my board?");
        verify(!Presence.composing);
        compare(Presence.phase, "working");
        compare(posts().length, 1);
        const sessionId = JSON.parse(posts()[0].body).sessionId;
        compare(Presence.sessionId, sessionId);
        // A fresh summon is a fresh conversation, not the one the window had.
        verify(sessionId !== "c1");

        Ghostd.turnFinished("casper", "elsewhere", "c1", "");
        compare(Presence.phase, "working");

        finish(posts()[0], "Two cards.");
        compare(Presence.phase, "answered");
        compare(Presence.answer, "Two cards.");
    }

    function test_aSummonOverTheReplyFollowsUp(): void {
        Presence.summon();
        Presence.send("first");
        const sessionId = Presence.sessionId;
        finish(posts()[0], "One.");

        Presence.summon();
        verify(Presence.continuing);
        Presence.send("and then?");
        compare(posts().length, 2);
        compare(JSON.parse(posts()[1].body).sessionId, sessionId);
        finish(posts()[1], "Two.");

        Presence.summon();
        Presence.startFresh();
        Presence.send("unrelated");
        verify(JSON.parse(posts()[2].body).sessionId !== sessionId);
    }

    // A follow-up whose ghost was banished while the prompt stood cannot
    // continue that conversation: it starts a fresh one with the ghost now
    // active, never lands in whatever conversation that ghost has open.
    function test_aFollowUpToABanishedGhostStartsAfresh(): void {
        Presence.summon();
        Presence.send("first");
        finish(posts()[0], "One.");
        Presence.summon();
        verify(Presence.continuing);

        Ghostd.ghosts = [{ name: "nick" }];
        Ghostd.forgetGhost("casper");
        Ghostd.switchGhost("nick");
        Ghostd.sessions = [{ id: "n1", title: "nick's", messageCount: 3 }];
        Ghostd.adoptConversation("nick", "n1");
        Presence.send("and then?");

        const post = sent.filter(xhr => xhr.method === "POST" && /\/messages$/.test(xhr.url)).pop();
        verify(/\/api\/ghosts\/nick\/messages$/.test(post.url));
        verify(JSON.parse(post.body).sessionId !== "n1");
        compare(Presence.ghost, "nick");
    }

    function test_dismissKeepsTheTurnAndClearForgetsIt(): void {
        Presence.summon();
        Presence.send("long job");
        Presence.summon();
        Presence.dismiss();
        verify(!Presence.composing);
        compare(Presence.phase, "working");

        Presence.clear();
        compare(Presence.phase, "");
        // A forgotten turn's end is no longer the presence's: the toast owns it.
        finish(posts()[0], "Done.");
        verify(!Presence.mine("casper", JSON.parse(posts()[0].body).sessionId));
    }

    // `ghost ask`: the card shows the question from the listing, and a picked
    // answer is the owner's next message in the same conversation.
    function test_aQuestionIsAnsweredInItsConversation(): void {
        Presence.summon();
        Presence.send("plan the release");
        const sessionId = Presence.sessionId;
        finish(posts()[0], "One thing first.");
        compare(Presence.question, null);

        Ghostd.sessions = Ghostd.sessions.map(session => session.id === sessionId
            ? Object.assign({}, session, { question: { text: "Tonight?", options: ["yes", "no"] } }) : session);
        compare(Presence.question.text, "Tonight?");

        Presence.answerQuestion("yes");
        compare(posts().length, 2);
        compare(JSON.parse(posts()[1].body), { prompt: "yes", sessionId: sessionId });
    }

    function test_dismissingAQuestionWithdrawsItUnanswered(): void {
        Presence.summon();
        Presence.send("plan");
        finish(posts()[0], "Hm.");
        const sessionId = Presence.sessionId;
        Ghostd.sessions = Ghostd.sessions.map(session => session.id === sessionId
            ? Object.assign({}, session, { question: { text: "Which?", options: [] } }) : session);
        Presence.dismissQuestion();
        compare(Presence.question, null);
        const deletes = sent.filter(xhr => xhr.method === "DELETE");
        compare(deletes.length, 1);
        verify(deletes[0].url.endsWith("/sessions/" + sessionId + "/question"));
    }

    function test_aFailedTurnShowsItsError(): void {
        Presence.summon();
        Presence.send("break");
        Ghostd.turnFailed("casper", "harness exited", Presence.sessionId, "");
        compare(Presence.phase, "failed");
        compare(Presence.failure, "harness exited");
    }

    function test_aSummonListensAndADismissDiscardsTheRecording(): void {
        Dictation.state = "idle";
        Presence.summon();
        compare(recorder.command, ["voxtype", "record", "start"]);

        recorder.running = false;
        Dictation.state = "recording";
        Presence.dismiss();
        compare(recorder.command, ["voxtype", "record", "cancel"]);
    }

    function test_enterSendsWhatVoxtypeTypedOrWaitsAgain(): void {
        Dictation.state = "idle";
        Presence.summon();
        Presence.sendAfterDictation = true;
        Dictation.state = "transcribing";
        Presence.dictationSettled("half");
        compare(posts().length, 0);

        // It heard nothing: the prompt stays, waiting for words again.
        Dictation.state = "idle";
        Presence.dictationSettled("  ");
        verify(Presence.composing);
        verify(!Presence.sendAfterDictation);
        compare(posts().length, 0);

        Presence.sendAfterDictation = true;
        Presence.dictationSettled("what's next");
        compare(posts().length, 1);
        compare(JSON.parse(posts()[0].body).prompt, "what's next");
    }

    function test_withoutVoxtypeASummonOnlyComposes(): void {
        Presence.summon();
        verify(Presence.composing);
        compare(recorder.command, []);
    }

    function test_openInWindowHandsOverAndForgets(): void {
        Presence.summon();
        Presence.send("show me");
        const sessionId = Presence.sessionId;
        windowRequests.clear();
        Presence.openInWindow();
        compare(windowRequests.count, 1);
        compare(windowRequests.signalArguments[0][0], "casper");
        compare(windowRequests.signalArguments[0][1], sessionId);
        compare(Presence.phase, "");
    }

    SignalSpy {
        id: windowRequests
        target: Presence
        signalName: "windowRequested"
    }
}
