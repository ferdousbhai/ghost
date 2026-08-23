.pragma library

// This module owns the desktop-handler boundary, not browser URL semantics.
// It stays independent of Quickshell so tests can prove that only explicitly
// allowed schemes can reach xdg-open without launching a process.

var MAX_URL_LENGTH = 8192;

function isClean(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) return false;
    if (value.trim() !== value || /[\u0000-\u0020\u007f-\u009f\\]/u.test(value)) return false;

    for (var index = value.indexOf("%"); index !== -1; index = value.indexOf("%", index + 3)) {
        if (index + 2 >= value.length || !/^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
            return false;
        }
    }
    return true;
}

function schemeOf(value) {
    if (!isClean(value)) return "";
    var match = /^([a-z][a-z0-9+.-]*):/i.exec(value);
    return match === null ? "" : match[1].toLowerCase();
}

function hasSafeWebForm(value, scheme) {
    var prefix = scheme + "://";
    if (value.slice(0, prefix.length).toLowerCase() !== prefix) return false;

    var authorityEnd = value.length;
    for (var index = prefix.length; index < value.length; index += 1) {
        if (value[index] === "/" || value[index] === "?" || value[index] === "#") {
            authorityEnd = index;
            break;
        }
    }
    var authority = value.slice(prefix.length, authorityEnd);
    // Credentials are unnecessary here and make the visible host misleading.
    return authority !== "" && !/(?:@|%40)/i.test(authority);
}

/** Model-authored Markdown may open only web pages and email drafts. */
function isModelUrl(value) {
    var scheme = schemeOf(value);
    if (scheme === "http" || scheme === "https") return hasSafeWebForm(value, scheme);
    return scheme === "mailto" && value.length > "mailto:".length;
}

/** Daemon-issued OAuth/device links are web URLs, never arbitrary handlers. */
function isLoginUrl(value) {
    var scheme = schemeOf(value);
    return (scheme === "http" || scheme === "https") && hasSafeWebForm(value, scheme);
}
