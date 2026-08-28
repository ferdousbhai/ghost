import QtQuick
import QtTest
import "../qml/components/Highlighter.js" as Highlighter

// The highlighter's one hard contract: it colours code without touching it.
// Everything CodeView shows goes through `highlight()` as rich text, so a lost
// space, a swallowed character or an unescaped "<" would silently misreport
// what is in the file — the failure mode a reading pane must not have. Each
// language test therefore strips the markup back off and compares against the
// input byte for byte, and only then checks that the colours landed in
// sensible places.
TestCase {
    id: tc
    name: "Highlighter"

    readonly property var palette: ({
        comment: "#5f8c69",
        string: "#d99a6c",
        number: "#b5cea8",
        keyword: "#9d8cf5",
        "function": "#d9c98a"
    })

    // <font color="#xxxxxx"> is the only tag we emit and it never contains a
    // ">", so tag-stripping is exact rather than a best effort.
    function plainOf(html) {
        return html.replace(/<[^>]*>/gu, "")
            .replace(/&lt;/gu, "<")
            .replace(/&gt;/gu, ">")
            .replace(/&amp;/gu, "&");
    }

    function coloured(html, colour, word) {
        return html.indexOf("<font color=\"" + colour + "\">" + word + "</font>") >= 0;
    }


    function test_escapesEntities(): void {
        compare(Highlighter.escapeHtml("a < b && c > d"), "a &lt; b &amp;&amp; c &gt; d");
        // Ampersand first, or the entities we just wrote get re-escaped.
        compare(Highlighter.escapeHtml("&lt;"), "&amp;lt;");
        compare(Highlighter.escapeHtml(""), "");
    }

    function test_markupCannotEscapeIntoAttribute(): void {
        // A palette value that is not a hex literal is dropped, not escaped,
        // so nothing can close the color attribute and inject a tag.
        const html = Highlighter.highlight("// hi\n", "a.js",
            { comment: "\" onload=\"x" });
        compare(html.indexOf("onload"), -1);
        compare(tc.plainOf(html), "// hi\n");
    }


    readonly property string jsSample:
        "// count things <fast>\n"
        + "import { thing } from \"./thing.js\";\n"
        + "\n"
        + "/* block\n   comment */\n"
        + "export function count(rows) {\n"
        + "    const label = `n=${rows.length} & rising`;\n"
        + "    let total = 0x1f + 2.5e3;\n"
        + "    if (total < 10 && label !== '') total += rows.length;\n"
        + "    return { total, label };\n"
        + "}\n"

    readonly property string pySample:
        "#!/usr/bin/env python3\n"
        + "\"\"\"Docstring with a < and an &.\"\"\"\n"
        + "\n"
        + "import os\n"
        + "\n"
        + "def summarise(rows, limit=25):\n"
        + "    # keep the first few\n"
        + "    label = 'rows & more'\n"
        + "    total = sum(len(r) for r in rows[:limit])\n"
        + "    if total > 0b1010:\n"
        + "        return f\"{total} rows\"\n"
        + "    return None\n"

    function test_roundTrip_data() {
        return [
            { tag: "js", path: "a.js", source: tc.jsSample },
            { tag: "ts", path: "a.ts", source: tc.jsSample },
            { tag: "py", path: "a.py", source: tc.pySample },
            { tag: "qml", path: "a.qml", source: "Item { property int n: 1 // x\n}\n" },
            { tag: "json", path: "a.json", source: "{\"a\": [1, true, null], \"b\": \"<x>\"}\n" },
            { tag: "sh", path: "a.sh", source: "#!/bin/sh\nset -eu\nfor f in *.md; do\n  echo \"$f\" # note\ndone\n" },
            { tag: "css", path: "a.css", source: "/* c */\n.a > .b { color: #ff8800; width: calc(10px * 2); }\n" },
            { tag: "html", path: "a.html", source: "<!-- c -->\n<div class=\"a\">x &amp; y</div>\n" },
            { tag: "yaml", path: "a.yml", source: "# c\nname: ghost\nitems:\n  - a: 1\n  - b: \"two\"\n" },
            { tag: "toml", path: "a.toml", source: "# c\n[bar]\nsize = 26\nname = \"x\"\n" },
            { tag: "rs", path: "a.rs", source: "// c\nfn main<'a>(x: &'a str) -> u32 { let c = 'z'; 1u32 }\n" },
            { tag: "go", path: "a.go", source: "// c\nfunc main() { s := `raw` ; _ = s }\n" },
            { tag: "c", path: "a.c", source: "#include <stdio.h>\nint main(void) { char c = '\\n'; return 0; }\n" },
            { tag: "java", path: "A.java", source: "// c\npublic class A { int n = 1; }\n" },
            { tag: "rb", path: "a.rb", source: "# c\ndef go(x)\n  puts \"a & b\"\nend\n" },
            { tag: "lua", path: "a.lua", source: "-- c\nlocal function f(x) return x + 1 end\n" },
            { tag: "sql", path: "a.sql", source: "-- c\nSELECT count(*) FROM t WHERE a < 3 AND b = 'x';\n" },
            { tag: "unknown", path: "a.wat", source: "anything <at> all & more\n" },
            { tag: "no extension", path: "/tmp/NOTICE", source: "plain & <text>\n" },
            { tag: "empty", path: "a.js", source: "" },
            { tag: "only whitespace", path: "a.py", source: "\n\n    \n\t\n" },
            { tag: "unterminated string", path: "a.js", source: "const a = \"oops\nconst b = 1;\n" },
            { tag: "unterminated comment", path: "a.js", source: "/* forever\nand ever\n" }
        ];
    }

    function test_roundTrip(data) {
        const html = Highlighter.highlight(data.source, data.path, tc.palette);
        compare(tc.plainOf(html), data.source);
    }

    function test_unknownLanguageIsNotColoured(): void {
        const html = Highlighter.highlight("a < b\n", "a.wat", tc.palette);
        compare(html, "a &lt; b\n");
    }


    function test_jsTokens(): void {
        const html = Highlighter.highlight(tc.jsSample, "a.js", tc.palette);
        verify(tc.coloured(html, tc.palette.comment, "// count things &lt;fast&gt;"));
        verify(tc.coloured(html, tc.palette.comment, "/* block\n   comment */"));
        verify(tc.coloured(html, tc.palette.string, "\"./thing.js\""));
        verify(tc.coloured(html, tc.palette.string, "`n=${rows.length} &amp; rising`"));
        verify(tc.coloured(html, tc.palette.keyword, "export"));
        verify(tc.coloured(html, tc.palette.keyword, "const"));
        verify(tc.coloured(html, tc.palette.number, "0x1f"));
        verify(tc.coloured(html, tc.palette.number, "2.5e3"));
        verify(tc.coloured(html, tc.palette["function"], "count"));
        // `if` is a keyword even though a "(" follows it.
        verify(tc.coloured(html, tc.palette.keyword, "if"));
        verify(!tc.coloured(html, tc.palette["function"], "if"));
    }

    function test_pyTokens(): void {
        const html = Highlighter.highlight(tc.pySample, "a.py", tc.palette);
        verify(tc.coloured(html, tc.palette.comment, "#!/usr/bin/env python3"));
        verify(tc.coloured(html, tc.palette.comment, "# keep the first few"));
        verify(tc.coloured(html, tc.palette.string,
            "\"\"\"Docstring with a &lt; and an &amp;.\"\"\""));
        verify(tc.coloured(html, tc.palette.string, "'rows &amp; more'"));
        verify(tc.coloured(html, tc.palette.keyword, "def"));
        verify(tc.coloured(html, tc.palette.keyword, "return"));
        verify(tc.coloured(html, tc.palette.keyword, "None"));
        verify(tc.coloured(html, tc.palette.number, "0b1010"));
        verify(tc.coloured(html, tc.palette["function"], "summarise"));
        verify(tc.coloured(html, tc.palette["function"], "sum"));
    }

    function test_languageEdges(): void {
        // A Rust lifetime is not an unterminated character literal.
        const rs = Highlighter.highlight("fn f<'a>(x: &'a str) { let c = 'q'; }\n",
            "a.rs", tc.palette);
        verify(tc.coloured(rs, tc.palette.string, "'q'"));
        verify(!tc.coloured(rs, tc.palette.string, "'a&gt;(x: &amp;'a"));

        // A shell "#" only opens a comment at a word boundary.
        const sh = Highlighter.highlight("echo ${#list} # real\n", "a.sh", tc.palette);
        verify(tc.coloured(sh, tc.palette.comment, "# real"));
        verify(!tc.coloured(sh, tc.palette.comment, "#list} # real"));

        // A CSS hex colour is a value, not a comment or an id selector.
        const css = Highlighter.highlight("a { color: #ff8800; }\n", "a.css", tc.palette);
        verify(tc.coloured(css, tc.palette.number, "#ff8800"));

        // Markup names the element, not the attribute value.
        const html = Highlighter.highlight("<div class=\"a\">x</div>\n", "a.html", tc.palette);
        verify(tc.coloured(html, tc.palette.keyword, "div"));
        verify(tc.coloured(html, tc.palette.string, "\"a\""));

        // YAML and TOML colour the key side of a line.
        const yaml = Highlighter.highlight("name: ghost\n", "a.yml", tc.palette);
        verify(tc.coloured(yaml, tc.palette["function"], "name"));
        const toml = Highlighter.highlight("[bar]\nsize = 26\n", "a.toml", tc.palette);
        verify(tc.coloured(toml, tc.palette.keyword, "[bar]"));
        verify(tc.coloured(toml, tc.palette["function"], "size"));

        // SQL keywords are case-insensitive.
        const sql = Highlighter.highlight("select 1 From t;\n", "a.sql", tc.palette);
        verify(tc.coloured(sql, tc.palette.keyword, "select"));
        verify(tc.coloured(sql, tc.palette.keyword, "From"));
    }


    function test_paths_data() {
        return [
            { tag: "js", path: "/home/a/b/main.js", lang: "js", md: false },
            { tag: "tsx", path: "/a/App.tsx", lang: "js", md: false },
            { tag: "qml", path: "/a/Bubble.qml", lang: "qml", md: false },
            { tag: "py", path: "/a/run.py", lang: "py", md: false },
            { tag: "yml", path: "/a/ci.yml", lang: "yaml", md: false },
            { tag: "uppercase", path: "/a/README.MD", lang: "", md: true },
            { tag: "markdown", path: "/a/notes.markdown", lang: "", md: true },
            { tag: "dotfile only", path: "/a/.gitignore", lang: "", md: false },
            { tag: "no extension", path: "/a/LICENSE", lang: "", md: false },
            { tag: "known filename", path: "/a/Dockerfile", lang: "sh", md: false },
            { tag: "unknown", path: "/a/thing.wat", lang: "", md: false },
            { tag: "dots in dir", path: "/a.js/thing", lang: "", md: false }
        ];
    }

    function test_paths(data) {
        compare(Highlighter.languageOf(data.path), data.lang);
        compare(Highlighter.isMarkdown(data.path), data.md);
    }

    function test_pathSplitting_data() {
        return [
            { tag: "nested", path: "/home/a/notes/todo.md", name: "todo.md", dir: "/home/a/notes" },
            { tag: "root", path: "/todo.md", name: "todo.md", dir: "/" },
            { tag: "bare", path: "todo.md", name: "todo.md", dir: "" },
            { tag: "trailing slash", path: "/home/a/notes/", name: "notes", dir: "/home/a" },
            { tag: "empty", path: "", name: "", dir: "" }
        ];
    }

    function test_pathSplitting(data) {
        compare(Highlighter.baseName(data.path), data.name);
        compare(Highlighter.parentPath(data.path), data.dir);
    }

    function test_fontFamilyIsValidated(): void {
        compare(Highlighter.safeFontFamily("JetBrains Mono", "monospace"), "JetBrains Mono");
        compare(Highlighter.safeFontFamily("", "monospace"), "monospace");
        // A themed font name is still a string from a file on disk.
        compare(Highlighter.safeFontFamily("a'; x:url(b)", "monospace"), "monospace");
    }
}
