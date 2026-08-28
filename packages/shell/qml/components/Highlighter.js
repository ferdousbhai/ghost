.pragma library

// A hand-rolled syntax highlighter: source text in, Qt rich text out.
//
// QML gives no access to a QSyntaxHighlighter or to QTextDocument's format
// runs, so the only way to colour code in a Quickshell surface is to build the
// markup ourselves and hand it to a RichText Text/TextEdit. CodeView wraps this
// output in a <pre> block; everything below emits inline <font color> spans and
// nothing else, so a caller can strip the tags and get its input back verbatim.
// That property is pinned in test/tst_highlighter.qml and is the reason every
// character is emitted by slicing the source rather than by rebuilding it: no
// branch here can drop, reorder, or normalise a byte.
//
// One scanner drives every language; a language is a table (comment markers,
// string forms, keyword set, a couple of flags), not a hand-written parser. The
// scanner is single-pass and context-free beyond "am I inside a string or a
// comment", which is the level a reading pane needs. Known imprecision, all of
// it cosmetic:
//
//   - JS/TS regex literals are not recognised; /foo/ renders as plain text.
//   - A template literal is one string; ${...} interpolation is not re-scanned.
//   - Shell/Ruby/Perl-style interpolation and heredocs are not tracked.
//   - CSS colours the property side of a declaration only when it is an
//     at-rule; ordinary properties stay plain.
//
// Six colours, no more: five token roles plus the editor's default foreground.
// The palette is passed in from Theme rather than baked in here.

const PLAIN = "plain";
const COMMENT = "comment";
const STRING = "string";
const NUMBER = "number";
const KEYWORD = "keyword";
const FUNCTION = "function";

function words(list) {
    const set = {};
    for (const word of list.split(" ")) {
        if (word !== "") set[word] = true;
    }
    return set;
}


const JS_WORDS =
    "as async await break case catch class const constructor continue debugger "
    + "default delete do else enum export extends false finally for from function "
    + "get if implements import in instanceof interface let new null of package "
    + "private protected public readonly return satisfies set static super switch "
    + "this throw true try type typeof undefined var void while with yield keyof "
    + "infer declare namespace abstract asserts override accessor using";

const QML_WORDS = JS_WORDS
    + " property signal alias component pragma on required list bool int real "
    + "string color date url point rect size font vector2d vector3d";

const PY_WORDS =
    "and as assert async await break case class continue def del elif else except "
    + "False finally for from global if import in is lambda match None nonlocal not "
    + "or pass raise return self True try while with yield";

const SH_WORDS =
    "if then else elif fi for while until do done case esac function in select "
    + "return break continue local export readonly declare typeset unset shift "
    + "source eval exec trap set echo printf cd true false";

const RS_WORDS =
    "as async await break const continue crate dyn else enum extern false fn for "
    + "if impl in let loop match mod move mut pub ref return self Self static "
    + "struct super trait true type unsafe use where while box macro_rules";

const GO_WORDS =
    "break case chan const continue default defer else fallthrough for func go "
    + "goto if import interface map package range return select struct switch type "
    + "var true false nil iota make new len cap append copy delete panic recover";

const C_WORDS =
    "auto break case char const constexpr continue default do double else enum "
    + "extern float for goto if inline int long register restrict return short "
    + "signed sizeof static struct switch typedef union unsigned void volatile "
    + "while bool true false nullptr class namespace template typename public "
    + "private protected virtual override final new delete this using friend "
    + "operator noexcept static_cast dynamic_cast const_cast reinterpret_cast try "
    + "catch throw explicit mutable";

const JAVA_WORDS =
    "abstract assert boolean break byte case catch char class const continue "
    + "default do double else enum extends final finally float for goto if "
    + "implements import instanceof int interface long native new null package "
    + "private protected public return short static strictfp super switch "
    + "synchronized this throw throws transient true false try var void volatile "
    + "while record sealed permits yield";

const RB_WORDS =
    "alias and begin break case class def do else elsif end ensure false for if "
    + "in module next nil not or redo rescue retry return self super then true "
    + "undef unless until when while yield require require_relative attr_accessor "
    + "attr_reader attr_writer lambda proc";

const LUA_WORDS =
    "and break do else elseif end false for function goto if in local nil not or "
    + "repeat return then true until while self";

const SQL_WORDS =
    "select from where insert into values update set delete create table drop "
    + "alter add column primary key foreign references index view join inner left "
    + "right outer full cross on group by order having limit offset union all "
    + "distinct as and or not null is in between like exists case when then else "
    + "end asc desc count sum avg min max cast coalesce default constraint unique "
    + "check begin commit rollback transaction with returning";


