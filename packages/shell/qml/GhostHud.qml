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
import Qt5Compat.GraphicalEffects
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

    // Materialize on summon: the content takes a breath of scale and opacity
    // instead of cutting in. Content-level, because the compositor owns the
    // surface itself; Hyprland's own open animation composes with it.
    onShownChanged: {
        if (hud.shown && !Theme.reducedMotion)
            materialize.restart();
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

        // ---- Ambient fog ----------------------------------------------
        // The old app's AmbientBackground: two cold blobs breathing far under
        // the reading surface. `z: -1` puts them over the card's own fill but
        // beneath every layout child, and `enabled: false` keeps the whole
        // layer out of the input chain. Alphas are held low enough (0.05 /
        // 0.04 at the core) that body text contrast is untouched.
        Item {
            anchors.fill: parent
            z: -1
            enabled: false

            RadialGradient {
                x: parent.width * 0.15 - width / 2
                y: parent.height * 0.2 - height / 2
                width: 400
                height: width
                horizontalRadius: width / 2
                verticalRadius: height / 2
                gradient: Gradient {
                    GradientStop { position: 0.0; color: "#0d8b5cf6" }
                    GradientStop { position: 0.6; color: "#048b5cf6" }
                    GradientStop { position: 1.0; color: "#008b5cf6" }
                }

                SequentialAnimation on opacity {
                    running: !Theme.reducedMotion
                    loops: Animation.Infinite
                    NumberAnimation { to: 0.45; duration: 6000; easing.type: Easing.InOutSine }
                    NumberAnimation { to: 1.0; duration: 6000; easing.type: Easing.InOutSine }
                }
            }

            RadialGradient {
                x: parent.width * 0.85 - width / 2
                y: parent.height * 0.8 - height / 2
                width: 400
                height: width
                horizontalRadius: width / 2
                verticalRadius: height / 2
                gradient: Gradient {
                    GradientStop { position: 0.0; color: "#0a3b82f6" }
                    GradientStop { position: 0.6; color: "#033b82f6" }
                    GradientStop { position: 1.0; color: "#003b82f6" }
                }

                SequentialAnimation on opacity {
                    running: !Theme.reducedMotion
                    loops: Animation.Infinite
                    NumberAnimation { to: 0.5; duration: 7500; easing.type: Easing.InOutSine }
                    NumberAnimation { to: 1.0; duration: 7500; easing.type: Easing.InOutSine }
                }
            }
        }

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: Theme.pad
            spacing: Theme.gap

            // ---- Header ---------------------------------------------------
            Item {
                Layout.fillWidth: true
                implicitHeight: 32

                Row {
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Theme.gap

                    // Presence, not a status LED: the mascot itself carries
                    // reachability. Amber and haloed when the daemon answers,
                    // bare danger-red when it does not.
                    Item {
                        anchors.verticalCenter: parent.verticalCenter
                        implicitWidth: 16
                        implicitHeight: 16

                        // The radii are explicit on every glow here:
                        // RadialGradient defaults them to the full width, not
                        // half, so the falloff would otherwise still be mid-hue
                        // at the bounds and paint a hard-edged square.
                        RadialGradient {
                            anchors.centerIn: parent
                            width: 16 * 2.2
                            height: width
                            horizontalRadius: width / 2
                            verticalRadius: height / 2
                            visible: Ghostd.reachable
                            gradient: Gradient {
                                GradientStop { position: 0.0; color: Theme.amber(0.25) }
                                GradientStop { position: 0.55; color: Theme.amber(0.08) }
                                GradientStop { position: 1.0; color: Theme.amber(0) }
                            }
                        }

                        GhostGlyph {
                            anchors.centerIn: parent
                            size: 16
                            tint: Ghostd.reachable ? Theme.ghostAmber : Theme.danger
                        }
                    }

                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        text: Ghostd.activeGhost === "" ? "ghost" : Ghostd.activeGhost
                        color: Theme.foregroundBright
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize + 1
                        font.weight: Font.DemiBold
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
                        implicitWidth: indicatorRow.implicitWidth + Theme.pad * 1.5
                        implicitHeight: 28
                        radius: Theme.radius / 2
                        color: hud.switcherOpen ? Theme.selection
                            : (indicatorArea.containsMouse ? Theme.hover : "transparent")
                        border.width: hud.switcherOpen || modelIndicator.noneSet ? 1 : 0
                        border.color: hud.switcherOpen ? Theme.accent
                            : (modelIndicator.noneSet ? Theme.warn : Theme.border)

                        Row {
                            id: indicatorRow
                            anchors.centerIn: parent
                            spacing: Theme.gap / 2

                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: hud.switcherOpen ? "Back to chat"
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
                                text: "· Vision"
                                color: Theme.foregroundDim
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                            }

                            // Fallback hint: this model was not explicitly chosen.
                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                visible: !hud.switcherOpen && Ghostd.currentModel
                                    && Ghostd.modelSource === "default"
                                text: "· Default"
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
                        text: "Esc to stop"
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                    }
                }
            }

            // ---- Body -----------------------------------------------------
            RowLayout {
                visible: !hud.loginOpen && !hud.switcherOpen
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: Theme.sectionGap

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
                    spacing: Theme.sectionGap

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
                            required property int index

                            width: transcriptView.width
                            rowIndex: index
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

                        // ---- Empty transcript: the welcome hero -----------
                        // A declared child of a ListView lands in the scrolling
                        // contentItem, whose height is 0 while the list is
                        // empty — so centre against the *view* explicitly
                        // rather than against `parent`.
                        Column {
                            id: welcome

                            anchors.horizontalCenter: parent.horizontalCenter
                            y: Math.max(0, (transcriptView.height - height) / 2)
                            visible: transcriptView.count === 0
                            width: Math.min(transcriptView.width * 0.8, 340)
                            spacing: Theme.pad

                            // Materialize: fade up while swelling past 1 and
                            // settling back. Reduced motion gets the end state.
                            opacity: Theme.reducedMotion ? 1 : 0
                            scale: 1
                            onVisibleChanged: if (welcome.visible && !Theme.reducedMotion) materialize.restart()
                            Component.onCompleted: if (welcome.visible && !Theme.reducedMotion) materialize.start()

                            SequentialAnimation {
                                id: materialize
                                ParallelAnimation {
                                    NumberAnimation {
                                        target: welcome; property: "opacity"
                                        from: 0; to: 1
                                        duration: Theme.durSlow
                                        easing.type: Easing.OutExpo
                                    }
                                    SequentialAnimation {
                                        NumberAnimation {
                                            target: welcome; property: "scale"
                                            from: 0.8; to: 1.05
                                            duration: 460
                                            easing.type: Easing.OutExpo
                                        }
                                        NumberAnimation {
                                            target: welcome; property: "scale"
                                            to: 1.0
                                            duration: 240
                                            easing.type: Easing.OutCubic
                                        }
                                    }
                                }
                            }

                            Item {
                                id: plinth

                                /** Idle float. Kept off `y` so the Column keeps owning layout. */
                                property real bob: 0

                                anchors.horizontalCenter: parent.horizontalCenter
                                width: 72
                                height: 72

                                SequentialAnimation on bob {
                                    running: !Theme.reducedMotion
                                    loops: Animation.Infinite
                                    NumberAnimation { to: -6; duration: 3000; easing.type: Easing.InOutSine }
                                    NumberAnimation { to: 6; duration: 3000; easing.type: Easing.InOutSine }
                                }

                                Item {
                                    width: parent.width
                                    height: parent.height
                                    y: plinth.bob

                                    // Two breathing halos, drifting out of phase
                                    // because their periods differ rather than
                                    // because either one waits.
                                    RadialGradient {
                                        anchors.centerIn: parent
                                        width: 200
                                        height: width
                                        horizontalRadius: width / 2
                                        verticalRadius: height / 2
                                        visible: Ghostd.reachable
                                        gradient: Gradient {
                                            GradientStop { position: 0.0; color: Theme.amber(0.15) }
                                            GradientStop { position: 0.5; color: Theme.amber(0.05) }
                                            GradientStop { position: 1.0; color: Theme.amber(0) }
                                        }

                                        SequentialAnimation on opacity {
                                            running: !Theme.reducedMotion
                                            loops: Animation.Infinite
                                            NumberAnimation { to: 0.5; duration: 2000; easing.type: Easing.InOutSine }
                                            NumberAnimation { to: 1.0; duration: 2000; easing.type: Easing.InOutSine }
                                        }
                                    }

                                    RadialGradient {
                                        anchors.centerIn: parent
                                        width: 132
                                        height: width
                                        horizontalRadius: width / 2
                                        verticalRadius: height / 2
                                        visible: Ghostd.reachable
                                        gradient: Gradient {
                                            GradientStop { position: 0.0; color: Theme.ember(0.10) }
                                            GradientStop { position: 0.5; color: Theme.ember(0.04) }
                                            GradientStop { position: 1.0; color: Theme.ember(0) }
                                        }

                                        SequentialAnimation on opacity {
                                            running: !Theme.reducedMotion
                                            loops: Animation.Infinite
                                            NumberAnimation { to: 0.45; duration: 1500; easing.type: Easing.InOutSine }
                                            NumberAnimation { to: 1.0; duration: 1500; easing.type: Easing.InOutSine }
                                        }
                                    }

                                    Rectangle {
                                        anchors.fill: parent
                                        radius: Theme.radiusLarge
                                        color: Theme.film(0.04)
                                        border.width: 1
                                        border.color: Theme.film(0.10)

                                        GhostGlyph {
                                            anchors.centerIn: parent
                                            size: 36
                                            tint: Ghostd.reachable ? Theme.ghostAmberBright : Theme.danger
                                        }
                                    }
                                }
                            }

                            Text {
                                anchors.horizontalCenter: parent.horizontalCenter
                                text: Ghostd.activeGhost === "" ? "ghost" : Ghostd.activeGhost
                                color: Theme.foregroundBright
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSize + 8
                                font.weight: Font.Medium
                            }

                            // The invitation. Amber film, so the ghost's own
                            // colour asks the question.
                            Rectangle {
                                anchors.horizontalCenter: parent.horizontalCenter
                                visible: Ghostd.reachable
                                width: parent.width
                                height: invitation.implicitHeight + Theme.pad * 2
                                radius: Theme.radiusLarge
                                color: Theme.amber(0.06)
                                border.width: 1
                                border.color: Theme.amber(0.15)

                                Text {
                                    id: invitation
                                    anchors.centerIn: parent
                                    width: parent.width - Theme.pad * 2
                                    horizontalAlignment: Text.AlignHCenter
                                    text: "What's on your mind?"
                                    color: Theme.foreground
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSize
                                    wrapMode: Text.Wrap
                                }
                            }

                            // The same hero, failed: rose film instead of amber.
                            Rectangle {
                                anchors.horizontalCenter: parent.horizontalCenter
                                visible: !Ghostd.reachable
                                width: parent.width
                                height: unreachable.implicitHeight + Theme.pad * 2
                                radius: Theme.radiusLarge
                                color: Theme.rose(0.08)
                                border.width: 1
                                border.color: Theme.rose(0.20)

                                Text {
                                    id: unreachable
                                    anchors.centerIn: parent
                                    width: parent.width - Theme.pad * 2
                                    horizontalAlignment: Text.AlignHCenter
                                    text: "ghostd is not answering on " + Ghostd.baseUrl
                                    color: Theme.foreground
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSize
                                    wrapMode: Text.Wrap
                                }
                            }
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
