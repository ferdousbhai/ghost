import { unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const addressFile = process.argv[2];
if (!addressFile) throw new Error("usage: sse-byte-split-server.mjs <address-file>");

const expected = "emoji 👻 and CJK 漢字 stay exact";
const wire = Buffer.from([
  `data: ${JSON.stringify({ type: "text_start", contentIndex: 0 })}\n\n`,
  `data: ${JSON.stringify({ type: "text_delta", contentIndex: 0, delta: expected })}\n\n`,
  `data: ${JSON.stringify({ type: "done", reason: "stop" })}\n\n`,
].join(""), "utf8");

function splitInside(buffer, token) {
  const at = buffer.indexOf(Buffer.from(token, "utf8"));
  if (at < 0) throw new Error(`fixture token missing: ${token}`);
  const width = Buffer.byteLength(token, "utf8");
  return Array.from({ length: width - 1 }, (_, index) => at + index + 1);
}

// Every boundary below is inside a multibyte UTF-8 scalar, not merely beside it.
const cuts = [...new Set([
  ...splitInside(wire, "👻"),
  ...splitInside(wire, "漢"),
  ...splitInside(wire, "字"),
])].sort((left, right) => left - right);

const server = createServer((request, response) => {
  if (request.url !== "/events") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "close",
  });
  let start = 0;
  const boundaries = cuts.concat([wire.length]);
  const writeNext = () => {
    const end = boundaries.shift();
    if (end === undefined) {
      response.end();
      return;
    }
    response.write(wire.subarray(start, end));
    start = end;
    setTimeout(writeNext, 8);
  };
  writeNext();
});

let addressPublished = false;
function removeAddressFile() {
  if (!addressPublished) return;
  try {
    unlinkSync(addressFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  addressPublished = false;
}

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  writeFileSync(addressFile, `http://127.0.0.1:${address.port}/events\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  addressPublished = true;
});

function stop() {
  server.close(() => {
    removeAddressFile();
    process.exit(0);
  });
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("exit", removeAddressFile);
