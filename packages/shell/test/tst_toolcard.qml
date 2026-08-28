import QtQuick
import QtTest
import qs.services
import "../qml/components/ToolTrace.js" as ToolTrace

TestCase {
    id: tc
    name: "ToolTrace"

    function test_liveIntentWinsOverMechanism(): void {
        const activity = {
            name: "ghost_browser",
            status: "running",
            arguments: { action: "find", query: "train times" },
            intent: "Checking whether the last train still runs",
            summary: ""
        };
        const trace = ToolTrace.text(activity, false, false, false);
        compare(trace, "Checking whether the last train still runs");
        verify(!trace.includes("browser"));
    }

    function test_liveSummaryBecomesOutcome(): void {
        const activity = {
            name: "ghost_notes_grep",
            status: "complete",
            arguments: { query: "launch" },
            intent: "Find the launch plan",
            summary: "Found the plan in roadmap.md"
        };
        compare(ToolTrace.text(activity, true, false, false), "Found the plan in roadmap.md");
    }

    function test_restoredCallUsesHumanFallback(): void {
        const activity = {
            name: "ghost_notes_read",
            status: "complete",
            arguments: { path: "projects/roadmap.md" },
            intent: "",
            summary: ""
        };
        compare(ToolTrace.text(activity, true, false, false), "Read projects/roadmap.md");
    }

    function test_legacyNoteCallStaysInImportedGhostHome(): void {
        const activity = {
            name: "ghost_notes_write",
            status: "complete",
            arguments: { path: "projects/roadmap.md" },
            intent: "",
            summary: ""
        };
        compare(ToolTrace.fileTarget(activity), "docs/projects/roadmap.md");
        compare(ToolTrace.fileBase(activity), "ghost");
    }

    function test_nativeWriterUsesItsCapturedCwd(): void {
        const activity = {
            name: "write",
            status: "complete",
            cwd: "/home/owner/projects/one",
            arguments: { path: "notes/today.md" },
            intent: "",
            summary: ""
        };
        const view = ToolTrace.view(activity, true, false, false);
        compare(view.fileBase, "cwd");
        compare(view.fileCwd, "/home/owner/projects/one");
        compare(
            Workbench.absoluteFrom(view.fileTarget, view.fileCwd),
            "/home/owner/projects/one/notes/today.md"
        );
    }

    function test_relativeNativeWriterWithoutRecordedCwdIsRefused(): void {
        compare(Workbench.absoluteFrom("notes/today.md", ""), "");
        // Absolute historical arguments remain unambiguous without the new field.
        compare(Workbench.absoluteFrom("/srv/archive/today.md", ""),
            "/srv/archive/today.md");
    }

    function test_resolutionUsesTheCallCwdNotCurrentGhostOrLaterCd(): void {
        compare(Workbench.absoluteFrom("same.md", "/home/owner"),
            "/home/owner/same.md");
        compare(Workbench.absoluteFrom("same.md", "/home/owner/code/project"),
            "/home/owner/code/project/same.md");
        compare(Workbench.absoluteFrom("../shared.md", "/home/owner/code/project"),
            "/home/owner/code/shared.md");
    }

    function test_failureKeepsPurpose(): void {
        const activity = {
            name: "ghost_browser",
            status: "failed",
            arguments: { action: "open", url: "https://example.com" },
            intent: "",
            summary: ""
        };
        compare(
            ToolTrace.text(activity, false, true, false),
            "Couldn’t complete: Opening https://example.com"
        );
    }

    function test_characterReadNamesTheGhostItself(): void {
        const activity = {
            name: "ghost_character",
            status: "running",
            arguments: { action: "read" },
            intent: "",
            summary: ""
        };
        const trace = ToolTrace.text(activity, false, false, false);
        compare(trace, "Reading its own character");
        verify(!trace.includes("character.md"));
    }

    function test_characterWriteIsSelfAuthorship(): void {
        const activity = {
            name: "ghost_character",
            status: "complete",
            arguments: { action: "write", content: "# Casper\n\nGentle." },
            intent: "",
            summary: ""
        };
        compare(ToolTrace.text(activity, true, false, false), "Wrote its character");
    }

    // Onboarding calls arrive mid-stream, before the arguments have finished
    // buffering, so the card must read as something before `action` exists.
    function test_characterWithoutActionStillReads(): void {
        const activity = {
            name: "ghost_character",
            status: "preparing",
            arguments: ({}),
            intent: "",
            summary: ""
        };
        compare(ToolTrace.text(activity, false, false, false), "Reading its own character");
    }

    // One settled ask, reused: the question the user closed the app on rather
    // than answering.
    function askActivity(settled: string): var {
        return {
            name: "ask",
            status: "complete",
            askSettled: settled,
            arguments: {
                questions: [{
                    id: "q1",
                    header: "Danger",
                    question: "Delete /home/dous/verygoodplugins and everything inside it?",
                    options: [
                        { label: "Delete it" },
                        { label: "Leave it alone" }
                    ],
                    recommended: 1
                }]
            },
            intent: "",
            summary: ""
        };
    }

    // The bug this whole card was reworked for: a question nobody answered
    // reported an answer, because "complete" was read as "submitted".
    function test_cancelledAskNeverClaimsAnAnswer(): void {
        const trace = ToolTrace.text(askActivity("cancelled"), true, false, false);
        compare(trace, "Never got an answer");
        verify(!trace.includes("Received"));
    }

    // A deadline the owner missed left a decision standing. The card is the
    // only place they will ever find out which one, so it names it.
    function test_timedOutAskNamesWhatWasChosenForTheOwner(): void {
        compare(
            ToolTrace.text(askActivity("timedOut"), true, false, false),
            "Time ran out — answered “Leave it alone” for you"
        );
        compare(ToolTrace.askAutoAnswer(askActivity("timedOut")), "Leave it alone");
    }

    // Nothing recommended, nothing submitted. Naming an option here would
    // invent the very decision the owner is being told about.
    function test_timedOutAskWithNoRecommendationNamesNoOption(): void {
        const activity = {
            name: "ask",
            status: "complete",
            askSettled: "timedOut",
            arguments: {
                questions: [{
                    id: "q1",
                    question: "Which branch should I start from?",
                    options: [{ label: "master" }, { label: "the release tag" }]
                }]
            },
            intent: "",
            summary: ""
        };
        compare(
            ToolTrace.text(activity, true, false, false),
            "Time ran out — nothing was answered"
        );
        compare(ToolTrace.askAutoAnswer(activity), "");
    }

    // The undo. A standing decision is corrected, not answered for the first
    // time — but only when the clock actually took one.
    function test_timedOutAskOffersTheChangeRatherThanAFirstAnswer(): void {
        compare(ToolTrace.askAction(askActivity("timedOut")), "Change it");
        compare(
            ToolTrace.askAction({
                name: "ask",
                askSettled: "timedOut",
                arguments: { questions: [{ id: "q", question: "Which?", options: [] }] }
            }),
            "Answer it"
        );
    }

    function test_submittedAskStillReadsAsAnswered(): void {
        compare(
            ToolTrace.text(askActivity("submitted"), true, false, false),
            "Received your answer"
        );
    }

    function test_chatRedirectIsNotAnAnswer(): void {
        compare(
            ToolTrace.text(askActivity("chat"), true, false, false),
            "Talked it through instead"
        );
    }

    // A transcript written before the daemon reported settlement, and any
    // value this shell does not know, must not be guessed into an outcome.
    function test_unknownSettlementReportsOnlyThatItWasAsked(): void {
        compare(
            ToolTrace.text(askActivity(""), true, false, false),
            "Asked you a question"
        );
        compare(
            ToolTrace.text(askActivity("half-answered"), true, false, false),
            "Asked you a question"
        );
    }

    function test_liveAskIsStillWaiting(): void {
        compare(
            ToolTrace.text(askActivity(""), false, false, false),
            "Waiting for your answer"
        );
    }

    // An ask that errored out was closed or abandoned, not a tool that broke,
    // so it keeps its own words instead of wearing the generic failure prefix.
    function test_failedAskIsAnUnansweredQuestionNotABrokenTool(): void {
        const trace = ToolTrace.text(askActivity(""), false, true, false);
        compare(trace, "Never got an answer");
        verify(!trace.includes("Couldn’t complete"));
    }

    // The card's whole point: the question survives the scrollback.
    function test_askCardCarriesTheQuestionItself(): void {
        compare(
            ToolTrace.askPrompt(askActivity("cancelled")),
            "Danger · Delete /home/dous/verygoodplugins and everything inside it?"
        );
    }

    function test_expandedAskNamesTheOptionsAndTheRecommendation(): void {
        compare(
            ToolTrace.askDetail(askActivity("cancelled")),
            "Options · Delete it · Leave it alone (recommended)"
        );
    }

    // A multi-part ask has room for one question on the line; the rest are
    // counted there and named behind the expand.
    function test_multiPartAskCountsTheRestAndNamesThemWhenExpanded(): void {
        const activity = {
            name: "ask",
            status: "complete",
            askSettled: "cancelled",
            arguments: {
                questions: [
                    { id: "a", question: "Delete the folder?", options: [{ label: "Yes" }] },
                    { id: "b", question: "Back it up first?", options: [{ label: "No" }] }
                ]
            },
            intent: "",
            summary: ""
        };
        compare(ToolTrace.askPrompt(activity), "Delete the folder?  +1 more question");
        compare(
            ToolTrace.askDetail(activity),
            "Options · Yes\nAlso asked · Back it up first?\nOptions · No"
        );
    }

    // "Re-answer" presumes a first answer that a cancelled question never got.
    function test_actionOffersAFirstAnswerWhenThereWasNone(): void {
        compare(ToolTrace.askAction(askActivity("submitted")), "Re-answer");
        compare(ToolTrace.askAction(askActivity("cancelled")), "Answer it");
        compare(ToolTrace.askAction(askActivity("")), "Answer it");
    }

    // The clock's answer is not the owner's answer, so a timed-out card keeps
    // the rose an answered one drops.
    function test_theClocksAnswerIsStillNotTheOwners(): void {
        verify(ToolTrace.askAwaiting(askActivity("timedOut"), true));
        verify(!ToolTrace.askAwaiting(askActivity("submitted"), true));
    }

    // The rose temperature is for a question with no answer — including one
    // still standing open — and never for one that was answered. Not knowing
    // how a finished ask settled is not the same as knowing it went unanswered.
    function test_onlyAnUnansweredQuestionLeavesTheAmber(): void {
        verify(ToolTrace.askAwaiting(askActivity("cancelled"), true));
        verify(ToolTrace.askAwaiting(askActivity("timedOut"), true));
        verify(ToolTrace.askAwaiting(askActivity(""), false));
        verify(!ToolTrace.askAwaiting(askActivity("submitted"), true));
        verify(!ToolTrace.askAwaiting(askActivity("chat"), true));
        verify(!ToolTrace.askAwaiting(askActivity(""), true));
    }

    function test_ordinaryToolNeverWearsTheQuestionTreatment(): void {
        const activity = {
            name: "ghost_docs_read",
            status: "complete",
            arguments: { path: "notes.md" },
            intent: "",
            summary: ""
        };
        compare(ToolTrace.askPrompt(activity), "");
        compare(ToolTrace.askDetail(activity), "");
        verify(!ToolTrace.askAwaiting(activity, false));
    }

    // The questions are on the card now, so the count row would only repeat
    // them — but a non-ask tool that happens to carry questions keeps it.
    function test_askInputRowYieldsToTheQuestionsThemselves(): void {
        compare(ToolTrace.input(askActivity("cancelled")), "");
        verify(ToolTrace.hasDiagnostics(askActivity("cancelled")));
        compare(
            ToolTrace.input({ name: "survey", arguments: { questions: [1, 2] } }),
            "2 questions"
        );
    }

    // Nothing above proves anything about the real thing on its own: an
    // activity reaches a ToolCard across a ListModel role AND a Repeater's
    // `modelData`, and each of those hands a JS array back as a variant list —
    // it indexes and measures like an array and fails `Array.isArray` flat.
    // Asking the wrong question there is silent, and it rendered restored ask
    // cards with no question and no options on them at all.

    ListModel { id: restoredTranscript }

    property var throughTheModels: null
    property var crossed: []

    Item {
        Repeater {
            model: tc.crossed
            delegate: Item {
                required property var modelData
                Component.onCompleted: tc.throughTheModels = modelData
            }
        }
    }

    function test_anAskSurvivesEveryModelItIsRenderedThrough(): void {
        restoredTranscript.append({
            role: "assistant",
            toolActivity: [tc.askActivity("timedOut")]
        });
        // Bubble's own recovery of the role into a real array.
        const raw = restoredTranscript.get(0).toolActivity;
        const list = [];
        for (let i = 0; i < raw.count; i++) list.push(raw.get(i));
        tc.crossed = list;
        wait(50);

        const activity = tc.throughTheModels;
        verify(activity !== null);
        // The premise: this is exactly the shape that used to read as empty.
        verify(!Array.isArray(activity.arguments.questions));

        compare(ToolTrace.askAutoAnswer(activity), "Leave it alone");
        compare(
            ToolTrace.text(activity, true, false, false),
            "Time ran out — answered “Leave it alone” for you"
        );
        compare(
            ToolTrace.askPrompt(activity),
            "Danger · Delete /home/dous/verygoodplugins and everything inside it?"
        );
        compare(
            ToolTrace.askDetail(activity),
            "Options · Delete it · Leave it alone (recommended)"
        );
        compare(ToolTrace.askAction(activity), "Change it");
        compare(ToolTrace.input(activity), "");
    }

    function test_unknownCallStaysOutOfTheTranscript(): void {
        const activity = {
            name: "internal_operation",
            status: "running",
            arguments: ({}),
            intent: "",
            summary: ""
        };
        compare(ToolTrace.text(activity, false, false, false), "");
    }
}
