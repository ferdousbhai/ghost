import QtQuick
import QtTest
import qs.components
import qs.services

TestCase {
    id: tc
    name: "ProjectChip"

    Component {
        id: chipComponent
        ProjectChip {
            width: implicitWidth
            height: implicitHeight
            availableWidth: 360
            availableHeight: 420
        }
    }

    function resources(overrides: var): var {
        return Object.assign({
            instructions: 1, skills: 2, rules: 0, prompts: 0,
            commands: 1, agents: 1, mcpServers: 1, ignoredExecutable: 0
        }, overrides || {});
    }

    function state(overrides: var): var {
        return Object.assign({
            id: "pi:project-chip",
            conversationId: "project-chip",
            runtime: "pi",
            root: "/home/owner/code/ghost",
            cwd: "/home/owner/code/ghost/packages/shell",
            relativeCwd: "packages/shell",
            name: "ghost",
            generation: 7,
            status: "ready",
            error: null,
            mcpStatus: "ready",
            resources: resources(),
            canRebind: true,
            lastRefreshAt: "2026-08-26T10:00:00.000Z",
            reason: "resumed"
        }, overrides || {});
    }

    function init(): void {
        Ghostd.clearProject();
        Ghostd.activeGhost = "casper";
        Ghostd.sessionIds = ({ casper: "pi:project-chip" });
        Ghostd.currentSessionId = "pi:project-chip";
        Ghostd.projectGhost = "casper";
        Ghostd.projectSessionId = "pi:project-chip";
        Ghostd.projectState = state();
    }

    function cleanup(): void {
        Ghostd.clearProject();
    }

    function test_chipAndPanelExposeCurrentBoundary(): void {
        const chip = createTemporaryObject(chipComponent, tc);
        verify(chip !== null);
        compare(chip.binding.name, "ghost");
        chip.panelOpen = true;
        wait(0);
        const button = findChild(chip, "projectChipButton");
        const panel = findChild(chip, "projectPanel");
        const status = findChild(chip, "projectStatusText");
        verify(button !== null);
        verify(panel !== null, "project panel should be instantiated");
        verify(chip.panelOpen);
        verify(status !== null);
        verify(status.text.indexOf("Generation 7") >= 0);
        verify(status.text.indexOf("MCP ready") >= 0);
    }

    function test_compactChipKeepsPanelInsideAvailableWidth(): void {
        const chip = createTemporaryObject(chipComponent, tc, {
            compact: true,
            availableWidth: 320
        });
        verify(chip !== null);
        verify(chip.implicitWidth <= 136);
        compare(chip.panelWidth, 320);
    }

    function test_keyboardOpensAndEscapesTheProjectPanel(): void {
        const chip = createTemporaryObject(chipComponent, tc);
        const button = findChild(chip, "projectChipButton");
        verify(button !== null);
        button.forceActiveFocus();
        keyClick(Qt.Key_Return);
        compare(chip.panelOpen, true);
        keyClick(Qt.Key_Escape);
        compare(chip.panelOpen, false);
    }

    function test_trustIsExplicitBeforeBind(): void {
        const chip = createTemporaryObject(chipComponent, tc);
        chip.panelOpen = true;
        chip.mode = "preview";
        Ghostd.projectPreview = {
            root: "/home/owner/code/another",
            name: "another",
            trustToken: "opaque",
            expiresAt: "2099-01-01T00:00:00.000Z",
            resources: resources(),
            warnings: []
        };
        wait(0);
        const trust = findChild(chip, "trustToggle");
        const trustCopy = findChild(chip, "projectTrustCopy");
        const bind = findChild(chip, "bindButton");
        const risk = findChild(chip, "trustRiskWarning");
        verify(trust !== null, "trust control should be instantiated");
        verify(trustCopy !== null);
        verify(bind !== null, "bind action should be instantiated");
        verify(risk !== null, "trust risk must be visibly instantiated");
        verify(risk.text.indexOf("YOLO mode") >= 0);
        verify(risk.text.indexOf("without approval prompts") >= 0);
        verify(risk.text.indexOf("run commands") >= 0);
        verify(risk.text.indexOf("access files") >= 0);
        compare(trust.Accessible.description, chip.trustRisk);
        verify(trustCopy.text.toLowerCase().indexOf("helper") < 0);
        verify(trustCopy.text.toLowerCase().indexOf("agent") < 0);
        const panel = findChild(chip, "projectPanel");
        verify(panel !== null);
        verify(panel.height <= chip.availableHeight,
            "the expanded trust disclosure must stay within the panel viewport");
        compare(chip.mode, "preview");
        verify(!bind.enabled);
        chip.trustConfirmed = true;
        wait(0);
        verify(bind.enabled);
    }

    function test_unbindDoesNotClaimInactiveAgentsWereLoaded(): void {
        const chip = createTemporaryObject(chipComponent, tc);
        chip.panelOpen = true;
        chip.mode = "unbind";
        wait(0);
        const copy = findChild(chip, "projectUnbindCopy");
        verify(copy !== null);
        verify(copy.text.toLowerCase().indexOf("helper") < 0);
        verify(copy.text.toLowerCase().indexOf("agent") < 0);
    }

    function test_projectSelectionRequiresAbsolutePath(): void {
        const chip = createTemporaryObject(chipComponent, tc);
        chip.panelOpen = true;
        chip.mode = "choose";
        chip.inputPath = "../relative";
        wait(0);
        const previewButton = findChild(chip, "previewButton");
        verify(previewButton !== null);
        verify(!chip.inputIsAbsolute);
        verify(!previewButton.enabled);
        chip.inputPath = "/home/owner/code/ghost";
        wait(0);
        verify(chip.inputIsAbsolute);
        verify(previewButton.enabled);
        chip.inputPath = "/home/owner/code/ghost/../another/";
        wait(0);
        verify(chip.inputIsAbsolute);
        verify(previewButton.enabled);
    }

    function test_claudeFixedProjectShowsStartNewGuidance(): void {
        Ghostd.projectState = state({
            id: "claude-code:project-chip",
            runtime: "claude-code",
            canRebind: false
        });
        Ghostd.currentSessionId = "claude-code:project-chip";
        Ghostd.projectSessionId = Ghostd.currentSessionId;
        const chip = createTemporaryObject(chipComponent, tc);
        chip.panelOpen = true;
        wait(0);
        const startNew = findChild(chip, "newConversationButton");
        verify(startNew !== null);
        verify(!chip.binding.canRebind);
        verify(startNew.activeFocusOnTab);
    }

    function test_degradedDiscoveryIsVisibleWithoutHidingKnownResources(): void {
        Ghostd.projectState = state({
            status: "degraded",
            mcpStatus: "degraded",
            error: { code: "mcp_reload_failed", message: "The prior MCP tools remain active." }
        });
        const chip = createTemporaryObject(chipComponent, tc);
        chip.panelOpen = true;
        wait(0);
        verify(chip.attention);
        const status = findChild(chip, "projectStatusText");
        verify(status !== null);
        verify(status.text.indexOf("Needs attention") >= 0);
        verify(status.text.indexOf("MCP degraded") >= 0);
    }
}
