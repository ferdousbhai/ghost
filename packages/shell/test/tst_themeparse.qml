import QtTest
import "../qml/services"

// Theme reads two Omarchy files with one deliberately small TOML parser. What
// it must never do is damage a value it did not understand: a theme is machine
// generated, but a hand-edited or half-written line still has to come through
// as itself rather than as a value with its last character eaten.
TestCase {
    id: tc

    name: "ThemeParse"

    property var savedColors: null
    property var savedShell: null

    function init(): void {
        tc.savedColors = Theme.colors;
        tc.savedShell = Theme.shell;
    }

    function cleanup(): void {
        Theme.colors = tc.savedColors;
        Theme.shell = tc.savedShell;
    }

    function test_flatColoursParse(): void {
        const parsed = Theme.parseToml(
            "# Tokyo Night\nmode = \"dark\"\nbackground = \"#1a1b26\"\n"
            + "\naccent = \"#7aa2f7\"   # the one Omarchy publishes\n", false);
        compare(parsed["mode"], "dark");
        compare(parsed["background"], "#1a1b26");
        compare(parsed["accent"], "#7aa2f7");
    }

    function test_sectionsPrefixKeysOnlyWhenAsked(): void {
        const text = "[font]\nbase-size = 13\n\n[popups]\nborder = \"hyprland.active-border\"\n";
        const sectioned = Theme.parseToml(text, true);
        compare(sectioned["font.base-size"], "13");
        compare(sectioned["popups.border"], "hyprland.active-border");
        compare(sectioned["base-size"], undefined);

        // colors.toml is flat: a section heading there must not smuggle a
        // prefix onto the keys the palette looks up by bare name.
        const flat = Theme.parseToml(text, false);
        compare(flat["base-size"], "13");
        compare(flat["border"], "hyprland.active-border");
    }

    function test_unquotedValuesAndCommentsSurvive(): void {
        const parsed = Theme.parseToml(
            "# leading comment\n\nscale = 1.25  # trailing\nscale-with-font = true\n"
            + "  spaced   =   18  \nnot a pair\n", true);
        compare(parsed["scale"], "1.25");
        compare(parsed["scale-with-font"], "true");
        compare(parsed["spaced"], "18");
        compare(parsed["not a pair"], undefined);
    }

    function test_quotesComeOffOnlyInMatchedPairs(): void {
        const rows = [
            ["balanced", "value = \"abc\"", "abc"],
            ["single quoted", "value = 'abc'", "abc"],
            ["opening only", "value = \"abc", "\"abc"],
            ["closing only", "value = abc\"", "abc\""],
            ["mismatched pair", "value = \"abc'", "\"abc'"],
            ["empty string", "value = \"\"", ""],
            ["no value at all", "value =", ""],
            ["one lone quote", "value = \"", "\""],
            ["one lone apostrophe", "value = '", "'"],
            ["hash inside the string", "value = \"a # b\"", "a # b"],
            ["comment after the string", "value = \"abc\" # why", "abc"]
        ];
        for (const row of rows)
            compare(Theme.parseToml(row[1] + "\n", false)["value"], row[2], row[0]);
    }

    function test_parsedShellValuesFeedTheTokens(): void {
        Theme.shell = Theme.parseToml(
            "[font]\nbase-size = 16\n\n[spacing]\nscale = 1\nscale-with-font = false\n"
            + "panel-padding = 20\n\n[popups]\nborder = \"hyprland.active-border\"\n"
            + "\n[hyprland]\nactive-border = \"rgba(ff8800ff)\"\n", true);

        // A reference hops to the key it names rather than being read as text.
        compare(Theme.shellValue("popups.border"), "rgba(ff8800ff)");
        compare(Theme.shellNumber("font.base-size", 12), 16);
        compare(Theme.shellNumber("font.missing", 11), 11);
        verify(!Theme.shellFlag("spacing.scale-with-font", true));
        compare(Theme.panelPadding, 20);

        const border = Theme.shellColor("popups.border", "#000000");
        compare(Math.round(border.r * 255), 255);
        compare(Math.round(border.g * 255), 136);
        compare(Math.round(border.b * 255), 0);
    }
}
