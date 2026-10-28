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
            height: 560
            visible: true
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
        Ghostd.retire(Ghostd, "hookConfigRequest");
        tc.requests = [];
        Ghostd.requestFactory = FakeXhr.factory(tc.requests, /\/api\/hooks/);
        Ghostd.hookConfig = {
            hooks: {
                session_stop: [{ hooks: [{
                    type: "command", command: "/bin/hostile", name: hostileName, description: hostileDescription
                }] }]
            }
        };
        Ghostd.hookConfigPath = "/owner/.config/ghost/hooks.json";
        Ghostd.hookConfigLoaded = true;
        Ghostd.hookConfigError = "";
    }

    function cleanup(): void {
        Ghostd.retire(Ghostd, "hookConfigRequest");
        Ghostd.retire(Ghostd, "hookConfigMutation");
        Ghostd.requestFactory = null;
        Ghostd.hookConfig = null;
        Ghostd.hookConfigLoaded = false;
        Ghostd.hookConfigError = "";
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

        Ghostd.hookConfigError = "<img src=\"https://resource.invalid/error.png\"> literal error";
        const error = findChild(browser, "hooksErrorText");
        verify(error !== null);
        compare(error.textFormat, Text.PlainText);
        compare(error.text, Ghostd.hookConfigError);
    }

    function editableBrowser(): var {
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
        // The admitted document is the live hook set; nothing else is read.
        compare(tc.requests.length, 1);
        compare(Ghostd.hookConfig.hooks.before_prompt[0].hooks[0].command, "/bin/context");
        compare(Ghostd.activeHookCount, 2);

        // The first card's delete prunes its event, leaving the rest of the file.
        mouseClick(findChild(browser, "hookDeleteButton"));
        compare(tc.requests.length, 2);
        compare(JSON.parse(tc.requests[1].body), configDocument());
    }
}
