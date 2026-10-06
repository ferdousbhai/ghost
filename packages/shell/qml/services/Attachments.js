.pragma library

// Attachments — how a message names the images sent with it.
//
// The daemon stores an image pasted or dropped in the HUD, or sent from the
// tailnet viewer, in the conversation directory and answers with its path
// relative to it, `attachments/<file>`. The message names each one on its own
// line as a Markdown image after the typed text, so the harness (whose working
// directory that is) can open it, and every client draws it as a picture.

// One path segment under attachments/, so a line never names a file outside
// the conversation directory.
const LINE = /^!\[[^\]]*\]\((attachments\/[^/\s)]+)\)$/u;

/** A message body as `{ text, images }`: the image lines lifted out, the rest kept verbatim. */
function split(body) {
    const kept = [];
    const images = [];
    for (const line of String(body || "").split("\n")) {
        const match = LINE.exec(line.trim());
        if (match) images.push(match[1]);
        else kept.push(line);
    }
    return { text: images.length > 0 ? kept.join("\n").replace(/\s+$/u, "") : String(body || ""), images: images };
}

/** The prompt to send: the typed text, then one image line per stored path. */
function compose(text, paths) {
    const lines = (paths || []).filter(isAttachmentPath).map(path => "![image](" + path + ")");
    const typed = String(text || "").trim();
    return (typed !== "" ? [typed] : []).concat(lines).join("\n");
}

/** Whether a dropped or pasted local file is an image the daemon accepts. */
function isImageFile(path) {
    return /\.(png|jpe?g|webp|gif)$/iu.test(String(path || ""));
}

/** Whether a path is one the daemon gave: one segment under attachments/. */
function isAttachmentPath(path) {
    return LINE.test("![image](" + String(path || "") + ")");
}
