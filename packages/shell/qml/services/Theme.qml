pragma Singleton
// Bound so the block-gap probe below can read the type scale off `root`.
pragma ComponentBehavior: Bound

// Theme — Omarchy's own design system, as Omarchy publishes it.
//
// Ghost is an Omarchy app, so it does not invent a parallel set of sizes,
// spacings and states. Omarchy 4 publishes the whole system and every stock
// surface is built from it; this file reads it and adds only the ghost's own
// identity colours and the handful of measurements Omarchy cannot publish
// because they belong to the renderer — what one character of the resolved face
// is worth, and what Qt leaves between two markdown blocks. Those are measured
// here, once, rather than guessed at each surface that needs them.
//
// Omarchy (>= 4.0 "Quattro") keeps the active theme as a *copy* at
// ~/.local/state/omarchy/current/theme/. Two files matter to us:
//
//   colors.toml   flat `key = "#rrggbb"` pairs + `mode = "dark"|"light"`
//   shell.toml    sectioned TOML carrying the design system itself:
//                 [bar] sizes/colours, [hyprland] the compositor's active
//                 border, [controls] the four-state chrome ladder, [spacing]
//                 a token scale, and [font] a type scale rooted at one base
//                 size. Its own template is
//                 /usr/share/omarchy/default/themed/shell.toml.tpl, which is
//                 where the default value of every commented-out key below
//                 comes from.
//
// Two things Omarchy states outside those files:
//
//   the font    fontconfig maps `monospace` to JetBrainsMono Nerd Font
//               system-wide (default/fontconfig/conf.avail/50-omarchy.conf),
//               so asking for "monospace" is how an Omarchy app gets the
//               Omarchy face. Naming the family here would pin it instead.
//   the corners shell.toml publishes no radius, and
//               default/hypr/looknfeel.lua sets `rounding = 0` for every
//               window but a popped one. Square is the Omarchy shape.
//
// Only the keys the theme author actually wrote are present in colors.toml —
// Omarchy derives the rest (color0..15, bg/fg aliases, bright_* mixes) in
// `omarchy-theme-color`. We deliberately do NOT shell out to that script on
// every read: the ~10 keys we need are the ones every stock theme writes, and
// a synchronous subprocess in a HUD open path is worse than a fallback.
//
// Theme switches: `omarchy-theme-set` does `rm -rf theme/ && mv next-theme/
// theme/`, which destroys any inotify watch on files *inside* that directory —
// Omarchy's own shell hits this and sets watchChanges: false. It then rewrites
// theme.name in place with `echo >`, so a watch on *that* file survives and
// gives us a reliable single-shot edge. We watch theme.name and re-read
// colors.toml when it fires.
//
// Everything degrades to the fallback palette and the template's own default
// numbers when Omarchy is absent, so these surfaces still run on a bare
// Hyprland or in a nested compositor.
import Quickshell
import Quickshell.Io
import QtQuick

