#!/usr/bin/env bash
set -euo pipefail

chromium_path="$(command -v chromium)"
bun_path="$(command -v bun)"
systemctl --user is-active --quiet graphical-session.target
systemctl --user is-active --quiet ghostd.service

/usr/bin/ghost status --json | python -c '
import json
import sys

status = json.load(sys.stdin)
if status.get("reachable") is not True:
    raise SystemExit("ghost status did not report a reachable daemon")
'
printf 'Ghost terminal client reached the packaged daemon.\n'

runtime_dir="${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}"
profile="$(mktemp -d -p "$runtime_dir" ghost-chromium-smoke.XXXXXX)"
cleanup() {
  find "$profile" -depth -delete
}
trap cleanup EXIT

# systemd-run expands dollar expressions in argv, so the embedded JavaScript
# deliberately avoids template literals.
systemd-run --user --wait --pipe --collect \
  --unit="ghost-chromium-smoke-$PPID-$$" \
  --setenv="GHOST_BROWSER_SMOKE_PROFILE=$profile/browser" \
  --setenv="GHOST_BROWSER_SMOKE_CHROMIUM=$chromium_path" \
  --property=Type=exec \
  --property=PrivateTmp=yes \
  --property=NoNewPrivileges=yes \
  --property=ProtectSystem=strict \
  --property=ProtectKernelTunables=yes \
  --property=ProtectKernelModules=yes \
  --property=ProtectControlGroups=yes \
  --property=RestrictSUIDSGID=yes \
  --property=LockPersonality=yes \
  --property=MemoryDenyWriteExecute=no \
  --property="ReadWritePaths=$HOME" \
  --property="ReadWritePaths=$runtime_dir" \
  --property=UMask=0077 \
  "$bun_path" --eval '
    import { existsSync, readFileSync } from "node:fs";
    import { join } from "node:path";

    const profile = process.env.GHOST_BROWSER_SMOKE_PROFILE;
    const browser = Bun.spawn({
      cmd: [
        process.env.GHOST_BROWSER_SMOKE_CHROMIUM,
        "--headless=new",
        "--disable-gpu",
        "--remote-debugging-port=0",
        "--user-data-dir=" + profile,
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        "--use-mock-keychain",
        "about:blank",
      ],
      stdout: "ignore",
      stderr: "inherit",
    });

    try {
      const portFile = join(profile, "DevToolsActivePort");
      let endpoint;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (browser.exitCode !== null)
          throw new Error(
            "Chromium exited before CDP was ready (" + browser.exitCode + ")",
          );
        if (existsSync(portFile)) {
          const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
          if (/^[0-9]+$/.test(port) && path?.startsWith("/devtools/browser/")) {
            endpoint = "ws://127.0.0.1:" + port + path;
            break;
          }
        }
        await Bun.sleep(100);
      }
      if (endpoint === undefined)
        throw new Error("Chromium CDP endpoint did not become ready");
    } finally {
      if (browser.exitCode === null) browser.kill("SIGTERM");
      const exitCode = await Promise.race([
        browser.exited,
        Bun.sleep(3000).then(() => null),
      ]);
      if (exitCode === null) {
        browser.kill("SIGKILL");
        await browser.exited;
      }
    }
    console.log("Chromium sandbox service-context smoke test passed.");
  '
