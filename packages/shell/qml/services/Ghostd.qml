pragma Singleton

// Streaming: Qt's QML XMLHttpRequest fires onreadystatechange repeatedly at
// readyState 3 (LOADING), once per network chunk, and exposes the *cumulative*
// partial body in responseText. That was measured on this stack (Quickshell
// 0.3.0 / Qt 6.11.2) against a chunked SSE server, both GET and POST — see
// dev/README.md. So SSE needs no helper process: we track a consumed offset,
// buffer the trailing partial frame, and parse `data:` frames ourselves.
//
// Auth: the daemon binds loopback, which is not the same as being private —
// every browser on this machine can reach 127.0.0.1 too, and a page the user
// visits could otherwise drive a ghost with a form post (issue #485). So every
// /api route but relay/status wants `Authorization: Bearer <token>`, where the
// token is a 0600 file the daemon mints at startup. We can read a file; a web
// page cannot. Nothing here opens a request directly — `request()` (or, for
// the two event streams, `dispatch()`) does, so the header and the rotation
// retry exist in one place.
import Quickshell
import Quickshell.Io
import QtQuick
import "GhostRename.js" as GhostRename
import "HookStatus.js" as HookStatus
import "HookConfig.js" as HookConfig
import "TurnBlocks.js" as TurnBlocks

