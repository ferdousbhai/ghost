import QtQuick
import QtTest
import "../qml"

TestCase {
    id: tc
    name: "TrayLifecycle"

    Component {
        id: bridgeComponent
        TrayBridge {
            startupTimeoutMs: 40
            restartBaseDelayMs: 20
            restartMaxDelayMs: 80
            stableRunWindowMs: 40
        }
    }

    function makeBridge(): var {
        const bridge = createTemporaryObject(bridgeComponent, tc, {
            hud: ({})
        });
        verify(bridge !== null);
        return bridge;
    }

    function test_unexpectedExitRestartsWithBoundedBackoff(): void {
        const bridge = makeBridge();
        const helper = findChild(bridge, "trayHelper");
        const restart = findChild(bridge, "trayRestartTimer");

        verify(helper.running);
        helper.simulateStarted();
        compare(bridge.helperState, "running");
        helper.simulateExited();
        compare(bridge.helperState, "restarting");
        compare(bridge.consecutiveFailures, 1);
        compare(restart.interval, 20);
        tryVerify(function () { return helper.running; });

        helper.simulateStarted();
        helper.simulateExited();
        compare(restart.interval, 40);
        tryVerify(function () { return helper.running; });

        helper.simulateStarted();
        helper.simulateExited();
        compare(restart.interval, 80);
        tryVerify(function () { return helper.running; });

        helper.simulateStarted();
        helper.simulateExited();
        compare(restart.interval, 80);
    }

    function test_stableRunResetsBackoff(): void {
        const bridge = makeBridge();
        const helper = findChild(bridge, "trayHelper");
        helper.simulateStarted();
        helper.simulateExited();
        tryVerify(function () { return helper.running; });
        helper.simulateStarted();
        tryCompare(bridge, "consecutiveFailures", 0);
    }

    function test_dependencyDiagnosticStopsRestarting(): void {
        const bridge = makeBridge();
        const helper = findChild(bridge, "trayHelper");
        helper.simulateStarted();
        helper.stderr.read("ghost-tray-error:" + JSON.stringify({
            kind: "dependency",
            message: "Install python-dbus, then restart the ghost shell."
        }));

        compare(bridge.helperState, "unavailable");
        compare(bridge.helperError,
            "Install python-dbus, then restart the ghost shell.");
        verify(!helper.running);
        helper.simulateExited();
        wait(100);
        verify(!helper.running);
        compare(bridge.helperState, "unavailable");
    }

    function test_failedStartBecomesActionable(): void {
        const bridge = makeBridge();
        const helper = findChild(bridge, "trayHelper");
        verify(helper.running);
        tryCompare(bridge, "helperState", "unavailable");
        verify(bridge.helperError.indexOf("pacman -S --needed python") >= 0);
        verify(!helper.running);
    }
}
