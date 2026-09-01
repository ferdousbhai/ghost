import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../../qml/tray/ghost-tray.py", import.meta.url));

const ready = spawnSync("python3", [helper, "--check"], { encoding: "utf8" });
assert.equal(ready.status, 0, ready.stderr);
assert.deepEqual(JSON.parse(ready.stdout), { ok: true });

const missing = spawnSync("python3", ["-S", helper, "--check"], { encoding: "utf8" });
assert.equal(missing.status, 78);
assert.match(missing.stderr, /^ghost-tray-error:/u);
const diagnostic = JSON.parse(missing.stderr.slice("ghost-tray-error:".length));
assert.equal(diagnostic.kind, "dependency");
assert.match(diagnostic.message, /python-dbus/u);
assert.match(diagnostic.message, /sudo pacman -S --needed/u);
