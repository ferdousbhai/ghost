import QtQuick
import QtTest
import qs.services
import "../qml/components" as Components

TestCase {
    id: tc
    name: "ToolCwd"

    Component {
        id: cardComponent
        Components.ToolCard {
            width: 500
            activity: ({})
        }
    }

    function makeCard(activity: var): var {
        return createTemporaryObject(cardComponent, tc, { activity: activity });
    }

    function init(): void {
        Ghostd.activeGhost = "casper";
        Ghostd.ghosts = [{ name: "casper", dir: "/tmp/ghost-home" }];
        Workbench.close();
    }

    function test_nativeRelativeTargetsUseEachCallsOwnCwd(): void {
        const before = makeCard({
            name: "write", status: "complete", cwd: "/home/owner",
            arguments: { path: "same.md" }, intent: "", summary: ""
        });
        const after = makeCard({
            name: "edit", status: "complete", cwd: "/home/owner/project",
            arguments: { path: "same.md" }, intent: "", summary: ""
        });
        verify(before !== null);
        verify(after !== null);
        compare(before.workbenchPath, "/home/owner/same.md");
        compare(after.workbenchPath, "/home/owner/project/same.md");
    }

    function test_oldRelativeNativeTargetDoesNotGuessGhostHome(): void {
        const card = makeCard({
            name: "write", status: "complete",
            arguments: { path: "same.md" }, intent: "", summary: ""
        });
        verify(card !== null);
        compare(card.workbenchPath, "");
        verify(!card.openable);
    }

    function test_ghostCharacterRemainsGhostHomeRelative(): void {
        const card = makeCard({
            name: "ghost_character", status: "complete", cwd: "/home/owner/project",
            arguments: { action: "write" }, intent: "", summary: ""
        });
        verify(card !== null);
        compare(card.workbenchPath, "/tmp/ghost-home/character.md");
    }

    function test_absoluteTargetNeedsNoRecordedCwd(): void {
        const card = makeCard({
            name: "edit", status: "complete",
            arguments: { path: "/srv/shared/notes.md" }, intent: "", summary: ""
        });
        verify(card !== null);
        compare(card.workbenchPath, "/srv/shared/notes.md");
    }
}
