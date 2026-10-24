import QtQuick
import QtTest
import "../qml"
import "../qml/services"

TestCase {
    name: "ReloadReopen"

    Component { id: serviceComponent; Service {} }

    function fakeShell(): var {
        return { summoned: [], summon: function (id, payload) { this.summoned.push(id); } };
    }

    function cleanup(): void {
        Ghostd.reopenAfterReload = false;
    }

    function test_aReloadedServiceReopensWhatTheReloadClosed(): void {
        Ghostd.reopenAfterReload = true;
        const shell = fakeShell(), service = createTemporaryObject(serviceComponent, this);
        service.shell = shell;
        compare(shell.summoned, ["ferdousbhai.ghost"]);
        verify(!Ghostd.reopenAfterReload);
        const later = fakeShell(), again = createTemporaryObject(serviceComponent, this);
        again.shell = later;
        compare(later.summoned, []);
    }
}
