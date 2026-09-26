pragma ComponentBehavior: Bound

// GhostHud — the chat window. A normal xdg-toplevel (FloatingWindow), NOT a
// wlr-layer surface: Hyprland tiles it, resizes it, and moves it between
// workspaces with its own binds like any app. Panel.qml owns it and forwards
// the host shell's summons (keybind, bar widget, `ghost` CLI) to open/close.
//
// Window-shape decisions:
//
//   FloatingWindow        the one Quickshell 0.3.0 construct that presents as a
//                         standard toplevel, so the compositor owns placement,
//                         tiling and monitors and no screen-move code is needed.
//   title                 "Ghost — <name>". Inside omarchy-shell the app-id is
//                         the host's (only a root shell.qml may set one), so the
//                         title is what finds this window again: `titlePattern`.
//   color / no border     the window paints an opaque Theme.background and lets
//                         Hyprland draw the frame, border and rounding. An app
//                         drawing its own rounded border inside the WM's frame
//                         just doubles the edge.
//
// Summon is launch-or-focus, not overlay-toggle: `open` reveals the window and
// focuses it; `toggle` (SUPER+CTRL+G) hides it only when it is already the
// focused window, otherwise it reveals+focuses.
import Quickshell
import Quickshell.Hyprland
import QtQuick
import QtQuick.Layouts
import "services"
import "components"

