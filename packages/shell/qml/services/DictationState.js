.pragma library

// Voxtype writes one word to $XDG_RUNTIME_DIR/voxtype/state whenever it
// changes. Anything else means the daemon is not there to talk to.

var states = ["idle", "recording", "transcribing"];

function parse(text) {
    var word = String(text === undefined || text === null ? "" : text).trim().toLowerCase();
    return states.indexOf(word) >= 0 ? word : "";
}

function label(state) {
    if (state === "recording") return "Listening… F9 or click to stop";
    if (state === "transcribing") return "Transcribing…";
    return "";
}
