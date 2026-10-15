.pragma library

// Voxtype writes one word to $XDG_RUNTIME_DIR/voxtype/state whenever it
// changes. Anything else means the daemon is not there to talk to.

var states = ["idle", "recording", "transcribing"];

function parse(text) {
    var word = String(text === undefined || text === null ? "" : text).trim().toLowerCase();
    return states.indexOf(word) >= 0 ? word : "";
}

/** The `voxtype record` verb the mic button sends: never one while it transcribes. */
function micAction(state) {
    if (state === "idle") return "start";
    if (state === "recording") return "stop";
    return "";
}

function cancellable(state) {
    return state === "recording" || state === "transcribing";
}

function command(action) {
    return ["voxtype", "record", action];
}

/** Why a `voxtype record` command failed, or "" if it did not; exitCode < 0: it never started. */
function failure(action, exitCode, exitStatus) {
    if (exitCode < 0) return "Voxtype did not run";
    if (exitStatus !== 0) return "voxtype record " + action + " crashed";
    if (exitCode !== 0) return "voxtype record " + action + " failed (exit " + exitCode + ")";
    return "";
}

function label(state) {
    if (state === "recording") return "Listening… F9 or click to stop, Esc to cancel";
    if (state === "transcribing") return "Transcribing… Esc to cancel";
    return "";
}
