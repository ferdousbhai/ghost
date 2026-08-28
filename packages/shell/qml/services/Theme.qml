pragma Singleton

// Theme — Ghost keeps Omarchy's accent and semantic colours, while its own
// reading surfaces use a quiet neutral foundation. This prevents a theme's
// decorative muted colour from becoming low-contrast body copy and gives the
// HUD a stable hierarchy across light and dark Omarchy themes.
//
// Omarchy (>= 4.0 "Quattro") keeps the active theme as a *copy* at
// ~/.local/state/omarchy/current/theme/. Two files matter to us:
//
//   colors.toml   flat `key = "#rrggbb"` pairs + `mode = "dark"|"light"`
//   shell.toml    sectioned TOML; [bar] gives us bar height/colors so a
//                 standalone ghost bar surface lines up with Omarchy's own
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
// Everything degrades to the fallback palette below when Omarchy is absent,
// so these surfaces still run on a bare Hyprland or in a nested compositor.
import Quickshell
import Quickshell.Io
import QtQuick

Singleton {
    id: root

    readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state"))
        + "/omarchy/current"

    property var colors: ({})
    property var shell: ({})
    property string themeName: ""
    readonly property bool themed: Object.keys(root.colors).length > 0
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

    // The summon-ghost canvas: a cool near-black (hue ~260) so the warm amber
    // brand has something cold to glow against. Light mode keeps a plain
    // neutral paper; the ghost identity reads through the amber tokens there.
    readonly property color background: root.light ? "#fafafa" : "#05070b"
    readonly property color surface: root.light ? "#ffffff" : "#0b0d12"
    readonly property color surfaceDeep: root.light ? "#f2f2f2" : "#11141b"
    readonly property color foregroundBright: root.light ? "#111111" : "#f8f8f8"
    readonly property color foreground: root.light ? "#383838" : "#c9ccd4"
    readonly property color foregroundDim: root.light ? "#666666" : "#8c8f95"
    readonly property color foregroundFaint: root.light ? "#858585" : "#6a6e76"

    // Chrome has its own ladder instead of borrowing a text colour.
    readonly property color hover: root.light ? "#eeeeee" : "#151920"
    readonly property color selection: root.light ? "#e5e5e5" : "#1c2029"
    readonly property color pressed: root.light ? "#dddddd" : "#232834"
    readonly property color border: root.light ? "#dedede" : "#1e222a"
    readonly property color borderStrong: root.light ? "#bdbdbd" : "#363c47"
    // Compatibility alias for host integrations; new UI code should choose a
    // text or border token explicitly.
    readonly property color muted: root.border

    // One inherited accent carries focus, selection, and the active state.
    readonly property color accent: root.pick("accent")
    readonly property color danger: root.pick("red")
    readonly property color ok: root.pick("green")
    readonly property color warn: root.pick("yellow")
    readonly property color thinking: root.pick("magenta")
    readonly property color onAccent: {
        const luma = root.accent.r * 0.299 + root.accent.g * 0.587 + root.accent.b * 0.114;
        return luma > 0.58 ? "#111111" : "#ffffff";
    }

    readonly property int barSize: Number(root.shell["bar.size-horizontal"]) || 26
    readonly property color barBackground: root.shell["bar.background"] || root.background
    readonly property color barForeground: root.shell["bar.text"] || root.foreground
    readonly property color barActive: root.shell["bar.active"] || root.accent

    // The summon-ghost identity, ported from the Cloudflare app: warm amber
    // for the ghost's presence, actions, and ownership; cold spectral
    // blue-white for machine thinking (the orb, ambient fog). Fixed brand
    // colour, not themed — it layers over whatever Omarchy provides.
    readonly property color ghostAmber: "#fbbf24"
    readonly property color ghostAmberBright: "#fcd34d"
    readonly property color ghostAmberDeep: "#f59e0b"
    readonly property color ghostEmber: "#f97316"
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

    // Not themed by Omarchy; kept here so every surface agrees on an 8px
    // rhythm and a readable native type scale.
    readonly property int radius: 8
    readonly property int radiusLarge: 16
    readonly property int radiusTail: 2
    readonly property int pad: 16
    readonly property int gap: 8
    readonly property int sectionGap: 24
    readonly property int controlHeight: 36
    readonly property int durFast: 200
    readonly property int durMed: 300
    readonly property int durSlow: 500
    readonly property string fontFamily: "sans-serif"
    readonly property string fontFamilyMono: root.shell["font.family"] || "monospace"
    readonly property int fontSize: Number(root.shell["font.body"]) || 14
    readonly property int fontSizeSmall: Number(root.shell["font.body-small"]) || 12
    /** Proportional line height for reading copy; chrome labels stay at 1.0. */
    readonly property real lineHeight: 1.35

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
            let value = line.slice(eq + 1).trim().replace(/\s+#.*$/u, "");
            if (/^["']/u.test(value)) value = value.slice(1, -1);
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
    // it survives the directory swap that kills watches inside theme/.
    FileView {
        id: nameFile
        path: root.stateDir + "/theme.name"
        blockLoading: true
        watchChanges: true
        printErrors: false
        onLoaded: root.themeName = nameFile.text().trim()
        onLoadFailed: root.themeName = ""
        onFileChanged: {
            nameFile.reload();
            // The directory swap has already happened by the time theme.name is
            // rewritten, so re-reading immediately is safe.
            colorsFile.reload();
            shellFile.reload();
        }
    }
}
