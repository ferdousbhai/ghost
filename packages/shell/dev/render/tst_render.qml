import QtQuick
import QtTest
import "../../qml"
import "../../qml/components"
import "../../qml/services"
import "../../test/FakeXhr.js" as FakeXhr

// Renders every Ghost surface to dev/render/out/<name>.png, offscreen, from
// fixed sample data: a design review that needs no desktop, daemon or
// window. Run with `bash dev/render.sh`; see dev/README.md.
TestCase {
    id: tc
    name: "Render"
    when: windowShown
    width: 1200
    height: 900
    visible: true

    readonly property string out: "dev/render/out/"
    property var sent: []
    property bool boardMissing: false

    Rectangle { id: stage; anchors.fill: parent; color: Theme.background }

    // The daemon's answers, by route, in the shapes ghostd sends.
    function answer(): void {
        for (const xhr of tc.sent) {
            if (xhr.readyState === 4) continue;
            const url = xhr.url;
            if (/\/mcp$/.test(url)) xhr.complete(200, { servers: [
                { name: "github", enabled: true, path: "mcp.json", config: { command: "github-mcp", args: ["--read-only"] } },
                { name: "linear", enabled: false, path: "mcp.json", config: { type: "http", url: "https://mcp.linear.app/sse" } }
            ], skipped: [] });
            else if (/\/api\/hooks\/config$/.test(url)) xhr.complete(200, { path: "/home/owner/.config/ghost/hooks.json", document: { hooks: {
                before_prompt: [{ hooks: [{ type: "command", command: "/home/owner/bin/context", name: "Add context", timeout: 5 }] }],
                turn_end: [{ hooks: [{ type: "command", command: "/home/owner/bin/ntfy", name: "Phone alert", timeout: 15 }] }]
            } } });
            else if (/\/routines$/.test(url)) xhr.complete(200, { routines: [{
                ghost: "dous", slug: "daily-notes", unit: "ghost-dous-daily-notes.timer", service: "ghost-dous-daily-notes.service",
                timerPath: "/home/owner/.config/systemd/user/ghost-dous-daily-notes.timer",
                servicePath: "/home/owner/.config/systemd/user/ghost-dous-daily-notes.service",
                description: "Tidy my notes", schedule: "OnCalendar=daily", nextRun: "Thu 2026-10-29 00:00:00 EET",
                lastRun: "Wed 2026-10-28 00:00:03 EET", enabled: "enabled", active: "active",
                command: "/usr/bin/ghost say --new --ghost dous \"Tidy my notes\"", result: "success", serviceActive: "inactive"
            }], recoveries: [] });
            else if (/\/api\/board$/.test(url) && tc.boardMissing) xhr.complete(200, { path: "/home/owner/Documents/board.md",
                exists: false, title: "", modified: "", truncated: false, columns: [] });
            else if (/\/api\/board$/.test(url)) xhr.complete(200, { path: "/home/owner/Documents/board.md", exists: true,
                title: "Board", modified: "2026-10-28T10:00:00Z", truncated: false, columns: [
                    { title: "Now", cards: [{ text: "Ship the launcher redesign", done: false, notes: ["design pass done"] },
                        { text: "Weekly review routine", notes: [] }] },
                    { title: "Next", cards: [{ text: "Recall in the launcher", notes: [] }] },
                    { title: "Done", cards: [{ text: "Bar mark in herdr's states", done: true, notes: [] }] }] });
            else if (/\/character$/.test(url)) xhr.complete(200, { body: "# Dous\n\nYou are Dous, the owner's ghost. Short answers, plain words.\n", limit: 16000 });
            else if (/\/harness$/.test(url)) xhr.complete(200, { harnesses: [
                { id: "claude", usage: { status: null, stale: false, updatedAt: null, windows: [
                    { label: "Session (5-hour)", percent: 0.09, resetsAt: null }, { label: "Weekly (7-day)", percent: 0.71, resetsAt: null }] },
                    effort: "low", resting: null },
                { id: "opencode", usage: null, effort: null, resting: null },
                { id: "pi", usage: null, effort: null,
                    resting: { until: "2026-11-01T00:00:00.000Z", reason: "429 monthly API usage threshold reached" } }
            ], ghostDefault: null, omarchyDefault: "claude" });
            else if (/\/api\/remote$/.test(url)) xhr.complete(200, { enabled: true, state: "on", scheme: "https",
                hostname: "omarchy.tail58bdd3.ts.net", url: "https://omarchy.tail58bdd3.ts.net",
                tailscale: { installed: true, running: true, loggedIn: true, operator: true, certs: true },
                guests: "read-only", owner: "owner@example.com", problem: null });
        }
    }

    function shot(item: var, name: string): void {
        for (let i = 0; i < 4; i += 1) {
            tc.answer();
            wait(60);
        }
        grabImage(item).save(tc.out + name + ".png");
    }

    /** One object, captured alone: made, shot, and gone before the next. */
    function snap(component: Component, props: var, name: string): void {
        const item = component.createObject(stage, Object.assign({ x: 20, y: 20 }, props || {}));
        tc.shot(item, name);
        item.destroy();
        wait(30);
    }

    function initTestCase(): void {
        Ghostd.requestFactory = () => FakeXhr.make(tc.sent);
        Ghostd.reachable = true;
        Ghostd.activeGhost = "dous";
        Ghostd.ghosts = [{ name: "dous" }, { name: "casper" }];
        const now = Date.now();
        Ghostd.sessions = [
            { id: "p", title: "What's my canadian address", preview: "what's my canadian address", pinned: true, updatedAt: new Date(now - 3600000).toISOString() },
            { id: "q", title: "Weekly review routine", preview: "set up a weekly review routine", question: { text: "Which day should the review run, and at what time?", options: ["Friday 4pm", "Sunday evening", "Monday 9am"] }, updatedAt: new Date(now - 40 * 60000).toISOString() },
            { id: "a", title: "Add a reminder at 3:10PM to leave", preview: "add a reminder at 3:10PM to leave for home", unread: true, updatedAt: new Date(now - 27 * 60000).toISOString() },
            { id: "r", title: "When using my folder explorer tool", preview: "when using my folder explorer tool, it crashes", running: true, updatedAt: new Date(now - 51 * 60000).toISOString() },
            { id: "t", title: "The taskbar doesn't seem to show", preview: "the taskbar doesn't seem to show up", updatedAt: "2026-10-16T18:28:49Z" },
            { id: "c", title: "Connectivity check from the owner's coding session", preview: "Connectivity check", updatedAt: "2026-10-16T13:46:12Z" }
        ];
    }

    Component { id: launcherC; Launcher { width: Theme.ch(76) + Theme.pad * 2; maxListHeight: 600 } }
    function test_launcher(): void {
        const l = createTemporaryObject(launcherC, stage, { x: 20, y: 20 });
        l.reset();
        shot(l, "launcher-home");
        keyClick("r");
        keyClick("e");
        shot(l, "launcher-filtered");
        l.mode = "ghosts";
        shot(l, "launcher-ghosts");
    }

    Component { id: promptC; PresencePrompt { width: 640; active: true } }
    function test_prompt(): void {
        snap(promptC, { x: 20, y: 20 }, "prompt");
    }

    Component { id: cardC; PresenceCard { maxHeight: 500 } }
    function test_presenceCard(): void {
        Presence.ghost = "dous";
        Presence.sessionId = "q";
        Presence.answer = "I can set that up as a weekly timer. **Before I do**, one thing:";
        Presence.phase = "answered";
        snap(cardC, { x: 20, y: 20 }, "card-question");
        Presence.sessionId = "a";
        Presence.answer = "Done. The reminder **Leave for home** is set for 3:10 PM today in your iCloud list.";
        snap(cardC, { x: 20, y: 20 }, "card-answered");
        Presence.failure = "pi refused: monthly API usage limit reached. You will regain access on 2026-11-01.";
        Presence.phase = "failed";
        snap(cardC, { x: 20, y: 20 }, "card-failed");
        Presence.phase = "";
    }

    Component { id: activityC; ActivityLine { width: 560 } }
    function test_activity(): void {
        Ghostd.streaming = true;
        Ghostd.toolActivities = [{ id: "x", name: "bash", status: "running", arguments: { command: "cloud-tasks lists --json" }, startedAt: Date.now() - 4200 }];
        const line = createTemporaryObject(activityC, stage, { x: 20, y: 20 });
        wait(500);
        shot(line, "activity-line");
        Ghostd.toolActivities = [];
        Ghostd.streaming = false;
    }

    Component { id: questionC; QuestionLine { width: 560 } }
    function test_question(): void {
        const q = createTemporaryObject(questionC, stage, { x: 20, y: 20 });
        q.question = { text: "Which day should the review run, and at what time?", options: ["Friday 4pm", "Sunday evening", "Monday 9am"] };
        shot(q, "question");
    }

    Component { id: toolC; ToolCard { width: 640 } }
    function test_toolCards(): void {
        snap(toolC, { x: 20, y: 20, activity: { id: "1", name: "bash", status: "running", arguments: { command: "cloud-tasks lists --json" } } }, "tool-running");
        snap(toolC, { x: 20, y: 20, activity: { id: "2", name: "edit", status: "complete", arguments: { path: "/home/owner/Documents/board.md" }, summary: "1 edit" } }, "tool-complete");
        snap(toolC, { x: 20, y: 20, activity: { id: "3", name: "read", status: "failed", arguments: { path: "/home/owner/notes/plan.md" }, summary: "ENOENT: no such file or directory" } }, "tool-failed");
    }

    Component {
        id: bubbleC
        Bubble { width: 760; activities: []; failure: ""; busy: false; rowIndex: 0 }
    }
    function test_bubbles(): void {
        snap(bubbleC, { x: 20, y: 20, speaker: "user", body: "What's on my board today?" }, "bubble-user");
        snap(bubbleC, { x: 20, y: 20, speaker: "assistant",
            body: "Two cards are in **Now**:\n\n- Ship the launcher redesign\n- Weekly review routine\n\nRun `ghost board` to see the rest, or open [the board](https://example.com/board)." }, "bubble-assistant");
        snap(bubbleC, { x: 20, y: 20, speaker: "assistant",
            body: "Here is the timer:\n\n```ini\n[Timer]\nOnCalendar=Fri 16:00\nPersistent=true\n```" }, "bubble-code");
        snap(bubbleC, { x: 20, y: 20, speaker: "assistant", body: "",
            failure: "pi refused: monthly API usage limit reached." }, "bubble-failed");
        snap(bubbleC, { x: 20, y: 20, speaker: "assistant",
            body: "Run this:\n\n```sh\nsystemctl --user list-timers\n```" }, "bubble-ends-in-code");
    }

    Component { id: composerC; Composer { width: 760; maxHeight: 200 } }
    function test_composer(): void {
        snap(composerC, { x: 20, y: 20 }, "composer");
    }

    Component { id: welcomeC; Welcome { width: 520 } }
    function test_welcome(): void {
        snap(welcomeC, { x: 20, y: 20 }, "welcome");
    }

    Component { id: headerC; HudHeader { width: 900 } }
    function test_header(): void {
        Ghostd.currentSessionId = "a";
        snap(headerC, { x: 20, y: 20 }, "hud-header");
    }

    Component { id: boardC; Board { width: 900; height: 520 } }
    Component { id: routinesC; Routines { width: 900; height: 520 } }
    Component { id: hooksC; HooksBrowser { width: 900; height: 520 } }
    Component { id: mcpC; McpBrowser { width: 900; height: 520 } }
    Component { id: remoteC; RemoteAccess { width: 900; height: 520 } }
    Component { id: characterC; CharacterPane { width: 900; height: 520 } }
    function test_panes(): void {
        Ghostd.refreshBoard();
        snap(boardC, { x: 20, y: 20 }, "pane-board");
        Ghostd.refreshRoutines();
        snap(routinesC, { x: 20, y: 20 }, "pane-routines");
        snap(hooksC, { x: 20, y: 20 }, "pane-hooks");
        snap(mcpC, { x: 20, y: 20 }, "pane-mcp");
        Ghostd.refreshRemote();
        snap(remoteC, { x: 20, y: 20 }, "pane-remote");
        // The pane fetches when it becomes visible; here it is visible from birth.
        Ghostd.fetchCharacter(true);
        tc.answer();
        wait(60);
        snap(characterC, { x: 20, y: 20 }, "pane-character");
    }

    // The whole HUD: its window is an Item under the test stubs, so the card,
    // its top bar and a pane render together, as on the desktop.
    Component { id: hudC; GhostHud { width: 1200; height: 860 } }
    function test_hud(): void {
        const hud = hudC.createObject(stage, { x: 0, y: 0 });
        hud.open();
        tc.shot(hud, "hud-home");
        hud.showSection("routines");
        tc.shot(hud, "hud-routines");
        Ghostd.fetchCharacter(true);
        hud.showSection("character");
        tc.shot(hud, "hud-character");
        Ghostd.newConversation();
        hud.showSection("chat");
        tc.shot(hud, "hud-chat-empty");
        hud.destroy();
        wait(30);
    }

    // States a session reaches beyond each surface's first look.
    Component {
        id: headerBoxC
        Item {
            property alias header: boxHeader
            width: 900
            height: 420
            HudHeader { id: boxHeader; width: parent.width }
        }
    }
    Component { id: queueC; QueueLine { width: 640 } }
    function test_states(): void {
        Ghostd.reachable = true;
        const box = headerBoxC.createObject(stage, { x: 20, y: 20 });
        box.header.togglePicker();
        tc.shot(box, "hud-header-picker");
        box.destroy();
        wait(30);

        snap(toolC, { expanded: true, activity: { id: "4", name: "bash", status: "complete",
            arguments: { command: "cloud-tasks lists --json" }, summary: "[{\"id\":\"icloud:C1B4\",\"name\":\"Reminders\"}]" } }, "tool-expanded");
        snap(queueC, { followUps: ["also check the issue tracker"] }, "queue-line");

        const mcp = mcpC.createObject(stage, { x: 20, y: 20 });
        tc.answer();
        mcp.beginAdd();
        tc.shot(mcp, "pane-mcp-adding");
        mcp.destroy();
        wait(30);

        const hooks = hooksC.createObject(stage, { x: 20, y: 20 });
        tc.answer();
        wait(60);
        hooks.beginDraft();
        tc.shot(hooks, "pane-hooks-new");
        hooks.destroy();
        wait(30);

        Ghostd.refreshRoutines();
        const routines = routinesC.createObject(stage, { x: 20, y: 20 });
        tc.answer();
        Ghostd.routineConfigReady("dous", "daily-notes", { timer: "[Timer]\nOnCalendar=daily\nPersistent=true\n",
            service: "[Service]\nType=oneshot\nExecStart=/usr/bin/ghost say --new --ghost dous \"Tidy my notes\"\n", revision: "r1" });
        tc.shot(routines, "pane-routines-editing");
        routines.destroy();
        wait(30);

        tc.boardMissing = true;
        Ghostd.refreshBoard();
        snap(boardC, {}, "pane-board-empty");
        tc.boardMissing = false;

        const sessions = Ghostd.sessions;
        Ghostd.sessions = [];
        const launcher = launcherC.createObject(stage, { x: 20, y: 20 });
        launcher.reset();
        tc.shot(launcher, "launcher-empty");
        launcher.destroy();
        Ghostd.sessions = sessions;
        wait(30);

        Dictation.state = "recording";
        snap(promptC, {}, "prompt-listening");
        Dictation.state = "";
    }

    Component {
        id: confirmC
        ConfirmDialog { width: 900; height: 520; open: true; title: "Banish casper?"; body: "Its persona, memories, credentials, and conversations move to Trash. The owner's own documents stay on this machine. Type “casper” to confirm."; challenge: "casper"; confirmText: "Banish" }
    }
    function test_confirm(): void {
        snap(confirmC, { x: 20, y: 20 }, "confirm-dialog");
    }

    QtObject {
        id: bar
        readonly property bool vertical: false
        readonly property int barSize: 26
        property var shell: null
        function showTooltip(item, label): void {}
        function hideTooltip(item): void {}
    }
    Component { id: barC; GhostBarWidget { bar: bar } }
    function test_barMark(): void {
        const states = [
            ["idle", [{ id: "a" }]], ["done", [{ id: "a", unread: true }]], ["working", [{ id: "a", running: true }]],
            ["blocked", [{ id: "a", question: { text: "?", options: [] } }]],
            ["found", [{ id: "event-a", unread: true }, { id: "a", unread: true }]],
            ["found-many", Array.from({ length: 12 }, (_, i) => ({ id: "event-" + i, unread: true }))],
            ["working-found", [{ id: "event-a", unread: true }, { id: "event-b", unread: true }, { id: "a", running: true }]]
        ];
        const was = Ghostd.sessions;
        // Earlier panes' requests leave ghostd marked unreachable here.
        Ghostd.reachable = true;
        for (const [name, sessions] of states) {
            Ghostd.sessions = sessions;
            snap(barC, { x: 20, y: 20 }, "bar-" + name);
        }
        Ghostd.reachable = false;
        snap(barC, { x: 20, y: 20 }, "bar-offline");
        Ghostd.reachable = true;
        Ghostd.sessions = was;
    }
}
