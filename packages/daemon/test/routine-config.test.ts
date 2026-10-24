import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { which } from "../src/harnesses.js";
import { discardRoutineRecoveries, listRoutineRecoveries, readRoutineConfig, removeRoutine, restoreRoutine, saveRoutineConfig } from "../src/routine-config.js";
import type { CommandRunner } from "../src/tailscale-identity.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const timer = "ghost-timer-v1-6-casper-daily.timer", service = timer.replace(".timer", ".service");
const originalTimer = "[Timer]\nOnCalendar=daily\n[Install]\nWantedBy=timers.target\n";
const originalService = "[Service]\nType=oneshot\nExecStart=/usr/bin/true\n";
const ok = { stdout: "", stderr: "", code: 0 };
async function setup() {
  const unitDir = await mkdtemp(join(tmpdir(), "ghost-routine-config-")); roots.push(unitDir);
  await writeFile(join(unitDir, timer), originalTimer); await writeFile(join(unitDir, service), originalService);
  const calls: string[][] = [];
  let rejectReload = false;
  const run: CommandRunner = async (args) => {
    calls.push([...args]);
    if (args.includes("show")) return { ...ok, stdout: `Id=${timer}\nUnit=${service}\nUnitFileState=enabled\nActiveState=active\nDropInPaths=\n\nId=${service}\nDropInPaths=\n` };
    if (rejectReload && args.includes("daemon-reload")) { rejectReload = false; return { ...ok, code: 1, stderr: "manager failed" }; }
    return ok;
  };
  return { options: { unitDir, run, verify: async () => ok }, calls, failReload() { rejectReload = true; } };
}
describe("native routine source edits and recovery", () => {
  it("validates, checkpoints, replaces, reloads and resumes an active timer", async () => {
    const { options, calls } = await setup(), config = await readRoutineConfig("casper", "daily", options);
    const changed = { ...config, timer: originalTimer.replace("daily", "weekly") };
    const result = await saveRoutineConfig("casper", "daily", changed, options);
    expect(await readFile(join(options.unitDir, timer), "utf8")).toBe(changed.timer);
    expect((await lstat(join(options.unitDir, timer))).mode & 0o777).toBe(0o600);
    expect(calls.filter(call => !call.includes("show")).slice(-3)).toEqual([["--user", "stop", timer], ["--user", "daemon-reload"], ["--user", "start", timer]]);
    expect(await listRoutineRecoveries("casper", options)).toMatchObject([{ id: result.recovery, slug: "daily", reason: "edit", applicable: true }]);
    const restored = await restoreRoutine("casper", result.recovery, options);
    expect((await readRoutineConfig("casper", "daily", options)).timer).toBe(originalTimer);
    expect(calls.at(-1)).toEqual(["--user", "disable", "--now", timer]);
    expect(await listRoutineRecoveries("casper", options)).toHaveLength(2);
    await restoreRoutine("casper", restored.recovery, options);
    expect((await readRoutineConfig("casper", "daily", options)).timer).toBe(changed.timer);
  });
  it("removes both files and restores them paused without deleting older checkpoints", async () => {
    const { options, calls } = await setup(), config = await readRoutineConfig("casper", "daily", options);
    const removed = await removeRoutine("casper", "daily", config.revision, options);
    expect(await readdir(options.unitDir)).toEqual([".ghost-routine-recovery"]);
    await restoreRoutine("casper", removed.recovery, options);
    expect(await readFile(join(options.unitDir, service), "utf8")).toBe(originalService);
    expect(calls.at(-1)).toEqual(["--user", "disable", "--now", timer]);
    const rows = await listRoutineRecoveries("casper", options);
    expect(rows).toHaveLength(2);
    const undoRestore = rows.find(row => row.reason === "restore");
    await restoreRoutine("casper", undoRestore!.id, options);
    await expect(readRoutineConfig("casper", "daily", options)).rejects.toMatchObject({ status: 404 });
  });
  it("restores removed source without trying to inspect nonexistent manager units", async () => {
    const { options } = await setup(), config = await readRoutineConfig("casper", "daily", options);
    const saved = await removeRoutine("casper", "daily", config.revision, options);
    await restoreRoutine("casper", saved.recovery, { ...options, run: async (args) => {
      if (args.includes("show") && !(await readdir(options.unitDir)).includes(timer)) return { ...ok, code: 4, stderr: "Unit not found" };
      if (args.includes("show")) return options.run(args);
      return ok;
    } });
    expect((await readRoutineConfig("casper", "daily", options)).timer).toBe(originalTimer);
  });
  it("retains a named checkpoint when both a change and its rollback fail", async () => {
    const { options } = await setup(), config = await readRoutineConfig("casper", "daily", options);
    await expect(saveRoutineConfig("casper", "daily", { ...config, timer: originalTimer.replace("daily", "weekly") }, {
      ...options, run: async (args) => args.includes("daemon-reload") ? { ...ok, code: 1, stderr: "manager unavailable" } : options.run(args),
    })).rejects.toMatchObject({ code: "routine_recovery_required", status: 503 });
    const checkpointDir = join(options.unitDir, ".ghost-routine-recovery");
    expect(await readdir(checkpointDir)).toHaveLength(1);
    const snapshot = JSON.parse(await readFile(join(checkpointDir, (await readdir(checkpointDir))[0]!), "utf8"));
    expect(snapshot.timer).toBe(originalTimer);
  });
  it("refuses stale edits/removal and a restore that would overwrite a native edit", async () => {
    const { options } = await setup(), config = await readRoutineConfig("casper", "daily", options);
    const saved = await saveRoutineConfig("casper", "daily", { ...config, timer: originalTimer.replace("daily", "weekly") }, options);
    await expect(saveRoutineConfig("casper", "daily", config, options)).rejects.toMatchObject({ status: 409 });
    await expect(removeRoutine("casper", "daily", config.revision, options)).rejects.toMatchObject({ status: 409 });
    await writeFile(join(options.unitDir, timer), originalTimer.replace("daily", "hourly"));
    await expect(restoreRoutine("casper", saved.recovery, options)).rejects.toMatchObject({ status: 409 });
    expect((await listRoutineRecoveries("casper", options))[0]?.applicable).toBe(false);
  });
  it("keeps units and timer state on verification failure and rolls back a failed reload", async () => {
    const fixture = await setup(), config = await readRoutineConfig("casper", "daily", fixture.options);
    await expect(saveRoutineConfig("casper", "daily", config, { ...fixture.options, verify: async () => ({ ...ok, code: 1, stderr: "bad calendar" }) })).rejects.toThrow("bad calendar");
    expect(fixture.calls).toHaveLength(0);
    fixture.failReload();
    await expect(saveRoutineConfig("casper", "daily", { ...config, timer: originalTimer.replace("daily", "weekly") }, fixture.options)).rejects.toThrow("manager failed");
    expect((await readRoutineConfig("casper", "daily", fixture.options)).timer).toBe(originalTimer);
    expect(await listRoutineRecoveries("casper", fixture.options)).toEqual([]);
    expect(fixture.calls.at(-1)).toEqual(["--user", "start", timer]);
  });
  it("rejects links, drop-ins, redirected targets, invalid sources and cross-ghost recovery", async () => {
    const { options } = await setup(), config = await readRoutineConfig("casper", "daily", options);
    await expect(saveRoutineConfig("casper", "daily", { ...config, timer: "[Timer]\nUnit=other.service\nOnCalendar=daily" }, { ...options, run: async args => {
      const result = await options.run(args);
      return args.includes("show") && (await readFile(join(options.unitDir, timer), "utf8")).includes("Unit=other.service") ? { ...ok, stdout: `Id=${timer}\nUnit=other.service\n` } : result;
    } })).rejects.toMatchObject({ status: 400 });
    await expect(saveRoutineConfig("casper", "daily", { ...config, service: "\0" }, options)).rejects.toMatchObject({ status: 400 });
    const withDropIn = { ...options, run: async () => ({ ...ok, stdout: `Id=${timer}\nDropInPaths=/owner/override.conf\n` }) };
    await expect(saveRoutineConfig("casper", "daily", config, withDropIn)).rejects.toThrow("drop-ins");
    const result = await removeRoutine("casper", "daily", config.revision, options);
    await expect(restoreRoutine("other", result.recovery, options)).rejects.toMatchObject({ status: 404 });
    await expect(restoreRoutine("casper", "../../outside", options)).rejects.toMatchObject({ status: 400 });
    await symlink(join(options.unitDir, ".ghost-routine-recovery"), join(options.unitDir, timer));
    await expect(readRoutineConfig("casper", "daily", options)).rejects.toThrow("native tools");
  });
  it.skipIf(which("systemd-analyze", process.env) === null)("uses native offline verification before changing real unit source files", async () => {
    const { options } = await setup(), config = await readRoutineConfig("casper", "daily", options);
    // A build chroot has no user runtime dir, which `systemd-analyze --user` creates state under.
    const runtime = await mkdtemp(join(tmpdir(), "ghost-routine-runtime-")); roots.push(runtime);
    const verify: CommandRunner = args => new Promise(resolve => execFile("systemd-analyze", [...args], { env: { ...process.env, XDG_RUNTIME_DIR: runtime } }, (error, stdout, stderr) => resolve({ stdout, stderr, code: error ? 1 : 0 })));
    await saveRoutineConfig("casper", "daily", { ...config, timer: originalTimer.replace("daily", "weekly") }, { ...options, verify });
    const latest = await readRoutineConfig("casper", "daily", options);
    await expect(saveRoutineConfig("casper", "daily", { ...latest, timer: "[Timer]\nOnCalendar=definitely-not-a-calendar\n" }, { ...options, verify })).rejects.toMatchObject({ status: 400 });
    expect((await readRoutineConfig("casper", "daily", options)).timer).toBe(latest.timer);
  });
  it("does not overwrite a native save when stopping fails or source changes during stop", async () => {
    for (const fail of [true, false]) {
      const { options } = await setup(), config = await readRoutineConfig("casper", "daily", options);
      const native = "[Timer]\nOnCalendar=hourly\n";
      await expect(saveRoutineConfig("casper", "daily", config, { ...options, run: async args => {
        if (args.includes("stop")) {
          await writeFile(join(options.unitDir, timer), native);
          return fail ? { ...ok, code: 1, stderr: "stop failed" } : ok;
        }
        return options.run(args);
      } })).rejects.toMatchObject({ status: fail ? 503 : 409 });
      expect(await readFile(join(options.unitDir, timer), "utf8")).toBe(native);
    }
  });
  it("can remove and recover a bounded empty unit source", async () => {
    const { options } = await setup();
    await writeFile(join(options.unitDir, service), "");
    const config = await readRoutineConfig("casper", "daily", options);
    const saved = await removeRoutine("casper", "daily", config.revision, options);
    expect((await listRoutineRecoveries("casper", options))[0]).toMatchObject({ id: saved.recovery, applicable: true });
    await restoreRoutine("casper", saved.recovery, options);
    expect(await readRoutineConfig("casper", "daily", options)).toMatchObject({ timer: originalTimer, service: "" });
  });
  it("lists the readable checkpoints beside a malformed one or a linked unit", async () => {
    const { options } = await setup(), config = await readRoutineConfig("casper", "daily", options);
    const saved = await saveRoutineConfig("casper", "daily", { ...config, timer: originalTimer.replace("daily", "weekly") }, options);
    await writeFile(join(options.unitDir, ".ghost-routine-recovery", "00000000-0000-0000-0000-000000000000.json"), "{");
    await writeFile(join(options.unitDir, ".ghost-routine-recovery", "00000000-0000-0000-0000-000000000001.json"), Buffer.from([0xff, 0xfe]));
    await rm(join(options.unitDir, service));
    await symlink(join(options.unitDir, timer), join(options.unitDir, service));
    expect(await listRoutineRecoveries("casper", options)).toMatchObject([{ id: saved.recovery, applicable: false }]);
  });
  it("marks a checkpoint inapplicable when its current unit is not valid UTF-8", async () => {
    const { options } = await setup(), config = await readRoutineConfig("casper", "daily", options);
    const saved = await saveRoutineConfig("casper", "daily", { ...config, timer: originalTimer.replace("daily", "weekly") }, options);
    await writeFile(join(options.unitDir, timer), Buffer.from([0xff, 0xfe]));
    expect(await listRoutineRecoveries("casper", options)).toMatchObject([{ id: saved.recovery, applicable: false }]);
    await expect(readRoutineConfig("casper", "daily", options)).rejects.toMatchObject({ status: 400 });
  });
  it("discards only the retired ghost's checkpoints", async () => {
    const { options } = await setup(), config = await readRoutineConfig("casper", "daily", options);
    await removeRoutine("casper", "daily", config.revision, options);
    const other = "ghost-timer-v1-5-aria1-daily";
    await writeFile(join(options.unitDir, `${other}.timer`), originalTimer); await writeFile(join(options.unitDir, `${other}.service`), originalService);
    const kept = await removeRoutine("aria1", "daily", (await readRoutineConfig("aria1", "daily", options)).revision, options);
    await discardRoutineRecoveries("casper", options);
    expect(await listRoutineRecoveries("casper", options)).toEqual([]);
    expect(await listRoutineRecoveries("aria1", options)).toMatchObject([{ id: kept.recovery }]);
  });
  it("keeps a native save made after the write when a later step fails", async () => {
    const { options } = await setup(), config = await readRoutineConfig("casper", "daily", options);
    const native = "[Timer]\nOnCalendar=hourly\n";
    await expect(saveRoutineConfig("casper", "daily", { ...config, timer: originalTimer.replace("daily", "weekly") }, { ...options, run: async args => {
      if (!args.includes("daemon-reload")) return options.run(args);
      await writeFile(join(options.unitDir, timer), native);
      return { ...ok, code: 1, stderr: "manager failed" };
    } })).rejects.toMatchObject({ code: "routine_recovery_required" });
    expect(await readFile(join(options.unitDir, timer), "utf8")).toBe(native);
  });
  it("checks a native editor's save made while verification was running", async () => {
    const { options } = await setup(), config = await readRoutineConfig("casper", "daily", options);
    await expect(saveRoutineConfig("casper", "daily", config, { ...options, verify: async () => {
      await writeFile(join(options.unitDir, timer), "[Timer]\nOnCalendar=hourly\n"); return ok;
    } })).rejects.toMatchObject({ status: 409 });
  });
});
