import QtQuick
import QtTest
import qs.components
import qs.services

TestCase {
    name: "ModelSwitcher"

    Component {
        id: switcherComponent
        ModelSwitcher {
            width: 800
            height: 600
        }
    }

    function test_pendingIntentIsDistinctAndAnnotated(): void {
        const switcher = createTemporaryObject(switcherComponent, this);
        verify(switcher !== null);

        switcher.rememberPendingModel({
            provider: "openrouter",
            id: "anthropic/claude-sonnet-4",
            name: "Claude Sonnet 4"
        });

        verify(switcher.hasPendingModel);
        compare(switcher.pendingModelName, "Claude Sonnet 4");
        const state = findChild(switcher, "pendingModelState");
        const annotation = findChild(switcher, "pendingModelAnnotation");
        verify(state !== null);
        verify(annotation !== null);
        compare(state.opacity, 0.58);
        compare(annotation.text, "waiting for login");
    }

    function test_clearFallsBackToEffectiveSelection(): void {
        const switcher = createTemporaryObject(switcherComponent, this);
        verify(switcher !== null);
        Ghostd.activeGhost = "";
        switcher.rememberPendingModel({ provider: "openrouter", id: "model" });

        switcher.clearPendingModel();

        verify(!switcher.hasPendingModel);
        compare(switcher.pendingModel, null);
    }
}
