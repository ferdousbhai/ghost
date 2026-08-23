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
}
