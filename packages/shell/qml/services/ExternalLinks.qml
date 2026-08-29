pragma Singleton

import Quickshell
import QtQuick
import "ExternalLinkPolicy.js" as Policy

Singleton {
    id: root

    function openModelUrl(url: string): bool {
        if (!Policy.isModelUrl(url)) {
            console.warn("ghost shell rejected an unsafe model-authored URL");
            return false;
        }
        // Allowed URLs begin with a scheme, so none can be parsed as an option
        // by xdg-open (which does not portably support a `--` separator).
        Quickshell.execDetached(["xdg-open", url]);
        return true;
    }

    function openLoginUrl(url: string): bool {
        if (!Policy.isLoginUrl(url)) {
            console.warn("ghost shell rejected an unsafe daemon login URL");
            return false;
        }
        Quickshell.execDetached(["xdg-open", url]);
        return true;
    }

    /**
     * Hand an absolute local path — a file or a directory — to whatever the
     * desktop has registered for it. Used by Workbench's editor fallback;
     * model-authored strings never reach here.
     */
    function openPath(path: string): bool {
        if (!Policy.isLocalPath(path)) {
            console.warn("ghost shell rejected an unopenable local path");
            return false;
        }
        Quickshell.execDetached(["xdg-open", path]);
        return true;
    }
}
