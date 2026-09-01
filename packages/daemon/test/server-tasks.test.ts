import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationIdentity } from "../src/conversation-identity.js";
import { GhostError } from "../src/ghosts.js";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
import type { SessionHost } from "../src/session-host.js";
import type { TaskRecord } from "../src/tasks.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { fetchNoReuse as fetch } from "./helpers/http-fetch.js";

const TOKEN = "owner-token";
const TASK_ID = "task-11111111-1111-4111-8111-111111111111";
const PARENT: ConversationIdentity = {
  id: "pi:conversation",
  runtime: "pi",
  conversationId: "conversation",
};

let temp: TempGhosts | undefined;
let listening: ListeningServer | undefined;

afterEach(async () => {
  await listening?.close();
  listening = undefined;
  temp?.cleanup();
  temp = undefined;
  vi.restoreAllMocks();
});

function record(parent = PARENT): TaskRecord {
  const at = "2026-08-31T00:00:00.000Z";
  return {
    version: 2,
    id: TASK_ID,
    generation: 1,
    parent,
    harness: "codex",
    agent: null,
    task: "Inspect a private implementation detail and return a patch.",
    binding: {
      version: 1,
      root: "/private/project",
      rootIdentity: "secret-root-identity",
      cwd: "/private/project/src",
      cwdIdentity: "secret-cwd-identity",
      generation: 4,
    },
    ownership: {
      version: 1,
      kind: "systemd-scope",
      nonce: "11111111111111111111111111111111",
    },
    state: "running",
    createdAt: at,
    updatedAt: at,
    events: [{ sequence: 1, at, code: "started", message: "Working safely." }],
    eventCursor: { nextSequence: 2, dropped: 0 },
    result: null,
    resultTruncated: false,
    error: null,
  };
}

async function serve(options: {
  host: Partial<SessionHost>;
  nativeHarnesses?: { list(): Promise<readonly unknown[]> };
}): Promise<string> {
  temp = makeTempGhosts();
  seedGhost(temp.root, { name: "casper" });
  listening = await startDaemonServer({
    registry: temp.registry,
    host: options.host as SessionHost,
    port: 0,
    apiToken: TOKEN,
    relay: null,
    ...(options.nativeHarnesses === undefined
      ? {}
      : { nativeHarnesses: options.nativeHarnesses as never }),
  });
  return `http://127.0.0.1:${listening.port}`;
}

function request(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
}

describe("native harness API", () => {
  it("authenticates before probing and projects only the public catalogue shape", async () => {
    const list = vi.fn(async () => [{
      id: "codex",
      availability: "available",
      authentication: "authenticated",
      executable: "/must/not/cross/the/wire",
      accountFingerprint: "private-account",
    }]);
    const base = await serve({ host: {}, nativeHarnesses: { list } });

    const denied = await fetch(`${base}/api/harnesses`);
    expect(denied.status).toBe(401);
    expect(list).not.toHaveBeenCalled();

    const admitted = await request(`${base}/api/harnesses`);
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toEqual({
      harnesses: [{
        id: "codex",
        availability: "available",
        authentication: "authenticated",
      }],
    });
    expect(list).toHaveBeenCalledOnce();
    expect((await request(`${base}/api/harnesses`, {
      method: "POST",
      body: "{}",
    })).status).toBe(405);
  });
});