Singleton {
    id: root

    readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state"))
        + "/omarchy/current"

    property var colors: ({})
    property var shell: ({})
    readonly property bool reducedMotion: {
        const value = String(Quickshell.env("GHOST_REDUCE_MOTION") || "").toLowerCase();
        return value === "1" || value === "true" || value === "yes";
    }

    // Tokyo Night, Omarchy's default theme. Chosen so a non-Omarchy machine
    // gets a coherent dark surface rather than Qt's default battleship grey.
    readonly property var fallback: ({
        "mode": "dark",
        "background": "#1a1b26",
        "dark_background": "#13141c",
        "darker_background": "#0e0e14",
        "lighter_background": "#24283b",
        "foreground": "#a9b1d6",
        "dark_foreground": "#565f89",
        "bright_foreground": "#c0caf5",
        "accent": "#7aa2f7",
        "selection": "#292e42",
        "muted": "#414868",
        "red": "#f7768e",
        "green": "#9ece6a",
        "yellow": "#e0af68",
        "magenta": "#ad8ee6"
    })

    function pick(key: string): string {
        const value = root.colors[key];
        return (value !== undefined && value !== "") ? value : root.fallback[key];
    }

    readonly property bool light: root.pick("mode") === "light"

    /**
     * One `section.key` from shell.toml, following the references Omarchy's own
     * template writes: `[popups] border = "hyprland.active-border"` names
     * another key rather than repeating its value. The hop count stops a theme
     * that points two keys at each other from hanging the HUD.
     */
    function shellValue(key: string): var {
        let value = root.shell[key];
        for (let hop = 0; hop < 4; hop++) {
            if (typeof value !== "string"
                || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/u.test(value)
                || root.shell[value] === undefined) break;
            value = root.shell[value];
        }
        return value;
    }

    function shellNumber(key: string, fallbackValue: real): real {
        const raw = root.shellValue(key);
        if (raw === undefined || raw === "") return fallbackValue;
        const value = Number(raw);
        return isFinite(value) ? value : fallbackValue;
    }

    function shellFlag(key: string, fallbackValue: bool): bool {
        const raw = root.shellValue(key);
        if (raw === undefined || raw === "") return fallbackValue;
        return raw === true || String(raw).toLowerCase() === "true";
    }

    /**
     * A colour from shell.toml. Two forms beyond plain `#rrggbb` appear in the
     * template: Hyprland's `rgba(rrggbbaa)` literal, and a gradient — two or
     * more colours plus an angle — where the first colour is the one a flat
     * surface can use.
     */
    function shellColor(key: string, fallbackValue: color): color {
        const raw = root.shellValue(key);
        if (typeof raw !== "string" || raw.trim() === "") return fallbackValue;
        const first = raw.trim().split(/\s+/u)[0];
        const hyprland = /^rgba?\(([0-9a-fA-F]{6}|[0-9a-fA-F]{8})\)$/u.exec(first);
        if (hyprland) {
            const digits = hyprland[1];
            return digits.length === 8
                ? Qt.rgba(parseInt(digits.slice(0, 2), 16) / 255,
                    parseInt(digits.slice(2, 4), 16) / 255,
                    parseInt(digits.slice(4, 6), 16) / 255,
                    parseInt(digits.slice(6, 8), 16) / 255)
                : Qt.color("#" + digits);
        }
        return /^#[0-9a-fA-F]{3,8}$/u.test(first) ? Qt.color(first) : fallbackValue;
    }

    /** A step along the line between two colours, opaque. */
    function blend(from: color, to: color, amount: real): color {
        return Qt.rgba(from.r + (to.r - from.r) * amount,
            from.g + (to.g - from.g) * amount,
            from.b + (to.b - from.b) * amount, 1);
    }

    // [font] — one base size and a scale derived from it. The ratios are the
    // template's own commented defaults at base-size 12; a theme that pins a
    // token in px wins over the ratio, exactly as the template describes.
    readonly property real fontBase: Math.max(1, root.shellNumber("font.base-size", 12))
    function fontSizeFor(token: string, ratio: real): int {
        return Math.max(1, Math.round(root.shellNumber("font." + token, root.fontBase * ratio)));
    }
    readonly property int fontSizeCaption: root.fontSizeFor("caption", 10 / 12)
    readonly property int fontSizeSmall: root.fontSizeFor("body-small", 11 / 12)
    readonly property int fontSize: root.fontSizeFor("body", 1)
    readonly property int fontSizeSubtitle: root.fontSizeFor("subtitle", 13 / 12)
    readonly property int fontSizeTitle: root.fontSizeFor("title", 14 / 12)
    readonly property int fontSizeHeading: root.fontSizeFor("heading", 16 / 12)
    readonly property int fontSizeDisplay: root.fontSizeFor("display", 24 / 12)

    // [spacing] — the same shape: a scale that optionally tracks the font base,
    // and per-token pins in absolute px that bypass it. Only the tokens with a
    // consumer are named; the rest of Omarchy's scale lands when a surface
    // wants it, rather than sitting here as vocabulary.
    readonly property real spacingScale: root.shellNumber("spacing.scale", 1)
        * (root.shellFlag("spacing.scale-with-font", true) ? root.fontBase / 12 : 1)
    function spaceFor(token: string, base: real): int {
        return Math.max(0, Math.round(root.shellNumber("spacing." + token, base * root.spacingScale)));
    }
    readonly property int spaceHuge: root.spaceFor("huge", 18)
    readonly property int controlGap: root.spaceFor("control-gap", 8)
    readonly property int controlPaddingX: root.spaceFor("control-padding-x", 10)
    readonly property int popupRowHeight: root.spaceFor("popup-row-height", 28)
    readonly property int panelPadding: root.spaceFor("panel-padding", 18)

    // [controls] — Omarchy publishes one chrome colour and one border colour
    // per state, and separates the states by alpha. Every fill below is
    // translucent for that reason: it is a tint of the surface under it, not a
    // colour of its own.
    function controlFill(state: string): color {
        const tint = root.shellColor("controls." + state + "-color",
            root.shellColor("controls.normal-color", root.foreground));
        return Qt.rgba(tint.r, tint.g, tint.b,
            root.shellNumber("controls." + state + "-fill-alpha", 0.04));
    }
    function controlBorder(state: string, alphaKey: string): color {
        const tint = root.shellColor("controls." + state + "-border",
            root.shellColor("controls.normal-border", root.foreground));
        return Qt.rgba(tint.r, tint.g, tint.b, root.shellNumber(alphaKey, 0.4));
    }

    // The canvas is the theme's own background, the same colour Omarchy gives
    // its bar and popups, so the HUD sits in the desktop rather than beside it.
    // Its two neighbours are the published steps either side: `dark_background`
    // recesses a well or a rail, `lighter_background` raises a card. Both modes
    // come out of the same three keys, so a light Omarchy theme needs no
    // second palette here.
    readonly property color background: root.pick("background")
    readonly property color surface: root.pick("lighter_background")
    /** The recessed step. The name predates the mapping; wells and rails use it. */
    readonly property color surfaceDeep: root.pick("dark_background")
    readonly property color foregroundBright: root.pick("bright_foreground")
    readonly property color foreground: root.pick("foreground")
    // Derived rather than taken from `dark_foreground`: that key is a theme's
    // decorative dim, free to sit at any contrast, and body copy that fades
    // into the background is the one failure this file has always guarded
    // against. Walking the text colour toward the canvas keeps the theme's hue
    // and a predictable ladder.
    readonly property color foregroundDim: root.blend(root.foreground, root.background, 0.35)
    readonly property color foregroundFaint: root.blend(root.foreground, root.background, 0.55)

    // Chrome states, straight from [controls]: one colour, four alphas.
    readonly property color hover: root.controlFill("hover-cursor")
    readonly property color selection: root.controlFill("selected")
    readonly property color border: root.controlBorder("normal", "controls.normal-border-alpha")
    /** The same border at the strongest alpha Omarchy publishes for it. */
    readonly property color borderStrong: root.controlBorder("selected",
        "controls.selected-border-alpha")

    // One inherited accent carries focus, selection, and the active state.
    readonly property color accent: root.pick("accent")
    readonly property color danger: root.pick("red")
    readonly property color ok: root.pick("green")
    readonly property color warn: root.pick("yellow")
    readonly property color onAccent: {
        const luma = root.accent.r * 0.299 + root.accent.g * 0.587 + root.accent.b * 0.114;
        return luma > 0.58 ? "#111111" : "#ffffff";
    }

    // The bar's cross-axis size is quoted at base-size 12 and grows with the
    // type scale when the theme says so.
    readonly property int barSize: Math.max(1, Math.round(
        root.shellNumber("bar.size-horizontal", 26)
        * (root.shellFlag("bar.scale-with-font", true) ? root.fontBase / 12 : 1)))
    readonly property color barBackground: root.shellColor("bar.background", root.background)
    readonly property color barForeground: root.shellColor("bar.text", root.foreground)

    // The summon-ghost identity, ported from the Cloudflare app: warm amber
    // for the ghost's presence, actions, and ownership; cold spectral
    // blue-white for machine thinking (the orb, ambient fog). Fixed brand
    // colour, not themed — it layers over whatever Omarchy provides.
    readonly property color ghostAmber: "#fbbf24"
    readonly property color ghostAmberBright: "#fcd34d"
    readonly property color ghostRose: "#fb7185"
    readonly property color spectral: "#c8dcff"

    function film(alpha: real): color {
        return root.light ? Qt.rgba(0, 0, 0, alpha * 0.8) : Qt.rgba(1, 1, 1, alpha);
    }
    function amber(alpha: real): color {
        return Qt.rgba(0.984, 0.749, 0.141, alpha);
    }
    function ember(alpha: real): color {
        return Qt.rgba(0.976, 0.451, 0.086, alpha);
    }
    function rose(alpha: real): color {
        return Qt.rgba(0.984, 0.443, 0.522, alpha);
    }

    // Deliberately dark in *both* Omarchy modes. A code view is editor chrome,
    // not a reading surface: VS Code, Xcode and Zed all keep a dark editor in a
    // light shell because a syntax palette tuned for contrast on dark ink turns
    // to mud on paper, and re-tuning six token colours per mode would be a
    // second palette to maintain. The surface is cooled toward the ghost canvas
    // so an open file reads as part of this app rather than an embedded IDE.
    readonly property color editorBackground: "#131720"
    readonly property color editorGutterBackground: "#0f131b"
    readonly property color editorGutterText: "#4d5666"
    readonly property color editorBorder: "#1d232e"
    readonly property color editorForeground: "#d3d8e0"
    readonly property color editorSelection: "#2a3a55"

    // The syntax palette: five roles, plus editorForeground for everything
    // else. Strings rather than colours because Highlighter.js interpolates
    // them straight into rich-text markup, where only a hex literal is valid.
    // VS Code Dark+ adjacent, pulled a step toward the ghost's warm chrome —
    // and no token is allowed to be brighter or more saturated than ghostAmber,
    // which has to stay the most present colour on screen.
    readonly property string synComment: "#5f8c69"
    readonly property string synString: "#d99a6c"
    readonly property string synNumber: "#b5cea8"
    readonly property string synKeyword: "#9d8cf5"
    readonly property string synFunction: "#d9c98a"

    // Omarchy publishes no radius in shell.toml and rounds nothing in
    // looknfeel.lua. Square is the shape; the tokens stay so a future Omarchy
    // radius has one place to land.
    readonly property int radius: 0
    readonly property int radiusLarge: 0
    readonly property int radiusTail: 0

    // The names the HUD already uses, pointed at their published equivalents.
    readonly property int pad: root.panelPadding
    readonly property int gap: root.controlGap
    readonly property int sectionGap: root.spaceHuge
    readonly property int controlHeight: root.spaceFor("control-height", 28)
    readonly property int compactControlHeight: root.popupRowHeight

    // omarchy.org moves everything on one 150ms ease-out; the longer two keep
    // their existing relation to it for the few surfaces that travel further.
    readonly property int durFast: 150
    readonly property int durMed: 300
    readonly property int durSlow: 500

    // "monospace" is not a fallback here: Omarchy's fontconfig binds it to
    // JetBrainsMono Nerd Font for every app on the machine, which is how an
    // Omarchy app asks for the Omarchy face without pinning a family. Off
    // Omarchy it resolves to whatever that machine calls monospace, which is
    // the right answer there too.
    readonly property string fontFamily: "monospace"
    readonly property string fontFamilyMono: root.fontFamily
    /** Proportional line height for reading copy; chrome labels stay at 1.0. */
    readonly property real lineHeight: 1.4

    // A monospace UI has one honest horizontal unit and it is not the pixel:
    // every glyph is one column wide, so a reading measure or a panel width is
    // a character count. omarchy.org sizes its own button gap in `ch` for the
    // same reason. Resolved through the real metrics of whatever face
    // fontconfig hands us, so a theme that raises `font.base-size` widens the
    // columns with it instead of clipping them.
    FontMetrics {
        id: bodyMetrics
        font.family: root.fontFamily
        font.pixelSize: root.fontSize
    }
    readonly property real charWidth: bodyMetrics.advanceWidth("0")
    function ch(count: real): int {
        return Math.round(count * root.charWidth);
    }

    /**
     * The widest a line of prose is allowed to get. Well past the 45–75 the
     * typographers argue over, because a reply is read in a window the owner
     * sized, not a page — this only ever catches the extreme, where a maximised
     * HUD would otherwise run a sentence past 130 columns.
     */
    readonly property int readingMeasure: root.ch(92)

    /**
     * The HUD's one list column — the roster stacked over the conversations,
     * and the delegated-task list that stands in the same relation to its
     * detail pane. Four columns wider than the 26 a name needs, because the
     * longest thing read down it is a conversation title and a title that wraps
     * costs a whole row of the list. The roster takes the same measure to stay
     * flush with the conversations under it, not because a ghost name needs it.
     */
    readonly property int sidebarMeasure: root.ch(30)

    /**
     * The space Qt's markdown renderer leaves between two blocks.
     *
     * A streaming reply is rendered one settled block at a time rather than as
     * one document (see components/MarkdownSegments.js), and separate documents
     * do not know about each other's margins — so the gap has to be put back
     * between them. Asked of the renderer rather than guessed: it is Qt's own
     * number, and it moves with the face and size the theme hands it.
     *
     * It is exact for prose, headings, lists and quotes, which is what a reply
     * is mostly made of. Fenced code, tables and rules carry margins of their
     * own that collapse against whatever they sit beside, so those sit a few
     * pixels off where one document would have put them. Reproducing that would
     * mean modelling Qt's margin collapsing, which is a lot of machinery for a
     * space no reader is measuring.
     */
    component BlockProbe: Text {
        visible: false
        // A width the probe never fills, because the two measurements only
        // agree on the margin when the text has a column to lay out in.
        width: 64
        wrapMode: Text.Wrap
        textFormat: Text.MarkdownText
        font.family: root.fontFamily
        font.pixelSize: root.fontSize
        lineHeight: root.lineHeight
    }
    BlockProbe { id: blockPair; text: "a\n\nb" }
    BlockProbe { id: blockFirst; text: "a" }
    BlockProbe { id: blockSecond; text: "b" }
    readonly property real markdownBlockGap: Math.max(0,
        blockPair.implicitHeight - blockFirst.implicitHeight - blockSecond.implicitHeight)

    // A deliberately small parser. Omarchy's theme files are generated from
    // templates and only ever contain `key = "value"`, `key = number`,
    // `key = true`, `# comment` and `[section]`. Anything fancier (arrays,
    // inline tables, multi-line strings) does not appear and is skipped rather
    // than mis-parsed.
    function parseToml(text: string, sectioned: bool): var {
        const out = {};
        let section = "";
        for (const rawLine of text.split("\n")) {
            const line = rawLine.trim();
            if (line === "" || line.startsWith("#")) continue;
            if (line.startsWith("[")) {
                section = sectioned ? line.replace(/^\[|\]$/gu, "").trim() + "." : "";
                continue;
            }
            const eq = line.indexOf("=");
            if (eq < 0) continue;
            const key = line.slice(0, eq).trim();
            let value = line.slice(eq + 1).trim();
            const quote = value.charAt(0);
            const close = quote === "\"" || quote === "'" ? value.indexOf(quote, 1) : -1;
            // A quoted value ends at its own closing quote, so a `#` inside it
            // is content rather than a comment. An unbalanced quote is not a
            // string at all: it stays verbatim rather than losing its last
            // character to a closing quote nobody wrote.
            value = close > 0 ? value.slice(1, close) : value.replace(/\s+#.*$/u, "");
            out[section + key] = value;
        }
        return out;
    }

    function reload(): void {
        colorsFile.reload();
        shellFile.reload();
        nameFile.reload();
    }

    FileView {
        id: colorsFile
        path: root.stateDir + "/theme/colors.toml"
        blockLoading: true
        printErrors: false
        onLoaded: root.colors = root.parseToml(colorsFile.text(), false)
        onLoadFailed: root.colors = ({})
    }

    FileView {
        id: shellFile
        path: root.stateDir + "/theme/shell.toml"
        blockLoading: true
        printErrors: false
        onLoaded: root.shell = root.parseToml(shellFile.text(), true)
        onLoadFailed: root.shell = ({})
    }

    // The one watchable file: rewritten in place on every theme switch, and
    // it survives the directory swap that kills watches inside theme/. Its
    // content is never read — only the change edge matters.
    FileView {
        id: nameFile
        path: root.stateDir + "/theme.name"
        blockLoading: true
        watchChanges: true
        printErrors: false
        onFileChanged: {
            nameFile.reload();
            // The directory swap has already happened by the time theme.name is
            // rewritten, so re-reading immediately is safe.
            colorsFile.reload();
            shellFile.reload();
        }
    }
}
