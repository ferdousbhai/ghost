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
// The wire format is pi-messages, whose normative definition is the pinned
// client in summon-ghost (@earendil-works/pi-ai). Deltas are INCREMENTAL
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

    // ---- Conversations ----------------------------------------------------
    // A ghost owns many conversations (pi sessions). The daemon persists them;
    // the HUD lists them per ghost, resumes one by loading its transcript, and
    // starts a fresh one on demand. This fixes #26 — a restart no longer loses
    // history, because a conversation lives in the daemon keyed by session id.
    /** Session listing for the active ghost: [{ id, title, createdAt, updatedAt, messageCount }], newest first. */
    property var sessions: []
    /** The active ghost's current conversation id. "" until one is minted or opened. */
    property string currentSessionId: ""
    /** Non-empty when a sessions/transcript fetch failed. */
    property string sessionsError: ""

    // ---- Turn state -------------------------------------------------------
    /** ListModel of { role, text, tools, error, pending }. */
    property alias transcript: transcriptModel
    /** True from `start` until `done`/`error`. */
    property bool streaming: false
    /** Compact activity line: "thinking", "read_memory", "" when idle. */
    property string activity: ""

    signal turnFinished(string ghost, string text)
    signal turnFailed(string ghost, string message)

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

    /** PUT /model wrote a role whose provider is not credentialed — prompt a login. */
    signal modelSwitchNeedsLogin(string provider)

    // ---- Internals --------------------------------------------------------
    // The XHR must be held by a property. A request whose only reference is the
    // closure it installed on itself is eligible for collection mid-flight.
    property var request: null
    property var listRequest: null
    property var loginRequest: null
    property var modelRequest: null
    property var availRequest: null
    property var catalogRequest: null
    property var setModelRequest: null
    property var sessionsRequest: null
    property var transcriptRequest: null

    property var sessionIds: ({})     // ghost name -> active pi session id
    property var blocks: ({})         // contentIndex -> { kind, text }
    property var toolNames: []        // tool names seen this turn, in order
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
                root.refresh();
            } else {
                root.fail(root.describeError(xhr, "POST /api/ghosts"));
            }
        };
        root.dispatch(xhr, "POST", "/api/ghosts",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ name: trimmed }));
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
        root.modelWarning = "";
        root.fetchCurrentModel();
        root.fetchSessions(name);
    }

    function clearTranscript(): void {
        transcriptModel.clear();
        root.activity = "";
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
        root.fetchSessions(ghost);
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
        root.sessionIds[ghost] = id;
        root.currentSessionId = id;
        root.clearTranscript();
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

    /** Replace the transcript view with a conversation's stored messages. */
    function rehydrate(messages: var): void {
        transcriptModel.clear();
        root.activity = "";
        for (const message of messages) {
            const role = message.role === "assistant" ? "assistant" : "user";
            if (message.role !== "user" && message.role !== "assistant") continue;
            const text = root.messageText(message);
            if (text === "") continue;
            transcriptModel.append({ role: role, text: text, tools: "", error: "", pending: false });
        }
    }

    /** Flatten a stored message's content to display text (string or parts). */
    function messageText(message: var): string {
        if (typeof message.content === "string") return message.content;
        if (Array.isArray(message.content)) {
            return message.content
                .filter(part => part && part.type === "text" && typeof part.text === "string")
                .map(part => part.text)
                .join("\n\n");
        }
        if (typeof message.text === "string") return message.text;
        return "";
    }

    // ---- A turn -----------------------------------------------------------

    function send(text: string): void {
        const prompt = text.trim();
        if (prompt === "" || root.streaming || root.activeGhost === "") return;

        transcriptModel.append({ role: "user", text: prompt, tools: "", error: "", pending: false });
        transcriptModel.append({ role: "assistant", text: "", tools: "", error: "", pending: true });
        root.assistantRow = transcriptModel.count - 1;

        root.blocks = ({});
        root.toolNames = [];
        root.consumed = 0;
        root.frameBuffer = "";
        root.activity = "waiting for ghostd";
        root.streaming = true;
        flushTimer.start();

        const ghost = root.activeGhost;
        const xhr = new XMLHttpRequest();
        root.request = xhr;
        xhr.onreadystatechange = function () {
            if (xhr.readyState >= 3 && xhr.status === 200) {
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
        root.activity = "";
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
            break;
        case "toolcall_delta":
            break;
        case "toolcall_end":
            root.activity = "";
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

    /** Push buffered block text into the model. Cheap when nothing changed. */
    function flush(): void {
        if (root.assistantRow < 0 || root.assistantRow >= transcriptModel.count) return;
        const indices = Object.keys(root.blocks).map(Number).sort((a, b) => a - b);
        let text = "";
        for (const index of indices) {
            const block = root.blocks[index];
            if (block.kind === "text" && block.text !== "")
                text += (text === "" ? "" : "\n\n") + block.text;
        }
        const row = transcriptModel.get(root.assistantRow);
        if (row.text !== text) transcriptModel.setProperty(root.assistantRow, "text", text);
        const tools = root.toolNames.join(", ");
        if (row.tools !== tools) transcriptModel.setProperty(root.assistantRow, "tools", tools);
    }

    function finishTurn(errorMessage: string): void {
        root.flush();
        root.endTurn(root.activeGhost, errorMessage);
    }

    function endTurn(ghost: string, errorMessage: string): void {
        if (!root.streaming) return;
        root.streaming = false;
        root.activity = "";
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
            root.turnFinished(ghost, text);
        }
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

    /** Open the current auth URL in the creator's browser. */
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
                if (body.usable === false && provider !== "claude-code")
                    root.modelSwitchNeedsLogin(provider);
            } else {
                root.modelError = root.describeError(xhr, "PUT model");
            }
        };
        root.dispatch(xhr, "PUT",
            "/api/ghosts/" + encodeURIComponent(ghost) + "/model",
            ({ "Content-Type": "application/json" }),
            JSON.stringify({ provider: provider, id: id }));
    }

    // ---- Errors -----------------------------------------------------------

    function describeError(xhr: var, what: string): string {
        if (xhr.status === 0) return "ghostd is not answering on " + root.baseUrl;
        // dispatch() already re-read the file and retried once, so a 401 that
        // reaches here means the token on disk is not the one ghostd wants.
        if (xhr.status === 401)
            return what + " → 401: ghostd rejected the API token in " + root.tokenPath;
        let detail = "";
        try {
            const body = JSON.parse(xhr.responseText);
            detail = body.error && body.error.message ? body.error.message : (body.error || "");
        } catch (error) {
            detail = "";
        }
        return what + " → " + xhr.status + (detail ? ": " + detail : "");
    }

    function fail(message: string): void {
        root.reachable = false;
        root.lastError = message;
        console.warn("ghost:", message);
    }
}
