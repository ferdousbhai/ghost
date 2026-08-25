pragma Singleton

import QtQml

QtObject {
    function env(name: string): string {
        if (name === "GHOSTD_PORT") return "17717";
        if (name === "HOME") return "/tmp/ghost-shell-test-home";
        if (name === "XDG_STATE_HOME") return "/tmp/ghost-shell-test-state";
        return "";
    }

    function execDetached(arguments: var): void {}
}
