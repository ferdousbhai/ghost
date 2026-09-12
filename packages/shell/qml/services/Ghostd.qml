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
// page cannot. Nothing here opens a request directly — `dispatch()` does, so
// the header and the rotation retry exist in one place rather than fourteen.
import Quickshell
import Quickshell.Io
import QtQuick
import "CommandTranscript.js" as CommandTranscript
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

    // Remote access is daemon-global rather than ghost- or conversation-scoped,
    // so its owner/request state survives ghost and conversation switches.

    function validUpdate(update: var): bool {
        return !!update && typeof update === "object" && !Array.isArray(update)
            && typeof update.latest === "string" && update.latest !== ""
            && typeof update.command === "string" && update.command !== "";
    }

    /** What the daemon knows about newer releases; nothing else in /api/status is read here. */
    function fetchDaemonStatus(): void {
        if (root.statusRequest && root.statusRequest.readyState !== 4) return;
        const xhr = typeof root.statusRequestFactory === "function"
            ? root.statusRequestFactory() : new XMLHttpRequest();
        root.statusRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.statusRequest) return;
            root.statusRequest = null;
            if (xhr.status !== 200) return;
            try {
                const body = JSON.parse(xhr.responseText);
                root.updateAvailable = root.validUpdate(body.update) ? body.update : null;
                root.reachable = true;
            } catch (error) {
                root.updateAvailable = null;
            }
        };
        root.dispatch(xhr, "GET", "/api/status", ({}), null,
            function () { return root.statusRequest === xhr; });
    }

    function makeRemoteRequest(): var {
        return typeof root.remoteRequestFactory === "function"
            ? root.remoteRequestFactory() : new XMLHttpRequest();
    }

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
        const request = root.remoteQrRequest;
        root.remoteQrRequest = null;
        root.remoteQrSource = "";
        if (request && request.readyState !== 4) request.abort();
    }

    function retireRemoteRequests(): void {
        const request = root.remoteRequest;
        root.remoteRequest = null;
        root.remoteLoading = false;
        root.remoteMutating = false;
        if (request && request.readyState !== 4) request.abort();
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
        if (root.remoteQrRequest && root.remoteQrRequest.readyState !== 4) return;
        const xhr = root.makeRemoteRequest();
        root.remoteQrRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.remoteQrRequest) return;
            root.remoteQrRequest = null;
            if (root.remoteUrl !== expectedUrl) return;
            if (xhr.status === 200) {
                const svg = String(xhr.responseText || "");
                if (svg.indexOf("<svg") < 0) {
                    root.remoteError = "ghostd sent malformed remote-access QR code";
                    return;
                }
                root.remoteQrSource = "data:image/svg+xml;charset=utf-8,"
                    + encodeURIComponent(svg);
            } else {
                root.remoteError = root.describeError(xhr, "GET remote-access QR code");
            }
        };
        root.dispatch(xhr, "GET", "/api/remote/qr.svg", ({}), null,
            function () { return root.remoteQrRequest === xhr; });
    }

    function refreshRemote(): void {
        if (root.remoteMutating) return;
        if (root.remoteRequest && root.remoteRequest.readyState !== 4) return;
        const xhr = root.makeRemoteRequest();
        root.remoteRequest = xhr;
        root.remoteLoading = true;
        root.remoteError = "";
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.remoteRequest) return;
            root.remoteRequest = null;
            root.remoteLoading = false;
            if (xhr.status === 200) {
                try {
                    if (!root.applyRemoteStatus(JSON.parse(xhr.responseText)))
                        throw new Error("invalid remote status");
                    root.reachable = true;
                } catch (error) {
                    root.remoteError = "ghostd sent malformed remote-access status";
                }
            } else {
                root.remoteError = root.describeError(xhr, "GET remote access");
            }
        };
        root.dispatch(xhr, "GET", "/api/remote", ({}), null,
            function () { return root.remoteRequest === xhr; });
    }

    function setRemoteEnabled(enabled: bool): void {
        if (root.remoteMutating || typeof enabled !== "boolean") return;
        const previous = root.remoteRequest;
        root.remoteRequest = null;
        if (previous && previous.readyState !== 4) previous.abort();
        const xhr = root.makeRemoteRequest();
        root.remoteRequest = xhr;
        root.remoteLoading = false;
        root.remoteMutating = true;
        root.remoteError = "";
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.remoteRequest) return;
            root.remoteRequest = null;
            root.remoteMutating = false;
            if (xhr.status === 200) {
                try {
                    if (!root.applyRemoteStatus(JSON.parse(xhr.responseText)))
                        throw new Error("invalid remote status");
                    root.reachable = true;
                    root.remoteSetFinished(enabled, true);
                } catch (error) {
                    root.remoteError = "ghostd sent malformed remote-access status";
                    root.remoteSetFinished(enabled, false);
                }
            } else {
                root.remoteError = root.describeError(xhr, "POST remote access");
                root.remoteSetFinished(enabled, false);
            }
        };
        root.dispatch(xhr, "POST", "/api/remote",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ enabled: enabled }),
            function () { return root.remoteRequest === xhr; });
    }

    // Hook status and configuration are daemon-global, independent of any
    // ghost or conversation.

    function makeHooksRequest(): var {
        return typeof root.hooksRequestFactory === "function"
            ? root.hooksRequestFactory() : new XMLHttpRequest();
    }

    /** Retire ownership before abort because test/native XHR may finish inline. */
    function retireHooksRequest(): void {
        const request = root.hooksRequest;
        root.hooksRequest = null;
        root.hooksLoading = false;
        if (request && request.readyState !== 4) request.abort();
    }

    function retireHookConfigRequest(): void {
        const request = root.hookConfigRequest;
        root.hookConfigRequest = null;
        if (request && request.readyState !== 4) request.abort();
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
        root.hookEvents = [];
        root.activeHookCount = 0;
        root.hooksLoaded = false;
        root.hooksStale = false;
        root.hooksError = "";
        root.retireHookConfigRequest();
        root.hookConfig = null;
        root.hookConfigPath = "";
        root.hookConfigLoaded = false;
        root.hookConfigError = "";
        root.hooksConnectionReset(root.hooksEpoch);
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
        if (root.hooksRequest && root.hooksRequest.readyState !== 4) {
            if (!force) return;
            root.retireHooksRequest();
        }
        const xhr = root.makeHooksRequest();
        const epoch = root.hooksEpoch;
        root.hooksRequest = xhr;
        root.hooksLoading = true;
        root.hooksStale = false;
        root.hooksError = "";
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || epoch !== root.hooksEpoch
                    || xhr !== root.hooksRequest) return;
            root.hooksRequest = null;
            root.hooksLoading = false;
            if (xhr.status === 200) {
                try {
                    const status = HookStatus.normalize(JSON.parse(xhr.responseText));
                    if (status === null) throw new Error("invalid hook status");
                    root.activeHooks = status.hooks;
                    root.hookEvents = status.events;
                    root.activeHookCount = status.total;
                    root.hooksLoaded = true;
                    root.hooksStale = false;
                    root.hooksError = "";
                    root.reachable = true;
                } catch (error) {
                    root.hooksStale = root.hooksLoaded;
                    root.hooksError = "ghostd sent malformed hook status";
                }
            } else if (xhr.status === 0) {
                root.failHooksTransport(epoch);
                return;
            } else {
                root.hooksStale = root.hooksLoaded;
                root.hooksError = root.describeError(xhr, "GET hooks");
            }
        };
        root.dispatch(xhr, "GET", "/api/hooks", ({}), null, function () {
            return epoch === root.hooksEpoch && root.hooksRequest === xhr;
        });
    }

    /** Read the owner's hooks.json through the daemon. A 404 means the daemon has no file to edit. */
    function fetchHookConfig(force: bool): void {
        if (!force && (root.hookConfigLoaded || root.hookConfigLoading)) return;
        root.retireHookConfigRequest();
        const xhr = root.makeHooksRequest();
        const epoch = root.hooksEpoch;
        root.hookConfigRequest = xhr;
        root.hookConfigError = "";
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || epoch !== root.hooksEpoch
                    || xhr !== root.hookConfigRequest) return;
            root.hookConfigRequest = null;
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
        };
        root.dispatch(xhr, "GET", "/api/hooks/config", ({}), null, function () {
            return epoch === root.hooksEpoch && root.hookConfigRequest === xhr;
        });
    }

    /**
     * Replace the owner's hooks.json whole. The daemon's loader is the only
     * validator: a refused document comes back as its message and nothing
     * changes; an admitted one is live at once, so the status is re-read.
     */
    function writeHookConfig(document: var): void {
        if (root.hookConfigBusy || !root.hookConfigAvailable) return;
        const xhr = root.makeHooksRequest();
        const epoch = root.hooksEpoch;
        root.hookConfigMutation = xhr;
        root.hookConfigError = "";
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.hookConfigMutation) return;
            root.hookConfigMutation = null;
            if (epoch !== root.hooksEpoch) return;
            let ok = false;
            if (xhr.status === 200) {
                ok = root.adoptHookConfig(xhr);
            } else if (xhr.status === 400) {
                // The loader's message names the field; that is the whole story.
                const detail = root.errorDetail(xhr);
                root.hookConfigError = detail !== "" ? detail : root.describeError(xhr, "PUT hooks config");
            } else {
                root.hookConfigError = root.describeError(xhr, "PUT hooks config");
            }
            root.hookConfigWriteFinished(ok);
            if (ok) root.fetchHooks(true);
        };
        root.dispatch(xhr, "PUT", "/api/hooks/config", ({ "Content-Type": "application/json" }),
            JSON.stringify(document), function () { return xhr === root.hookConfigMutation; });
    }

    /** One tray or roster intent, applied to the selected destination. */
    function performNavigation(action: var): void {
        if (!action) return;
        if (action.kind === "newConversation") root.finishNewConversation();
        else if (action.kind === "selectGhost") root.finishSelectGhost(action.name);
        else if (action.kind === "openConversation") root.finishOpenConversation(action.id);
        else if (action.kind === "createdGhost") root.finishCreatedGhostSelection(action.name);
        else if (action.kind === "openConversationForGhost") {
            if (action.name !== root.activeGhost) root.finishSelectGhost(action.name);
            root.finishOpenConversation(action.id);
        } else if (action.kind === "newConversationForGhost") {
            if (action.name !== root.activeGhost) root.finishSelectGhost(action.name);
            root.finishNewConversation();
        }
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
    /** The last listing body verbatim: an unchanged directory must not rebuild
        the list's rows. */

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
    property var hookEvents: []
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

    // Effective commands are conversation-scoped: an extension can register
    // them while a session is built, so a ghost-level cache would quietly show
    // the wrong palette after switching conversations.
    property var commands: []
    property bool commandsLoading: false
    property string commandsError: ""
    /** Why there is no catalog to show, when that is not an error: pi-only on a Claude conversation. */
    property string commandsNotice: ""
    property string commandsGhost: ""
    property string commandsSessionId: ""

    // Exact resources admitted to one principal conversation. Paths are
    // owner-only, so this state is never reused by the remote viewer.
    property var sessionResources: null
    property bool sessionResourcesLoading: false
    property string sessionResourcesError: ""
    /** True while the error only says the runtime has not started yet. */
    property bool sessionResourcesPending: false
    property string sessionResourcesGhost: ""
    property string sessionResourcesSessionId: ""

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

    // A ghost owns many conversations (pi sessions). The daemon persists them;
    // the HUD lists them per ghost, resumes one by loading its transcript, and
    // starts a fresh one on demand. This fixes #26 — a restart no longer loses
    // history, because a conversation lives in the daemon keyed by session id.
    property var sessions: []
    property string currentSessionId: ""
    /** Non-empty when a sessions/transcript fetch failed. */
    property string sessionsError: ""
    property string deletingSessionId: ""
    /** Why the last branch refused, or "". Kept apart from `sessionsError`:
        that one renders in the conversation list, and a branch is asked for
        from a message, half a window away from it. */
    property string branchError: ""
    property bool hudVisible: false

    // The ghost's opening line for an empty chat. Pure upside: the HUD paints
    // its own static invitation the instant the card appears and only swaps to
    // this if and when it arrives, so a slow, absent, or failed greeting costs
    // the owner nothing. Every failure path therefore leaves it "".
    property string greeting: ""
    property bool greetingOnboarding: false
    property string greetingGhost: ""

    property alias transcript: transcriptModel
    property var commandExchanges: ({})
    property int hydratedRowCount: 0
    /** True when the open conversation's stored history has an unavailable prefix. */
    property bool transcriptHistoryTruncated: false
    property string commandTurnKey: ""
    property int commandTurnIndex: -1
    property int commandTurnAnchor: 0
    property bool streaming: false
    property string activity: ""
    property var pendingAsk: null
    property bool askSubmitting: false
    property string askError: ""
    property var steeringQueue: []
    property var followUpQueue: []
    property bool queueSubmitting: false
    property string queueError: ""

    signal turnFinished(string ghost, string text)
    signal turnFailed(string ghost, string message)
    signal queueMessageRejected(string text)
    signal branchDraftReady(string text)
    signal mcpMutationFinished(string action, string server, bool ok)
    signal characterWriteFinished(bool ok)
    signal hookConfigWriteFinished(bool ok)
    signal hooksConnectionReset(int epoch)
    signal remoteSetFinished(bool enabled, bool ok)

    property var providers: []
    property string loginId: ""
    property var loginState: ({})
    property string loginGhost: ""
    /** The daemon route that currently owns loginId. During an optimistic ghost
        rename this remains the old name until the rename XHR succeeds. */
    property string loginRouteGhost: ""
    /** No login request may cross the daemon's atomic rename publication. */
    property bool loginRoutePaused: false
    /** Non-empty while a login request is in flight or has failed to reach ghostd. */
    property string loginError: ""

    property var currentModel: null
    property string modelSource: "none"
    property int availableModelTotal: 0
    /** Non-empty when a model fetch or switch failed. */
    property string modelError: ""
    property string modelWarning: ""

    signal modelRouteCompleted(string role, string target)

    // The XHR must be held by a property. A request whose only reference is the
    // closure it installed on itself is eligible for collection mid-flight.
    property var request: null
    property var listRequest: null
    property int listGeneration: 0
    property var createGhostRequest: null
    property int createGhostGeneration: 0
    /** Test seam; production always constructs the native QML XHR. */
    property var ghostRequestFactory: null
    property var deleteGhostRequest: null
    property var renameGhostRequest: null
    property var renameGhostRequestFactory: null
    property var renameGhostSnapshot: null
    property var renameSessionRequest: null
    /** Login requests have distinct owners so a poll cannot evict an input or
        provider fetch from the GC root, and every one can be retired on close. */
    property var providersRequest: null
    property var loginStartRequest: null
    property var loginPollRequest: null
    property var loginInputRequest: null
    property int loginGeneration: 0
    /** Test seam; production always constructs the native QML XHR. */
    property var loginRequestFactory: null
    property var tokenReloadOverride: null
    readonly property bool loginPolling: loginPoll.running
    property var modelRequest: null
    property int modelGeneration: 0
    property var availRequest: null
    property var setModelRequest: null
    property var sessionsRequest: null
    property var eventsRequest: null
    property string eventsGhost: ""
    property int eventsConsumed: 0
    property string eventsFrameBuffer: ""
    property var characterRequest: null
    property var characterWriteRequest: null
    /** Test seam; production constructs native character XHRs. */
    property var characterRequestFactory: null
    property var remoteRequest: null
    property var statusRequest: null
    /** Test seam; production constructs the native XHR. */
    property var statusRequestFactory: null
    property var remoteQrRequest: null
    /** Test seam; production constructs native QML XHRs. */
    property var remoteRequestFactory: null
    property var hooksRequest: null
    property var hooksRequestFactory: null
    property var hookConfigRequest: null
    property var hookConfigMutation: null
    property var commandsRequest: null
    property var sessionResourcesRequest: null
    /** Test seam; production constructs the native resource-snapshot XHR. */
    property var sessionResourcesRequestFactory: null
    property var mcpRequest: null
    property var mcpMutationRequest: null
    property var greetingRequest: null
    property var transcriptRequestFactory: null
    readonly property int transcriptPageLimit: 1000
    readonly property int transcriptMaxPages: 10
    /** The shell's own patience for a silent stream — three of the daemon's
        15s SSE keepalives missed means that response is no longer live. */
    readonly property int streamSilenceMs: 45000
    property var deleteSessionRequest: null
    property var deleteSessionRequestFactory: null
    property var pinSessionRequest: null
    property var readSessionRequests: ({})
    property var branchRequest: null
    property var branchRequestFactory: null

    property var sessionIds: ({})     // ghost name -> runtime-qualified active id
    property var turnStates: ({})
    property var liveConversationKeys: []
    readonly property bool anyStreaming: root.liveConversationKeys.length > 0
    property var blocks: ({})         // contentIndex -> { kind, text }
    property var toolActivities: []   // stateful cards for the current assistant row
    property var toolIdsByContent: ({})
    property int assistantRow: -1
    property int consumed: 0
    property string frameBuffer: ""
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

    // A login is interactive and multi-step; the daemon models it as a pollable
    // session. We poll once a second while one is running and stop the moment
    // it settles.
    Timer {
        id: loginPoll
        interval: 1000
        repeat: true
        onTriggered: root.pollLogin()
    }

    // Ghost's ask tool pauses the provider turn while the HTTP SSE stream stays
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

    Component.onCompleted: root.refresh()
    Component.onDestruction: root.retireClientRequests()

    onReachableChanged: {
        if (root.reachable) {
            root.establishedConnection = true;
            if (!root.hooksLoaded && !root.hooksLoading) {
                Qt.callLater(function () {
                    if (root.reachable && !root.hooksLoaded && !root.hooksLoading)
                        root.fetchHooks(false);
                });
            }
        } else if (root.establishedConnection) {
            root.beginHooksConnectionEpoch();
        }
    }

    function retireClientRequests(): void {
        root.cancelLogin();
        root.cancelAllTranscriptLoads();
        root.retireRemoteRequests();
        root.retireHooksRequest();
    }
    onActiveGhostChanged: {
        root.modelGeneration += 1;
        root.modelRequest = null;
        // A rename moves loginGhost before activeGhost, preserving a live flow.
        // Any other selection change makes the old ghost's requests stale.
        if (root.loginGhost === "" || root.loginGhost !== root.activeGhost)
            root.cancelLogin();
        root.connectConversationEvents(root.activeGhost);
    }

    function token(): string {
        if (root.apiToken === "") {
            const text = apiTokenFile.text();
            root.apiToken = text ? text.trim() : "";
        }
        return root.apiToken;
    }

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


    // The owner's board: Documents/board.md, parsed by the daemon and shown
    // read-only. Polled while its pane is up; edits happen in the file.
    property var board: null
    property string boardError: ""
    property bool boardLoading: false
    property var boardRequest: null
    property var boardRequestFactory: null

    function makeBoardRequest(): var {
        return typeof root.boardRequestFactory === "function"
            ? root.boardRequestFactory() : new XMLHttpRequest();
    }

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
        if (root.boardRequest && root.boardRequest.readyState !== 4) return;
        const xhr = root.makeBoardRequest();
        root.boardRequest = xhr;
        root.boardLoading = true;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.boardRequest) return;
            root.boardRequest = null;
            root.boardLoading = false;
            if (xhr.status === 200) {
                let parsed = null;
                try {
                    parsed = root.boardFrom(JSON.parse(xhr.responseText));
                } catch (error) {
                    parsed = null;
                }
                if (parsed === null) {
                    root.boardError = "ghostd sent a malformed board";
                } else {
                    root.board = parsed;
                    root.boardError = "";
                    root.reachable = true;
                }
            } else {
                root.boardError = root.describeError(xhr, "GET board");
            }
        };
        root.dispatch(xhr, "GET", "/api/board", ({}), null,
            function () { return root.boardRequest === xhr; });
    }

    // The browser relay's pairing prompt is daemon-global as well. GhostHud
    // polls it only while shown: the code the extension popup displays has to
    // match the one here, and that is what makes Allow safe to click.
    /** `{code, since}` while a browser is waiting for Allow, else null. */
    property var relayPairing: null
    property bool relayResolving: false
    property string relayError: ""
    property var relayRequest: null
    property var relayRequestFactory: null

    function makeRelayRequest(): var {
        return typeof root.relayRequestFactory === "function"
            ? root.relayRequestFactory() : new XMLHttpRequest();
    }

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
        if (root.relayResolving) return;
        if (root.relayRequest && root.relayRequest.readyState !== 4) return;
        const xhr = root.makeRelayRequest();
        root.relayRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.relayRequest) return;
            root.relayRequest = null;
            let pairing = null;
            if (xhr.status === 200) {
                try {
                    pairing = root.relayPairingFrom(JSON.parse(xhr.responseText));
                } catch (error) {
                    pairing = null;
                }
            }
            root.relayPairing = pairing;
        };
        root.dispatch(xhr, "GET", "/api/relay/status", ({}), null,
            function () { return root.relayRequest === xhr; });
    }

    /** Answer the pairing whose code the owner can see. */
    function resolveRelayPairing(code: string, allow: bool): void {
        if (root.relayResolving || typeof code !== "string" || code === ""
                || typeof allow !== "boolean") return;
        const previous = root.relayRequest;
        root.relayRequest = null;
        if (previous && previous.readyState !== 4) previous.abort();
        const xhr = root.makeRelayRequest();
        root.relayRequest = xhr;
        root.relayResolving = true;
        root.relayError = "";
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.relayRequest) return;
            root.relayRequest = null;
            root.relayResolving = false;
            if (xhr.status === 200) {
                let pairing = null;
                try {
                    pairing = root.relayPairingFrom(JSON.parse(xhr.responseText));
                } catch (error) {
                    pairing = null;
                }
                root.relayPairing = pairing;
            } else if (xhr.status === 404) {
                // Expired, or answered from the CLI: either way it is gone.
                root.relayPairing = null;
            } else {
                root.relayError = root.describeError(xhr,
                    (allow ? "allow" : "deny") + " browser pairing");
            }
        };
        root.dispatch(xhr, "POST", "/api/relay/pair",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ code: code, allow: allow }),
            function () { return root.relayRequest === xhr; });
    }

    function makeGhostRequest(): var {
        return typeof root.ghostRequestFactory === "function"
            ? root.ghostRequestFactory() : new XMLHttpRequest();
    }

    function retireListRequest(): void {
        root.listGeneration += 1;
        const request = root.listRequest;
        root.listRequest = null;
        if (request && request.readyState !== 4) request.abort();
    }

    function retireCreateGhostRequest(): void {
        root.createGhostGeneration += 1;
        const request = root.createGhostRequest;
        root.createGhostRequest = null;
        if (request && request.readyState !== 4) request.abort();
    }

    function refresh(): void {
        root.fetchHooks(false);
        root.fetchDaemonStatus();
        root.retireListRequest();
        const generation = root.listGeneration;
        const xhr = root.makeGhostRequest();
        root.listRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.listRequest
                    || generation !== root.listGeneration) return;
            root.listRequest = null;
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
        root.dispatch(xhr, "GET", "/api/ghosts", ({}), null, function () {
            return xhr === root.listRequest && generation === root.listGeneration;
        });
    }

    function createGhost(name: string): void {
        const trimmed = name.trim();
        if (trimmed === "") return;
        root.retireCreateGhostRequest();
        const generation = root.createGhostGeneration;
        const xhr = root.makeGhostRequest();
        root.createGhostRequest = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.createGhostRequest
                    || generation !== root.createGhostGeneration) return;
            root.createGhostRequest = null;
            if (xhr.status === 200 || xhr.status === 201) {
                let created = null;
                let createdName = trimmed;
                try {
                    created = JSON.parse(xhr.responseText);
                    if (created && typeof created.name === "string" && created.name !== "")
                        createdName = created.name;
                } catch (error) {
                    created = null;
                }
                if (created && !root.ghosts.some(function (ghost) {
                    return ghost && ghost.name === createdName;
                })) root.ghosts = root.ghosts.concat([created]);
                root.performNavigation(({
                    kind: "createdGhost", name: createdName
                }));
            } else {
                root.fail(root.describeError(xhr, "POST /api/ghosts"));
            }
        };
        root.dispatch(xhr, "POST", "/api/ghosts",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ name: trimmed }), function () {
                return xhr === root.createGhostRequest
                    && generation === root.createGhostGeneration;
            });
    }

    function finishCreatedGhostSelection(name: string): void {
        if (name === "") return;
        root.activeGhost = name;
        root.currentSessionId = "";
        root.sessions = [];
        root.clearTranscript();
        root.clearGreeting();
        root.clearCommands();
        root.clearSessionResources();
        root.clearMcp();
        root.refresh();
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
            root.ghostRenameError = "Wait for the provider login to start before renaming this ghost.";
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
            activeGhost: root.activeGhost,
            characterGhost: root.characterGhost
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
        root.clearCharacter();
        root.clearCommands();
        root.clearSessionResources();
        root.clearMcp();
    }

    function selectGhost(name: string): void {
        if (name === root.activeGhost) return;
        root.performNavigation(({ kind: "selectGhost", name: name }));
    }

    function finishSelectGhost(name: string): void {
        if (name === "" || name === root.activeGhost) return;
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
        root.clearCharacter();
        root.clearCommands();
        root.clearSessionResources();
        root.clearMcp();
        root.fetchCurrentModel();
        root.fetchSessions(name);
        root.fetchGreeting();
    }

    /** One atomic tray intent for the selected ghost. */
    function openConversationForGhost(name: string, id: string): void {
        if (name === "" || id === "") return;
        root.performNavigation(({
            kind: "openConversationForGhost", name: name, id: id
        }));
    }

    /** One atomic tray intent; New must apply to the selected destination. */
    function newConversationForGhost(name: string): void {
        if (name === "") return;
        root.performNavigation(({
            kind: "newConversationForGhost", name: name
        }));
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
        root.clearSessionResources();
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
            published: false,
            rows: [],
            hydratedRowCount: 0,
            historyTruncated: false,
            commandTurnKey: "",
            commandTurnIndex: -1,
            commandTurnAnchor: 0,
            streaming: false,
            request: null,
            lastStreamActivity: 0,
            activity: "",
            limitNotice: "",
            lastError: "",
            pendingAsk: null,
            askSubmitting: false,
            askError: "",
            steeringQueue: [],
            followUpQueue: [],
            queueSubmitting: false,
            queueError: "",
            blocks: ({}),
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
        state.historyTruncated = root.transcriptHistoryTruncated;
        state.commandTurnKey = root.commandTurnKey;
        state.commandTurnIndex = root.commandTurnIndex;
        state.commandTurnAnchor = root.commandTurnAnchor;
        state.streaming = root.streaming;
        state.request = root.request;
        state.activity = root.activity;
        state.lastError = root.lastError;
        state.pendingAsk = root.pendingAsk;
        state.askSubmitting = root.askSubmitting;
        state.askError = root.askError;
        state.steeringQueue = root.steeringQueue.slice();
        state.followUpQueue = root.followUpQueue.slice();
        state.queueSubmitting = root.queueSubmitting;
        state.queueError = root.queueError;
        state.blocks = root.blocks;
        state.toolActivities = root.toolActivities.slice();
        state.toolIdsByContent = root.toolIdsByContent;
        state.assistantRow = root.assistantRow;
        state.consumed = root.consumed;
        state.frameBuffer = root.frameBuffer;
        state.presentationDirty = root.presentationDirty;
    }

    function projectTurnFields(state: var): void {
        if (!root.isActiveTurn(state)) return;
        root.projectTurnProjection(state);
    }

    function projectTurnProjection(state: var): void {
        root.hydratedRowCount = state.hydratedRowCount;
        root.transcriptHistoryTruncated = state.historyTruncated === true;
        root.commandTurnKey = state.commandTurnKey;
        root.commandTurnIndex = state.commandTurnIndex;
        root.commandTurnAnchor = state.commandTurnAnchor;
        root.streaming = state.streaming;
        root.request = state.request;
        root.activity = state.activity;
        root.lastError = state.lastError;
        root.pendingAsk = state.pendingAsk;
        root.askSubmitting = state.askSubmitting;
        root.askError = state.askError;
        root.steeringQueue = state.steeringQueue;
        root.followUpQueue = state.followUpQueue;
        root.queueSubmitting = state.queueSubmitting;
        root.queueError = state.queueError;
        root.blocks = state.blocks;
        root.toolActivities = state.toolActivities;
        root.toolIdsByContent = state.toolIdsByContent;
        root.assistantRow = state.assistantRow;
        root.consumed = state.consumed;
        root.frameBuffer = state.frameBuffer;
        root.presentationDirty = state.presentationDirty;
    }

    function clearTurnProjection(): void {
        transcriptModel.clear();
        root.hydratedRowCount = 0;
        root.transcriptHistoryTruncated = false;
        root.commandTurnKey = "";
        root.commandTurnIndex = -1;
        root.commandTurnAnchor = 0;
        root.streaming = false;
        root.request = null;
        root.activity = "";
        root.pendingAsk = null;
        root.askSubmitting = false;
        root.askError = "";
        root.steeringQueue = [];
        root.followUpQueue = [];
        root.queueSubmitting = false;
        root.queueError = "";
        root.blocks = ({});
        root.toolActivities = [];
        root.toolIdsByContent = ({});
        root.assistantRow = -1;
        root.consumed = 0;
        root.frameBuffer = "";
        root.presentationDirty = false;
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
            state.historyTruncated = false;
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

    function clearModelState(): void {
        root.currentModel = null;
        root.modelSource = "none";
        root.availableModelTotal = 0;
        root.modelWarning = "";
    }


    function clearGreeting(): void {
        root.greeting = "";
        root.greetingOnboarding = false;
        root.greetingGhost = "";
    }



    function newCharacterRequest(): var {
        return typeof root.characterRequestFactory === "function"
            ? root.characterRequestFactory() : new XMLHttpRequest();
    }

    function clearCharacter(): void {
        const read = root.characterRequest;
        const write = root.characterWriteRequest;
        // Retire ownership before abort because Qt may synchronously deliver DONE.
        root.characterRequest = null;
        root.characterWriteRequest = null;
        root.characterBody = "";
        root.characterLimit = 0;
        root.characterLoading = false;
        root.characterSaving = false;
        root.characterError = "";
        root.characterGhost = "";
        if (read && read.readyState !== 4) read.abort();
        if (write && write.readyState !== 4) write.abort();
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
        if (root.characterRequest && root.characterRequest.readyState !== 4) {
            if (!force) return;
            root.characterRequest.abort();
        }

        const xhr = root.newCharacterRequest();
        root.characterRequest = xhr;
        root.characterLoading = true;
        root.characterError = "";
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.characterRequest) return;
            root.characterRequest = null;
            root.characterLoading = false;
            if (ghost !== root.activeGhost) return;
            if (xhr.status === 200) {
                try {
                    const body = JSON.parse(xhr.responseText);
                    if (typeof body.body !== "string" || !(body.limit > 0))
                        throw new Error("invalid character");
                    root.characterBody = body.body;
                    root.characterLimit = body.limit;
                    root.characterGhost = ghost;
                    root.characterError = "";
                    root.reachable = true;
                } catch (error) {
                    root.characterError = "ghostd sent a malformed character file";
                }
            } else {
                root.characterError = root.describeError(xhr, "GET character");
            }
        };
        root.dispatch(xhr, "GET",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/character", ({}), null);
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
        const xhr = root.newCharacterRequest();
        root.characterWriteRequest = xhr;
        root.characterSaving = true;
        root.characterError = "";
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.characterWriteRequest) return;
            root.characterWriteRequest = null;
            root.characterSaving = false;
            if (ghost !== root.activeGhost) return;
            let ok = false;
            if (xhr.status === 200) {
                try {
                    const result = JSON.parse(xhr.responseText);
                    if (!result || result.ok !== true) throw new Error("not ok");
                    ok = true;
                    root.characterBody = body;
                    if (result.limit > 0) root.characterLimit = result.limit;
                    root.characterGhost = ghost;
                    root.reachable = true;
                } catch (error) {
                    root.characterError = "ghostd sent a malformed character result";
                }
            } else {
                root.characterError = root.describeError(xhr, "PUT character");
            }
            root.characterWriteFinished(ok);
            // The file on disk is the truth; re-read what the daemon stored.
            if (ok) root.fetchCharacter(true);
        };
        root.dispatch(xhr, "PUT",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/character",
            ({ "Content-Type": "application/json" }), JSON.stringify({ body: body }));
    }


    function clearCommands(): void {
        if (root.commandsRequest && root.commandsRequest.readyState !== 4)
            root.commandsRequest.abort();
        root.commandsRequest = null;
        root.commands = [];
        root.commandsLoading = false;
        root.commandsError = "";
        root.commandsNotice = "";
        root.commandsGhost = "";
        root.commandsSessionId = "";
    }

    function clearSessionResources(): void {
        const request = root.sessionResourcesRequest;
        root.sessionResourcesRequest = null;
        root.sessionResources = null;
        root.sessionResourcesLoading = false;
        root.sessionResourcesError = "";
        root.sessionResourcesPending = false;
        root.sessionResourcesGhost = "";
        root.sessionResourcesSessionId = "";
        if (request && request.readyState !== 4) request.abort();
    }

    function validSessionResourceRow(row: var, mcp: bool): bool {
        const sources = mcp ? ["ghost"] : ["machine", "ghost"];
        const statuses = mcp
            ? ["admitted", "shadowed", "skipped", "disabled"]
            : ["admitted", "shadowed", "skipped"];
        if (!row || typeof row !== "object" || Array.isArray(row)
                || typeof row.name !== "string" || row.name === ""
                || typeof row.path !== "string"
                || sources.indexOf(row.source) < 0
                || typeof row.precedence !== "number" || !Number.isFinite(row.precedence)
                || statuses.indexOf(row.status) < 0
                || (row.description !== undefined && typeof row.description !== "string")
                || (row.reason !== undefined && typeof row.reason !== "string")
                || (row.shadowedBy !== undefined && typeof row.shadowedBy !== "string"))
            return false;
        return !mcp || typeof row.enabled === "boolean";
    }

    function validSessionResourceDiagnostic(row: var): bool {
        return row && typeof row === "object" && !Array.isArray(row)
            && ["machine", "ghost"].indexOf(row.source) >= 0
            && typeof row.reason === "string"
            && (row.path === undefined || typeof row.path === "string")
            && (row.shadowedBy === undefined || typeof row.shadowedBy === "string");
    }

    function applySessionResources(body: var, ghost: string, sessionId: string): bool {
        const identity = root.conversationIdentity(sessionId);
        if (!body || typeof body !== "object" || Array.isArray(body)
                || ["pi", "claude-code"].indexOf(body.runtime) < 0
                || !identity || body.runtime !== identity.runtime
                || !Array.isArray(body.skills)
                || !body.skills.every(function (row) {
                    return root.validSessionResourceRow(row, false);
                })
                || !Array.isArray(body.mcpServers)
                || !body.mcpServers.every(function (row) {
                    return root.validSessionResourceRow(row, true);
                })
                || !Array.isArray(body.diagnostics)
                || !body.diagnostics.every(function (row) {
                    return root.validSessionResourceDiagnostic(row);
                })
                || !Array.isArray(body.mcpDiagnostics)
                || !body.mcpDiagnostics.every(function (row) {
                    return root.validSessionResourceDiagnostic(row);
                })
            )
            return false;
        root.sessionResources = body;
        root.sessionResourcesGhost = ghost;
        root.sessionResourcesSessionId = sessionId;
        return true;
    }

    function fetchSessionResources(force: bool): void {
        const ghost = root.activeGhost;
        if (ghost === "") {
            root.clearSessionResources();
            return;
        }
        const sessionId = root.ensureSession(ghost);
        if (!force && root.sessionResourcesGhost === ghost
                && root.sessionResourcesSessionId === sessionId) return;
        const previous = root.sessionResourcesRequest;
        root.sessionResourcesRequest = null;
        if (previous && previous.readyState !== 4) previous.abort();

        const xhr = root.sessionResourcesRequestFactory
            ? root.sessionResourcesRequestFactory() : new XMLHttpRequest();
        root.sessionResourcesRequest = xhr;
        root.sessionResources = null;
        root.sessionResourcesLoading = true;
        root.sessionResourcesError = "";
        root.sessionResourcesPending = false;
        root.sessionResourcesGhost = ghost;
        root.sessionResourcesSessionId = sessionId;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || xhr !== root.sessionResourcesRequest) return;
            root.sessionResourcesRequest = null;
            root.sessionResourcesLoading = false;
            if (ghost !== root.activeGhost || sessionId !== root.currentSessionId) return;
            if (xhr.status === 200) {
                try {
                    if (!root.applySessionResources(JSON.parse(xhr.responseText), ghost, sessionId))
                        throw new Error("invalid resource snapshot");
                    root.sessionResourcesError = "";
        root.sessionResourcesPending = false;
                    root.reachable = true;
                } catch (error) {
                    root.sessionResources = null;
                    root.sessionResourcesError = "ghostd sent a malformed resource snapshot";
                }
            } else {
                root.sessionResources = null;
                root.sessionResourcesPending = root.errorCode(xhr) === "session_resources_unavailable";
                root.sessionResourcesError = root.sessionResourcesPending
                    ? "Send a message to start Claude Code, then refresh."
                    : root.describeError(xhr, "GET session resources");
            }
        };
        root.dispatch(xhr, "GET", "/api/ghosts/" + encodeURIComponent(ghost)
            + "/sessions/" + encodeURIComponent(sessionId) + "/resources", ({}), null);
    }

    /**
     * Discover Ghost's effective slash commands for the active conversation.
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
        // Slash commands are pi's; a Claude Code conversation has none to
        // list, and the daemon would only say so with a 409.
        const identity = root.parseConversationActionId(sessionId);
        if (identity && identity.runtime === "claude-code") {
            root.commandsRequest = null;
            root.commands = [];
            root.commandsLoading = false;
            root.commandsError = "";
            root.commandsNotice = "Slash commands are pi's. This conversation runs on Claude Code.";
            root.commandsGhost = ghost;
            root.commandsSessionId = sessionId;
            return;
        }
        root.commandsNotice = "";

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
                    root.clearSessionResources();
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
                        && ghost === root.activeGhost) {
                    root.fetchSessions(ghost);
                }
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
                    const valid = root.validSessionRows(list);
                    for (const session of valid) {
                        const state = root.turnStates[root.conversationKey(g, session.id)];
                        if (state) state.published = true;
                    }
                    root.sessions = root.mergeSessionListing(g, valid);
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
        if (root.activeGhost === "") return;
        root.performNavigation(({ kind: "newConversation" }));
    }

    function finishNewConversation(): void {
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
        root.clearSessionResources();
        // A blank chat is back on screen, so it earns a fresh opening line.
        root.clearGreeting();
        root.fetchGreeting();
    }

    function ensureOptimisticSessionRow(ghost: string, id: string): void {
        const state = root.turnStates[root.conversationKey(ghost, id)];
        if (state) state.published = true;
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
                        root.clearSessionResources();
                                        root.clearGreeting();
                        root.fetchGreeting();
                    }
                    root.sessionsError = "";
                    root.fetchSessions(ghost);
                }
            } else {
                if (ghost === root.activeGhost) {
                    root.sessionsError = root.describeError(xhr, "DELETE conversation");
                }
            }
            // The dialog observes this field to settle. Publish the outcome
            // first so a failure cannot look like a successful dismissal.
            root.deletingSessionId = "";
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

    function applySessionTitle(id: string, title: var): void {
        root.sessions = root.sessions.map(function (session) {
            return session && session.id === id
                ? Object.assign({}, session, { title: title })
                : session;
        });
    }

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
        root.clearSessionResources();
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
        if (id === root.currentSessionId) {
            if (!root.streaming) root.finishOpenConversation(id);
            return;
        }
        root.performNavigation(({ kind: "openConversation", id: id }));
    }

    function finishOpenConversation(id: string): void {
        const ghost = root.activeGhost;
        if (ghost === "" || id === "") return;
        root.adoptConversation(ghost, id);
        root.markConversationRead(ghost, id);
        const state = root.ensureTurnState(ghost, id);
        if (state.streaming) return;
        root.loadConversationTranscript(state, true);
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
            historyTruncated: null,
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
        root.sessionsError = message;
        if (unreachable) root.fail(message);
    }

    function completeTranscriptLoad(state: var, load: var): void {
        if (!state || state.transcriptLoad !== load
                || state.transcriptGeneration !== load.generation || state.streaming) return;
        state.transcriptRequest = null;
        state.transcriptLoad = null;
        state.historyTruncated = load.historyTruncated === true;
        root.rehydrateTurn(state, load.messages);
        root.reachable = true;
        if (root.isActiveTurn(state)) root.sessionsError = "";
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
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4 || !root.transcriptLoadIsCurrent(state, load, xhr)) return;
            if (xhr.status === 404 && requestedOffset === 0 && load.allowNotFound) {
                load.messages = [];
                load.historyTruncated = false;
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
                state.published = true;
                if (typeof body.total !== "number" || !Number.isFinite(body.total)
                        || Math.floor(body.total) !== body.total || body.total < 0)
                    throw new Error("invalid transcript total");
                if (typeof body.truncated !== "boolean")
                    throw new Error("invalid transcript truncation marker");
                if (typeof body.historyTruncated !== "boolean")
                    throw new Error("invalid transcript history marker");
                if (load.historyTruncated === null)
                    load.historyTruncated = body.historyTruncated;
                else if (load.historyTruncated !== body.historyTruncated)
                    throw new Error("transcript history marker changed between pages");
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
     * Older storage projections may give one turn several consecutive assistant
     * messages, while the live stream renders the whole turn as one row. They
     * are therefore regrouped before the split, or a restored answer scatters
     * across several rows and an announcement is severed from the tool call
     * it captions.
     *
     * A text-less row survives when it still carries tool activity. That is the
     * only thing standing between an unanswered `ask` and a dead conversation:
     * its message is a lone `toolCall` part, so dropping the row takes the
     * card's re-answer branch with it and the question can never be answered.
     */
    function rehydrateTurn(state: var, messages: var): void {
        state.activity = "";
        state.limitNotice = "";
        const storedRows = TurnBlocks.rows(messages);
        state.hydratedRowCount = storedRows.length;
        const rows = CommandTranscript.merge(storedRows, root.commandExchangesFor(state));
        const hydrated = [];
        for (const row of rows) {
            hydrated.push({
                role: row.role,
                text: row.text + (row.contentTruncated
                    ? "\n\n*[Saved message truncated]*" : ""),
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

    function commandExchangesFor(state: var): var {
        const key = root.commandTranscriptKey(state.ghost, state.sessionId);
        return Array.isArray(root.commandExchanges[key]) ? root.commandExchanges[key] : [];
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

    function messageTools(message: var): var {
        if (!Array.isArray(message.content)) return [];
        const captions = TurnBlocks.splitParts(message.content).captions;
        const tools = [];
        message.content.forEach((part, index) => {
            if (!part || part.type !== "toolCall") return;
            tools.push({
                id: part.id || ("history-" + Math.random()),
                name: part.name || "tool",
                // Reading every restored call as complete quietly healed the
                // failures: Bubble keeps a failed call in the reading column
                // on purpose — a silent one is how a confidently wrong answer
                // gets believed — and a reload folded it behind the "N steps"
                // toggle with the ordinary ones.
                status: root.restoredToolStatus(part),
                arguments: part.arguments || ({}),
                // Per-call, not per-conversation: a transcript can contain
                // writes on both sides of a persisted `!cd`.
                cwd: typeof part.cwd === "string" ? part.cwd : "",
                summary: "",
                // What the ghost said it was doing before this call, so a
                // restored card explains itself the way the live one did.
                intent: captions[index] || "",
                askBranch: part.ghostAsk || null,
                // How the question actually settled, so a restored card can stop
                // reporting an answer for one that was cancelled or timed out.
                // "" for a runtime that does not say, which the card reads as
                // unknown rather than guessing.
                askSettled: part.ghostAsk && typeof part.ghostAsk.settled === "string"
                    ? part.ghostAsk.settled : ""
            });
        });
        return tools;
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


    function send(text: string): void {
        const prompt = text.trim();
        if (prompt === "" || root.streaming || root.activeGhost === "") return;
        const ghost = root.activeGhost;
        let sessionId = root.ensureSession(ghost);
        let state = root.ensureTurnState(ghost, sessionId);
        const desiredRuntime = root.runtimeForNewConversation();
        if (state && state.runtime !== desiredRuntime) {
            state = root.adoptConversationRuntime(ghost, desiredRuntime);
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
            role: "user", text: prompt, toolActivity: [], error: "", pending: false,
            entryId: ""
        });
        root.appendTurnRow(state, {
            role: "assistant", text: "", toolActivity: [], error: "", pending: true,
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
        root.projectTurnFields(state);
    }

    function resetAssistantSegmentFor(state: var): void {
        state.blocks = ({});
        state.toolActivities = [];
        state.toolIdsByContent = ({});
        state.presentationDirty = true;
        root.projectTurnFields(state);
    }

    function resetAskStateFor(state: var): void {
        state.pendingAsk = null;
        state.askSubmitting = false;
        state.askError = "";
        root.projectTurnFields(state);
    }

    function resetInteractionStateFor(state: var): void {
        state.activity = "";
        root.resetAskStateFor(state);
        state.steeringQueue = [];
        state.followUpQueue = [];
        state.queueSubmitting = false;
        state.queueError = "";
        root.projectTurnFields(state);
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

    // GHOST_HUD_REPLAY is a diagnostic fallback for stateless daemon builds;
    // normal requests send only the new message because ghostd owns history.
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


    /**
     * Feed a raw chunk of the response body. Chunk boundaries are network
     * boundaries, never frame boundaries, so the trailing partial frame is
     * carried over to the next call.
     */
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
            state.presentationDirty = true;
            state.toolIdsByContent[event.contentIndex] = event.id;
            root.updateToolFor(state, event.id, {
                name: event.toolName,
                status: "preparing",
                arguments: ({}),
                summary: ""
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
                summary: ""
            });
            root.resetAskStateFor(state);
            break;
        case "tool_execution_start":
            state.activity = event.toolName;
            const started = {
                name: event.toolName,
                status: "running",
                arguments: event.arguments || ({}),
                cwd: typeof event.cwd === "string" ? event.cwd : ""
            };
            // The runtime's own statement of purpose outranks the caption
            // TurnBlocks recovered from the narration; "" would erase it.
            if (event.intent) started.intent = event.intent;
            root.updateToolFor(state, event.id, started);
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
        case "limit_reached":
            // The terminal error that follows says "provider failed"; this
            // says what actually happened and when the window opens again.
            state.limitNotice = root.limitNoticeText(event);
            state.activity = "limit reached";
            break;
        case "branch_changed":
            if (!root.transcriptMatchesIdentity(event.transcript, state)) {
                root.endTurnState(state, "ghostd sent mismatched branch state");
                break;
            }
            root.rehydrateTurn(state, event.transcript.messages);
            root.appendTurnRow(state, {
                role: "assistant", text: "", toolActivity: [], error: "", pending: true,
                entryId: ""
            });
            state.assistantRow = state.rows.length - 1;
            root.resetAssistantSegmentFor(state);
            state.activity = "";
            break;
        case "done":
            root.endTurnState(state, "");
            break;
        case "error":
            root.endTurnState(state,
                state.limitNotice || event.errorMessage || ("the ghost stopped: " + event.reason));
            break;
        default:
            console.warn("ghost: unknown pi-messages event:", event.type);
        }
        root.projectTurnFields(state);
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
            cwd: "",
            summary: "",
            intent: "",
            // A live ask has not settled yet; the card reads "" as unknown and
            // says nothing about an outcome rather than inventing one.
            askSettled: ""
        }, patch));
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
        // A builtin has no model blocks. Re-splitting an empty block buffer at
        // `done` must not erase the command_output row we just rendered.
        if (state.rows[state.assistantRow].role === "command") return;
        if (!force && !state.presentationDirty) return;
        const turn = TurnBlocks.split(state.blocks, Object.keys(state.toolIdsByContent));
        const row = state.rows[state.assistantRow];
        if (row.text !== turn.body)
            root.setTurnRow(state, state.assistantRow, "text", turn.body);
        // The text a call overwrote is that call's own announcement, unless
        // the runtime already said what the call was for.
        for (const index of Object.keys(turn.captions)) {
            const caption = turn.captions[index];
            if (caption === "") continue;
            const id = state.toolIdsByContent[index];
            const activity = state.toolActivities.find(item => item.id === id);
            if (activity && !activity.intent)
                root.updateToolFor(state, id, { intent: caption });
        }
        state.presentationDirty = false;
        root.projectTurnFields(state);
    }

    /** "Claude Code weekly limit reached · resets Thu 20:00", from a limit_reached event. */
    function limitNoticeText(event: var): string {
        const harness = event.harness === "claude-code" ? "Claude Code" : "pi";
        const kind = String(event.kind || "limit").replace("_", " ");
        const window = event.window ? " (" + String(event.window).replace(/_/g, " ") + ")" : "";
        let resets = "";
        if (event.resetsAt) {
            const at = new Date(event.resetsAt);
            if (!isNaN(at.getTime()))
                resets = " · resets " + Qt.formatDateTime(at, "ddd HH:mm");
        }
        return harness + " " + kind + window + " reached" + resets;
    }

    function endTurnState(state: var, errorMessage: string): void {
        // The terminal event, EOF fallback, watchdog and abort can race. Only
        // the first one owns settlement and emits a terminal shell signal.
        if (!state.streaming) return;
        root.settleToolActivityFor(state, false);
        state.streaming = false;
        // Re-split now the turn is closed, so the last flush tick's text is
        // what the row shows.
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
            root.turnFailed(state.ghost, errorMessage);
            if (state.ghost === root.activeGhost) Qt.callLater(function () {
                root.fetchSessions(state.ghost);
            });
        } else {
            // A turn that completed is proof the daemon answered; drop any stale
            // error banner so it does not linger under a good reply.
            state.lastError = "";
            root.turnFinished(state.ghost, text);
        }
        root.projectTurnFields(state);
        Qt.callLater(function () {
            root.refreshConversationTranscript(state);
        });
        if (errorMessage === "" && root.hudVisible && root.isActiveTurn(state))
            root.markConversationRead(state.ghost, state.sessionId);
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
            // Pi can dequeue a batch of owner messages before starting the
            // next provider step. Keep those as consecutive owner rows rather
            // than manufacturing a blank assistant row between each pair.
            root.removeTurnRow(state, state.assistantRow);
            state.assistantRow = -1;
        } else {
            root.settleToolActivityFor(state, false);
            // The HTTP turn continues, but this assistant segment ends where
            // the dequeued owner message enters; flush what it said.
            root.flushTurn(state, true);
            if (hasAssistant)
                root.setTurnRow(state, state.assistantRow, "pending", false);
        }
        state.activity = "";

        root.appendTurnRow(state, {
            role: "user", text: message, toolActivity: [], error: "", pending: false,
            entryId: ""
        });
        root.appendTurnRow(state, {
            role: "assistant", text: "", toolActivity: [], error: "", pending: true,
            entryId: ""
        });
        state.assistantRow = state.rows.length - 1;
        root.resetAssistantSegmentFor(state);
        root.projectTurnFields(state);
    }


    function fetchPendingAskFor(state: var): void {
        if (!state.streaming || state.activity !== "ask") return;
        if (state.askRequest && state.askRequest.readyState !== 4) return;
        const xhr = new XMLHttpRequest();
        state.askRequest = xhr;
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


    function applyQueueFor(state: var, body: var): void {
        state.steeringQueue = Array.isArray(body.steering) ? body.steering : [];
        state.followUpQueue = Array.isArray(body.followUp) ? body.followUp : [];
        root.projectTurnFields(state);
    }

    function fetchQueueFor(state: var): void {
        if (!state.streaming) return;
        if (state.queueStatusRequest && state.queueStatusRequest.readyState !== 4) return;
        const xhr = new XMLHttpRequest();
        state.queueStatusRequest = xhr;
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
        // Pi consumes it into the next provider boundary.
        if (mode === "followUp") state.followUpQueue = state.followUpQueue.concat([prompt]);
        else state.steeringQueue = state.steeringQueue.concat([prompt]);

        const xhr = new XMLHttpRequest();
        state.queueRequest = xhr;
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

    function resetLogin(): void {
        root.cancelLogin();
    }


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
