import QtQuick
import QtTest
import "../qml/services/HookStatus.js" as HookStatus

TestCase {
    name: "HookStatus"

    function validStatus(): var {
        return {
            active: true,
            total: 3,
            events: [
                { event: "before_prompt", count: 1 },
                { event: "session_stop", count: 2 }
            ],
            hooks: [
                { event: "before_prompt", name: "Prompt policy", description: "Adds policy." },
                { event: "session_stop", name: "Continuity", description: "Checks completion." },
                { event: "session_stop", name: "Style", description: "Checks prose." }
            ]
        };
    }

    function test_normalizesExactRedactedStatus(): void {
        const status = HookStatus.normalize(validStatus());
        verify(status !== null);
        compare(status.total, 3);
        compare(status.events.length, 2);
        compare(status.hooks[1].name, "Continuity");
        compare(HookStatus.label("session_stop"), "Session stop");
        compare(HookStatus.trigger("session_stop"), "After each assistant pass");
        compare(HookStatus.trigger("before_prompt"), "Before each owner prompt");
    }

    function test_acceptsExactEmptyStatus(): void {
        const status = HookStatus.normalize({
            active: false,
            total: 0,
            events: [],
            hooks: []
        });
        verify(status !== null);
        compare(status.total, 0);
    }

    function test_rejectsUnknownOutOfOrderOrInconsistentRows(): void {
        const unknown = validStatus();
        unknown.events[0].event = "conversation_idle";
        compare(HookStatus.normalize(unknown), null);

        const eventOrder = validStatus();
        eventOrder.events = [eventOrder.events[1], eventOrder.events[0]];
        compare(HookStatus.normalize(eventOrder), null);

        const hookOrder = validStatus();
        hookOrder.hooks = [hookOrder.hooks[1], hookOrder.hooks[0], hookOrder.hooks[2]];
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

    function test_rejectsFractionalCountsAndExtraFields(): void {
        const count = validStatus();
        count.events[0].count = 1.25;
        compare(HookStatus.normalize(count), null);

        // A hook row carries exactly event, name and description now.
        const extraHookField = validStatus();
        extraHookField.hooks[0].source = "config";
        compare(HookStatus.normalize(extraHookField), null);

        const extraRoot = validStatus();
        extraRoot.command = "/bin/private";
        compare(HookStatus.normalize(extraRoot), null);

        const extraHook = validStatus();
        extraHook.hooks[0].idleSeconds = 60;
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
