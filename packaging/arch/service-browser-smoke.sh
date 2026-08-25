#!/usr/bin/env bash
set -euo pipefail

chromium_path="$(command -v chromium)"
bun_path="$(command -v bun)"
systemctl --user is-active --quiet graphical-session.target

runtime_dir="${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}"
daemon_dir="${GHOST_DAEMON_DIR:-/usr/lib/ghost/daemon}"
playwright_module="$(find "$daemon_dir/node_modules/.pnpm" \
  -path '*/playwright-core/index.mjs' -print -quit)"
[[ -f "$playwright_module" ]]
profile="$(mktemp -d -p "$runtime_dir" ghost-chromium-smoke.XXXXXX)"
cleanup() {
  find "$profile" -depth -delete
}
trap cleanup EXIT

systemd-run --user --wait --pipe --collect \
  --unit="ghost-chromium-smoke-$PPID-$$" \
  --setenv="GHOST_BROWSER_SMOKE_MODULE=$playwright_module" \
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
    const { chromium } = await import(process.env.GHOST_BROWSER_SMOKE_MODULE);
    const context = await chromium.launchPersistentContext(
      process.env.GHOST_BROWSER_SMOKE_PROFILE,
      {
        executablePath: process.env.GHOST_BROWSER_SMOKE_CHROMIUM,
        chromiumSandbox: true,
        headless: true,
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          "--password-store=basic",
          "--use-mock-keychain",
        ],
      },
    );
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto("about:blank");
    await context.close();
    console.log("Chromium sandbox service-context smoke test passed.");
  '
