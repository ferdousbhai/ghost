import QtQuick
import QtTest
import qs.components
import qs.services

TestCase {
    id: tc
    name: "ContextBrowser"

    Component {
        id: browserComponent
        ContextBrowser {
            width: 760
            height: 500
            section: "agents"
        }
    }

    function init(): void {
        Ghostd.activeGhost = "casper";
        Ghostd.contextGhost = "casper";
        Ghostd.contextLoading = false;
        Ghostd.contextError = "";
        Ghostd.contextAgents = [
            {
                name: "reviewer",
                description: "Confined definition",
                source: "project",
                tools: null,
                model: [],
                spawns: "*"
            },
            {
                name: "ambient-task",
                description: "Must stay hidden",
                source: "bundled",
                tools: null,
                model: [],
                spawns: null
            }
        ];
    }

    function cleanup(): void {
        Ghostd.contextAgents = [];
        Ghostd.contextGhost = "";
        Ghostd.activeGhost = "";
    }

    function test_confinedDefinitionsAreExplicitlyInactive(): void {
        const browser = createTemporaryObject(browserComponent, tc);
        verify(browser !== null);
        compare(browser.sectionTitle(), "Agent definitions (inactive)");
        compare(browser.agents.length, 1);
        compare(browser.agents[0].name, "reviewer");
        const notice = findChild(browser, "agentInactiveNotice");
        verify(notice !== null);
        verify(notice.text.indexOf("Inactive in phase 1") >= 0);
        verify(notice.text.indexOf("cannot run tasks or delegate") >= 0);
    }

    function test_declaredMetadataNeverClaimsRuntimeAvailability(): void {
        const browser = createTemporaryObject(browserComponent, tc);
        verify(browser !== null);
        compare(browser.toolValue(null), "No tool restriction declared");
        compare(browser.modelValue([]), "No model override declared");
        compare(browser.spawnValue("*"), "Any named agent definition");
        verify(browser.sectionEmptyBody().toLowerCase().indexOf("available") < 0);
    }
}