describe("delegated task API", () => {
  it("returns the bounded active-task deletion conflict unchanged", async () => {
    const deleteSession = vi.fn(async () => {
      throw new GhostError(
        "tasks_active",
        "Cancel or wait for this conversation's delegated tasks before deleting it.",
        409,
      );
    });
    const base = await serve({ host: { deleteSession } });
    const response = await request(
      `${base}/api/ghosts/casper/sessions/${encodeURIComponent(PARENT.id)}`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "tasks_active",
        message: "Cancel or wait for this conversation's delegated tasks before deleting it.",
      },
    });
    expect(deleteSession).toHaveBeenCalledWith("casper", "conversation", "pi");
  });

  it("uses exact parent-scoped methods and bounded projections for every action", async () => {
    const task = record();
    const host = {
      listTasks: vi.fn(async () => [task]),
      createTask: vi.fn(async () => task),
      task: vi.fn(async () => task),
      sendTask: vi.fn(async () => task),
      cancelTask: vi.fn(async () => ({ ...task, state: "cancelled" as const })),
    };
    const base = await serve({ host });
    const collection = `${base}/api/ghosts/casper/sessions/${encodeURIComponent(PARENT.id)}/tasks`;

    const denied = await fetch(collection);
    expect(denied.status).toBe(401);
    expect(host.listTasks).not.toHaveBeenCalled();

    const listed = await request(`${collection}?limit=1`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as Record<string, unknown>;
    expect(listedBody).toMatchObject({ shown: 1, total: 1 });
    expect(JSON.stringify(listedBody)).not.toContain("secret-root-identity");
    expect(host.listTasks).toHaveBeenCalledWith("casper", PARENT);

    const created = await request(collection, {
      method: "POST",
      body: JSON.stringify({
        harness: "codex",
        assignment: "Implement the fix.",
        cwd: "/private/project/src",
      }),
    });
    expect(created.status).toBe(201);
    expect(host.createTask).toHaveBeenCalledWith(
      "casper",
      PARENT,
      {
        harness: "codex",
        assignment: "Implement the fix.",
        cwd: "/private/project/src",
      },
      expect.any(AbortSignal),
    );

    expect((await request(`${collection}/${TASK_ID}`)).status).toBe(200);
    expect(host.task).toHaveBeenCalledWith("casper", PARENT, TASK_ID);

    expect((await request(`${collection}/${TASK_ID}/send`, {
      method: "POST",
      body: JSON.stringify({ message: "Also run the focused test." }),
    })).status).toBe(200);
    expect(host.sendTask).toHaveBeenCalledWith(
      "casper",
      PARENT,
      TASK_ID,
      "Also run the focused test.",
    );

    const cancelled = await request(`${collection}/${TASK_ID}/cancel`, {
      method: "POST",
      body: "{}",
    });
    expect(cancelled.status).toBe(200);
    expect(host.cancelTask).toHaveBeenCalledWith("casper", PARENT, TASK_ID);
  });

  it("rejects hostile shapes before task code and never returns unexpected failures", async () => {
    const createTask = vi.fn(async () => record());
    const sendTask = vi.fn(async () => {
      throw new Error("raw protocol bearer super-secret");
    });
    const base = await serve({
      host: {
        listTasks: vi.fn(async () => []),
        createTask,
        task: vi.fn(async () => { throw new GhostError("task_not_found", "No task.", 404); }),
        sendTask,
        cancelTask: vi.fn(async () => record()),
      },
    });
    const collection = `${base}/api/ghosts/casper/sessions/${encodeURIComponent(PARENT.id)}/tasks`;

    expect((await request(`${collection}?limit=01`)).status).toBe(400);
    expect((await request(collection, {
      method: "POST",
      body: JSON.stringify({
        harness: "codex",
        assignment: "work",
        credential: "must-not-be-accepted",
      }),
    })).status).toBe(400);
    expect(createTask).not.toHaveBeenCalled();
    expect((await request(collection, {
      method: "POST",
      body: JSON.stringify({ harness: "codex", assignment: " \n\t " }),
    })).status).toBe(400);
    expect((await request(collection, {
      method: "POST",
      body: JSON.stringify({ harness: "pi", assignment: "work", agent: "claude-only" }),
    })).status).toBe(400);
    for (const agent of [
      " \n\t ",
      "reviewer\nname",
      "Bearer private-token-value",
      "[REDACTED_SECRET]",
    ]) {
      expect((await request(collection, {
        method: "POST",
        body: JSON.stringify({ harness: "claude-code", assignment: "work", agent }),
      })).status).toBe(400);
    }
    expect(createTask).not.toHaveBeenCalled();

    expect((await request(`${collection}/${TASK_ID}/send`, {
      method: "POST",
      body: JSON.stringify({ message: " \n\t " }),
    })).status).toBe(400);
    expect(sendTask).not.toHaveBeenCalled();

    const failed = await request(`${collection}/${TASK_ID}/send`, {
      method: "POST",
      body: JSON.stringify({ message: "continue" }),
    });
    expect(failed.status).toBe(500);
    const text = await failed.text();
    expect(text).toContain("internal_error");
    expect(text).not.toContain("super-secret");

    const missing = await request(`${collection}/${TASK_ID}`);
    expect(missing.status).toBe(404);
  });
});
