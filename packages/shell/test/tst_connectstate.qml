import QtQuick
import QtTest
import "../qml/components/ConnectState.js" as Connect

TestCase {
    name: "ConnectState"

    function test_liveStatusNormalisation(): void {
        compare(Connect.phaseLabel({ phase: "waiting_for_audio" }), "Waiting for audio");
        verify(Connect.liveActive({ status: "listening" }));
        verify(!Connect.liveActive({ status: "stopped" }));
        verify(Connect.muted({ phase: "muted" }));
        compare(Connect.level({ inputLevel: 1.8 }), 1);
        compare(Connect.level({ audioLevel: -2 }), 0);
    }

    function test_transcriptSupportsTextAndRows(): void {
        compare(Connect.transcript({ transcript: "hello" }), "hello");
        compare(Connect.transcript({ transcript: [
            { role: "you", text: "Hello" },
            { speaker: "ghost", content: "Hi" }
        ] }), "you: Hello\nghost: Hi");
    }

    function test_structuredNotSupported(): void {
        verify(Connect.notSupported({ supported: false, reason: "Deferred" }));
        verify(Connect.notSupported({ code: "not_supported" }));
        compare(Connect.supportMessage({ supported: false, reason: "Deferred" }, "fallback"), "Deferred");
    }

    function test_collabUrlsRemainSeparate(): void {
        const status = {
            active: true,
            urls: { readOnly: "https://relay/read", writable: "https://relay/write" }
        };
        verify(Connect.collabActive(status));
        compare(Connect.readOnlyUrl(status), "https://relay/read");
        compare(Connect.writableUrl(status), "https://relay/write");
    }

}
