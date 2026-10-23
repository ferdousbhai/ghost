import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRoutineRecoveries } from "../src/routine-config.js";
import { controlGhostRoutine, listGhostRoutines, readRoutineLogs } from "../src/schedules.js";
import { SessionHost } from "../src/session-host.js";
import { startDaemonServer, type ListeningServer } from "../src/server.js";
import { RemoteAccess, type CommandRunner } from "../src/tailscale-identity.js";
import { runCli } from "./helpers/cli.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "./helpers/fixtures.js";
import { fetchNoReuse as fetch } from "./helpers/http-fetch.js";

let temp: TempGhosts;
let host: SessionHost | undefined;
let server: ListeningServer | undefined;
afterEach(async () => {
  await server?.close(); await host?.disposeAll(); temp?.cleanup();
  server = undefined; host = undefined;
});
const timer = "ghost-timer-v1-6-casper-daily.timer";
const service = timer.replace(".timer", ".service");
const ok = { stdout: "", stderr: "", code: 0 };
async function setup() {
  temp = makeTempGhosts(); temp.registry.ensureRoot(); seedGhost(temp.root);
  const unitDir = join(temp.ownerHome, "units");
  await mkdir(unitDir);
  for (const name of [timer, service, "ghost-timer-v1-10-casper-ops-daily.timer", "ghost-timer-casper-legacy.timer"]) {
    await writeFile(join(unitDir, name), "[Unit]\n");
  }
  return unitDir;
}
function manager(calls: string[][], overrides: { target?: string; started?: boolean; active?: string } = {}): CommandRunner {
  return async (args) => {
    calls.push([...args]);
    if (args.includes("--value")) return { ...ok, stdout: overrides.target ?? service };
    if (args.includes("show")) return { ...ok, stdout: args.includes(timer)
      ? `Id=${timer}\nUnit=${overrides.target ?? service}\nDescription=Daily notes\nTimersCalendar={ OnCalendar=*-*-* 09:00:00 Europe/Helsinki ; next_elapse=Fri 2026-10-23 09:00:00 EEST }\nNextElapseUSecRealtime=Fri 2026-10-23 09:00:00 EEST\nUnitFileState=disabled\nActiveState=inactive\nLastTriggerUSec=Thu 2026-10-22 09:00:00 EEST\n`
      : `Id=${service}\nExecStart={ path=/usr/bin/ghost ; argv[]=/usr/bin/ghost say --new ; }\nResult=success\nActiveState=${overrides.active ?? "inactive"}\nExecMainStartTimestamp=${overrides.started ? "Thu 2026-10-22 10:00:00 EEST" : ""}\n` };
    return ok;
  };
}