Singleton {
    id: root

    readonly property string host: Quickshell.env("GHOSTD_HOST") || "127.0.0.1"
    readonly property string port: String(Quickshell.env("GHOSTD_PORT") || "7717")
    // IPv6 literals need brackets in a URL authority; ghostd binds loopback only.
    readonly property string baseUrl: "http://"
        + (root.host.indexOf(":") >= 0 ? "[" + root.host + "]" : root.host)
        + ":" + root.port

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
    property string apiToken: ""

    property var ghosts: []
    property string activeGhost: ""
    /** False once any request fails; the HUD shows a reconnect hint. */
    property bool reachable: false
    /** Human-readable last failure, or "". */
    property string lastError: ""
    property string deletingGhost: ""
    property string renamingGhost: ""
    property string ghostDeleteError: ""
    /** Why the last ghost rename was refused, or "". Presentable as-is. Kept
        apart from `ghostDeleteError`: that one renders inside the banish
        modal, and a rename is typed in the roster row itself. */
    property string ghostRenameError: ""

    function validUpdate(update: var): bool {
        return !!update && typeof update === "object" && !Array.isArray(update)
            && typeof update.latest === "string" && update.latest !== ""
            && typeof update.command === "string" && update.command !== "";
    }

    /** What the daemon knows about newer releases; nothing else in /api/status is read here. */
    function fetchDaemonStatus(): void {
        if (root.statusRequest) return;
        root.request(root, "statusRequest", "GET", "/api/status", null, function (xhr, body) {
            if (xhr.status !== 200) return;
            root.updateAvailable = body && root.validUpdate(body.update) ? body.update : null;
            if (body) root.reachable = true;
        });
    }

    // Remote access is daemon-global rather than ghost- or conversation-scoped,
    // so its owner/request state survives ghost and conversation switches.

    /** The daemon's RemoteStatus; the panel reads the rest defensively. */
    function validRemoteStatus(body: var): bool {
        return !!body && typeof body === "object" && !Array.isArray(body)
            && typeof body.enabled === "boolean"
            && (body.problem === null
                || (!!body.problem && typeof body.problem === "object"
                    && typeof body.problem.message === "string"));
    }

    /** Adopt a status; the QR code is fetched once per URL. */
    function applyRemoteStatus(body: var): bool {
        if (!root.validRemoteStatus(body)) return false;
        const urlBefore = root.remoteUrl;
        root.remoteStatus = body;
        root.remoteError = "";
        if (root.remoteUrl !== urlBefore) root.clearRemoteQr();
        if (root.remoteUrl !== "" && root.remoteQrSource === "") root.fetchRemoteQr();
        return true;
    }

    function clearRemoteQr(): void {
        root.retire(root, "remoteQrRequest");
        root.remoteQrSource = "";
    }

    function retireRemoteRequests(): void {
        root.retire(root, "remoteRequest");
        root.remoteLoading = false;
        root.remoteMutating = false;
        root.clearRemoteQr();
    }

    function clearRemote(): void {
        root.retireRemoteRequests();
        root.remoteStatus = ({});
        root.remoteError = "";
    }

    function fetchRemoteQr(): void {
        const expectedUrl = root.remoteUrl;
        if (expectedUrl === "") {
            root.clearRemoteQr();
            return;
        }
        if (root.remoteQrRequest) return;
        root.request(root, "remoteQrRequest", "GET", "/api/remote/qr.svg", null, function (xhr) {
            if (root.remoteUrl !== expectedUrl) return;
            const svg = String(xhr.responseText || "");
            if (xhr.status !== 200)
                root.remoteError = root.describeError(xhr, "GET remote-access QR code");
            else if (svg.indexOf("<svg") < 0)
                root.remoteError = "ghostd sent malformed remote-access QR code";
            else
                root.remoteQrSource = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        });
    }

    function adoptRemoteReply(xhr: var, body: var, what: string): void {
        if (xhr.status !== 200) root.remoteError = root.describeError(xhr, what);
        else if (!root.applyRemoteStatus(body)) root.remoteError = "ghostd sent malformed remote-access status";
        else root.reachable = true;
    }

    function refreshRemote(): void {
        if (root.remoteMutating || root.remoteRequest) return;
        root.remoteLoading = true;
        root.remoteError = "";
        root.request(root, "remoteRequest", "GET", "/api/remote", null, function (xhr, body) {
            root.remoteLoading = false;
            root.adoptRemoteReply(xhr, body, "GET remote access");
        });
    }

    function setRemoteEnabled(enabled: bool): void {
        if (root.remoteMutating || typeof enabled !== "boolean") return;
        root.retire(root, "remoteRequest");
        root.remoteLoading = false;
        root.remoteMutating = true;
        root.remoteError = "";
        root.request(root, "remoteRequest", "POST", "/api/remote", { enabled: enabled },
            function (xhr, body) {
                root.remoteMutating = false;
                root.adoptRemoteReply(xhr, body, "POST remote access");
            });
    }

    // Hook status and configuration are daemon-global, independent of any
    // ghost or conversation.

    function retireHooksRequest(): void {
        root.retire(root, "hooksRequest");
        root.hooksLoading = false;
    }

    /** Take the daemon's `{ path, document }` as the current hooks.json; false when the body is not that. */
    function adoptHookConfig(xhr: var): bool {
        const config = HookConfig.parseConfig(xhr.responseText);
        if (config === null) {
            root.hookConfigError = "ghostd sent a malformed hook configuration";
            return false;
        }
        root.hookConfigPath = config.path;
        root.hookConfig = config.document;
        return true;
    }

    function beginHooksConnectionEpoch(): void {
        root.hooksEpoch += 1;
        root.retireHooksRequest();
        root.activeHooks = [];
        root.activeHookCount = 0;
        root.hooksLoaded = false;
        root.hooksStale = false;
        root.hooksError = "";
        root.retire(root, "hookConfigRequest");
        root.hookConfig = null;
        root.hookConfigPath = "";
        root.hookConfigLoaded = false;
        root.hookConfigError = "";
    }

    function failHooksTransport(epoch: int): void {
        if (epoch !== root.hooksEpoch) return;
        root.reachable = false;
        // A true -> false transition resets through onReachableChanged. During
        // startup reachable is already false, so retire this epoch directly.
        if (epoch === root.hooksEpoch) root.beginHooksConnectionEpoch();
    }

    function fetchHooks(force: bool): void {
        if (!force && (root.hooksLoaded || root.hooksLoading)) return;
        if (root.hooksRequest) {
            if (!force) return;
            root.retireHooksRequest();
        }
        const epoch = root.hooksEpoch;
        root.hooksLoading = true;
        root.hooksStale = false;
        root.hooksError = "";
        root.request(root, "hooksRequest", "GET", "/api/hooks", null, function (xhr, body) {
            root.hooksLoading = false;
            const status = xhr.status === 200 ? HookStatus.normalize(body) : null;
            if (status !== null) {
                root.activeHooks = status.hooks;
                root.activeHookCount = status.total;
                root.hooksLoaded = true;
                root.hooksStale = false;
                root.hooksError = "";
                root.reachable = true;
            } else if (xhr.status === 0) {
                root.failHooksTransport(epoch);
            } else {
                root.hooksStale = root.hooksLoaded;
                root.hooksError = xhr.status === 200 ? "ghostd sent malformed hook status"
                    : root.describeError(xhr, "GET hooks");
            }
        }, () => epoch === root.hooksEpoch);
    }

    /** Read the owner's hooks.json through the daemon. A 404 means the daemon has no file to edit. */
    function fetchHookConfig(force: bool): void {
        if (!force && (root.hookConfigLoaded || root.hookConfigLoading)) return;
        root.retire(root, "hookConfigRequest");
        const epoch = root.hooksEpoch;
        root.hookConfigError = "";
        root.request(root, "hookConfigRequest", "GET", "/api/hooks/config", null, function (xhr) {
            if (xhr.status === 200) {
                if (!root.adoptHookConfig(xhr)) return;
                root.hookConfigLoaded = true;
                root.reachable = true;
            } else if (xhr.status === 404) {
                root.hookConfig = null;
                root.hookConfigPath = "";
                root.hookConfigLoaded = true;
            } else if (xhr.status === 0) {
                root.failHooksTransport(epoch);
            } else {
                root.hookConfigError = root.describeError(xhr, "GET hooks config");
            }
        }, () => epoch === root.hooksEpoch);
    }

    /**
     * Replace the owner's hooks.json whole. The daemon's loader is the only
     * validator: a refused document comes back as its message and nothing
     * changes; an admitted one is live at once, so the status is re-read.
     */
    function writeHookConfig(document: var): void {
        if (root.hookConfigBusy || !root.hookConfigAvailable) return;
        const epoch = root.hooksEpoch;
        root.hookConfigError = "";
        root.request(root, "hookConfigMutation", "PUT", "/api/hooks/config", document, function (xhr) {
            if (epoch !== root.hooksEpoch) return;
            const ok = xhr.status === 200 && root.adoptHookConfig(xhr);
            // A 400 is the loader's message naming the field; that is the whole story.
            if (xhr.status === 400) root.hookConfigError = root.refusal(xhr, "PUT hooks config");
            else if (xhr.status !== 200) root.hookConfigError = root.describeError(xhr, "PUT hooks config");
            root.hookConfigWriteFinished(ok);
            if (ok) root.fetchHooks(true);
        });
    }

    // The persona file, edited through the daemon rather than by a direct
    // disk write: the daemon owns the size cap and refuses an oversize body,
    // so a bad edit fails at save time instead of at the next cold session
    // start. The read tolerates an oversize hand-edited file so it can be
    // shortened here.
    property string characterBody: ""
    /** The daemon's character cap, echoed in its responses; 0 until heard.
        Never pinned here — the daemon may change it. */
    property int characterLimit: 0
    property bool characterLoading: false
    property bool characterSaving: false
    property string characterError: ""
    property string characterGhost: ""

    /** The daemon's RemoteStatus, `{}` until read. */
    property var remoteStatus: ({})
    /** The tailnet URL while remote access is on, else "". */
    readonly property string remoteUrl: typeof root.remoteStatus.url === "string" ? root.remoteStatus.url : ""
    property bool remoteLoading: false
    property bool remoteMutating: false
    /**
     * A newer Ghost release the daemon knows about, `{ latest, command, url }`,
     * or null. The daemon checks once a day; this is only its last answer.
     */
    property var updateAvailable: null
    property string remoteError: ""
    /** Authenticated SVG responses become a data URL for QML's Image, whose
        network loader cannot attach the bearer header itself. */
    property string remoteQrSource: ""
    readonly property bool remoteQrLoading: root.remoteQrRequest !== null

    property var activeHooks: []
    property int activeHookCount: 0
    property bool hooksLoading: false
    property bool hooksLoaded: false
    /** A failed refresh may retain the last exact successful projection. */
    property bool hooksStale: false
    property string hooksError: ""
    property int hooksEpoch: 0
    /** The owner's hooks.json as the daemon admitted it; null until read. */
    property var hookConfig: null
    property string hookConfigPath: ""
    /** False on a daemon built without a hooks file (the route is 404). */
    readonly property bool hookConfigAvailable: root.hookConfig !== null
    property bool hookConfigLoaded: false
    readonly property bool hookConfigLoading: root.hookConfigRequest !== null
    readonly property bool hookConfigBusy: root.hookConfigMutation !== null
    property string hookConfigError: ""

    property bool establishedConnection: false

    // Only the active ghost's visible `<ghost-home>/mcp.json` is represented
    // here. GET
    // is sanitized; secret-bearing values are write-only through mutations.
    property var mcpServers: []
    property var mcpSkipped: []
    property bool mcpLoading: false
    property bool mcpMutating: false
    property string mcpError: ""
    property string mcpNotice: ""
    property string mcpGhost: ""

    // A ghost owns many conversations. The daemon persists them;
    // the HUD lists them per ghost, resumes one by loading its transcript, and
    // starts a fresh one on demand. This fixes #26 — a restart no longer loses
    // history, because a conversation lives in the daemon keyed by session id.
    property var sessions: []
    property string currentSessionId: ""
    /** Non-empty when a sessions/transcript fetch failed. */
    property string sessionsError: ""
    property string deletingSessionId: ""
    /** The agent CLI carrying the open conversation: the owner's unconfirmed
        pick, else its listing row; "" when unknown (a draft runs on whatever
        the daemon picks). */
    readonly property string currentHarness: {
        const pending = root.pendingHarnesses[root.conversationKey(root.activeGhost, root.currentSessionId)];
        if (typeof pending === "string") return pending;
        const row = root.sessions.find(session => session && session.id === root.currentSessionId);
        return row && typeof row.harness === "string" ? row.harness : "";
    }
    /** What a conversation not yet bound starts on: the ghost's default, else
        "auto (<Omarchy's default>)", each with the effort its launch asks for. */
    readonly property string draftHarness: {
        const choice = root.harnessChoice;
        const named = harness => {
            const row = choice.harnesses.find(h => h.id === harness);
            return harness + (row && row.effort ? " • " + row.effort : "");
        };
        if (choice && choice.ghostDefault) return named(choice.ghostDefault);
        return choice && choice.omarchyDefault ? "auto (" + named(choice.omarchyDefault) + ")" : "automatic";
    }
    /** What that harness last ran on, pi-style — "(provider) model • effort" —
        or "" when it is a pick not yet run or said nothing. */
    readonly property string currentModel: {
        const row = root.sessions.find(session => session && session.id === root.currentSessionId);
        if (!row || row.harness !== root.currentHarness) return "";
        const model = (row.provider ? "(" + row.provider + ") " : "") + (row.model || "");
        return [model, row.effort || ""].filter(part => part !== "").join(" • ");
    }

    // The agent picker: GET /harness for the active ghost, the ghost's default
    // (PUT /harness), and one conversation's next agent (PUT .../harness).
    /** `{ harnesses: [{ id, eligible, reason, effort }], ghostDefault, omarchyDefault }`, or null until read. */
    property var harnessChoice: null
    property string harnessError: ""
    /** conversationKey -> the agent the owner picked, until a listing reports it. */
    property var pendingHarnesses: ({})
    property var harnessRequest: null
    property var harnessMutation: null
    property var harnessSessionRequest: null
    property bool hudVisible: false
    property bool hudChatFocused: false

    property alias transcript: transcriptModel
    property bool streaming: false
    property string activity: ""
    property var followUpQueue: []
    property string queueError: ""

    signal turnFinished(string ghost, string text, string sessionId, string title)
    signal turnFailed(string ghost, string message, string sessionId, string title)
    /** Text for the composer: a queued message the daemon refused. */
    signal composerDraft(string text)
    signal mcpMutationFinished(string action, string server, bool ok)
    signal characterWriteFinished(bool ok)
    signal hookConfigWriteFinished(bool ok)

    // An XHR must be held by a property (see request()).
    property var listRequest: null
    property var createGhostRequest: null
    property var deleteGhostRequest: null
    property var renameGhostRequest: null
    property var renameGhostSnapshot: null
    property var renameSessionRequest: null
    property var sessionsRequest: null
    property var eventsRequest: null
    property string eventsGhost: ""
    property int eventsConsumed: 0
    property string eventsFrameBuffer: ""
    property var characterRequest: null
    property var characterWriteRequest: null
    property var remoteRequest: null
    property var statusRequest: null
    property var remoteQrRequest: null
    property var hooksRequest: null
    property var hookConfigRequest: null
    property var hookConfigMutation: null
    property var mcpRequest: null
    property var mcpMutationRequest: null
    /** Test seam: when set, every request is `requestFactory()` instead of a native XHR. */
    property var requestFactory: null
    readonly property int transcriptPageLimit: 1000
    readonly property int transcriptMaxPages: 10
    /** The shell's own patience for a silent stream — three of the daemon's
        15s SSE keepalives missed means that response is no longer live. */
    readonly property int streamSilenceMs: 45000
    property var deleteSessionRequest: null
    property var pinSessionRequest: null
    /** conversationKey -> its in-flight mark-read request. */
    property var readSessionRequests: ({})

    property var sessionIds: ({})     // ghost name -> active conversation id
    property var turnStates: ({})
    property var liveConversationKeys: []
    readonly property bool anyStreaming: root.liveConversationKeys.length > 0
    property var toolActivities: []   // stateful cards for the current assistant row
    property int assistantRow: -1

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
        interval: root.streamSilenceMs
        repeat: false
        onTriggered: root.expireConversationEvents()
    }

    Timer {
        id: eventsReconnect
        interval: 1000
        repeat: false
        onTriggered: root.connectConversationEvents(root.activeGhost)
    }

    Component.onCompleted: root.refresh()
    Component.onDestruction: root.retireClientRequests()

    onReachableChanged: {
        if (root.reachable) {
            root.establishedConnection = true;
            Qt.callLater(function () {
                if (root.reachable) root.fetchHooks(false);
            });
        } else if (root.establishedConnection) {
            root.beginHooksConnectionEpoch();
        }
    }

    function retireClientRequests(): void {
        root.cancelAllTranscriptLoads();
        root.retireRemoteRequests();
        root.retireHooksRequest();
    }
    onActiveGhostChanged: root.connectConversationEvents(root.activeGhost)

    function token(): string {
        if (root.apiToken === "") {
            const text = apiTokenFile.text();
            root.apiToken = text ? text.trim() : "";
        }
        return root.apiToken;
    }

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

    function newRequest(): var {
        return typeof root.requestFactory === "function" ? root.requestFactory() : new XMLHttpRequest();
    }

    /**
     * Send one request, held in `owner[slot]` while in flight: an XHR whose
     * only reference is its own closure can be collected mid-flight. The reply
     * lands only while the slot still holds this request; the slot is emptied
     * at DONE, and `done(xhr, body)` runs unless `alive()` (optional) has
     * turned false. `body` is the parsed JSON reply, or undefined. A non-null
     * `payload` is sent as JSON. Retiring the slot (see retire) drops the reply.
     */
    function request(owner: var, slot: string, method: string, path: string, payload: var,
            done: var, alive: var): void {
        const xhr = root.newRequest();
        owner[slot] = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || owner[slot] !== xhr) return;
            owner[slot] = null;
            if (typeof alive === "function" && !alive()) return;
            let body;
            try {
                body = JSON.parse(xhr.responseText);
            } catch (error) {
                body = undefined;
            }
            done(xhr, body);
        };
        const json = payload !== null && payload !== undefined;
        root.dispatch(xhr, method, path, json ? ({ "Content-Type": "application/json" }) : ({}),
            json ? JSON.stringify(payload) : null, () => owner[slot] === xhr);
    }

    /** Empty `owner[slot]` before aborting its request: Qt may deliver DONE inside abort(). */
    function retire(owner: var, slot: string): void {
        const xhr = owner[slot];
        owner[slot] = null;
        if (xhr && xhr.readyState !== 4) xhr.abort();
    }

    function deliver(xhr: var, method: string, url: string, headers: var, body: var): void {
        xhr.open(method, url);
        const bearer = root.token();
        if (bearer !== "") xhr.setRequestHeader("Authorization", "Bearer " + bearer);
        for (const name in headers) xhr.setRequestHeader(name, headers[name]);
        if (body === null || body === undefined) xhr.send();
        else xhr.send(body);
    }


    // The owner's board: Documents/board.md, parsed by the daemon and shown
    // read-only. Polled while its pane is up; edits happen in the file.
    property var board: null
    property string boardError: ""
    property bool boardLoading: false
    property var boardRequest: null

    /** The daemon's Board, or null when the body is not one. */
    function boardFrom(body: var): var {
        if (!body || typeof body !== "object" || Array.isArray(body)) return null;
        if (typeof body.path !== "string" || typeof body.exists !== "boolean"
                || !Array.isArray(body.columns)) return null;
        const columns = [];
        for (const column of body.columns) {
            if (!column || typeof column.title !== "string" || !Array.isArray(column.cards)) return null;
            const cards = [];
            for (const card of column.cards) {
                if (!card || typeof card.text !== "string") return null;
                cards.push({
                    text: card.text,
                    done: card.done === true ? true : (card.done === false ? false : null),
                    notes: Array.isArray(card.notes) ? card.notes.filter(n => typeof n === "string") : []
                });
            }
            columns.push({ title: column.title, cards: cards });
        }
        return {
            path: body.path,
            exists: body.exists,
            title: typeof body.title === "string" ? body.title : "",
            modified: typeof body.modified === "string" ? body.modified : "",
            truncated: body.truncated === true,
            columns: columns
        };
    }

    function refreshBoard(): void {
        if (root.boardRequest) return;
        root.boardLoading = true;
        root.request(root, "boardRequest", "GET", "/api/board", null, function (xhr, body) {
            root.boardLoading = false;
            const parsed = xhr.status === 200 ? root.boardFrom(body) : null;
            if (parsed !== null) {
                // The pane polls every few seconds; an unchanged board keeps its cards.
                if (JSON.stringify(parsed) !== JSON.stringify(root.board)) root.board = parsed;
                root.boardError = "";
                root.reachable = true;
            } else {
                root.boardError = xhr.status === 200 ? "ghostd sent a malformed board"
                    : root.describeError(xhr, "GET board");
            }
        });
    }

    // The browser relay's pairing prompt is daemon-global as well. GhostHud
    // polls it only while shown: the code the extension popup displays has to
    // match the one here, and that is what makes Allow safe to click.
    /** `{code, since}` while a browser is waiting for Allow, else null. */
    property var relayPairing: null
    property bool relayResolving: false
    property string relayError: ""
    property var relayRequest: null

    /** The pending pairing from a relay status body, or null. */
    function relayPairingFrom(body: var): var {
        if (!body || typeof body !== "object" || Array.isArray(body)) return null;
        const pairing = body.pairing;
        if (!pairing || typeof pairing !== "object" || typeof pairing.code !== "string"
                || !/^[0-9]{6}$/.test(pairing.code)) return null;
        return {
            code: pairing.code,
            since: typeof pairing.since === "string" ? pairing.since : ""
        };
    }

    function refreshRelay(): void {
        if (root.relayResolving || root.relayRequest) return;
        root.request(root, "relayRequest", "GET", "/api/relay/status", null, function (xhr, body) {
            root.relayPairing = xhr.status === 200 ? root.relayPairingFrom(body) : null;
        });
    }

    /** Answer the pairing whose code the owner can see. */
    function resolveRelayPairing(code: string, allow: bool): void {
        if (root.relayResolving || typeof code !== "string" || code === ""
                || typeof allow !== "boolean") return;
        root.retire(root, "relayRequest");
        root.relayResolving = true;
        root.relayError = "";
        root.request(root, "relayRequest", "POST", "/api/relay/pair", { code: code, allow: allow },
            function (xhr, body) {
                root.relayResolving = false;
                // A 404 is expired, or answered from the CLI: either way it is gone.
                if (xhr.status === 200 || xhr.status === 404)
                    root.relayPairing = xhr.status === 200 ? root.relayPairingFrom(body) : null;
                else
                    root.relayError = root.describeError(xhr, (allow ? "allow" : "deny") + " browser pairing");
            });
    }

    function refresh(): void {
        root.fetchHooks(false);
        root.fetchDaemonStatus();
        root.retire(root, "listRequest");
        root.request(root, "listRequest", "GET", "/api/ghosts", null, function (xhr, list) {
            if (xhr.status !== 200) {
                root.fail(xhr.status === 0
                    ? "ghostd is not answering on " + root.baseUrl
                    : "GET /api/ghosts → " + xhr.status);
                return;
            }
            if (list === undefined) {
                root.fail("ghostd sent a malformed ghost list");
                return;
            }
            root.ghosts = Array.isArray(list) ? list : [];
            root.reachable = true;
            root.lastError = "";
            if (root.activeGhost === "" && root.ghosts.length > 0)
                root.activeGhost = root.ghosts[0].name;
            if (root.activeGhost !== "") {
                root.connectConversationEvents(root.activeGhost);
                root.fetchSessions(root.activeGhost);
                root.refreshCurrentTranscript();
            }
        });
    }

    function createGhost(name: string): void {
        const trimmed = name.trim();
        if (trimmed === "") return;
        root.retire(root, "createGhostRequest");
        root.request(root, "createGhostRequest", "POST", "/api/ghosts", { name: trimmed },
            function (xhr, created) {
                if (xhr.status !== 200 && xhr.status !== 201) {
                    root.fail(root.describeError(xhr, "POST /api/ghosts"));
                    return;
                }
                const createdName = created && typeof created.name === "string"
                    && created.name !== "" ? created.name : trimmed;
                if (created && !root.ghosts.some(ghost => ghost && ghost.name === createdName))
                    root.ghosts = root.ghosts.concat([created]);
                root.switchGhost(createdName);
                // The roster, not the POST echo, is the authoritative listing.
                root.refresh();
            });
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
        root.request(root, "deleteGhostRequest", "DELETE", "/api/ghosts/" + encodeURIComponent(name)
            + "?confirm=" + encodeURIComponent(name), null, function (xhr) {
                root.deletingGhost = "";
                if (xhr.status !== 200) {
                    root.ghostDeleteError = root.refusal(xhr, "DELETE ghost");
                    return;
                }
                root.ghostDeleteError = "";
                root.forgetGhost(name);
                // activeGhost is "" now if this was the active one, so the
                // listing picks the next ghost the way the first one does.
                root.refresh();
            });
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
        root.installGhostRenameState(transaction.after);
        root.moveTurnStates(from, next);
        root.request(root, "renameGhostRequest", "PUT", "/api/ghosts/" + encodeURIComponent(from) + "/name",
            { name: next }, function (xhr, body) {
                root.renamingGhost = "";
                if (xhr.status === 200) {
                    root.renameGhostSnapshot = null;
                    root.ghostRenameError = "";
                    // The daemon has the last word on the name it actually wrote.
                    const settled = body && typeof body.name === "string" && body.name !== ""
                        ? body.name : next;
                    if (settled !== next) root.applyGhostRename(next, settled);
                    root.refresh();
                    return;
                }
                if (root.renameGhostSnapshot) {
                    root.moveTurnStates(next, from);
                    root.installGhostRenameState(root.renameGhostSnapshot);
                }
                root.renameGhostSnapshot = null;
                root.ghostRenameError = root.refusal(xhr, "PUT ghost name");
            });
        return true;
    }

    function ghostRenameState(): var {
        return {
            ghosts: root.ghosts,
            sessionIds: root.sessionIds,
            mcpGhost: root.mcpGhost,
            activeGhost: root.activeGhost,
            characterGhost: root.characterGhost
        };
    }

    function installGhostRenameState(state: var): void {
        root.ghosts = state.ghosts;
        root.sessionIds = state.sessionIds;
        root.mcpGhost = state.mcpGhost;
        root.activeGhost = state.activeGhost;
        root.characterGhost = state.characterGhost;
    }

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
        root.clearTurnProjection();
        root.clearGhostScopedState();
    }

    /** Drop everything the HUD holds for the previously active ghost. */
    function clearGhostScopedState(): void {
        root.sessions = [];
        root.sessionsError = "";
        root.clearCharacter();
        root.clearMcp();
        root.clearHarnessChoice();
    }

    function clearHarnessChoice(): void {
        root.retire(root, "harnessRequest");
        root.retire(root, "harnessMutation");
        root.harnessChoice = null;
        root.harnessError = "";
    }

    /** The daemon's harness choice, or null when the body is not one. */
    function harnessChoiceFrom(body: var): var {
        if (!body || typeof body !== "object" || !Array.isArray(body.harnesses)) return null;
        const name = value => typeof value === "string" && value !== "" ? value : null;
        return {
            harnesses: body.harnesses.filter(h => h && name(h.id) !== null).map(h => ({
                id: h.id,
                eligible: h.eligible !== false,
                reason: typeof h.reason === "string" ? h.reason : "",
                effort: typeof h.effort === "string" ? h.effort : ""
            })),
            ghostDefault: name(body.ghostDefault),
            omarchyDefault: name(body.omarchyDefault)
        };
    }

    /** Adopt a GET/PUT /harness reply for `ghost`; false when it is not one. */
    function adoptHarnessChoice(xhr: var, body: var, ghost: string, what: string): bool {
        if (ghost !== root.activeGhost) return false;
        const choice = xhr.status === 200 ? root.harnessChoiceFrom(body) : null;
        if (choice === null) {
            root.harnessError = xhr.status === 200 ? "ghostd sent a malformed agent list"
                : root.describeError(xhr, what);
            return false;
        }
        root.harnessChoice = choice;
        root.harnessError = "";
        root.reachable = true;
        return true;
    }

    function fetchHarnesses(): void {
        const ghost = root.activeGhost;
        if (ghost === "" || root.harnessMutation !== null) return;
        root.retire(root, "harnessRequest");
        root.request(root, "harnessRequest", "GET", "/api/ghosts/" + encodeURIComponent(ghost) + "/harness",
            null, (xhr, body) => root.adoptHarnessChoice(xhr, body, ghost, "GET harnesses"));
    }

    /** Set the ghost's own default agent; null hands the choice back to Omarchy's default. */
    function setGhostHarness(harness: var): void {
        const ghost = root.activeGhost;
        const next = typeof harness === "string" && harness !== "" ? harness : null;
        if (ghost === "" || root.harnessMutation !== null) return;
        root.retire(root, "harnessRequest");
        const before = root.harnessChoice;
        if (before) root.harnessChoice = Object.assign({}, before, { ghostDefault: next });
        root.harnessError = "";
        root.request(root, "harnessMutation", "PUT", "/api/ghosts/" + encodeURIComponent(ghost) + "/harness",
            { harness: next }, function (xhr, body) {
                if (!root.adoptHarnessChoice(xhr, body, ghost, "PUT default harness")
                        && ghost === root.activeGhost && before) root.harnessChoice = before;
            });
    }

    /** A pick is settled once the daemon's listing reports that agent for it. */
    function settlePendingHarnesses(ghost: string, listed: var): void {
        for (const session of listed) {
            const key = root.conversationKey(ghost, session.id);
            const pending = root.pendingHarnesses[key];
            if (typeof pending === "string" && session.harness === pending)
                root.setPendingHarness(key, undefined);
        }
    }

    function setPendingHarness(key: string, harness: var): void {
        const next = Object.assign({}, root.pendingHarnesses);
        if (typeof harness === "string") next[key] = harness;
        else delete next[key];
        root.pendingHarnesses = next;
    }

    /**
     * Run the open conversation's next turn on `harness`. A brand-new draft is
     * minted first so it has an id to carry the choice; the label shows the
     * pick at once, and until a listing reports it.
     */
    function chooseHarness(harness: string): void {
        const ghost = root.activeGhost;
        if (ghost === "" || harness === "") return;
        if (root.currentSessionId === "") root.finishNewConversation();
        const id = root.currentSessionId;
        if (id === "") return;
        const key = root.conversationKey(ghost, id);
        const before = root.pendingHarnesses[key];
        root.setPendingHarness(key, harness);
        root.harnessError = "";
        root.request(root, "harnessSessionRequest", "PUT", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(id) + "/harness", { harness: harness }, function (xhr) {
                if (xhr.status === 200) return;
                if (root.pendingHarnesses[key] === harness) root.setPendingHarness(key, before);
                if (ghost === root.activeGhost)
                    root.harnessError = root.describeError(xhr, "PUT conversation harness");
            });
    }

    function selectGhost(name: string): void {
        if (name === root.activeGhost) return;
        root.finishSelectGhost(name);
    }

    function finishSelectGhost(name: string): void {
        if (!root.switchGhost(name)) return;
        root.fetchSessions(name);
    }

    /**
     * Make `name` the active ghost and drop the previous one's state, without
     * fetching; finishSelectGhost fetches, and a create lets refresh()'s
     * listing do it. False when there is nothing to switch.
     */
    function switchGhost(name: string): bool {
        if (name === "" || name === root.activeGhost) return false;
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
        root.clearGhostScopedState();
        return true;
    }

    /** Open one conversation of any ghost; Panel's summon payload names both. */
    function openConversationForGhost(name: string, id: string): void {
        if (name === "" || id === "") return;
        if (name !== root.activeGhost) root.finishSelectGhost(name);
        root.finishOpenConversation(id);
    }

    function conversationKey(ghost: string, sessionId: string): string {
        return JSON.stringify([ghost, sessionId]);
    }

    /** A conversation id the daemon accepts: 1–128 of `[A-Za-z0-9._-]`, not led by a dot. */
    function validConversationId(id: var): bool {
        return typeof id === "string" && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/u.test(id);
    }

    /** A fresh HUD-minted conversation id. */
    function mintConversationId(): string {
        return "hud-" + Date.now().toString(36)
            + "-" + Math.floor(Math.random() * 0xffffff).toString(36);
    }

    function cancelTranscriptLoad(state: var): void {
        if (!state) return;
        state.transcriptGeneration = Number(state.transcriptGeneration || 0) + 1;
        state.transcriptLoad = null;
        root.retire(state, "transcriptRequest");
    }

    function cancelAllTranscriptLoads(): void {
        for (const key of Object.keys(root.turnStates))
            root.cancelTranscriptLoad(root.turnStates[key]);
    }

    function isActiveTurn(state: var): bool {
        return !!state && state.ghost === root.activeGhost
            && state.sessionId === root.currentSessionId;
    }

    function cloneTranscriptRow(row: var): var {
        return {
            role: String(row.role || ""),
            text: String(row.text || ""),
            toolActivity: Array.isArray(row.toolActivity) ? row.toolActivity.slice() : [],
            error: String(row.error || ""),
            pending: row.pending === true
        };
    }

    function newTurnState(ghost: string, sessionId: string): var {
        return {
            key: root.conversationKey(ghost, sessionId),
            ghost: ghost,
            sessionId: sessionId,
            title: "",
            rows: [],
            hydratedRowCount: 0,
            streaming: false,
            // ghostd runs this conversation's turn for another client, or for
            // this HUD before a reload: shown as running, with no stream here.
            detached: false,
            request: null,
            lastStreamActivity: 0,
            activity: "",
            limitNotice: "",
            lastError: "",
            followUpQueue: [],
            queueSubmitting: false,
            queueError: "",
            parts: [],
            toolActivities: [],
            assistantRow: -1,
            consumed: 0,
            frameBuffer: "",
            presentationDirty: false,
            queueRequest: null,
            queueStatusRequest: null,
            stopRequest: null,
            transcriptRequest: null,
            transcriptGeneration: 0,
            transcriptLoad: null
        };
    }

    function ensureTurnState(ghost: string, sessionId: string): var {
        if (ghost === "" || !root.validConversationId(sessionId)) return null;
        const key = root.conversationKey(ghost, sessionId);
        let state = root.turnStates[key];
        if (!state) {
            state = root.newTurnState(ghost, sessionId);
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

    /**
     * Keep the active conversation's listed title before switching away from
     * or mutating it. Everything else the HUD shows is already in `state`: the
     * root fields and transcriptModel are only ever written as its projection.
     */
    function captureActiveTurn(state: var): void {
        if (!root.isActiveTurn(state)) return;
        const listed = root.sessions.find(session => session.id === state.sessionId);
        if (listed) state.title = listed.title || "";
    }

    function projectTurnFields(state: var): void {
        if (!root.isActiveTurn(state)) return;
        root.projectTurnProjection(state);
    }

    function projectTurnProjection(state: var): void {
        root.streaming = state.streaming || state.detached;
        root.activity = state.activity;
        root.lastError = state.lastError;
        root.followUpQueue = state.followUpQueue;
        root.queueError = state.queueError;
        root.toolActivities = state.toolActivities;
        root.assistantRow = state.assistantRow;
    }

    function clearTurnProjection(): void {
        transcriptModel.clear();
        const empty = root.newTurnState("", "");
        // A daemon-level error (fail()) outlives a conversation switch; a
        // conversation's own error comes back with its state.
        empty.lastError = root.lastError;
        root.projectTurnProjection(empty);
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
        if (root.isActiveTurn(state)) root.projectTurnRows(state);
    }

    function updateLiveConversationKeys(): void {
        root.liveConversationKeys = Object.keys(root.turnStates).filter(function (key) {
            return root.turnStates[key] && root.turnStates[key].streaming === true;
        });
    }

    function isConversationStreaming(ghost: string, id: string): bool {
        return root.liveConversationKeys.indexOf(root.conversationKey(ghost, id)) >= 0;
    }

    function flushLiveTurns(): void {
        for (const key of root.liveConversationKeys) {
            const state = root.turnStates[key];
            if (state) root.flushTurn(state, false);
        }
    }

    function expireStaleStreams(): void {
        const now = Date.now();
        for (const key of root.liveConversationKeys) {
            const state = root.turnStates[key];
            if (state && now - state.lastStreamActivity >= root.streamSilenceMs)
                root.expireTurnStream(state);
        }
    }

    function clearCharacter(): void {
        root.retire(root, "characterRequest");
        root.retire(root, "characterWriteRequest");
        root.characterBody = "";
        root.characterLimit = 0;
        root.characterLoading = false;
        root.characterSaving = false;
        root.characterError = "";
        root.characterGhost = "";
    }

    /**
     * Re-read the active ghost's persona file. `force` bypasses the per-ghost
     * cache; a successful save forces it so the view follows the disk.
     */
    function fetchCharacter(force: bool): void {
        const ghost = root.activeGhost;
        if (ghost === "") {
            root.clearCharacter();
            return;
        }
        if (!force && root.characterGhost === ghost) return;
        if (root.characterRequest) {
            if (!force) return;
            root.retire(root, "characterRequest");
        }
        root.characterLoading = true;
        root.characterError = "";
        root.request(root, "characterRequest", "GET",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/character", null, function (xhr, body) {
                root.characterLoading = false;
                if (ghost !== root.activeGhost) return;
                if (xhr.status !== 200) {
                    root.characterError = root.describeError(xhr, "GET character");
                } else if (!body || typeof body.body !== "string" || !(body.limit > 0)) {
                    root.characterError = "ghostd sent a malformed character file";
                } else {
                    root.characterBody = body.body;
                    root.characterLimit = body.limit;
                    root.characterGhost = ghost;
                    root.characterError = "";
                    root.reachable = true;
                }
            });
    }

    /**
     * Replace character.md through the daemon's validating writer. The daemon
     * is the authority on the size cap: an oversize body comes back 400
     * limit_exceeded and its message is surfaced as characterError while the
     * caller keeps the draft.
     */
    function writeCharacter(body: string): void {
        const ghost = root.activeGhost;
        if (ghost === "" || root.characterSaving) return;
        root.characterSaving = true;
        root.characterError = "";
        root.request(root, "characterWriteRequest", "PUT",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/character", { body: body }, function (xhr, result) {
                root.characterSaving = false;
                if (ghost !== root.activeGhost) return;
                const ok = xhr.status === 200 && !!result && result.ok === true;
                if (ok) {
                    root.characterBody = body;
                    if (result.limit > 0) root.characterLimit = result.limit;
                    root.characterGhost = ghost;
                    root.reachable = true;
                } else {
                    root.characterError = xhr.status === 200 ? "ghostd sent a malformed character result"
                        : root.describeError(xhr, "PUT character");
                }
                root.characterWriteFinished(ok);
                // The file on disk is the truth; re-read what the daemon stored.
                if (ok) root.fetchCharacter(true);
            });
    }


    function clearMcp(): void {
        root.retire(root, "mcpRequest");
        root.retire(root, "mcpMutationRequest");
        root.mcpServers = [];
        root.mcpSkipped = [];
        root.mcpLoading = false;
        root.mcpMutating = false;
        root.mcpError = "";
        root.mcpNotice = "";
        root.mcpGhost = "";
    }

    /** Adopt a `{ servers, skipped }` catalog for `ghost`; false when the body is not one. */
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
        root.mcpError = "";
        root.reachable = true;
        return true;
    }

    function fetchMcp(force: bool): void {
        const ghost = root.activeGhost;
        if (ghost === "") {
            root.clearMcp();
            return;
        }
        if (!force && root.mcpGhost === ghost) return;
        if (root.mcpRequest) {
            if (!force) return;
            root.retire(root, "mcpRequest");
        }
        root.mcpLoading = true;
        root.mcpError = "";
        root.mcpNotice = "";
        root.request(root, "mcpRequest", "GET", "/api/ghosts/" + encodeURIComponent(ghost) + "/mcp",
            null, function (xhr, body) {
                root.mcpLoading = false;
                if (ghost !== root.activeGhost) return;
                if (xhr.status !== 200) {
                    root.mcpError = root.describeError(xhr, "GET MCP servers");
                } else if (!root.applyMcpSnapshot(body, ghost)) {
                    root.mcpServers = [];
                    root.mcpSkipped = [];
                    root.mcpError = "ghostd sent a malformed MCP catalog";
                }
            });
    }

    function mutateMcp(method: string, suffix: string, body: var,
            action: string, server: string): void {
        const ghost = root.activeGhost;
        if (ghost === "" || root.mcpMutating) return;
        root.retire(root, "mcpRequest");
        root.mcpLoading = false;
        root.mcpMutating = true;
        root.mcpError = "";
        root.mcpNotice = "";
        root.request(root, "mcpMutationRequest", method, "/api/ghosts/" + encodeURIComponent(ghost)
            + "/mcp" + suffix, body, function (xhr, catalog) {
                root.mcpMutating = false;
                if (ghost !== root.activeGhost) return;
                const answered = xhr.status === 200 || xhr.status === 201;
                const ok = answered && root.applyMcpSnapshot(catalog, ghost);
                if (ok)
                    root.mcpNotice = action === "delete" ? "Server deleted."
                        : (action === "toggle" ? "Server state updated."
                            : (action === "add" ? "Server added." : "Server updated."));
                else
                    root.mcpError = answered ? "ghostd sent a malformed MCP catalog"
                        : root.describeError(xhr, method + " MCP server");
                root.mcpMutationFinished(action, server, ok);
            });
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
        const xhr = root.newRequest();
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
                if (connected && ghost === root.activeGhost) {
                    root.fetchSessions(ghost);
                    // The header names the agent a new conversation starts on.
                    root.fetchHarnesses();
                }
            }
        }
        if (xhr.readyState !== 4 || xhr !== root.eventsRequest) return;
        root.eventsRequest = null;
        eventsWatchdog.stop();
        if (ghost === root.activeGhost) eventsReconnect.restart();
    }

    /** The `data:` payloads of the complete SSE frames in `buffer + chunk`, and the partial frame left over. */
    function sseFrames(buffer: string, chunk: string): var {
        const frames = (buffer + chunk.replace(/\r\n/gu, "\n")).split("\n\n");
        const rest = frames.pop();
        const payloads = [];
        for (const frame of frames) {
            // Keepalives are bare `: comment` frames with no data line.
            const line = frame.split("\n").find(value => value.startsWith("data:"));
            const payload = line ? line.slice(5).trim() : "";
            if (payload !== "" && payload !== "[DONE]") payloads.push(payload);
        }
        return { rest: rest, payloads: payloads };
    }

    function ingestConversationEvents(chunk: string, ghost: string): void {
        const parsed = root.sseFrames(root.eventsFrameBuffer, chunk);
        root.eventsFrameBuffer = parsed.rest;
        for (const payload of parsed.payloads) {
            try {
                const event = JSON.parse(payload);
                if (event.type === "conversation-updated"
                        && root.validConversationId(event.id)
                        && ghost === root.activeGhost) {
                    root.fetchSessions(ghost);
                }
            } catch (error) {
                console.warn("ghost: unparseable conversation event:", payload);
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
                && (root.isConversationStreaming(ghost, session.id)
                    || (session.id === root.currentSessionId
                        && session.messageCount === 0));
        });
        return root.orderSessions(list.concat(localLive));
    }

    function validSessionRows(list: var): var {
        return list.filter(session => session && root.validConversationId(session.id));
    }

    function fetchSessions(ghost: string): void {
        const g = ghost || root.activeGhost;
        if (g === "") {
            root.sessions = [];
            return;
        }
        root.request(root, "sessionsRequest", "GET",
            "/api/ghosts/" + encodeURIComponent(g) + "/sessions", null, function (xhr, body) {
                // A reply for a ghost the user has since switched away from is stale.
                if (g !== root.activeGhost) return;
                if (xhr.status !== 200 || !body || !Array.isArray(body.sessions)) {
                    root.sessions = [];
                    root.sessionsError = xhr.status === 200 ? "ghostd sent a malformed session list"
                        : root.describeError(xhr, "GET sessions");
                    return;
                }
                const valid = root.validSessionRows(body.sessions);
                for (const session of valid) {
                    const state = root.turnStates[root.conversationKey(g, session.id)];
                    if (state) state.title = session.title || "";
                }
                root.sessions = root.mergeSessionListing(g, valid);
                root.syncDetachedTurns(g, valid);
                root.settlePendingHarnesses(g, valid);
                root.sessionsError = "";
                const current = root.sessions.find(session => session && session.id === root.currentSessionId);
                if (root.hudVisible && current && current.unread === true)
                    root.markConversationRead(g, current.id);
            });
    }

    /** Follow the listing's `running` for turns this HUD has no stream for; one ending reloads its transcript. */
    function syncDetachedTurns(ghost: string, list: var): void {
        for (const session of list) {
            const running = session.running === true;
            const state = running ? root.ensureTurnState(ghost, session.id)
                : root.turnStates[root.conversationKey(ghost, session.id)];
            if (!state || state.streaming || (!running && !state.detached)) continue;
            if (state.detached !== running) {
                state.detached = running;
                // Nothing of this HUD's last turn describes another client's.
                state.activity = "";
                state.toolActivities = [];
                state.followUpQueue = [];
            }
            // ghostd announces each pass too (a follow-up, a stop hook): with no
            // stream here, the transcript and the queue are read again each time.
            if (root.isActiveTurn(state)) {
                root.loadConversationTranscript(state, false);
                root.fetchQueueFor(state);
            }
            root.projectTurnFields(state);
        }
    }

    /**
     * Start a fresh conversation for the active ghost. An already-blank draft
     * is reused — there is only ever one unstarted "New conversation". The
     * daemon creates the transcript lazily on the first turn and titles it
     * afterwards; until then the row is local to the HUD.
     */
    function newConversation(): void {
        if (root.activeGhost === "") return;
        root.finishNewConversation();
    }

    function isUnstartedSession(session: var): bool {
        return !!session && session.messageCount === 0
            && (session.title === null || session.title === ""
                || session.title === undefined);
    }

    function conversationHasOwnerText(id: string): bool {
        const listed = root.sessions.find(function (session) {
            return session && session.id === id;
        });
        if (listed && typeof listed.messageCount === "number"
                && listed.messageCount > 0)
            return true;
        const state = root.turnStates[root.conversationKey(root.activeGhost, id)];
        if (state && state.transcriptLoad) return true;
        if (state && state.hydratedRowCount > 0) return true;
        if (state && Array.isArray(state.rows) && state.rows.some(function (row) {
            return row && row.role === "user"
                && typeof row.text === "string" && row.text !== "";
        })) return true;
        return false;
    }

    function isCurrentConversationUnstarted(): bool {
        const id = root.currentSessionId;
        if (id === "") return false;
        return !root.conversationHasOwnerText(id);
    }

    function finishNewConversation(): void {
        const ghost = root.activeGhost;
        if (ghost === "") return;
        if (root.isCurrentConversationUnstarted()) {
            root.ensureLocalSessionRow(ghost, root.currentSessionId, 0);
            return;
        }
        const previous = root.activeTurnState(false);
        if (previous) {
            root.captureActiveTurn(previous);
            root.cancelTranscriptLoad(previous);
        }
        const id = root.mintConversationId();
        root.sessionIds[ghost] = id;
        root.currentSessionId = id;
        root.ensureTurnState(ghost, id);
        root.showTurnState(ghost, id);
        root.ensureLocalSessionRow(ghost, id, 0);
    }

    /**
     * List a conversation the daemon has not persisted yet: 0 messages for a
     * blank draft, 1 for one just sent. A row already listed keeps its count.
     */
    function ensureLocalSessionRow(ghost: string, id: string, messageCount: int): void {
        if (ghost !== root.activeGhost || id === "") return;
        const existing = root.sessions.find(function (session) {
            return session && session.id === id;
        });
        if (existing) {
            root.sessions = root.orderSessions(root.sessions);
            return;
        }
        if (!root.validConversationId(id)) return;
        const now = new Date().toISOString();
        root.sessions = root.orderSessions(root.sessions.concat([{
            id: id,
            title: null,
            preview: null,
            harness: null,
            createdAt: now,
            updatedAt: now,
            messageCount: messageCount,
            pinned: false,
            unread: false,
            localOnly: true
        }]));
    }

    function deleteConversation(id: string): void {
        const ghost = root.activeGhost;
        if (ghost === "" || id === "" || root.deletingSessionId !== "") return;
        if (root.isConversationStreaming(ghost, id)) {
            root.sessionsError = "Cancel the current answer before deleting this conversation";
            return;
        }
        root.deletingSessionId = id;
        root.sessionsError = "";
        root.request(root, "deleteSessionRequest", "DELETE", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(id), null, function (xhr) {
                if (xhr.status === 200) {
                    const key = root.conversationKey(ghost, id);
                    const kept = Object.assign({}, root.turnStates);
                    root.cancelTranscriptLoad(kept[key]);
                    delete kept[key];
                    root.turnStates = kept;
                    root.updateLiveConversationKeys();
                    if (ghost === root.activeGhost) {
                        root.sessions = root.sessions.filter(session => session.id !== id);
                        if (root.currentSessionId === id) {
                            root.sessionIds[ghost] = "";
                            root.currentSessionId = "";
                            root.clearTurnProjection();
                        }
                        root.sessionsError = "";
                        root.fetchSessions(ghost);
                    }
                } else if (ghost === root.activeGhost) {
                    root.sessionsError = root.describeError(xhr, "DELETE conversation");
                }
                // The dialog observes this field to settle. Publish the outcome
                // first so a failure cannot look like a successful dismissal.
                root.deletingSessionId = "";
            });
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
        const local = root.sessions.find(function (session) {
            return session && session.id === id;
        });
        if (local && local.localOnly === true) return;
        root.request(root, "pinSessionRequest", "PUT", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(id) + "/pin", { pinned: pinned }, function (xhr) {
                if (ghost !== root.activeGhost || xhr.status === 200) return;
                root.sessionsError = root.describeError(xhr, "PUT pin conversation");
                // The optimistic reorder is now a lie; take the server's truth.
                root.fetchSessions(ghost);
            });
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
        root.request(root, "renameSessionRequest", "PUT", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(id) + "/title", { title: next }, function (xhr, body) {
                if (ghost !== root.activeGhost) return;
                if (xhr.status !== 200) {
                    root.applySessionTitle(id, previous);
                    root.sessionsError = root.refusal(xhr, "PUT conversation title");
                } else if (body && (body.title === null || typeof body.title === "string")) {
                    // The daemon has the last word on the title it wrote; an
                    // unreadable echo leaves the optimistic row, which says what was sent.
                    root.applySessionTitle(id, body.title || null);
                }
            });
    }

    function applySessionTitle(id: string, title: var): void {
        root.sessions = root.sessions.map(function (session) {
            return session && session.id === id
                ? Object.assign({}, session, { title: title })
                : session;
        });
    }

    function collapseUnstartedSessions(list: var): var {
        let draft = null;
        const kept = [];
        for (let index = 0; index < list.length; index++) {
            const session = list[index];
            if (!session) continue;
            // Only HUD drafts collapse; a listed conversation never does.
            if (!(session.localOnly === true && root.isUnstartedSession(session))) {
                kept.push(session);
                continue;
            }
            if (draft === null || session.id === root.currentSessionId)
                draft = session;
            else if (draft.id !== root.currentSessionId) {
                if (root.sessionTime(session) > root.sessionTime(draft)) draft = session;
            }
        }
        if (draft) kept.push(draft);
        return kept;
    }

    function orderSessions(list: var): var {
        return root.collapseUnstartedSessions(list).sort(function (a, b) {
            const pinnedA = a.pinned === true ? 1 : 0;
            const pinnedB = b.pinned === true ? 1 : 0;
            if (pinnedA !== pinnedB) return pinnedB - pinnedA;
            return root.sessionTime(b) - root.sessionTime(a);
        });
    }

    /** When a conversation last changed, for ordering; 0 when it never says. */
    function sessionTime(session: var): real {
        return Date.parse(session.updatedAt || session.createdAt || "") || 0;
    }

    /** Make one conversation the ghost's active one, clearing everything the last one owned. */
    function adoptConversation(ghost: string, id: string): void {
        const previous = root.activeTurnState(false);
        if (previous) {
            root.captureActiveTurn(previous);
            if (previous.sessionId !== id) root.cancelTranscriptLoad(previous);
        }
        root.sessionIds[ghost] = id;
        root.currentSessionId = id;
        root.showTurnState(ghost, id);
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
        if (id === root.currentSessionId) {
            if (!root.streaming) root.finishOpenConversation(id);
            return;
        }
        root.finishOpenConversation(id);
    }

    function finishOpenConversation(id: string): void {
        const ghost = root.activeGhost;
        if (ghost === "" || id === "") return;
        root.adoptConversation(ghost, id);
        root.markConversationRead(ghost, id);
        const state = root.ensureTurnState(ghost, id);
        if (state.streaming) return;
        root.loadConversationTranscript(state, true);
        // Another client's running turn may already hold follow-ups.
        root.fetchQueueFor(state);
    }

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
        root.request(root.readSessionRequests, root.conversationKey(ghost, id), "PUT",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/sessions/" + encodeURIComponent(id) + "/read",
            {}, function (xhr) {
                if (ghost === root.activeGhost && xhr.status !== 200) root.fetchSessions(ghost);
            });
    }

    function markCurrentConversationRead(): void {
        if (!root.hudVisible || root.activeGhost === "" || root.currentSessionId === "") return;
        root.markConversationRead(root.activeGhost, root.currentSessionId);
    }

    function refreshCurrentTranscript(): void {
        root.loadConversationTranscript(root.activeTurnState(false), false);
    }

    function transcriptLoadIsCurrent(state: var, load: var): bool {
        return !!state && !!load && state.transcriptLoad === load
            && state.transcriptGeneration === load.generation && !state.streaming;
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
        state.transcriptLoad = null;
        if (!root.isActiveTurn(state)) return;
        root.sessionsError = message;
        if (unreachable) root.fail(message);
    }

    function completeTranscriptLoad(state: var, load: var): void {
        if (!root.transcriptLoadIsCurrent(state, load)) return;
        state.transcriptLoad = null;
        root.rehydrateTurn(state, load.messages);
        root.reachable = true;
        if (root.isActiveTurn(state)) root.sessionsError = "";
    }

    function requestTranscriptPage(state: var, load: var): void {
        if (!root.transcriptLoadIsCurrent(state, load)) return;
        if (load.pageCount >= root.transcriptMaxPages) {
            root.failTranscriptLoad(state, load,
                "Transcript is too large to load safely", false);
            return;
        }
        const requestedOffset = load.nextOffset;
        load.pageCount += 1;
        root.request(state, "transcriptRequest", "GET", "/api/ghosts/" + encodeURIComponent(state.ghost)
            + "/sessions/" + encodeURIComponent(state.sessionId) + "/transcript"
            + "?limit=" + root.transcriptPageLimit + "&offset=" + requestedOffset, null, function (xhr, body) {
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
                if (!body || body.id !== state.sessionId || !Array.isArray(body.messages))
                    throw new Error("transcript identity mismatch");
                if (typeof body.total !== "number" || !Number.isFinite(body.total)
                        || Math.floor(body.total) !== body.total || body.total < 0)
                    throw new Error("invalid transcript total");
                if (typeof body.truncated !== "boolean")
                    throw new Error("invalid transcript truncation marker");
                if (load.total < 0) load.total = body.total;
                else if (load.total !== body.total)
                    throw new Error("transcript changed between pages");
                // The daemon clamps `limit` silently, so a page shorter than
                // asked for is its clamp speaking, not corruption — the next
                // request just continues from where this one ended. Only a
                // page that overshoots what remains is inconsistent.
                const expected = Math.min(root.transcriptPageLimit,
                    load.total - requestedOffset);
                if (expected < 0 || body.messages.length > expected)
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
                    "ghostd sent an inconsistent transcript page", false);
            }
        }, () => root.transcriptLoadIsCurrent(state, load));
    }

    /**
     * Replace the transcript view with a conversation's stored messages,
     * regrouped by TurnBlocks.rows into the rows the live stream would have made.
     */
    function rehydrateTurn(state: var, messages: var): void {
        state.activity = "";
        state.limitNotice = "";
        const rows = TurnBlocks.rows(messages);
        state.hydratedRowCount = rows.length;
        const hydrated = [];
        for (const row of rows) {
            hydrated.push({
                role: row.role,
                text: row.text + (row.contentTruncated
                    ? "\n\n*[Saved message truncated]*" : ""),
                toolActivity: row.role === "assistant"
                    ? root.messageTools(row.parts) : [],
                error: row.error || "",
                pending: false
            });
        }
        root.replaceTurnRows(state, hydrated);
        root.projectTurnFields(state);
    }

    function messageTools(parts: var): var {
        const tools = [];
        parts.forEach(part => {
            if (part.type !== "toolCall") return;
            tools.push({
                id: part.id || ("history-" + Math.random()),
                name: part.name || "tool",
                // A failed call stays failed on reload so Bubble keeps it in the reading column.
                status: part.failed === true ? "failed" : "complete",
                arguments: part.arguments || ({}),
                // A stored call keeps no cwd, so a relative path offers no file chip.
                cwd: ""
            });
        });
        return tools;
    }

    function send(text: string): void {
        const prompt = text.trim();
        if (prompt === "" || root.streaming || root.activeGhost === "") return;
        const ghost = root.activeGhost;
        const sessionId = root.ensureSession(ghost);
        const state = root.ensureTurnState(ghost, sessionId);
        if (!state || sessionId === "") return;
        root.ensureLocalSessionRow(ghost, sessionId, 1);
        root.captureActiveTurn(state);

        root.beginTurnFor(state);
        root.appendTurnRow(state, {
            role: "user", text: prompt, toolActivity: [], error: "", pending: false
        });
        root.openAssistantRowFor(state);

        const xhr = root.newRequest();
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
            JSON.stringify({ prompt: prompt, sessionId: state.sessionId }));
    }

    /** Stop the active conversation's turn in ghostd, which runs it regardless of this HUD's stream. */
    function cancel(): void {
        const state = root.activeTurnState(false);
        if (!state) return;
        root.captureActiveTurn(state);
        root.request(state, "stopRequest", "POST", "/api/ghosts/" + encodeURIComponent(state.ghost)
            + "/sessions/" + encodeURIComponent(state.sessionId) + "/stop", {}, function () {});
        // Another client's turn ends in the listing, which reloads what it left.
        if (state.detached) return;
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
        root.flushTurn(state, true);
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

    function beginTurnFor(state: var): void {
        root.cancelTranscriptLoad(state);
        root.resetAssistantSegmentFor(state);
        state.assistantRow = -1;
        state.consumed = 0;
        state.frameBuffer = "";
        root.resetInteractionStateFor(state);
        state.activity = "waiting for ghostd";
        state.lastError = "";
        state.limitNotice = "";
        state.streaming = true;
        state.lastStreamActivity = Date.now();
        root.updateLiveConversationKeys();
    }

    // beginTurnFor and the reset*For helpers change only the state; the caller
    // projects it with projectTurnFields.

    function resetAssistantSegmentFor(state: var): void {
        state.parts = [];
        state.toolActivities = [];
        state.presentationDirty = true;
    }

    function resetInteractionStateFor(state: var): void {
        state.activity = "";
        state.followUpQueue = [];
        state.queueSubmitting = false;
        state.queueError = "";
    }

    /** Consume the cumulative Qt XHR body and settle every readyState-4 path. */
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

    function expireTurnStream(state: var): void {
        if (!state.streaming) return;
        const xhr = state.request;
        state.request = null;
        root.reachable = false;
        root.endTurnState(state, "the stream stopped responding");
        if (xhr && xhr.readyState !== 4) xhr.abort();
    }

    /**
     * The active session id for a ghost, minting one on first use. A conversation
     * is created lazily by the daemon on the first turn; until then it lives only
     * as this id, which `sessionId` carries into the POST. Reuses the
     * current unstarted draft so New and Send cannot mint a second blank chat.
     */
    function ensureSession(ghost: string): string {
        if (!root.sessionIds[ghost]) {
            if (ghost === root.activeGhost && root.isCurrentConversationUnstarted()) {
                root.sessionIds[ghost] = root.currentSessionId;
            } else {
                root.sessionIds[ghost] = root.mintConversationId();
            }
        }
        if (ghost === root.activeGhost) root.currentSessionId = root.sessionIds[ghost];
        root.ensureTurnState(ghost, root.sessionIds[ghost]);
        return root.sessionIds[ghost];
    }


    /**
     * Feed a raw chunk of the response body. Chunk boundaries are network
     * boundaries, never frame boundaries, so the trailing partial frame is
     * carried over to the next call.
     */
    function ingestTurn(state: var, chunk: string): void {
        if (chunk === "") return;
        const parsed = root.sseFrames(state.frameBuffer, chunk);
        state.frameBuffer = parsed.rest;
        for (const payload of parsed.payloads) {
            try {
                root.handleTurnEvent(state, JSON.parse(payload));
            } catch (error) {
                console.warn("ghost: unparseable SSE frame:", payload);
            }
        }
    }

    function handleTurnEvent(state: var, event: var): void {
        switch (event.type) {
        case "start":
            state.activity = "";
            break;
        case "harness":
            state.activity = "starting:" + (event.harness || "");
            break;
        case "text_start":
            root.textPart(state, event.contentIndex);
            state.presentationDirty = true;
            state.activity = "writing";
            break;
        case "text_delta":
            root.textPart(state, event.contentIndex).text += event.delta;
            state.presentationDirty = true;
            break;
        case "text_end":
            root.textPart(state, event.contentIndex).text = event.content;
            state.presentationDirty = true;
            break;
        case "queue":
            root.applyQueueFor(state, event);
            break;
        case "owner_message":
            root.receiveOwnerMessageFor(state, event.text || "");
            break;
        case "hook_start":
            // ActivityLine shows the name of the hook the turn is waiting on.
            state.activity = "hook:" + (event.name || "");
            break;
        case "hook_end":
            state.activity = "";
            break;
        case "session_stop_continued":
            root.receiveSessionStopContinuedFor(state, event.reason || "");
            break;
        case "thinking":
            // Reasoning stays out of the transcript; the activity line reads
            // its newest line, so only a tail is kept.
            state.activity = "thinking:" + ((state.activity.startsWith("thinking:") ? state.activity.slice(9) : "")
                + (event.delta || "")).slice(-600);
            break;
        case "tool_execution_start":
            state.activity = event.toolName;
            // The daemon drops a repeated call id, so each start is a new call.
            state.parts.push({ type: "toolCall" });
            state.presentationDirty = true;
            root.updateToolFor(state, event.id, {
                name: event.toolName,
                status: "running",
                arguments: event.arguments || ({}),
                cwd: typeof event.cwd === "string" ? event.cwd : ""
            });
            break;
        // An update or end only ever follows its call's start.
        case "tool_execution_update":
            root.updateToolFor(state, event.id, { summary: event.summary || "" });
            break;
        case "tool_execution_end":
            state.activity = "";
            root.updateToolFor(state, event.id, {
                status: event.isError ? "failed" : "complete",
                summary: event.summary || ""
            });
            break;
        case "limit_reached":
            // The terminal error that follows says "provider failed"; this
            // says what actually happened.
            state.limitNotice = root.limitNoticeText(event);
            state.activity = "limit reached";
            break;
        case "done":
            root.endTurnState(state, "");
            break;
        case "error":
            if (event.reason === "aborted") {
                root.cancelTurn(state);
                break;
            }
            root.endTurnState(state,
                state.limitNotice || event.errorMessage || ("the ghost stopped: " + event.reason));
            break;
        default:
            console.warn("ghost: unknown turn event:", event.type);
        }
        root.projectTurnFields(state);
    }

    /**
     * The turn's text part for a content index, appended on first sight. The
     * daemon closes a text block before a tool call starts, so arrival order
     * is content order and `parts` reads like a stored message's content.
     */
    function textPart(state: var, index: int): var {
        for (let i = state.parts.length - 1; i >= 0; i--) {
            const part = state.parts[i];
            if (part.type === "text" && part.index === index) return part;
        }
        root.openMessageAfterToolsFor(state);
        const part = { type: "text", index: index, text: "" };
        state.parts.push(part);
        return part;
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
        // Only a start creates a card, and it names every field a card reads;
        // a late end for a call in an earlier message has no card here.
        if (!found) {
            if (patch.name === undefined) return;
            next.push(Object.assign({ id: id }, patch));
        }
        state.toolActivities = next;
        root.syncToolActivityFor(state);
    }

    function syncToolActivityFor(state: var): void {
        if (state.assistantRow < 0 || state.assistantRow >= state.rows.length) return;
        root.setTurnRow(state, state.assistantRow, "toolActivity", state.toolActivities);
        root.projectTurnFields(state);
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

    function flushTurn(state: var, force: bool): void {
        if (state.assistantRow < 0 || state.assistantRow >= state.rows.length) return;
        if (!force && !state.presentationDirty) return;
        const body = TurnBlocks.fromParts(state.parts);
        const row = state.rows[state.assistantRow];
        if (row.text !== body)
            root.setTurnRow(state, state.assistantRow, "text", body);
        state.presentationDirty = false;
        root.projectTurnFields(state);
    }

    /** "claude usage limit reached", from a limit_reached event. */
    function limitNoticeText(event: var): string {
        return String(event.harness) + " " + String(event.kind || "limit").replace("_", " ") + " reached";
    }

    function notificationTitle(state: var): string {
        const listed = state.ghost === root.activeGhost
            ? root.sessions.find(session => session.id === state.sessionId) : null;
        const title = (listed && listed.title) || state.title;
        if (title) return String(title);
        const first = state.rows.find(row => row.role === "user" && row.text);
        return first ? String(first.text) : "Conversation";
    }

    function endTurnState(state: var, errorMessage: string): void {
        // The terminal event, EOF fallback, watchdog and abort can race. Only
        // the first one owns settlement and emits a terminal shell signal.
        if (!state.streaming) return;
        root.settleToolActivityFor(state, false);
        state.streaming = false;
        // Flushes are throttled; force one so the row shows the turn's final
        // text.
        root.flushTurn(state, true);
        root.resetInteractionStateFor(state);
        let text = "";
        if (state.assistantRow >= 0 && state.assistantRow < state.rows.length) {
            root.setTurnRow(state, state.assistantRow, "pending", false);
            if (errorMessage !== "")
                root.setTurnRow(state, state.assistantRow, "error", errorMessage);
            text = state.rows[state.assistantRow].text;
        }
        state.assistantRow = -1;
        root.updateLiveConversationKeys();
        if (errorMessage !== "") {
            state.lastError = errorMessage;
            root.turnFailed(state.ghost, errorMessage, state.sessionId, root.notificationTitle(state));
            if (state.ghost === root.activeGhost) Qt.callLater(function () {
                root.fetchSessions(state.ghost);
            });
        } else {
            // A turn that completed is proof the daemon answered; drop any stale
            // error banner so it does not linger under a good reply.
            state.lastError = "";
            root.turnFinished(state.ghost, text, state.sessionId, root.notificationTitle(state));
        }
        root.projectTurnFields(state);
        Qt.callLater(function () {
            root.loadConversationTranscript(state, false);
        });
        if (errorMessage === "" && root.hudVisible && root.isActiveTurn(state))
            root.markConversationRead(state.ghost, state.sessionId);
    }

    function receiveOwnerMessageFor(state: var, text: string): void {
        const message = text.trim();
        if (!state.streaming || message === "") return;
        // The `queue` event just before this one already took its chip away.
        root.insertTurnBreakFor(state, "user", message);
    }

    function receiveSessionStopContinuedFor(state: var, reason: string): void {
        const notice = String(reason || "").trim();
        if (!state.streaming || notice === "") return;
        root.insertTurnBreakFor(state, "hook", notice);
    }

    /**
     * End the current assistant segment where a `role` row enters mid-turn,
     * append that row, and open a fresh assistant segment after it.
     */
    function insertTurnBreakFor(state: var, role: string, text: string): void {
        const hasAssistant = state.assistantRow >= 0
            && state.assistantRow < state.rows.length;
        const emptyPlaceholder = hasAssistant
            && state.assistantRow === state.rows.length - 1
            && state.parts.length === 0;
        if (emptyPlaceholder) {
            // The daemon can dequeue a batch of owner messages before the next
            // harness pass. Keep those as consecutive rows rather than
            // manufacturing a blank assistant row between each pair.
            root.removeTurnRow(state, state.assistantRow);
            state.assistantRow = -1;
        } else {
            root.settleToolActivityFor(state, false);
            // The HTTP turn continues, but this assistant segment ends where
            // the new row enters; flush what it said.
            root.flushTurn(state, true);
            if (hasAssistant)
                root.setTurnRow(state, state.assistantRow, "pending", false);
        }
        state.activity = "";
        root.appendTurnRow(state, {
            role: role, text: text, toolActivity: [], error: "", pending: false
        });
        root.openAssistantRowFor(state);
        root.resetAssistantSegmentFor(state);
        root.projectTurnFields(state);
    }

    /** Append the pending assistant row the stream writes into. */
    function openAssistantRowFor(state: var): void {
        root.appendTurnRow(state, {
            role: "assistant", text: "", toolActivity: [], error: "", pending: true
        });
        state.assistantRow = state.rows.length - 1;
    }

    /**
     * Text after a tool call is the ghost's next message: settle the row that
     * holds the calls and give the new text a row of its own.
     */
    function openMessageAfterToolsFor(state: var): void {
        if (!state.parts.some(part => part.type === "toolCall")) return;
        root.settleToolActivityFor(state, false);
        root.flushTurn(state, true);
        if (state.assistantRow >= 0 && state.assistantRow < state.rows.length)
            root.setTurnRow(state, state.assistantRow, "pending", false);
        root.openAssistantRowFor(state);
        root.resetAssistantSegmentFor(state);
    }


    /** Both callers project afterwards; an unchanged queue keeps its array so its chips are not rebuilt. */
    function applyQueueFor(state: var, body: var): void {
        const next = Array.isArray(body.followUp) ? body.followUp : [];
        if (JSON.stringify(next) !== JSON.stringify(state.followUpQueue)) state.followUpQueue = next;
    }

    function fetchQueueFor(state: var): void {
        if (!(state.streaming || state.detached) || state.queueStatusRequest) return;
        root.request(state, "queueStatusRequest", "GET", "/api/ghosts/" + encodeURIComponent(state.ghost)
            + "/sessions/" + encodeURIComponent(state.sessionId) + "/queue", null, function (xhr, body) {
                if (xhr.status === 200) {
                    if (body) root.applyQueueFor(state, body);
                    else state.queueError = "ghostd sent malformed queue state";
                }
                root.projectTurnFields(state);
            }, () => state.streaming || state.detached);
    }

    /** Queue a follow-up for the running turn; the daemon runs it after the current pass. */
    function queueMessage(text: string): void {
        const prompt = text.trim();
        const state = root.activeTurnState(false);
        if (!state) return;
        root.captureActiveTurn(state);
        if (prompt === "" || state.queueSubmitting || !(state.streaming || state.detached)) return;
        state.queueSubmitting = true;
        state.queueError = "";
        // Show the chip immediately; the stream's `queue` event removes it
        // once the daemon starts the pass that carries it.
        state.followUpQueue = state.followUpQueue.concat([prompt]);
        root.request(state, "queueRequest", "POST", "/api/ghosts/" + encodeURIComponent(state.ghost)
            + "/sessions/" + encodeURIComponent(state.sessionId) + "/queue", { text: prompt },
            function (xhr, body) {
                state.queueSubmitting = false;
                if (xhr.status !== 200) {
                    state.queueError = root.describeError(xhr, "POST queue");
                    // The refused text goes back to the composer, not into a chip.
                    const at = state.followUpQueue.lastIndexOf(prompt);
                    if (at >= 0) state.followUpQueue = state.followUpQueue.filter((_, index) => index !== at);
                    root.fetchQueueFor(state);
                    root.composerDraft(prompt);
                } else if (body) {
                    root.applyQueueFor(state, body);
                    state.queueError = "";
                } else {
                    state.queueError = "ghostd sent malformed queue state";
                }
                root.projectTurnFields(state);
            });
        root.projectTurnFields(state);
    }


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

    /** A refusal as the daemon words it, else as describeError would. */
    function refusal(xhr: var, what: string): string {
        return root.errorDetail(xhr) || root.describeError(xhr, what);
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
