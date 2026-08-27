import { spawn } from "node:child_process";
import { createServer } from "node:http";

const qml = process.argv[2];
if (!qml) throw new Error("usage: hook-resource-probe.mjs <qml-runtime>");

const requested = [];
const server = createServer((request, response) => {
  requested.push(request.url ?? "<missing-url>");
  response.writeHead(200, { "content-type": "image/gif" });
  response.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string") throw new Error("missing TCP address");
const fixtureUrl = `http://127.0.0.1:${address.port}`;

const child = spawn(qml, [
  "-I", "test/imports",
  "-I", "qml",
  "-I", ".qmllint",
  "test/hook-resource-probe.qml",
  "--",
  fixtureUrl,
], {
  env: { ...process.env, QT_QPA_PLATFORM: "offscreen" },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`qml probe exited on ${signal}`));
    else resolve(code);
  });
});

await new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

if (exitCode !== 0) {
  throw new Error(`hook resource probe failed with ${exitCode}:\n${stderr}`);
}
if (requested.length > 0) {
  throw new Error(`hook labels requested resources: ${requested.join(", ")}`);
}

console.log("hook label resource probe passed (0 requests)");
