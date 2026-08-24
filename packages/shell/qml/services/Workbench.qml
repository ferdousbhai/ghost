pragma Singleton

// Workbench — which file the HUD has open beside the chat.
//
// State only: the pane that renders it is qs.components/FilePane, and nothing
// here reads the disk. `filePath` is always absolute once set, so every
// consumer can treat it as a real path rather than re-deriving a base.
//
// Tool arguments are the main source of paths, and OMP hands the ghost a
// session cwd of the ghost home (CONTRACTS.md), so a relative argument is
// resolved against that home. When the home is unknown — no active ghost, or a
// roster that has not landed yet — a relative path resolves to "" and the
// caller is expected to offer nothing rather than guess a base.
import Quickshell
import QtQuick
import qs.services

Singleton {
    id: root

    /** Absolute path of the open file. "" means the workbench is closed. */
    property string filePath: ""

    /** Basename of `filePath`, for titles and click affordances. */
    readonly property string fileName: root.baseName(root.filePath)

    /** "markdown", "code", or "" when no pane here can render the file. */
    readonly property string kind: root.kindOf(root.filePath)

    /** The active ghost's home directory, or "" while it is unknown. */
    readonly property string home: {
        const ghost = Ghostd.activeGhost;
        if (ghost === "") return "";
        for (const row of (Ghostd.ghosts || [])) {
            if (row && row.name === ghost) return String(row.dir || "");
        }
        return "";
    }

    /**
     * Extensions the code view claims. Curated rather than "anything that is
     * not markdown": an unlisted extension reads as `kind === ""`, which is how
     * a caller knows not to offer the file at all.
     */
    readonly property var codeExtensions: [
        "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "qml", "json", "jsonc",
        "sh", "bash", "zsh", "fish", "css", "scss", "html", "htm", "yaml",
        "yml", "toml", "rs", "go", "c", "h", "cpp", "hpp", "cc", "java", "kt",
        "rb", "lua", "sql", "xml", "svg", "conf", "ini", "env", "txt", "log",
        "csv", "diff", "patch", "nix", "vim", "php", "pl", "swift", "gradle",
        "cmake", "make", "dockerfile", "gitignore", "qmldir"
    ]

    /**
     * Open `path` beside the chat. Absolute or ghost-home-relative. A path no
     * pane can render is ignored rather than opened blank, so `filePath` is
     * always something `kind` describes.
     */
    function open(path: string): void {
        if (!root.canOpen(path)) return;
        root.filePath = root.absolute(path);
    }

    /** Close the workbench; the chat takes the whole width back. */
    function close(): void {
        root.filePath = "";
    }

    /** True when `path` resolves to something a pane can actually render. */
    function canOpen(path: string): bool {
        const resolved = root.absolute(path);
        return resolved !== "" && root.kindOf(resolved) !== "";
    }

    /**
     * `path` as an absolute, dot-free path, or "" when it cannot be made one.
     * Accepts a file:// URL and a leading `~` because both reach us from
     * outside; anything else relative needs `home` to be known.
     */
    function absolute(path: string): string {
        let value = String(path || "").trim();
        if (value === "") return "";
        // A pseudo-path (conflict://N and friends) names no file on disk.
        if (value.indexOf("://") >= 0 && !value.startsWith("file://")) return "";
        if (value.startsWith("file://")) value = value.slice(7);
        if (value.startsWith("~/") || value === "~") {
            const userHome = Quickshell.env("HOME") || "";
            if (userHome === "") return "";
            value = userHome + value.slice(1);
        }
        if (!value.startsWith("/")) {
            const base = String(root.home || "").trim();
            if (base === "" || !base.startsWith("/")) return "";
            value = base + "/" + value;
        }
        const segments = [];
        for (const segment of value.split("/")) {
            if (segment === "" || segment === ".") continue;
            if (segment === "..") {
                segments.pop();
                continue;
            }
            segments.push(segment);
        }
        return segments.length === 0 ? "" : "/" + segments.join("/");
    }

    /** The last path segment of `path`, or "" when there is none. */
    function baseName(path: string): string {
        const value = String(path || "");
        const cut = value.lastIndexOf("/");
        return cut < 0 ? value : value.slice(cut + 1);
    }

    /** Which pane renders `path`: "markdown", "code", or "". */
    function kindOf(path: string): string {
        const name = root.baseName(path);
        const dot = name.lastIndexOf(".");
        // `dot > 0` and not `>= 0`: a dotfile is its own name, not an extension.
        const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
        if (ext === "md" || ext === "markdown") return "markdown";
        return root.codeExtensions.indexOf(ext) >= 0 ? "code" : "";
    }
}
