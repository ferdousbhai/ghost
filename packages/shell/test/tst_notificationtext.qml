import QtTest
import "../qml/services/NotificationText.js" as NotificationText

TestCase {
    name: "NotificationText"

    function test_askNamesTheReasonItPaused(): void {
        compare(NotificationText.askBody({
            questions: [{ question: "Which finish should I use?" }]
        }), "Needs your input · Which finish should I use?");
    }

    function test_askNormalizesWhitespaceAndCountsTheRest(): void {
        compare(NotificationText.askBody({
            questions: [
                { question: "  Back it up\nfirst?  " },
                { question: "Where?" },
                { question: "When?" }
            ]
        }), "Needs your input · Back it up first? (+2 more)");
    }

    function test_malformedAskStillExplainsItself(): void {
        compare(NotificationText.askBody(null), "Needs your input");
        compare(NotificationText.askBody({ questions: [{}] }), "Needs your input");
    }

    function test_clickCarriesExactIdentityAsData(): void {
        const ghost = "a'$(touch nope)";
        const sessionId = "pi:a b\"c";
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
        const args = NotificationText.command("casper", "pi:1", " A\n title ", "x".repeat(200), "critical", 0);
        compare(args[args.length - 2], "casper · A title");
        compare(args[args.length - 1], "x".repeat(179) + "…");
        verify(args.includes("--replace-id=0"));
        verify(args.includes("--urgency=critical"));
    }
}
