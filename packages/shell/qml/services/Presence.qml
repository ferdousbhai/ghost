pragma Singleton

// Presence — the ghost embedded in the desktop instead of a window.
//
// A summon lights every screen's edges and opens a prompt on the focused one,
// with Voxtype already listening. Sending lets the desktop go: the glow thins
// to a shimmer and a ticker says what the ghost is doing, taking neither
// clicks nor keys. The reply lands as a card in the ticker's place; summoning
// again from there continues that conversation.
//
// This is state only. Service.qml draws it (PresenceOverlay) because the
// panel is unloaded whenever the host hides it, and the work outlives the
// prompt.
import Quickshell
import Quickshell.Hyprland
import QtQuick
import "DesktopKeys.js" as Desk

Singleton {
    id: root

    /** The prompt is open. */
    property bool composing: false
    /** The prompt's window is the focused one (PresenceOverlay keeps this). */
    property bool promptFocused: false
    /**
     * The conversation this presence follows: "" before a send, "working"
     * while it runs, then "answered" or "failed" until dismissed.
     */
    property string phase: ""
    property string ghost: ""
    property string sessionId: ""
    property string answer: ""
    property string failure: ""
    /** The monitor the prompt, ticker and card show on, fixed at summon. */
    property string screenName: ""
    /** Continue `sessionId` on send; cleared to start a fresh conversation. */
    property bool continuing: false
    /** Enter on an empty prompt while recording: send what Voxtype types. */
    property bool sendAfterDictation: false

    /**
     * The edge glow's ignition: which screen, which edge, and where along it
     * (0..1 from its top or left end), counted so each summon starts one.
     * The menu's glow stays on `hudScreen` while it is open.
     */
    property string ignitionScreen: ""
    property string ignitionEdge: "bottom"
    property real ignitionAt: 0.5
    property int ignitions: 0
    property string hudScreen: ""
    /** Where the bar mark was clicked ({ screen, edge, at, time }), for the menu's ignition to start there. */
    property var clickedAt: null

    function ignite(screen: string, edge: string, at: real): void {
        root.ignitionScreen = screen;
        root.ignitionEdge = edge;
        root.ignitionAt = at;
        root.ignitions += 1;
    }

    /** The menu opening: its glow starts from the bar mark when that was the click, else above it. */
    function igniteMenu(): void {
        const click = root.clickedAt !== null && Date.now() - root.clickedAt.time < 1500 ? root.clickedAt : null;
        root.clickedAt = null;
        root.hudScreen = click ? click.screen : Hyprland.focusedMonitor ? Hyprland.focusedMonitor.name : "";
        root.ignite(root.hudScreen, click ? click.edge : "top", click ? click.at : 0.5);
    }

    /** Service.qml summons the window on this; only it holds the host shell. */
    signal windowRequested(string ghost, string sessionId)

    readonly property bool working: root.phase === "working"
    /** What the ghost asked in this conversation (`ghost ask`) and waits on, or null. */
    readonly property var question: {
        if (root.phase === "" || root.ghost !== Ghostd.activeGhost) return null;
        const row = Ghostd.sessions.find(session => session && session.id === root.sessionId);
        return row && row.question ? row.question : null;
    }
    /** Ghostd's live projection is this conversation's: its activity is ours. */
    readonly property bool projected: Ghostd.activeGhost === root.ghost
        && Ghostd.currentSessionId === root.sessionId

    function summon(): void {
        if (Ghostd.activeGhost === "") return;
        // Already open, behind another app: bring it back as it was, though a
        // summon that switched the ghost cannot continue the other's turn.
        if (root.composing) {
            root.continuing = root.continuing && root.ghost === Ghostd.activeGhost;
            root.raise();
            return;
        }
        root.screenName = Hyprland.focusedMonitor ? Hyprland.focusedMonitor.name : "";
        // A reply on screen, or a turn still running, is what a summon
        // follows up on; a fresh summon starts a fresh conversation.
        root.continuing = root.phase !== "" && root.ghost === Ghostd.activeGhost;
        root.sendAfterDictation = false;
        root.composing = true;
        // From under the prompt, where it sits.
        root.ignite(root.screenName, "bottom", 0.5);
        Dictation.refresh();
        if (Dictation.state === "idle") Dictation.toggle();
    }

    /** Give the prompt the focus back, when another app took it. */
    function raise(): void {
        for (const command of Desk.focusCommands(Desk.PROMPT_TITLE)) Quickshell.execDetached(command);
    }

    /** Close the prompt; a turn it started keeps its ticker or card. */
    function dismiss(): void {
        if (!root.composing) return;
        Dictation.cancel();
        root.sendAfterDictation = false;
        root.composing = false;
    }

    /** Forget the card or ticker; a running turn keeps running. */
    function clear(): void {
        root.phase = "";
        root.answer = "";
        root.failure = "";
        root.continuing = false;
    }

    /** Hand the conversation to the HUD and forget the card. */
    function openInWindow(): void {
        const ghost = root.ghost;
        const sessionId = root.sessionId;
        root.clear();
        root.windowRequested(ghost, sessionId);
    }

    /** Answer the question from the card: the owner's message, in the same conversation. */
    function answerQuestion(text: string): void {
        root.continuing = true;
        root.send(text);
    }

    function dismissQuestion(): void {
        Ghostd.dismissQuestion(root.sessionId);
    }

    function startFresh(): void {
        root.continuing = false;
    }

    function send(text: string): void {
        const prompt = text.trim();
        if (prompt === "") return;
        Dictation.cancel();
        if (root.continuing) {
            if (!root.projected) Ghostd.openConversationForGhost(root.ghost, root.sessionId);
        } else {
            Ghostd.newConversation();
        }
        Ghostd.send(prompt);
        root.ghost = Ghostd.activeGhost;
        root.sessionId = Ghostd.currentSessionId;
        root.answer = "";
        root.failure = "";
        root.phase = "working";
        root.composing = false;
        root.sendAfterDictation = false;
    }

    /**
     * Voxtype has gone quiet after Enter stopped it: send what it typed, or,
     * when it heard nothing, go back to waiting for words.
     */
    function dictationSettled(text: string): void {
        if (!root.sendAfterDictation || Dictation.state !== "idle") return;
        if (text.trim() !== "") root.send(text);
        else root.sendAfterDictation = false;
    }

    function mine(ghost: string, sessionId: string): bool {
        return root.phase !== "" && ghost === root.ghost && sessionId === root.sessionId;
    }

    Connections {
        target: Ghostd

        function onTurnFinished(ghost: string, text: string, sessionId: string, title: string): void {
            if (!root.mine(ghost, sessionId)) return;
            root.answer = text;
            root.phase = "answered";
            // The card is where this reply is read.
            Ghostd.markConversationRead(ghost, sessionId);
        }

        function onTurnFailed(ghost: string, message: string, sessionId: string, title: string): void {
            if (!root.mine(ghost, sessionId)) return;
            root.failure = message;
            root.phase = "failed";
        }
    }
}
