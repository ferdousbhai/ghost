import QtQuick
import QtTest
import "../qml/components"

// A ghost's open question: hidden without one, its suggested answers picked
// by click or number, and withdrawable unanswered.
TestCase {
    id: tc
    name: "QuestionLine"
    when: windowShown
    width: 500
    height: 200
    visible: true

    QuestionLine {
        id: line
        width: 480
    }

    SignalSpy { id: answered; target: line; signalName: "answered" }
    SignalSpy { id: dismissed; target: line; signalName: "dismissed" }

    function init(): void {
        answered.clear();
        dismissed.clear();
        line.question = null;
    }

    function test_hiddenWithoutAQuestion(): void {
        verify(!line.visible);
        line.question = { text: "Ship it tonight?", options: ["yes", "wait"] };
        verify(line.visible);
    }

    function test_numbersPickSuggestedAnswers(): void {
        line.question = { text: "Ship it tonight?", options: ["yes", "wait"] };
        verify(line.choose(1));
        compare(answered.signalArguments[0][0], "wait");
        verify(!line.choose(2));
        compare(answered.count, 1);
    }

    function test_aQuestionWithoutSuggestionsTakesATypedAnswer(): void {
        line.question = { text: "What should I call it?", options: [] };
        verify(line.visible);
        verify(!line.choose(0));
    }
}
