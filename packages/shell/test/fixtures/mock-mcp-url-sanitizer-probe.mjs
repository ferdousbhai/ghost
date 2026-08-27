import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mockPath = resolve(here, "../../dev/mock-ghostd.mjs");
const vectors = JSON.parse(readFileSync(
  resolve(here, "mcp-url-sanitizer-vectors.json"),
  "utf8",
));
const child = spawn(process.execPath, [mockPath, "--port", "0"], {
  stdio: ["ignore", "ignore", "pipe"],
});

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
  const endpoint = `http://127.0.0.1:${port}/api/ghosts/casper/mcp`;

  for (const [index, vector] of vectors.entries()) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `url-vector-${index}`,
        config: { type: "http", url: vector.input },
      }),
    });
    const responseText = await response.text();
    assert.equal(response.status, 201, `${vector.name}: ${responseText}`);
    const snapshot = JSON.parse(responseText);
    const server = snapshot.servers.find((entry) => entry.name === `url-vector-${index}`);
    assert.equal(server?.config?.url, vector.expected, vector.name);
    for (const sentinel of vector.sentinels) {
      assert.ok(!responseText.includes(sentinel), `${vector.name} exposed ${sentinel}`);
    }
  }

  const finalResponse = await fetch(endpoint);
  assert.equal(finalResponse.status, 200);
  const finalText = await finalResponse.text();
  const finalSnapshot = JSON.parse(finalText);
  for (const [index, vector] of vectors.entries()) {
    const server = finalSnapshot.servers.find((entry) => entry.name === `url-vector-${index}`);
    assert.equal(server?.config?.url, vector.expected, vector.name);
    for (const sentinel of vector.sentinels) {
      assert.ok(!finalText.includes(sentinel), `${vector.name} exposed ${sentinel}`);
    }
  }
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    if (child.exitCode !== null) resolveExit();
    else child.once("exit", resolveExit);
  });
}

console.log("mock MCP URL sanitizer parity probe passed");
