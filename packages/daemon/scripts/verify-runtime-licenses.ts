import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const runtimeRootArg = process.argv[2];
if (!runtimeRootArg) throw new Error("usage: verify-runtime-licenses.ts <runtime-root>");
const runtimeRoot = resolve(runtimeRootArg);
const manifestPath = join(runtimeRoot, "BUNDLED-LICENSES");
const lines = readFileSync(manifestPath, "utf8").split("\n");
if (lines.pop() !== "" || lines.shift() !== "format=ghost-bundled-licenses/v1") {
  throw new Error("bundled license manifest has an invalid header or final newline");
}

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function filesBelow(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(runtimeRoot, path));
      else throw new Error(`runtime license closure contains a special entry: ${path}`);
    }
  };
  visit(root);
  return files.sort();
}

const declared = new Set<string>();
const identities = new Set<string>();
let sawGhost = false;
let sawPi = false;
for (const line of lines) {
  const fields = line.split("\t");
  if (fields.length !== 5) throw new Error(`invalid bundled license row: ${line}`);
  const [kind, name, version, license, pathList] = fields as [string, string, string, string, string];
  if ((kind !== "ghost" && kind !== "npm")
    || !name || !version || !license || !pathList
    || fields.some((field) => /[\r\n]/.test(field))) {
    throw new Error(`invalid bundled license identity: ${line}`);
  }
  const identity = `${kind}\0${name}\0${version}`;
  if (identities.has(identity)) throw new Error(`duplicate bundled license identity: ${line}`);
  identities.add(identity);
  if (kind === "ghost") sawGhost = true;
  if (name.startsWith("@earendil-works/pi-")) sawPi = true;
  if (name === "@anthropic-ai/claude-agent-sdk") {
    throw new Error("external Claude Agent SDK appears in the bundled license closure");
  }
  for (const relativePath of pathList.split(",")) {
    if (!relativePath.startsWith("licenses/") || isAbsolute(relativePath)) {
      throw new Error(`invalid bundled license path: ${relativePath}`);
    }
    const path = resolve(runtimeRoot, relativePath);
    if (!pathWithin(runtimeRoot, path)
      || !existsSync(path)
      || !statSync(path).isFile()) {
      throw new Error(`missing bundled license file: ${relativePath}`);
    }
    if (declared.has(relativePath)) throw new Error(`duplicate bundled license file: ${relativePath}`);
    declared.add(relativePath);
  }
}
if (!sawGhost || !sawPi) throw new Error("bundled license closure omits Ghost or Pi");

const actual = filesBelow(join(runtimeRoot, "licenses"));
const expected = [...declared].sort();
if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
  throw new Error("bundled license manifest does not exactly cover the licenses tree");
}
