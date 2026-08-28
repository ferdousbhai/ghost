import QtQuick
import QtTest
import "../qml/services/HookStatus.js" as HookStatus

TestCase {
    name: "HookStatus"

    function validStatus(): var {
        return {
            active: true,
            total: 4,
            events: [
                { event: "before_prompt", count: 1 },
                { event: "session_stop", count: 2 },
                { event: "conversation_idle", count: 1 }
            ],
            hooks: [
                { event: "before_prompt", source: "config", name: "Prompt policy", description: "Adds policy." },
                { event: "session_stop", source: "builtin", name: "Continuity", description: "Checks completion." },
                { event: "session_stop", source: "config", name: "Style", description: "Checks prose." },
                {
                    event: "conversation_idle",
                    source: "builtin",
                    name: "Memory upkeep",
                    description: "Updates durable context.",
                    idleSeconds: 600
                }
            ],
            sessionStopContinuationCap: 10
        };
    }

    function test_normalizesExactRedactedStatus(): void {
        const status = HookStatus.normalize(validStatus());
        verify(status !== null);
        compare(status.total, 4);
        compare(status.events.length, 3);
        compare(status.hooks[1].name, "Continuity");
        compare(status.hooks[3].idleSeconds, 600);
        compare(status.sessionStopContinuationCap, 10);
        compare(HookStatus.label("session_stop"), "Session stop");
        compare(HookStatus.trigger("session_stop", 10, 0),
            "After each assistant pass · up to 10 continuations");
        compare(HookStatus.trigger("conversation_idle", 2, 600),
            "After 10 minutes of conversation inactivity");
    }

    function test_acceptsExactEmptyStatus(): void {
        const status = HookStatus.normalize({
            active: false,
            total: 0,
            events: [],
            hooks: [],
            sessionStopContinuationCap: 10
        });
        verify(status !== null);
        compare(status.total, 0);
    }

    function test_acceptsIdleSecondBoundaries(): void {
        const one = validStatus();
        one.hooks[3].idleSeconds = 1;
        verify(HookStatus.normalize(one) !== null);
        const maximum = validStatus();
        maximum.hooks[3].idleSeconds = 86400;
        verify(HookStatus.normalize(maximum) !== null);
    }

    function test_rejectsFractionalOrOutOfRangeIdleSeconds(): void {
        for (const value of [0, 1.5, 86401]) {
            const body = validStatus();
            body.hooks[3].idleSeconds = value;
            compare(HookStatus.normalize(body), null);
        }
        const missing = validStatus();
        delete missing.hooks[3].idleSeconds;
        compare(HookStatus.normalize(missing), null);
        const misplaced = validStatus();
        misplaced.hooks[0].idleSeconds = 60;
        compare(HookStatus.normalize(misplaced), null);
    }

    function test_rejectsUnknownOutOfOrderOrInconsistentRows(): void {
        const unknown = validStatus();
        unknown.events[0].event = "agent_end";
        compare(HookStatus.normalize(unknown), null);

        const eventOrder = validStatus();
        eventOrder.events = [eventOrder.events[1], eventOrder.events[0], eventOrder.events[2]];
        compare(HookStatus.normalize(eventOrder), null);

        const hookOrder = validStatus();
        hookOrder.hooks = [hookOrder.hooks[1], hookOrder.hooks[0],
            hookOrder.hooks[2], hookOrder.hooks[3]];
        compare(HookStatus.normalize(hookOrder), null);

        const count = validStatus();
        count.events[1].count = 1;
        compare(HookStatus.normalize(count), null);

        const total = validStatus();
        total.total = 99;
        compare(HookStatus.normalize(total), null);

        const active = validStatus();
        active.active = false;
        compare(HookStatus.normalize(active), null);
    }

    function test_rejectsFractionalCountsCapsAndExtraFields(): void {
        const count = validStatus();
        count.events[0].count = 1.25;
        compare(HookStatus.normalize(count), null);

        const cap = validStatus();
        cap.sessionStopContinuationCap = 2.5;
        compare(HookStatus.normalize(cap), null);

        const zeroCap = validStatus();
        zeroCap.sessionStopContinuationCap = 0;
        compare(HookStatus.normalize(zeroCap), null);

        const tunedConfig = validStatus();
        tunedConfig.hooks[0].settingsKey = "prompt";
        compare(HookStatus.normalize(tunedConfig), null);

        const badKey = validStatus();
        badKey.hooks[3].settingsKey = "Memory-Upkeep";
        compare(HookStatus.normalize(badKey), null);

        const tuned = validStatus();
        tuned.hooks[3].settingsKey = "memory_upkeep";
        compare(HookStatus.normalize(tuned).hooks[3].settingsKey, "memory_upkeep");
        compare(HookStatus.normalize(tuned).hooks[1].settingsKey, undefined);

        const badSource = validStatus();
        badSource.hooks[0].source = "extension";
        compare(HookStatus.normalize(badSource), null);

        const noSource = validStatus();
        delete noSource.hooks[0].source;
        compare(HookStatus.normalize(noSource), null);

        const hugeCap = validStatus();
        hugeCap.sessionStopContinuationCap = 101;
        compare(HookStatus.normalize(hugeCap), null);

        const otherCap = validStatus();
        otherCap.sessionStopContinuationCap = 6;
        compare(HookStatus.normalize(otherCap).sessionStopContinuationCap, 6);

        const extraRoot = validStatus();
        extraRoot.command = "/bin/private";
        compare(HookStatus.normalize(extraRoot), null);

        const extraHook = validStatus();
        extraHook.hooks[0].path = "/private/hooks.json";
        compare(HookStatus.normalize(extraHook), null);
    }

    function test_rejectsUnboundedOrUntrimmedLabels(): void {
        const blank = validStatus();
        blank.hooks[0].name = " ";
        compare(HookStatus.normalize(blank), null);

        const untrimmed = validStatus();
        untrimmed.hooks[0].description = " leading";
        compare(HookStatus.normalize(untrimmed), null);

        const longName = validStatus();
        longName.hooks[0].name = "n".repeat(81);
        compare(HookStatus.normalize(longName), null);

        const longDescription = validStatus();
        longDescription.hooks[0].description = "d".repeat(241);
        compare(HookStatus.normalize(longDescription), null);
    }
}
