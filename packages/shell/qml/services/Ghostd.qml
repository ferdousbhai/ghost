pragma Singleton

// Ghostd — the shell's client for the local `ghostd` HTTP API (CONTRACTS.md).
//
// Streaming: Qt's QML XMLHttpRequest fires onreadystatechange repeatedly at
// readyState 3 (LOADING), once per network chunk, and exposes the *cumulative*
// partial body in responseText. That was measured on this stack (Quickshell
// 0.3.0 / Qt 6.11.2) against a chunked SSE server, both GET and POST — see
// dev/README.md. So SSE needs no helper process: we track a consumed offset,
// buffer the trailing partial frame, and parse `data:` frames ourselves.
//
// The wire format is pi-messages as fixed in CONTRACTS.md. Deltas are INCREMENTAL
// fragments, not cumulative snapshots; `text_end` carries the authoritative
// full block and we replace with it. There is no tool-*result* event in the
// vocabulary — tool activity is start/delta/end only.
//
// Auth: the daemon binds loopback, which is not the same as being private —
// every browser on this machine can reach 127.0.0.1 too, and a page the user
// visits could otherwise drive a ghost with a form post (issue #485). So every
// /api route but relay/status wants `Authorization: Bearer <token>`, where the
// token is a 0600 file the daemon mints at startup. We can read a file; a web
// page cannot. Nothing here opens a request directly — `dispatch()` does, so
// the header and the rotation retry exist in one place rather than fourteen.
import Quickshell
import Quickshell.Io
import QtQuick
import "TurnBlocks.js" as TurnBlocks