const DQ = { open: "\"", close: "\"", escape: true, multiline: false };
const SQ = { open: "'", close: "'", escape: true, multiline: false };
const BACKTICK = { open: "`", close: "`", escape: true, multiline: true };
const PY_TRIPLE_D = { open: "\"\"\"", close: "\"\"\"", escape: true, multiline: true };
const PY_TRIPLE_S = { open: "'''", close: "'''", escape: true, multiline: true };

//
// line       line-comment openers
// block      [opener, closer] pairs
// strings    string forms, longest opener first
// keywords   word set; `foldCase` matches them case-insensitively (SQL)
// calls      an identifier directly before "(" is a call
// charLit    'c' / '\n' is a character literal, a bare ' is not a string (Rust
//            lifetimes, C++ digit separators)
// markup     <tag ...> element names colour as keywords
// lineKeys   a `key:` / `key =` at the head of a line colours as a call
// wordChars  extra characters that belong to an identifier (CSS hyphens)
// hashColor  #rrggbb is a number (CSS)
// hashBoundary  a # only opens a comment at a word boundary (shell, YAML)

const LANGUAGES = {
    js: {
        line: ["//"], block: [["/*", "*/"]],
        strings: [DQ, SQ, BACKTICK], keywords: words(JS_WORDS), calls: true
    },
    qml: {
        line: ["//"], block: [["/*", "*/"]],
        strings: [DQ, SQ, BACKTICK], keywords: words(QML_WORDS), calls: true
    },
    json: {
        line: [], block: [],
        strings: [DQ], keywords: words("true false null"), calls: false
    },
    py: {
        line: ["#"], block: [],
        strings: [PY_TRIPLE_D, PY_TRIPLE_S, DQ, SQ],
        keywords: words(PY_WORDS), calls: true
    },
    sh: {
        line: ["#"], block: [],
        strings: [DQ, { open: "'", close: "'", escape: false, multiline: false }],
        keywords: words(SH_WORDS), calls: false, hashBoundary: true
    },
    css: {
        line: ["//"], block: [["/*", "*/"]],
        strings: [DQ, SQ],
        keywords: words("important media import charset namespace supports "
            + "keyframes font-face page layer container from to and not only "
            + "inherit initial unset revert none auto"),
        calls: true, wordChars: "-", hashColor: true
    },
    html: {
        line: [], block: [["<!--", "-->"]],
        strings: [DQ, SQ], keywords: {}, calls: false, markup: true
    },
    yaml: {
        line: ["#"], block: [],
        strings: [DQ, SQ],
        keywords: words("true false null yes no on off ~"),
        calls: false, lineKeys: ":", hashBoundary: true
    },
    toml: {
        line: ["#"], block: [],
        strings: [PY_TRIPLE_D, DQ, SQ],
        keywords: words("true false"), calls: false, lineKeys: "=",
        sections: true, hashBoundary: true
    },
    rs: {
        line: ["//"], block: [["/*", "*/"]],
        strings: [DQ], keywords: words(RS_WORDS), calls: true, charLit: true
    },
    go: {
        line: ["//"], block: [["/*", "*/"]],
        strings: [DQ, BACKTICK], keywords: words(GO_WORDS), calls: true,
        charLit: true
    },
    c: {
        line: ["//"], block: [["/*", "*/"]],
        strings: [DQ], keywords: words(C_WORDS), calls: true, charLit: true
    },
    java: {
        line: ["//"], block: [["/*", "*/"]],
        strings: [DQ], keywords: words(JAVA_WORDS), calls: true, charLit: true
    },
    rb: {
        line: ["#"], block: [["=begin", "=end"]],
        strings: [DQ, SQ], keywords: words(RB_WORDS), calls: true
    },
    lua: {
        line: ["--"], block: [["--[[", "]]"]],
        strings: [DQ, SQ], keywords: words(LUA_WORDS), calls: true
    },
    sql: {
        line: ["--"], block: [["/*", "*/"]],
        strings: [SQ, DQ], keywords: words(SQL_WORDS), calls: true, foldCase: true
    }
};

const EXTENSIONS = {
    js: "js", mjs: "js", cjs: "js", jsx: "js",
    ts: "js", mts: "js", cts: "js", tsx: "js",
    qml: "qml",
    json: "json", jsonc: "json",
    py: "py", pyi: "py",
    sh: "sh", bash: "sh", zsh: "sh", fish: "sh", ksh: "sh",
    css: "css", scss: "css", less: "css",
    html: "html", htm: "html", xml: "html", svg: "html", xhtml: "html", vue: "html",
    yaml: "yaml", yml: "yaml",
    toml: "toml",
    rs: "rs",
    go: "go",
    c: "c", h: "c", cc: "c", cpp: "c", cxx: "c", hpp: "c", hh: "c", hxx: "c", m: "c",
    java: "java", kt: "java", kts: "java",
    rb: "rb", rake: "rb", gemspec: "rb",
    lua: "lua",
    sql: "sql"
};

