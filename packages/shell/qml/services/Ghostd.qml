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
import Quickshell
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

    /** [{ name, dir, createdAt }], newest listing from GET /api/ghosts. */
    property var ghosts: []
    /** Name of the ghost the HUD is talking to. Empty until the first listing. */
    property string activeGhost: ""
    /** False once any request fails; the HUD shows a reconnect hint. */
    property bool reachable: false
    /** Human-readable last failure, or "". */
    property string lastError: ""

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
    /** [{ id, name, subscription, authTypes, loginLabel, configured, connectedVia }]. */
    property var providers: []
    /** The active login's id, or "" when none is running. */
    property string loginId: ""
    /** The current login view from GET .../login/:id — the step to render. */
    property var loginState: ({})
    /** Which ghost the running login belongs to (a login is per ghost). */
    property string loginGhost: ""
    /** Non-empty while a login request is in flight or has failed to reach ghostd. */
    property string loginError: ""

    // ---- Internals --------------------------------------------------------
    // The XHR must be held by a property. A request whose only reference is the
    // closure it installed on itself is eligible for collection mid-flight.
    property var request: null
    property var listRequest: null
    property var loginRequest: null

    property var sessions: ({})       // ghost name -> pi session id
    property var blocks: ({})         // contentIndex -> { kind, text }
    property var toolNames: []        // tool names seen this turn, in order
    property int assistantRow: -1
    property string consumedPrefix: ""
    property int consumed: 0
    property string frameBuffer: ""

    ListModel { id: transcriptModel }

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
                } catch (error) {
                    root.fail("ghostd sent a malformed ghost list: " + error);
                }
            } else {
                root.fail(xhr.status === 0
                    ? "ghostd is not answering on " + root.baseUrl
                    : "GET /api/ghosts → " + xhr.status);
            }
        };
        xhr.open("GET", root.baseUrl + "/api/ghosts");
        xhr.send();
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
                root.clearTranscript();
                root.refresh();
            } else {
                root.fail(root.describeError(xhr, "POST /api/ghosts"));
            }
        };
        xhr.open("POST", root.baseUrl + "/api/ghosts");
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.send(JSON.stringify({ name: trimmed }));
    }

    function selectGhost(name: string): void {
        if (name === root.activeGhost) return;
        root.cancel();
        root.activeGhost = name;
        root.clearTranscript();
    }

    function clearTranscript(): void {
        transcriptModel.clear();
        root.activity = "";
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
        xhr.open("POST", root.baseUrl + "/api/ghosts/" + encodeURIComponent(ghost) + "/messages");
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("Accept", "text/event-stream");
        xhr.send(JSON.stringify(root.buildBody(ghost, prompt)));
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
        if (!root.sessions[ghost]) {
            root.sessions[ghost] = "hud-" + Date.now().toString(36)
                + "-" + Math.floor(Math.random() * 0xffffff).toString(36);
        }
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
            options: { sessionId: root.sessions[ghost] }
        };
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
        xhr.open("GET", root.baseUrl + "/api/ghosts/" + encodeURIComponent(ghost) + "/providers");
        xhr.send();
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
        xhr.open("POST", root.baseUrl + "/api/ghosts/" + encodeURIComponent(ghost) + "/login");
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.send(JSON.stringify({ providerId: providerId, authType: authType }));
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
                        // A finished login may have set the ghost's chat model;
                        // refresh so the roster reflects it.
                        if (root.loginState.status === "succeeded") root.refresh();
                    }
                } catch (error) {
                    root.loginError = "ghostd sent a malformed login step";
                }
            } else {
                loginPoll.stop();
                root.loginError = root.describeError(xhr, "GET login");
            }
        };
        xhr.open("GET", root.baseUrl + "/api/ghosts/"
            + encodeURIComponent(root.loginGhost) + "/login/" + encodeURIComponent(root.loginId));
        xhr.send();
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
                    if (root.isLoginTerminal()) loginPoll.stop();
                    else loginPoll.start();
                } catch (error) {
                    root.loginError = "ghostd sent a malformed login step";
                }
            } else {
                root.loginError = root.describeError(xhr, "POST login input");
            }
        };
        xhr.open("POST", root.baseUrl + "/api/ghosts/"
            + encodeURIComponent(root.loginGhost) + "/login/" + encodeURIComponent(root.loginId) + "/input");
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.send(JSON.stringify({ value: value }));
    }

    /** Open the current auth URL in the creator's browser. */
    function openLoginUrl(url: string): void {
        if (url && url !== "") Quickshell.execDetached(["xdg-open", url]);
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

    // ---- Errors -----------------------------------------------------------

    function describeError(xhr: var, what: string): string {
        if (xhr.status === 0) return "ghostd is not answering on " + root.baseUrl;
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
