pragma Singleton

import QtQml

QtObject {
    function env(name: string): string {
        // Destination port 0 cannot have a listener. Keep singleton startup
        // deterministic without probing either the owner's daemon or another
        // process that happens to occupy a conventional test port.
        if (name === "GHOSTD_PORT") return "0";
        if (name === "HOME") return "/tmp/ghost-shell-test-home";
        if (name === "XDG_STATE_HOME") return "/tmp/ghost-shell-test-state";
        return "";
    }

    function execDetached(arguments: var): void {}
}
