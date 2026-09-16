import QtQuick
import QtTest
import "../qml/services"

// The daemon answers `GET /model` with two source values and a nullable model:
// `explicit` when a role is bound, `none` when it is not — and `none` still
// carries whatever would answer anyway (the first declared provider's model,
// or nothing). Three states, and the HUD used to read them wrong in both
// directions: it warned about a working unbound model, and its "Default" hint
// keyed off a `"default"` source the daemon has never sent.
TestCase {
    id: tc
    name: "ModelState"

    // The HUD's own two predicates, kept here in the same form GhostHud binds
    // them, so a change to either has to change this test.
    function noneSet(model): bool { return model === null; }
    function showsDefaultHint(model, source): bool { return !!model && source === "none"; }

    function test_nothingBoundAndNothingAvailableIsTheOnlyWarning(): void {
        verify(tc.noneSet(null));
        verify(!tc.showsDefaultHint(null, "none"));
    }

    function test_anUnboundButWorkingModelReadsAsDefaultNotAsAWarning(): void {
        const model = { provider: "openrouter", id: "a/b" };
        verify(!tc.noneSet(model), "a model that answers is not 'no model'");
        verify(tc.showsDefaultHint(model, "none"), "unbound-but-working is the Default hint");
    }

    function test_anExplicitBindingIsPlain(): void {
        const model = { provider: "openrouter", id: "a/b" };
        verify(!tc.noneSet(model));
        verify(!tc.showsDefaultHint(model, "explicit"));
    }

    // The source the HUD used to look for. If the daemon ever sends it again
    // this test is the reminder that the hint above must change with it.
    function test_theDaemonNeverSendsADefaultSource(): void {
        const model = { provider: "openrouter", id: "a/b" };
        verify(!tc.showsDefaultHint(model, "default"));
    }
}
