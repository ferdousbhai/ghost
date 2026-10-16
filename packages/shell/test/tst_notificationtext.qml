import QtTest
import "../qml/services/NotificationText.js" as NotificationText

TestCase {
    name: "NotificationText"

    function test_clickCarriesExactIdentityAsData(): void {
        const ghost = "a'$(touch nope)";
        const sessionId = "a b\"c";
        const args = NotificationText.command(ghost, sessionId, "Title", "Reply", "normal", 42);
        const hint = args.find(arg => arg.startsWith("--hint=string:omarchy-exec-argv:"));
        const action = JSON.parse(hint.slice("--hint=string:omarchy-exec-argv:".length));
        compare(action.slice(0, 4), ["omarchy-shell", "shell", "summon", "ferdousbhai.ghost"]);
        compare(JSON.parse(action[4]), { ghost: ghost, sessionId: sessionId, section: "chat" });
        verify(args.includes("--replace-id=42"));
        compare(args[args.length - 3], "--");
        compare(args[args.length - 2], ghost + " · Title");
    }

    function test_excerptIsBoundedWithoutAnotherModelCall(): void {
        const args = NotificationText.command("casper", "hud-1", " A\n title ", "x".repeat(200), "critical", 0);
        compare(args[args.length - 2], "casper · A title");
        compare(args[args.length - 1], "x".repeat(179) + "…");
        verify(args.includes("--replace-id=0"));
        verify(args.includes("--urgency=critical"));
    }

    function test_markdownReadsAsPlainText(): void {
        const reply = "## Done\n\nYou said: **Show me a list** and `inline code`.\n\n"
            + "- first *item*\n2. second\n> quoted [link](https://example.com) ![chart](a.png)\n"
            + "```js\nconst x = 1;\n```\nsnake_case_name stays";
        const args = NotificationText.command("casper", "s", "**Bold** title", reply, "normal", 0);
        compare(args[args.length - 2], "casper · Bold title");
        compare(args[args.length - 1], "Done You said: Show me a list and inline code. first item second "
            + "quoted link chart const x = 1; snake_case_name stays");
    }
}
