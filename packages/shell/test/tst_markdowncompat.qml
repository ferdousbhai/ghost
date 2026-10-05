import QtQuick
import QtTest
import "../qml/components/MarkdownCompat.js" as MarkdownCompat

// MarkdownCompat rewrites the emphasis Qt 6.11 stopped formatting into forms
// it still formats. Two halves are pinned: Qt's own behaviour (so the day it
// formats `_i_` again, this fails and the rewrite is deleted), and the
// rewrite's effect on what renders.
TestCase {
    id: tc
    name: "MarkdownCompat"
    when: windowShown
    width: 320
    height: 200
    visible: true

    TextEdit {
        id: ed
        width: 300
        textFormat: TextEdit.MarkdownText
        font.pixelSize: 14
    }

    /** The HTML body Qt builds for `markdown`, paragraphs unstyled. */
    function rendered(markdown) {
        ed.textFormat = TextEdit.MarkdownText;
        ed.text = markdown;
        ed.textFormat = TextEdit.RichText;
        return ed.text.replace(/[\s\S]*<body[^>]*>/, "").replace(/<\/body>[\s\S]*/, "")
            .replace(/<p style="[^"]*">/g, "<p>").replace(/\n/g, "").trim();
    }

    function test_qtDropsUnderscoreAndTildeEmphasis(): void {
        compare(tc.rendered("a _i_ b"), "<p>a i b</p>");
        compare(tc.rendered("__b__"), "<p>b</p>");
        compare(tc.rendered("~~s~~"), "<p>s</p>");
        compare(tc.rendered("a *i* b"), '<p>a <span style=" font-style:italic;">i</span> b</p>');
    }

    function test_rewrittenEmphasisRenders(): void {
        compare(tc.rendered(MarkdownCompat.normalize("a _i_ b")), '<p>a <span style=" font-style:italic;">i</span> b</p>');
        compare(tc.rendered(MarkdownCompat.normalize("__b__")), '<p><span style=" font-weight:700;">b</span></p>');
        compare(tc.rendered(MarkdownCompat.normalize("~~s~~")), '<p><span style=" text-decoration: line-through;">s</span></p>');
    }

    function test_rewrites(): void {
        compare(MarkdownCompat.normalize("_i_ and __b__"), "*i* and **b**");
        compare(MarkdownCompat.normalize("~~gone~~ and ~one~"), "<del>gone</del> and <del>one</del>");
        compare(MarkdownCompat.normalize("(_aside_)."), "(*aside*).");
        compare(MarkdownCompat.normalize("- _item_\n> _quote_"), "- *item*\n> *quote*");
        // CommonMark makes this strong, as GitHub renders it; code wants backticks.
        compare(MarkdownCompat.normalize("__init__.py"), "**init**.py");
    }

    function test_leavesWhatIsNotEmphasis(): void {
        const untouched = [
            "snake_case_name",
            "a_b_c",
            "\\_literal\\_",
            "_ spaced _",
            "about ~5 to ~10 minutes",
            "~/notes/a_b_.md",
            "plain text",
        ];
        for (const text of untouched) compare(MarkdownCompat.normalize(text), text);
    }

    function test_leavesCodeLinksAndUrls(): void {
        compare(MarkdownCompat.normalize("`_x_` and _y_"), "`_x_` and *y*");
        compare(MarkdownCompat.normalize("``a _b_ c`` _d_"), "``a _b_ c`` *d*");
        compare(MarkdownCompat.normalize("[_l_](https://e.com/_p_/) _x_", "#fff"), tc.a("https://e.com/_p_/", "<i>l</i>") + " *x*");
        compare(MarkdownCompat.normalize("<https://e.com/_p_> https://e.com/_q_", "#fff"),
            tc.a("https://e.com/_p_", "https://e.com/_p_") + " " + tc.a("https://e.com/_q_", "https://e.com/_q_"));
        compare(MarkdownCompat.normalize("![_i_](https://e.com/_p_.png)"), "![_i_](https://e.com/_p_.png)");
        compare(MarkdownCompat.normalize("<span title=\"_t_\">x</span>"), "<span title=\"_t_\">x</span>");
    }

    function test_leavesFencedCode(): void {
        const fenced = "_a_\n```py\nx = _y_\n~~z~~\n```\n_b_\n~~~\n_c_\n~~~\n_d_";
        compare(MarkdownCompat.normalize(fenced), "*a*\n```py\nx = _y_\n~~z~~\n```\n*b*\n~~~\n_c_\n~~~\n*d*");
    }

    function a(href, label): string {
        return '<a href="' + href + '" style="color:#fff; text-decoration:none">' + label + "</a>";
    }

    // Qt paints markdown links in the application palette's blue, whatever
    // linkColor says; an inline anchor keeps its own colour.
    function test_qtIgnoresLinkColorButHonoursAnchorStyle(): void {
        verify(tc.rendered("[l](https://e.com)").indexOf("#0000ff") >= 0);
        verify(tc.rendered(MarkdownCompat.normalize("[l](https://e.com)", "#fbbf24")).indexOf("#fbbf24") >= 0);
    }

    function test_linksBecomeColouredAnchors(): void {
        compare(MarkdownCompat.normalize("see [the **manual**](https://e.com/m?a=1&b=2).", "#fff"),
            "see " + tc.a("https://e.com/m?a=1&amp;b=2", "the <b>manual</b>") + ".");
        compare(MarkdownCompat.normalize("[`a<b>.ts`](file.ts \"t\")", "#fff"), tc.a("file.ts", "<code>a&lt;b&gt;.ts</code>"));
        compare(MarkdownCompat.normalize("(https://e.com/x).", "#fff"), "(" + tc.a("https://e.com/x", "https://e.com/x") + ").");
        compare(MarkdownCompat.normalize("`https://e.com` and `[l](u)`", "#fff"), "`https://e.com` and `[l](u)`");
        compare(MarkdownCompat.normalize("```\nhttps://e.com\n```", "#fff"), "```\nhttps://e.com\n```");
    }

    function test_unclosedFenceStaysCode(): void {
        compare(MarkdownCompat.normalize("```\n_x_"), "```\n_x_");
    }
}
