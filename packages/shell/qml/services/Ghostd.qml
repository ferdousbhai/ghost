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
import "CommandTranscript.js" as CommandTranscript
import "GhostRename.js" as GhostRename
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
    /** Ghost whose rename is in flight, under its OLD name, or "" when idle. */
    property string renamingGhost: ""
    /** Why the last ghost deletion was refused, or "". Presentable as-is. */
    property string ghostDeleteError: ""
    /** Why the last ghost rename was refused, or "". Presentable as-is. Kept
        apart from `ghostDeleteError`: that one renders inside the banish
        modal, and a rename is typed in the roster row itself. */
    property string ghostRenameError: ""

    // ---- Browsable context -----------------------------------------------
    // Plain files stay canonical. This is only the latest derived daemon
    // snapshot used by the right-hand Docs/Memory/Helpers/Character surfaces.
    property var contextCharacter: ({ path: "character.md", title: null })
    property var contextDocs: []
    property var contextMemory: []
    property var contextAgents: []
    property var contextSkipped: []
    property bool contextLoading: false
    property string contextError: ""
    property string contextDeletingPath: ""
    property string contextDeleteError: ""
    /** The ghost the current snapshot belongs to; "" means none is cached. */
    property string contextGhost: ""

    // ---- OMP commands -----------------------------------------------------
    // Effective commands are conversation-scoped: an extension can register
    // them while a session is built, so a ghost-level cache would quietly show
    // the wrong palette after switching conversations.
    property var commands: []
    property bool commandsLoading: false
    property string commandsError: ""
    property string commandsGhost: ""
    property string commandsSessionId: ""

    // ---- Ghost MCP -------------------------------------------------------
    // Only the active ghost's visible `mcp.json` is represented here. GET is
    // sanitized by the daemon;
    // secret-bearing values are write-only through mutation bodies.
    property var mcpServers: []
    property var mcpSkipped: []
    property bool mcpLoading: false
    property bool mcpMutating: false
    property string mcpError: ""
    property string mcpNotice: ""
    property string mcpGhost: ""

    // ---- Connect: live voice, collaboration -------------------------------
    property var liveStatus: ({ phase: "idle" })
    property bool liveLoading: false
    property bool liveMutating: false
    property bool liveNotSupported: false
    property string liveError: ""
    property string liveGhost: ""
    property string liveSessionId: ""
    property var collabStatus: ({ active: false })
    property bool collabLoading: false
    property bool collabMutating: false
    property bool collabNotSupported: false
    property string collabError: ""
    property string collabGhost: ""
    property string collabSessionId: ""

    // ---- Conversations ----------------------------------------------------
    // A ghost owns many conversations (pi sessions). The daemon persists them;
    // the HUD lists them per ghost, resumes one by loading its transcript, and
    // starts a fresh one on demand. This fixes #26 — a restart no longer loses
    // history, because a conversation lives in the daemon keyed by session id.
    /** Session listing: [{ id, runtime, conversationId, title, … }]. `id` is the action key. */
    property var sessions: []
    /** Runtime-qualified id of the active conversation. */
    property string currentSessionId: ""
    /** Non-empty when a sessions/transcript fetch failed. */
    property string sessionsError: ""
    /** Conversation currently being deleted, or "" when idle. */
    property string deletingSessionId: ""
    /** Why the last branch refused, or "". Kept apart from `sessionsError`:
        that one renders in the conversation list, and a branch is asked for
        from a message, half a window away from it. */
    property string branchError: ""
    /** Whether the owner can currently see the HUD. */
    property bool hudVisible: false

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

    // ---- Idle recap -------------------------------------------------------
    // OMP's recap is deliberately presentation-only: after one completed Pi
    // turn, an empty composer arms a four-minute timer. Any owner activity
    // retires the timer/request/result before it can bleed into another chat.
    property string recapText: ""
    property string recapGhost: ""
    property string recapSessionId: ""
    property bool composerHasDraft: false
    /** Mutable for deterministic QML tests; production keeps OMP's four minutes. */
    property int recapIdleMs: 240000

    // ---- Turn state -------------------------------------------------------
    /** ListModel of { role, text, tools, toolActivity, error, pending }. */
    property alias transcript: transcriptModel
    /** Presentation-only builtin output, keyed by ghost and conversation. */
    property var commandExchanges: ({})
    /** Number of rows restored from storage, excluding command presentation. */
    property int hydratedRowCount: 0
    property string commandTurnKey: ""
    property int commandTurnIndex: -1
    property int commandTurnAnchor: 0
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
    signal mcpMutationFinished(string action, string server, bool ok)
    signal liveActionFinished(string action, bool ok)
    signal collabActionFinished(string action, bool writable, bool ok)
    signal contextDeleteFinished(string section, string path, bool ok)

    // ---- Model login ------------------------------------------------------
    /** [{ id, name, subscription, authTypes, loginLabel, billingNote, configured, connectedVia }]. */
    property var providers: []
    /** The active login's id, or "" when none is running. */
    property string loginId: ""
    /** The current login view from GET .../login/:id — the step to render. */
    property var loginState: ({})
    /** Which ghost the running login belongs to (a login is per ghost). */
    property string loginGhost: ""
    /** The daemon route that currently owns loginId. During an optimistic ghost
        rename this remains the old name until the rename XHR succeeds. */
    property string loginRouteGhost: ""
    /** No login request may cross the daemon's atomic rename publication. */
    property bool loginRoutePaused: false
    /** Non-empty while a login request is in flight or has failed to reach ghostd. */
    property string loginError: ""

    // ---- Model selection --------------------------------------------------
    /** The resolved current model: { provider, id, name?, contextWindow?, hasVision } | null. */
    property var currentModel: null
    /** How currentModel was chosen: "role" (explicit pick), "default" (fallback), "none". */
    property string modelSource: "none"
    /** scope=available rows the ghost can use now: [{ provider, id, name?, …, current }]. */
    property var availableModels: []
    /** Full available-model count behind the page held in availableModels. */
    property int availableModelTotal: 0
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
    /** [{ role, ompRole, label, primary, effective, source, fallbacks }] from OMP routing. */
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
    property var renameGhostRequest: null
    /** Test seam; production always constructs the native rename XHR. */
    property var renameGhostRequestFactory: null
    property var renameGhostSnapshot: null
    property var renameSessionRequest: null
    /** Login requests have distinct owners so a poll cannot evict an input or
        provider fetch from the GC root, and every one can be retired on close. */
    property var providersRequest: null
    property var loginStartRequest: null
    property var loginPollRequest: null
    property var loginInputRequest: null
    /** Invalidates callbacks from a closed, switched, or superseded flow. */
    property int loginGeneration: 0
    /** Test seam; production always constructs the native QML XHR. */
    property var loginRequestFactory: null
    /** Test seam for a changed token between a request and its first 401. */
    property var tokenReloadOverride: null
    readonly property bool loginPolling: loginPoll.running
    property var modelRequest: null
    /** Invalidates current-model GETs started before a ghost/model transition. */
    property int modelGeneration: 0
    property var availRequest: null
    /** Test seam; production constructs the native available-model XHR. */
    property var availableModelsRequestFactory: null
    property var catalogRequest: null
    property var setModelRequest: null
    property var modelRoutingRequest: null
    property var sessionsRequest: null
    /** Long-lived passive invalidation stream for the active ghost. */
    property var eventsRequest: null
    property string eventsGhost: ""
    property int eventsConsumed: 0
    property string eventsFrameBuffer: ""
    property var contextRequest: null
    property var contextDeleteRequest: null
    property var commandsRequest: null
    property var mcpRequest: null
    property var mcpMutationRequest: null
    property var liveRequest: null
    property var collabRequest: null
    property var greetingRequest: null
    property var recapRequest: null
    /** Test seam; production constructs the native recap XHR. */
    property var recapRequestFactory: null
    property int recapGeneration: 0
    property var transcriptRequest: null
    /** Test seam; production constructs each native transcript-page XHR. */
    property var transcriptRequestFactory: null
    /** Keep transcript restoration finite if a peer reports an absurd total. */
    readonly property int transcriptPageLimit: 1000
    readonly property int transcriptMaxPages: 10
    property var deleteSessionRequest: null
    /** Test seam; production constructs the native session-deletion XHR. */
    property var deleteSessionRequestFactory: null
    property var pinSessionRequest: null
    property var readSessionRequests: ({})
    property var askRequest: null
    property var askSubmitRequest: null
    property var queueRequest: null
    property var queueStatusRequest: null
    property var branchRequest: null
    /** Test seam; production constructs the native branch XHR. */
    property var branchRequestFactory: null

    property var sessionIds: ({})     // ghost name -> runtime-qualified active id
    /** Full live/presentation state keyed by JSON.stringify([ghost, sessionId]). */
    property var turnStates: ({})
    /** Keys whose HTTP turn is still open; replacing this array wakes bindings. */
    property var liveConversationKeys: []
    readonly property bool anyStreaming: root.liveConversationKeys.length > 0
    property var blocks: ({})         // contentIndex -> { kind, text }
    property var toolNames: []        // tool names seen this turn, in order
    property var toolActivities: []   // stateful cards for the current assistant row
    property var toolIdsByContent: ({})
    property int assistantRow: -1
    property int consumed: 0
    property string frameBuffer: ""
    /** True when blocks/tool labels changed since the last 50ms render pass. */
    property bool presentationDirty: false

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
        running: root.anyStreaming
        onTriggered: root.flushLiveTurns()
    }

    // ghostd writes an SSE keepalive every 15s. Three missed beats means this
    // particular response is no longer live even if Qt has not advanced the
    // XHR to DONE (a half-open socket otherwise leaves the HUD spinning forever).
    Timer {
        id: streamWatchdog
        interval: 1000
        repeat: true
        running: root.anyStreaming
        onTriggered: root.expireStaleStreams()
    }

    // The conversation event stream uses the daemon's same 15s keepalive.
    Timer {
        id: eventsWatchdog
        interval: 45000
        repeat: false
        onTriggered: root.expireConversationEvents()
    }

    Timer {
        id: eventsReconnect
        interval: 1000
        repeat: false
        onTriggered: root.connectConversationEvents(root.activeGhost)
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
        running: root.anyStreaming
        onTriggered: root.pollPendingAsks()
    }

    Timer {
        id: queuePoll
        interval: 350
        repeat: true
        running: root.anyStreaming
        onTriggered: root.pollQueues()
    }

    Timer {
        id: recapIdleTimer
        interval: Math.max(1, root.recapIdleMs)
        repeat: false
        onTriggered: root.requestRecap()
    }

    Component.onCompleted: root.refresh()
    Component.onDestruction: root.retireClientRequests()

    function retireClientRequests(): void {
        root.cancelLogin();
        root.cancelAllTranscriptLoads();
        root.clearRecap();
    }
    onActiveGhostChanged: {
        root.clearRecap();
        root.modelGeneration += 1;
        root.modelRequest = null;
        // A rename moves loginGhost before activeGhost, preserving a live flow.
        // Any other selection change makes the old ghost's requests stale.
        if (root.loginGhost === "" || root.loginGhost !== root.activeGhost)
            root.cancelLogin();
        root.connectConversationEvents(root.activeGhost);
    }
    onCurrentSessionIdChanged: root.clearRecap()
    onComposerHasDraftChanged: {
        if (root.composerHasDraft) root.clearRecap();
    }

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
        if (root.tokenReloadOverride) {
            const overridden = root.tokenReloadOverride();
            root.apiToken = overridden ? String(overridden).trim() : "";
            return root.apiToken;
        }
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
    function dispatch(xhr: var, method: string, path: string, headers: var, body: var,
            stillCurrent: var): void {
        const url = root.baseUrl + path;
        const inner = xhr.onreadystatechange;
        let retried = false;
        xhr.onreadystatechange = function () {
            if (typeof stillCurrent === "function" && !stillCurrent()) return;
            if (xhr.readyState === 4 && xhr.status === 401 && !retried) {
                retried = true;
                const before = root.apiToken;
                if (root.reloadToken() !== "" && root.apiToken !== before) {
                    Qt.callLater(function () {
                        // DONE requests cannot be aborted. Re-check ownership here
                        // so closing/switching a flow retires a deferred replay too.
                        if (typeof stillCurrent === "function" && !stillCurrent()) return;
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
            if (xhr.readyState !== 4 || xhr !== root.listRequest) return;
            if (xhr.status === 200) {
                try {
                    const list = JSON.parse(xhr.responseText);
                    root.ghosts = Array.isArray(list) ? list : [];
                    root.reachable = true;
                    root.lastError = "";
                    if (root.activeGhost === "" && root.ghosts.length > 0)
                        root.activeGhost = root.ghosts[0].name;
                    if (root.activeGhost !== "") {
                        root.connectConversationEvents(root.activeGhost);
                        root.fetchCurrentModel();
                        root.fetchSessions(root.activeGhost);
                        root.fetchGreeting();
                        root.refreshCurrentTranscript();
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
                root.clearCommands();
                root.clearMcp();
                root.clearConnect();
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

    /**
     * Rename a ghost. The home directory is what moves; every conversation id
     * survives it, so nothing here reloads a transcript — but everything the
     * shell keys by ghost name has to follow it, or the active ghost's own
     * conversations are stranded under a name that no longer exists.
     *
     * Optimistic, because the name is the window title and the composer's
     * placeholder: both of them lagging a round trip behind the field reads as
     * the edit not having taken. A refusal — `409 ghost_busy` most often — puts
     * every one of those keys back and says why in `ghostRenameError`.
     */
    function renameGhost(from: string, to: string): bool {
        const next = to.trim();
        if (from === "" || next === "" || next === from) return false;
        if (root.renamingGhost !== "" || root.deletingGhost !== "") return false;
        // A start has no login id to recover after the route moves. Established
        // flows are safe to rebind; this short window must settle first.
        if (root.loginStartRequest !== null && root.loginRouteGhost === from) {
            root.ghostRenameError = "Wait for the model login to start before renaming this ghost.";
            return false;
        }
        const transaction = GhostRename.prepare(root.ghostRenameState(), from, next);
        if (!transaction.ok) {
            root.ghostRenameError = transaction.code === "already_exists"
                ? "A ghost named “" + next + "” already exists."
                : "The ghost being renamed is no longer available.";
            return false;
        }
        root.renamingGhost = from;
        root.ghostRenameError = "";
        root.renameGhostSnapshot = transaction.before;
        root.pauseLoginRoute(from);
        root.installGhostRenameState(transaction.after);
        root.moveTurnStates(from, next);
        const xhr = root.renameGhostRequestFactory
            ? root.renameGhostRequestFactory() : new XMLHttpRequest();
        root.renameGhostRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.renameGhostRequest) return;
            root.renameGhostRequest = null;
            root.renamingGhost = "";
            if (xhr.status === 200) {
                root.renameGhostSnapshot = null;
                root.ghostRenameError = "";
                // The daemon has the last word on the name it actually wrote.
                let settled = next;
                try {
                    const body = JSON.parse(xhr.responseText);
                    if (typeof body.name === "string" && body.name !== "") settled = body.name;
                } catch (error) {
                    settled = next;
                }
                if (settled !== next) root.applyGhostRename(next, settled);
                root.moveLoginRoute(from, settled);
                root.refresh();
            } else {
                if (root.renameGhostSnapshot) {
                    root.moveTurnStates(next, from);
                    root.installGhostRenameState(GhostRename.rollback({
                        before: root.renameGhostSnapshot
                    }));
                }
                root.renameGhostSnapshot = null;
                const detail = root.errorDetail(xhr);
                root.ghostRenameError = detail !== ""
                    ? detail
                    : root.describeError(xhr, "PUT ghost name");
                root.resumeLoginRoute(from);
            }
        };
        root.dispatch(xhr, "PUT",
            "/api/ghosts/" + encodeURIComponent(from) + "/name",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ name: next }));
        return true;
    }

    function ghostRenameState(): var {
        return {
            ghosts: root.ghosts,
            sessionIds: root.sessionIds,
            commandExchanges: root.commandExchanges,
            commandTurnKey: root.commandTurnKey,
            greetingGhost: root.greetingGhost,
            loginGhost: root.loginGhost,
            commandsGhost: root.commandsGhost,
            mcpGhost: root.mcpGhost,
            liveGhost: root.liveGhost,
            collabGhost: root.collabGhost,
            activeGhost: root.activeGhost,
            contextGhost: root.contextGhost
        };
    }

    function installGhostRenameState(state: var): void {
        root.ghosts = state.ghosts;
        root.sessionIds = state.sessionIds;
        root.commandExchanges = state.commandExchanges;
        root.commandTurnKey = state.commandTurnKey;
        root.greetingGhost = state.greetingGhost;
        root.loginGhost = state.loginGhost;
        root.commandsGhost = state.commandsGhost;
        root.mcpGhost = state.mcpGhost;
        root.liveGhost = state.liveGhost;
        root.collabGhost = state.collabGhost;
        root.activeGhost = state.activeGhost;
        root.contextGhost = state.contextGhost;
    }

    /** Move everything the shell keys by a ghost's name onto the new one. */
    function applyGhostRename(from: string, to: string): void {
        root.installGhostRenameState(GhostRename.move(root.ghostRenameState(), from, to));
        root.moveTurnStates(from, to);
    }

    function moveTurnStates(from: string, to: string): void {
        if (from === to) return;
        const next = ({});
        for (const key of Object.keys(root.turnStates)) {
            const state = root.turnStates[key];
            if (state && state.ghost === from) {
                state.ghost = to;
                state.key = root.conversationKey(to, state.sessionId);
                next[state.key] = state;
            } else {
                next[key] = state;
            }
        }
        root.turnStates = next;
        root.updateLiveConversationKeys();
    }

    /** Drop every trace of a ghost that is no longer there. */
    function forgetGhost(name: string): void {
        delete root.sessionIds[name];
        root.dropCommandTranscripts(name, "");
        const kept = ({});
        for (const key of Object.keys(root.turnStates)) {
            const state = root.turnStates[key];
            if (state && state.ghost === name) root.cancelTranscriptLoad(state);
            else if (state) kept[key] = state;
        }
        root.turnStates = kept;
        root.updateLiveConversationKeys();
        if (name !== root.activeGhost) return;
        root.activeGhost = "";
        root.currentSessionId = "";
        root.sessions = [];
        root.sessionsError = "";
        root.clearTurnProjection();
        root.clearModelState();
        root.clearGreeting();
        root.clearContext();
        root.clearCommands();
        root.clearMcp();
        root.clearConnect();
    }

    function selectGhost(name: string): void {
        if (name === root.activeGhost) return;
        const previous = root.activeTurnState(false);
        if (previous) {
            root.captureActiveTurn(previous);
            root.cancelTranscriptLoad(previous);
        }
        root.activeGhost = name;
        // Conversations are per ghost; restore this ghost's last-active session
        // id (if any) and list its conversations. The transcript view stays
        // empty until the user opens one — a switch shows the list, not a body.
        root.currentSessionId = root.sessionIds[name] || "";
        root.showTurnState(name, root.currentSessionId);
        root.sessions = [];
        root.sessionsError = "";
        // Model selection is per ghost; drop the old one and fetch the new.
        root.clearModelState();
        // The greeting is this ghost's own voice, so it never carries over.
        root.clearGreeting();
        root.clearContext();
        root.clearCommands();
        root.clearMcp();
        root.clearConnect();
        root.fetchCurrentModel();
        root.fetchSessions(name);
        root.fetchGreeting();
    }

    function conversationKey(ghost: string, sessionId: string): string {
        return JSON.stringify([ghost, sessionId]);
    }

    function conversationActionId(runtime: string, conversationId: string): string {
        return runtime + ":" + conversationId;
    }

    function parseConversationActionId(id: string): var {
        const piPrefix = "pi:";
        if (id.indexOf(piPrefix) === 0 && id.length > piPrefix.length) return {
            id: id,
            runtime: "pi",
            conversationId: id.slice(piPrefix.length)
        };
        const claudePrefix = "claude-code:";
        if (id.indexOf(claudePrefix) === 0 && id.length > claudePrefix.length) return {
            id: id,
            runtime: "claude-code",
            conversationId: id.slice(claudePrefix.length)
        };
        return null;
    }

    function conversationIdentity(id: string): var {
        const row = root.sessions.find(function (session) {
            return session && session.id === id;
        });
        if (row && (row.runtime === "pi" || row.runtime === "claude-code")
                && typeof row.conversationId === "string" && row.conversationId !== "")
            return { id: id, runtime: row.runtime, conversationId: row.conversationId };
        return root.parseConversationActionId(id);
    }

    function transcriptMatchesIdentity(body: var, state: var): bool {
        return body && state
            && body.id === state.sessionId
            && body.conversationId === state.conversationId
            && body.runtime === state.runtime
            && Array.isArray(body.messages);
    }

    function cancelTranscriptLoad(state: var): void {
        if (!state) return;
        const xhr = state.transcriptRequest;
        state.transcriptGeneration = Number(state.transcriptGeneration || 0) + 1;
        state.transcriptRequest = null;
        state.transcriptLoad = null;
        if (root.isActiveTurn(state)) root.transcriptRequest = null;
        // Retire ownership before abort because Qt may synchronously deliver DONE.
        if (xhr && xhr.readyState !== 4 && typeof xhr.abort === "function") xhr.abort();
    }

    function cancelAllTranscriptLoads(): void {
        for (const key of Object.keys(root.turnStates))
            root.cancelTranscriptLoad(root.turnStates[key]);
    }

    function runtimeForNewConversation(): string {
        return root.currentModel && root.currentModel.provider === "claude-code"
            ? "claude-code" : "pi";
    }

    function adoptConversationRuntime(ghost: string, runtime: string): var {
        if (ghost === "" || ghost !== root.activeGhost
                || (runtime !== "pi" && runtime !== "claude-code")) return null;
        const state = root.activeTurnState(false);
        if (!state || state.runtime === runtime || state.streaming) return state;
        root.captureActiveTurn(state);
        root.cancelTranscriptLoad(state);
        const id = root.conversationActionId(runtime, state.conversationId);
        root.sessionIds[ghost] = id;
        root.currentSessionId = id;
        const target = root.ensureTurnState(ghost, id, state.conversationId, runtime);
        root.showTurnState(ghost, id);
        root.clearCommands();
        root.clearConnect();
        return target;
    }

    function isActiveTurn(state: var): bool {
        return !!state && state.ghost === root.activeGhost
            && state.sessionId === root.currentSessionId;
    }

    function cloneTranscriptRow(row: var): var {
        return {
            role: String(row.role || ""),
            text: String(row.text || ""),
            tools: String(row.tools || ""),
            toolActivity: Array.isArray(row.toolActivity) ? row.toolActivity.slice() : [],
            error: String(row.error || ""),
            pending: row.pending === true,
            entryId: String(row.entryId || "")
        };
    }

    function visibleTranscriptRows(): var {
        const rows = [];
        for (let index = 0; index < transcriptModel.count; index++)
            rows.push(root.cloneTranscriptRow(transcriptModel.get(index)));
        return rows;
    }

    function newTurnState(ghost: string, sessionId: string,
            conversationId: string, runtime: string): var {
        return {
            key: root.conversationKey(ghost, sessionId),
            ghost: ghost,
            sessionId: sessionId,
            conversationId: conversationId,
            runtime: runtime,
            rows: [],
            hydratedRowCount: 0,
            commandTurnKey: "",
            commandTurnIndex: -1,
            commandTurnAnchor: 0,
            streaming: false,
            request: null,
            lastStreamActivity: 0,
            activity: "",
            statusText: "",
            lastError: "",
            pendingAsk: null,
            askSubmitting: false,
            askError: "",
            steeringQueue: [],
            followUpQueue: [],
            queueSubmitting: false,
            queueError: "",
            blocks: ({}),
            toolNames: [],
            toolActivities: [],
            toolIdsByContent: ({}),
            assistantRow: -1,
            consumed: 0,
            frameBuffer: "",
            presentationDirty: false,
            askRequest: null,
            askSubmitRequest: null,
            queueRequest: null,
            queueStatusRequest: null,
            transcriptRequest: null,
            transcriptGeneration: 0,
            transcriptLoad: null
        };
    }

    function ensureTurnState(ghost: string, sessionId: string,
            conversationId: var, runtime: var): var {
        if (ghost === "" || sessionId === "") return null;
        const key = root.conversationKey(ghost, sessionId);
        let state = root.turnStates[key];
        if (!state) {
            const identity = typeof conversationId === "string" && conversationId !== ""
                ? { id: sessionId, conversationId: conversationId, runtime: runtime || "pi" }
                : root.conversationIdentity(sessionId);
            if (!identity || identity.id !== root.conversationActionId(
                    identity.runtime, identity.conversationId)) return null;
            state = root.newTurnState(ghost, sessionId,
                identity.conversationId, identity.runtime);
            const next = Object.assign({}, root.turnStates);
            next[key] = state;
            root.turnStates = next;
        }
        return state;
    }

    function activeTurnState(create: bool): var {
        if (root.activeGhost === "" || root.currentSessionId === "") return null;
        const key = root.conversationKey(root.activeGhost, root.currentSessionId);
        return root.turnStates[key]
            || (create ? root.ensureTurnState(root.activeGhost, root.currentSessionId) : null);
    }

    /** Tests and QML controls still write the active projection directly. */
    function captureActiveTurn(state: var): void {
        if (!root.isActiveTurn(state)) return;
        root.captureTurnProjection(state);
    }

    function captureTurnProjection(state: var): void {
        state.rows = root.visibleTranscriptRows();
        state.hydratedRowCount = root.hydratedRowCount;
        state.commandTurnKey = root.commandTurnKey;
        state.commandTurnIndex = root.commandTurnIndex;
        state.commandTurnAnchor = root.commandTurnAnchor;
        state.streaming = root.streaming;
        state.request = root.request;
        state.activity = root.activity;
        state.statusText = root.statusText;
        state.lastError = root.lastError;
        state.pendingAsk = root.pendingAsk;
        state.askSubmitting = root.askSubmitting;
        state.askError = root.askError;
        state.steeringQueue = root.steeringQueue.slice();
        state.followUpQueue = root.followUpQueue.slice();
        state.queueSubmitting = root.queueSubmitting;
        state.queueError = root.queueError;
        state.blocks = root.blocks;
        state.toolNames = root.toolNames.slice();
        state.toolActivities = root.toolActivities.slice();
        state.toolIdsByContent = root.toolIdsByContent;
        state.assistantRow = root.assistantRow;
        state.consumed = root.consumed;
        state.frameBuffer = root.frameBuffer;
        state.presentationDirty = root.presentationDirty;
    }

    /** Legacy direct stream helpers have no key; a single live turn is unambiguous. */
    function compatibilityTurnState(): var {
        const active = root.activeTurnState(false);
        if (active) return active;
        if (root.liveConversationKeys.length !== 1) return null;
        return root.turnStates[root.liveConversationKeys[0]] || null;
    }

    function projectTurnFields(state: var): void {
        if (!root.isActiveTurn(state)) return;
        root.projectTurnProjection(state);
    }

    function projectTurnProjection(state: var): void {
        root.hydratedRowCount = state.hydratedRowCount;
        root.commandTurnKey = state.commandTurnKey;
        root.commandTurnIndex = state.commandTurnIndex;
        root.commandTurnAnchor = state.commandTurnAnchor;
        root.streaming = state.streaming;
        root.request = state.request;
        root.activity = state.activity;
        root.statusText = state.statusText;
        root.lastError = state.lastError;
        root.pendingAsk = state.pendingAsk;
        root.askSubmitting = state.askSubmitting;
        root.askError = state.askError;
        root.steeringQueue = state.steeringQueue;
        root.followUpQueue = state.followUpQueue;
        root.queueSubmitting = state.queueSubmitting;
        root.queueError = state.queueError;
        root.blocks = state.blocks;
        root.toolNames = state.toolNames;
        root.toolActivities = state.toolActivities;
        root.toolIdsByContent = state.toolIdsByContent;
        root.assistantRow = state.assistantRow;
        root.consumed = state.consumed;
        root.frameBuffer = state.frameBuffer;
        root.presentationDirty = state.presentationDirty;
        root.transcriptRequest = state.transcriptRequest;
    }

    function clearTurnProjection(): void {
        transcriptModel.clear();
        root.hydratedRowCount = 0;
        root.commandTurnKey = "";
        root.commandTurnIndex = -1;
        root.commandTurnAnchor = 0;
        root.streaming = false;
        root.request = null;
        root.activity = "";
        root.statusText = "";
        root.pendingAsk = null;
        root.askSubmitting = false;
        root.askError = "";
        root.steeringQueue = [];
        root.followUpQueue = [];
        root.queueSubmitting = false;
        root.queueError = "";
        root.blocks = ({});
        root.toolNames = [];
        root.toolActivities = [];
        root.toolIdsByContent = ({});
        root.assistantRow = -1;
        root.consumed = 0;
        root.frameBuffer = "";
        root.presentationDirty = false;
        root.transcriptRequest = null;
    }

    function showTurnState(ghost: string, sessionId: string): void {
        const state = sessionId === "" ? null
            : root.turnStates[root.conversationKey(ghost, sessionId)];
        root.clearTurnProjection();
        if (!state) return;
        root.projectTurnRows(state);
        root.projectTurnFields(state);
    }

    function projectTurnRows(state: var): void {
        transcriptModel.clear();
        for (const row of state.rows) transcriptModel.append(root.cloneTranscriptRow(row));
    }

    function appendTurnRow(state: var, row: var): void {
        const copy = root.cloneTranscriptRow(row);
        state.rows.push(copy);
        if (root.isActiveTurn(state)) transcriptModel.append(root.cloneTranscriptRow(copy));
    }

    function removeTurnRow(state: var, index: int): void {
        if (index < 0 || index >= state.rows.length) return;
        state.rows.splice(index, 1);
        if (root.isActiveTurn(state)) transcriptModel.remove(index);
    }

    function setTurnRow(state: var, index: int, propertyName: string, value: var): void {
        if (index < 0 || index >= state.rows.length) return;
        state.rows[index] = Object.assign({}, state.rows[index], ({ [propertyName]: value }));
        if (root.isActiveTurn(state)) transcriptModel.setProperty(index, propertyName, value);
    }

    function replaceTurnRows(state: var, rows: var): void {
        state.rows = rows.map(root.cloneTranscriptRow);
        if (!root.isActiveTurn(state)) return;
        transcriptModel.clear();
        for (const row of state.rows) transcriptModel.append(root.cloneTranscriptRow(row));
    }

    function updateLiveConversationKeys(): void {
        root.liveConversationKeys = Object.keys(root.turnStates).filter(function (key) {
            return root.turnStates[key] && root.turnStates[key].streaming === true;
        });
    }

    function isConversationStreaming(ghost: string, id: string): bool {
        return root.liveConversationKeys.indexOf(root.conversationKey(ghost, id)) >= 0;
    }

    function clearTranscript(): void {
        const state = root.activeTurnState(false);
        if (state && state.streaming) return;
        if (state) {
            state.rows = [];
            state.hydratedRowCount = 0;
            state.commandTurnKey = "";
            state.commandTurnIndex = -1;
            state.commandTurnAnchor = 0;
            state.assistantRow = -1;
            root.resetAssistantSegmentFor(state);
            root.resetInteractionStateFor(state);
        }
        root.clearTurnProjection();
        root.branchError = "";
    }

    function flushLiveTurns(): void {
        for (const key of root.liveConversationKeys) {
            const state = root.turnStates[key];
            if (state) root.flushTurn(state, false, false);
        }
    }

    function expireStaleStreams(): void {
        const now = Date.now();
        for (const key of root.liveConversationKeys) {
            const state = root.turnStates[key];
            if (state && now - state.lastStreamActivity >= 45000)
                root.expireTurnStream(state);
        }
    }

    function pollPendingAsks(): void {
        for (const key of root.liveConversationKeys) {
            const state = root.turnStates[key];
            if (state && state.activity === "ask" && state.pendingAsk === null
                    && !state.askSubmitting)
                root.fetchPendingAskFor(state);
        }
    }

    function pollQueues(): void {
        for (const key of root.liveConversationKeys) {
            const state = root.turnStates[key];
            if (state && state.pendingAsk === null) root.fetchQueueFor(state);
        }
    }

    /** Drop model data that belongs to the previously selected ghost. */
    function clearModelState(): void {
        root.currentModel = null;
        root.modelSource = "none";
        root.availableModels = [];
        root.availableModelTotal = 0;
        root.modelRouting = [];
        root.modelRoutingLoading = false;
        root.modelWarning = "";
    }

    // ---- Greeting ---------------------------------------------------------

    /** Forget the current greeting so the next fetch asks for a fresh one. */
    function clearGreeting(): void {
        root.greeting = "";
        root.greetingOnboarding = false;
        root.greetingGhost = "";
    }

    // ---- Idle recap -------------------------------------------------------

    function clearRecap(): void {
        root.recapGeneration += 1;
        recapIdleTimer.stop();
        const xhr = root.recapRequest;
        root.recapRequest = null;
        root.recapText = "";
        root.recapGhost = "";
        root.recapSessionId = "";
        if (xhr && xhr.readyState !== 4) xhr.abort();
    }

    /** Arm the OMP-native recap only for the conversation that just settled. */
    function scheduleRecapFor(state: var): void {
        root.clearRecap();
        if (!root.isActiveTurn(state) || state.streaming || state.runtime !== "pi"
                || root.composerHasDraft) return;
        root.recapGhost = state.ghost;
        root.recapSessionId = state.sessionId;
        recapIdleTimer.restart();
    }

    function requestRecap(): void {
        recapIdleTimer.stop();
        const ghost = root.recapGhost;
        const sessionId = root.recapSessionId;
        const state = root.turnStates[root.conversationKey(ghost, sessionId)];
        if (ghost === "" || sessionId === "" || root.composerHasDraft
                || !root.isActiveTurn(state) || state.streaming || state.runtime !== "pi") {
            root.clearRecap();
            return;
        }

        const generation = root.recapGeneration;
        const xhr = root.recapRequestFactory
            ? root.recapRequestFactory() : new XMLHttpRequest();
        root.recapRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.recapRequest
                    || generation !== root.recapGeneration) return;
            root.recapRequest = null;
            const current = root.turnStates[root.conversationKey(ghost, sessionId)];
            if (root.composerHasDraft || !root.isActiveTurn(current) || current.streaming) {
                root.clearRecap();
                return;
            }
            if (xhr.status !== 200) return;
            try {
                const body = JSON.parse(xhr.responseText);
                root.recapText = typeof body.recap === "string" ? body.recap.trim() : "";
            } catch (error) {
                root.recapText = "";
            }
        };
        root.dispatch(xhr, "POST", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(sessionId) + "/recap",
            ({ "Content-Type": "application/json" }), JSON.stringify({}), function () {
                return xhr === root.recapRequest && generation === root.recapGeneration;
            });
    }

    // ---- Browsable context -----------------------------------------------

    /** Drop a snapshot that belongs to a ghost the owner has left. */
    function clearContext(): void {
        if (root.contextRequest && root.contextRequest.readyState !== 4)
            root.contextRequest.abort();
        if (root.contextDeleteRequest && root.contextDeleteRequest.readyState !== 4)
            root.contextDeleteRequest.abort();
        root.contextRequest = null;
        root.contextDeleteRequest = null;
        root.contextCharacter = ({ path: "character.md", title: null });
        root.contextDocs = [];
        root.contextMemory = [];
        root.contextAgents = [];
        root.contextSkipped = [];
        root.contextLoading = false;
        root.contextError = "";
        root.contextDeletingPath = "";
        root.contextDeleteError = "";
        root.contextGhost = "";
    }

    /**
     * Rebuild the active ghost's context catalog. `force` bypasses the
     * per-ghost cache for the visible refresh affordance after external edits.
     */
    function fetchContext(force: bool): void {
        const ghost = root.activeGhost;
        if (ghost === "") {
            root.clearContext();
            return;
        }
        if (!force && root.contextGhost === ghost) return;
        if (root.contextRequest && root.contextRequest.readyState !== 4) {
            if (!force) return;
            root.contextRequest.abort();
        }

        const xhr = new XMLHttpRequest();
        root.contextRequest = xhr;
        root.contextLoading = true;
        root.contextError = "";
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.contextRequest) return;
            root.contextLoading = false;
            if (ghost !== root.activeGhost) return;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    root.contextCharacter = body.character
                        && typeof body.character === "object"
                        ? body.character : ({ path: "character.md", title: null });
                    root.contextDocs = Array.isArray(body.docs) ? body.docs : [];
                    root.contextMemory = Array.isArray(body.memory) ? body.memory : [];
                    root.contextAgents = Array.isArray(body.agents) ? body.agents : [];
                    root.contextSkipped = Array.isArray(body.skipped) ? body.skipped : [];
                    root.contextGhost = ghost;
                    root.contextError = "";
                    root.reachable = true;
                } catch (error) {
                    root.contextError = "ghostd sent malformed context";
                }
            } else {
                root.contextError = root.describeError(xhr, "GET context");
            }
        };
        root.dispatch(xhr, "GET",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/context", ({}), null);
    }

    /** Move one doc or memory file to system Trash after the UI confirms it. */
    function deleteContextFile(section: string, path: string): void {
        const ghost = root.activeGhost;
        if (ghost === "" || path === "" || root.contextDeletingPath !== "") return;
        if (section !== "docs" && section !== "memory") return;
        const xhr = new XMLHttpRequest();
        root.contextDeleteRequest = xhr;
        root.contextDeletingPath = path;
        root.contextDeleteError = "";
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.contextDeleteRequest) return;
            root.contextDeletingPath = "";
            if (ghost !== root.activeGhost) return;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    if (!body || body.ok !== true || body.path !== path
                            || typeof body.trash !== "string")
                        throw new Error("invalid trash result");
                    // The absolute trash destination is intentionally not
                    // logged; the file manager owns restoration from here.
                    root.contextDeleteError = "";
                    root.contextDeleteFinished(section, path, true);
                    root.fetchContext(true);
                } catch (error) {
                    root.contextDeleteError = "ghostd sent a malformed trash result";
                    root.contextDeleteFinished(section, path, false);
                }
            } else {
                root.contextDeleteError = root.describeError(xhr, "DELETE context file");
                root.contextDeleteFinished(section, path, false);
            }
        };
        root.dispatch(xhr, "DELETE",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/context",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ section: section, path: path, confirm: path }));
    }

    // ---- OMP command catalog ---------------------------------------------

    /** Forget a catalog whose ghost or conversation is no longer active. */
    function clearCommands(): void {
        if (root.commandsRequest && root.commandsRequest.readyState !== 4)
            root.commandsRequest.abort();
        root.commandsRequest = null;
        root.commands = [];
        root.commandsLoading = false;
        root.commandsError = "";
        root.commandsGhost = "";
        root.commandsSessionId = "";
    }

    /**
     * Discover the effective OMP slash commands for the active conversation.
     * `ensureSession` may mint the id for a blank chat, but the daemon still
     * creates its transcript lazily: browsing commands does not add a row to
     * the conversation list.
     */
    function fetchCommands(force: bool): void {
        const ghost = root.activeGhost;
        if (ghost === "") {
            root.clearCommands();
            return;
        }
        const sessionId = root.ensureSession(ghost);
        if (!force && root.commandsGhost === ghost
                && root.commandsSessionId === sessionId) return;
        if (root.commandsRequest && root.commandsRequest.readyState !== 4)
            root.commandsRequest.abort();

        const xhr = new XMLHttpRequest();
        root.commandsRequest = xhr;
        root.commands = [];
        root.commandsLoading = true;
        root.commandsError = "";
        root.commandsGhost = ghost;
        root.commandsSessionId = sessionId;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.commandsRequest) return;
            if (ghost !== root.activeGhost || sessionId !== root.currentSessionId) return;
            root.commandsLoading = false;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    const list = body && Array.isArray(body.commands) ? body.commands : null;
                    if (list === null) throw new Error("missing commands");
                    root.commands = list.filter(function (command) {
                        return command && typeof command === "object"
                            && typeof command.name === "string"
                            && command.name.trim() !== "";
                    });
                    root.commandsError = "";
                    root.reachable = true;
                } catch (error) {
                    root.commands = [];
                    root.commandsError = "ghostd sent a malformed command catalog";
                }
            } else {
                root.commands = [];
                root.commandsError = root.describeError(xhr, "GET commands");
            }
        };
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(sessionId) + "/commands", ({}), null);
    }

    // ---- Project MCP management -----------------------------------------

    function clearMcp(): void {
        if (root.mcpRequest && root.mcpRequest.readyState !== 4)
            root.mcpRequest.abort();
        if (root.mcpMutationRequest && root.mcpMutationRequest.readyState !== 4)
            root.mcpMutationRequest.abort();
        root.mcpRequest = null;
        root.mcpMutationRequest = null;
        root.mcpServers = [];
        root.mcpSkipped = [];
        root.mcpLoading = false;
        root.mcpMutating = false;
        root.mcpError = "";
        root.mcpNotice = "";
        root.mcpGhost = "";
    }

    /** Apply the sanitized catalog shape shared by reads and mutations. */
    function applyMcpSnapshot(body: var, ghost: string): bool {
        if (!body || !Array.isArray(body.servers) || !Array.isArray(body.skipped))
            return false;
        root.mcpServers = body.servers.filter(function (server) {
            return server && typeof server === "object"
                && typeof server.name === "string" && server.name.trim() !== ""
                && server.config && typeof server.config === "object";
        });
        root.mcpSkipped = body.skipped.filter(function (entry) {
            return entry && typeof entry === "object";
        });
        root.mcpGhost = ghost;
        return true;
    }

    function fetchMcp(force: bool): void {
        const ghost = root.activeGhost;
        if (ghost === "") {
            root.clearMcp();
            return;
        }
        if (!force && root.mcpGhost === ghost) return;
        if (root.mcpRequest && root.mcpRequest.readyState !== 4) {
            if (!force) return;
            root.mcpRequest.abort();
        }

        const xhr = new XMLHttpRequest();
        root.mcpRequest = xhr;
        root.mcpLoading = true;
        root.mcpError = "";
        root.mcpNotice = "";
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.mcpRequest) return;
            root.mcpLoading = false;
            if (ghost !== root.activeGhost) return;
            if (xhr.status === 200) {
                try {
                    if (!root.applyMcpSnapshot(JSON.parse(xhr.responseText), ghost))
                        throw new Error("missing catalog");
                    root.mcpError = "";
                    root.reachable = true;
                } catch (error) {
                    root.mcpServers = [];
                    root.mcpSkipped = [];
                    root.mcpError = "ghostd sent a malformed MCP catalog";
                }
            } else {
                root.mcpError = root.describeError(xhr, "GET MCP servers");
            }
        };
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/mcp", ({}), null);
    }

    function mutateMcp(method: string, suffix: string, body: var,
            action: string, server: string): void {
        const ghost = root.activeGhost;
        if (ghost === "" || root.mcpMutating) return;
        if (root.mcpRequest && root.mcpRequest.readyState !== 4)
            root.mcpRequest.abort();
        const xhr = new XMLHttpRequest();
        root.mcpMutationRequest = xhr;
        root.mcpMutating = true;
        root.mcpError = "";
        root.mcpNotice = "";
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.mcpMutationRequest) return;
            root.mcpMutating = false;
            if (ghost !== root.activeGhost) return;
            if (xhr.status === 200 || xhr.status === 201) {
                try {
                    if (!root.applyMcpSnapshot(JSON.parse(xhr.responseText), ghost))
                        throw new Error("missing catalog");
                    root.mcpError = "";
                    root.mcpNotice = action === "delete" ? "Server deleted."
                        : (action === "toggle" ? "Server state updated."
                            : (action === "add" ? "Server added." : "Server updated."));
                    root.reachable = true;
                    root.mcpMutationFinished(action, server, true);
                } catch (error) {
                    root.mcpError = "ghostd sent a malformed MCP catalog";
                    root.mcpMutationFinished(action, server, false);
                }
            } else {
                root.mcpError = root.describeError(xhr, method + " MCP server");
                root.mcpMutationFinished(action, server, false);
            }
        };
        const headers = body === null ? ({}) : ({ "Content-Type": "application/json" });
        root.dispatch(xhr, method, "/api/ghosts/" + encodeURIComponent(ghost)
            + "/mcp" + suffix, headers, body === null ? null : JSON.stringify(body));
    }

    function addMcpServer(name: string, config: var): void {
        const trimmed = name.trim();
        if (trimmed === "") return;
        root.mutateMcp("POST", "", { name: trimmed, config: config },
            "add", trimmed);
    }

    function updateMcpServer(name: string, config: var): void {
        if (name === "") return;
        root.mutateMcp("PUT", "/" + encodeURIComponent(name), { config: config },
            "update", name);
    }

    function setMcpEnabled(name: string, enabled: bool): void {
        if (name === "") return;
        root.mutateMcp("PUT", "/" + encodeURIComponent(name) + "/enabled",
            { enabled: enabled }, "toggle", name);
    }

    function deleteMcpServer(name: string): void {
        if (name === "") return;
        root.mutateMcp("DELETE", "/" + encodeURIComponent(name), null,
            "delete", name);
    }

    // ---- Connect: live voice, collaboration -------------------------------

    function clearConnect(): void {
        if (root.liveRequest && root.liveRequest.readyState !== 4)
            root.liveRequest.abort();
        if (root.collabRequest && root.collabRequest.readyState !== 4)
            root.collabRequest.abort();
        root.liveRequest = null;
        root.collabRequest = null;
        root.liveStatus = ({ phase: "idle" });
        root.liveLoading = false;
        root.liveMutating = false;
        root.liveNotSupported = false;
        root.liveError = "";
        root.liveGhost = "";
        root.liveSessionId = "";
        root.collabStatus = ({ active: false });
        root.collabLoading = false;
        root.collabMutating = false;
        root.collabNotSupported = false;
        root.collabError = "";
        root.collabGhost = "";
        root.collabSessionId = "";
    }

    function responseNotSupported(body: var): bool {
        return body && typeof body === "object" && (body.supported === false
            || body.code === "not_supported" || body.errorCode === "not_supported"
            || (body.error && body.error.code === "not_supported"));
    }

    function fetchConnect(force: bool): void {
        root.fetchLive(force);
        root.fetchCollab(force);
    }

    function applyLiveStatus(body: var, ghost: string, sessionId: string): bool {
        if (!body || typeof body !== "object" || Array.isArray(body)) return false;
        root.liveStatus = body;
        root.liveNotSupported = root.responseNotSupported(body);
        root.liveGhost = ghost;
        root.liveSessionId = sessionId;
        return true;
    }

    function fetchLive(force: bool): void {
        const ghost = root.activeGhost;
        if (ghost === "") return;
        const sessionId = root.ensureSession(ghost);
        if (!force && root.liveGhost === ghost && root.liveSessionId === sessionId) return;
        if (root.liveRequest && root.liveRequest.readyState !== 4) {
            if (!force) return;
            root.liveRequest.abort();
        }
        const xhr = new XMLHttpRequest();
        root.liveRequest = xhr;
        root.liveLoading = true;
        root.liveError = "";
        root.liveGhost = ghost;
        root.liveSessionId = sessionId;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.liveRequest) return;
            root.liveLoading = false;
            if (ghost !== root.activeGhost || sessionId !== root.currentSessionId) return;
            if (xhr.status === 200) {
                try {
                    if (!root.applyLiveStatus(JSON.parse(xhr.responseText), ghost, sessionId))
                        throw new Error("invalid status");
                    root.liveError = "";
                    root.reachable = true;
                } catch (error) {
                    root.liveError = "ghostd sent malformed live-voice status";
                }
            } else if (root.errorCode(xhr) === "not_supported") {
                root.liveNotSupported = true;
                root.liveStatus = ({
                    supported: false,
                    code: "not_supported",
                    message: root.errorDetail(xhr)
                });
                root.liveError = "";
            } else {
                root.liveError = root.describeError(xhr, "GET live voice");
            }
        };
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(sessionId) + "/live", ({}), null);
    }

    function liveAction(action: string): void {
        const ghost = root.activeGhost;
        if (ghost === "" || root.liveMutating
                || ["start", "mute", "unmute", "stop"].indexOf(action) < 0) return;
        const sessionId = root.ensureSession(ghost);
        if (root.liveRequest && root.liveRequest.readyState !== 4)
            root.liveRequest.abort();
        const xhr = new XMLHttpRequest();
        root.liveRequest = xhr;
        root.liveMutating = true;
        root.liveError = "";
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.liveRequest) return;
            root.liveMutating = false;
            if (ghost !== root.activeGhost || sessionId !== root.currentSessionId) return;
            if (xhr.status === 200 || xhr.status === 201) {
                try {
                    if (!root.applyLiveStatus(JSON.parse(xhr.responseText), ghost, sessionId))
                        throw new Error("invalid status");
                    root.liveError = "";
                    root.reachable = true;
                    root.liveActionFinished(action, true);
                } catch (error) {
                    root.liveError = "ghostd sent malformed live-voice status";
                    root.liveActionFinished(action, false);
                }
            } else if (root.errorCode(xhr) === "not_supported") {
                root.liveNotSupported = true;
                root.liveStatus = ({
                    supported: false,
                    code: "not_supported",
                    message: root.errorDetail(xhr)
                });
                root.liveError = "";
                root.liveActionFinished(action, false);
            } else {
                root.liveError = root.describeError(xhr, "POST live voice");
                root.liveActionFinished(action, false);
            }
        };
        root.dispatch(xhr, "POST", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(sessionId) + "/live",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ action: action }));
    }

    function applyCollabStatus(body: var, ghost: string, sessionId: string): bool {
        if (!body || typeof body !== "object" || Array.isArray(body)) return false;
        root.collabStatus = body;
        root.collabNotSupported = root.responseNotSupported(body);
        root.collabGhost = ghost;
        root.collabSessionId = sessionId;
        return true;
    }

    function fetchCollab(force: bool): void {
        const ghost = root.activeGhost;
        if (ghost === "") return;
        const sessionId = root.ensureSession(ghost);
        if (!force && root.collabGhost === ghost
                && root.collabSessionId === sessionId) return;
        if (root.collabRequest && root.collabRequest.readyState !== 4) {
            if (!force) return;
            root.collabRequest.abort();
        }
        const xhr = new XMLHttpRequest();
        root.collabRequest = xhr;
        root.collabLoading = true;
        root.collabError = "";
        root.collabGhost = ghost;
        root.collabSessionId = sessionId;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.collabRequest) return;
            root.collabLoading = false;
            if (ghost !== root.activeGhost || sessionId !== root.currentSessionId) return;
            if (xhr.status === 200) {
                try {
                    if (!root.applyCollabStatus(JSON.parse(xhr.responseText), ghost, sessionId))
                        throw new Error("invalid status");
                    root.collabError = "";
                    root.reachable = true;
                } catch (error) {
                    root.collabError = "ghostd sent malformed collaboration status";
                }
            } else if (root.errorCode(xhr) === "not_supported") {
                root.collabNotSupported = true;
                root.collabStatus = ({
                    supported: false,
                    code: "not_supported",
                    message: root.errorDetail(xhr)
                });
                root.collabError = "";
            } else {
                root.collabError = root.describeError(xhr, "GET collaboration");
            }
        };
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(sessionId) + "/collab", ({}), null);
    }

    function collabAction(action: string, relayUrl: string, writable: bool): void {
        const ghost = root.activeGhost;
        if (ghost === "" || root.collabMutating
                || ["start", "stop"].indexOf(action) < 0) return;
        const sessionId = root.ensureSession(ghost);
        if (root.collabRequest && root.collabRequest.readyState !== 4)
            root.collabRequest.abort();
        const body = { action: action };
        const relay = relayUrl.trim();
        if (action === "start") {
            body.writable = writable;
            body.confirmed = true;
            if (relay !== "") body.relayUrl = relay;
        }
        const xhr = new XMLHttpRequest();
        root.collabRequest = xhr;
        root.collabMutating = true;
        root.collabError = "";
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.collabRequest) return;
            root.collabMutating = false;
            if (ghost !== root.activeGhost || sessionId !== root.currentSessionId) return;
            if (xhr.status === 200 || xhr.status === 201) {
                try {
                    if (!root.applyCollabStatus(JSON.parse(xhr.responseText), ghost, sessionId))
                        throw new Error("invalid status");
                    root.collabError = "";
                    root.reachable = true;
                    root.collabActionFinished(action, writable, true);
                } catch (error) {
                    root.collabError = "ghostd sent malformed collaboration status";
                    root.collabActionFinished(action, writable, false);
                }
            } else if (root.errorCode(xhr) === "not_supported") {
                root.collabNotSupported = true;
                root.collabStatus = ({
                    supported: false,
                    code: "not_supported",
                    message: root.errorDetail(xhr)
                });
                root.collabError = "";
                root.collabActionFinished(action, writable, false);
            } else {
                root.collabError = root.describeError(xhr, "POST collaboration");
                root.collabActionFinished(action, writable, false);
            }
        };
        root.dispatch(xhr, "POST", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(sessionId) + "/collab",
            ({ "Content-Type": "application/json" }),
            JSON.stringify(body));
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

    /** Keep one authenticated SSE invalidation stream attached to the active ghost. */
    function connectConversationEvents(ghost: string): void {
        const previous = root.eventsRequest;
        if (previous && previous.readyState !== 4) {
            if (root.eventsGhost === ghost) return;
            root.eventsRequest = null;
            previous.onreadystatechange = function () {};
            previous.abort();
        }
        eventsWatchdog.stop();
        eventsReconnect.stop();
        root.eventsGhost = ghost;
        root.eventsConsumed = 0;
        root.eventsFrameBuffer = "";
        if (ghost === "") return;
        const xhr = new XMLHttpRequest();
        root.eventsRequest = xhr;
        xhr.onreadystatechange = function () {
            root.readConversationEvents(xhr, ghost);
        };
        eventsWatchdog.restart();
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/events", ({ "Accept": "text/event-stream" }), null);
    }

    function readConversationEvents(xhr: var, ghost: string): void {
        if (xhr !== root.eventsRequest) return;
        if (xhr.readyState >= 3 && xhr.status === 200) {
            const whole = xhr.responseText;
            if (whole.length > root.eventsConsumed) {
                const connected = root.eventsConsumed === 0;
                eventsWatchdog.restart();
                root.reachable = true;
                root.ingestConversationEvents(whole.substring(root.eventsConsumed), ghost);
                root.eventsConsumed = whole.length;
                // The stream carries invalidations rather than history. A
                // reconnect closes the only possible missed-event window.
                if (connected && ghost === root.activeGhost) root.fetchSessions(ghost);
            }
        }
        if (xhr.readyState !== 4 || xhr !== root.eventsRequest) return;
        root.eventsRequest = null;
        eventsWatchdog.stop();
        if (ghost === root.activeGhost) eventsReconnect.restart();
    }

    function ingestConversationEvents(chunk: string, ghost: string): void {
        root.eventsFrameBuffer += chunk.replace(/\r\n/gu, "\n");
        const frames = root.eventsFrameBuffer.split("\n\n");
        root.eventsFrameBuffer = frames.pop();
        for (const frame of frames) {
            const line = frame.split("\n").find(value => value.startsWith("data:"));
            if (!line) continue;
            try {
                const event = JSON.parse(line.slice(5).trim());
                if (event.type === "conversation-updated" && typeof event.id === "string"
                        && (event.runtime === "pi" || event.runtime === "claude-code")
                        && typeof event.conversationId === "string"
                        && event.id === root.conversationActionId(
                            event.runtime, event.conversationId)
                        && ghost === root.activeGhost)
                    root.fetchSessions(ghost);
            } catch (error) {
                console.warn("ghost: unparseable conversation event:", line);
            }
        }
    }

    function expireConversationEvents(): void {
        const xhr = root.eventsRequest;
        root.eventsRequest = null;
        eventsWatchdog.stop();
        if (xhr && xhr.readyState !== 4) {
            xhr.onreadystatechange = function () {};
            xhr.abort();
        }
        if (root.activeGhost !== "") eventsReconnect.restart();
    }

    function mergeSessionListing(ghost: string, list: var): var {
        const ids = new Set(list.map(function (session) { return session.id; }));
        const localLive = root.sessions.filter(function (session) {
            return session && session.localOnly === true && !ids.has(session.id)
                && root.isConversationStreaming(ghost, session.id);
        });
        return root.orderSessions(list.concat(localLive));
    }

    function validSessionRows(list: var): var {
        return list.filter(function (session) {
            return session && typeof session.id === "string"
                && (session.runtime === "pi" || session.runtime === "claude-code")
                && typeof session.conversationId === "string"
                && session.conversationId !== ""
                && session.id === root.conversationActionId(
                    session.runtime, session.conversationId);
        });
    }

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
            if (xhr.readyState !== 4 || xhr !== root.sessionsRequest) return;
            // A reply for a ghost the user has since switched away from is stale.
            if (g !== root.activeGhost) return;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    // Contract is { sessions: [...] }; tolerate a bare array too.
                    const list = Array.isArray(body) ? body
                        : (Array.isArray(body.sessions) ? body.sessions : []);
                    root.sessions = root.mergeSessionListing(g, root.validSessionRows(list));
                    root.sessionsError = "";
                    const current = root.sessions.find(function (session) {
                        return session && session.id === root.currentSessionId;
                    });
                    if (root.hudVisible && current && current.unread === true)
                        root.markConversationRead(g, current.id);
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
        const previous = root.activeTurnState(false);
        if (previous) {
            root.captureActiveTurn(previous);
            root.cancelTranscriptLoad(previous);
        }
        const conversationId = "hud-" + Date.now().toString(36)
            + "-" + Math.floor(Math.random() * 0xffffff).toString(36);
        const runtime = root.runtimeForNewConversation();
        const id = root.conversationActionId(runtime, conversationId);
        root.sessionIds[ghost] = id;
        root.currentSessionId = id;
        root.ensureTurnState(ghost, id, conversationId, runtime);
        root.showTurnState(ghost, id);
        root.clearCommands();
        root.clearConnect();
        // A blank chat is back on screen, so it earns a fresh opening line.
        root.clearGreeting();
        root.fetchGreeting();
    }

    /** Keep a lazily-created live conversation navigable until ghostd lists it. */
    function ensureOptimisticSessionRow(ghost: string, id: string): void {
        if (ghost !== root.activeGhost || root.sessions.some(function (session) {
            return session && session.id === id;
        })) return;
        const identity = root.conversationIdentity(id);
        if (!identity) return;
        const now = new Date().toISOString();
        root.sessions = root.orderSessions(root.sessions.concat([{
            id: id,
            conversationId: identity.conversationId,
            runtime: identity.runtime,
            title: null,
            createdAt: now,
            updatedAt: now,
            messageCount: 1,
            pinned: false,
            unread: false,
            localOnly: true
        }]));
    }

    /** Move one stored conversation's Ghost-owned artifacts to Trash. */
    function deleteConversation(id: string): void {
        const ghost = root.activeGhost;
        if (ghost === "" || id === "" || root.deletingSessionId !== "") return;
        if (root.isConversationStreaming(ghost, id)) {
            root.sessionsError = "Cancel the current answer before deleting this conversation";
            return;
        }
        root.deletingSessionId = id;
        root.sessionsError = "";
        const xhr = root.deleteSessionRequestFactory
            ? root.deleteSessionRequestFactory() : new XMLHttpRequest();
        root.deleteSessionRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.deleteSessionRequest) return;
            root.deletingSessionId = "";
            if (xhr.status === 200) {
                root.dropCommandTranscripts(ghost, id);
                const key = root.conversationKey(ghost, id);
                const kept = Object.assign({}, root.turnStates);
                root.cancelTranscriptLoad(kept[key]);
                delete kept[key];
                root.turnStates = kept;
                root.updateLiveConversationKeys();
                if (ghost === root.activeGhost) {
                    root.sessions = root.sessions.filter(function (session) {
                        return session.id !== id;
                    });
                    if (root.currentSessionId === id) {
                        root.sessionIds[ghost] = "";
                        root.currentSessionId = "";
                        root.clearTurnProjection();
                        root.clearCommands();
                        root.clearConnect();
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

    /**
     * Rename one conversation. A title is a name, not a field that can be
     * emptied: there is no "clear it" here, so an empty edit never reaches the
     * daemon and the caller keeps what the row already had.
     *
     * Optimistic like the pin, and for a sharper reason: the owner has just
     * typed this into the row itself, so a label that only settles after a
     * round trip reads as the edit not having taken. A refusal puts the old
     * title back and lands in `sessionsError`, which renders at the foot of the
     * very list the row is in.
     */
    function renameConversation(id: string, title: string): void {
        const ghost = root.activeGhost;
        const next = title.trim();
        if (ghost === "" || id === "" || next === "") return;
        const row = root.sessions.find(function (session) {
            return session && session.id === id;
        });
        if (!row) return;
        const previous = typeof row.title === "string" ? row.title : null;
        if (previous === next) return;
        root.sessionsError = "";
        root.applySessionTitle(id, next);
        const xhr = new XMLHttpRequest();
        root.renameSessionRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.renameSessionRequest) return;
            if (ghost !== root.activeGhost) return;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    // The daemon has the last word on the title it wrote.
                    if (body.title === null || typeof body.title === "string")
                        root.applySessionTitle(id, body.title || null);
                } catch (error) {
                    // The write landed; only the echo was unreadable, and the
                    // optimistic row already says what was sent.
                }
                return;
            }
            root.applySessionTitle(id, previous);
            const detail = root.errorDetail(xhr);
            root.sessionsError = detail !== ""
                ? detail
                : root.describeError(xhr, "PUT conversation title");
        };
        root.dispatch(xhr, "PUT", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(id) + "/title",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ title: next }));
    }

    /** Swap one row's title. A fresh row object, or nothing re-reads it. */
    function applySessionTitle(id: string, title: var): void {
        root.sessions = root.sessions.map(function (session) {
            return session && session.id === id
                ? Object.assign({}, session, { title: title })
                : session;
        });
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
        const previous = root.activeTurnState(false);
        if (previous) {
            root.captureActiveTurn(previous);
            if (previous.sessionId !== id) root.cancelTranscriptLoad(previous);
        }
        root.sessionIds[ghost] = id;
        root.currentSessionId = id;
        root.showTurnState(ghost, id);
        root.clearCommands();
        root.clearConnect();
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
        // Clicking the selected title is navigation, not an interrupt button.
        // In particular it must not abort the XHR and then report that
        // client-initiated abort as ghostd becoming unreachable.
        if (id === root.currentSessionId && root.streaming) return;
        root.adoptConversation(ghost, id);
        root.markConversationRead(ghost, id);
        const state = root.ensureTurnState(ghost, id);
        if (state.streaming) return;
        root.loadConversationTranscript(state, true);
    }

    /** Persist that the owner opened a stored conversation. */
    function markConversationRead(ghost: string, id: string): void {
        if (ghost === "" || id === "") return;
        const local = ghost === root.activeGhost ? root.sessions.find(function (session) {
            return session && session.id === id;
        }) : null;
        if (ghost === root.activeGhost) {
            root.sessions = root.sessions.map(function (session) {
                return session && session.id === id
                    ? Object.assign({}, session, { unread: false }) : session;
            });
        }
        // The daemon creates a new conversation lazily inside its first turn.
        // The completion path marks it again after the persisted row arrives.
        if (local && local.localOnly === true) return;
        const key = root.commandTranscriptKey(ghost, id);
        const xhr = new XMLHttpRequest();
        const held = Object.assign({}, root.readSessionRequests);
        held[key] = xhr;
        root.readSessionRequests = held;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || root.readSessionRequests[key] !== xhr) return;
            const remaining = Object.assign({}, root.readSessionRequests);
            delete remaining[key];
            root.readSessionRequests = remaining;
            if (ghost !== root.activeGhost) return;
            if (xhr.status !== 200) root.fetchSessions(ghost);
        };
        root.dispatch(xhr, "PUT", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(id) + "/read",
            ({ "Content-Type": "application/json" }), JSON.stringify({}));
    }

    function markCurrentConversationRead(): void {
        if (!root.hudVisible || root.activeGhost === "" || root.currentSessionId === "") return;
        root.markConversationRead(root.activeGhost, root.currentSessionId);
    }

    /** Refresh the persisted entry ids a live turn could not know yet. */
    function refreshCurrentTranscript(): void {
        const state = root.activeTurnState(false);
        if (!state || state.streaming) return;
        root.refreshConversationTranscript(state);
    }

    function refreshConversationTranscript(state: var): void {
        if (!state || state.streaming) return;
        root.loadConversationTranscript(state, false);
    }

    function newTranscriptRequest(): var {
        return root.transcriptRequestFactory
            ? root.transcriptRequestFactory() : new XMLHttpRequest();
    }

    function newBranchRequest(): var {
        return root.branchRequestFactory
            ? root.branchRequestFactory() : new XMLHttpRequest();
    }

    function transcriptLoadIsCurrent(state: var, load: var, xhr: var): bool {
        return !!state && !!load && state.transcriptLoad === load
            && state.transcriptGeneration === load.generation
            && state.transcriptRequest === xhr && !state.streaming;
    }

    /**
     * Read a complete transcript through the daemon's bounded page API. The
     * previous visible rows stay intact until every page has been validated,
     * so a failed or inconsistent read is visible as an error, never as a
     * convincing partial history.
     */
    function loadConversationTranscript(state: var, allowNotFound: bool): void {
        if (!state || state.streaming) return;
        root.cancelTranscriptLoad(state);
        const load = {
            generation: state.transcriptGeneration,
            allowNotFound: allowNotFound,
            total: -1,
            nextOffset: 0,
            pageCount: 0,
            messages: [],
            entryIds: new Set()
        };
        state.transcriptLoad = load;
        root.requestTranscriptPage(state, load);
    }

    function failTranscriptLoad(state: var, load: var, message: string, unreachable: bool): void {
        if (!state || state.transcriptLoad !== load
                || state.transcriptGeneration !== load.generation) return;
        state.transcriptRequest = null;
        state.transcriptLoad = null;
        if (!root.isActiveTurn(state)) return;
        root.transcriptRequest = null;
        root.sessionsError = message;
        if (unreachable) root.fail(message);
    }

    function completeTranscriptLoad(state: var, load: var): void {
        if (!state || state.transcriptLoad !== load
                || state.transcriptGeneration !== load.generation || state.streaming) return;
        state.transcriptRequest = null;
        state.transcriptLoad = null;
        root.rehydrateTurn(state, load.messages);
        root.reachable = true;
        if (root.isActiveTurn(state)) {
            root.transcriptRequest = null;
            root.sessionsError = "";
        }
    }

    function requestTranscriptPage(state: var, load: var): void {
        if (!state || state.transcriptLoad !== load
                || state.transcriptGeneration !== load.generation || state.streaming) return;
        if (load.pageCount >= root.transcriptMaxPages) {
            root.failTranscriptLoad(state, load,
                "Transcript is too large to load safely", false);
            return;
        }
        const requestedOffset = load.nextOffset;
        const xhr = root.newTranscriptRequest();
        load.pageCount += 1;
        state.transcriptRequest = xhr;
        if (root.isActiveTurn(state)) root.transcriptRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || !root.transcriptLoadIsCurrent(state, load, xhr)) return;
            if (xhr.status === 404 && requestedOffset === 0 && load.allowNotFound) {
                load.messages = [];
                root.completeTranscriptLoad(state, load);
                return;
            }
            if (xhr.status !== 200) {
                const message = root.describeError(xhr, "GET transcript");
                root.failTranscriptLoad(state, load, message, xhr.status === 0);
                return;
            }
            try {
                const body = JSON.parse(xhr.responseText);
                if (!root.transcriptMatchesIdentity(body, state))
                    throw new Error("transcript identity mismatch");
                if (typeof body.total !== "number" || !Number.isFinite(body.total)
                        || Math.floor(body.total) !== body.total || body.total < 0)
                    throw new Error("invalid transcript total");
                if (body.total > root.transcriptPageLimit * root.transcriptMaxPages)
                    throw new Error("transcript exceeds client cap");
                if (typeof body.truncated !== "boolean")
                    throw new Error("invalid transcript truncation marker");
                if (load.total < 0) load.total = body.total;
                else if (load.total !== body.total)
                    throw new Error("transcript changed between pages");
                const expected = Math.min(root.transcriptPageLimit,
                    load.total - requestedOffset);
                if (expected < 0 || body.messages.length !== expected)
                    throw new Error("inconsistent transcript page length");
                const truncated = requestedOffset > 0
                    || requestedOffset + body.messages.length < load.total;
                if (body.truncated !== truncated)
                    throw new Error("inconsistent transcript truncation marker");
                for (const message of body.messages) {
                    if (!message || typeof message.entryId !== "string"
                            || message.entryId === "" || load.entryIds.has(message.entryId))
                        throw new Error("invalid or repeated transcript entry id");
                    load.entryIds.add(message.entryId);
                }
                load.messages = load.messages.concat(body.messages);
                load.nextOffset = requestedOffset + body.messages.length;
                if (load.nextOffset === load.total) {
                    root.completeTranscriptLoad(state, load);
                    return;
                }
                if (body.messages.length === 0 || load.nextOffset <= requestedOffset)
                    throw new Error("transcript page made no progress");
                root.requestTranscriptPage(state, load);
            } catch (error) {
                root.failTranscriptLoad(state, load,
                    String(error).indexOf("exceeds client cap") >= 0
                        ? "Transcript is too large to load safely"
                        : "ghostd sent an inconsistent transcript page", false);
            }
        };
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(state.ghost)
            + "/sessions/" + encodeURIComponent(state.sessionId) + "/transcript"
            + "?limit=" + root.transcriptPageLimit + "&offset=" + requestedOffset,
            ({}), null, function () {
                return root.transcriptLoadIsCurrent(state, load, xhr);
            });
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
        const state = root.activeTurnState(true);
        if (state) root.rehydrateTurn(state, messages);
    }

    function rehydrateTurn(state: var, messages: var): void {
        state.activity = "";
        state.statusText = "";
        const storedRows = TurnBlocks.rows(messages);
        state.hydratedRowCount = storedRows.length;
        const rows = CommandTranscript.merge(storedRows, root.commandExchangesFor(state));
        const hydrated = [];
        for (const row of rows) {
            hydrated.push({
                role: row.role,
                text: row.text,
                tools: "",
                toolActivity: row.role === "assistant"
                    ? root.messageTools({ content: row.parts }) : [],
                error: row.error || "",
                pending: false,
                entryId: row.entryId
            });
        }
        root.replaceTurnRows(state, hydrated);
        root.projectTurnFields(state);
    }

    function commandTranscriptKey(ghost: string, sessionId: string): string {
        return ghost + "\n" + sessionId;
    }

    function dropCommandTranscripts(ghost: string, sessionId: string): void {
        const prefix = ghost + "\n";
        const exact = root.commandTranscriptKey(ghost, sessionId);
        const next = ({});
        for (const key of Object.keys(root.commandExchanges)) {
            if (sessionId !== "" ? key === exact : key.startsWith(prefix)) continue;
            next[key] = root.commandExchanges[key];
        }
        root.commandExchanges = next;
    }

    function currentCommandExchanges(): var {
        const state = root.activeTurnState(false);
        return state ? root.commandExchangesFor(state) : [];
    }

    function commandExchangesFor(state: var): var {
        const key = root.commandTranscriptKey(state.ghost, state.sessionId);
        return Array.isArray(root.commandExchanges[key]) ? root.commandExchanges[key] : [];
    }

    /** Keep every command_output frame in the current presentation exchange. */
    function receiveCommandOutput(event: var): void {
        const state = root.activeTurnState(false);
        if (!state) return;
        root.captureActiveTurn(state);
        root.receiveCommandOutputFor(state, event);
    }

    function receiveCommandOutputFor(state: var, event: var): void {
        if (state.assistantRow < 0 || state.assistantRow >= state.rows.length) return;
        const key = root.commandTranscriptKey(state.ghost, state.sessionId);
        if (key === "\n") return;
        let exchanges = Array.isArray(root.commandExchanges[key])
            ? root.commandExchanges[key].slice() : [];
        let previous = null;
        if (state.commandTurnKey === key && state.commandTurnIndex >= 0
                && state.commandTurnIndex < exchanges.length)
            previous = exchanges[state.commandTurnIndex];
        else {
            state.commandTurnKey = key;
            state.commandTurnIndex = exchanges.length;
        }
        const promptRow = state.assistantRow > 0
            ? state.rows[state.assistantRow - 1] : null;
        const prompt = promptRow && promptRow.role === "user" ? promptRow.text : event.command;
        const exchange = CommandTranscript.append(
            previous, event, prompt, state.commandTurnAnchor);
        if (state.commandTurnIndex === exchanges.length) exchanges.push(exchange);
        else exchanges[state.commandTurnIndex] = exchange;
        const next = Object.assign({}, root.commandExchanges);
        next[key] = exchanges;
        root.commandExchanges = next;

        root.setTurnRow(state, state.assistantRow, "role", "command");
        root.setTurnRow(state, state.assistantRow, "text", exchange.output);
        root.setTurnRow(state, state.assistantRow, "error", CommandTranscript.failure(exchange));
        root.projectTurnFields(state);
    }

    /**
     * How a restored call turned out, however the runtime marked it. The
     * daemon writes a per-call failure marker on the persisted `toolCall`;
     * older transcripts carry none, and a call nobody flagged did finish.
     */
    function restoredToolStatus(part: var): string {
        return part.failed === true || part.isError === true
            || part.status === "failed" ? "failed" : "complete";
    }

    /** Recover tool cards from an assistant message on transcript load. */
    function messageTools(message: var): var {
        if (!Array.isArray(message.content)) return [];
        return message.content
            .filter(part => part && part.type === "toolCall")
            .map(part => ({
                id: part.id || ("history-" + Math.random()),
                name: part.name || "tool",
                // Reading every restored call as complete quietly healed the
                // failures: Bubble keeps a failed call in the reading column
                // on purpose — a silent one is how a confidently wrong answer
                // gets believed — and a reload folded it behind the "N steps"
                // toggle with the ordinary ones.
                status: root.restoredToolStatus(part),
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
        const xhr = root.newBranchRequest();
        root.branchRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.branchRequest) return;
            // A branch of a conversation the user has since left is not theirs.
            if (ghost !== root.activeGhost || sessionId !== root.currentSessionId) return;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    const branched = typeof body.id === "string" ? body.id : "";
                    if (branched === "" || body.runtime !== "pi"
                            || typeof body.conversationId !== "string"
                            || body.conversationId === ""
                            || branched !== root.conversationActionId(
                                body.runtime, body.conversationId)
                            || body.sessionId !== body.conversationId
                            || !body.transcript
                            || body.transcript.id !== branched
                            || body.transcript.conversationId !== body.conversationId
                            || body.transcript.runtime !== body.runtime
                            || !Array.isArray(body.transcript.messages)) {
                        root.branchError = "ghostd branched into no conversation";
                        return;
                    }
                    const state = root.ensureTurnState(
                        ghost, branched, body.conversationId, body.runtime);
                    if (!state) {
                        root.branchError = "ghostd branched into no conversation";
                        return;
                    }
                    root.adoptConversation(ghost, branched);
                    // POST carries the daemon's default transcript page, which may
                    // omit a deep branch's tail. Publish only the bounded pager's
                    // fully validated assembly so branching and reopening have the
                    // same complete-history semantics.
                    root.loadConversationTranscript(state, false);
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
        const state = root.ensureTurnState(ghost, sessionId);
        root.captureActiveTurn(state);
        root.beginTurnFor(state);

        const xhr = new XMLHttpRequest();
        state.request = xhr;
        root.projectTurnFields(state);
        xhr.onreadystatechange = function () {
            root.readTurnStream(xhr, state.key,
                "re-answer ask", "the re-answer stream ended mid-turn");
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
        const ghost = root.activeGhost;
        let sessionId = root.ensureSession(ghost);
        let state = root.ensureTurnState(ghost, sessionId);
        if (state && state.runtime !== root.runtimeForNewConversation()) {
            state = root.adoptConversationRuntime(ghost, root.runtimeForNewConversation());
            sessionId = state ? state.sessionId : "";
        }
        if (!state || sessionId === "") return;
        root.ensureOptimisticSessionRow(ghost, sessionId);
        root.captureActiveTurn(state);
        // A completed model turn can be visible a tick before its transcript
        // refresh lands. Count that live pair too, while excluding the
        // presentation-only command pairs already in the model.
        const commandAnchor = Math.max(state.hydratedRowCount,
            state.rows.length - root.commandExchangesFor(state).length * 2);

        root.beginTurnFor(state);
        root.appendTurnRow(state, {
            role: "user", text: prompt, tools: "", toolActivity: [], error: "", pending: false,
            entryId: ""
        });
        root.appendTurnRow(state, {
            role: "assistant", text: "", tools: "", toolActivity: [], error: "", pending: true,
            entryId: ""
        });
        state.assistantRow = state.rows.length - 1;
        state.commandTurnKey = "";
        state.commandTurnIndex = -1;
        state.commandTurnAnchor = commandAnchor;
        root.projectTurnFields(state);
        // The conversation has messages now; the opening line has been answered.
        root.clearGreeting();

        const xhr = new XMLHttpRequest();
        state.request = xhr;
        root.projectTurnFields(state);
        xhr.onreadystatechange = function () {
            root.readTurnStream(xhr, state.key,
                "POST /api/ghosts/" + ghost + "/messages",
                "the stream ended mid-turn");
        };
        root.dispatch(xhr, "POST",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/messages",
            ({ "Content-Type": "application/json", "Accept": "text/event-stream" }),
            JSON.stringify(root.buildBody(ghost, prompt, state)));
    }

    function cancel(): void {
        const state = root.activeTurnState(false);
        if (!state) return;
        root.captureActiveTurn(state);
        root.cancelTurn(state);
    }

    function cancelTurn(state: var): void {
        const xhr = state.request;
        // Retire the callback before abort(), because Qt may synchronously run
        // readyState 4 from inside abort(). That is our cancellation, not a
        // transport failure and not evidence that ghostd is unreachable.
        state.request = null;
        state.streaming = false;
        root.settleToolActivityFor(state, true);
        root.flushTurn(state, true, false);
        root.resetInteractionStateFor(state);
        if (state.assistantRow >= 0 && state.assistantRow < state.rows.length) {
            root.setTurnRow(state, state.assistantRow, "pending", false);
            if (state.rows[state.assistantRow].text === "")
                root.setTurnRow(state, state.assistantRow, "error", "cancelled");
        }
        state.assistantRow = -1;
        root.updateLiveConversationKeys();
        root.projectTurnFields(state);
        if (xhr && xhr.readyState !== 4) xhr.abort();
    }

    /** Shared initialization for ordinary turns and streamed ask re-answers. */
    function beginTurn(): void {
        const ghost = root.activeGhost;
        if (ghost === "") return;
        const state = root.ensureTurnState(ghost, root.ensureSession(ghost));
        root.captureActiveTurn(state);
        root.beginTurnFor(state);
    }

    function beginTurnFor(state: var): void {
        root.clearRecap();
        root.cancelTranscriptLoad(state);
        root.resetAssistantSegmentFor(state);
        state.assistantRow = -1;
        state.consumed = 0;
        state.frameBuffer = "";
        root.resetInteractionStateFor(state);
        state.activity = "waiting for ghostd";
        state.lastError = "";
        state.streaming = true;
        state.lastStreamActivity = Date.now();
        root.updateLiveConversationKeys();
        root.projectTurnFields(state);
    }

    /** Fields scoped to the assistant segment between two owner messages. */
    function resetAssistantSegment(): void {
        const state = root.activeTurnState(true);
        if (state) root.resetAssistantSegmentFor(state);
    }

    function resetAssistantSegmentFor(state: var): void {
        state.blocks = ({});
        state.toolNames = [];
        state.toolActivities = [];
        state.toolIdsByContent = ({});
        state.presentationDirty = true;
        root.projectTurnFields(state);
    }

    /** The dialog and submission state belonging to one OMP ask interaction. */
    function resetAskState(): void {
        const state = root.activeTurnState(true);
        if (state) root.resetAskStateFor(state);
    }

    function resetAskStateFor(state: var): void {
        state.pendingAsk = null;
        state.askSubmitting = false;
        state.askError = "";
        root.projectTurnFields(state);
    }

    /** The interaction fields every terminal/cancel path must clear together. */
    function resetInteractionState(): void {
        const state = root.activeTurnState(true);
        if (state) root.resetInteractionStateFor(state);
    }

    function resetInteractionStateFor(state: var): void {
        state.statusText = "";
        state.activity = "";
        root.resetAskStateFor(state);
        state.steeringQueue = [];
        state.followUpQueue = [];
        state.queueSubmitting = false;
        state.queueError = "";
        root.projectTurnFields(state);
    }

    /** Consume the cumulative Qt XHR body and settle every readyState-4 path. */
    function readStream(xhr: var, ghost: string, requestName: string,
            missingTerminal: string): void {
        const state = root.compatibilityTurnState();
        if (!state || state.ghost !== ghost) return;
        root.captureTurnProjection(state);
        root.readTurnStream(xhr, state.key, requestName, missingTerminal);
        root.projectTurnRows(state);
        root.projectTurnProjection(state);
    }

    function readTurnStream(xhr: var, key: string, requestName: string,
            missingTerminal: string): void {
        const state = root.turnStates[key];
        if (!state || xhr !== state.request) return;
        if (xhr.readyState >= 3 && xhr.status === 200) {
            const whole = xhr.responseText;
            if (whole.length > state.consumed) {
                // Events and keepalive comments both prove this connection is live.
                state.lastStreamActivity = Date.now();
                root.reachable = true;
                state.lastError = "";
                root.ingestTurn(state, whole.substring(state.consumed));
                state.consumed = whole.length;
            }
        }
        if (xhr.readyState !== 4 || xhr !== state.request) {
            root.projectTurnFields(state);
            return;
        }
        if (xhr.status !== 200) {
            if (xhr.status === 0) root.reachable = false;
            root.endTurnState(state, root.describeError(xhr, requestName));
        } else if (state.streaming) {
            root.endTurnState(state, missingTerminal);
        }
        if (xhr === state.request) state.request = null;
        root.projectTurnFields(state);
    }

    /** A half-open SSE response missed three daemon keepalives. */
    function expireStream(): void {
        const state = root.compatibilityTurnState();
        if (!state) return;
        root.captureTurnProjection(state);
        root.expireTurnStream(state);
        root.projectTurnRows(state);
        root.projectTurnProjection(state);
    }

    function expireTurnStream(state: var): void {
        if (!state.streaming) return;
        const xhr = state.request;
        state.request = null;
        root.reachable = false;
        root.endTurnState(state, "the stream stopped responding");
        if (xhr && xhr.readyState !== 4) xhr.abort();
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
    function buildBody(ghost: string, prompt: string, turnState: var): var {
        const sessionId = turnState ? turnState.sessionId : root.ensureSession(ghost);
        const state = turnState || root.ensureTurnState(ghost, sessionId);
        const messages = [];
        if (Quickshell.env("GHOST_HUD_REPLAY")) {
            for (let i = 0; i < state.rows.length - 1; i++) {
                const row = state.rows[i];
                const next = i + 1 < state.rows.length ? state.rows[i + 1] : null;
                // Presentation-only builtins must not come back as ordinary
                // user/assistant context when the diagnostic replay mode is on.
                if (row.role === "command"
                        || (row.role === "user" && next && next.role === "command"))
                    continue;
                if (row.text === "") continue;
                messages.push({ role: row.role, content: row.text, timestamp: Date.now() });
            }
        } else {
            messages.push({ role: "user", content: prompt, timestamp: Date.now() });
        }
        return {
            model: "ghost/" + ghost,
            context: { messages: messages },
            options: { sessionId: state.conversationId }
        };
    }

    /**
     * The active session id for a ghost, minting one on first use. A conversation
     * is created lazily by the daemon on the first turn; until then it lives only
     * as this id, which `options.sessionId` carries into the POST.
     */
    function ensureSession(ghost: string): string {
        if (!root.sessionIds[ghost]) {
            const conversationId = "hud-" + Date.now().toString(36)
                + "-" + Math.floor(Math.random() * 0xffffff).toString(36);
            const runtime = root.runtimeForNewConversation();
            root.sessionIds[ghost] = root.conversationActionId(runtime, conversationId);
            root.ensureTurnState(ghost, root.sessionIds[ghost], conversationId, runtime);
        }
        if (ghost === root.activeGhost) root.currentSessionId = root.sessionIds[ghost];
        root.ensureTurnState(ghost, root.sessionIds[ghost]);
        return root.sessionIds[ghost];
    }

    // ---- SSE --------------------------------------------------------------

    /**
     * Feed a raw chunk of the response body. Chunk boundaries are network
     * boundaries, never frame boundaries, so the trailing partial frame is
     * carried over to the next call.
     */
    function ingest(chunk: string): void {
        const state = root.activeTurnState(false);
        if (!state) return;
        root.captureActiveTurn(state);
        root.ingestTurn(state, chunk);
    }

    function ingestTurn(state: var, chunk: string): void {
        if (chunk === "") return;
        state.frameBuffer += chunk.replace(/\r\n/gu, "\n");
        const frames = state.frameBuffer.split("\n\n");
        state.frameBuffer = frames.pop();
        for (const frame of frames) {
            // Keepalives are bare `: comment` frames with no data line.
            const line = frame.split("\n").find(l => l.startsWith("data:"));
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") continue;
            try {
                root.handleTurnEvent(state, JSON.parse(payload));
            } catch (error) {
                console.warn("ghost: unparseable SSE frame:", payload);
            }
        }
    }

    function handleEvent(event: var): void {
        const state = root.compatibilityTurnState();
        if (!state) return;
        root.captureTurnProjection(state);
        root.handleTurnEvent(state, event);
        root.projectTurnRows(state);
        root.projectTurnProjection(state);
    }

    function handleTurnEvent(state: var, event: var): void {
        switch (event.type) {
        case "start":
            state.activity = "";
            break;
        case "command_output":
            root.receiveCommandOutputFor(state, event);
            break;
        case "text_start":
            state.blocks[event.contentIndex] = { kind: "text", text: "" };
            state.presentationDirty = true;
            state.activity = "";
            break;
        case "text_delta":
            if (!state.blocks[event.contentIndex])
                state.blocks[event.contentIndex] = { kind: "text", text: "" };
            state.blocks[event.contentIndex].text += event.delta;
            state.presentationDirty = true;
            break;
        case "text_end":
            state.blocks[event.contentIndex] = { kind: "text", text: event.content };
            state.presentationDirty = true;
            break;
        case "owner_message":
            root.receiveOwnerMessageFor(state, event.text || "");
            break;
        case "thinking_start":
            state.activity = "thinking";
            break;
        case "thinking_delta":
        case "thinking_end":
            // Reasoning stays out of the transcript in v1; the activity line
            // is the only signal that it happened.
            break;
        case "toolcall_start":
            state.activity = event.toolName;
            state.toolNames = state.toolNames.concat([event.toolName]);
            state.presentationDirty = true;
            state.toolIdsByContent[event.contentIndex] = event.id;
            root.updateToolFor(state, event.id, {
                name: event.toolName,
                status: "preparing",
                arguments: ({}),
                summary: "",
                intent: ""
            });
            if (event.toolName === "ask") Qt.callLater(function () {
                root.fetchPendingAskFor(state);
            });
            break;
        case "toolcall_delta":
            break;
        case "toolcall_end":
            state.activity = "";
            root.updateToolFor(state, event.toolCall.id, {
                name: event.toolCall.name,
                status: "queued",
                arguments: event.toolCall.arguments || ({}),
                summary: "",
                intent: ""
            });
            root.resetAskStateFor(state);
            break;
        case "tool_execution_start":
            state.activity = event.toolName;
            root.updateToolFor(state, event.id, {
                name: event.toolName,
                status: "running",
                arguments: event.arguments || ({}),
                intent: event.intent || ""
            });
            if (event.toolName === "ask") Qt.callLater(function () {
                root.fetchPendingAskFor(state);
            });
            break;
        case "tool_execution_update":
            root.updateToolFor(state, event.id, {
                name: event.toolName,
                status: "running",
                summary: event.summary || ""
            });
            break;
        case "tool_execution_end":
            state.activity = "";
            root.updateToolFor(state, event.id, {
                name: event.toolName,
                status: event.isError ? "failed" : "complete",
                summary: event.summary || ""
            });
            // An ask can settle by its timeout as well as by this shell's POST.
            // The SSE event is authoritative in both cases; do not leave a
            // stale dialog over the resumed assistant response until `done`.
            if (event.toolName === "ask") {
                root.resetAskStateFor(state);
            }
            break;
        case "model_fallback":
            state.activity = event.phase === "applied"
                ? "switching model · " + event.to
                : "using fallback · " + event.model;
            break;
        case "branch_changed":
            if (!root.transcriptMatchesIdentity(event.transcript, state)) {
                root.endTurnState(state, "ghostd sent mismatched branch state");
                break;
            }
            root.rehydrateTurn(state, event.transcript.messages);
            root.appendTurnRow(state, {
                role: "assistant", text: "", tools: "", toolActivity: [], error: "", pending: true,
                entryId: ""
            });
            state.assistantRow = state.rows.length - 1;
            root.resetAssistantSegmentFor(state);
            state.activity = "";
            state.statusText = "";
            break;
        case "done":
            root.endTurnState(state, "");
            break;
        case "error":
            root.endTurnState(state,
                event.errorMessage || ("the ghost stopped: " + event.reason));
            break;
        default:
            console.warn("ghost: unknown pi-messages event:", event.type);
        }
        root.projectTurnFields(state);
    }

    function updateTool(id: string, patch: var): void {
        const state = root.activeTurnState(false);
        if (!state) return;
        root.captureActiveTurn(state);
        root.updateToolFor(state, id, patch);
    }

    function updateToolFor(state: var, id: string, patch: var): void {
        const next = [];
        let found = false;
        for (const item of state.toolActivities) {
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
        state.toolActivities = next;
        root.syncToolActivityFor(state);
    }

    function syncToolActivity(): void {
        const state = root.activeTurnState(false);
        if (!state) return;
        root.captureActiveTurn(state);
        root.syncToolActivityFor(state);
    }

    function syncToolActivityFor(state: var): void {
        if (state.assistantRow < 0 || state.assistantRow >= state.rows.length) return;
        root.setTurnRow(state, state.assistantRow, "toolActivity", state.toolActivities);
        root.projectTurnFields(state);
    }

    function settleToolActivity(cancelled: bool): void {
        const state = root.activeTurnState(false);
        if (!state) return;
        root.captureActiveTurn(state);
        root.settleToolActivityFor(state, cancelled);
    }

    function settleToolActivityFor(state: var, cancelled: bool): void {
        const next = [];
        for (const item of state.toolActivities) {
            next.push(item.status === "failed" || item.status === "complete"
                ? item : Object.assign({}, item, cancelled
                    ? { status: "failed", summary: item.summary || "Cancelled" }
                    : { status: "complete" }));
        }
        state.toolActivities = next;
        root.syncToolActivityFor(state);
    }

    /** Push buffered block text into the model. Cheap when nothing changed. */
    function flush(force: bool, segmentClosed: bool): void {
        const state = root.activeTurnState(false);
        if (!state) return;
        root.captureActiveTurn(state);
        root.flushTurn(state, force, segmentClosed);
    }

    function flushTurn(state: var, force: bool, segmentClosed: bool): void {
        if (state.assistantRow < 0 || state.assistantRow >= state.rows.length) return;
        // A builtin has no model blocks. Re-splitting an empty block buffer at
        // `done` must not erase the command_output row we just rendered.
        if (state.rows[state.assistantRow].role === "command") return;
        if (!force && !state.presentationDirty) return;
        const turn = TurnBlocks.split(
            state.blocks, Object.keys(state.toolIdsByContent),
            state.streaming && !segmentClosed);
        const row = state.rows[state.assistantRow];
        if (row.text !== turn.body)
            root.setTurnRow(state, state.assistantRow, "text", turn.body);
        if (state.statusText !== turn.status) state.statusText = turn.status;
        const tools = state.toolNames.join(", ");
        if (row.tools !== tools)
            root.setTurnRow(state, state.assistantRow, "tools", tools);
        state.presentationDirty = false;
        root.projectTurnFields(state);
    }

    function finishTurn(errorMessage: string): void {
        const state = root.activeTurnState(false);
        if (!state) return;
        root.captureActiveTurn(state);
        root.endTurnState(state, errorMessage);
    }

    function endTurn(ghost: string, errorMessage: string): void {
        const state = root.activeTurnState(false);
        if (!state || state.ghost !== ghost) return;
        root.captureActiveTurn(state);
        root.endTurnState(state, errorMessage);
    }

    function endTurnState(state: var, errorMessage: string): void {
        // The terminal event, EOF fallback, watchdog and abort can race. Only
        // the first one owns settlement and emits a terminal shell signal.
        if (!state.streaming) return;
        root.settleToolActivityFor(state, false);
        state.streaming = false;
        // Re-split now the turn is closed: a trailing block held beside the orb
        // while it might still have been a preamble is the reply after all.
        root.flushTurn(state, true, false);
        root.resetInteractionStateFor(state);
        let text = "";
        let recapEligible = false;
        if (state.assistantRow >= 0 && state.assistantRow < state.rows.length) {
            recapEligible = state.rows[state.assistantRow].role === "assistant";
            root.setTurnRow(state, state.assistantRow, "pending", false);
            if (errorMessage !== "")
                root.setTurnRow(state, state.assistantRow, "error", errorMessage);
            text = state.rows[state.assistantRow].text;
        }
        state.assistantRow = -1;
        root.updateLiveConversationKeys();
        if (errorMessage !== "") {
            state.lastError = errorMessage;
            root.turnFailed(state.ghost, errorMessage);
            if (state.ghost === root.activeGhost) Qt.callLater(function () {
                root.fetchSessions(state.ghost);
            });
        } else {
            // A turn that completed is proof the daemon answered; drop any stale
            // error banner so it does not linger under a good reply.
            state.lastError = "";
            root.turnFinished(state.ghost, text);
            if (recapEligible && root.isActiveTurn(state)) root.scheduleRecapFor(state);
        }
        root.projectTurnFields(state);
        Qt.callLater(function () {
            root.refreshConversationTranscript(state);
        });
        if (errorMessage === "" && root.hudVisible && root.isActiveTurn(state))
            root.markConversationRead(state.ghost, state.sessionId);
    }

    /** Move a dequeued steer/follow-up from QueueLine into transcript order. */
    function receiveOwnerMessage(text: string): void {
        const state = root.activeTurnState(false);
        if (!state) return;
        root.captureActiveTurn(state);
        root.receiveOwnerMessageFor(state, text);
    }

    function receiveOwnerMessageFor(state: var, text: string): void {
        const message = text.trim();
        if (!state.streaming || message === "") return;
        // The SSE event is the dequeue boundary. Move one matching chip now;
        // the 350ms queue poll remains the authority for unusual duplicates or
        // non-owner queue entries, but the ordinary row never renders twice.
        const steering = state.steeringQueue.slice();
        const steerIndex = steering.indexOf(message);
        if (steerIndex >= 0) {
            steering.splice(steerIndex, 1);
            state.steeringQueue = steering;
        } else {
            const followUp = state.followUpQueue.slice();
            const followIndex = followUp.indexOf(message);
            if (followIndex >= 0) {
                followUp.splice(followIndex, 1);
                state.followUpQueue = followUp;
            }
        }
        const hasAssistant = state.assistantRow >= 0
            && state.assistantRow < state.rows.length;
        const emptyPlaceholder = hasAssistant
            && state.assistantRow === state.rows.length - 1
            && state.rows[state.assistantRow].text === ""
            && state.toolActivities.length === 0
            && Object.keys(state.blocks).length === 0;
        if (emptyPlaceholder) {
            // OMP can dequeue a batch of owner messages before starting the
            // next provider step. Keep those as consecutive owner rows rather
            // than manufacturing a blank assistant row between each pair.
            root.removeTurnRow(state, state.assistantRow);
            state.assistantRow = -1;
        } else {
            root.settleToolActivityFor(state, false);
            // The HTTP turn continues, but this assistant segment ends where
            // the dequeued owner message enters. Its trailing prose is a reply,
            // not an in-progress status line.
            root.flushTurn(state, true, true);
            if (hasAssistant)
                root.setTurnRow(state, state.assistantRow, "pending", false);
        }
        state.statusText = "";
        state.activity = "";

        root.appendTurnRow(state, {
            role: "user", text: message, tools: "", toolActivity: [], error: "", pending: false,
            entryId: ""
        });
        root.appendTurnRow(state, {
            role: "assistant", text: "", tools: "", toolActivity: [], error: "", pending: true,
            entryId: ""
        });
        state.assistantRow = state.rows.length - 1;
        root.resetAssistantSegmentFor(state);
        root.projectTurnFields(state);
    }

    // ---- OMP ask ---------------------------------------------------------

    /** Fetch the ask payload surfaced by the live conversation, if ready. */
    function fetchPendingAsk(): void {
        const state = root.activeTurnState(false);
        if (state) root.fetchPendingAskFor(state);
    }

    function fetchPendingAskFor(state: var): void {
        if (!state.streaming || state.activity !== "ask") return;
        if (state.askRequest && state.askRequest.readyState !== 4) return;
        const xhr = new XMLHttpRequest();
        state.askRequest = xhr;
        if (root.isActiveTurn(state)) root.askRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== state.askRequest || !state.streaming) return;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    state.pendingAsk = body.ask || null;
                    state.askError = "";
                } catch (error) {
                    state.askError = "ghostd sent a malformed ask interaction";
                }
            } else {
                state.askError = root.describeError(xhr, "GET ask");
            }
            root.projectTurnFields(state);
        };
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(state.ghost)
            + "/sessions/" + encodeURIComponent(state.sessionId) + "/ask", ({}), null);
    }

    /** Submit an OMP ask result. `answer` is { kind, results? }. */
    function answerAsk(answer: var): void {
        const state = root.activeTurnState(false);
        if (!state) return;
        root.captureActiveTurn(state);
        const ask = state.pendingAsk;
        if (!ask || state.askSubmitting) return;
        state.askSubmitting = true;
        state.askError = "";
        const xhr = new XMLHttpRequest();
        state.askSubmitRequest = xhr;
        root.askSubmitRequest = xhr;
        root.projectTurnFields(state);
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== state.askSubmitRequest) return;
            if (xhr.status === 200) {
                root.resetAskStateFor(state);
            } else {
                state.askSubmitting = false;
                state.askError = root.describeError(xhr, "POST ask");
                // A stale interaction may already have advanced. Refresh once
                // so the card never remains stuck on an answer nobody can take.
                if (xhr.status === 409) root.fetchPendingAskFor(state);
            }
            root.projectTurnFields(state);
        };
        const body = Object.assign({ askId: ask.id }, answer);
        root.dispatch(xhr, "POST", "/api/ghosts/" + encodeURIComponent(state.ghost)
            + "/sessions/" + encodeURIComponent(state.sessionId) + "/ask",
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
        const state = root.activeTurnState(false);
        if (state) root.applyQueueFor(state, body);
    }

    function applyQueueFor(state: var, body: var): void {
        state.steeringQueue = Array.isArray(body.steering) ? body.steering : [];
        state.followUpQueue = Array.isArray(body.followUp) ? body.followUp : [];
        root.projectTurnFields(state);
    }

    function fetchQueue(): void {
        const state = root.activeTurnState(false);
        if (state) root.fetchQueueFor(state);
    }

    function fetchQueueFor(state: var): void {
        if (!state.streaming) return;
        if (state.queueStatusRequest && state.queueStatusRequest.readyState !== 4) return;
        const xhr = new XMLHttpRequest();
        state.queueStatusRequest = xhr;
        if (root.isActiveTurn(state)) root.queueStatusRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== state.queueStatusRequest || !state.streaming) return;
            if (xhr.status === 200) {
                try {
                    root.applyQueueFor(state, JSON.parse(xhr.responseText));
                } catch (error) {
                    state.queueError = "ghostd sent malformed queue state";
                }
            }
            root.projectTurnFields(state);
        };
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(state.ghost)
            + "/sessions/" + encodeURIComponent(state.sessionId) + "/queue", ({}), null);
    }

    function queueMessage(text: string, mode: string): void {
        const prompt = text.trim();
        const state = root.activeTurnState(false);
        if (!state) return;
        root.captureActiveTurn(state);
        if (prompt === "" || state.queueSubmitting || !state.streaming) return;
        state.queueSubmitting = true;
        state.queueError = "";
        // Show the chip immediately; the authoritative GET will remove it once
        // OMP consumes it into the next provider boundary.
        if (mode === "followUp") state.followUpQueue = state.followUpQueue.concat([prompt]);
        else state.steeringQueue = state.steeringQueue.concat([prompt]);

        const xhr = new XMLHttpRequest();
        state.queueRequest = xhr;
        root.queueRequest = xhr;
        root.projectTurnFields(state);
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== state.queueRequest) return;
            state.queueSubmitting = false;
            if (xhr.status === 200) {
                try {
                    root.applyQueueFor(state, JSON.parse(xhr.responseText));
                    state.queueError = "";
                } catch (error) {
                    state.queueError = "ghostd sent malformed queue state";
                }
            } else {
                state.queueError = root.describeError(xhr, "POST queue");
                root.fetchQueueFor(state);
                root.queueMessageRejected(prompt);
            }
            root.projectTurnFields(state);
        };
        root.dispatch(xhr, "POST", "/api/ghosts/" + encodeURIComponent(state.ghost)
            + "/sessions/" + encodeURIComponent(state.sessionId) + "/queue",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ mode: mode, text: prompt }));
    }

    // ---- Model login ------------------------------------------------------

    function newLoginRequest(): var {
        return root.loginRequestFactory ? root.loginRequestFactory() : new XMLHttpRequest();
    }

    function abortLoginRequest(xhr: var): void {
        if (xhr && xhr.readyState !== 4 && typeof xhr.abort === "function") xhr.abort();
    }

    /** Detach first: Qt may synchronously deliver DONE from abort(). */
    function abortLoginRequests(): void {
        const providers = root.providersRequest;
        const start = root.loginStartRequest;
        const poll = root.loginPollRequest;
        const input = root.loginInputRequest;
        root.providersRequest = null;
        root.loginStartRequest = null;
        root.loginPollRequest = null;
        root.loginInputRequest = null;
        root.abortLoginRequest(providers);
        root.abortLoginRequest(start);
        root.abortLoginRequest(poll);
        root.abortLoginRequest(input);
    }

    function providersRequestCurrent(xhr: var, generation: int, ghost: string): bool {
        return xhr === root.providersRequest && generation === root.loginGeneration
            && ghost === root.activeGhost;
    }

    function loginStartRequestCurrent(xhr: var, generation: int,
            routeGhost: string): bool {
        return xhr === root.loginStartRequest && generation === root.loginGeneration
            && routeGhost !== "" && routeGhost === root.loginRouteGhost;
    }

    function loginPollRequestCurrent(xhr: var, generation: int,
            routeGhost: string, loginId: string): bool {
        return xhr === root.loginPollRequest && generation === root.loginGeneration
            && routeGhost !== "" && routeGhost === root.loginRouteGhost
            && loginId !== "" && loginId === root.loginId;
    }

    function loginInputRequestCurrent(xhr: var, generation: int,
            routeGhost: string, loginId: string): bool {
        return xhr === root.loginInputRequest && generation === root.loginGeneration
            && routeGhost !== "" && routeGhost === root.loginRouteGhost
            && loginId !== "" && loginId === root.loginId;
    }

    function applyProvidersResponse(xhr: var, generation: int, ghost: string): bool {
        if (xhr.readyState !== 4
                || !root.providersRequestCurrent(xhr, generation, ghost))
            return false;
        root.providersRequest = null;
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
        return true;
    }

    /** GET the providers this ghost can log into. Call when the panel opens. */
    function fetchProviders(): void {
        const ghost = root.activeGhost;
        if (ghost === "") return;
        if (root.renamingGhost !== "") {
            root.loginError = "Wait for the ghost rename to finish before starting a login.";
            return;
        }
        const xhr = root.newLoginRequest();
        const previous = root.providersRequest;
        const generation = root.loginGeneration;
        root.providersRequest = xhr;
        root.abortLoginRequest(previous);
        xhr.onreadystatechange = function () {
            root.applyProvidersResponse(xhr, generation, ghost);
        };
        root.dispatch(xhr, "GET",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/providers", ({}), null,
            function () { return root.providersRequestCurrent(xhr, generation, ghost); });
    }

    function refreshAfterLoginSuccess(): void {
        root.refresh();
        root.fetchCurrentModel();
        root.fetchAvailableModels();
    }

    function applyLoginStartResponse(xhr: var, generation: int,
            routeGhost: string): bool {
        if (xhr.readyState !== 4
                || !root.loginStartRequestCurrent(xhr, generation, routeGhost))
            return false;
        root.loginStartRequest = null;
        if (xhr.status === 200 || xhr.status === 201) {
            try {
                const view = JSON.parse(xhr.responseText);
                if (!view || typeof view.loginId !== "string" || view.loginId === "")
                    throw new Error("missing login id");
                root.loginId = view.loginId;
                root.loginState = view;
                root.loginError = "";
                if (root.isLoginTerminal()) {
                    loginPoll.stop();
                    if (root.loginState.status === "succeeded") root.refreshAfterLoginSuccess();
                } else {
                    loginPoll.start();
                }
            } catch (error) {
                root.loginError = "ghostd sent a malformed login response";
            }
        } else {
            root.loginError = root.describeError(xhr, "POST login");
        }
        return true;
    }

    /** Begin a login for the active ghost. authType is "oauth" or "api_key". */
    function startLogin(providerId: string, authType: string): void {
        const ghost = root.activeGhost;
        if (ghost === "") return;
        if (root.renamingGhost !== "") {
            root.loginError = "Wait for the ghost rename to finish before starting a login.";
            return;
        }
        root.resetLogin();
        root.loginGhost = ghost;
        root.loginRouteGhost = ghost;
        const generation = root.loginGeneration;
        const routeGhost = root.loginRouteGhost;
        const xhr = root.newLoginRequest();
        root.loginStartRequest = xhr;
        xhr.onreadystatechange = function () {
            root.applyLoginStartResponse(xhr, generation, routeGhost);
        };
        root.dispatch(xhr, "POST",
            "/api/ghosts/" + encodeURIComponent(routeGhost) + "/login",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ providerId: providerId, authType: authType }),
            function () {
                return root.loginStartRequestCurrent(xhr, generation, routeGhost);
            });
    }

    function applyLoginPollResponse(xhr: var, generation: int,
            routeGhost: string, loginId: string): bool {
        if (xhr.readyState !== 4
                || !root.loginPollRequestCurrent(xhr, generation, routeGhost, loginId))
            return false;
        root.loginPollRequest = null;
        if (xhr.status === 200) {
            try {
                const view = JSON.parse(xhr.responseText);
                if (!view || view.loginId !== loginId) throw new Error("mismatched login id");
                root.loginState = view;
                root.loginError = "";
                if (root.isLoginTerminal()) {
                    loginPoll.stop();
                    if (root.loginState.status === "succeeded") root.refreshAfterLoginSuccess();
                }
            } catch (error) {
                root.loginError = "ghostd sent a malformed login step";
            }
        } else {
            loginPoll.stop();
            root.loginError = root.describeError(xhr, "GET login");
        }
        return true;
    }

    /** Poll the running login's current step. */
    function pollLogin(): void {
        if (root.loginId === "" || root.loginRouteGhost === ""
                || root.loginRoutePaused) return;
        // Keep one poll in flight, and never race an authoritative input reply.
        if (root.loginPollRequest !== null || root.loginInputRequest !== null) return;
        const routeGhost = root.loginRouteGhost;
        const loginId = root.loginId;
        const generation = root.loginGeneration;
        const xhr = root.newLoginRequest();
        root.loginPollRequest = xhr;
        xhr.onreadystatechange = function () {
            root.applyLoginPollResponse(xhr, generation, routeGhost, loginId);
        };
        root.dispatch(xhr, "GET", "/api/ghosts/"
            + encodeURIComponent(routeGhost) + "/login/" + encodeURIComponent(loginId),
            ({}), null, function () {
                return root.loginPollRequestCurrent(
                    xhr, generation, routeGhost, loginId);
            });
    }

    function applyLoginInputResponse(xhr: var, generation: int,
            routeGhost: string, loginId: string): bool {
        if (xhr.readyState !== 4
                || !root.loginInputRequestCurrent(xhr, generation, routeGhost, loginId))
            return false;
        root.loginInputRequest = null;
        if (xhr.status === 200) {
            try {
                const view = JSON.parse(xhr.responseText);
                if (!view || view.loginId !== loginId) throw new Error("mismatched login id");
                root.loginState = view;
                root.loginError = "";
                if (root.isLoginTerminal()) {
                    loginPoll.stop();
                    if (root.loginState.status === "succeeded") root.refreshAfterLoginSuccess();
                } else {
                    loginPoll.start();
                }
            } catch (error) {
                root.loginError = "ghostd sent a malformed login step";
            }
        } else {
            root.loginError = root.describeError(xhr, "POST login input");
        }
        return true;
    }

    /** Satisfy an awaiting prompt with a pasted code, API key, or selected id. */
    function submitLoginInput(value: string): bool {
        if (root.loginId === "" || root.loginRouteGhost === ""
                || root.loginRoutePaused) return false;
        if (root.loginInputRequest !== null) return false;
        const routeGhost = root.loginRouteGhost;
        const loginId = root.loginId;
        const generation = root.loginGeneration;
        const stalePoll = root.loginPollRequest;
        root.loginPollRequest = null;
        root.abortLoginRequest(stalePoll);
        const xhr = root.newLoginRequest();
        root.loginInputRequest = xhr;
        xhr.onreadystatechange = function () {
            root.applyLoginInputResponse(xhr, generation, routeGhost, loginId);
        };
        root.dispatch(xhr, "POST", "/api/ghosts/"
            + encodeURIComponent(routeGhost) + "/login/"
            + encodeURIComponent(loginId) + "/input",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ value: value }), function () {
                return root.loginInputRequestCurrent(
                    xhr, generation, routeGhost, loginId);
            });
        return true;
    }

    /** Open the current auth URL in the owner's browser. */
    function openLoginUrl(url: string): void {
        if (!ExternalLinks.openLoginUrl(url)) root.loginError = "ghostd sent an unsafe login URL";
    }

    function isLoginTerminal(): bool {
        const status = root.loginState ? root.loginState.status : "";
        return status === "succeeded" || status === "failed";
    }

    /** Stop login traffic for the whole interval in which either daemon route
        could be wrong. Existing input/poll work is replaced by a later poll. */
    function pauseLoginRoute(routeGhost: string): void {
        if (routeGhost === "" || root.loginRouteGhost !== routeGhost) return;
        loginPoll.stop();
        root.loginRoutePaused = true;
        const poll = root.loginPollRequest;
        const input = root.loginInputRequest;
        root.loginPollRequest = null;
        root.loginInputRequest = null;
        root.abortLoginRequest(poll);
        root.abortLoginRequest(input);
    }

    /** A refused rename leaves the old daemon route authoritative. */
    function resumeLoginRoute(routeGhost: string): void {
        if (root.loginRouteGhost !== routeGhost) return;
        root.loginRoutePaused = false;
        if (root.loginId !== "" && !root.isLoginTerminal()) loginPoll.start();
    }

    /** Publish the daemon's post-rename route. The login id/state survive; the
        next poll is authoritative after traffic was paused across publication. */
    function moveLoginRoute(from: string, to: string): void {
        if (from === to || root.loginRouteGhost !== from) return;
        const start = root.loginStartRequest;
        const poll = root.loginPollRequest;
        const input = root.loginInputRequest;
        root.loginStartRequest = null;
        root.loginPollRequest = null;
        root.loginInputRequest = null;
        root.loginRouteGhost = to;
        root.loginRoutePaused = false;
        root.abortLoginRequest(start);
        root.abortLoginRequest(poll);
        root.abortLoginRequest(input);
        if (root.loginId !== "" && !root.isLoginTerminal()) loginPoll.start();
    }

    /** Cancel every client-side part of the current flow. */
    function cancelLogin(): void {
        loginPoll.stop();
        root.loginGeneration += 1;
        root.abortLoginRequests();
        root.loginId = "";
        root.loginState = ({});
        root.loginGhost = "";
        root.loginRouteGhost = "";
        root.loginRoutePaused = false;
        root.loginError = "";
    }

    /** Clear login state and stop polling. Leaves the provider list intact. */
    function resetLogin(): void {
        root.cancelLogin();
    }

    // ---- Model selection --------------------------------------------------

    function applyCurrentModelResponse(xhr: var, ghost: string, generation: int): bool {
        if (xhr.readyState !== 4 || xhr !== root.modelRequest
                || ghost !== root.activeGhost || generation !== root.modelGeneration)
            return false;
        root.modelRequest = null;
        if (xhr.status === 200) {
            try {
                const body = JSON.parse(xhr.responseText);
                root.currentModel = body.current || null;
                root.modelSource = body.source || "none";
                root.modelError = "";
                root.adoptConversationRuntime(ghost,
                    body.current && body.current.provider === "claude-code"
                        ? "claude-code" : "pi");
            } catch (error) {
                root.modelError = "ghostd sent a malformed model selection";
            }
        } else {
            root.modelError = root.describeError(xhr, "GET model");
        }
        return true;
    }

    function adoptSelectedModelRuntime(ghost: string, provider: string): bool {
        if (ghost === "" || ghost !== root.activeGhost) return false;
        root.modelGeneration += 1;
        root.modelRequest = null;
        root.adoptConversationRuntime(ghost,
            provider === "claude-code" ? "claude-code" : "pi");
        return true;
    }

    /** GET the ghost's current model. Cheap; called on refresh, ghost switch, panel open. */
    function fetchCurrentModel(): void {
        const ghost = root.activeGhost;
        if (ghost === "") return;
        const generation = root.modelGeneration;
        const xhr = new XMLHttpRequest();
        root.modelRequest = xhr;
        xhr.onreadystatechange = function () {
            root.applyCurrentModelResponse(xhr, ghost, generation);
        };
        root.dispatch(xhr, "GET",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/model", ({}), null);
    }

    /** GET the models this ghost can use right now (credentialed providers only). */
    function fetchAvailableModels(): void {
        const ghost = root.activeGhost;
        if (ghost === "") return;
        const xhr = root.availableModelsRequestFactory
            ? root.availableModelsRequestFactory() : new XMLHttpRequest();
        root.availRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.availRequest
                    || ghost !== root.activeGhost) return;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    if (!Array.isArray(body.models) || typeof body.total !== "number"
                            || !Number.isFinite(body.total) || Math.floor(body.total) !== body.total
                            || body.total < body.models.length || body.limit !== 500
                            || body.offset !== 0
                            || body.models.length !== Math.min(body.total, body.limit))
                        throw new Error("invalid available model page");
                    root.availableModels = body.models;
                    root.availableModelTotal = body.total;
                    root.modelError = "";
                } catch (error) {
                    root.modelError = "ghostd sent a malformed model list";
                }
            } else {
                root.modelError = root.describeError(xhr, "GET models (available)");
            }
        };
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/models?scope=available&limit=500&offset=0", ({}), null,
            function () { return xhr === root.availRequest && ghost === root.activeGhost; });
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
            if (xhr.readyState !== 4 || xhr !== root.setModelRequest
                    || ghost !== root.activeGhost) return;
            root.setModelRequest = null;
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
                root.adoptSelectedModelRuntime(ghost, provider);
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
        root.replaceModelFallbacks(role, []);
    }

    /** Remove an explicit primary so OMP's automatic role resolution is visible again. */
    function clearModelPrimary(role: string): void {
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
                    root.fetchCurrentModel();
                    root.fetchAvailableModels();
                    root.modelRouteCompleted(role, "clear_primary");
                } catch (error) {
                    root.modelError = "ghostd sent malformed model routing";
                }
            } else {
                root.modelError = root.describeError(xhr, "clear model primary");
            }
        };
        root.dispatch(xhr, "PUT", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/model-routing", ({ "Content-Type": "application/json" }),
            JSON.stringify({ role: role, target: "clear_primary" }));
    }

    /** Atomically replace an OMP role's complete ordered retry chain. */
    function replaceModelFallbacks(role: string, fallbacks: var): void {
        const ghost = root.activeGhost;
        if (ghost === "" || role === "" || !Array.isArray(fallbacks)) return;

        const replacement = [];
        for (let i = 0; i < fallbacks.length; i++) {
            const fallback = fallbacks[i];
            if (!fallback || typeof fallback.provider !== "string"
                    || fallback.provider === "" || typeof fallback.id !== "string"
                    || fallback.id === "") return;
            replacement.push({ provider: fallback.provider, id: fallback.id });
        }

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
                    root.modelRouteCompleted(role, "replace_fallbacks");
                } catch (error) {
                    root.modelError = "ghostd sent malformed model routing";
                }
            } else {
                root.modelError = root.describeError(xhr, "replace model fallbacks");
            }
        };
        root.dispatch(xhr, "PUT", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/model-routing", ({ "Content-Type": "application/json" }),
            JSON.stringify({
                role: role,
                target: "replace_fallbacks",
                fallbacks: replacement
            }));
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

    /** Machine-readable daemon error code, when the response carries one. */
    function errorCode(xhr: var): string {
        try {
            const body = JSON.parse(xhr.responseText);
            const code = body && body.error && typeof body.error === "object"
                ? body.error.code : body.code;
            return typeof code === "string" ? code : "";
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
