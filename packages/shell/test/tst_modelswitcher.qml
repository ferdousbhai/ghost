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

    function cleanup(): void {
        Ghostd.modelRouting = [];
        Ghostd.modelRoutingLoading = false;
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

    function test_routingCopyNamesGhostWhileKeepingCompatibilityRole(): void {
        const switcher = createTemporaryObject(switcherComponent, this);
        verify(switcher !== null);
        Ghostd.modelRouting = [{
            role: "chat_model",
            ompRole: "default",
            label: "Chat",
            primary: null,
            effective: { provider: "openai", id: "gpt" },
            source: "auto",
            fallbacks: []
        }];
        Ghostd.modelRoutingLoading = false;
        switcher.routingView = true;
        wait(0);

        const summary = findChild(switcher, "routingSummaryText");
        const compatibilityName = findChild(switcher, "roleCompatibilityName");
        verify(summary !== null);
        verify(compatibilityName !== null);
        compare(summary.text,
            "Auto follows Ghost's role defaults. Set a primary only when you want to override it.");
        compare(compatibilityName.text, "Ghost @default");

        Ghostd.modelRoutingLoading = true;
        compare(summary.text, "Loading routes…");
    }

    function test_fallbackPickerUsesGhostNeutralCopy(): void {
        const switcher = createTemporaryObject(switcherComponent, this);
        verify(switcher !== null);
        switcher.beginRoutePick("chat_model", "Chat", "fallback");
        wait(0);

        const status = findChild(switcher, "modelStatusText");
        verify(status !== null);
        compare(status.text, "Choose the next fallback model");
    }
}
