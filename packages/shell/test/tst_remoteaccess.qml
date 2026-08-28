import QtQuick
import QtTest
import qs.components
import qs.services

TestCase {
    id: tc
    name: "RemoteAccess"
    when: windowShown
    width: 800
    height: 700
    visible: true

    property var requests: []

    Component {
        id: panelComponent
        RemoteAccess {
            width: 700
            height: 600
            visible: true
        }
    }

    Component {
        id: navigationComponent
        GhostNavigation {
            width: 72
            height: 600
        }
    }

    function fakeRequest(): var {
        const xhr = {
            readyState: 0,
            status: 0,
            responseText: "",
            method: "",
            url: "",
            body: null,
            aborted: false,
            headers: ({}),
            onreadystatechange: null,
            open: function (method, url) {
                this.method = method;
                this.url = url;
                this.readyState = 1;
            },
            setRequestHeader: function (name, value) { this.headers[name] = value; },
            send: function (body) { this.body = body; },
            abort: function () {
                this.aborted = true;
                this.readyState = 4;
                this.status = 0;
                if (this.onreadystatechange) this.onreadystatechange();
            },
            complete: function (status, body) {
                this.status = status;
                this.responseText = typeof body === "string" ? body : JSON.stringify(body);
                this.readyState = 4;
                if (this.onreadystatechange) this.onreadystatechange();
            }
        };
        tc.requests.push(xhr);
        return xhr;
    }

    function status(overrides: var): var {
        return Object.assign({
            enabled: false,
            state: "off",
            scheme: "https",
            hostname: "omarchy-thinkpad.tail58bdd3.ts.net",
            url: null,
            tailscale: {
                installed: true,
                running: true,
                loggedIn: true,
                operator: true,
                certs: true
            },
            guests: "read-only",
            owner: "owner@example.com",
            problem: null
        }, overrides || {});
    }

    function init(): void {
        Ghostd.clearRemote();
        requests = [];
        Ghostd.remoteRequestFactory = function () { return tc.fakeRequest(); };
        Ghostd.apiToken = "test-token";
    }

    function cleanup(): void {
        Ghostd.clearRemote();
        Ghostd.remoteRequestFactory = null;
    }

    function test_offStateRendersSwitchOffAndNoQr(): void {
        const panel = createTemporaryObject(panelComponent, tc);
        verify(panel !== null);
        compare(requests.length, 1);
        requests[0].complete(200, status());

        const remoteSwitch = findChild(panel, "remoteSwitch");
        const statusText = findChild(panel, "remoteStatusText");
        const qr = findChild(panel, "remoteQrImage");
        verify(remoteSwitch !== null);
        verify(statusText !== null);
        verify(qr !== null);
        verify(!remoteSwitch.checked);
        compare(statusText.text, "Off");
        verify(!qr.visible);
        compare(String(qr.source), "");
    }

    function test_onStateRendersUrlAndAuthenticatedQrSource(): void {
        const panel = createTemporaryObject(panelComponent, tc);
        verify(panel !== null);
        requests[0].complete(200, status({
            enabled: true,
            state: "on",
            url: "https://omarchy-thinkpad.tail58bdd3.ts.net"
        }));
        compare(requests.length, 2);
        compare(requests[1].method, "GET");
        verify(requests[1].url.endsWith("/api/remote/qr.svg"));
        compare(requests[1].headers.Authorization, "Bearer test-token");
        requests[1].complete(200,
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>');

        const remoteSwitch = findChild(panel, "remoteSwitch");
        const statusText = findChild(panel, "remoteStatusText");
        const urlText = findChild(panel, "remoteUrlText");
        const qr = findChild(panel, "remoteQrImage");
        const audience = findChild(panel, "remoteAudienceText");
        verify(remoteSwitch.checked);
        compare(statusText.text,
            "On — https://omarchy-thinkpad.tail58bdd3.ts.net");
        compare(urlText.text, "https://omarchy-thinkpad.tail58bdd3.ts.net");
        verify(qr.visible);
        verify(String(qr.source).startsWith("data:image/svg+xml"));
        verify(audience.text.indexOf("owner@example.com") >= 0);
        verify(audience.text.indexOf("read-only") >= 0);
    }

    function test_eachProblemShowsMessageAndOptionalAction(): void {
        const problems = [
            ["tailscale_missing", "Tailscale is not installed.",
                "omarchy-install-service-tailscale"],
            ["tailscale_stopped", "Tailscale is installed but not running.", ""],
            ["not_logged_in", "This machine is not logged in to Tailscale.",
                "tailscale up"],
            ["operator_required", "Ghost needs permission to manage Tailscale Serve.",
                "sudo tailscale set --operator=$USER"],
            ["serve_failed", "tailscale serve failed: mock CLI error", ""],
            ["remote_unsupported", "This daemon does not support remote access", ""]
        ];
        const panel = createTemporaryObject(panelComponent, tc);
        verify(panel !== null);
        const statusText = findChild(panel, "remoteStatusText");
        const actionBlock = findChild(panel, "remoteProblemAction");
        const actionCommand = findChild(panel, "remoteActionCommand");
        verify(statusText !== null);
        verify(actionBlock !== null);
        verify(actionCommand !== null);

        for (const row of problems) {
            Ghostd.remoteStatus = status({
                state: "unavailable",
                problem: row[2] === ""
                    ? { code: row[0], message: row[1] }
                    : { code: row[0], message: row[1], action: row[2] }
            });
            wait(0);
            compare(statusText.text, row[1], row[0]);
            compare(actionBlock.visible, row[2] !== "", row[0]);
            compare(actionCommand.text, row[2], row[0]);
        }
    }

    function test_notSupportedPostBecomesProductStatus(): void {
        const panel = createTemporaryObject(panelComponent, tc);
        const remoteSwitch = findChild(panel, "remoteSwitch");
        remoteSwitch.activate();
        compare(requests.length, 2);
        requests[1].complete(409, {
            error: { code: "not_supported", message: "Old daemon" }
        });
        const statusText = findChild(panel, "remoteStatusText");
        compare(statusText.text, "This daemon does not support remote access");
        verify(!remoteSwitch.enabled);
        compare(Ghostd.remoteError, "");
    }

    function test_navigationKeepsPhoneAccessBesideRemote(): void {
        const navigation = createTemporaryObject(navigationComponent, tc);
        verify(navigation !== null);
        const connectIndex = navigation.destinations.findIndex(function (destination) {
            return destination.id === "connect";
        });
        const remoteIndex = navigation.destinations.findIndex(function (destination) {
            return destination.id === "remote";
        });
        compare(remoteIndex, connectIndex + 1);
        let selected = "";
        navigation.selected.connect(function (section) { selected = section; });
        navigation.activate(remoteIndex);
        compare(selected, "remote");
    }

    function test_switchPostsExactEnabledBody(): void {
        const panel = createTemporaryObject(panelComponent, tc);
        const remoteSwitch = findChild(panel, "remoteSwitch");
        verify(remoteSwitch !== null);
        remoteSwitch.activate();

        compare(requests.length, 2);
        verify(requests[0].aborted);
        compare(requests[1].method, "POST");
        verify(requests[1].url.endsWith("/api/remote"));
        compare(requests[1].headers["Content-Type"], "application/json");
        compare(requests[1].headers.Authorization, "Bearer test-token");
        compare(requests[1].body, '{"enabled":true}');
    }

    function test_successfulPostAppliesThenRefreshes(): void {
        const panel = createTemporaryObject(panelComponent, tc);
        const remoteSwitch = findChild(panel, "remoteSwitch");
        remoteSwitch.activate();
        requests[1].complete(200, status({
            enabled: true,
            state: "on",
            url: "https://omarchy-thinkpad.tail58bdd3.ts.net"
        }));

        tryCompare(requests, "length", 4);
        compare(requests[2].method, "GET");
        verify(requests[2].url.endsWith("/api/remote/qr.svg"));
        compare(requests[3].method, "GET");
        verify(requests[3].url.endsWith("/api/remote"));
        verify(remoteSwitch.checked);
    }

    function test_keyboardOperatesSwitch(): void {
        const panel = createTemporaryObject(panelComponent, tc);
        const remoteSwitch = findChild(panel, "remoteSwitch");
        verify(remoteSwitch !== null);
        remoteSwitch.forceActiveFocus();
        verify(remoteSwitch.activeFocus);
        keyClick(Qt.Key_Space);

        compare(requests.length, 2);
        compare(requests[1].method, "POST");
        compare(requests[1].body, '{"enabled":true}');
    }

    function test_escapeLeavesPanelFromSwitchFocus(): void {
        const panel = createTemporaryObject(panelComponent, tc);
        const remoteSwitch = findChild(panel, "remoteSwitch");
        let closes = 0;
        panel.closeRequested.connect(function () { closes += 1; });
        remoteSwitch.forceActiveFocus();
        keyClick(Qt.Key_Escape);
        compare(closes, 1);
    }
}
