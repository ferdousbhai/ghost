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
}
