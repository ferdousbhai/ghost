import QtQuick
import QtTest
import "../qml/services/ExternalLinkPolicy.js" as Policy

TestCase {
    name: "ExternalLinkPolicy"

    function test_modelUrls_data() {
        return [
            { tag: "https", url: "https://example.com/docs?q=ghost#install", allowed: true },
            { tag: "mixed-case scheme", url: "HTTPS://例え.テスト/docs", allowed: true },
            { tag: "http", url: "http://localhost:3000/help", allowed: true },
            { tag: "mailto", url: "mailto:ghost@example.com?subject=Hello%20there", allowed: true },
            { tag: "file", url: "file:///home/user/.ssh/id_ed25519", allowed: false },
            { tag: "custom scheme", url: "ghost://open/settings", allowed: false },
            { tag: "javascript", url: "javascript:alert(1)", allowed: false },
            { tag: "leading dash", url: "--help", allowed: false },
            { tag: "relative", url: "//example.com/path", allowed: false },
            { tag: "leading whitespace", url: " https://example.com", allowed: false },
            { tag: "embedded control", url: "https://example.com/\nfile", allowed: false },
            { tag: "backslash confusion", url: "https:\\attacker.test", allowed: false },
            { tag: "userinfo", url: "https://trusted.test@attacker.test/", allowed: false },
            { tag: "encoded userinfo", url: "https://trusted.test%40attacker.test/", allowed: false },
            { tag: "scheme without web form", url: "https:javascript:alert(1)", allowed: false },
            { tag: "missing authority", url: "https:///attacker.test", allowed: false },
            { tag: "bad percent escape", url: "https://example.com/%zz", allowed: false },
            { tag: "empty mailto", url: "mailto:", allowed: false }
        ];
    }

    function test_modelUrls(data) {
        compare(Policy.isModelUrl(data.url), data.allowed);
    }

    function test_loginUrls_data() {
        return [
            { tag: "provider https", url: "https://auth.example.com/oauth?code=abc", allowed: true },
            { tag: "provider http", url: "http://auth.example.com/oauth", allowed: true },
            { tag: "mixed-case https", url: "HTTPS://AUTH.EXAMPLE/oauth", allowed: true },
            { tag: "mailto", url: "mailto:support@example.com", allowed: false },
            { tag: "file", url: "file:///tmp/callback", allowed: false },
            { tag: "userinfo", url: "https://auth.example.com@attacker.test", allowed: false },
            { tag: "scheme confusion", url: "https:\\attacker.test", allowed: false },
            { tag: "no scheme", url: "auth.example.com/oauth", allowed: false }
        ];
    }

    function test_loginUrls(data) {
        compare(Policy.isLoginUrl(data.url), data.allowed);
    }

    function test_localPaths_data() {
        return [
            { tag: "a directory", path: "/home/u/work/app", allowed: true },
            { tag: "a file", path: "/home/u/work/app/src/main.js", allowed: true },
            { tag: "spaces are ordinary in a name", path: "/home/u/My Notes/idea.md", allowed: true },
            { tag: "so is a percent", path: "/home/u/100%/report.md", allowed: true },
            { tag: "so is a backslash", path: "/home/u/a\\b", allowed: true },
            { tag: "relative", path: "work/app", allowed: false },
            { tag: "option-looking", path: "--help", allowed: false },
            { tag: "a URL is not a path", path: "https://example.com", allowed: false },
            { tag: "empty", path: "", allowed: false }
        ];
    }

    function test_localPaths(data) {
        compare(Policy.isLocalPath(data.path), data.allowed);
    }

    // Built rather than written: a literal control character in this file would
    // be invisible in review and easy to "tidy" away.
    function test_localPathRejectsControlCharacters() {
        compare(Policy.isLocalPath("/home/u/a" + String.fromCharCode(10) + "b"), false);
        compare(Policy.isLocalPath("/home/u/a" + String.fromCharCode(0) + "b"), false);
        compare(Policy.isLocalPath("/home/u/a" + String.fromCharCode(127) + "b"), false);
    }
}
