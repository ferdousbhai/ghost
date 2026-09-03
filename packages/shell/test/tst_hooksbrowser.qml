import QtQuick
import QtTest
import qs.services
import "../qml/components" as Components

TestCase {
    id: tc
    name: "HooksBrowser"
    when: windowShown
    width: 640
    height: 480
    visible: true

    readonly property string hostileName:
        "![remote](https://resource.invalid/name.png) <img src=\"file:///etc/passwd\">"
    readonly property string hostileDescription:
        "<img src=\"https://resource.invalid/description.png\"> [local](file:///etc/shadow)"

    Component {
        id: browserComponent
        Components.HooksBrowser {
            width: 640
            height: 480
            visible: true
        }
    }

    Component {
        id: navigationComponent
        Components.GhostNavigation {
            width: 72
            height: 520
            activeHookCount: 7
        }
    }

    property var requests: []

    function fakeRequest(): var {
        const xhr = {
            readyState: 0,
            status: 0,
            responseText: "",
            method: "",
            url: "",
            body: null,
            headers: ({}),
            onreadystatechange: null,
            open: function (method, url) {
                this.method = method;
                this.url = url;
                this.readyState = 1;
            },
            setRequestHeader: function (name, value) { this.headers[name] = value; },
            send: function (body) { this.body = body; },
            abort: function () {
                this.readyState = 4;
                this.status = 0;
                if (this.onreadystatechange) this.onreadystatechange();
            },
            complete: function (status, body) {
                this.status = status;
                this.responseText = typeof body === "string" ? body : JSON.stringify(body);
                this.readyState = 4;
                if (this.onreadystatechange) this.onreadystatechange();
            }
        };
        tc.requests.push(xhr);
        return xhr;
    }

    function configDocument(): var {
        return {
            hooks: {
                session_stop: [{ hooks: [{ type: "command", command: "/bin/review", name: "Review", timeout: 5 }] }]
            }
        };
    }

    function init(): void {
        Ghostd.retireHooksRequest();
        tc.requests = [];
        Ghostd.hooksRequestFactory = function () { return tc.fakeRequest(); };
        Ghostd.hookConfig = null;
        Ghostd.hookConfigPath = "";
        Ghostd.hookConfigLoaded = true;
        Ghostd.hookConfigError = "";
        Ghostd.activeHooks = [{
            event: "conversation_idle",
            source: "builtin",
            name: hostileName,
            description: hostileDescription,
            idleSeconds: 60
        }];
        Ghostd.hookEvents = [{ event: "conversation_idle", count: 1 }];
        Ghostd.activeHookCount = 1;
        Ghostd.hooksLoaded = true;
        Ghostd.hooksLoading = false;
        Ghostd.hooksStale = false;
        Ghostd.hooksError = "";
    }

    function cleanup(): void {
        Ghostd.retireHooksRequest();
        Ghostd.hooksRequestFactory = null;
        Ghostd.hookConfig = null;
        Ghostd.hookConfigLoaded = false;
        Ghostd.hookConfigError = "";
        Ghostd.activeHooks = [];
        Ghostd.hookEvents = [];
        Ghostd.activeHookCount = 0;
        Ghostd.hooksLoaded = false;
        Ghostd.hooksStale = false;
        Ghostd.hooksError = "";
    }

    function test_daemonLabelsRemainLiteralPlainText(): void {
        const browser = createTemporaryObject(browserComponent, tc);
        verify(browser !== null);
        tryVerify(function () { return findChild(browser, "hookName") !== null; });
        const name = findChild(browser, "hookName");
        const description = findChild(browser, "hookDescription");
        const trigger = findChild(browser, "hookTrigger");
        verify(name !== null);
        verify(description !== null);
        verify(trigger !== null);
        compare(name.textFormat, Text.PlainText);
        compare(description.textFormat, Text.PlainText);
        compare(trigger.textFormat, Text.PlainText);
        compare(name.text, hostileName);
        compare(description.text, hostileDescription);

        Ghostd.hooksError = "<img src=\"https://resource.invalid/error.png\"> literal error";
        const error = findChild(browser, "hooksErrorText");
        verify(error !== null);
        compare(error.textFormat, Text.PlainText);
        compare(error.text, Ghostd.hooksError);
    }

    function editableBrowser(): var {
        Ghostd.activeHooks = [
            { event: "session_stop", source: "config", name: "Review", description: "Reviews the pass." },
            { event: "conversation_idle", source: "builtin", name: "Memory upkeep",
              description: "Upkeep.", idleSeconds: 60, settingsKey: "memory_upkeep" }
        ];
        Ghostd.hookEvents = [{ event: "session_stop", count: 1 }, { event: "conversation_idle", count: 1 }];
        Ghostd.activeHookCount = 2;
        Ghostd.hookConfig = configDocument();
        Ghostd.hookConfigPath = "/owner/.config/ghost/hooks.json";
        const browser = createTemporaryObject(browserComponent, tc);
        verify(browser !== null);
        tryVerify(function () { return findChild(browser, "hookCommand") !== null; });
        return browser;
    }

    function test_commandHookIsEditedInPlaceAndTheFileIsReplacedWhole(): void {
        const browser = editableBrowser();
        const card = findChild(browser, "hookCard");
        compare(findChild(card, "hookName").text, "Review");
        compare(findChild(card, "hookCommand").text, "/bin/review");
        compare(findChild(card, "hookSource").text, "hooks.json");
        verify(findChild(browser, "hookField-command") === null);

        mouseClick(card);
        tryVerify(function () { return findChild(browser, "hookField-command") !== null; });
        compare(browser.editingKey, "config:session_stop:0:0");
        compare(findChild(browser, "hookField-command").text, "/bin/review");
        compare(findChild(browser, "hookField-timeout").text, "5");
        verify(!findChild(browser, "hookField-idleSeconds").visible);

        findChild(browser, "hookField-command").text = "/bin/review --strict";
        findChild(browser, "hookField-name").text = "";
        mouseClick(findChild(browser, "hookSaveButton"));
        verify(!browser.editing);
        compare(tc.requests.length, 1);
        compare(tc.requests[0].method, "PUT");
        verify(tc.requests[0].url.endsWith("/api/hooks/config"));
        compare(JSON.parse(tc.requests[0].body), {
            hooks: { session_stop: [{ hooks: [{ type: "command", command: "/bin/review --strict", timeout: 5 }] }] }
        });

        // A refused write reopens the card with what was typed, under the reason.
        tc.requests[0].complete(400, {
            error: { code: "invalid_request", message: "hooks.json: hooks.session_stop[0].hooks[0].timeout must be a number in (0, 600]." }
        });
        tryVerify(function () { return findChild(browser, "hookField-command") !== null; });
        compare(findChild(browser, "hookField-command").text, "/bin/review --strict");
        compare(findChild(browser, "hooksErrorText").text,
            "hooks.json: hooks.session_stop[0].hooks[0].timeout must be a number in (0, 600].");
        mouseClick(findChild(browser, "hookCancelButton"));
        verify(!browser.editing);
        compare(tc.requests.length, 1);
    }

    function test_newHookIsAppendedAndRemovalPrunesTheEvent(): void {
        const browser = editableBrowser();
        mouseClick(findChild(browser, "hooksNewButton"));
        tryVerify(function () { return findChild(browser, "hookEventChoice") !== null; });
        verify(browser.drafting);
        // Save is inert until there is a command.
        mouseClick(findChild(browser, "hookSaveButton"));
        verify(browser.drafting);
        browser.draftEvent = "conversation_idle";
        tryVerify(function () { return findChild(browser, "hookField-idleSeconds").visible; });
        findChild(browser, "hookField-command").text = "/bin/idle";
        findChild(browser, "hookField-idleSeconds").text = "300";
        mouseClick(findChild(browser, "hookSaveButton"));
        compare(tc.requests.length, 1);
        compare(JSON.parse(tc.requests[0].body).hooks.conversation_idle,
            [{ hooks: [{ type: "command", command: "/bin/idle", idleSeconds: 300 }] }]);
        tc.requests[0].complete(200, {
            path: "/owner/.config/ghost/hooks.json",
            document: JSON.parse(tc.requests[0].body)
        });
        // An admitted write re-reads the status.
        compare(tc.requests.length, 2);
        compare(tc.requests[1].method, "GET");
        verify(tc.requests[1].url.endsWith("/api/hooks"));
        compare(Ghostd.hookConfig.hooks.conversation_idle[0].hooks[0].command, "/bin/idle");

        mouseClick(findChild(browser, "hookDeleteButton"));
        compare(tc.requests.length, 3);
        compare(JSON.parse(tc.requests[2].body), {
            hooks: { conversation_idle: [{ hooks: [{ type: "command", command: "/bin/idle", idleSeconds: 300 }] }] }
        });
    }

    function hookCards(browser: var): var {
        const cards = [];
        function collect(item) {
            if (item.objectName === "hookCard") cards.push(item);
            for (let i = 0; i < item.children.length; i += 1) collect(item.children[i]);
        }
        collect(browser);
        return cards;
    }

    function test_builtinHookWithoutTuningIsReadOnly(): void {
        Ghostd.activeHooks = [
            { event: "session_stop", source: "config", name: "Review", description: "Reviews the pass." },
            { event: "conversation_idle", source: "builtin", name: "Memory upkeep",
              description: "Upkeep.", idleSeconds: 60 }
        ];
        Ghostd.hookEvents = [{ event: "session_stop", count: 1 }, { event: "conversation_idle", count: 1 }];
        Ghostd.activeHookCount = 2;
        Ghostd.hookConfig = configDocument();
        Ghostd.hookConfigPath = "/owner/.config/ghost/hooks.json";
        const browser = createTemporaryObject(browserComponent, tc);
        tryVerify(function () { return findChild(browser, "hookCommand") !== null; });
        const cards = hookCards(browser);
        compare(cards.length, 2);
        compare(findChild(cards[1], "hookSource").text, "built in");
        verify(!findChild(cards[1], "hookDeleteButton").visible);
        mouseClick(cards[1]);
        verify(!browser.editing);
        compare(tc.requests.length, 0);
    }

    function test_reviewSettingsKeyDoesNotMakeTheBuiltinEditable(): void {
        Ghostd.activeHooks = [
            { event: "session_stop", source: "builtin", name: "Review",
              description: "Reviews the pass.", settingsKey: "review" }
        ];
        Ghostd.hookEvents = [{ event: "session_stop", count: 1 }];
        Ghostd.activeHookCount = 1;
        Ghostd.hookConfig = { hooks: {} };
        Ghostd.hookConfigPath = "/owner/.config/ghost/hooks.json";
        const browser = createTemporaryObject(browserComponent, tc);
        tryVerify(function () { return hookCards(browser).length === 1; });
        mouseClick(hookCards(browser)[0]);
        verify(!browser.editing);
        compare(tc.requests.length, 0);
    }

    function test_builtinIntervalIsSavedToTheFileAndPendingUntilRestart(): void {
        const browser = editableBrowser();
        const cards = hookCards(browser);
        compare(cards.length, 2);
        compare(findChild(cards[1], "hookTrigger").text, "After 1 minute of conversation inactivity");
        mouseClick(cards[1]);
        tryVerify(function () { return findChild(browser, "hookField-idleSeconds") !== null; });
        verify(!findChild(browser, "hookField-command").visible);
        verify(findChild(browser, "hookRestartNote").visible);
        findChild(browser, "hookField-idleSeconds").text = "900";
        mouseClick(findChild(browser, "hookSaveButton"));
        verify(!browser.editing);
        compare(tc.requests.length, 1);
        const sent = JSON.parse(tc.requests[0].body);
        compare(sent.builtin, { memory_upkeep: { idleSeconds: 900 } });
        compare(sent.hooks, configDocument().hooks);
        tc.requests[0].complete(200, { path: "/owner/.config/ghost/hooks.json", document: sent });
        tryVerify(function () {
            const trigger = findChild(hookCards(browser)[1], "hookTrigger");
            return trigger !== null && trigger.text.indexOf("15 minutes once ghostd restarts") > 0;
        });
    }

    function test_navigationContainsKeyboardActivatableHooksDestination(): void {
        const navigation = createTemporaryObject(navigationComponent, tc);
        verify(navigation !== null);
        const hookIndex = navigation.destinations.findIndex(function (destination) {
            return destination.id === "hooks";
        });
        verify(hookIndex > 0);
        verify(navigation.destinations[hookIndex].label.indexOf("7 loaded") >= 0);
        let selected = "";
        navigation.selected.connect(function (section) { selected = section; });
        navigation.activate(hookIndex);
        compare(selected, "hooks");
    }
}
