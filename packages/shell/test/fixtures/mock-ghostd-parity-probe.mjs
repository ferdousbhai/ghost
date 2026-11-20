import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// The mock daemon must answer the routes the HUD relies on with the daemon's
// exact shapes: hooks.json, the roster, a transcript, and a
// streamed turn.
const here = dirname(fileURLToPath(import.meta.url));
const mockPath = resolve(here, "../../dev/mock-ghostd.mjs");
const child = spawn(process.execPath, [mockPath, "--port", "0", "--tool-steps", "2", "--stop-hook", "0.5", "--cut-bytes", "1000"], {
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

  const hooksResponse = await fetch(`http://127.0.0.1:${port}/api/hooks/config`, {
    headers: { authorization: "Bearer mock-parity" },
  });
  assert.equal(hooksResponse.status, 200);
  const hooksReply = await hooksResponse.json();
  assert.deepEqual(Object.keys(hooksReply), ["path", "document"]);
  // Like ghostd's parseHooksDocument, a PUT of the reply itself (stray top-level keys) is refused, not admitted as no hooks.
  const pastedReply = await fetch(`http://127.0.0.1:${port}/api/hooks/config`, {
    method: "PUT", headers: { authorization: "Bearer mock-parity", "content-type": "application/json" }, body: JSON.stringify(hooksReply),
  });
  assert.equal(pastedReply.status, 400);
  assert.deepEqual((await pastedReply.json()).error, {
    code: "invalid_request",
    message: `${hooksReply.path} has no top-level "path", "document"; send the document itself.`,
  });
  const rosterResponse = await fetch(`http://127.0.0.1:${port}/api/ghosts`);
  assert.equal(rosterResponse.status, 200);
  const roster = await rosterResponse.json();
  const casper = roster.find((ghost) => ghost.name === "casper");
  assert.ok(casper);

  const sessionsResponse = await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/sessions`);
  assert.equal(sessionsResponse.status, 200);
  const { sessions } = await sessionsResponse.json();
  assert.deepEqual(Object.keys(sessions[0]), [
    "id", "title", "preview", "harness", "model", "provider", "effort", "updatedAt", "messageCount", "pinned", "unread", "running", "question",
  ]);

  // A question the ghost asks is on its row until withdrawn.
  const questionUrl = `http://127.0.0.1:${port}/api/ghosts/casper/sessions/sess-casper-1/question`;
  const asked = await fetch(questionUrl, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Go ahead?", options: ["Yes", "No"] }),
  });
  assert.equal(asked.status, 200);
  assert.deepEqual((await asked.json()).question.options, ["Yes", "No"]);
  const rowOf = async (id) => (await (await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/sessions`)).json())
    .sessions.find((session) => session.id === id);
  assert.equal((await rowOf("sess-casper-1")).question.text, "Go ahead?");
  assert.deepEqual(await (await fetch(questionUrl, { method: "DELETE" })).json(), { ok: true });
  assert.equal((await rowOf("sess-casper-1")).question, null);

  // Pinning lifts a conversation above newer ones, and unpinning puts it back.
  const pinUrl = (id) => `http://127.0.0.1:${port}/api/ghosts/casper/sessions/${id}/pin`;
  const listedIds = async () => (await (await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/sessions`)).json())
    .sessions.map((session) => session.id);
  assert.deepEqual(await listedIds(), ["sess-casper-2", "sess-casper-1"]);
  const pinned = await fetch(pinUrl("sess-casper-1"), {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: true }),
  });
  assert.deepEqual(await pinned.json(), { ok: true, pinned: true });
  assert.deepEqual(await listedIds(), ["sess-casper-1", "sess-casper-2"]);
  await fetch(pinUrl("sess-casper-1"), { method: "PUT", body: JSON.stringify({ pinned: false }) });
  assert.deepEqual(await listedIds(), ["sess-casper-2", "sess-casper-1"]);
  const badPin = await fetch(pinUrl("sess-casper-1"), { method: "PUT", body: JSON.stringify({ pinned: "yes" }) });
  assert.equal(badPin.status, 400);
  assert.equal((await badPin.json()).error.code, "invalid_request");

  const harnessUrl =`http://127.0.0.1:${port}/api/ghosts/casper/harness`;
  const putJson = (url, body) => fetch(url, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const harnessChoice = await (await fetch(harnessUrl)).json();
  assert.deepEqual(Object.keys(harnessChoice), ["harnesses", "ghostDefault", "automatic"]);
  assert.deepEqual(Object.keys(harnessChoice.harnesses[0]), ["id", "usage", "effort", "resting"]);
  assert.equal(harnessChoice.ghostDefault, null);
  assert.equal((await (await putJson(harnessUrl, { harness: "pi" })).json()).ghostDefault, "pi");
  assert.equal((await (await putJson(harnessUrl, { harness: null })).json()).ghostDefault, null);
  const unknownHarness = await putJson(harnessUrl, { harness: "nope" });
  assert.equal(unknownHarness.status, 400);
  assert.equal((await unknownHarness.json()).error.code, "unknown_harness");
  const sessionHarness = await putJson(
    `http://127.0.0.1:${port}/api/ghosts/casper/sessions/hud-draft-probe/harness`, { harness: "pi" },
  );
  assert.equal(sessionHarness.status, 200);
  assert.deepEqual(await sessionHarness.json(), { id: "hud-draft-probe", harness: "pi" });

  // RemoteStatus's fields, in ghostd's order.
  const remote = await (await fetch(`http://127.0.0.1:${port}/api/remote`)).json();
  assert.deepEqual(Object.keys(remote), ["state", "hostname", "guests", "owner", "app", "problem"]);

  const transcriptResponse = await fetch(
    `http://127.0.0.1:${port}/api/ghosts/casper/sessions/sess-casper-1/transcript`,
  );
  assert.equal(transcriptResponse.status, 200);
  const transcriptBody = await transcriptResponse.json();
  assert.deepEqual(Object.keys(transcriptBody), [
    "id", "messages", "total", "truncated", "readThrough",
  ]);
  for (const message of transcriptBody.messages) {
    assert.equal(typeof message.entryId, "string");
    assert.ok(Array.isArray(message.content), "content is a part list, as transcriptMessages sends it");
  }
  const transcript = JSON.stringify(transcriptBody);
  assert.ok(transcript.includes(join(homedir(), "project-brief.md")));

  // A conversation with no log yet is ghostd's empty page, not a 404.
  const unknownTranscript = await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/sessions/never-started/transcript`);
  assert.equal(unknownTranscript.status, 200);
  assert.deepEqual(
    { ...await unknownTranscript.json(), readThrough: "" },
    { id: "never-started", messages: [], total: 0, truncated: false, readThrough: "" },
  );

  // Refusals carry ghostd's own code and message, so a client's handling of
  // one is proven against the mock exactly as it will meet ghostd.
  const base = `http://127.0.0.1:${port}/api/ghosts/casper`;
  const refusal = async (response, status, code, message) => {
    assert.equal(response.status, status);
    assert.deepEqual((await response.json()).error, { message, code });
  };
  const send = (method, path, body) => fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await refusal(await send("POST", "/sessions/sess-casper-1/stop"), 409, "session_not_streaming",
    "This conversation is not currently streaming.");
  await refusal(await send("POST", "/sessions/sess-casper-1/queue", { text: "later" }), 409, "session_not_streaming",
    "This conversation is not currently streaming; send a normal message instead.");
  await refusal(await send("POST", "/sessions/sess-casper-1/attachments", { path: fileURLToPath(import.meta.url) }), 415,
    "unsupported_media_type", "An attachment must be a PNG, JPEG, GIF, or WebP image.");
  await refusal(await send("PUT", "/sessions/sess-casper-1/title", { title: "x".repeat(121) }), 400, "invalid_request",
    '"title" must be at most 120 characters.');
  await refusal(await send("PUT", "/sessions/no-such-conversation/pin", { pinned: true }), 404, "not_found",
    'This ghost has no conversation "no-such-conversation".');
  await refusal(await send("PUT", "/sessions/sess-casper-1/question", { text: "Go?", options: [1] }), 400, "invalid_request",
    '"options" must be an array of strings.');
  await refusal(await send("PUT", "/sessions/pins.json/read", {}), 400, "invalid_conversation_id",
    "Conversation ids are 1-128 letters, digits, '.', '_' or '-', and not pins.json, reads.json, questions.json.");
  await refusal(await fetch(`http://127.0.0.1:${port}/api/ghosts/nobody/sessions`), 404, "not_found", 'No ghost named "nobody".');

  /** Read a turn to its terminal, following each cut as the HUD does. */
  const settle = async (response, id) => {
    const events = [];
    while (response) {
      const frames = (await response.text()).split("\n\n").filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice(6)));
      const last = frames.at(-1);
      response = last?.type === "resume" && await fetch(`${base}/sessions/${id}/stream?turn=${last.turn}&from=${last.from}`);
      events.push(...frames.filter((event) => event.type !== "resume"));
    }
    return events;
  };
  // No sessionId is ghostd's conversation `default`.
  const defaultTurn = await send("POST", "/messages", { prompt: "probe the default conversation" });
  assert.equal(defaultTurn.status, 200);
  assert.deepEqual((await settle(defaultTurn, "default")).at(-1), { type: "done" });
  const defaultLog = await (await fetch(`${base}/sessions/default/transcript`)).json();
  assert.ok(JSON.stringify(defaultLog.messages).includes("probe the default conversation"));

  const createdResponse = await fetch(`http://127.0.0.1:${port}/api/ghosts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "fresh-mock-ghost" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.ok(existsSync(created.dir));

  const turnResponse = await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: "probe tool trace",
      sessionId: "mock-trace-probe",
    }),
  });
  assert.equal(turnResponse.status, 200);
  // A turn cut for size resumes, as ghostd's does, until its one terminal.
  const frames = [];
  let cuts = 0;
  for (let response = turnResponse; response;) {
    const events = (await response.text()).split("\n\n").filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice(6)));
    const last = events.at(-1);
    response = null;
    if (last?.type === "resume") {
      cuts += 1;
      events.pop();
      response = await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/sessions/mock-trace-probe/stream?turn=${last.turn}&from=${last.from}`);
      assert.equal(response.status, 200);
    }
    frames.push(...events);
  }
  assert.ok(cuts > 0);
  // Like ghostd, a pass names its agent right after `start`.
  assert.deepEqual(frames.slice(0, 2), [{ type: "start" }, { type: "harness", harness: "local" }]);
  assert.deepEqual(frames.filter((event) => event.type === "done" || event.type === "error"), [{ type: "done" }]);
  const gone = await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/sessions/mock-trace-probe/stream?turn=nope&from=0`);
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).error.code, "turn_not_found");
  const turnEvents = JSON.stringify(frames);
  assert.ok(turnEvents.includes(join(homedir(), "step-2.md")));
  // The pass is logged as ghostd logs it: narration, its calls, then the reply.
  const logged = await (await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/sessions/mock-trace-probe/transcript`)).json();
  assert.deepEqual(logged.messages.find((message) => message.role === "assistant").content.map((part) => part.type),
    ["text", "toolCall", "toolCall", "text"]);

  // A stop during a stop hook is accepted and the turn settles.
  const stoppedId = "mock-stopped-hook";
  let stoppedResponse = await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "stop during hook", sessionId: stoppedId }),
  });
  let sawHook = false;
  while (stoppedResponse) {
    const reader = stoppedResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let resume = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (buffer.includes("\n\n")) {
        const end = buffer.indexOf("\n\n");
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (!frame.startsWith("data: ")) continue;
        const event = JSON.parse(frame.slice(6));
        if (event.type === "resume") resume = event;
        if (event.type === "hook_start" && event.event === "session_stop") {
          sawHook = true;
          // Like ghostd, a conversation mid-turn keeps its agent and its directory.
          const conversationUrl = `http://127.0.0.1:${port}/api/ghosts/casper/sessions/${stoppedId}`;
          const busySwitch = await fetch(`${conversationUrl}/harness`, {
            method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ harness: "pi" }),
          });
          assert.equal(busySwitch.status, 409);
          assert.deepEqual((await busySwitch.json()).error,
            { message: "Wait for this conversation to finish before switching agents.", code: "session_busy" });
          await refusal(await send("POST", "/messages", { prompt: "again", sessionId: stoppedId }), 409, "session_busy",
            "This ghost is already answering in this conversation.");
          const busyDelete = await fetch(conversationUrl, { method: "DELETE" });
          assert.equal(busyDelete.status, 409);
          assert.deepEqual((await busyDelete.json()).error,
            { message: "Wait for this conversation to finish before deleting it.", code: "session_busy" });
          const stop = await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/sessions/${stoppedId}/stop`, { method: "POST" });
          assert.equal(stop.status, 200);
        }
      }
    }
    stoppedResponse = resume && await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/sessions/${stoppedId}/stream?turn=${resume.turn}&from=${resume.from}`);
  }
  assert.ok(sawHook);
  for (let tries = 0; tries < 100; tries += 1) {
    const row = (await (await fetch(`http://127.0.0.1:${port}/api/ghosts/casper/sessions`)).json())
      .sessions.find((session) => session.id === stoppedId);
    if (!row.running) {
      break;
    }
    if (tries === 99) throw new Error("stopped mock turn did not settle");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }

} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    if (child.exitCode !== null) resolveExit();
    else child.once("exit", resolveExit);
  });
}

console.log("mock ghostd parity probe passed");
