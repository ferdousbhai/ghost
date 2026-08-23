pragma ComponentBehavior: Bound

// GhostHud — the chat window. A normal xdg-toplevel (FloatingWindow), NOT a
// wlr-layer surface: Hyprland tiles it, resizes it, and moves it between
// workspaces with its own binds (Shift+SUPER+<n>, movewindow, …) like any app.
// Summoned from a keybind or the tray through Quickshell IPC (see shell.qml and
// contrib/hyprland/), not by clicking anything on the desktop.
//
// Window-shape decisions:
//
//   FloatingWindow        the one Quickshell 0.3.0 construct that presents as a
//                         standard toplevel window. It is what makes the WM
//                         treat the HUD as a real client (`hyprctl clients`),
//                         so no custom screen-move code is needed any more —
//                         the compositor owns placement, tiling and monitors.
//   app-id "ghost"        set process-wide via `//@ pragma AppId ghost` in
//                         shell.qml (an instance pragma; it must live in the
//                         root file). That is the window class Hyprland sees,
//                         so a user can target it with `windowrule = …,
//                         class:^(ghost)$`. The title carries the active ghost.
//   color / no border     the window paints an opaque Theme.background and lets
//                         Hyprland draw the frame, border and rounding. An app
//                         drawing its own rounded border inside the WM's frame
//                         just doubles the edge.
//
// Summon is launch-or-focus, not overlay-toggle: `open`/`summon` reveal the
// window and focus it (Hyprland auto-focuses a freshly mapped toplevel, and
// `focuswindow` handles the already-open case); the SUPER+G `toggle` hides it
// only when it is already the focused window, otherwise it reveals+focuses.
import Quickshell
import Quickshell.Hyprland
import QtQuick
import QtQuick.Layouts
import qs.services
import qs.components