Singleton {
    id: root

    // ---- Connection -------------------------------------------------------
    readonly property string host: Quickshell.env("GHOSTD_HOST") || "127.0.0.1"
    readonly property string port: String(Quickshell.env("GHOSTD_PORT") || "7717")
    // IPv6 literals need brackets in a URL authority; ghostd binds loopback only.
    readonly property string baseUrl: "http://"
        + (root.host.indexOf(":") >= 0 ? "[" + root.host + "]" : root.host)
        + ":" + root.port

    // ---- Auth -------------------------------------------------------------
    // Same resolution the daemon does (packages/daemon/src/api-token.ts): an
    // explicit override, else $XDG_STATE_HOME/ghost/api-token, else the XDG
    // default. A relative XDG_STATE_HOME is not a state home, so it is ignored.
    readonly property string tokenPath: {
        const explicit = Quickshell.env("GHOSTD_API_TOKEN_FILE") || "";
        if (explicit !== "") return explicit;
        const state = Quickshell.env("XDG_STATE_HOME") || "";
        const base = state.charAt(0) === "/" ? state
            : (Quickshell.env("HOME") || "") + "/.local/state";
        return base + "/ghost/api-token";
    }
    /** The bearer token, "" until the file has been read (or if it cannot be). */
    property string apiToken: ""

    /** [{ name, dir, createdAt }], newest listing from GET /api/ghosts. */
    property var ghosts: []
    /** Name of the ghost the HUD is talking to. Empty until the first listing. */
    property string activeGhost: ""
    /** False once any request fails; the HUD shows a reconnect hint. */
    property bool reachable: false
    /** Human-readable last failure, or "". */
    property string lastError: ""
    /** Ghost currently being deleted, or "" when idle. */
    property string deletingGhost: ""
    /** Why the last ghost deletion was refused, or "". Presentable as-is. */
    property string ghostDeleteError: ""

    // ---- Conversations ----------------------------------------------------
    // A ghost owns many conversations (pi sessions). The daemon persists them;
    // the HUD lists them per ghost, resumes one by loading its transcript, and
    // starts a fresh one on demand. This fixes #26 — a restart no longer loses
    // history, because a conversation lives in the daemon keyed by session id.
    /** Session listing for the active ghost: [{ id, title, createdAt, updatedAt, messageCount, pinned }], pinned first then newest. */
    property var sessions: []
    /** The active ghost's current conversation id. "" until one is minted or opened. */
    property string currentSessionId: ""
    /** Non-empty when a sessions/transcript fetch failed. */
    property string sessionsError: ""
    /** Conversation currently being deleted, or "" when idle. */
    property string deletingSessionId: ""
    /** Why the last branch refused, or "". Kept apart from `sessionsError`:
        that one renders in the conversation list, and a branch is asked for
        from a message, half a window away from it. */
    property string branchError: ""

    // ---- Greeting ---------------------------------------------------------
    // The ghost's opening line for an empty chat. Pure upside: the HUD paints
    // its own static invitation the instant the card appears and only swaps to
    // this if and when it arrives, so a slow, absent, or failed greeting costs
    // the owner nothing. Every failure path therefore leaves it "".
    /** The daemon's opening line for the active ghost, or "". */
    property string greeting: ""
    /** True when that greeting is the "we have not met yet" onboarding one. */
    property bool greetingOnboarding: false
    /** The ghost the current greeting was fetched for; the once-per-ghost latch. */
    property string greetingGhost: ""

    // ---- Turn state -------------------------------------------------------
    /** ListModel of { role, text, tools, toolActivity, error, pending }. */
    property alias transcript: transcriptModel
    /** True from `start` until `done`/`error`. */
    property bool streaming: false
    /** Compact activity line: "thinking", "read_memory", "" when idle. */
    property string activity: ""
    /**
     * The ghost's own words for what it is doing right now, or "" when it is
     * working silently. A model narrating itself ("Checking your Dropbox for
     * the invoice") is status, not reply: it belongs beside the orb for as long
     * as it is true, and nowhere afterwards. See TurnBlocks.js for the split.
     */
    property string statusText: ""
    /** OMP's currently-blocking ask interaction, or null. */
    property var pendingAsk: null
    property bool askSubmitting: false
    property string askError: ""
    /** OMP's user-visible pending queues. Enter steers; Ctrl+Enter follows up. */
    property var steeringQueue: []
    property var followUpQueue: []
    property bool queueSubmitting: false
    property string queueError: ""

    signal turnFinished(string ghost, string text)
    signal turnFailed(string ghost, string message)
    signal queueMessageRejected(string text)
    signal branchDraftReady(string text)

    // ---- Model login ------------------------------------------------------
    /** [{ id, name, subscription, authTypes, loginLabel, billingNote, configured, connectedVia }]. */
    property var providers: []
    /** The active login's id, or "" when none is running. */
    property string loginId: ""
    /** The current login view from GET .../login/:id — the step to render. */
    property var loginState: ({})
    /** Which ghost the running login belongs to (a login is per ghost). */
    property string loginGhost: ""
    /** Non-empty while a login request is in flight or has failed to reach ghostd. */
    property string loginError: ""

    // ---- Model selection --------------------------------------------------
    /** The resolved current model: { provider, id, name?, contextWindow?, hasVision } | null. */
    property var currentModel: null
    /** How currentModel was chosen: "role" (explicit pick), "default" (fallback), "none". */
    property string modelSource: "none"
    /** scope=available rows the ghost can use now: [{ provider, id, name?, …, current }]. */
    property var availableModels: []
    /** scope=catalog rows for the last search: same shape plus `usable`. */
    property var catalogModels: []
    /** Full filtered count behind the current catalog page (may exceed catalogModels.length). */
    property int catalogTotal: 0
    /** The query and page offset the catalog list currently reflects. */
    property string catalogQuery: ""
    property int catalogOffset: 0
    readonly property int catalogLimit: 50
    /** True while a catalog search is in flight; drives the switcher's "searching…" line. */
    property bool catalogLoading: false
    /** Non-empty when a model fetch or switch failed. */
    property string modelError: ""
    /** Non-fatal setup instruction returned by a successful model switch. */
    property string modelWarning: ""
    /** [{ role, ompRole, label, primary, fallbacks }] from modern OMP routing. */
    property var modelRouting: []
    property bool modelRoutingLoading: false

    /** PUT /model wrote a role whose provider is not credentialed — prompt a login. */
    signal modelSwitchNeedsLogin(string provider)
    /** PUT /model completed with a usable selection — return the HUD to chat. */
    signal modelSwitchCompleted(string provider, string id)
    /** One advanced role/fallback mutation completed — return to the route overview. */
    signal modelRouteCompleted(string role, string target)

    // ---- Internals --------------------------------------------------------
    // The XHR must be held by a property. A request whose only reference is the
    // closure it installed on itself is eligible for collection mid-flight.
    property var request: null
    property var listRequest: null
    property var deleteGhostRequest: null
    property var loginRequest: null
    property var modelRequest: null
    property var availRequest: null
    property var catalogRequest: null
    property var setModelRequest: null
    property var modelRoutingRequest: null
    property var sessionsRequest: null
    property var greetingRequest: null
    property var transcriptRequest: null
    property var deleteSessionRequest: null
    property var pinSessionRequest: null
    property var askRequest: null
    property var askSubmitRequest: null
    property var queueRequest: null
    property var queueStatusRequest: null
    property var branchRequest: null

    property var sessionIds: ({})     // ghost name -> active pi session id
    property var blocks: ({})         // contentIndex -> { kind, text }
    property var toolNames: []        // tool names seen this turn, in order
    property var toolActivities: []   // stateful cards for the current assistant row
    property var toolIdsByContent: ({})
    property var toolArgumentText: ({})
    property int assistantRow: -1
    property string consumedPrefix: ""
    property int consumed: 0
    property string frameBuffer: ""

    ListModel { id: transcriptModel }

    // blockLoading, like Theme.qml's palette files: the shell has nothing
    // useful to do before it can authenticate, and a token that arrives one
    // event loop after the first request would just produce a 401 to retry.
    // printErrors stays off — a daemon that has never run has no token file,
    // and that is a "not started yet", not a fault.
    FileView {
        id: apiTokenFile
        path: root.tokenPath
        blockLoading: true
        printErrors: false
        onLoaded: root.apiToken = apiTokenFile.text().trim()
        onLoadFailed: root.apiToken = ""
    }

    // Deltas arrive faster than a text layout can keep up with (a local model
    // can emit hundreds a second). Buffer them and flush on a frame-ish timer;
    // the model only sees ~20 updates a second regardless of token rate.
    Timer {
        id: flushTimer
        interval: 50
        repeat: true
        onTriggered: root.flush()
    }

    // A login is interactive and multi-step; the daemon models it as a pollable
    // session. We poll once a second while one is running and stop the moment
    // it settles.
    Timer {
        id: loginPoll
        interval: 1000
        repeat: true
        onTriggered: root.pollLogin()
    }

    // OMP's ask tool pauses the provider turn while the HTTP SSE stream stays
    // open. The dialog itself is a separate, reconnectable resource, so poll
    // only during the short gap between seeing the ask tool call and receiving
    // its payload.
    Timer {
        id: askPoll
        interval: 200
        repeat: true
        running: root.streaming && root.activity === "ask"
            && root.pendingAsk === null && !root.askSubmitting
        onTriggered: root.fetchPendingAsk()
    }

    Timer {
        id: queuePoll
        interval: 350
        repeat: true
        running: root.streaming && root.pendingAsk === null
        onTriggered: root.fetchQueue()
    }

    Component.onCompleted: root.refresh()

    // ---- Authenticated requests -------------------------------------------

    /** The token, reading the file on first use. "" when there is none yet. */
    function token(): string {
        if (root.apiToken === "") {
            const text = apiTokenFile.text();
            root.apiToken = text ? text.trim() : "";
        }
        return root.apiToken;
    }

    /** Re-read the token file. Returns the token, which may be unchanged. */
    function reloadToken(): string {
        apiTokenFile.reload();
        const text = apiTokenFile.text();
        root.apiToken = text ? text.trim() : "";
        return root.apiToken;
    }

    /**
     * Open, authenticate, and send `xhr`. `headers` is a plain object of extra
     * request headers; `body` is a string, or null for a bodyless request.
     *
     * Callers install their onreadystatechange handler *before* calling this —
     * we wrap it, because a 401 is not necessarily fatal. `ghostd api-token
     * --rotate` can replace the secret while the shell is running, so the first
     * 401 re-reads the file and replays the request once; only then does the
     * caller's handler see it. The replay is deferred with callLater rather
     * than reopening the XHR from inside its own callback.
     */
    function dispatch(xhr: var, method: string, path: string, headers: var, body: var): void {
        const url = root.baseUrl + path;
        const inner = xhr.onreadystatechange;
        let retried = false;
        xhr.onreadystatechange = function () {
            if (xhr.readyState === 4 && xhr.status === 401 && !retried) {
                retried = true;
                const before = root.apiToken;
                if (root.reloadToken() !== "" && root.apiToken !== before) {
                    Qt.callLater(function () {
                        root.deliver(xhr, method, url, headers, body);
                    });
                    return;
                }
            }
            inner();
        };
        root.deliver(xhr, method, url, headers, body);
    }

    function deliver(xhr: var, method: string, url: string, headers: var, body: var): void {
        xhr.open(method, url);
        const bearer = root.token();
        if (bearer !== "") xhr.setRequestHeader("Authorization", "Bearer " + bearer);
        for (const name in headers) xhr.setRequestHeader(name, headers[name]);
        if (body === null || body === undefined) xhr.send();
        else xhr.send(body);
    }

    // ---- Ghost roster -----------------------------------------------------

    function refresh(): void {
        const xhr = new XMLHttpRequest();
        root.listRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                try {
                    const list = JSON.parse(xhr.responseText);
                    root.ghosts = Array.isArray(list) ? list : [];
                    root.reachable = true;
                    root.lastError = "";
                    if (root.activeGhost === "" && root.ghosts.length > 0)
                        root.activeGhost = root.ghosts[0].name;
                    if (root.activeGhost !== "") {
                        root.fetchCurrentModel();
                        root.fetchSessions(root.activeGhost);
                        root.fetchGreeting();
                    }
                } catch (error) {
                    root.fail("ghostd sent a malformed ghost list: " + error);
                }
            } else {
                root.fail(xhr.status === 0
                    ? "ghostd is not answering on " + root.baseUrl
                    : "GET /api/ghosts → " + xhr.status);
            }
        };
        root.dispatch(xhr, "GET", "/api/ghosts", ({}), null);
    }

    function createGhost(name: string): void {
        const trimmed = name.trim();
        if (trimmed === "") return;
        const xhr = new XMLHttpRequest();
        root.listRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200 || xhr.status === 201) {
                try {
                    root.activeGhost = JSON.parse(xhr.responseText).name;
                } catch (error) {
                    root.activeGhost = trimmed;
                }
                root.currentSessionId = "";
                root.sessions = [];
                root.clearTranscript();
                root.clearGreeting();
                root.refresh();
            } else {
                root.fail(root.describeError(xhr, "POST /api/ghosts"));
            }
        };
        root.dispatch(xhr, "POST", "/api/ghosts",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ name: trimmed }));
    }

    /**
     * Delete a ghost home. The daemon wants the name echoed back in `confirm`
     * byte-for-byte and answers 400 confirmation_required otherwise, so the UI
     * types it and we only carry it; the home is moved to the XDG trash
     * (~/.local/share/Trash/files/) rather than unlinked, which is what makes
     * this recoverable from the desktop.
     *
     * A refusal (409 ghost_busy, most often) leaves the selection untouched and
     * lands in `ghostDeleteError` for the row that asked. One at a time: the
     * confirmation is per row and a second in-flight delete would have no row.
     */
    function deleteGhost(name: string): void {
        if (name === "" || root.deletingGhost !== "") return;
        root.deletingGhost = name;
        root.ghostDeleteError = "";
        const xhr = new XMLHttpRequest();
        root.deleteGhostRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.deleteGhostRequest) return;
            root.deletingGhost = "";
            if (xhr.status === 200) {
                root.ghostDeleteError = "";
                root.forgetGhost(name);
                // activeGhost is "" now if this was the active one, so the
                // listing picks the next ghost the way the first one does.
                root.refresh();
            } else {
                const detail = root.errorDetail(xhr);
                root.ghostDeleteError = detail !== ""
                    ? detail
                    : root.describeError(xhr, "DELETE ghost");
            }
        };
        root.dispatch(xhr, "DELETE", "/api/ghosts/" + encodeURIComponent(name)
            + "?confirm=" + encodeURIComponent(name), ({}), null);
    }

    /** Drop every trace of a ghost that is no longer there. */
    function forgetGhost(name: string): void {
        delete root.sessionIds[name];
        if (name !== root.activeGhost) return;
        root.cancel();
        root.activeGhost = "";
        root.currentSessionId = "";
        root.sessions = [];
        root.sessionsError = "";
        root.clearTranscript();
        root.currentModel = null;
        root.modelSource = "none";
        root.availableModels = [];
        root.modelRouting = [];
        root.modelRoutingLoading = false;
        root.modelWarning = "";
        root.clearGreeting();
    }

    function selectGhost(name: string): void {
        if (name === root.activeGhost) return;
        root.cancel();
        root.activeGhost = name;
        root.clearTranscript();
        // Conversations are per ghost; restore this ghost's last-active session
        // id (if any) and list its conversations. The transcript view stays
        // empty until the user opens one — a switch shows the list, not a body.
        root.currentSessionId = root.sessionIds[name] || "";
        root.sessions = [];
        root.sessionsError = "";
        // Model selection is per ghost; drop the old one and fetch the new.
        root.currentModel = null;
        root.modelSource = "none";
        root.availableModels = [];
        root.modelRouting = [];
        root.modelRoutingLoading = false;
        root.modelWarning = "";
        // The greeting is this ghost's own voice, so it never carries over.
        root.clearGreeting();
        root.fetchCurrentModel();
        root.fetchSessions(name);
        root.fetchGreeting();
    }

    function clearTranscript(): void {
        transcriptModel.clear();
        root.activity = "";
        root.statusText = "";
        root.pendingAsk = null;
        root.askSubmitting = false;
        root.askError = "";
        root.steeringQueue = [];
        root.followUpQueue = [];
        root.queueSubmitting = false;
        root.queueError = "";
        root.branchError = "";
    }

    // ---- Greeting ---------------------------------------------------------

    /** Forget the current greeting so the next fetch asks for a fresh one. */
    function clearGreeting(): void {
        root.greeting = "";
        root.greetingOnboarding = false;
        root.greetingGhost = "";
    }

    /**
     * Ask the active ghost for its opening line.
     *
     * Fired from the roster/selection refresh the HUD's open path already runs,
     * so the HUD needs no plumbing beyond reading `greeting`. The
     * `greetingGhost` latch keeps that from becoming a per-poll request: one
     * fetch per ghost selection, cleared by clearGreeting() when the empty chat
     * genuinely comes back (new/deleted conversation, ghost switch).
     *
     * A greeting the daemon could not produce is a 200 with `greeting: null`,
     * and everything else — non-200, malformed body, unreachable — is treated
     * the same way: leave the properties empty and let the static line stand.
     */
    function fetchGreeting(): void {
        const ghost = root.activeGhost;
        if (ghost === "" || ghost === root.greetingGhost) return;
        if (root.greetingRequest && root.greetingRequest.readyState !== 4) return;
        root.greetingGhost = ghost;
        const xhr = new XMLHttpRequest();
        root.greetingRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.greetingRequest) return;
            // A greeting for a ghost the owner has since left is not theirs.
            if (ghost !== root.activeGhost || xhr.status !== 200) return;
            try {
                const body = JSON.parse(xhr.responseText);
                root.greeting = typeof body.greeting === "string" ? body.greeting.trim() : "";
                root.greetingOnboarding = root.greeting !== "" && body.onboarding === true;
            } catch (error) {
                root.greeting = "";
                root.greetingOnboarding = false;
            }
        };
        root.dispatch(xhr, "POST",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/greeting",
            ({ "Content-Type": "application/json" }), JSON.stringify({}));
    }

    // ---- Conversations ----------------------------------------------------

    /** GET the active ghost's conversation listing. Newest-updated first. */
    function fetchSessions(ghost: string): void {
        const g = ghost || root.activeGhost;
        if (g === "") {
            root.sessions = [];
            return;
        }
        const xhr = new XMLHttpRequest();
        root.sessionsRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            // A reply for a ghost the user has since switched away from is stale.
            if (g !== root.activeGhost) return;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    // Contract is { sessions: [...] }; tolerate a bare array too.
                    const list = Array.isArray(body) ? body
                        : (Array.isArray(body.sessions) ? body.sessions : []);
                    root.sessions = list;
                    root.sessionsError = "";
                } catch (error) {
                    root.sessions = [];
                    root.sessionsError = "ghostd sent a malformed session list";
                }
            } else {
                root.sessions = [];
                root.sessionsError = root.describeError(xhr, "GET sessions");
            }
        };
        root.dispatch(xhr, "GET",
            "/api/ghosts/" + encodeURIComponent(g) + "/sessions", ({}), null);
    }

    /**
     * Start a fresh conversation for the active ghost: mint a session id, clear
     * the transcript view, and re-list. The daemon creates the session lazily on
     * the first turn and titles it in the background afterwards, so no listing
     * row exists yet — the composer is simply ready for a new thread.
     */
    function newConversation(): void {
        const ghost = root.activeGhost;
        if (ghost === "") return;
        root.cancel();
        const id = "hud-" + Date.now().toString(36)
            + "-" + Math.floor(Math.random() * 0xffffff).toString(36);
        root.sessionIds[ghost] = id;
        root.currentSessionId = id;
        root.clearTranscript();
        // A blank chat is back on screen, so it earns a fresh opening line.
        root.clearGreeting();
        root.fetchGreeting();
        root.fetchSessions(ghost);
    }

    /** Permanently delete one stored conversation after the UI confirms it. */
    function deleteConversation(id: string): void {
        const ghost = root.activeGhost;
        if (ghost === "" || id === "" || root.deletingSessionId !== "") return;
        if (id === root.currentSessionId && root.streaming) {
            root.sessionsError = "Cancel the current answer before deleting this conversation";
            return;
        }
        root.deletingSessionId = id;
        root.sessionsError = "";
        const xhr = new XMLHttpRequest();
        root.deleteSessionRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.deleteSessionRequest) return;
            root.deletingSessionId = "";
            if (xhr.status === 200) {
                if (ghost === root.activeGhost) {
                    root.sessions = root.sessions.filter(function (session) {
                        return session.id !== id;
                    });
                    if (root.currentSessionId === id) {
                        root.sessionIds[ghost] = "";
                        root.currentSessionId = "";
                        root.clearTranscript();
                        root.clearGreeting();
                        root.fetchGreeting();
                    }
                    root.sessionsError = "";
                    root.fetchSessions(ghost);
                }
            } else if (ghost === root.activeGhost) {
                root.sessionsError = root.describeError(xhr, "DELETE conversation");
            }
        };
        root.dispatch(xhr, "DELETE", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(id), ({}), null);
    }

    /**
     * Pin or unpin one conversation. The daemon owns the listing order (pinned
     * first, newest-updated first inside each group); we reproduce it here so the
     * row jumps sections on click instead of after a round trip, and re-list from
     * the server if the write turns out to have failed.
     */
    function pinConversation(id: string, pinned: bool): void {
        const ghost = root.activeGhost;
        if (ghost === "" || id === "") return;
        root.sessionsError = "";
        // A fresh row object per change: mutating the existing one in place would
        // not re-evaluate the bindings reading it.
        root.sessions = root.orderSessions(root.sessions.map(function (session) {
            return session.id === id
                ? Object.assign({}, session, { pinned: pinned })
                : session;
        }));
        const xhr = new XMLHttpRequest();
        root.pinSessionRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.pinSessionRequest) return;
            if (ghost !== root.activeGhost) return;
            if (xhr.status !== 200) {
                root.sessionsError = root.describeError(xhr, "PUT pin conversation");
                // The optimistic reorder is now a lie; take the server's truth.
                root.fetchSessions(ghost);
            }
        };
        root.dispatch(xhr, "PUT", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(id) + "/pin",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ pinned: pinned }));
    }

    /** The listing order GET sessions returns, applied to a local edit. */
    function orderSessions(list: var): var {
        return list.slice().sort(function (a, b) {
            const pinnedA = a.pinned === true ? 1 : 0;
            const pinnedB = b.pinned === true ? 1 : 0;
            if (pinnedA !== pinnedB) return pinnedB - pinnedA;
            const whenA = Date.parse(a.updatedAt || a.createdAt || "") || 0;
            const whenB = Date.parse(b.updatedAt || b.createdAt || "") || 0;
            return whenB - whenA;
        });
    }

    /**
     * Make one conversation the ghost's active one, clearing everything the
     * last one owned. Shared with branching, which lands the user in the copy
     * it just made: without this the source's queues, its pending ask and its
     * errors would follow them into a conversation that never had them.
     */
    function adoptConversation(ghost: string, id: string): void {
        root.sessionIds[ghost] = id;
        root.currentSessionId = id;
        root.clearTranscript();
        // A conversation with its own history needs no opening line; a greeting
        // would be answering a question nobody just asked.
        root.clearGreeting();
    }

    /**
     * Resume a conversation: make it active for the ghost and load its transcript
     * so history is visible. A 404 or an empty/unstarted session leaves the view
     * cleared rather than erroring — the conversation is simply blank.
     */
    function openConversation(id: string): void {
        const ghost = root.activeGhost;
        if (ghost === "" || id === "") return;
        root.cancel();
        root.adoptConversation(ghost, id);
        const xhr = new XMLHttpRequest();
        root.transcriptRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            // Ignore a transcript that arrives after the user moved on.
            if (ghost !== root.activeGhost || id !== root.currentSessionId) return;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    root.rehydrate(Array.isArray(body.messages) ? body.messages : []);
                    root.sessionsError = "";
                } catch (error) {
                    root.sessionsError = "ghostd sent a malformed transcript";
                }
            } else if (xhr.status === 404) {
                // An unstarted conversation has no transcript yet; that is fine.
                root.sessionsError = "";
            } else {
                root.sessionsError = root.describeError(xhr, "GET transcript");
            }
        };
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(id) + "/transcript", ({}), null);
    }

    /** Refresh the persisted entry ids a live turn could not know yet. */
    function refreshCurrentTranscript(): void {
        const ghost = root.activeGhost;
        const id = root.currentSessionId;
        if (ghost === "" || id === "" || root.streaming) return;
        const xhr = new XMLHttpRequest();
        root.transcriptRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.transcriptRequest) return;
            if (ghost !== root.activeGhost || id !== root.currentSessionId || root.streaming) return;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    root.rehydrate(Array.isArray(body.messages) ? body.messages : []);
                } catch (error) {
                    root.sessionsError = "ghostd sent a malformed transcript";
                }
            }
        };
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(id) + "/transcript", ({}), null);
    }

    /**
     * Replace the transcript view with a conversation's stored messages.
     *
     * Storage gives a turn one message per content block — the Claude Code
     * runtime puts every tool call in a message of its own — while the live
     * stream renders a whole turn as one row. Consecutive assistant messages
     * are therefore regrouped before the split, or a restored answer scatters
     * across five rows and a preamble is severed from the tool call that made
     * it one.
     *
     * A text-less row survives when it still carries tool activity. That is the
     * only thing standing between an unanswered `ask` and a dead conversation:
     * its message is a lone `toolCall` part, so dropping the row takes the
     * card's re-answer branch with it and the question can never be answered.
     */
    function rehydrate(messages: var): void {
        transcriptModel.clear();
        root.activity = "";
        root.statusText = "";
        for (const row of TurnBlocks.rows(messages)) {
            transcriptModel.append({
                role: row.role,
                text: row.text,
                tools: "",
                toolActivity: row.role === "assistant"
                    ? root.messageTools({ content: row.parts }) : [],
                error: "",
                pending: false,
                entryId: row.entryId
            });
        }
    }

    /** Recover completed tool cards from an assistant message on transcript load. */
    function messageTools(message: var): var {
        if (!Array.isArray(message.content)) return [];
        return message.content
            .filter(part => part && part.type === "toolCall")
            .map(part => ({
                id: part.id || ("history-" + Math.random()),
                name: part.name || "tool",
                status: "complete",
                arguments: part.arguments || ({}),
                summary: "",
                intent: "",
                askBranch: part.ghostAsk || null,
                // How the question actually settled, so a restored card can stop
                // reporting an answer for one that was cancelled or timed out.
                // "" for a runtime that does not say, which the card reads as
                // unknown rather than guessing.
                askSettled: part.ghostAsk && typeof part.ghostAsk.settled === "string"
                    ? part.ghostAsk.settled : ""
            }));
    }

    /**
     * Branch off a user message into a conversation of its own.
     *
     * The daemon copies the thread up to (not including) that message into a
     * brand-new conversation and hands back its id, title, transcript, and the
     * branched text as a draft. The source thread is left exactly as it was —
     * a second answer to the same question is a second thread, not an
     * overwrite of the first, so nothing the ghost already said is spent to
     * ask again.
     *
     * So the shell moves the user *into* the copy the way opening a
     * conversation from the sidebar would: same active-session bookkeeping,
     * same rehydrate, plus a re-list because the new row does not exist in the
     * listing the sidebar is showing.
     */
    function branchFrom(entryId: string): void {
        const ghost = root.activeGhost;
        const sessionId = root.currentSessionId;
        if (ghost === "" || sessionId === "" || entryId === "") return;
        // A running turn owns the tree. Say so rather than swallowing the click.
        if (root.streaming) {
            root.branchError = "Wait for this answer to finish before branching.";
            return;
        }
        root.branchError = "";
        const xhr = new XMLHttpRequest();
        root.branchRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.branchRequest) return;
            // A branch of a conversation the user has since left is not theirs.
            if (ghost !== root.activeGhost || sessionId !== root.currentSessionId) return;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    const branched = typeof body.sessionId === "string" ? body.sessionId : "";
                    if (branched === "") {
                        root.branchError = "ghostd branched into no conversation";
                        return;
                    }
                    root.adoptConversation(ghost, branched);
                    root.rehydrate(body.transcript && Array.isArray(body.transcript.messages)
                        ? body.transcript.messages : []);
                    root.branchError = "";
                    root.sessionsError = "";
                    root.fetchSessions(ghost);
                    root.branchDraftReady(typeof body.draft === "string" ? body.draft : "");
                } catch (error) {
                    root.branchError = "ghostd sent malformed branch state";
                }
            } else {
                root.branchError = root.describeError(xhr, "branch conversation");
            }
        };
        root.dispatch(xhr, "POST", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(sessionId) + "/branch",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ action: "fork", entryId: entryId }));
    }

    /** Run modern OMP's two-phase Ask tree re-answer as a streamed continuation. */
    function reanswerHistoricalAsk(entryId: string): void {
        const ghost = root.activeGhost;
        const sessionId = root.currentSessionId;
        if (root.streaming || ghost === "" || sessionId === "" || entryId === "") return;

        root.blocks = ({});
        root.toolNames = [];
        root.toolActivities = [];
        root.toolIdsByContent = ({});
        root.toolArgumentText = ({});
        root.assistantRow = -1;
        root.consumed = 0;
        root.frameBuffer = "";
        root.activity = "waiting for ghostd";
        root.statusText = "";
        root.pendingAsk = null;
        root.askSubmitting = false;
        root.askError = "";
        root.streaming = true;
        flushTimer.start();

        const xhr = new XMLHttpRequest();
        root.request = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState >= 3 && xhr.status === 200) {
                root.reachable = true;
                root.lastError = "";
                const whole = xhr.responseText;
                root.ingest(whole.substring(root.consumed));
                root.consumed = whole.length;
            }
            if (xhr.readyState !== 4) return;
            flushTimer.stop();
            root.flush();
            if (xhr.status !== 200) {
                root.endTurn(ghost, root.describeError(xhr, "re-answer ask"));
            } else if (root.streaming) {
                root.endTurn(ghost, "the re-answer stream ended mid-turn");
            }
        };
        root.dispatch(xhr, "POST", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(sessionId) + "/reanswer",
            ({ "Content-Type": "application/json", "Accept": "text/event-stream" }),
            JSON.stringify({ entryId: entryId }));
    }

    // ---- A turn -----------------------------------------------------------

    function send(text: string): void {
        const prompt = text.trim();
        if (prompt === "" || root.streaming || root.activeGhost === "") return;

        transcriptModel.append({
            role: "user", text: prompt, tools: "", toolActivity: [], error: "", pending: false,
            entryId: ""
        });
        transcriptModel.append({
            role: "assistant", text: "", tools: "", toolActivity: [], error: "", pending: true,
            entryId: ""
        });
        root.assistantRow = transcriptModel.count - 1;
        // The conversation has messages now; the opening line has been answered.
        root.clearGreeting();

        root.blocks = ({});
        root.toolNames = [];
        root.toolActivities = [];
        root.toolIdsByContent = ({});
        root.toolArgumentText = ({});
        root.consumed = 0;
        root.frameBuffer = "";
        root.activity = "waiting for ghostd";
        root.statusText = "";
        root.pendingAsk = null;
        root.askSubmitting = false;
        root.askError = "";
        root.steeringQueue = [];
        root.followUpQueue = [];
        root.queueSubmitting = false;
        root.queueError = "";
        root.streaming = true;
        flushTimer.start();

        const ghost = root.activeGhost;
        const xhr = new XMLHttpRequest();
        root.request = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState >= 3 && xhr.status === 200) {
                // A live stream is proof the daemon is answering; clear any stale
                // connectivity error a past blip (e.g. a daemon restart) left set,
                // which nothing else clears while `reachable` stayed true.
                root.reachable = true;
                root.lastError = "";
                const whole = xhr.responseText;
                root.ingest(whole.substring(root.consumed));
                root.consumed = whole.length;
            }
            if (xhr.readyState !== 4) return;
            flushTimer.stop();
            root.flush();
            if (xhr.status !== 200) {
                root.endTurn(ghost, root.describeError(xhr, "POST /api/ghosts/" + ghost + "/messages"));
            } else if (root.streaming) {
                // Stream ended without a terminal `done`/`error` event.
                root.endTurn(ghost, "the stream ended mid-turn");
            }
        };
        root.dispatch(xhr, "POST",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/messages",
            ({ "Content-Type": "application/json", "Accept": "text/event-stream" }),
            JSON.stringify(root.buildBody(ghost, prompt)));
    }

    function cancel(): void {
        if (root.request) root.request.abort();
        flushTimer.stop();
        root.streaming = false;
        root.flush();
        root.statusText = "";
        root.activity = "";
        root.pendingAsk = null;
        root.askSubmitting = false;
        root.askError = "";
        root.steeringQueue = [];
        root.followUpQueue = [];
        root.queueSubmitting = false;
        root.queueError = "";
        if (root.assistantRow >= 0 && root.assistantRow < transcriptModel.count) {
            transcriptModel.setProperty(root.assistantRow, "pending", false);
            if (transcriptModel.get(root.assistantRow).text === "")
                transcriptModel.setProperty(root.assistantRow, "error", "cancelled");
        }
        root.assistantRow = -1;
    }

    /**
     * The pi-messages request body.
     *
     * We send only the new user message and let ghostd's per-ghost AgentSession
     * own the history — CONTRACTS.md puts the daemon's sessions in pi session
     * storage, and `options.sessionId` selects which one. If a daemon build
     * turns out to be stateless per request, set GHOST_HUD_REPLAY=1 and we
     * replay the local transcript instead.
     */
    function buildBody(ghost: string, prompt: string): var {
        const sessionId = root.ensureSession(ghost);
        const messages = [];
        if (Quickshell.env("GHOST_HUD_REPLAY")) {
            for (let i = 0; i < transcriptModel.count - 1; i++) {
                const row = transcriptModel.get(i);
                if (row.text === "") continue;
                messages.push({ role: row.role, content: row.text, timestamp: Date.now() });
            }
        } else {
            messages.push({ role: "user", content: prompt, timestamp: Date.now() });
        }
        return {
            model: "ghost/" + ghost,
            context: { messages: messages },
            options: { sessionId: sessionId }
        };
    }

    /**
     * The active session id for a ghost, minting one on first use. A conversation
     * is created lazily by the daemon on the first turn; until then it lives only
     * as this id, which `options.sessionId` carries into the POST.
     */
    function ensureSession(ghost: string): string {
        if (!root.sessionIds[ghost]) {
            root.sessionIds[ghost] = "hud-" + Date.now().toString(36)
                + "-" + Math.floor(Math.random() * 0xffffff).toString(36);
        }
        if (ghost === root.activeGhost) root.currentSessionId = root.sessionIds[ghost];
        return root.sessionIds[ghost];
    }

    // ---- SSE --------------------------------------------------------------

    /**
     * Feed a raw chunk of the response body. Chunk boundaries are network
     * boundaries, never frame boundaries, so the trailing partial frame is
     * carried over to the next call.
     */
    function ingest(chunk: string): void {
        if (chunk === "") return;
        root.frameBuffer += chunk.replace(/\r\n/gu, "\n");
        const frames = root.frameBuffer.split("\n\n");
        root.frameBuffer = frames.pop();
        for (const frame of frames) {
            // Keepalives are bare `: comment` frames with no data line.
            const line = frame.split("\n").find(l => l.startsWith("data:"));
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") continue;
            try {
                root.handleEvent(JSON.parse(payload));
            } catch (error) {
                console.warn("ghost: unparseable SSE frame:", payload);
            }
        }
    }

    function handleEvent(event: var): void {
        switch (event.type) {
        case "start":
            root.activity = "";
            break;
        case "text_start":
            root.blocks[event.contentIndex] = { kind: "text", text: "" };
            root.activity = "";
            break;
        case "text_delta":
            if (!root.blocks[event.contentIndex])
                root.blocks[event.contentIndex] = { kind: "text", text: "" };
            root.blocks[event.contentIndex].text += event.delta;
            break;
        case "text_end":
            root.blocks[event.contentIndex] = { kind: "text", text: event.content };
            break;
        case "thinking_start":
            root.activity = "thinking";
            break;
        case "thinking_delta":
        case "thinking_end":
            // Reasoning stays out of the transcript in v1; the activity line
            // is the only signal that it happened.
            break;
        case "toolcall_start":
            root.activity = event.toolName;
            root.toolNames = root.toolNames.concat([event.toolName]);
            root.toolIdsByContent[event.contentIndex] = event.id;
            root.toolArgumentText[event.id] = "";
            root.updateTool(event.id, {
                name: event.toolName,
                status: "preparing",
                arguments: ({}),
                summary: "",
                intent: ""
            });
            if (event.toolName === "ask") Qt.callLater(root.fetchPendingAsk);
            break;
        case "toolcall_delta":
            const deltaId = root.toolIdsByContent[event.contentIndex];
            if (deltaId) root.toolArgumentText[deltaId]
                = (root.toolArgumentText[deltaId] || "") + event.delta;
            break;
        case "toolcall_end":
            root.activity = "";
            root.updateTool(event.toolCall.id, {
                name: event.toolCall.name,
                status: "queued",
                arguments: event.toolCall.arguments || ({}),
                summary: "",
                intent: ""
            });
            root.pendingAsk = null;
            root.askSubmitting = false;
            root.askError = "";
            break;
        case "tool_execution_start":
            root.activity = event.toolName;
            root.updateTool(event.id, {
                name: event.toolName,
                status: "running",
                arguments: event.arguments || ({}),
                intent: event.intent || ""
            });
            if (event.toolName === "ask") Qt.callLater(root.fetchPendingAsk);
            break;
        case "tool_execution_update":
            root.updateTool(event.id, {
                name: event.toolName,
                status: "running",
                summary: event.summary || ""
            });
            break;
        case "tool_execution_end":
            root.activity = "";
            root.updateTool(event.id, {
                name: event.toolName,
                status: event.isError ? "failed" : "complete",
                summary: event.summary || ""
            });
            break;
        case "model_fallback":
            root.activity = event.phase === "applied"
                ? "switching model · " + event.to
                : "using fallback · " + event.model;
            break;
        case "branch_changed":
            root.rehydrate(event.transcript && Array.isArray(event.transcript.messages)
                ? event.transcript.messages : []);
            transcriptModel.append({
                role: "assistant", text: "", tools: "", toolActivity: [], error: "", pending: true,
                entryId: ""
            });
            root.assistantRow = transcriptModel.count - 1;
            root.blocks = ({});
            root.toolNames = [];
            root.toolActivities = [];
            root.toolIdsByContent = ({});
            root.toolArgumentText = ({});
            root.activity = "";
            root.statusText = "";
            break;
        case "done":
            root.finishTurn("");
            break;
        case "error":
            root.finishTurn(event.errorMessage || ("the ghost stopped: " + event.reason));
            break;
        default:
            console.warn("ghost: unknown pi-messages event:", event.type);
        }
    }

    function updateTool(id: string, patch: var): void {
        const next = [];
        let found = false;
        for (const item of root.toolActivities) {
            if (item.id === id) {
                next.push(Object.assign({}, item, patch));
                found = true;
            } else {
                next.push(item);
            }
        }
        if (!found) next.push(Object.assign({
            id: id,
            name: patch.name || "tool",
            status: "preparing",
            arguments: ({}),
            summary: "",
            intent: "",
            // A live ask has not settled yet; the card reads "" as unknown and
            // says nothing about an outcome rather than inventing one.
            askSettled: ""
        }, patch));
        root.toolActivities = next;
        root.syncToolActivity();
    }

    function syncToolActivity(): void {
        if (root.assistantRow < 0 || root.assistantRow >= transcriptModel.count) return;
        transcriptModel.setProperty(root.assistantRow, "toolActivity", root.toolActivities);
    }

    function settleToolActivity(): void {
        const next = [];
        for (const item of root.toolActivities) {
            next.push(item.status === "failed" || item.status === "complete"
                ? item : Object.assign({}, item, { status: "complete" }));
        }
        root.toolActivities = next;
        root.syncToolActivity();
    }

    /** Push buffered block text into the model. Cheap when nothing changed. */
    function flush(): void {
        if (root.assistantRow < 0 || root.assistantRow >= transcriptModel.count) return;
        const turn = TurnBlocks.split(
            root.blocks, Object.keys(root.toolIdsByContent), root.streaming);
        const row = transcriptModel.get(root.assistantRow);
        if (row.text !== turn.body) transcriptModel.setProperty(root.assistantRow, "text", turn.body);
        if (root.statusText !== turn.status) root.statusText = turn.status;
        const tools = root.toolNames.join(", ");
        if (row.tools !== tools) transcriptModel.setProperty(root.assistantRow, "tools", tools);
    }

    function finishTurn(errorMessage: string): void {
        root.flush();
        root.endTurn(root.activeGhost, errorMessage);
    }

    function endTurn(ghost: string, errorMessage: string): void {
        if (!root.streaming) return;
        root.settleToolActivity();
        root.streaming = false;
        // Re-split now the turn is closed: a trailing block held beside the orb
        // while it might still have been a preamble is the reply after all.
        root.flush();
        root.statusText = "";
        root.activity = "";
        root.pendingAsk = null;
        root.askSubmitting = false;
        root.askError = "";
        root.steeringQueue = [];
        root.followUpQueue = [];
        root.queueSubmitting = false;
        root.queueError = "";
        flushTimer.stop();
        let text = "";
        if (root.assistantRow >= 0 && root.assistantRow < transcriptModel.count) {
            transcriptModel.setProperty(root.assistantRow, "pending", false);
            if (errorMessage !== "") transcriptModel.setProperty(root.assistantRow, "error", errorMessage);
            text = transcriptModel.get(root.assistantRow).text;
        }
        root.assistantRow = -1;
        // The turn may have created this conversation or triggered background
        // titling; re-list so the sidebar reflects it. Only for the active ghost.
        if (ghost === root.activeGhost) root.fetchSessions(ghost);
        if (errorMessage !== "") {
            root.lastError = errorMessage;
            root.turnFailed(ghost, errorMessage);
        } else {
            // A turn that completed is proof the daemon answered; drop any stale
            // error banner so it does not linger under a good reply.
            root.lastError = "";
            root.turnFinished(ghost, text);
        }
        if (ghost === root.activeGhost && root.currentSessionId !== "")
            Qt.callLater(root.refreshCurrentTranscript);
    }

    // ---- OMP ask ---------------------------------------------------------

    /** Fetch the ask payload surfaced by the live conversation, if ready. */
    function fetchPendingAsk(): void {
        const ghost = root.activeGhost;
        const sessionId = root.currentSessionId;
        if (!root.streaming || root.activity !== "ask" || ghost === "" || sessionId === "") return;
        if (root.askRequest && root.askRequest.readyState !== 4) return;
        const xhr = new XMLHttpRequest();
        root.askRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (ghost !== root.activeGhost || sessionId !== root.currentSessionId || !root.streaming) return;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    root.pendingAsk = body.ask || null;
                    root.askError = "";
                } catch (error) {
                    root.askError = "ghostd sent a malformed ask interaction";
                }
            } else {
                root.askError = root.describeError(xhr, "GET ask");
            }
        };
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(sessionId) + "/ask", ({}), null);
    }

    /** Submit an OMP ask result. `answer` is { kind, results? }. */
    function answerAsk(answer: var): void {
        const ask = root.pendingAsk;
        const ghost = root.activeGhost;
        const sessionId = root.currentSessionId;
        if (!ask || root.askSubmitting || ghost === "" || sessionId === "") return;
        root.askSubmitting = true;
        root.askError = "";
        const xhr = new XMLHttpRequest();
        root.askSubmitRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (ghost !== root.activeGhost || sessionId !== root.currentSessionId) return;
            root.askSubmitting = false;
            if (xhr.status === 200) {
                root.pendingAsk = null;
                root.askError = "";
            } else {
                root.askError = root.describeError(xhr, "POST ask");
                // A stale interaction may already have advanced. Refresh once
                // so the card never remains stuck on an answer nobody can take.
                if (xhr.status === 409) root.fetchPendingAsk();
            }
        };
        const body = Object.assign({ askId: ask.id }, answer);
        root.dispatch(xhr, "POST", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(sessionId) + "/ask",
            ({ "Content-Type": "application/json" }), JSON.stringify(body));
    }

    function chatAboutAsk(): void {
        root.answerAsk({ kind: "chat" });
    }

    /**
     * Decline the question. The daemon has always accepted this; nothing in the
     * HUD ever sent it, so a question the user did not want to answer had no
     * exit but closing the app — which is precisely how a conversation ends up
     * holding a question nobody can ever answer.
     */
    function dismissAsk(): void {
        root.answerAsk({ kind: "cancel" });
    }

    // ---- OMP steering + follow-up queues --------------------------------

    function applyQueue(body: var): void {
        root.steeringQueue = Array.isArray(body.steering) ? body.steering : [];
        root.followUpQueue = Array.isArray(body.followUp) ? body.followUp : [];
    }

    function fetchQueue(): void {
        const ghost = root.activeGhost;
        const sessionId = root.currentSessionId;
        if (!root.streaming || ghost === "" || sessionId === "") return;
        if (root.queueStatusRequest && root.queueStatusRequest.readyState !== 4) return;
        const xhr = new XMLHttpRequest();
        root.queueStatusRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (ghost !== root.activeGhost || sessionId !== root.currentSessionId || !root.streaming) return;
            if (xhr.status === 200) {
                try {
                    root.applyQueue(JSON.parse(xhr.responseText));
                } catch (error) {
                    root.queueError = "ghostd sent malformed queue state";
                }
            }
        };
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(sessionId) + "/queue", ({}), null);
    }

    function queueMessage(text: string, mode: string): void {
        const prompt = text.trim();
        const ghost = root.activeGhost;
        const sessionId = root.currentSessionId;
        if (prompt === "" || root.queueSubmitting || !root.streaming
                || ghost === "" || sessionId === "") return;
        root.queueSubmitting = true;
        root.queueError = "";
        // Show the chip immediately; the authoritative GET will remove it once
        // OMP consumes it into the next provider boundary.
        if (mode === "followUp") root.followUpQueue = root.followUpQueue.concat([prompt]);
        else root.steeringQueue = root.steeringQueue.concat([prompt]);

        const xhr = new XMLHttpRequest();
        root.queueRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (ghost !== root.activeGhost || sessionId !== root.currentSessionId) return;
            root.queueSubmitting = false;
            if (xhr.status === 200) {
                try {
                    root.applyQueue(JSON.parse(xhr.responseText));
                    root.queueError = "";
                } catch (error) {
                    root.queueError = "ghostd sent malformed queue state";
                }
            } else {
                root.queueError = root.describeError(xhr, "POST queue");
                root.fetchQueue();
                root.queueMessageRejected(prompt);
            }
        };
        root.dispatch(xhr, "POST", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(sessionId) + "/queue",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ mode: mode, text: prompt }));
    }

    // ---- Model login ------------------------------------------------------

    /** GET the providers this ghost can log into. Call when the panel opens. */
    function fetchProviders(): void {
        const ghost = root.activeGhost;
        if (ghost === "") return;
        const xhr = new XMLHttpRequest();
        root.loginRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    root.providers = Array.isArray(body.providers) ? body.providers : [];
                    root.loginError = "";
                } catch (error) {
                    root.loginError = "ghostd sent a malformed provider list";
                }
            } else {
                root.loginError = root.describeError(xhr, "GET providers");
            }
        };
        root.dispatch(xhr, "GET",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/providers", ({}), null);
    }

    /** Begin a login for the active ghost. authType is "oauth" or "api_key". */
    function startLogin(providerId: string, authType: string): void {
        const ghost = root.activeGhost;
        if (ghost === "") return;
        root.resetLogin();
        root.loginGhost = ghost;
        const xhr = new XMLHttpRequest();
        root.loginRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200 || xhr.status === 201) {
                try {
                    const view = JSON.parse(xhr.responseText);
                    root.loginId = view.loginId;
                    root.loginState = view;
                    root.loginError = "";
                    if (!root.isLoginTerminal()) loginPoll.start();
                } catch (error) {
                    root.loginError = "ghostd sent a malformed login response";
                }
            } else {
                root.loginError = root.describeError(xhr, "POST login");
            }
        };
        root.dispatch(xhr, "POST",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/login",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ providerId: providerId, authType: authType }));
    }

    /** Poll the running login's current step. */
    function pollLogin(): void {
        if (root.loginId === "" || root.loginGhost === "") return;
        const xhr = new XMLHttpRequest();
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                try {
                    root.loginState = JSON.parse(xhr.responseText);
                    root.loginError = "";
                    if (root.isLoginTerminal()) {
                        loginPoll.stop();
                        // A finished login may have set the ghost's chat model
                        // and always changes which models are usable; refresh both
                        // the roster and the model indicator/available list.
                        if (root.loginState.status === "succeeded") {
                            root.refresh();
                            root.fetchCurrentModel();
                            root.fetchAvailableModels();
                        }
                    }
                } catch (error) {
                    root.loginError = "ghostd sent a malformed login step";
                }
            } else {
                loginPoll.stop();
                root.loginError = root.describeError(xhr, "GET login");
            }
        };
        root.dispatch(xhr, "GET", "/api/ghosts/"
            + encodeURIComponent(root.loginGhost) + "/login/" + encodeURIComponent(root.loginId),
            ({}), null);
    }

    /** Satisfy an awaiting prompt with a pasted code, API key, or selected id. */
    function submitLoginInput(value: string): void {
        if (root.loginId === "" || root.loginGhost === "") return;
        const xhr = new XMLHttpRequest();
        root.loginRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                try {
                    root.loginState = JSON.parse(xhr.responseText);
                    root.loginError = "";
                    if (root.isLoginTerminal()) {
                        loginPoll.stop();
                        // A paste/api-key flow can settle here without a poll;
                        // reflect the new credentials in the model surfaces.
                        if (root.loginState.status === "succeeded") {
                            root.refresh();
                            root.fetchCurrentModel();
                            root.fetchAvailableModels();
                        }
                    } else {
                        loginPoll.start();
                    }
                } catch (error) {
                    root.loginError = "ghostd sent a malformed login step";
                }
            } else {
                root.loginError = root.describeError(xhr, "POST login input");
            }
        };
        root.dispatch(xhr, "POST", "/api/ghosts/"
            + encodeURIComponent(root.loginGhost) + "/login/"
            + encodeURIComponent(root.loginId) + "/input",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ value: value }));
    }

    /** Open the current auth URL in the owner's browser. */
    function openLoginUrl(url: string): void {
        if (!ExternalLinks.openLoginUrl(url)) root.loginError = "ghostd sent an unsafe login URL";
    }

    function isLoginTerminal(): bool {
        const status = root.loginState ? root.loginState.status : "";
        return status === "succeeded" || status === "failed";
    }

    /** Clear login state and stop polling. Leaves the provider list intact. */
    function resetLogin(): void {
        loginPoll.stop();
        root.loginId = "";
        root.loginState = ({});
        root.loginGhost = "";
        root.loginError = "";
    }

    // ---- Model selection --------------------------------------------------

    /** GET the ghost's current model. Cheap; called on refresh, ghost switch, panel open. */
    function fetchCurrentModel(): void {
        const ghost = root.activeGhost;
        if (ghost === "") return;
        const xhr = new XMLHttpRequest();
        root.modelRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    root.currentModel = body.current || null;
                    root.modelSource = body.source || "none";
                    root.modelError = "";
                } catch (error) {
                    root.modelError = "ghostd sent a malformed model selection";
                }
            } else {
                root.modelError = root.describeError(xhr, "GET model");
            }
        };
        root.dispatch(xhr, "GET",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/model", ({}), null);
    }

    /** GET the models this ghost can use right now (credentialed providers only). */
    function fetchAvailableModels(): void {
        const ghost = root.activeGhost;
        if (ghost === "") return;
        const xhr = new XMLHttpRequest();
        root.availRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    root.availableModels = Array.isArray(body.models) ? body.models : [];
                    root.modelError = "";
                } catch (error) {
                    root.modelError = "ghostd sent a malformed model list";
                }
            } else {
                root.modelError = root.describeError(xhr, "GET models (available)");
            }
        };
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/models?scope=available", ({}), null);
    }

    /**
     * Search the FULL pi catalogue. `query` is a case-insensitive substring on
     * id/name; `offset` pages by catalogLimit. Result → catalogModels/catalogTotal.
     * A stale reply (a newer search already fired) is dropped.
     */
    function fetchCatalog(query: string, offset: int): void {
        const ghost = root.activeGhost;
        if (ghost === "") return;
        root.catalogQuery = query;
        root.catalogOffset = offset;
        root.catalogLoading = true;
        const xhr = new XMLHttpRequest();
        root.catalogRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr !== root.catalogRequest) return;   // superseded by a newer search
            root.catalogLoading = false;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    root.catalogModels = Array.isArray(body.models) ? body.models : [];
                    root.catalogTotal = Number(body.total) || 0;
                    root.modelError = "";
                } catch (error) {
                    root.modelError = "ghostd sent a malformed catalogue";
                }
            } else {
                root.modelError = root.describeError(xhr, "GET models (catalog)");
            }
        };
        const q = query === "" ? "" : "&q=" + encodeURIComponent(query);
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/models?scope=catalog&limit=" + root.catalogLimit + "&offset=" + offset + q,
            ({}), null);
    }

    /**
     * Set roles.chat_model. The daemon writes the role even when the provider is
     * not credentialed and answers { usable: false, … } — we then emit
     * modelSwitchNeedsLogin so the shell can surface a login rather than fail the
     * switch silently. The indicator and available list are refreshed either way.
     */
    function setModel(provider: string, id: string): void {
        const ghost = root.activeGhost;
        if (ghost === "" || provider === "" || id === "") return;
        root.modelWarning = "";
        const xhr = new XMLHttpRequest();
        root.setModelRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                let body = {};
                try {
                    body = JSON.parse(xhr.responseText);
                } catch (error) {
                    body = {};
                }
                root.modelWarning = body.usable === false && typeof body.warning === "string"
                    ? body.warning
                    : "";
                root.modelError = "";
                root.fetchCurrentModel();
                root.fetchAvailableModels();
                // Claude Code owns its external desktop login. Opening Ghost's
                // per-ghost provider form here would offer no usable action.
                if (body.usable === true) {
                    root.modelSwitchCompleted(provider, id);
                } else if (body.usable === false && provider !== "claude-code") {
                    root.modelSwitchNeedsLogin(provider);
                }
            } else {
                root.modelError = root.describeError(xhr, "PUT model");
            }
        };
        root.dispatch(xhr, "PUT",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/model",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ provider: provider, id: id }));
    }

    function applyModelRouting(body: var): void {
        root.modelRouting = Array.isArray(body.roles) ? body.roles : [];
    }

    /** Fetch Ghost roles plus the OMP role/fallback projection. */
    function fetchModelRouting(): void {
        const ghost = root.activeGhost;
        if (ghost === "") return;
        root.modelRoutingLoading = true;
        const xhr = new XMLHttpRequest();
        root.modelRoutingRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.modelRoutingRequest) return;
            root.modelRoutingLoading = false;
            if (xhr.status === 200) {
                try {
                    root.applyModelRouting(JSON.parse(xhr.responseText));
                    root.modelError = "";
                } catch (error) {
                    root.modelError = "ghostd sent malformed model routing";
                }
            } else {
                root.modelError = root.describeError(xhr, "GET model routing");
            }
        };
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/model-routing", ({}), null);
    }

    /** Assign a primary model or append an ordered OMP retry fallback. */
    function setModelRoute(role: string, target: string, provider: string, id: string): void {
        const ghost = root.activeGhost;
        if (ghost === "" || role === "" || provider === "" || id === "") return;
        root.modelRoutingLoading = true;
        const xhr = new XMLHttpRequest();
        root.modelRoutingRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.modelRoutingRequest) return;
            root.modelRoutingLoading = false;
            if (xhr.status === 200) {
                try {
                    root.applyModelRouting(JSON.parse(xhr.responseText));
                    root.modelError = "";
                    root.fetchCurrentModel();
                    root.fetchAvailableModels();
                    root.modelRouteCompleted(role, target);
                } catch (error) {
                    root.modelError = "ghostd sent malformed model routing";
                }
            } else {
                root.modelError = root.describeError(xhr, "PUT model routing");
            }
        };
        root.dispatch(xhr, "PUT", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/model-routing", ({ "Content-Type": "application/json" }),
            JSON.stringify({ role: role, target: target, provider: provider, id: id }));
    }

    function clearModelFallbacks(role: string): void {
        const ghost = root.activeGhost;
        if (ghost === "" || role === "") return;
        root.modelRoutingLoading = true;
        const xhr = new XMLHttpRequest();
        root.modelRoutingRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.modelRoutingRequest) return;
            root.modelRoutingLoading = false;
            if (xhr.status === 200) {
                try {
                    root.applyModelRouting(JSON.parse(xhr.responseText));
                    root.modelError = "";
                    root.modelRouteCompleted(role, "clear_fallbacks");
                } catch (error) {
                    root.modelError = "ghostd sent malformed model routing";
                }
            } else {
                root.modelError = root.describeError(xhr, "clear model fallbacks");
            }
        };
        root.dispatch(xhr, "PUT", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/model-routing", ({ "Content-Type": "application/json" }),
            JSON.stringify({ role: role, target: "clear_fallbacks" }));
    }

    // ---- Errors -----------------------------------------------------------

    /** The daemon's own presentable message for a failure, or "". */
    function errorDetail(xhr: var): string {
        try {
            const body = JSON.parse(xhr.responseText);
            const detail = body.error && body.error.message
                ? body.error.message
                : (body.error || body.message || "");
            return typeof detail === "string" ? detail : "";
        } catch (error) {
            return "";
        }
    }

    function describeError(xhr: var, what: string): string {
        if (xhr.status === 0) return "ghostd is not answering on " + root.baseUrl;
        // dispatch() already re-read the file and retried once, so a 401 that
        // reaches here means the token on disk is not the one ghostd wants.
        if (xhr.status === 401)
            return what + " → 401: ghostd rejected the API token in " + root.tokenPath;
        const detail = root.errorDetail(xhr);
        return what + " → " + xhr.status + (detail ? ": " + detail : "");
    }

    function fail(message: string): void {
        root.reachable = false;
        root.lastError = message;
        console.warn("ghost:", message);
    }
}