describe("systemd routine inspection and controls", () => {
  it("lists only exactly owned timers, preserves timezone, and reports service starts including manual runs", async () => {
    const unitDir = await setup(), calls: string[][] = [];
    const routines = await listGhostRoutines("casper", { unitDir, run: manager(calls, { started: true }) });
    expect(routines).toHaveLength(1);
    expect(routines[0]).toMatchObject({ ghost: "casper", slug: "daily", unit: timer, service,
      enabled: "disabled", active: "inactive", result: "success", lastRun: "Thu 2026-10-22 10:00:00 EEST" });
    expect(routines[0]?.schedule).toContain("Europe/Helsinki");
    expect(calls).toHaveLength(2);
  });
  it("does not call a never-started service a success", async () => {
    const unitDir = await setup();
    const [row] = await listGhostRoutines("casper", { unitDir, run: manager([]) });
    expect(row).toMatchObject({ lastRun: null, result: "" });
  });
  it("does not present a running service's default result as a completed outcome", async () => {
    const unitDir = await setup();
    const [row] = await listGhostRoutines("casper", { unitDir, run: manager([], { started: true, active: "activating" }) });
    expect(row).toMatchObject({ result: "", serviceActive: "activating" });
  });
  it("pauses/resumes the timer and queues the service without waiting or changing the timer", async () => {
    const unitDir = await setup(), calls: string[][] = [];
    const options = { unitDir, run: manager(calls) };
    for (const action of ["pause", "resume", "run"]) await controlGhostRoutine("casper", "daily", action, options);
    expect(calls).toEqual([
      ["--user", "disable", "--now", timer], ["--user", "enable", "--now", timer],
      ["--user", "show", "--property=Unit", "--value", timer], ["--user", "start", "--no-block", service],
    ]);
  });
  it("rejects invalid, missing, cross-ghost, and redirected run targets before executing them", async () => {
    const unitDir = await setup(), calls: string[][] = [], run = manager(calls, { target: "unrelated.service" });
    for (const [slug, action, status] of [["../daily", "pause", 400], ["missing", "run", 404], ["daily", "remove", 400]] as const) {
      await expect(controlGhostRoutine("casper", slug, action, { unitDir, run })).rejects.toMatchObject({ status });
    }
    expect(calls).toHaveLength(0);
    await expect(controlGhostRoutine("casper", "daily", "run", { unitDir, run })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
    const [row] = await listGhostRoutines("casper", { unitDir, run });
    expect(row).toMatchObject({ service: "unrelated.service", command: "", servicePath: "", result: "" });
    await rm(join(unitDir, service));
    const direct: string[][] = [];
    await expect(controlGhostRoutine("casper", "daily", "run", { unitDir, run: manager(direct) })).rejects.toMatchObject({ status: 400 });
    expect(direct.some(call => call.includes("start"))).toBe(false);
  });
  it("propagates a systemd failure rather than presenting empty or successful state", async () => {
    const unitDir = await setup();
    const options = { unitDir, run: async () => ({ ...ok, code: 1, stderr: "User manager unavailable" }) };
    await expect(listGhostRoutines("casper", options)).rejects.toMatchObject({ status: 503 });
    await expect(controlGhostRoutine("casper", "daily", "resume", options)).rejects.toThrow("User manager unavailable");
  });
  it("does not contact systemd for a ghost with no timers", async () => {
    const unitDir = await setup(), calls: string[][] = [];
    expect(await listGhostRoutines("other", { unitDir, run: manager(calls) })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
  it("holds a lifecycle lease until a routine control finishes", async () => {
    const unitDir = await setup();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    host = new SessionHost({ registry: temp.registry, ownerHome: temp.ownerHome, scheduleUnitDir: unitDir,
      env: { ...process.env, GHOST_DESKTOP: "/usr/bin/false" },
      scheduleCommandRunner: async (args) => {
        if (args.includes("enable")) { entered(); await blocked; }
        return ok;
      } });
    const resume = host.controlRoutine("casper", "daily", "resume");
    await started;
    const rename = host.renameGhost("casper", "new-name");
    // reserve() claims both names synchronously, then waits for the lease.
    await expect(host.routines("casper")).rejects.toMatchObject({ status: 409 });
    expect(temp.registry.get("casper").name).toBe("casper");
    release(); await resume; await rename;
    expect(temp.registry.get("new-name").name).toBe("new-name");
  });
  it("retires a renamed ghost's checkpoints with its units", async () => {
    const unitDir = await setup();
    host = new SessionHost({ registry: temp.registry, ownerHome: temp.ownerHome, scheduleUnitDir: unitDir,
      env: { ...process.env, GHOST_DESKTOP: "/usr/bin/false" }, scheduleCommandRunner: manager([]), scheduleVerifyRunner: async () => ok });
    const config = await host.routineConfig("casper", "daily");
    await host.removeRoutine("casper", "daily", config.revision);
    expect(await listRoutineRecoveries("casper", { unitDir })).toHaveLength(1);
    await host.renameGhost("casper", "new-name");
    expect(await listRoutineRecoveries("casper", { unitDir })).toEqual([]);
  });
  it("bounds journal reads to the owned service and links accepted event conversations", async () => {
    const unitDir = await setup(), eventId = "event-" + "a".repeat(64);
    const calls: string[][] = [];
    const result = await readRoutineLogs("casper", "daily", { unitDir }, async (args) => {
      calls.push([...args]); return { ...ok, stdout: "x".repeat(65000) + `\nAccepted: casper/${eventId}\nAccepted: other/event-${"b".repeat(64)}\n` };
    });
    expect(result.truncated).toBe(true); expect(result.text.length).toBe(64000);
    expect(result.sessions).toEqual([eventId]);
    expect(calls[0]).toEqual(["--user", "--unit", service, "--no-pager", "--output=short-iso", "--lines=100"]);
  });
  it("CLI lists state and routes pause/resume/run to the addressed ghost", async () => {
    const unitDir = await setup();
    const routines = await listGhostRoutines("casper", { unitDir, run: manager([]) });
    const requests: Array<{ path: string; method: string }> = [];
    const options = { env: { GHOST: "casper", GHOSTD_PORT: "17718" }, home: temp.ownerHome,
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET" });
        return new Response(JSON.stringify(init?.method === "POST" ? { ok: true } : { routines }), { headers: { "content-type": "application/json" } });
      } };
    expect((await runCli(["routines"], options)).stdout).toContain("casper/daily · disabled");
    expect(JSON.parse((await runCli(["routines", "--json"], options)).stdout)).toEqual({ routines });
    for (const action of ["pause", "resume", "run"]) {
      expect((await runCli(["routines", action, "daily"], options)).code).toBe(0);
      expect(requests.at(-1)).toEqual({ path: `/api/ghosts/casper/routines/daily/${action}`, method: "POST" });
    }
    const count = requests.length;
    expect((await runCli(["routines", "pause"], options)).code).not.toBe(0);
    expect(requests).toHaveLength(count);
  });
  it("exposes owner inspection/control through HTTP and refuses guest access", async () => {
    const unitDir = await setup(), calls: string[][] = [];
    host = new SessionHost({ registry: temp.registry, ownerHome: temp.ownerHome, scheduleUnitDir: unitDir,
      scheduleCommandRunner: manager(calls), scheduleVerifyRunner: async () => ok, scheduleJournalRunner: async () => ({ ...ok, stdout: "Finished routine" }), env: { ...process.env, GHOST_DESKTOP: "/usr/bin/false" } });
    server = await startDaemonServer({ registry: temp.registry, host, port: 0, apiToken: "test-token",
      remote: new RemoteAccess({ selfLogin: async () => "owner@example.com" }) });
    const path = `http://127.0.0.1:${server.port}/api/ghosts/casper/routines`;
    const owner = { "tailscale-user-login": "owner@example.com", "content-type": "application/json" };
    expect(await (await fetch(path, { headers: owner })).json()).toMatchObject({ routines: [{ slug: "daily" }] });
    expect((await fetch(`${path}/daily/run`, { method: "POST", headers: owner, body: "{}" })).status).toBe(200);
    const config = await (await fetch(`${path}/daily/config`, { headers: owner })).json() as { revision: string; timer: string; service: string };
    const saved = await fetch(`${path}/daily/config`, { method: "PUT", headers: owner,
      body: JSON.stringify({ ...config, timer: "[Timer]\nOnCalendar=weekly\n", service: "[Service]\nExecStart=/usr/bin/true\n" }) });
    expect(saved.status).toBe(200);
    expect(await (await fetch(`${path}/daily/logs`, { headers: owner })).json()).toMatchObject({ text: "Finished routine", sessions: [] });
    const updated = await (await fetch(`${path}/daily/config`, { headers: owner })).json() as { revision: string };
    const removed = await fetch(`${path}/daily?revision=${updated.revision}`, { method: "DELETE", headers: owner });
    expect(removed.status).toBe(200);
    const { recovery } = await removed.json() as { recovery: string };
    expect(await (await fetch(path, { headers: owner })).json()).toMatchObject({ recoveries: expect.arrayContaining([expect.objectContaining({ id: recovery, applicable: true })]) });
    expect((await fetch(`${path}/recoveries/${recovery}/restore`, { method: "POST", headers: owner, body: "{}" })).status).toBe(200);
    const count = calls.length;
    for (const [url, method] of [[path, "GET"], [`${path}/daily/config`, "GET"], [`${path}/daily/logs`, "GET"], [`${path}/daily/config`, "PUT"], [`${path}/daily`, "DELETE"], [`${path}/daily/pause`, "POST"]]) {
      expect((await fetch(url as string, { method, headers: { "tailscale-user-login": "guest@example.com" } })).status).toBe(403);
    }
    expect(calls).toHaveLength(count);
  });
});