FloatingWindow {
    id: hud

    /** Driven by IPC; see the IpcHandler in shell.qml. Bound to `visible`. */
    property bool shown: false
    /** The whole left sidebar (ghost roster + conversations). Toggled with Ctrl+B. */
    property bool sidebarOpen: true
    /** The "Connect a model" panel replaces the transcript body when open. */
    property bool loginOpen: false
    /** The model switcher replaces the transcript body when open. */
    property bool switcherOpen: false
    /** True when login was reached from the switcher, so closing returns there. */
    property bool loginFromSwitcher: false

    visible: hud.shown
    color: Theme.background
    title: Ghostd.activeGhost === "" ? "Ghost" : "Ghost — " + Ghostd.activeGhost

    // A reasonable default; the WM resizes/tiles from here. minimumSize keeps a
    // tiled slice from collapsing the composer and roster into nothing.
    implicitWidth: 880
    implicitHeight: 620
    minimumSize: Qt.size(480, 360)

    function open(): void {
        hud.shown = true;
        // The "focus" half of launch-or-focus. A freshly mapped toplevel is
        // auto-focused by Hyprland; this also pulls an already-open window
        // (possibly on another workspace) to the foreground. Matches the
        // app-id set by `//@ pragma AppId ghost` in shell.qml.
        Hyprland.dispatch("focuswindow class:ghost");
        hud.loginOpen = false;
        hud.switcherOpen = false;
        Ghostd.refresh();
        composer.take();
    }

    function close(): void {
        hud.shown = false;
    }

    function openLogin(): void {
        hud.loginFromSwitcher = false;
        hud.switcherOpen = false;
        hud.loginOpen = true;
        modelLogin.open();
    }

    /** Open the model switcher over the transcript. */
    function openSwitcher(): void {
        hud.loginOpen = false;
        hud.switcherOpen = true;
        modelSwitcher.open();
    }

    /** Reach the provider login from the switcher; closing it returns to the switcher. */
    function openLoginFromSwitcher(): void {
        hud.loginFromSwitcher = true;
        hud.switcherOpen = false;
        hud.loginOpen = true;
        modelLogin.open();
    }

    /** Authenticate a model already selected in the switcher; completion returns to chat. */
    function openLoginForSelectedModel(): void {
        hud.loginFromSwitcher = false;
        hud.switcherOpen = false;
        hud.loginOpen = true;
        modelLogin.open();
    }

    /**
     * Launch-or-focus on a single bind (SUPER+G). Reveal+focus when hidden or
     * when open but not the focused window; hide only when it is already the
     * focused window. Hyprland's own move/tile/workspace binds handle placement,
     * so there is no screen-move code here — the WM owns it.
     */
    function toggle(): void {
        if (!hud.shown || !hud.focused())
            hud.open();
        else
            hud.close();
    }

    /** True when our toplevel (app-id "ghost") is Hyprland's focused window. */
    function focused(): bool {
        const top = Hyprland.activeToplevel;
        return !!(top && top.lastIpcObject && top.lastIpcObject["class"] === "ghost");
    }

    Rectangle {
        id: card

        // Fill the window and paint a plain rectangle; Hyprland draws the frame,
        // border and rounding for a normal toplevel.
        anchors.fill: parent
        color: Theme.background

        focus: true
        // Esc-to-close is unusual for a normal app window, so Esc only cancels a
        // running turn; dismiss with SUPER+G or the tray. Left unhandled when
        // idle so it never swallows a compositor bind.
        Keys.onEscapePressed: event => {
            event.accepted = Ghostd.streaming;
            if (Ghostd.streaming) Ghostd.cancel();
        }
        // Ctrl+B toggles the whole left sidebar, editor-style. This reaches the
        // card by focus-chain propagation even while the composer holds focus,
        // since a plain TextEdit does not consume Ctrl+B.
        Keys.onPressed: event => {
            if ((event.modifiers & Qt.ControlModifier) && event.key === Qt.Key_B) {
                hud.sidebarOpen = !hud.sidebarOpen;
                event.accepted = true;
            }
        }

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: Theme.pad
            spacing: Theme.gap

            // ---- Header ---------------------------------------------------
            Item {
                Layout.fillWidth: true
                implicitHeight: 26

                Row {
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Theme.gap

                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        text: "◉"
                        color: Ghostd.reachable ? Theme.accent : Theme.danger
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize + 3
                    }

                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        text: Ghostd.activeGhost === "" ? "ghost" : Ghostd.activeGhost
                        color: Theme.foregroundBright
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize + 1
                        font.bold: true
                    }
                }

                Row {
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Theme.pad

                    // Current-model indicator → opens the switcher. Shows the
                    // model name (or id), a vision badge, a "default" hint when
                    // the pick is only a fallback, and a CTA when nothing is set.
                    Rectangle {
                        id: modelIndicator

                        readonly property bool noneSet: Ghostd.currentModel === null
                            || Ghostd.modelSource === "none"

                        anchors.verticalCenter: parent.verticalCenter
                        visible: Ghostd.activeGhost !== ""
                        implicitWidth: indicatorRow.implicitWidth + Theme.pad
                        implicitHeight: 22
                        radius: Theme.radius / 2
                        color: indicatorArea.containsMouse ? Theme.selection : "transparent"
                        border.width: 1
                        border.color: hud.switcherOpen ? Theme.accent
                            : (modelIndicator.noneSet ? Theme.warn : Theme.muted)

                        Row {
                            id: indicatorRow
                            anchors.centerIn: parent
                            spacing: Theme.gap / 2

                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: hud.switcherOpen ? "back to chat"
                                    : (Ghostd.currentModel
                                        ? (Ghostd.currentModel.name || Ghostd.currentModel.id)
                                        : "Choose a model")
                                color: hud.switcherOpen ? Theme.accent
                                    : (modelIndicator.noneSet ? Theme.warn : Theme.foreground)
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                elide: Text.ElideRight
                            }

                            // Vision badge.
                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                visible: !hud.switcherOpen && Ghostd.currentModel
                                    && Ghostd.currentModel.hasVision === true
                                text: "· vision"
                                color: Theme.foregroundDim
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                            }

                            // Fallback hint: this model was not explicitly chosen.
                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                visible: !hud.switcherOpen && Ghostd.currentModel
                                    && Ghostd.modelSource === "default"
                                text: "· default"
                                color: Theme.foregroundDim
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                            }
                        }

                        MouseArea {
                            id: indicatorArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                if (hud.switcherOpen) {
                                    hud.switcherOpen = false;
                                    composer.take();
                                } else {
                                    hud.openSwitcher();
                                }
                            }
                        }
                    }

                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        visible: Ghostd.streaming
                        text: "esc to stop"
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                    }
                }
            }

            Rectangle {
                Layout.fillWidth: true
                implicitHeight: 1
                color: Theme.muted
            }

            // ---- Body -----------------------------------------------------
            RowLayout {
                visible: !hud.loginOpen && !hud.switcherOpen
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: Theme.pad

                // Left sidebar: the ghost roster stacked over this ghost's
                // conversations, each in its own scroller so a long list never
                // crowds the other out. Toggled as one unit with Ctrl+B.
                ColumnLayout {
                    id: sidebar
                    visible: hud.sidebarOpen
                    // A nested Layout defaults Layout.fillWidth to true, which
                    // would let the sidebar swallow the whole row and crush the
                    // transcript; pin it to a fixed column instead.
                    Layout.fillWidth: false
                    Layout.preferredWidth: 190
                    Layout.minimumWidth: 190
                    Layout.maximumWidth: 190
                    Layout.fillHeight: true
                    spacing: Theme.gap

                    Flickable {
                        id: rosterScroll
                        Layout.fillWidth: true
                        // Prefer the roster's own height, but cap it with a fixed
                        // ceiling so a long ghost list never starves the
                        // conversations below; both scroll past their share.
                        // The cap is a constant on purpose — deriving it from
                        // `sidebar.height` feeds the layout's size back into a
                        // child hint and trips a recursive rearrange.
                        Layout.preferredHeight: Math.min(roster.implicitHeight, 220)
                        contentWidth: width
                        contentHeight: roster.implicitHeight
                        clip: true
                        interactive: contentHeight > height
                        boundsBehavior: Flickable.StopAtBounds

                        Roster {
                            id: roster
                            width: rosterScroll.width
                            onPicked: {
                                hud.loginOpen = false;
                                composer.take();
                            }
                        }
                    }

                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: 1
                        color: Theme.muted
                    }

                    Flickable {
                        id: convoScroll
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        contentWidth: width
                        contentHeight: conversations.implicitHeight
                        clip: true
                        interactive: contentHeight > height
                        boundsBehavior: Flickable.StopAtBounds

                        Conversations {
                            id: conversations
                            width: convoScroll.width
                            onPicked: {
                                hud.loginOpen = false;
                                composer.take();
                            }
                        }
                    }
                }

                ColumnLayout {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    spacing: Theme.gap

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

                        delegate: Bubble {
                            // One required property per ListModel role. qmllint
                            // cannot introspect a dynamically-filled ListModel,
                            // so it reports these as unbound — see dev/README.md
                            // for the expected-warning list.
                            required property string role
                            required property string text
                            required property string tools
                            required property var toolActivity
                            required property string error
                            required property bool pending
                            required property string entryId
                            required property var branch

                            width: transcriptView.width
                            speaker: role
                            body: text
                            toolTrail: tools
                            activities: toolActivity
                            failure: error
                            busy: pending
                            sourceEntryId: entryId
                            branchNavigation: branch
                        }

                        onContentYChanged: pinned = contentY >= contentHeight - height - 40
                        onCountChanged: if (pinned) positionViewAtEnd()
                        onContentHeightChanged: if (pinned) positionViewAtEnd()

                        Text {
                            anchors.centerIn: parent
                            visible: transcriptView.count === 0
                            width: transcriptView.width * 0.7
                            horizontalAlignment: Text.AlignHCenter
                            text: Ghostd.reachable
                                ? "Nothing said yet."
                                : "ghostd is not answering on " + Ghostd.baseUrl
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                            wrapMode: Text.Wrap
                        }
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

                    AskDialog {
                        visible: Ghostd.pendingAsk !== null
                        Layout.fillWidth: true
                        interaction: Ghostd.pendingAsk || ({ questions: [] })
                        submitting: Ghostd.askSubmitting
                        error: Ghostd.askError
                        onAnswered: answer => Ghostd.answerAsk(answer)
                        onChatRequested: Ghostd.chatAboutAsk()
                    }

                    Composer {
                        id: composer
                        visible: Ghostd.pendingAsk === null
                        Layout.fillWidth: true
                        onSubmitted: (prompt, mode) => {
                            if (mode === "prompt") Ghostd.send(prompt);
                            else Ghostd.queueMessage(prompt, mode);
                        }
                    }
                }
            }

            // Model switcher: swaps in over the transcript body.
            ModelSwitcher {
                id: modelSwitcher
                visible: hud.switcherOpen && !hud.loginOpen
                Layout.fillWidth: true
                Layout.fillHeight: true
                onCloseRequested: {
                    hud.switcherOpen = false;
                    composer.take();
                }
                onConnectProviderRequested: hud.openLoginFromSwitcher()
            }

            // "Connect a model": swaps in over the transcript body.
            ModelLogin {
                id: modelLogin
                visible: hud.loginOpen
                Layout.fillWidth: true
                Layout.fillHeight: true
                onCloseRequested: {
                    hud.loginOpen = false;
                    if (hud.loginFromSwitcher) {
                        hud.loginFromSwitcher = false;
                        hud.openSwitcher();
                    }
                }
            }
        }

        // A switch to an uncredentialed provider's model wrote the role but
        // needs a login before it resolves; route into the login flow.
        Connections {
            target: Ghostd
            function onModelSwitchCompleted(provider: string, id: string): void {
                hud.switcherOpen = false;
                composer.take();
            }
            function onModelSwitchNeedsLogin(provider: string): void {
                hud.openLoginForSelectedModel();
            }
            function onQueueMessageRejected(text: string): void {
                composer.text = text;
                composer.take();
            }
            function onBranchDraftReady(text: string): void {
                composer.text = text;
                composer.take();
            }
        }
    }
}
