pragma ComponentBehavior: Bound

// GhostHud — history, the board, routines and settings, the way the desktop
// shows its own menu: a card over everything on the focused monitor, on the
// theme's [menu] scrim. It is a window shaped by DesktopKeys' rules, so
// SUPER+W closes it rather than the app behind. It opens on the
// Launcher (a filter over conversations and places); choosing a row grows the
// card into that view, and Esc steps back to the list, then out. Panel.qml
// owns it and forwards the host shell's summons (a section or conversation
// payload: bar mark, desktop entry, toast, the presence card's "open").
//
// Shape decisions:
//
//   one monitor           the focused one at open, where Hyprland maps a new
//                         window; the rules size it to that monitor.
//   the list's place      a fixed top a fifth of the way down, so filtering
//                         shortens the card without moving the field; a view
//                         grows from there to most of the screen.
//   leaving               Esc after a standing question, the workbench and the
//                         view, the summon toggle, a click on the scrim, or the
//                         compositor closing the window (SUPER+W). A turn keeps
//                         running when it closes; Shift+Esc stops one.
//   hand-offs             opening a link, a file or the external editor closes
//                         it, or the app it opened would sit underneath.
import Quickshell
import QtQuick
import QtQuick.Layouts
import "services"
import "components"
import "services/DesktopKeys.js" as Desk

