pragma ComponentBehavior: Bound

// GhostHud — history, the board, routines and settings, as a takeover: a
// full-screen layer over everything on the focused monitor, fullscreen apps
// included, that holds the keyboard until it closes. Like the presence, it is
// part of the desktop rather than a window among others; the WM does not tile,
// move or close it. Panel.qml owns it and forwards the host shell's summons
// (a section or conversation payload: bar mark, desktop entry, toast, the
// presence card's "open") to open/close.
//
// Takeover-shape decisions:
//
//   one monitor           the focused one at open, like the presence prompt;
//                         other screens stay usable by pointer.
//   backdrop              the desktop stays visible, dimmed, around a centred
//                         surface; clicking it closes the takeover.
//   leaving               Esc after a standing question and the workbench,
//                         the summon toggle, or a backdrop click. A turn keeps
//                         running when it closes; Shift+Esc stops one.
//   hand-offs             opening a link, a file or the external editor closes
//                         it, or the app it opened would sit underneath.
import Quickshell
import Quickshell.Hyprland
import Quickshell.Wayland
import QtQuick
import QtQuick.Layouts
import "services"
import "components"

WlrLayershell {
    id: hud

    /** Driven by Panel.qml. Bound to `visible`. */
    property bool shown: false
    property bool sidebarOpen: true
    property string currentSection: "chat"
    /** The navigable sections, in rail order; the body stack follows it. */
    readonly property var sections: navigation.destinations.map(destination => destination.id)
    readonly property int navigationWidth: navigation.implicitWidth

    /** The monitor it covers, fixed at open. */
    property string screenName: ""

    // Deleting a conversation and banishing a ghost are asked in a modal over
    // the whole window rather than in the row: the row is 16px of a scrolling
    // sidebar, and a question that costs something deserves the middle of the
    // screen. One question stands at a time, as { kind: "conversation" |
    // "ghost", id, title } or null. It lives here, not in the list that raised it, because the dialog
    // outlives the delegate (a refresh rebuilds every row).
    property var pending: null
    readonly property string pendingSession: hud.pendingId("conversation")
    readonly property string pendingGhost: hud.pendingId("ghost")

    // The file pane sits beside the chat when both columns can still be read,
    // and takes the chat's place when they cannot. The test is on the width
    // actually left for the two of them, not on the window: an open sidebar
    // costs its list column plus the gap beside it, which a raw window-width
    // threshold would ignore.
    readonly property int chatMinimumWidth: 380
    readonly property int paneMinimumWidth: 320
    readonly property int bodyWidth: card.width - Theme.pad * 2
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
    screen: Quickshell.screens.find(screen => screen.name === hud.screenName) || Quickshell.screens[0] || null
    anchors { top: true; bottom: true; left: true; right: true } // qmllint disable missing-property
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    namespace: "ghost-hud"
    layer: WlrLayer.Overlay
    keyboardFocus: WlrKeyboardFocus.Exclusive

    // Materialize on summon: the content takes a breath of scale and opacity
    // instead of cutting in.
    onShownChanged: {
        Ghostd.hudVisible = hud.shown;
        if (hud.shown && !Theme.reducedMotion)
            materialize.restart();
    }

    function open(): void {
        if (!hud.shown) hud.screenName = Hyprland.focusedMonitor ? Hyprland.focusedMonitor.name : "";
        hud.shown = true;
        Ghostd.refresh();
        Dictation.refresh();
        hud.showSection("chat");
    }

    function close(): void {
        hud.shown = false;
    }

    function focused(): bool {
        return hud.contentItem.Window.active;
    }

    /** Each pane fetches its own data when it becomes visible. */
    function showSection(section: string): void {
        if (hud.sections.indexOf(section) < 0) return;
        hud.currentSection = section;
        if (section === "chat") composer.take();
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
        color: Qt.rgba(Theme.background.r, Theme.background.g, Theme.background.b, 0.72)

        MouseArea {
            anchors.fill: parent
            onClicked: hud.close()
        }
    }

    Rectangle {
        id: card

        // Most of the screen, square like the rest of Omarchy, with enough
        // backdrop left round it to read as over the desktop, not instead of it.
        readonly property int inset: Math.max(Theme.sectionGap * 2, Math.round(Math.min(hud.width, hud.height) * 0.04))
        anchors.centerIn: parent
        width: Math.min(hud.width - card.inset * 2, Theme.ch(200))
        height: hud.height - card.inset * 2
        color: Theme.background
        border.width: 1
        border.color: Theme.film(0.22)

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
        // the takeover itself. A turn runs on behind it; Shift+Esc stops one.
        Keys.onEscapePressed: event => {
            event.accepted = true;
            if (hud.pending !== null) hud.dismissPending();
            else if ((event.modifiers & Qt.ShiftModifier) && Ghostd.working) Ghostd.cancel();
            else if (hud.workbenchOpen) Workbench.close();
            else hud.close();
        }
        // Ctrl+B toggles the whole left sidebar, editor-style; Ctrl+N starts a
        // conversation, as in any chat app. These reach the card by focus-chain
        // propagation even while the composer holds focus, since a plain
        // TextEdit consumes neither. The transcript's scroll keys come first
        // (FollowingList.handleKey).
        Keys.onPressed: event => {
            if (hud.currentSection !== "chat") return;
            if (transcriptView.visible && transcriptView.handleKey(event)) {
                event.accepted = true;
                return;
            }
            if (!(event.modifiers & Qt.ControlModifier)) return;
            if (event.key === Qt.Key_B) hud.sidebarOpen = !hud.sidebarOpen;
            else if (event.key === Qt.Key_N) sidebar.startConversation();
            else return;
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

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: Theme.pad
            anchors.rightMargin: Theme.pad + hud.navigationWidth + Theme.sectionGap
            spacing: Theme.gap

            HudHeader {
                Layout.fillWidth: true
                z: 20
                onRefocused: composer.take()
            }

            // One pane per entry of `hud.sections`, in the same order.
            StackLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                currentIndex: hud.sections.indexOf(hud.currentSection)

                RowLayout {
                    spacing: Theme.sectionGap

                    // Toggled as one unit with Ctrl+B.
                    Sidebar {
                        id: sidebar
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
                            onNewConversationRequested: sidebar.startConversation()

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
                    onCloseRequested: hud.showSection("chat")
                }

                Routines {
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

                // Machine-level hook configuration is global: the owner's command
                // hooks are edited in place. It never creates or selects a
                // conversation merely to show status.
                HooksBrowser {}

                McpBrowser {}

                RemoteAccess {
                    onCloseRequested: hud.showSection("chat")
                }
            }
        }

        // A permanent rail floating at the right edge, reserving its width
        // instead of covering the content.
        GhostNavigation {
            id: navigation
            anchors.top: parent.top
            anchors.right: parent.right
            anchors.rightMargin: Theme.pad
            anchors.bottom: parent.bottom
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
