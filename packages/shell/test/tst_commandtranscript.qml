import QtTest
import "../qml/services/CommandTranscript.js" as CommandTranscript

TestCase {
    name: "CommandTranscript"

    function test_aggregatesEveryOutputFrameAndErrorState(): void {
        let exchange = CommandTranscript.append(null, {
            command: "/tools", output: "read", isError: false
        }, "/tools", 2);
        exchange = CommandTranscript.append(exchange, {
            command: "/tools", output: "write", isError: true,
            code: "command_failed"
        }, "/tools", 2);

        compare(exchange.output, "read\nwrite");
        compare(exchange.anchor, 2);
        verify(exchange.isError);
        compare(CommandTranscript.failure(exchange), "Command failed.");
    }

    function test_refreshReinsertsCommandAtItsStoredAnchor(): void {
        const stored = [
            { role: "user", text: "before" },
            { role: "assistant", text: "answer" },
            { role: "user", text: "after" },
            { role: "assistant", text: "later answer" }
        ];
        const command = CommandTranscript.append(null, {
            command: "/tools", output: "read\nwrite"
        }, "/tools --all", 2);
        const rows = CommandTranscript.merge(stored, [command]);

        compare(rows.length, 6);
        compare(rows.map(row => row.role).join(","),
            "user,assistant,user,command,user,assistant");
        compare(rows[2].text, "/tools --all");
        compare(rows[3].text, "read\nwrite");
        compare(rows[3].entryId, "");
    }

    function test_consecutiveCommandsKeepTheirLiveOrder(): void {
        const first = CommandTranscript.append(null,
            { command: "/tools", output: "tools" }, "/tools", 0);
        const second = CommandTranscript.append(null, {
            command: "/memory", output: "not in Ghost", isError: true,
            code: "unsupported_command"
        }, "/memory", 0);
        const rows = CommandTranscript.merge([], [first, second]);

        compare(rows.map(row => row.text).join("|"),
            "/tools|tools|/memory|not in Ghost");
        compare(rows[3].error, "This command is unavailable here.");
    }
}
