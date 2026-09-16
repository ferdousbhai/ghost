import QtQuick
import QtTest
import "../qml/services"
import "FakeXhr.js" as FakeXhr

// The browser-relay pairing prompt: what the HUD service makes of the daemon's
// relay status, and how Allow/Deny reach `/api/relay/pair`.
TestCase {
    id: tc
    name: "RelayPairing"

    property var requests: []

    function init(): void {
        tc.requests = [];
        Ghostd.relayRequestFactory = function () { return FakeXhr.make(tc.requests); };
        Ghostd.relayPairing = null;
        Ghostd.relayResolving = false;
        Ghostd.relayError = "";
        Ghostd.relayRequest = null;
    }

    function cleanup(): void {
        Ghostd.relayRequestFactory = null;
    }

    function test_pairing_parses_only_a_six_digit_code(): void {
        compare(Ghostd.relayPairingFrom({ pairing: { code: "482913", since: "2026-09-08T10:00:00Z" } }),
            { code: "482913", since: "2026-09-08T10:00:00Z" });
        compare(Ghostd.relayPairingFrom({ pairing: null }), null);
        compare(Ghostd.relayPairingFrom({ pairing: { code: "abc" } }), null);
        compare(Ghostd.relayPairingFrom({ pairing: { code: 482913 } }), null);
        compare(Ghostd.relayPairingFrom({ enabled: false }), null);
        compare(Ghostd.relayPairingFrom(null), null);
        compare(Ghostd.relayPairingFrom([]), null);
    }

    function test_refresh_reads_status_and_clears_on_failure(): void {
        Ghostd.refreshRelay();
        compare(tc.requests.length, 1);
        compare(tc.requests[0].method, "GET");
        verify(tc.requests[0].url.endsWith("/api/relay/status"));
        tc.requests[0].complete(200, { enabled: true, connected: false, pairing: { code: "111222", since: "" } });
        compare(Ghostd.relayPairing.code, "111222");

        Ghostd.refreshRelay();
        tc.requests[1].complete(200, "not json");
        compare(Ghostd.relayPairing, null);

        Ghostd.refreshRelay();
        tc.requests[2].complete(200, { enabled: true, pairing: { code: "333444" } });
        compare(Ghostd.relayPairing.code, "333444");
        Ghostd.refreshRelay();
        tc.requests[3].complete(503, { error: { code: "unavailable", message: "down" } });
        compare(Ghostd.relayPairing, null);
    }

    function test_refresh_is_single_flight(): void {
        Ghostd.refreshRelay();
        Ghostd.refreshRelay();
        compare(tc.requests.length, 1);
    }

    function test_allow_posts_the_code_and_applies_the_fresh_status(): void {
        Ghostd.relayPairing = { code: "482913", since: "" };
        Ghostd.resolveRelayPairing("482913", true);
        compare(Ghostd.relayResolving, true);
        compare(tc.requests.length, 1);
        compare(tc.requests[0].method, "POST");
        verify(tc.requests[0].url.endsWith("/api/relay/pair"));
        compare(JSON.parse(tc.requests[0].body), { code: "482913", allow: true });

        // Resolving blocks a poll from racing the answer.
        Ghostd.refreshRelay();
        compare(tc.requests.length, 1);

        tc.requests[0].complete(200, { ok: true, outcome: "paired", pairing: null });
        compare(Ghostd.relayResolving, false);
        compare(Ghostd.relayPairing, null);
        compare(Ghostd.relayError, "");
    }

    function test_deny_posts_allow_false(): void {
        Ghostd.relayPairing = { code: "482913", since: "" };
        Ghostd.resolveRelayPairing("482913", false);
        compare(JSON.parse(tc.requests[0].body), { code: "482913", allow: false });
        tc.requests[0].complete(200, { ok: true, outcome: "denied", pairing: null });
        compare(Ghostd.relayPairing, null);
    }

    function test_a_stale_code_is_simply_gone(): void {
        Ghostd.relayPairing = { code: "482913", since: "" };
        Ghostd.resolveRelayPairing("482913", true);
        tc.requests[0].complete(404, { error: { code: "pairing_not_found", message: "gone" } });
        compare(Ghostd.relayPairing, null);
        compare(Ghostd.relayError, "");
    }

    function test_a_daemon_failure_keeps_the_prompt_and_shows_why(): void {
        Ghostd.relayPairing = { code: "482913", since: "" };
        Ghostd.resolveRelayPairing("482913", true);
        tc.requests[0].complete(500, { error: { code: "internal", message: "relay has no token" } });
        compare(Ghostd.relayPairing.code, "482913");
        verify(Ghostd.relayError !== "");
        compare(Ghostd.relayResolving, false);
    }

    function test_resolve_abandons_an_in_flight_poll(): void {
        Ghostd.relayPairing = { code: "482913", since: "" };
        Ghostd.refreshRelay();
        Ghostd.resolveRelayPairing("482913", true);
        compare(tc.requests.length, 2);
        compare(tc.requests[0].aborted, true);
        // The aborted poll's late completion cannot clear the prompt.
        compare(Ghostd.relayPairing.code, "482913");
        tc.requests[1].complete(200, { ok: true, pairing: null });
        compare(Ghostd.relayPairing, null);
    }
}
