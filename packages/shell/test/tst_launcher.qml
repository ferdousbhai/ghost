import QtQuick
import QtTest
import "../qml/components"
import "../qml/services"
import "../qml/components/Launcher.js" as Launcher
import "FakeXhr.js" as FakeXhr

// Where the HUD opens: a filter over conversations and places. Enter opens
// what was searched for and asks the ghost when there was nothing to find;
// headers are never landed on; a conversation renames, pins and trashes from
// its row.
TestCase {
    id: tc
    name: "Launcher"
    when: windowShown
    width: 700
    height: 600
    visible: true

    readonly property real now: Date.parse("2026-10-28T12:00:00Z")
    readonly property var sessions: [
        { id: "a", title: "Fix the README", preview: "can you fix the readme", pinned: true,
            updatedAt: "2026-10-20T12:00:00Z" },
        { id: "b", title: null, preview: "what's on my board?", unread: true,
            updatedAt: "2026-10-28T11:30:00Z" },
        { id: "c", title: "Taxes", preview: "", running: true, updatedAt: "2026-10-28T11:59:30Z" }
    ]

    function kinds(rows: var): var {
        return rows.map(row => row.kind + ":" + row.id);
    }

    function test_emptyQueryOffersNewThenConversationsThenPlaces(): void {
        const rows = Launcher.rows("", sessions, "casper", now, 0);
        compare(kinds(rows).slice(0, 5), ["new:new", "header:h-conversations", "session:a", "session:b", "session:c"]);
        compare(rows[5].kind, "header");
        compare(rows[5].label, "casper");
        compare(rows.filter(row => row.kind === "place").map(row => row.id),
            ["board", "routines", "character", "ghosts", "hooks", "mcp", "remote"]);
        verify(!rows.some(row => row.kind === "ask"));
    }

    function test_aConversationRowSaysWhatItIs(): void {
        const rows = Launcher.rows("", sessions, "casper", now, 0);
        const untitled = rows.find(row => row.id === "b");
        compare(untitled.label, "what's on my board?");
        compare(untitled.title, "");
        compare(untitled.meta, "30m");
        verify(untitled.unread);
        compare(rows.find(row => row.id === "a").meta, "20 Oct");
        compare(rows.find(row => row.id === "a").detail, "can you fix the readme");
        compare(rows.find(row => row.id === "c").meta, "now");
        verify(rows.find(row => row.id === "c").running);
    }

    function test_aMatchComesFirstAndAskingComesLast(): void {
        const rows = Launcher.rows("readme", sessions, "casper", now, 0);
        compare(kinds(rows), ["header:h-conversations", "session:a", "header:h-ask", "ask:ask"]);
        compare(rows[Launcher.first(rows)].id, "a");
        compare(rows[3].detail, "readme");
    }

    function test_nothingToFindMeansAsking(): void {
        const rows = Launcher.rows("  why is the sky blue ", sessions, "casper", now, 0);
        compare(kinds(rows), ["ask:ask"]);
        compare(rows[0].label, "Ask casper");
        compare(rows[0].detail, "why is the sky blue");
    }

    function test_placesMatchByNameOrHint(): void {
        const rows = Launcher.rows("phone", sessions, "casper", now, 0);
        compare(rows.filter(row => row.kind === "place").map(row => row.label), ["Remote access"]);
    }

    function test_hooksSayHowManyAreLoaded(): void {
        compare(Launcher.rows("", [], "casper", now, 7).find(row => row.id === "hooks").detail, "7 loaded");
        compare(Launcher.rows("", [], "casper", now, 0).find(row => row.id === "hooks").detail,
            "lifecycle commands");
    }

    function test_movingSkipsHeadersAndStopsAtTheEnds(): void {
        const rows = Launcher.rows("", sessions, "casper", now, 0);
        compare(Launcher.step(rows, 0, 1), 2);
        compare(Launcher.step(rows, 2, -1), 0);
        compare(Launcher.step(rows, 0, -1), 0);
        const last = rows.length - 1;
        compare(Launcher.step(rows, last, 1), last);
    }

    // The component: keys on the filter reach the row they mean.
    Component {
        id: launcherComponent
        Launcher {
            width: 600
            maxListHeight: 400
        }
    }

    property var sent: []

    function init(): void {
        sent = [];
        Ghostd.requestFactory = () => FakeXhr.make(sent);
        Ghostd.activeGhost = "casper";
        Ghostd.ghosts = [{ name: "casper" }];
        Ghostd.sessions = sessions;
    }

    function cleanup(): void {
        Ghostd.requestFactory = null;
        Ghostd.sessions = [];
    }

    function test_enterOpensTheSelectedRow(): void {
        const launcher = createTemporaryObject(launcherComponent, tc);
        const chosen = [];
        launcher.activated.connect(row => chosen.push(row.kind + ":" + row.id));
        launcher.reset();
        keyClick(Qt.Key_Down);
        keyClick(Qt.Key_Return);
        compare(chosen, ["session:a"]);

        keyClick("t");
        keyClick("a");
        keyClick("x");
        keyClick(Qt.Key_Return);
        compare(chosen[1], "session:c");
    }

    function test_deleteAsksAboutTheSelectedConversation(): void {
        const launcher = createTemporaryObject(launcherComponent, tc);
        const asked = [];
        launcher.deleteRequested.connect((id, title) => asked.push([id, title]));
        launcher.reset();
        keyClick(Qt.Key_Delete);
        compare(asked.length, 0);
        keyClick(Qt.Key_Down);
        keyClick(Qt.Key_Delete);
        compare(asked, [["a", "Fix the README"]]);
    }

    function test_ctrlRRenamesWhereItIsRead(): void {
        const launcher = createTemporaryObject(launcherComponent, tc);
        launcher.reset();
        keyClick(Qt.Key_Down);
        keyClick(Qt.Key_R, Qt.ControlModifier);
        compare(launcher.rename.editingKey, "a");
        compare(launcher.rename.draft, "Fix the README");
        keyClick(Qt.Key_Escape);
        compare(launcher.rename.editingKey, "");
    }

    function test_ctrlPPinsTheSelectedConversation(): void {
        const launcher = createTemporaryObject(launcherComponent, tc);
        launcher.reset();
        keyClick(Qt.Key_Down);
        keyClick(Qt.Key_P, Qt.ControlModifier);
        const pins = sent.filter(xhr => /\/sessions\/a\/pin$/.test(xhr.url) || /\/sessions\/a$/.test(xhr.url));
        verify(pins.length > 0, JSON.stringify(sent.map(xhr => xhr.method + " " + xhr.url)));
    }
}
