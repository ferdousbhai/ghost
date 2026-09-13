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
// `focuswindow` handles the already-open case); the SUPER+CTRL+G `toggle` hides it
// only when it is already the focused window, otherwise it reveals+focuses.
import Quickshell
import Quickshell.Hyprland
import QtQuick
import QtQuick.Layouts
import Qt5Compat.GraphicalEffects
import "services"
import "components"

FloatingWindow {
    id: hud

    /** Driven by IPC; see the IpcHandler in shell.qml. Bound to `visible`. */
    property bool shown: false
    property bool sidebarOpen: true
    property bool loginOpen: false

    // Leaving login abandons any client-only model intent and restores the
    // daemon's effective selection. This catches Close, Done, navigation, and
    // picking another ghost or conversation through the shared panel state.
    onLoginOpenChanged: {
        if (!hud.loginOpen) {
            Ghostd.cancelLogin();
        }
    }
    property string currentSection: "chat"
    readonly property int navigationWidth: 64

    // Deleting a conversation is asked in a modal over the whole window rather
    // than in the row itself: the row is 16px of a scrolling sidebar, and a
    // question that erases a transcript deserves the middle of the screen. The
    // id lives here, not in Conversations, because the dialog outlives the
    // delegate that raised it (a refresh rebuilds every row).
    property string pendingDeleteSessionId: ""
    property string pendingDeleteTitle: ""
    property string pendingDeleteGhost: ""
    /** The message a branch would fork from, held while the composer's own
        draft is being asked about, or "". */
    property string pendingBranchEntryId: ""

    function dismissDelete(): void {
        hud.pendingDeleteSessionId = "";
        hud.pendingDeleteTitle = "";
        Ghostd.sessionsError = "";
        composer.take();
    }

    /**
     * Branch from a message. The copy the daemon makes is a new conversation,
     * so nothing already said is at risk — but the branched text lands in the
     * composer, overwriting whatever is in it, so an unsent draft gets a
     * question first. It is the one thing here nothing else can recover.
     */
    function requestBranch(entryId: string): void {
        if (entryId === "") return;
        if (!composer.hasDraft) {
            Ghostd.branchFrom(entryId);
            return;
        }
        hud.pendingDeleteSessionId = "";
        hud.pendingDeleteGhost = "";
        hud.pendingBranchEntryId = entryId;
    }

    function dismissBranch(): void {
        hud.pendingBranchEntryId = "";
        composer.take();
    }

    function dismissBanish(): void {
        hud.pendingDeleteGhost = "";
        Ghostd.ghostDeleteError = "";
        composer.take();
    }

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

    // How this window is named to the compositor, and the regex that finds it
    // again. Both halves of launch-or-focus go through here.
    readonly property string titlePattern: "^Ghost( — .*)?$"

    // A reasonable default; the WM resizes/tiles from here. minimumSize keeps a
    // tiled slice from collapsing the composer and roster into nothing.
    implicitWidth: 998
    implicitHeight: 620
    minimumSize: Qt.size(568, 360)

    function showSection(section: string): void {
        if (["chat", "commands", "hooks", "mcp", "remote", "character", "board"]
                .indexOf(section) < 0)
            return;
        hud.loginOpen = false;
        hud.currentSection = section;
        if (section === "chat") {
            composer.take();
        } else if (section === "commands") {
            Ghostd.fetchCommands(false);
        } else if (section === "hooks") {
            Ghostd.fetchHooks(false);
        } else if (section === "mcp") {
            Ghostd.fetchMcp(false);
        } else if (section === "character") {
            Ghostd.fetchCharacter(false);
        } else if (section === "board") {
            Ghostd.refreshBoard();
        }
    }

    function open(): void {
        hud.shown = true;
        // The "focus" half of launch-or-focus. A freshly mapped toplevel is
        // auto-focused by Hyprland; this also pulls an already-open window
        // (possibly on another workspace) to the foreground. The window is
        // matched by title, not app-id: inside omarchy-shell the app-id is the
        // host's, and only a root shell.qml may set one.
        // Hyprland 0.55+ dispatches Lua expressions. The old
        // `focuswindow class:ghost` spelling is parsed as invalid Lua.
        Hyprland.dispatch('hl.dsp.focus({ window = "title:' + hud.titlePattern + '" })');
        hud.loginOpen = false;
        hud.currentSection = "chat";
        Ghostd.refresh();
        Ghostd.refreshRelay();
        Dictation.refresh();
        composer.take();
    }

    // The pairing prompt has no event stream; a cheap unauthenticated poll
    // while the HUD is up is what makes it appear.
    Timer {
        interval: 3000
        repeat: true
        running: hud.shown && Ghostd.reachable
        onTriggered: Ghostd.refreshRelay()
    }

    function close(): void {
        hud.loginOpen = false;
        hud.shown = false;
    }

    function openLogin(): void {
        hud.currentSection = "chat";
        hud.loginOpen = true;
        modelLogin.open("");
    }

    /**
     * Launch-or-focus on a single bind (SUPER+CTRL+G). Reveal+focus when hidden or
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

    function focused(): bool {
        const top = Hyprland.activeToplevel;
        const title = top && top.lastIpcObject ? String(top.lastIpcObject["title"] || "") : "";
        return title === "Ghost" || title.startsWith("Ghost — ");
    }

    // Materialize on summon: the content takes a breath of scale and opacity
    // instead of cutting in. Content-level, because the compositor owns the
    // surface itself; Hyprland's own open animation composes with it.
    onShownChanged: {
        Ghostd.hudVisible = hud.shown;
        if (hud.shown) Ghostd.markCurrentConversationRead();
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
        // running turn and then closes the workbench; dismiss with SUPER+CTRL+G
        // or the tray. Left unhandled once there is nothing of ours left to
        // dismiss, so it never swallows a compositor bind.
        Keys.onEscapePressed: event => {
            if (hud.pendingDeleteSessionId !== "") {
                hud.dismissDelete();
                event.accepted = true;
            } else if (hud.pendingDeleteGhost !== "") {
                hud.dismissBanish();
                event.accepted = true;
            } else if (hud.pendingBranchEntryId !== "") {
                hud.dismissBranch();
                event.accepted = true;
            } else if (Ghostd.streaming) {
                Ghostd.cancel();
                event.accepted = true;
            } else if (hud.workbenchOpen) {
                Workbench.close();
                event.accepted = true;
            } else {
                event.accepted = false;
            }
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
            anchors.rightMargin: Theme.pad + hud.navigationWidth + Theme.sectionGap
            spacing: Theme.gap

            Item {
                Layout.fillWidth: true
                implicitHeight: 32
                z: 20

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
                        font.pixelSize: Theme.fontSizeSubtitle
                        font.weight: Font.DemiBold
                    }
                }

                Row {
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Theme.pad

                    // Current-model indicator → opens the login pane. Shows the
                    // model name (or id), Claude subscription when applicable,
                    // a vision badge, a "default" hint when the pick is only a
                    // fallback, and a CTA when nothing is set.
                    Rectangle {
                        id: modelIndicator

                        readonly property bool noneSet: Ghostd.currentModel === null
                            || Ghostd.modelSource === "none"

                        anchors.verticalCenter: parent.verticalCenter
                        visible: Ghostd.activeGhost !== ""
                        implicitWidth: indicatorRow.implicitWidth + Theme.pad * 1.5
                        implicitHeight: 28
                        radius: Theme.radius / 2
                        color: indicatorArea.containsMouse ? Theme.hover : "transparent"
                        border.width: modelIndicator.noneSet ? 1 : 0
                        border.color: modelIndicator.noneSet ? Theme.warn : Theme.border

                        Row {
                            id: indicatorRow
                            anchors.centerIn: parent
                            spacing: Theme.gap / 2

                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: Ghostd.currentModel
                                    ? (Ghostd.currentModel.provider + "/" + Ghostd.currentModel.id)
                                    : "No model: ghost model <provider>/<id>"
                                color: modelIndicator.noneSet ? Theme.warn : Theme.foreground
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                elide: Text.ElideRight
                            }



                            // Fallback hint: this model was not explicitly chosen.
                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                visible: Ghostd.currentModel && Ghostd.modelSource === "default"
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
                            onClicked: hud.openLogin()
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

            RowLayout {
                visible: hud.currentSection === "chat"
                    && !hud.loginOpen
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
                    Layout.preferredWidth: Theme.sidebarMeasure
                    Layout.minimumWidth: Theme.sidebarMeasure
                    Layout.maximumWidth: Theme.sidebarMeasure
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
                                // The open file lives in the ghost we just left.
                                Workbench.close();
                                composer.take();
                            }
                            // Same ghost, so the workbench still holds a file
                            // from the home we are looking at; only the
                            // keyboard has come loose.
                            onRefocused: {
                                hud.loginOpen = false;
                                composer.take();
                            }
                            onDeleteRequested: name => {
                                Ghostd.ghostDeleteError = "";
                                hud.pendingDeleteSessionId = "";
                                hud.pendingDeleteGhost = name;
                            }
                        }
                    }

                    Conversations {
                        id: conversations
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        onPicked: {
                            hud.loginOpen = false;
                            composer.take();
                        }
                        onRefocused: composer.take()
                        onDeleteRequested: (sessionId, title) => {
                            Ghostd.sessionsError = "";
                            hud.pendingDeleteGhost = "";
                            hud.pendingDeleteSessionId = sessionId;
                            hud.pendingDeleteTitle = title;
                        }
                    }

                    // Sidebar footer, Notes-style: the one button that adds to the
                    // list. It lives outside convoScroll so it stays put at the
                    // bottom while the list scrolls behind.
                    Item {
                        Layout.fillWidth: true
                        Layout.preferredHeight: Theme.controlHeight
                        visible: Ghostd.activeGhost !== ""

                        Rectangle {
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            width: Theme.controlHeight
                            height: Theme.controlHeight
                            radius: Theme.radius
                            color: composeArea.containsMouse ? Theme.amber(0.15) : Theme.amber(0.10)
                            border.width: 1
                            border.color: composeArea.containsMouse
                                ? Theme.amber(0.30)
                                : Theme.amber(0.20)

                            Behavior on color {
                                enabled: !Theme.reducedMotion
                                ColorAnimation { duration: Theme.durFast }
                            }

                            Text {
                                anchors.centerIn: parent
                                // "+" over a compose glyph: it is in every
                                // sans-serif, so it never falls back to tofu.
                                text: "+"
                                color: Theme.ghostAmberBright
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeHeading
                            }

                            MouseArea {
                                id: composeArea
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: {
                                    conversations.reset();
                                    Ghostd.newConversation();
                                    hud.loginOpen = false;
                                    composer.take();
                                }
                            }
                        }
                    }
                }

                ColumnLayout {
                    id: chatColumn

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
                            // One required property per ListModel role. qmllint
                            // cannot introspect a dynamically-filled ListModel,
                            // so it reports these as unbound — see dev/README.md
                            // for the expected-warning list.
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
                        Column {
                            id: welcome

                            anchors.horizontalCenter: parent.horizontalCenter
                            y: Math.max(0, (transcriptView.height - height) / 2)
                            visible: transcriptView.count === 0
                            // A greeting is a short paragraph, so the card is
                            // as wide as one reads well — measured in columns
                            // now that every glyph is one column wide. A narrow
                            // HUD gives it the whole column rather than a
                            // fraction of one: there is no room to spare at 30
                            // columns, and the fraction was what pushed the
                            // wrap to every third word.
                            width: Math.min(transcriptView.width - Theme.pad * 2,
                                Theme.ch(46) + Theme.pad * 2)
                            spacing: Theme.pad

                            // Materialize: fade up while swelling past 1 and
                            // settling back. Reduced motion gets the end state.
                            opacity: Theme.reducedMotion ? 1 : 0
                            scale: 1
                            onVisibleChanged: if (welcome.visible && !Theme.reducedMotion) welcomeMaterialize.restart()
                            Component.onCompleted: if (welcome.visible && !Theme.reducedMotion) welcomeMaterialize.start()

                            SequentialAnimation {
                                id: welcomeMaterialize
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
                                font.pixelSize: Theme.fontSizeDisplay
                                font.weight: Font.Medium
                            }

                            // The invitation. Amber film, so the ghost's own
                            // colour asks the question.
                            //
                            // Instant-then-upgrade: the static line paints the
                            // moment the card appears, and the ghost's own
                            // greeting — fetched in the background, often a
                            // second or two behind — crossfades in over it if
                            // it arrives at all. No spinner, because there is
                            // nothing to wait for: the card is already usable.
                            Rectangle {
                                anchors.horizontalCenter: parent.horizontalCenter
                                visible: Ghostd.reachable
                                width: parent.width
                                // A greeting is two or three sentences, so this
                                // follows the *wrapped* height of a Text with a
                                // fixed width, and glides rather than snapping.
                                height: invitation.implicitHeight + Theme.pad * 2
                                radius: Theme.radiusLarge
                                color: Theme.amber(0.06)
                                border.width: 1
                                border.color: Theme.amber(0.15)

                                Behavior on height {
                                    enabled: !Theme.reducedMotion
                                    NumberAnimation {
                                        duration: Theme.durMed
                                        easing.type: Easing.OutCubic
                                    }
                                }

                                Text {
                                    id: invitation

                                    readonly property string line: Ghostd.greeting !== ""
                                        ? Ghostd.greeting : "What's on your mind?"

                                    anchors.centerIn: parent
                                    width: parent.width - Theme.pad * 2
                                    // The card is centred; its sentences are
                                    // not. A centred rag is the one thing a
                                    // fixed-width face renders worse than a
                                    // proportional one, because every line
                                    // break lands on a column boundary.
                                    horizontalAlignment: Text.AlignLeft
                                    // Deliberately unbound: the crossfade swaps
                                    // the words at the bottom of the opacity dip
                                    // so neither line is ever half-visible.
                                    text: "What's on your mind?"
                                    color: Theme.foreground
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSize
                                    wrapMode: Text.Wrap

                                    onLineChanged: {
                                        // Reduced motion, or a card nobody is
                                        // looking at, takes the end state.
                                        if (Theme.reducedMotion || !invitation.visible) {
                                            crossfade.stop();
                                            invitation.opacity = 1;
                                            invitation.text = invitation.line;
                                        } else {
                                            crossfade.restart();
                                        }
                                    }
                                    // A greeting that landed before this card
                                    // existed changed nothing to listen for.
                                    Component.onCompleted: invitation.text = invitation.line

                                    SequentialAnimation {
                                        id: crossfade
                                        NumberAnimation {
                                            target: invitation; property: "opacity"
                                            to: 0
                                            duration: Theme.durMed / 2
                                            easing.type: Easing.InCubic
                                        }
                                        ScriptAction {
                                            script: invitation.text = invitation.line
                                        }
                                        NumberAnimation {
                                            target: invitation; property: "opacity"
                                            to: 1
                                            duration: Theme.durMed / 2
                                            easing.type: Easing.OutCubic
                                        }
                                    }
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

                    // A newer release, as the daemon last saw it. One line, the
                    // command it takes, and a click that copies it.
                    Rectangle {
                        Layout.fillWidth: true
                        visible: Ghostd.reachable && Ghostd.updateAvailable !== null
                        implicitHeight: visible ? updateLine.implicitHeight + Theme.pad * 2 : 0
                        radius: Theme.radiusLarge
                        color: Theme.amber(0.08)
                        border.width: 1
                        border.color: Theme.amber(0.20)

                        Text {
                            id: updateLine
                            objectName: "updateLine"
                            anchors.centerIn: parent
                            width: parent.width - Theme.pad * 2
                            horizontalAlignment: Text.AlignHCenter
                            text: Ghostd.updateAvailable
                                ? "Ghost " + Ghostd.updateAvailable.latest + " is available · "
                                    + Ghostd.updateAvailable.command
                                : ""
                            color: Theme.foreground
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            wrapMode: Text.Wrap
                        }

                        MouseArea {
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: if (Ghostd.updateAvailable)
                                Quickshell.clipboardText = Ghostd.updateAvailable.command
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

                        // The ask form takes the keyboard while a question is
                        // standing, so answering or dismissing one has to hand
                        // it back — otherwise the composer returns with nothing
                        // focused and the next thing typed goes nowhere. Gated
                        // on the HUD being up, since Quickshell's FloatingWindow
                        // exposes no focus state and grabbing the caret for a
                        // window nobody is looking at is worse than not.
                        Connections {
                            target: Ghostd
                            function onPendingAskChanged(): void {
                                if (Ghostd.pendingAsk === null && hud.shown) composer.take();
                            }
                        }
                    }
                }

                // The workbench: a file the ghost wrote, opened from its tool
                // card. Nothing is instantiated while it is closed, and while
                // it is open it either takes the larger half of the body or,
                // on a narrow window, the whole of it.
                Loader {
                    id: workbenchPane

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

            // Character replaces chat rather than nesting its roster/conversation
            // sidebar inside its own surface.
            // The persona edits through the daemon's validating writer rather
            // than the workbench's direct file editor (which remains for
            // ordinary files): the daemon owns the size cap, so a bad edit is
            // refused at Save instead of breaking the next cold start.
            CharacterPane {
                id: characterPane
                visible: hud.currentSection === "character"
                    && !hud.loginOpen
                Layout.fillWidth: true
                Layout.fillHeight: true
                onClosed: hud.showSection("chat")
            }

            // The effective command palette is conversation-scoped. A pick
            // returns to chat with the command staged, never already running.
            CommandsBrowser {
                id: commandsBrowser
                visible: hud.currentSection === "commands"
                    && !hud.loginOpen
                Layout.fillWidth: true
                Layout.fillHeight: true
                onCommandPicked: invocation => {
                    hud.currentSection = "chat";
                    composer.stageCommand(invocation);
                }
            }

            // Machine-level hook configuration is global: built-in hooks are
            // shown, the owner's command hooks are edited in place. It never
            // creates or selects a conversation merely to show status.
            HooksBrowser {
                id: hooksBrowser
                visible: hud.currentSection === "hooks"
                    && !hud.loginOpen
                Layout.fillWidth: true
                Layout.fillHeight: true
            }

            McpBrowser {
                id: mcpBrowser
                visible: hud.currentSection === "mcp"
                    && !hud.loginOpen
                Layout.fillWidth: true
                Layout.fillHeight: true
            }

            RemoteAccess {
                id: remoteAccess
                visible: hud.currentSection === "remote"
                    && !hud.loginOpen
                Layout.fillWidth: true
                Layout.fillHeight: true
                onCloseRequested: hud.showSection("chat")
            }

            Board {
                id: boardPane
                visible: hud.currentSection === "board"
                    && !hud.loginOpen
                Layout.fillWidth: true
                Layout.fillHeight: true
                onCloseRequested: hud.showSection("chat")
            }


            // "Connect a model": swaps in over the transcript body.
            ModelLogin {
                id: modelLogin
                visible: hud.loginOpen
                Layout.fillWidth: true
                Layout.fillHeight: true
                onCloseRequested: hud.loginOpen = false
            }
        }

        // summon-ghost's final desktop navigation: a permanent 64px rail at
        // the far right, reserving its width instead of covering the content.
        GhostNavigation {
            anchors.top: parent.top
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            width: hud.navigationWidth
            currentSection: hud.currentSection
            activeHookCount: Ghostd.activeHookCount
            onSelected: section => hud.showSection(section)
        }

        // Sits over the whole card, above the layout, so the scrim dims the
        // sidebar and transcript alike.
        ConfirmDialog {
            id: deleteDialog

            anchors.fill: parent
            open: hud.pendingDeleteSessionId !== ""
            title: "Move conversation to Trash?"
            body: "“" + hud.pendingDeleteTitle + "” and its transcript will be "
                + "moved to the trash. This cannot be undone from the HUD."
            confirmText: "Move to Trash"
            busy: Ghostd.deletingSessionId === hud.pendingDeleteSessionId
                && hud.pendingDeleteSessionId !== ""
            error: hud.pendingDeleteSessionId !== "" ? Ghostd.sessionsError : ""
            onConfirmed: Ghostd.deleteConversation(hud.pendingDeleteSessionId)
            onDismissed: hud.dismissDelete()
        }

        // A browser extension asking to pair shows a six-digit code in its
        // popup. The same code here is the whole check: Allow only on a match.
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
            id: branchDialog

            anchors.fill: parent
            open: hud.pendingBranchEntryId !== ""
            title: "Replace what you're typing?"
            body: "Branching opens a copy of this conversation and puts that "
                + "message's text in the composer. What you have typed there "
                + "now is not saved anywhere."
            confirmText: "Replace"
            destructive: false
            onConfirmed: {
                const entryId = hud.pendingBranchEntryId;
                hud.pendingBranchEntryId = "";
                Ghostd.branchFrom(entryId);
            }
            onDismissed: hud.dismissBranch()
        }

        // Banishing a ghost is the same question one notch louder: the daemon
        // wants the name echoed back byte for byte, so the dialog collects it.
        ConfirmDialog {
            id: banishDialog

            anchors.fill: parent
            open: hud.pendingDeleteGhost !== ""
            title: "Banish " + hud.pendingDeleteGhost + "?"
            body: "Its persona, memories, credentials, and conversations move to Trash. "
                + "The owner's own documents stay on this machine. Type “"
                + hud.pendingDeleteGhost + "” to confirm."
            challenge: hud.pendingDeleteGhost
            confirmText: "Banish"
            busy: Ghostd.deletingGhost === hud.pendingDeleteGhost
                && hud.pendingDeleteGhost !== ""
            error: hud.pendingDeleteGhost !== "" ? Ghostd.ghostDeleteError : ""
            onConfirmed: Ghostd.deleteGhost(hud.pendingDeleteGhost)
            onDismissed: hud.dismissBanish()
        }

        // The delete answered: close on success, stay up with the daemon's
        // reason on failure (a conversation still streaming, an unreachable
        // daemon) so the dialog never dismisses into a no-op.
        Connections {
            target: Ghostd
            function onDeletingSessionIdChanged(): void {
                if (hud.pendingDeleteSessionId === "") return;
                if (Ghostd.deletingSessionId !== "") return;
                if (Ghostd.sessionsError === "") hud.dismissDelete();
            }

            function onDeletingGhostChanged(): void {
                if (hud.pendingDeleteGhost === "") return;
                if (Ghostd.deletingGhost !== "") return;
                if (Ghostd.ghostDeleteError === "") hud.dismissBanish();
            }

            // A name that left the listing (banished here, or from another
            // shell) has nothing left to confirm.
            function onGhostsChanged(): void {
                if (hud.pendingDeleteGhost === "" || Ghostd.deletingGhost !== "") return;
                const alive = Ghostd.ghosts.some(function (ghost) {
                    return ghost.name === hud.pendingDeleteGhost;
                });
                if (!alive) hud.dismissBanish();
            }
        }

        Connections {
            target: Ghostd
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
