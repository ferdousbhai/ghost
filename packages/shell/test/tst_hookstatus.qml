import QtQuick
import QtTest
import "../qml/services/HookStatus.js" as HookStatus

TestCase {
    name: "HookStatus"

    function test_normalizesRedactedStatus(): void {
        const status = HookStatus.normalize({
            active: true,
            total: 99,
            events: [
                { event: "before_prompt", count: 1 },
                { event: "session_stop", count: 2 },
                { event: "conversation_idle", count: 1 }
            ],
            hooks: [
                { event: "before_prompt", name: "Prompt policy", description: "Adds policy." },
                { event: "session_stop", name: "Continuity", description: "Checks completion." },
                { event: "session_stop", name: "Style", description: "Checks prose." },
                {
                    event: "conversation_idle",
                    name: "Memory upkeep",
                    description: "Updates durable context.",
                    idle_seconds: 600
                }
            ],
            session_stop_continuation_cap: 6
        });
        compare(status.total, 4);
        compare(status.events.length, 3);
        compare(status.hooks[1].name, "Continuity");
        compare(status.hooks[3].idleSeconds, 600);
        compare(status.sessionStopContinuationCap, 6);
        compare(HookStatus.label("session_stop"), "Session stop");
        verify(HookStatus.trigger("session_stop", 6).indexOf("up to 6 continuations") >= 0);
        compare(HookStatus.trigger("conversation_idle", 6, 600),
            "After 10 minutes of conversation inactivity");
    }

    function test_rejectsMalformedEvents(): void {
        compare(HookStatus.normalize({ events: [{ event: "session_stop", count: 0 }], hooks: [] }), null);
        compare(HookStatus.normalize({ events: "session_stop", hooks: [] }), null);
    }
}
