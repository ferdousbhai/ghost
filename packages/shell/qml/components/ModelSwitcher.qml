pragma ComponentBehavior: Bound

// ModelSwitcher — pick which model the active ghost talks with, without a
// terminal. Two lists behind one panel:
//
//   • AVAILABLE (the default view): the short set the ghost can use right now,
//     from credentialed providers, grouped by provider, the current one marked.
//     Selecting one is a single PUT /model.
//   • CATALOG (as soon as you type in the search box): the full pi catalogue,
//     every provider whether logged in or not, queried server-side by `q` and
//     paged — the shell never downloads all ~1,270 models. A row whose provider
//     is not credentialed (`usable: false`) is still offered: clicking it writes
//     the role anyway (the daemon allows that) and Ghostd routes into the login
//     flow via modelSwitchNeedsLogin, after which the same model resolves.
//
// Every model decision is Ghostd's; this component renders its state and posts
// clicks back. "Connect another provider" bubbles up to open ModelLogin.
import QtQuick
import QtQuick.Layouts
import qs.services
import "ModelRouting.js" as Routing

Rectangle {
    id: root

    /** Return to the transcript. */
    signal closeRequested()
    /** Open the provider login (ModelLogin), keeping the switcher as the origin. */
    signal connectProviderRequested()

    /** Advanced OMP role/fallback overview, separate from the one-click chat picker. */
    property bool routingView: false
    property string routeRole: ""
    property string routeLabel: ""
    property string routeTarget: "primary"
    readonly property bool pickingRoute: routeRole !== ""
    readonly property var routingRows: Routing.rows(Ghostd.modelRouting)

    /** A catalog choice that cannot become effective until its provider login finishes. */
    property var pendingModel: null
    readonly property bool hasPendingModel: pendingModel !== null
    readonly property string pendingModelName: {
        if (!root.pendingModel) return "";
        return root.pendingModel.name || root.pendingModel.id;
    }

    /** True once the user has typed a search: show catalog instead of available. */
    readonly property bool searching: searchField.text.trim() !== ""

    // Available models, flattened into provider-header + model rows for a single
    // Repeater. The list arrives in ghostd's OMP-style semantic model order.
    readonly property var availableRows: {
        const rows = [];
        let lastProvider = "";
        const models = Ghostd.availableModels;
        for (let i = 0; i < models.length; i++) {
            const m = models[i];
            if (m.provider !== lastProvider) {
                rows.push({ header: true, provider: m.provider, model: null });
                lastProvider = m.provider;
            }
            rows.push({ header: false, provider: m.provider, model: m });
        }
        return rows;
    }

    radius: Theme.radius
    color: Theme.background

    /** Open the panel: fresh current model + available list; clear any old search. */
    function open(): void {
        searchField.text = "";
        root.routingView = false;
        root.routeRole = "";
        Ghostd.fetchCurrentModel();
        Ghostd.fetchAvailableModels();
        Ghostd.fetchModelRouting();
    }

    function routeModelName(model: var): string {
        return Routing.modelName(model);
    }

    function beginRoutePick(role: string, label: string, target: string): void {
        root.routeRole = role;
        root.routeLabel = label;
        root.routeTarget = target;
        root.routingView = false;
        searchField.text = "";
        Ghostd.fetchAvailableModels();
    }

    function rememberPendingModel(model: var): void {
        if (!model || !model.provider || !model.id) return;
        root.pendingModel = {
            provider: String(model.provider),
            id: String(model.id),
            name: model.name ? String(model.name) : ""
        };
    }

    /** Drop client intent and refresh the effective daemon-reported selection. */
    function clearPendingModel(): void {
        root.pendingModel = null;
        Ghostd.fetchCurrentModel();
        Ghostd.fetchAvailableModels();
    }

    function chooseModel(model: var): void {
        if (!model || !model.provider || !model.id) return;
        if (root.pickingRoute) {
            Ghostd.setModelRoute(root.routeRole, root.routeTarget, model.provider, model.id);
        } else {
            if (model.usable === false) root.rememberPendingModel(model);
            else root.pendingModel = null;
            Ghostd.setModel(model.provider, model.id);
        }
    }

    /** (Re)run the catalog search from the box, debounced. */
    function runSearch(): void {
        Ghostd.fetchCatalog(searchField.text.trim(), 0);
    }

    // Search deltas arrive per keystroke; only hit ghostd once typing settles.
    Timer {
        id: debounce
        interval: 300
        repeat: false
        onTriggered: root.runSearch()
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Theme.pad
        spacing: Theme.gap

        // ---- Header -------------------------------------------------------
        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.gap

            Text {
                text: root.routingView
                    ? "Model routing"
                    : (root.pickingRoute
                        ? (root.routeTarget === "fallback" ? "Add fallback" : "Choose primary")
                            + " · " + root.routeLabel
                        : "Choose a model")
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize + 1
                font.weight: Font.DemiBold
            }

            Text {
                text: Ghostd.activeGhost === "" ? "" : "· " + Ghostd.activeGhost
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }

            Item { Layout.fillWidth: true }

            Text {
                text: root.routingView ? "Models" : "Routing"
                color: Theme.foreground
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        root.routeRole = "";
                        root.routingView = !root.routingView;
                        searchField.text = "";
                        if (root.routingView) Ghostd.fetchModelRouting();
                    }
                }
            }

            Text {
                text: "Connect provider"
                color: Theme.accent
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.connectProviderRequested()
                }
            }

            Text {
                text: "Close"
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.closeRequested()
                }
            }
        }

        // ---- Search box ---------------------------------------------------
        Rectangle {
            visible: !root.routingView
            Layout.fillWidth: true
            implicitHeight: 40
            radius: Theme.radius / 2
            color: Theme.surface
            border.width: 1
            border.color: searchField.activeFocus ? Theme.accent : Theme.border

            TextInput {
                id: searchField
                anchors.fill: parent
                anchors.leftMargin: Theme.pad
                anchors.rightMargin: Theme.pad
                verticalAlignment: TextInput.AlignVCenter
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
                selectByMouse: true
                selectionColor: Theme.selection
                onTextChanged: {
                    if (searchField.text.trim() === "") debounce.stop();
                    else debounce.restart();
                }
                onAccepted: root.runSearch()

                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    visible: searchField.text === ""
                    text: "Search all models (e.g. \"sonnet\", \"gpt\", \"gemini\")…"
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                }
            }
        }

        // A one-line status: what the list below is showing.
        Text {
            visible: !root.routingView
            Layout.fillWidth: true
            text: {
                if (Ghostd.modelError !== "") return Ghostd.modelError;
                if (Ghostd.modelWarning !== "") return Ghostd.modelWarning;
                if (root.pickingRoute) {
                    return root.routeTarget === "fallback"
                        ? "Choose the next model OMP should try"
                        : "Choose the model for this role";
                }
                if (root.searching) {
                    if (Ghostd.catalogLoading) return "Searching…";
                    const shown = Ghostd.catalogModels.length;
                    return shown === 0
                        ? "No models match \"" + Ghostd.catalogQuery + "\""
                        : "Showing " + (Ghostd.catalogOffset + 1)
                            + "–" + (Ghostd.catalogOffset + shown)
                            + " of " + Ghostd.catalogTotal;
                }
                return Ghostd.availableModels.length === 0
                    ? "No usable models yet — connect a provider"
                    : Ghostd.availableModels.length + " model"
                        + (Ghostd.availableModels.length === 1 ? "" : "s") + " ready to use";
            }
            color: Ghostd.modelError !== ""
                ? Theme.danger
                : (Ghostd.modelWarning !== "" ? Theme.warn : Theme.foregroundDim)
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            elide: Text.ElideRight
        }

        // Client intent is deliberately separate from the effective selection:
        // no accent rail, no selection fill, and a dimmed login annotation.
        Rectangle {
            objectName: "pendingModelState"
            visible: root.hasPendingModel && !root.routingView
            Layout.fillWidth: true
            implicitHeight: 46
            radius: Theme.radius / 2
            color: "transparent"
            border.width: 1
            border.color: Theme.warn
            opacity: 0.58

            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: Theme.pad
                anchors.rightMargin: Theme.pad
                spacing: Theme.gap

                ColumnLayout {
                    spacing: 0
                    Layout.fillWidth: true

                    Text {
                        text: root.pendingModelName
                        color: Theme.foreground
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize
                        elide: Text.ElideRight
                        Layout.fillWidth: true
                    }

                    Text {
                        text: root.pendingModel
                            ? root.pendingModel.provider + "/" + root.pendingModel.id : ""
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        elide: Text.ElideRight
                        Layout.fillWidth: true
                    }
                }

                Text {
                    objectName: "pendingModelAnnotation"
                    text: "waiting for login"
                    color: Theme.warn
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                }
            }
        }

        // ---- OMP role + fallback routing ---------------------------------
        Flickable {
            visible: root.routingView
            Layout.fillWidth: true
            Layout.fillHeight: true
            contentWidth: width
            contentHeight: routingColumn.implicitHeight
            clip: true
            interactive: contentHeight > height

            Column {
                id: routingColumn
                width: parent.width
                spacing: Theme.gap

                Text {
                    width: parent.width
                    text: Ghostd.modelRoutingLoading
                        ? "Loading OMP routes…"
                        : "Auto follows OMP's role defaults. Set a primary only when you want to override it."
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }

                Repeater {
                    model: root.routingRows

                    Item {
                        id: routeEntry
                        required property var modelData
                        readonly property var route: routeEntry.modelData.route
                        readonly property var chain: routeEntry.route
                            && Array.isArray(routeEntry.route.fallbacks)
                            ? routeEntry.route.fallbacks : []

                        width: routingColumn.width
                        implicitHeight: routeEntry.modelData.header
                            ? 26 : routeCard.implicitHeight

                        Text {
                            visible: routeEntry.modelData.header
                            anchors.left: parent.left
                            anchors.bottom: parent.bottom
                            anchors.bottomMargin: 2
                            text: routeEntry.modelData.label || ""
                            color: Theme.foreground
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            font.weight: Font.DemiBold
                        }

                        Rectangle {
                            id: routeCard
                            visible: !routeEntry.modelData.header
                            width: parent.width
                            implicitHeight: routeContent.implicitHeight + Theme.pad * 2
                            radius: Theme.radius / 2
                            color: Theme.surface
                            border.width: 0
                            border.color: Theme.border

                            ColumnLayout {
                                id: routeContent
                                anchors.left: parent.left
                                anchors.right: parent.right
                                anchors.top: parent.top
                                anchors.margins: Theme.pad
                                spacing: 3

                                RowLayout {
                                    Layout.fillWidth: true
                                    Text {
                                        text: routeEntry.route
                                            ? (routeEntry.route.label || routeEntry.route.role) : ""
                                        color: Theme.foregroundBright
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSize
                                        font.weight: Font.DemiBold
                                    }
                                    Text {
                                        text: routeEntry.route ? "OMP @" + routeEntry.route.ompRole : ""
                                        color: Theme.foregroundDim
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSizeSmall - 1
                                    }
                                    Item { Layout.fillWidth: true }
                                    Text {
                                        text: routeEntry.route && routeEntry.route.source === "explicit"
                                            ? "Change" : "Set primary"
                                        color: Theme.accent
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSizeSmall
                                        MouseArea {
                                            anchors.fill: parent
                                            cursorShape: Qt.PointingHandCursor
                                            onClicked: {
                                                if (routeEntry.route) root.beginRoutePick(
                                                    routeEntry.route.role,
                                                    routeEntry.route.label,
                                                    "primary");
                                            }
                                        }
                                    }
                                    Text {
                                        visible: routeEntry.route
                                            && routeEntry.route.source === "explicit"
                                        text: "Use Auto"
                                        color: Theme.foregroundDim
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSizeSmall
                                        MouseArea {
                                            anchors.fill: parent
                                            cursorShape: Qt.PointingHandCursor
                                            onClicked: {
                                                if (routeEntry.route)
                                                    Ghostd.clearModelPrimary(routeEntry.route.role);
                                            }
                                        }
                                    }
                                    Text {
                                        text: "+ Fallback"
                                        color: Theme.accent
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSizeSmall
                                        MouseArea {
                                            anchors.fill: parent
                                            cursorShape: Qt.PointingHandCursor
                                            onClicked: {
                                                if (routeEntry.route) root.beginRoutePick(
                                                    routeEntry.route.role,
                                                    routeEntry.route.label,
                                                    "fallback");
                                            }
                                        }
                                    }
                                }

                                Text {
                                    Layout.fillWidth: true
                                    text: Routing.sourceLine(routeEntry.route)
                                    color: routeEntry.route && routeEntry.route.source === "explicit"
                                        ? Theme.foreground : Theme.foregroundDim
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    elide: Text.ElideRight
                                }

                                RowLayout {
                                    Layout.fillWidth: true
                                    Text {
                                        text: routeEntry.chain.length === 0
                                            ? "Fallbacks · none" : "Fallbacks · retry order"
                                        color: Theme.foregroundDim
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSizeSmall
                                    }
                                    Item { Layout.fillWidth: true }
                                    Text {
                                        visible: routeEntry.chain.length > 0
                                        text: "Clear chain"
                                        color: Theme.foregroundDim
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSizeSmall
                                        MouseArea {
                                            anchors.fill: parent
                                            cursorShape: Qt.PointingHandCursor
                                            onClicked: {
                                                if (routeEntry.route)
                                                    Ghostd.replaceModelFallbacks(routeEntry.route.role, []);
                                            }
                                        }
                                    }
                                }

                                Repeater {
                                    model: routeEntry.chain

                                    RowLayout {
                                        id: fallbackRow
                                        required property var modelData
                                        required property int index

                                        Layout.fillWidth: true
                                        spacing: Theme.gap

                                        Text {
                                            Layout.fillWidth: true
                                            text: (fallbackRow.index + 1) + "  "
                                                + root.routeModelName(fallbackRow.modelData)
                                            color: Theme.foreground
                                            font.family: Theme.fontFamily
                                            font.pixelSize: Theme.fontSizeSmall
                                            elide: Text.ElideRight
                                        }
                                        Text {
                                            visible: fallbackRow.index > 0
                                            text: "↑"
                                            color: Theme.accent
                                            font.family: Theme.fontFamily
                                            font.pixelSize: Theme.fontSizeSmall
                                            MouseArea {
                                                anchors.fill: parent
                                                cursorShape: Qt.PointingHandCursor
                                                onClicked: Ghostd.replaceModelFallbacks(
                                                    routeEntry.route.role,
                                                    Routing.moveFallback(
                                                        routeEntry.chain, fallbackRow.index, -1))
                                            }
                                        }
                                        Text {
                                            visible: fallbackRow.index + 1 < routeEntry.chain.length
                                            text: "↓"
                                            color: Theme.accent
                                            font.family: Theme.fontFamily
                                            font.pixelSize: Theme.fontSizeSmall
                                            MouseArea {
                                                anchors.fill: parent
                                                cursorShape: Qt.PointingHandCursor
                                                onClicked: Ghostd.replaceModelFallbacks(
                                                    routeEntry.route.role,
                                                    Routing.moveFallback(
                                                        routeEntry.chain, fallbackRow.index, 1))
                                            }
                                        }
                                        Text {
                                            text: "Remove"
                                            color: Theme.foregroundDim
                                            font.family: Theme.fontFamily
                                            font.pixelSize: Theme.fontSizeSmall
                                            MouseArea {
                                                anchors.fill: parent
                                                cursorShape: Qt.PointingHandCursor
                                                onClicked: Ghostd.replaceModelFallbacks(
                                                    routeEntry.route.role,
                                                    Routing.removeFallback(
                                                        routeEntry.chain, fallbackRow.index))
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // ---- Available list (default view) --------------------------------
        Flickable {
            visible: !root.routingView && !root.searching
            Layout.fillWidth: true
            Layout.fillHeight: true
            contentWidth: width
            contentHeight: availableColumn.implicitHeight
            clip: true
            interactive: contentHeight > height

            Column {
                id: availableColumn
                width: parent.width
                spacing: Theme.gap / 2

                // Empty-state call to action.
                Rectangle {
                    visible: Ghostd.availableModels.length === 0
                    width: parent.width
                    implicitHeight: 40
                    radius: Theme.radius / 2
                    color: connectArea.containsMouse ? Theme.hover : Theme.surface
                    border.width: 1
                    border.color: Theme.border
                    Text {
                        anchors.centerIn: parent
                        text: "Connect a provider to get a model"
                        color: Theme.accent
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                    }
                    MouseArea {
                        id: connectArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.connectProviderRequested()
                    }
                }

                Repeater {
                    model: root.availableRows

                    Item {
                        id: availRow
                        required property var modelData

                        width: availableColumn.width
                        implicitHeight: availRow.modelData.header ? 24 : 46

                        // Provider group header.
                        Text {
                            visible: availRow.modelData.header
                            anchors.left: parent.left
                            anchors.bottom: parent.bottom
                            anchors.bottomMargin: 2
                            text: availRow.modelData.provider || ""
                            color: Theme.foreground
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            font.weight: Font.DemiBold
                        }

                        // A usable model row.
                        Rectangle {
                            id: usableRow
                            visible: !availRow.modelData.header
                            anchors.fill: parent
                            radius: Theme.radius / 2
                            readonly property bool isCurrent: availRow.modelData.model
                                && availRow.modelData.model.current === true
                            color: isCurrent ? Theme.selection
                                : (modelArea.containsMouse ? Theme.hover : "transparent")
                            border.width: 0
                            border.color: Theme.border

                            RowLayout {
                                anchors.fill: parent
                                anchors.leftMargin: Theme.pad
                                anchors.rightMargin: Theme.pad
                                spacing: Theme.gap

                                Rectangle {
                                    Layout.alignment: Qt.AlignVCenter
                                    visible: usableRow.isCurrent
                                    implicitWidth: 2
                                    implicitHeight: 22
                                    radius: 1
                                    color: Theme.accent
                                }

                                ColumnLayout {
                                    spacing: 0
                                    Layout.fillWidth: true

                                    Text {
                                        text: availRow.modelData.model
                                            ? (availRow.modelData.model.name || availRow.modelData.model.id)
                                            : ""
                                        color: Theme.foregroundBright
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSize
                                        elide: Text.ElideRight
                                        Layout.fillWidth: true
                                    }

                                    Text {
                                        readonly property var m: availRow.modelData.model
                                        visible: text !== ""
                                        text: {
                                            const parts = [];
                                            if (m && m.name && m.id && m.name !== m.id) parts.push(m.id);
                                            if (m && m.connectedVia) parts.push("via " + m.connectedVia);
                                            return parts.join("  ·  ");
                                        }
                                        color: Theme.foregroundDim
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSizeSmall
                                        elide: Text.ElideRight
                                        Layout.fillWidth: true
                                    }
                                }

                                // Vision badge.
                                Rectangle {
                                    visible: availRow.modelData.model
                                        && availRow.modelData.model.hasVision === true
                                    implicitWidth: visionLabel.implicitWidth + Theme.gap
                                    implicitHeight: 18
                                    radius: Theme.radius / 3
                                    color: "transparent"
                                    border.width: 1
                                    border.color: Theme.border
                                    Text {
                                        id: visionLabel
                                        anchors.centerIn: parent
                                        text: "Vision"
                                        color: Theme.foregroundDim
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSizeSmall - 1
                                    }
                                }

                                Text {
                                    visible: usableRow.isCurrent
                                    text: "Current"
                                    color: Theme.accent
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                }
                            }

                            MouseArea {
                                id: modelArea
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: {
                                    if (availRow.modelData.model)
                                        root.chooseModel(availRow.modelData.model);
                                }
                            }
                        }
                    }
                }
            }
        }

        // ---- Catalog list (while searching) -------------------------------
        Flickable {
            visible: !root.routingView && root.searching
            Layout.fillWidth: true
            Layout.fillHeight: true
            contentWidth: width
            contentHeight: catalogColumn.implicitHeight
            clip: true
            interactive: contentHeight > height

            Column {
                id: catalogColumn
                width: parent.width
                spacing: Theme.gap / 2

                Repeater {
                    model: Ghostd.catalogModels

                    Rectangle {
                        id: catRow
                        required property var modelData

                        readonly property bool usable: catRow.modelData.usable === true

                        width: catalogColumn.width
                        implicitHeight: 48
                        radius: Theme.radius / 2
                        color: catRow.modelData.current === true ? Theme.selection
                            : (catArea.containsMouse ? Theme.hover : "transparent")
                        border.width: 0
                        border.color: Theme.border

                        RowLayout {
                            anchors.fill: parent
                            anchors.leftMargin: Theme.pad
                            anchors.rightMargin: Theme.pad
                            spacing: Theme.gap

                            ColumnLayout {
                                spacing: 0
                                Layout.fillWidth: true

                                Text {
                                    text: catRow.modelData.name || catRow.modelData.id
                                    color: Theme.foregroundBright
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSize
                                    elide: Text.ElideRight
                                    Layout.fillWidth: true
                                }

                                Text {
                                    text: (catRow.modelData.provider || "")
                                        + (catRow.modelData.name && catRow.modelData.id
                                            && catRow.modelData.name !== catRow.modelData.id
                                            ? "  ·  " + catRow.modelData.id : "")
                                    color: Theme.foregroundDim
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    elide: Text.ElideRight
                                    Layout.fillWidth: true
                                }
                            }

                            // Vision badge.
                            Rectangle {
                                visible: catRow.modelData.hasVision === true
                                implicitWidth: catVisionLabel.implicitWidth + Theme.gap
                                implicitHeight: 18
                                radius: Theme.radius / 3
                                color: "transparent"
                                border.width: 1
                                border.color: Theme.border
                                Text {
                                    id: catVisionLabel
                                    anchors.centerIn: parent
                                    text: "Vision"
                                    color: Theme.foregroundDim
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall - 1
                                }
                            }

                            // Credential state: usable, an in-app provider
                            // login, or Claude Code's external desktop login.
                            Text {
                                text: catRow.usable
                                    ? "Use"
                                    : (catRow.modelData.provider === "claude-code"
                                        ? "Run claude auth login"
                                        : "Log in →")
                                color: catRow.usable ? Theme.accent : Theme.warn
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                            }
                        }

                        MouseArea {
                            id: catArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            // Both paths PUT the role. Ghostd opens in-app login
                            // for providers and leaves Claude's external command
                            // as an inline setup warning.
                            onClicked: root.chooseModel(catRow.modelData)
                        }
                    }
                }

                // Paging when the filtered set is larger than one page.
                RowLayout {
                    visible: Ghostd.catalogTotal > Ghostd.catalogLimit
                    width: parent.width
                    spacing: Theme.gap

                    Rectangle {
                        id: prevButton
                        implicitWidth: prevLabel.implicitWidth + Theme.pad
                        implicitHeight: 28
                        radius: Theme.radius / 2
                        readonly property bool canPage: Ghostd.catalogOffset > 0
                        opacity: canPage ? 1 : 0.4
                        color: prevArea.containsMouse && canPage ? Theme.selection : "transparent"
                        border.width: 1
                        border.color: Theme.border
                        Text {
                            id: prevLabel
                            anchors.centerIn: parent
                            text: "‹ Previous"
                            color: Theme.foreground
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                        }
                        MouseArea {
                            id: prevArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: prevButton.canPage ? Qt.PointingHandCursor : Qt.ArrowCursor
                            onClicked: {
                                if (prevButton.canPage)
                                    Ghostd.fetchCatalog(Ghostd.catalogQuery,
                                        Math.max(0, Ghostd.catalogOffset - Ghostd.catalogLimit));
                            }
                        }
                    }

                    Item { Layout.fillWidth: true }

                    Rectangle {
                        id: nextButton
                        implicitWidth: nextLabel.implicitWidth + Theme.pad
                        implicitHeight: 28
                        radius: Theme.radius / 2
                        readonly property bool canPage:
                            Ghostd.catalogOffset + Ghostd.catalogModels.length < Ghostd.catalogTotal
                        opacity: canPage ? 1 : 0.4
                        color: nextArea.containsMouse && canPage ? Theme.selection : "transparent"
                        border.width: 1
                        border.color: Theme.border
                        Text {
                            id: nextLabel
                            anchors.centerIn: parent
                            text: "Next ›"
                            color: Theme.foreground
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                        }
                        MouseArea {
                            id: nextArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: nextButton.canPage ? Qt.PointingHandCursor : Qt.ArrowCursor
                            onClicked: {
                                if (nextButton.canPage)
                                    Ghostd.fetchCatalog(Ghostd.catalogQuery,
                                        Ghostd.catalogOffset + Ghostd.catalogLimit);
                            }
                        }
                    }
                }
            }
        }
    }

    Connections {
        target: Ghostd
        function onModelRouteCompleted(role: string, target: string): void {
            root.routeRole = "";
            root.routingView = true;
            searchField.text = "";
        }
    }
}
