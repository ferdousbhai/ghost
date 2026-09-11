// The transcript delegate declares one `required property` per ListModel role.
// A dynamically-filled ListModel has no schema, so a role the rows stop
// carrying does not fail the build, or qmllint, or any test — the delegate
// simply cannot be created and the conversation renders empty at runtime.
// qmllint is already told to expect these as unbound, so this is the only
// thing standing between a removed row field and a blank HUD.
import { readFileSync } from "node:fs";

const hud = readFileSync(new URL("../../qml/GhostHud.qml", import.meta.url), "utf8");
const ghostd = readFileSync(new URL("../../qml/services/Ghostd.qml", import.meta.url), "utf8");

// The whole delegate, not just up to the first blank line: a `required
// property` declared below the bindings is ordinary QML style, and stopping
// early would skip it and still exit 0.
const open = hud.indexOf("delegate: Bubble {");
let depth = 0;
let close = open;
for (let i = hud.indexOf("{", open); i < hud.length; i++) {
  if (hud[i] === "{") depth++;
  else if (hud[i] === "}" && --depth === 0) { close = i; break; }
}
if (close === open) throw new Error("could not find the end of the transcript delegate");
// Comments first: the prose above these declarations says "required property
// per ListModel role", which reads as a declaration to a regex.
const block = hud.slice(open, close).replace(/^\s*\/\/.*$/gm, "");
const required = [...block.matchAll(/required property \w+ (\w+)/g)].map(m => m[1]);
if (required.length === 0) throw new Error("no required properties found on the transcript delegate");

const clone = ghostd.slice(ghostd.indexOf("function cloneTranscriptRow"));
const roles = new Set(
  [...clone.slice(0, clone.indexOf("\n    }")).matchAll(/^\s+(\w+):/gm)].map(m => m[1]));
// ListView supplies this one; it is never a model role.
roles.add("index");

const orphans = required.filter(name => !roles.has(name));
if (orphans.length > 0) {
  console.error(
    `transcript delegate requires roles no row carries: ${orphans.join(", ")}\n`
    + `  declared in qml/GhostHud.qml, produced by Ghostd.cloneTranscriptRow\n`
    + `  every transcript row would fail to instantiate and the HUD would render empty`);
  process.exit(1);
}
console.log(`transcript roles agree (${required.length} required, ${roles.size} supplied)`);