FloatingWindow {
    id: hud

    /** Driven by Panel.qml. Bound to `visible`. */
    property bool shown: false
    /** "home" or "ghosts" (the launcher's two lists), or one of `sections`. */
    property string currentSection: "home"
    /** The views a row opens, in the body stack's order. */
    readonly property var sections: ["chat", "board", "routines", "character", "hooks", "mcp", "remote"]
    /** The card is a list: the launcher, over conversations or over ghosts. */
    readonly property bool home: hud.currentSection === "home" || hud.currentSection === "ghosts"

    // Deleting a conversation and banishing a ghost are asked in a modal over
    // the whole card rather than in the row: a row is one line of a scrolling
    // list, and a question that costs something deserves the middle of the
    // screen. One question stands at a time, as { kind: "conversation" |
    // "ghost", id, title } or null. It lives here, not in the list that raised it, because the dialog
    // outlives the delegate (a refresh rebuilds every row).
    property var pending: null
    readonly property string pendingSession: hud.pendingId("conversation")
    readonly property string pendingGhost: hud.pendingId("ghost")

    // The file pane sits beside the chat when both columns can still be read,
    // and takes the chat's place when they cannot.
    readonly property int chatMinimumWidth: 380
    readonly property int paneMinimumWidth: 320
    readonly property int bodyWidth: card.width - Theme.pad * 2
    readonly property bool workbenchOpen: Workbench.filePath !== ""
    readonly property bool workbenchSplit: hud.workbenchOpen
        && hud.bodyWidth >= hud.chatMinimumWidth + hud.paneMinimumWidth + Theme.sectionGap
    readonly property int workbenchWidth: {
        const region = hud.bodyWidth - Theme.sectionGap;
        return Math.max(hud.paneMinimumWidth,
            Math.min(Math.round(region * 0.55), region - hud.chatMinimumWidth));
    }

    visible: hud.shown
    // DesktopKeys' rules find it by this title (a plugin's windows carry the
    // host shell's app-id) and size it to the monitor; these sizes are only
    // what it asks for before they apply.
    title: Desk.HUD_TITLE
    color: "transparent"
    implicitWidth: 1280
    implicitHeight: 800

    // The compositor can close the window itself (SUPER+W). Without this,
    // `shown` stays true, the host takes the hidden HUD for open, and the next
    // summon only "hides" it.
    onVisibleChanged: if (!hud.visible) hud.shown = false

    // Materialize on summon: the content takes a breath of scale and opacity
    // instead of cutting in.
    onShownChanged: {
        Ghostd.hudVisible = hud.shown;
        if (hud.shown && !Theme.reducedMotion)
            materialize.restart();
    }

    function open(): void {
        hud.shown = true;
        hud.raise();
        Ghostd.refresh();
        Dictation.refresh();
        hud.showSection("home");
    }

    function close(): void {
        hud.shown = false;
    }

    /** Give the window the focus: a new one, or one left open behind another app. */
    function raise(): void {
        for (const command of Desk.focusCommands(Desk.HUD_TITLE)) Quickshell.execDetached(command);
    }

    function focused(): bool {
        return hud.contentItem.Window.active;
    }

    /** Each pane fetches its own data when it becomes visible. */
    function showSection(section: string): void {
        if (section !== "home" && section !== "ghosts" && hud.sections.indexOf(section) < 0) return;
        hud.currentSection = section;
        if (hud.home) launcher.reset();
        else if (section === "chat") composer.take();
    }

    /** A fresh conversation, the keyboard in its composer. */
    function startConversation(): void {
        Ghostd.newConversation();
        hud.showSection("chat");
    }

    function launch(row: var): void {
        if (row.kind === "new") {
            hud.startConversation();
        } else if (row.kind === "ask") {
            Ghostd.newConversation();
            Ghostd.send(row.detail);
            hud.showSection("chat");
        } else if (row.kind === "session") {
            Ghostd.openConversation(row.id);
            hud.showSection("chat");
        } else if (row.kind === "place") {
            hud.showSection(row.id);
        } else if (row.kind === "ghost") {
            // The open file lives in the ghost being left.
            if (row.id !== Ghostd.activeGhost) Workbench.close();
            Ghostd.selectGhost(row.id);
            hud.showSection("home");
        } else if (row.kind === "summon") {
            Workbench.close();
            Ghostd.createGhost(row.title);
            hud.showSection("home");
        }
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
        if (hud.home) launcher.reset();
        else if (hud.currentSection === "chat") composer.take();
    }

    // A dialog shows only the daemon's refusal of its own attempt, so that
    // error is cleared when the question opens and when it closes.
    function clearPendingError(): void {
        if (hud.pendingSession !== "") Ghostd.sessionsError = "";
        if (hud.pendingGhost !== "") Ghostd.ghostDeleteError = "";
    }

    Binding {
        target: Ghostd
        property: "hudChatFocused"
        value: hud.shown && hud.focused() && hud.currentSection === "chat"
            && (!hud.workbenchOpen || hud.workbenchSplit)
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

        function onComposerDraft(text: string): void {
            composer.restore(text);
        }
    }

    Connections {
        target: ExternalLinks
        function onHandedOff(): void {
            hud.close();
        }
    }

    // The desktop, dimmed; a click on it is a click away from Ghost.
    Rectangle {
        anchors.fill: parent
        color: Theme.menuScrim

        MouseArea {
            anchors.fill: parent
            onClicked: hud.close()
        }
    }

    Rectangle {
        id: card

        // The list is a launcher's width at a fixed top; a view grows from
        // that top to most of the screen, leaving scrim round it so it reads
        // as over the desktop, not instead of it.
        readonly property int inset: Math.max(Theme.sectionGap * 2, Math.round(Math.min(hud.width, hud.height) * 0.04))
        readonly property int listTop: Math.round(hud.height * 0.2)
        x: Math.round((hud.width - card.width) / 2)
        y: hud.home ? card.listTop : card.inset
        width: hud.home ? Math.min(hud.width - card.inset * 2, Theme.ch(76) + Theme.pad * 2)
            : Math.min(hud.width - card.inset * 2, Theme.ch(180))
        // A standing question needs room the list alone may not give it.
        height: hud.home
            ? (hud.pending !== null ? Math.max(launcher.implicitHeight, Theme.ch(40)) : launcher.implicitHeight)
            : hud.height - card.inset * 2
        color: Theme.menuBackground
        border.width: 1
        border.color: Theme.menuBorder
        radius: Theme.radius
        clip: true

        Behavior on y { enabled: !Theme.reducedMotion; NumberAnimation { duration: 220; easing.type: Easing.OutCubic } }
        Behavior on width { enabled: !Theme.reducedMotion; NumberAnimation { duration: 220; easing.type: Easing.OutCubic } }
        Behavior on height { enabled: !Theme.reducedMotion; NumberAnimation { duration: 220; easing.type: Easing.OutCubic } }

        // Clicks inside the card are the card's business, not the backdrop's.
        MouseArea { anchors.fill: parent }

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
        // Esc steps back out: a standing question, then the workbench, then
        // the view back to the list, then the HUD itself. A turn runs on
        // behind it; Shift+Esc stops one.
        Keys.onEscapePressed: event => {
            event.accepted = true;
            if (hud.pending !== null) hud.dismissPending();
            else if ((event.modifiers & Qt.ShiftModifier) && Ghostd.working) Ghostd.cancel();
            else if (hud.workbenchOpen) Workbench.close();
            else if (hud.currentSection !== "home") hud.showSection("home");
            else hud.close();
        }
        // Ctrl+N starts a conversation, as in any chat app. It reaches the card
        // by focus-chain propagation even while the composer holds focus,
        // since a plain TextEdit does not consume it. The transcript's scroll
        // keys come first (FollowingList.handleKey).
        Keys.onPressed: event => {
            if (hud.currentSection !== "chat") return;
            if (transcriptView.visible && transcriptView.handleKey(event)) {
                event.accepted = true;
                return;
            }
            if (!(event.modifiers & Qt.ControlModifier) || event.key !== Qt.Key_N) return;
            hud.startConversation();
            event.accepted = true;
        }

        // Two still, cold blobs far under the reading surface. `z: -1` puts
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
            }

            Glow {
                x: parent.width * 0.85 - width / 2
                y: parent.height * 0.8 - height / 2
                width: 400
                core: "#0a3b82f6"
                mid: "#033b82f6"
                midAt: 0.6
            }
        }

        Launcher {
            id: launcher
            anchors.top: parent.top
            anchors.left: parent.left
            anchors.right: parent.right
            visible: hud.home
            focus: hud.home
            mode: hud.currentSection === "ghosts" ? "ghosts" : "home"
            maxListHeight: hud.height - card.listTop - card.inset - Theme.controlHeight * 4
            onActivated: row => hud.launch(row)
            onDeleteRequested: (sessionId, title) => hud.ask("conversation", sessionId, title)
            onBanishRequested: name => hud.ask("ghost", name, "")
            onBackRequested: hud.showSection("home")
            onCloseRequested: hud.close()
        }

        // A pane pads itself, so in a pane only the top bar takes the card's
        // padding: the ‹, the pane's title and its content share one edge.
        // The chat view has no padding of its own and takes it all.
        ColumnLayout {
            // A pane stops inside the card's border, which its own background
            // would otherwise paint over.
            readonly property real inset: hud.currentSection === "chat" ? Theme.pad : card.border.width
            anchors.fill: parent
            anchors.margins: inset
            visible: !hud.home
            spacing: Theme.gap

            // The way back to the list, and out.
            RowLayout {
                Layout.fillWidth: true
                Layout.leftMargin: Theme.pad - parent.inset
                Layout.rightMargin: Theme.pad - parent.inset
                Layout.topMargin: Theme.pad - parent.inset
                z: 20
                spacing: Theme.gap

                GlyphButton {
                    text: "‹"
                    name: "Back to the list"
                    restColor: Theme.foregroundDim
                    font.pixelSize: Theme.fontSizeHeading
                    onClicked: hud.showSection("home")
                }

                // A pane titles itself; the bar only holds the way back and out.
                Item {
                    visible: hud.currentSection !== "chat"
                    Layout.fillWidth: true
                }

                HudHeader {
                    visible: hud.currentSection === "chat"
                    Layout.fillWidth: true
                    onRefocused: composer.take()
                }

                // The way out, in sight; Esc steps back to the list first.
                GlyphButton {
                    text: "×"
                    name: "Close Ghost"
                    onClicked: hud.close()
                }
            }

            // One pane per entry of `hud.sections`, in the same order.
            StackLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                currentIndex: hud.sections.indexOf(hud.currentSection)

                RowLayout {
                    spacing: Theme.sectionGap

                    ColumnLayout {
                        // A narrow window has room for one column, so the file pane
                        // takes this one's place until it closes.
                        visible: !hud.workbenchOpen || hud.workbenchSplit
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        spacing: Theme.gap

                        FollowingList {
                            id: transcriptView

                            Layout.fillWidth: true
                            Layout.fillHeight: true
                            clip: true
                            spacing: Theme.gap
                            model: Ghostd.transcript
                            cacheBuffer: 400
                            isMarked: index => Ghostd.transcript.get(index).role === "user"

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
                                required property int index

                                width: transcriptView.width
                                rowIndex: index
                                speaker: role
                                body: text
                                activities: toolActivity
                                failure: error
                                busy: pending
                            }

                            // A declared child of a ListView lands in the scrolling
                            // contentItem, whose height is 0 while the list is
                            // empty — so centre against the *view* explicitly
                            // rather than against `parent`.
                            Welcome {
                                anchors.horizontalCenter: parent.horizontalCenter
                                y: Math.max(0, (transcriptView.height - height) / 2)
                                visible: transcriptView.count === 0
                                // As wide as a line reads well, in columns. A
                                // narrow HUD gives it the whole column: a fraction
                                // of one would wrap every third word.
                                width: Math.min(transcriptView.width - Theme.pad * 2,
                                    Theme.ch(46) + Theme.pad * 2)
                            }
                        }

                        ActivityLine {
                            Layout.fillWidth: true
                            maxHeight: Math.max(90, Math.floor(card.height * 0.28))
                        }

                        // What the ghost asked here and waits on; any message
                        // answers it, a button just saves typing.
                        QuestionLine {
                            Layout.fillWidth: true
                            question: Ghostd.currentSessionRow ? Ghostd.currentSessionRow.question || null : null
                            onAnswered: text => {
                                transcriptView.toEnd();
                                Ghostd.send(text);
                            }
                            onDismissed: Ghostd.dismissQuestion(Ghostd.currentSessionId)
                        }

                        QueueLine {
                            Layout.fillWidth: true
                            followUps: Ghostd.followUpQueue
                            error: Ghostd.queueError
                        }

                        Composer {
                            id: composer
                            Layout.fillWidth: true
                            // Room for a real draft before it scrolls, never the
                            // whole pane: the transcript above must stay in view.
                            maxHeight: Math.max(160, Math.floor(card.height * 0.4))
                            transcript: transcriptView
                            onNewConversationRequested: hud.startConversation()

                            onSubmitted: prompt => {
                                transcriptView.toEnd();
                                Ghostd.send(prompt);
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
                    onCloseRequested: hud.showSection("home")
                }

                Routines {
                    onCloseRequested: hud.showSection("home")
                }

                // The persona edits through the
                // daemon's validating writer rather than the workbench's direct
                // file editor: the daemon owns the size cap, so a bad edit is
                // refused at Save instead of breaking the next cold start.
                CharacterPane {
                    onClosed: hud.showSection("home")
                }

                // Machine-level hook configuration is global: the owner's command
                // hooks are edited in place. It never creates or selects a
                // conversation merely to show status.
                HooksBrowser {}

                McpBrowser {}

                RemoteAccess {
                    onCloseRequested: hud.showSection("home")
                }
            }
        }

        // The dialogs sit over the whole card, above the layout, so their scrim
        // dims whatever the card shows.
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
