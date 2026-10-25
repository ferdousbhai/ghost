import QtQuick
import QtTest
import "../qml/services"
import "../qml/components" as Components
import "FakeXhr.js" as FakeXhr

TestCase {
    id: tc
    name: "Routines"
    when: windowShown
    visible: true
    width: 900
    height: 650
    property var requests: []
    Component {
        id: paneComponent
        Components.Routines { width: 900; height: 650; visible: true }
    }
    function init(): void {
        Ghostd.retireClientRequests();
        tc.requests = [];
        Ghostd.requestFactory = FakeXhr.factory(tc.requests, /\/routines/);
        Ghostd.activeGhost = "casper";
        Ghostd.routinesError = "";
        Ghostd.routineWriteError = "";
        Ghostd.routines = [];
        Ghostd.routineRecoveries = [];
    }
    function cleanup(): void {
        Ghostd.retireClientRequests();
        Ghostd.requestFactory = null;
    }
    function loadedPane(): var {
        const pane = createTemporaryObject(paneComponent, tc);
        verify(pane !== null);
        for (const xhr of tc.requests) {
            xhr.complete(200, { routines: [], recoveries: [] });
        }
        tc.requests.splice(0, tc.requests.length);
        return pane;
    }
    function test_failedSaveRetainsDraftAndRevisionUntilExplicitDiscard(): void {
        const pane = loadedPane();
        Ghostd.routineConfigReady("casper", "daily", { timer: "[Timer]\nOnCalendar=daily", service: "[Service]\nExecStart=/usr/bin/true", revision: "original" });
        const editor = findChild(pane, "routineEditor"), timer = findChild(pane, "routineTimerSource");
        tryCompare(editor, "visible", true);
        timer.text = "[Timer]\nOnCalendar=weekly";
        findChild(pane, "routineSave").clicked();
        compare(tc.requests.length, 1);
        const xhr = tc.requests[0];
        compare(xhr.method, "PUT");
        verify(xhr.url.endsWith("/routines/daily/config"));
        compare(JSON.parse(xhr.body).revision, "original");
        compare(JSON.parse(xhr.body).timer, timer.text);
        xhr.complete(409, { error: { message: "Source changed" } });
        verify(Ghostd.routineWriteError.indexOf("Source changed") >= 0);
        compare(editor.visible, true);
        compare(timer.text, "[Timer]\nOnCalendar=weekly");
        findChild(pane, "routineDiscard").clicked();
        tryCompare(editor, "visible", false);
    }
    function test_switchingGhostDropsTheOtherGhostsRowsAndErrors(): void {
        Ghostd.routineWriteError = "Change routine failed";
        Ghostd.routineRecoveries = [{ id: "checkpoint", slug: "daily", reason: "remove", createdAt: "now", applicable: true }];
        Ghostd.switchGhost("aria");
        compare(Ghostd.routineWriteError, "");
        compare(Ghostd.routineRecoveries.length, 0);
    }
    function test_successfulSaveClosesEditorAndRefreshesRecovery(): void {
        const pane = loadedPane();
        Ghostd.routineConfigReady("casper", "daily", { timer: "[Timer]\nOnCalendar=daily", service: "[Service]\nExecStart=/usr/bin/true", revision: "original" });
        const editor = findChild(pane, "routineEditor");
        tryCompare(editor, "visible", true);
        findChild(pane, "routineSave").clicked();
        tc.requests[0].complete(200, { recovery: "saved" });
        tryCompare(editor, "visible", false);
        verify(tc.requests.some(xhr => xhr.url.endsWith("/routines")));
    }
    function test_removedRoutineCanBeRestoredThroughOwnerRoute(): void {
        const pane = loadedPane();
        Ghostd.routineRecoveries = [{ id: "checkpoint", slug: "daily", reason: "remove", createdAt: "now", applicable: true }];
        Ghostd.mutateRoutine("casper", "recoveries/checkpoint/restore", "POST", {});
        const xhr = tc.requests[0];
        verify(xhr.url.endsWith("/routines/recoveries/checkpoint/restore"));
        compare(xhr.method, "POST");
        xhr.complete(200, { recovery: "undo" });
        compare(Ghostd.routinesError, "");
        verify(pane !== null);
    }
}
