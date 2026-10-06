.pragma library

// Attachments — how a message names the images sent with it.
//
// The daemon stores an attached image in the conversation directory and
// answers with its path relative to it, `attachments/<file>`. The message
// names each one on its own line as a Markdown image after the typed text, so
// the harness (whose working directory that is) can open it, and every client
// can draw it instead of printing the line.

const LINE = /^!\[[^\]]*\]\((attachments\/[^)\s]+)\)$/u;

/** True for a stored attachment path that stays inside its conversation directory. */
function isAttachmentPath(path) {
    return typeof path === "string" && /^attachments\/[^/\s)]+$/u.test(path)
        && path.indexOf("..") < 0;
}

/** A message body as `{ text, images }`: the image lines lifted out, the rest kept verbatim. */
function split(body) {
    const kept = [];
    const images = [];
    for (const line of String(body || "").split("\n")) {
        const match = LINE.exec(line.trim());
        if (match && isAttachmentPath(match[1])) images.push(match[1]);
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
