import QtQuick
import QtTest
import "../qml/services"
import "../qml/components" as Components
import "FakeXhr.js" as FakeXhr

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
        Ghostd.hooksRequestFactory = function () { return FakeXhr.make(tc.requests); };
        Ghostd.hookConfig = {
            hooks: {
                session_stop: [{ hooks: [{ type: "command", command: "/bin/hostile" }] }]
            }
        };
        Ghostd.hookConfigPath = "/owner/.config/ghost/hooks.json";
        Ghostd.hookConfigLoaded = true;
        Ghostd.hookConfigError = "";
        Ghostd.activeHooks = [{
            event: "session_stop",
            name: hostileName,
            description: hostileDescription
        }];
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
            { event: "session_stop", name: "Review", description: "Reviews the pass." }
        ];
        Ghostd.activeHookCount = 1;
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
        verify(findChild(browser, "hookField-command") === null);

        mouseClick(card);
        tryVerify(function () { return findChild(browser, "hookField-command") !== null; });
        compare(browser.editingKey, "config:session_stop:0:0");
        compare(findChild(browser, "hookField-command").text, "/bin/review");
        compare(findChild(browser, "hookField-timeout").text, "5");

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
        browser.draftEvent = "before_prompt";
        findChild(browser, "hookField-command").text = "/bin/context";
        mouseClick(findChild(browser, "hookSaveButton"));
        compare(tc.requests.length, 1);
        compare(JSON.parse(tc.requests[0].body).hooks.before_prompt,
            [{ hooks: [{ type: "command", command: "/bin/context" }] }]);
        tc.requests[0].complete(200, {
            path: "/owner/.config/ghost/hooks.json",
            document: JSON.parse(tc.requests[0].body)
        });
        // An admitted write re-reads the status.
        compare(tc.requests.length, 2);
        compare(tc.requests[1].method, "GET");
        verify(tc.requests[1].url.endsWith("/api/hooks"));
        compare(Ghostd.hookConfig.hooks.before_prompt[0].hooks[0].command, "/bin/context");

        // The first card's delete prunes its event, leaving the rest of the file.
        mouseClick(findChild(browser, "hookDeleteButton"));
        compare(tc.requests.length, 3);
        compare(JSON.parse(tc.requests[2].body), configDocument());
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