// Extension-less files that are unambiguous enough to name by hand.
const FILENAMES = {
    dockerfile: "sh", makefile: "sh", ".bashrc": "sh", ".zshrc": "sh",
    ".profile": "sh", ".env": "sh", gemfile: "rb", rakefile: "rb"
};

const MARKDOWN = { md: true, markdown: true, mdown: true, mkd: true };


function baseName(path) {
    const clean = String(path || "").replace(/[\\/]+$/u, "");
    const cut = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
    return cut < 0 ? clean : clean.slice(cut + 1);
}

function parentPath(path) {
    const clean = String(path || "").replace(/[\\/]+$/u, "");
    const cut = clean.lastIndexOf("/");
    if (cut < 0) return "";
    return cut === 0 ? "/" : clean.slice(0, cut);
}

function extensionOf(path) {
    const name = baseName(path);
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return "";
    return name.slice(dot + 1).toLowerCase();
}

function isMarkdown(path) {
    return MARKDOWN[extensionOf(path)] === true;
}

function languageOf(path) {
    const ext = extensionOf(path);
    if (EXTENSIONS[ext]) return EXTENSIONS[ext];
    const name = baseName(path).toLowerCase();
    return FILENAMES[name] || "";
}

function languageLabel(path) {
    const ext = extensionOf(path);
    return ext === "" ? "text" : ext;
}


// Ampersands first: escaping < or > before & would double-escape the entities
// we just introduced.
function escapeHtml(text) {
    return String(text)
        .replace(/&/gu, "&amp;")
        .replace(/</gu, "&lt;")
        .replace(/>/gu, "&gt;");
}


const IDENT_START = /[A-Za-z_$]/u;
const IDENT_BODY = /[A-Za-z0-9_$]/u;
const NUMBER_AT = /^(?:0[xXoObB][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eEpP][+-]?\d+)?|\.\d[\d_]*)(?:[a-zA-Z%]\w*)?/u;
const HASH_COLOR_AT = /^#[0-9a-fA-F]{3,8}\b/u;
const KEY_AT = /^([ \t]*(?:-[ \t]+)?)([A-Za-z_][\w.\- ]*?)[ \t]*(?=[:=])/u;
const SECTION_AT = /^[ \t]*\[[^\]\n]*\]/u;

function isWordChar(ch, spec) {
    if (ch === "") return false;
    if (IDENT_BODY.test(ch)) return true;
    return Boolean(spec.wordChars) && spec.wordChars.indexOf(ch) >= 0;
}

/**
 * Split `src` into {type, text} runs. Concatenating every `text` in order
 * reproduces `src` exactly — the scanner only ever slices, never rewrites.
 */