FloatingWindow {
    id: hud

    /** Driven by Panel.qml. Bound to `visible`. */
    property bool shown: false
    property bool sidebarOpen: true
    property bool loginOpen: false
    property string currentSection: "chat"
    /** What the body shows: the login pane over any section, else the section. */
    readonly property string view: hud.loginOpen ? "login" : hud.currentSection
    /** The navigable sections, in rail order; the body stack follows it. */
    readonly property var sections: navigation.destinations.map(destination => destination.id)
    readonly property int navigationWidth: 64

    // How this window is named to the compositor, and the regex that finds it
    // again. Both halves of launch-or-focus go through here.
    readonly property string titlePattern: "^Ghost( — .*)?$"

    // Deleting a conversation, banishing a ghost, and branching over an unsent
    // draft are asked in a modal over the whole window rather than in the row:
    // the row is 16px of a scrolling sidebar, and a question that costs
    // something deserves the middle of the screen. One question stands at a
    // time, as { kind: "conversation" | "ghost" | "branch", id, title } or
    // null. It lives here, not in the list that raised it, because the dialog
    // outlives the delegate (a refresh rebuilds every row).
    property var pending: null
    readonly property string pendingSession: hud.pendingId("conversation")
    readonly property string pendingGhost: hud.pendingId("ghost")
    readonly property string pendingBranch: hud.pendingId("branch")

    // The file pane sits beside the chat when both columns can still be read,
    // and takes the chat's place when they cannot. The test is on the width
    // actually left for the two of them, not on the window: an open sidebar
    // costs its list column plus the gap beside it, which a raw window-width
    // threshold would ignore.
    readonly property int chatMinimumWidth: 380
    readonly property int paneMinimumWidth: 320
    readonly property int bodyWidth: hud.width - Theme.pad * 2
        - hud.navigationWidth - Theme.sectionGap
        - (hud.sidebarOpen ? Theme.sidebarMeasure + Theme.sectionGap : 0)
    readonly property bool workbenchOpen: Workbench.filePath !== ""
    readonly property bool workbenchSplit: hud.workbenchOpen
        && hud.bodyWidth >= hud.chatMinimumWidth + hud.paneMinimumWidth + Theme.sectionGap
    readonly property int workbenchWidth: {
        const region = hud.bodyWidth - Theme.sectionGap;
        return Math.max(hud.paneMinimumWidth,
            Math.min(Math.round(region * 0.55), region - hud.chatMinimumWidth));
    }

    visible: hud.shown
    color: Theme.background
    title: Ghostd.activeGhost === "" ? "Ghost" : "Ghost — " + Ghostd.activeGhost

    // A reasonable default; the WM resizes/tiles from here. minimumSize keeps a
    // tiled slice from collapsing the composer and roster into nothing.
    implicitWidth: 998
    implicitHeight: 620
    minimumSize: Qt.size(568, 360)

    // Leaving login abandons any client-only model intent and restores the
    // daemon's effective selection. This catches Close, Done, navigation, and
    // every other way the login pane gives the body back.
    onLoginOpenChanged: if (!hud.loginOpen) Ghostd.cancelLogin()

    // Materialize on summon: the content takes a breath of scale and opacity
    // instead of cutting in. Content-level, because the compositor owns the
    // surface itself; Hyprland's own open animation composes with it.
    onShownChanged: {
        Ghostd.hudVisible = hud.shown;
        if (hud.shown) Ghostd.markCurrentConversationRead();
        if (hud.shown && !Theme.reducedMotion)
            materialize.restart();
    }

    function open(): void {
        hud.shown = true;
        // The "focus" half of launch-or-focus. A freshly mapped toplevel is
        // auto-focused by Hyprland; this also pulls an already-open window
        // (possibly on another workspace) to the foreground. Hyprland 0.55+
        // dispatches Lua expressions; the old `focuswindow` spelling is parsed
        // as invalid Lua.
        Hyprland.dispatch('hl.dsp.focus({ window = "title:' + hud.titlePattern + '" })');
        Ghostd.refresh();
        Ghostd.refreshRelay();
        Dictation.refresh();
        hud.showSection("chat");
    }

    function close(): void {
        hud.loginOpen = false;
        hud.shown = false;
    }

    /**
     * Launch-or-focus on a single bind (SUPER+CTRL+G). Reveal+focus when hidden
     * or when open but not the focused window; hide only when it is already the
     * focused window.
     */
    function toggle(): void {
        if (!hud.shown || !hud.focused())
            hud.open();
        else
            hud.close();
    }

    function focused(): bool {
        const top = Hyprland.activeToplevel;
        const title = top && top.lastIpcObject ? String(top.lastIpcObject["title"] || "") : "";
        return new RegExp(hud.titlePattern).test(title);
    }

    /** Each pane fetches its own data when it becomes visible. */
    function showSection(section: string): void {
        if (hud.sections.indexOf(section) < 0) return;
        hud.loginOpen = false;
        hud.currentSection = section;
        if (section === "chat") composer.take();
    }

    function openLogin(): void {
        hud.currentSection = "chat";
        hud.loginOpen = true;
        modelLogin.open();
    }

    function pendingId(kind: string): string {
        return hud.pending !== null && hud.pending.kind === kind ? hud.pending.id : "";
    }

    function ask(kind: string, id: string, title: string): void {
        hud.pending = ({ kind: kind, id: id, title: title });
        hud.clearPendingError();
    }

    function dismissPending(): void {
        hud.clearPendingError();
        hud.pending = null;
        composer.take();
    }

    // A dialog shows only the daemon's refusal of its own attempt, so that
    // error is cleared when the question opens and when it closes.
    function clearPendingError(): void {
        if (hud.pendingSession !== "") Ghostd.sessionsError = "";
        if (hud.pendingGhost !== "") Ghostd.ghostDeleteError = "";
    }

    /**
     * Branch from a message. The copy the daemon makes is a new conversation,
     * so nothing already said is at risk — but the branched text lands in the
     * composer, overwriting whatever is in it, so an unsent draft gets a
     * question first. It is the one thing here nothing else can recover.
     */
    function requestBranch(entryId: string): void {
        if (entryId === "") return;
        if (composer.hasDraft) hud.ask("branch", entryId, "");
        else Ghostd.branchFrom(entryId);
    }

    // The pairing prompt has no event stream; a cheap unauthenticated poll
    // while the HUD is up is what makes it appear.
    Timer {
        interval: 3000
        repeat: true
        running: hud.shown && Ghostd.reachable
        onTriggered: Ghostd.refreshRelay()
    }

    Binding {
        target: Ghostd
        property: "hudChatFocused"
        value: hud.shown && hud.focused() && hud.view === "chat"
    }

    Connections {
        target: Ghostd

        // The delete answered: close on success, stay up with the daemon's
        // reason on failure (a conversation still streaming, an unreachable
        // daemon) so the dialog never dismisses into a no-op.
        function onDeletingSessionIdChanged(): void {
            if (hud.pendingSession === "" || Ghostd.deletingSessionId !== "") return;
            if (Ghostd.sessionsError === "") hud.dismissPending();
        }

        function onDeletingGhostChanged(): void {
            if (hud.pendingGhost === "" || Ghostd.deletingGhost !== "") return;
            if (Ghostd.ghostDeleteError === "") hud.dismissPending();
        }

        // A name that left the listing (banished here, or from another shell)
        // has nothing left to confirm.
        function onGhostsChanged(): void {
            if (hud.pendingGhost === "" || Ghostd.deletingGhost !== "") return;
            if (!Ghostd.ghosts.some(ghost => ghost.name === hud.pendingGhost))
                hud.dismissPending();
        }

        // The ask form takes the keyboard while a question is standing, so
        // answering or dismissing one has to hand it back — otherwise the
        // composer returns with nothing focused and the next thing typed goes
        // nowhere. Gated on the HUD being up: grabbing the caret for a window
        // nobody is looking at is worse than not.
        function onPendingAskChanged(): void {
            if (Ghostd.pendingAsk === null && hud.shown) composer.take();
        }

        function onComposerDraft(text: string): void {
            composer.text = text;
            composer.take();
        }
    }

    Rectangle {
        id: card

        // Fill the window and paint a plain rectangle; Hyprland draws the frame,
        // border and rounding for a normal toplevel.
        anchors.fill: parent
        color: Theme.background

        ParallelAnimation {
            id: materialize
            NumberAnimation {
                target: card; property: "opacity"; from: 0; to: 1
                duration: 250; easing.type: Easing.OutCubic
            }
            SequentialAnimation {
                NumberAnimation {
                    target: card; property: "scale"; from: 0.97; to: 1.008
                    duration: 260; easing.type: Easing.OutCubic
                }
                NumberAnimation {
                    target: card; property: "scale"; from: 1.008; to: 1
                    duration: 180; easing.type: Easing.InOutQuad
                }
            }
        }

        focus: true
        // Esc-to-close is unusual for a normal app window, so Esc only dismisses
        // a standing question, then cancels a running turn, then closes the
        // workbench; the window itself goes with SUPER+CTRL+G. Left unhandled
        // once there is nothing of ours to dismiss, so it never swallows a
        // compositor bind.
        Keys.onEscapePressed: event => {
            event.accepted = true;
            if (hud.pending !== null) hud.dismissPending();
            else if (Ghostd.streaming) Ghostd.cancel();
            else if (hud.workbenchOpen) Workbench.close();
            else event.accepted = false;
        }
        // Ctrl+B toggles the whole left sidebar, editor-style. This reaches the
        // card by focus-chain propagation even while the composer holds focus,
        // since a plain TextEdit does not consume Ctrl+B.
        Keys.onPressed: event => {
            if (hud.currentSection === "chat"
                    && (event.modifiers & Qt.ControlModifier)
                    && event.key === Qt.Key_B) {
                hud.sidebarOpen = !hud.sidebarOpen;
                event.accepted = true;
            }
        }

        // Two cold blobs breathing far under the reading surface. `z: -1` puts
        // them over the card's own fill but beneath every layout child, and
        // `enabled: false` keeps the layer out of the input chain. Alphas are
        // held low enough that body text contrast is untouched.
        Item {
            anchors.fill: parent
            z: -1
            enabled: false

            Glow {
                x: parent.width * 0.15 - width / 2
                y: parent.height * 0.2 - height / 2
                width: 400
                core: "#0d8b5cf6"
                mid: "#048b5cf6"
                midAt: 0.6
                breathLow: 0.45
                breath: 6000
            }

            Glow {
                x: parent.width * 0.85 - width / 2
                y: parent.height * 0.8 - height / 2
                width: 400
                core: "#0a3b82f6"
                mid: "#033b82f6"
                midAt: 0.6
                breathLow: 0.5
                breath: 7500
            }
        }

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: Theme.pad
            anchors.rightMargin: Theme.pad + hud.navigationWidth + Theme.sectionGap
            spacing: Theme.gap

            HudHeader {
                Layout.fillWidth: true
                z: 20
                onLoginRequested: hud.openLogin()
            }

            // One pane per entry of `hud.sections`, in the same order, then
            // login; the stack shows the one `hud.view` names.
            StackLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                currentIndex: hud.sections.concat(["login"]).indexOf(hud.view)

                RowLayout {
                    spacing: Theme.sectionGap

                    // Toggled as one unit with Ctrl+B.
                    Sidebar {
                        visible: hud.sidebarOpen
                        // A nested Layout defaults Layout.fillWidth to true, which
                        // would let the sidebar swallow the whole row and crush the
                        // transcript; pin it to a fixed column instead.
                        Layout.fillWidth: false
                        Layout.preferredWidth: Theme.sidebarMeasure
                        Layout.minimumWidth: Theme.sidebarMeasure
                        Layout.maximumWidth: Theme.sidebarMeasure
                        Layout.fillHeight: true
                        onRefocused: composer.take()
                        onGhostDeleteRequested: name => hud.ask("ghost", name, "")
                        onConversationDeleteRequested: (sessionId, title) =>
                            hud.ask("conversation", sessionId, title)
                    }

                    ColumnLayout {
                        // A narrow window has room for one column, so the file pane
                        // takes this one's place until it closes.
                        visible: !hud.workbenchOpen || hud.workbenchSplit
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        spacing: Theme.gap

                        Text {
                            visible: Ghostd.transcriptHistoryTruncated
                            Layout.fillWidth: true
                            text: "Earlier conversation history is unavailable."
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            wrapMode: Text.Wrap
                        }

                        ListView {
                            id: transcriptView

                            // Follow the stream, but only while the user is already
                            // at the bottom — yanking the view back down while they
                            // read earlier text is worse than falling behind.
                            property bool pinned: true

                            Layout.fillWidth: true
                            Layout.fillHeight: true
                            clip: true
                            spacing: Theme.gap
                            model: Ghostd.transcript
                            cacheBuffer: 400
                            header: ResourcesLine { width: transcriptView.width }

                            delegate: Bubble {
                                // One required property per ListModel role. A
                                // dynamically-filled ListModel has no schema, so
                                // test/fixtures/transcript-role-probe.mjs checks
                                // these against Ghostd.cloneTranscriptRow.
                                required property string role
                                required property string text
                                required property var toolActivity
                                required property string error
                                required property bool pending
                                required property string entryId
                                required property int index

                                width: transcriptView.width
                                rowIndex: index
                                speaker: role
                                body: text
                                activities: toolActivity
                                failure: error
                                busy: pending
                                sourceEntryId: entryId
                                onBranchRequested: id => hud.requestBranch(id)
                            }

                            onContentYChanged: pinned = contentY >= contentHeight - height - 40
                            onCountChanged: if (pinned) positionViewAtEnd()
                            onContentHeightChanged: if (pinned) positionViewAtEnd()

                            // A declared child of a ListView lands in the scrolling
                            // contentItem, whose height is 0 while the list is
                            // empty — so centre against the *view* explicitly
                            // rather than against `parent`.
                            Welcome {
                                anchors.horizontalCenter: parent.horizontalCenter
                                y: Math.max(0, (transcriptView.height - height) / 2)
                                visible: transcriptView.count === 0
                                // A greeting is a short paragraph, so the card is
                                // as wide as one reads well, in columns. A narrow
                                // HUD gives it the whole column: a fraction of one
                                // would wrap every third word.
                                width: Math.min(transcriptView.width - Theme.pad * 2,
                                    Theme.ch(46) + Theme.pad * 2)
                                onLoginRequested: hud.openLogin()
                            }
                        }

                        UpdateNotice {
                            Layout.fillWidth: true
                        }

                        ActivityLine {
                            Layout.fillWidth: true
                        }

                        QueueLine {
                            Layout.fillWidth: true
                            steering: Ghostd.steeringQueue
                            followUps: Ghostd.followUpQueue
                            error: Ghostd.queueError
                        }

                        // A branch that refused. It belongs here, under the
                        // transcript it would have forked, and clears itself on
                        // the next attempt or on a click.
                        Text {
                            visible: Ghostd.branchError !== ""
                            Layout.fillWidth: true
                            text: Ghostd.branchError
                            color: Theme.ghostRose
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            wrapMode: Text.Wrap

                            MouseArea {
                                anchors.fill: parent
                                cursorShape: Qt.PointingHandCursor
                                onClicked: Ghostd.branchError = ""
                            }
                        }

                        AskDialog {
                            visible: Ghostd.pendingAsk !== null
                            Layout.fillWidth: true
                            interaction: Ghostd.pendingAsk || ({ questions: [] })
                            submitting: Ghostd.askSubmitting
                            error: Ghostd.askError
                            onAnswered: answer => Ghostd.answerAsk(answer)
                            onChatRequested: Ghostd.chatAboutAsk()
                            onDismissed: Ghostd.dismissAsk()
                        }

                        Composer {
                            id: composer
                            visible: Ghostd.pendingAsk === null
                            Layout.fillWidth: true
                            // Room for a real draft before it scrolls, never the
                            // whole pane: the transcript above must stay in view.
                            maxHeight: Math.max(160, Math.floor(hud.height * 0.4))

                            onSubmitted: (prompt, mode) => {
                                if (mode === "prompt") Ghostd.send(prompt);
                                else Ghostd.queueMessage(prompt, mode);
                            }
                        }
                    }

                    // The workbench: a file the ghost wrote, opened from its tool
                    // card. Nothing is instantiated while it is closed, and while
                    // it is open it either takes the larger half of the body or,
                    // on a narrow window, the whole of it.
                    Loader {
                        active: hud.workbenchOpen
                        visible: hud.workbenchOpen
                        Layout.fillHeight: true
                        Layout.fillWidth: !hud.workbenchSplit
                        Layout.preferredWidth: hud.workbenchSplit ? hud.workbenchWidth : 0
                        Layout.minimumWidth: hud.workbenchSplit ? hud.paneMinimumWidth : 0

                        sourceComponent: FilePane {
                            filePath: Workbench.filePath
                            onClosed: Workbench.close()
                        }
                    }
                }

                Board {
                    onCloseRequested: hud.showSection("chat")
                }

                // Character replaces chat rather than nesting its roster/conversation
                // sidebar inside its own surface. The persona edits through the
                // daemon's validating writer rather than the workbench's direct
                // file editor: the daemon owns the size cap, so a bad edit is
                // refused at Save instead of breaking the next cold start.
                CharacterPane {
                    onClosed: hud.showSection("chat")
                }

                // The effective command palette is conversation-scoped. A pick
                // returns to chat with the command staged, never already running.
                CommandsBrowser {
                    onCommandPicked: invocation => {
                        hud.currentSection = "chat";
                        composer.stageCommand(invocation);
                    }
                }

                // Machine-level hook configuration is global: the owner's command
                // hooks are edited in place. It never creates or selects a
                // conversation merely to show status.
                HooksBrowser {}

                McpBrowser {}

                RemoteAccess {
                    onCloseRequested: hud.showSection("chat")
                }

                // "Connect a model": swaps in over the transcript body.
                ModelLogin {
                    id: modelLogin
                    onCloseRequested: hud.loginOpen = false
                }
            }
        }

        // A permanent rail at the far right, reserving its width instead of
        // covering the content.
        GhostNavigation {
            id: navigation
            anchors.top: parent.top
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            width: hud.navigationWidth
            currentSection: hud.currentSection
            activeHookCount: Ghostd.activeHookCount
            onSelected: section => hud.showSection(section)
        }

        // The dialogs sit over the whole card, above the layout, so the scrim
        // dims the sidebar and transcript alike.
        ConfirmDialog {
            id: deleteDialog

            anchors.fill: parent
            open: hud.pendingSession !== ""
            title: "Move conversation to Trash?"
            body: "“" + (deleteDialog.open ? hud.pending.title : "") + "” and its transcript "
                + "will be moved to the trash. This cannot be undone from the HUD."
            confirmText: "Move to Trash"
            busy: deleteDialog.open && Ghostd.deletingSessionId === hud.pendingSession
            error: deleteDialog.open ? Ghostd.sessionsError : ""
            onConfirmed: Ghostd.deleteConversation(hud.pendingSession)
            onDismissed: hud.dismissPending()
        }

        // The relay asking to pair shows a six-digit code in its popup. The
        // same code here is the whole check: Allow only on a match.
        ConfirmDialog {
            id: pairDialog

            readonly property string code: Ghostd.relayPairing ? Ghostd.relayPairing.code : ""

            anchors.fill: parent
            open: Ghostd.relayPairing !== null
            title: "Let a browser pair?"
            body: "A Chromium extension wants to drive tabs for your ghosts. "
                + "Its popup shows code " + pairDialog.code.slice(0, 3) + " "
                + pairDialog.code.slice(3) + ". Allow only if that matches."
            confirmText: "Allow"
            cancelText: "Deny"
            destructive: false
            busy: Ghostd.relayResolving
            error: Ghostd.relayError
            onConfirmed: if (pairDialog.code !== "") Ghostd.resolveRelayPairing(pairDialog.code, true)
            onDismissed: if (pairDialog.code !== "") Ghostd.resolveRelayPairing(pairDialog.code, false)
        }

        // Branching overwrites the composer with the branched message's text.
        // Only asked when that would cost something the user typed.
        ConfirmDialog {
            anchors.fill: parent
            open: hud.pendingBranch !== ""
            title: "Replace what you're typing?"
            body: "Branching opens a copy of this conversation and puts that "
                + "message's text in the composer. What you have typed there "
                + "now is not saved anywhere."
            confirmText: "Replace"
            destructive: false
            onConfirmed: {
                const entryId = hud.pendingBranch;
                hud.pending = null;
                Ghostd.branchFrom(entryId);
            }
            onDismissed: hud.dismissPending()
        }

        // Banishing a ghost is the same question one notch louder: the daemon
        // wants the name echoed back byte for byte, so the dialog collects it.
        ConfirmDialog {
            id: banishDialog

            anchors.fill: parent
            open: hud.pendingGhost !== ""
            title: "Banish " + hud.pendingGhost + "?"
            body: "Its persona, memories, credentials, and conversations move to Trash. "
                + "The owner's own documents stay on this machine. Type “"
                + hud.pendingGhost + "” to confirm."
            challenge: hud.pendingGhost
            confirmText: "Banish"
            busy: banishDialog.open && Ghostd.deletingGhost === hud.pendingGhost
            error: banishDialog.open ? Ghostd.ghostDeleteError : ""
            onConfirmed: Ghostd.deleteGhost(hud.pendingGhost)
            onDismissed: hud.dismissPending()
        }
    }
}
