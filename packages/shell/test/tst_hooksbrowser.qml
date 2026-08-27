import QtQuick
import QtTest
import qs.services
import "../qml/components" as Components

TestCase {
    id: tc
    name: "HooksBrowser"

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

    function init(): void {
        Ghostd.retireHooksRequest();
        Ghostd.activeHooks = [{
            event: "conversation_idle",
            name: hostileName,
            description: hostileDescription,
            idleSeconds: 60
        }];
        Ghostd.hookEvents = [{ event: "conversation_idle", count: 1 }];
        Ghostd.activeHookCount = 1;
        Ghostd.hookContinuationCap = 2;
        Ghostd.hooksLoaded = true;
        Ghostd.hooksLoading = false;
        Ghostd.hooksStale = false;
        Ghostd.hooksError = "";
    }

    function cleanup(): void {
        Ghostd.retireHooksRequest();
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