function tokenize(src, spec) {
    const out = [];
    const length = src.length;
    let index = 0;
    let plainStart = 0;

    function flushPlain(end) {
        if (end > plainStart) out.push({ type: PLAIN, text: src.slice(plainStart, end) });
    }

    function emit(type, start, end) {
        flushPlain(start);
        out.push({ type: type, text: src.slice(start, end) });
        plainStart = end;
        index = end;
    }

    function lineEnd(from) {
        const nl = src.indexOf("\n", from);
        return nl < 0 ? length : nl;
    }

    // A quoted run, honouring backslash escapes when the form has them. An
    // unterminated single-line string stops at the newline so one stray quote
    // cannot paint the rest of the file.
    function scanString(form) {
        const bodyStart = index + form.open.length;
        const limit = form.multiline ? length : lineEnd(bodyStart);
        let at = bodyStart;
        while (at < limit) {
            const ch = src.charAt(at);
            if (form.escape && ch === "\\") {
                at += 2;
                continue;
            }
            if (src.startsWith(form.close, at)) {
                emit(STRING, index, at + form.close.length);
                return;
            }
            at += 1;
        }
        emit(STRING, index, Math.min(limit, length));
    }

    while (index < length) {
        const ch = src.charAt(index);
        const atLineStart = index === 0 || src.charAt(index - 1) === "\n";

        // Line-leading structure: [section] headers and `key:` / `key =` pairs.
        if (atLineStart && (spec.sections || spec.lineKeys)) {
            const rest = src.slice(index, lineEnd(index));
            if (spec.sections) {
                const section = SECTION_AT.exec(rest);
                if (section) {
                    emit(KEYWORD, index, index + section[0].length);
                    continue;
                }
            }
            if (spec.lineKeys) {
                const key = KEY_AT.exec(rest);
                if (key && src.charAt(index + key[0].length) === spec.lineKeys) {
                    const start = index + key[1].length;
                    emit(FUNCTION, start, start + key[2].length);
                    continue;
                }
            }
        }

        // Comments before everything else: their contents are never code.
        let consumed = false;
        for (const pair of spec.block) {
            if (!src.startsWith(pair[0], index)) continue;
            const close = src.indexOf(pair[1], index + pair[0].length);
            emit(COMMENT, index, close < 0 ? length : close + pair[1].length);
            consumed = true;
            break;
        }
        if (consumed) continue;

        for (const opener of spec.line) {
            if (!src.startsWith(opener, index)) continue;
            // In shell and YAML a # only starts a comment at a word boundary,
            // so $#, url#fragment and colour literals survive.
            if (spec.hashBoundary && opener === "#" && index > 0
                && /[^\s;|&(]/u.test(src.charAt(index - 1))) continue;
            emit(COMMENT, index, lineEnd(index));
            consumed = true;
            break;
        }
        if (consumed) continue;

        // A char literal is only a literal when it closes on the same line and
        // holds one character; otherwise ' is punctuation (a Rust lifetime).
        if (spec.charLit && ch === "'") {
            const literal = /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^'\\])'/u
                .exec(src.slice(index, index + 12));
            if (literal) {
                emit(STRING, index, index + literal[0].length);
                continue;
            }
            index += 1;
            continue;
        }

        for (const form of spec.strings) {
            if (!src.startsWith(form.open, index)) continue;
            if (spec.charLit && form.open === "'") continue;
            scanString(form);
            consumed = true;
            break;
        }
        if (consumed) continue;

        // <tag and </tag: the element name reads as the keyword of a markup
        // language, attributes and text stay plain.
        if (spec.markup && ch === "<") {
            const tag = /^<[/!?]?([A-Za-z_][\w:.-]*)/u.exec(src.slice(index, index + 64));
            if (tag) {
                const nameStart = index + tag[0].length - tag[1].length;
                emit(KEYWORD, nameStart, nameStart + tag[1].length);
                continue;
            }
        }

        if (spec.hashColor && ch === "#") {
            const colour = HASH_COLOR_AT.exec(src.slice(index, index + 10));
            if (colour) {
                emit(NUMBER, index, index + colour[0].length);
                continue;
            }
        }

        if (IDENT_START.test(ch) || (spec.wordChars && spec.wordChars.indexOf(ch) >= 0)) {
            let end = index + 1;
            while (end < length && isWordChar(src.charAt(end), spec)) end += 1;
            const word = src.slice(index, end);
            const lookup = spec.foldCase ? word.toLowerCase() : word;
            if (spec.keywords[lookup] === true) {
                emit(KEYWORD, index, end);
                continue;
            }
            if (spec.calls) {
                let after = end;
                while (after < length && /[ \t]/u.test(src.charAt(after))) after += 1;
                if (src.charAt(after) === "(") {
                    emit(FUNCTION, index, end);
                    continue;
                }
            }
            index = end;
            continue;
        }

        if (/[0-9]/u.test(ch) || (ch === "." && /[0-9]/u.test(src.charAt(index + 1)))) {
            const number = NUMBER_AT.exec(src.slice(index, index + 40));
            if (number) {
                emit(NUMBER, index, index + number[0].length);
                continue;
            }
        }

        index += 1;
    }

    flushPlain(length);
    return out;
}


/**
 * Rich-text markup for `source`, coloured for the language of `path`.
 *
 * `palette` carries the five token colours ({comment, string, number, keyword,
 * function}); plain text is left uncoloured so it inherits the view's own
 * foreground. An unknown language returns the escaped source and nothing else.
 * The caller supplies the <pre> wrapper that preserves whitespace.
 */
function highlight(source, path, palette) {
    const text = String(source === undefined || source === null ? "" : source);
    const spec = LANGUAGES[languageOf(path)];
    if (!spec) return escapeHtml(text);

    const parts = [];
    for (const token of tokenize(text, spec)) {
        const colour = token.type === PLAIN ? "" : hexColour(palette[token.type]);
        if (colour === "") parts.push(escapeHtml(token.text));
        else parts.push("<font color=\"" + colour + "\">"
            + escapeHtml(token.text) + "</font>");
    }
    return parts.join("");
}

// Everything we interpolate into an HTML *attribute* is validated rather than
// escaped: a colour that is not a hex literal is dropped, so no palette value
// can close the attribute and inject markup.
function hexColour(value) {
    const text = String(value === undefined || value === null ? "" : value);
    return /^#[0-9a-fA-F]{3,8}$/u.test(text) ? text : "";
}

function safeFontFamily(value, fallback) {
    const text = String(value === undefined || value === null ? "" : value).trim();
    return /^[A-Za-z0-9 _.-]{1,64}$/u.test(text) ? text : fallback;
}
