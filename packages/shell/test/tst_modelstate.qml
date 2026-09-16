import QtQuick
import QtTest
import "../qml/services"

// The daemon answers `GET /model` with two source values and a nullable model:
// `explicit` when a role is bound, `none` when it is not — and `none` still
// carries whatever would answer anyway. The HUD read that wrong in both
// directions once: it warned about a working unbound model, and its "Default"
// hint keyed off a `"default"` source the daemon has never sent. These assert
// the real `Ghostd.noModel`, not a copy of it, so the HUD cannot drift from
// the test without breaking it.
TestCase {
    id: tc
    name: "ModelState"

    function test_nothingBoundAndNothingAvailableIsTheOnlyWarning(): void {
        Ghostd.currentModel = null;
        Ghostd.modelSource = "none";
        verify(Ghostd.noModel);
    }

    function test_anUnboundButWorkingModelIsNotAWarning(): void {
        Ghostd.currentModel = { provider: "openrouter", id: "a/b" };
        Ghostd.modelSource = "none";
        verify(!Ghostd.noModel, "a model that answers is not 'no model'");
        // `none` with a model present is the Default hint, the case the HUD
        // used to miss entirely.
        verify(Ghostd.modelSource === "none" && !Ghostd.noModel);
    }

    function test_anExplicitBindingIsPlain(): void {
        Ghostd.currentModel = { provider: "openrouter", id: "a/b" };
        Ghostd.modelSource = "explicit";
        verify(!Ghostd.noModel);
    }

    function cleanupTestCase(): void {
        Ghostd.currentModel = null;
        Ghostd.modelSource = "none";
    }
}
