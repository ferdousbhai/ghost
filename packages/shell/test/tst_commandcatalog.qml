import QtQuick
import QtTest
import "../qml/components/CommandCatalog.js" as Catalog

TestCase {
    name: "CommandCatalog"

    readonly property var commands: [
        {
            name: "/tree",
            aliases: ["branch", "/branches", "branch"],
            description: "Browse conversation branches",
            input: { usage: "[entry]" },
            subcommands: [{ name: "show" }, "list"],
            source: "built-in"
        },
        {
            name: "release-notes",
            aliases: [],
            description: "Draft release notes",
            input: "<version>",
            source: "project"
        },
        { name: "skill:research", description: "Research a topic", source: "skill" }
    ]

    function test_normalizesInvocationAndMetadata(): void {
        compare(Catalog.commandName(commands[0]), "tree");
        compare(Catalog.aliases(commands[0]).join(","), "branch,branches");
        compare(Catalog.invocation(commands[0]), "/tree ");
        compare(Catalog.inputHint(commands[0].input), "[entry]");
        compare(Catalog.subcommandText(commands[0]), "show  ·  list");
    }

    function test_searchIncludesAliasesDescriptionsAndInputs(): void {
        compare(Catalog.filtered(commands, "branches").length, 1);
        compare(Catalog.filtered(commands, "draft")[0].name, "release-notes");
        compare(Catalog.filtered(commands, "version")[0].name, "release-notes");
        compare(Catalog.filtered(commands, "missing").length, 0);
    }

    function test_groupsPreserveEffectiveCatalogOrder(): void {
        const groups = Catalog.groups(commands, "");
        compare(groups.length, 3);
        compare(groups[0].label, "Built in");
        compare(groups[0].commands[0].name, "/tree");
        compare(groups[2].commands[0].name, "skill:research");
    }

    function test_completionMatchesNamesAndAliasesWithACap(): void {
        compare(Catalog.completions(commands, "/tr", 6)[0].name, "/tree");
        compare(Catalog.completions(commands, "bran", 6)[0].name, "/tree");
        compare(Catalog.completions(commands, "", 2).length, 2);
    }

    function test_availabilityKeepsUnsupportedCommandsDiscoverable(): void {
        const unsupported = {
            name: "tree",
            availability: "unsupported",
            unavailableReason: "Ghost forks instead of rewinding branches."
        };
        compare(Catalog.availability(unsupported), "unsupported");
        compare(Catalog.availabilityLabel(unsupported), "Unsupported here");
        compare(Catalog.filtered([unsupported], "rewinding").length, 1);
        compare(Catalog.invocation(unsupported), "/tree ");
        compare(Catalog.availability({ name: "help" }), "supported");
    }
}
