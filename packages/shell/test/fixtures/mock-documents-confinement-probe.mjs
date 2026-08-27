import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = mkdtempSync(join(tmpdir(), "ghost-mock-documents-confined-"));
const documents = join(fixture, "Documents");
const outside = join(fixture, "outside");
mkdirSync(join(documents, "nested"), { recursive: true });
mkdirSync(join(documents, "swappable"));
mkdirSync(outside);
writeFileSync(join(documents, "Alpha.md"), "alpha\n", "utf8");
writeFileSync(join(documents, "Beta.md"), "beta\n", "utf8");
writeFileSync(join(documents, "nested", "normal.md"), "normal\n", "utf8");
writeFileSync(join(documents, "swappable", "inside.md"), "inside\n", "utf8");
const outsideFile = join(outside, "outside-secret.md");
writeFileSync(outsideFile, "outside must survive\n", "utf8");
symlinkSync(outsideFile, join(documents, "direct-link.md"));
symlinkSync(outside, join(documents, "ancestor-link"));

const here = dirname(fileURLToPath(import.meta.url));
const mockPath = resolve(here, "../../dev/mock-ghostd.mjs");
const child = spawn(process.execPath, [mockPath, "--port", "0"], {
  env: { ...process.env, GHOST_DOCUMENTS_ROOT: documents },
  stdio: ["ignore", "ignore", "pipe"],
});

async function deleteDocument(baseUrl, path) {
  return fetch(`${baseUrl}/api/documents`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, confirm: path }),
  });
}

try {
  const port = await new Promise((resolvePort, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`mock did not listen: ${output}`)), 5_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      output += chunk;
      const found = output.match(/mock-ghostd on http:\/\/127\.0\.0\.1:(\d+)/u);
      if (!found) return;
      clearTimeout(timer);
      resolvePort(Number(found[1]));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`mock exited before listening (${code}): ${output}`));
    });
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  const rootResponse = await fetch(`${baseUrl}/api/documents?limit=2`);
  assert.equal(rootResponse.status, 200);
  const firstPage = await rootResponse.json();
  assert.equal(firstPage.root, documents);
  assert.ok(firstPage.entries.every((entry) => !["direct-link.md", "ancestor-link"].includes(entry.name)));
  assert.deepEqual(firstPage.skipped.map((entry) => entry.name).sort(), ["ancestor-link", "direct-link.md"]);
  assert.ok(!JSON.stringify(firstPage).includes("outside-secret.md"));

  const seen = firstPage.entries.map((entry) => entry.name);
  let page = firstPage;
  while (page.nextCursor !== null) {
    const response = await fetch(
      `${baseUrl}/api/documents?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
    );
    assert.equal(response.status, 200);
    page = await response.json();
    seen.push(...page.entries.map((entry) => entry.name));
  }
  assert.deepEqual(seen, ["nested", "swappable", "Alpha.md", "Beta.md"]);
  assert.equal(page.truncated, true);

  const nestedResponse = await fetch(`${baseUrl}/api/documents?path=nested`);
  assert.equal(nestedResponse.status, 200);
  assert.deepEqual((await nestedResponse.json()).entries.map((entry) => entry.name), ["normal.md"]);
  const nestedContent = await fetch(`${baseUrl}/api/documents/content?path=nested%2Fnormal.md`);
  assert.equal(nestedContent.status, 200);
  assert.equal((await nestedContent.json()).content, "normal\n");

  const directList = await fetch(`${baseUrl}/api/documents?path=direct-link.md`);
  assert.equal(directList.status, 400);
  assert.equal((await directList.json()).error.code, "invalid_path");
  const ancestorList = await fetch(`${baseUrl}/api/documents?path=ancestor-link`);
  assert.equal(ancestorList.status, 400);
  assert.equal((await ancestorList.json()).error.code, "invalid_path");
  const directContent = await fetch(`${baseUrl}/api/documents/content?path=direct-link.md`);
  assert.equal(directContent.status, 400);
  assert.equal((await directContent.json()).error.code, "invalid_path");
  const ancestorContent = await fetch(
    `${baseUrl}/api/documents/content?path=ancestor-link%2Foutside-secret.md`,
  );
  assert.equal(ancestorContent.status, 400);
  assert.equal((await ancestorContent.json()).error.code, "invalid_path");

  const directDelete = await deleteDocument(baseUrl, "direct-link.md");
  assert.equal(directDelete.status, 400);
  assert.equal((await directDelete.json()).error.code, "invalid_path");
  assert.equal(readFileSync(outsideFile, "utf8"), "outside must survive\n");
  assert.ok(existsSync(join(documents, "direct-link.md")));

  const ancestorDelete = await deleteDocument(baseUrl, "ancestor-link/outside-secret.md");
  assert.equal(ancestorDelete.status, 400);
  assert.equal((await ancestorDelete.json()).error.code, "invalid_path");
  assert.equal(readFileSync(outsideFile, "utf8"), "outside must survive\n");

  // A pathname that was a real directory on one request cannot become a
  // symlink escape on the next. Each request reopens every ancestor no-follow.
  const beforeSwap = await fetch(`${baseUrl}/api/documents?path=swappable`);
  assert.equal(beforeSwap.status, 200);
  renameSync(join(documents, "swappable"), join(documents, "held-inside"));
  symlinkSync(outside, join(documents, "swappable"));
  const afterSwap = await fetch(`${baseUrl}/api/documents?path=swappable`);
  assert.equal(afterSwap.status, 400);
  const swapDelete = await deleteDocument(baseUrl, "swappable/outside-secret.md");
  assert.equal(swapDelete.status, 400);
  assert.equal(readFileSync(outsideFile, "utf8"), "outside must survive\n");

  const normalDelete = await deleteDocument(baseUrl, "nested/normal.md");
  assert.equal(normalDelete.status, 200);
  const deleted = await normalDelete.json();
  assert.deepEqual(
    { ok: deleted.ok, path: deleted.path, kind: deleted.kind },
    { ok: true, path: "nested/normal.md", kind: "fallback" },
  );
  assert.deepEqual(Object.keys(deleted).sort(), ["kind", "ok", "path", "trash"]);
  assert.ok(!existsSync(join(documents, "nested", "normal.md")));
  assert.ok(existsSync(deleted.trash));
  const trashRelative = relative(documents, deleted.trash);
  assert.ok(trashRelative !== "" && trashRelative !== ".."
    && !trashRelative.startsWith(`..${sep}`) && trashRelative.startsWith(`.mock-trash${sep}`));
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    if (child.exitCode !== null) resolveExit();
    else child.once("exit", resolveExit);
  });
  rmSync(fixture, { recursive: true, force: true });
}

console.log("mock Documents descriptor-confinement probe passed");
