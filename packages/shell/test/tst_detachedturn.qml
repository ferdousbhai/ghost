import QtQuick
import QtTest
import "../qml/services"
import "FakeXhr.js" as FakeXhr

// A turn ghostd runs with no stream in this HUD — started by another client,
// or by this HUD before a reload — shows as running from the session listing.
TestCase {
    name: "DetachedTurn"

    property var sent: []

    function init(): void {
        sent = [];
        Ghostd.requestFactory = () => FakeXhr.make(sent);
        Ghostd.turnStates = ({});
        Ghostd.liveConversationKeys = [];
        Ghostd.activeGhost = "casper";
        Ghostd.sessionIds = ({ casper: "" });
        Ghostd.clearTurnProjection();
        Ghostd.reachable = true;
        Ghostd.hudVisible = false;
        Ghostd.sessions = [];
        Ghostd.adoptConversation("casper", "c1");
    }

    function cleanup(): void {
        Ghostd.requestFactory = null;
        Ghostd.turnStates = ({});
        Ghostd.currentSessionId = "";
        Ghostd.clearTurnProjection();
    }

    function requests(method: string, pattern: var): var {
        return sent.filter(xhr => xhr.method === method && pattern.test(xhr.url));
    }

    function list(running: bool): void {
        Ghostd.fetchSessions("casper");
        const pending = requests("GET", /\/sessions$/).filter(xhr => xhr.readyState !== 4);
        compare(pending.length, 1);
        pending[0].complete(200, { sessions: [{ id: "c1", title: "Fix the README", running: running }] });
    }

    function test_runningListingShowsTheTurnAndItsEndReloads(): void {
        Ghostd.activeTurnState(true).toolActivities = [{ id: "t1", name: "bash", status: "complete" }];
        list(true);
        verify(Ghostd.streaming);
        // No stream here, so nothing for the silence watchdog to expire, and
        // nothing of this HUD's last turn describes the running one.
        compare(Ghostd.liveConversationKeys, []);
        compare(Ghostd.toolActivities, []);
        // The transcript shows the prompt that is running…
        compare(requests("GET", /\/sessions\/c1\/transcript/).length, 1);

        list(false);
        verify(!Ghostd.streaming);
        // …and what ran, once it ends.
        compare(requests("GET", /\/sessions\/c1\/transcript/).length, 2);
    }

    function test_stopAsksGhostd(): void {
        list(true);
        Ghostd.cancel();
        const stops = requests("POST", /\/api\/ghosts\/casper\/sessions\/c1\/stop$/);
        compare(stops.length, 1);
        compare(stops[0].body, "{}");
        verify(!Ghostd.streaming);
    }

    function test_followUpQueuesIntoTheRunningTurn(): void {
        list(true);
        Ghostd.queueMessage("also check the issue");
        const queued = requests("POST", /\/sessions\/c1\/queue$/);
        compare(queued.length, 1);
        compare(JSON.parse(queued[0].body).text, "also check the issue");
    }
}
