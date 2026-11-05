import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_TOPICS, isHelpTopic, renderHelpTopic } from "../src/help-topics.js";

const INPUT = { ghostName: "aria", unitDir: "/home/owner/.config/systemd/user", cliPath: "/usr/bin/ghost" };

describe("ghost help topics", () => {
  it("knows its topics", () => {
    expect(HELP_TOPICS).toEqual(["timers", "self", "harnesses", "background", "machine", "crashes", "memory", "dictation", "events", "notifications", "peers"]);
    expect(isHelpTopic("timers")).toBe(true);
    expect(isHelpTopic("status")).toBe(false);
  });

  it("timers: both units in the ghost's namespace, the CLI path, and what Persistent= does", () => {
    const text = renderHelpTopic("timers", { ...INPUT, ghostName: "aria-ops", unitDir: "/srv/owner config/systemd/user" });
    expect(text).toContain('"/srv/owner config/systemd/user"');
    expect(text).toContain("ghost-timer-v1-8-aria-ops-<slug>");
    expect(text).toContain("[a-z0-9]+(?:-[a-z0-9]+)*");
    expect(text).toContain("ExecStart=/usr/bin/ghost say --new --ghost aria-ops");
    expect(text).toContain("`Persistent=true` runs one catch-up");
    expect(text).toContain("`Persistent=false` drops them");
    expect(text).toContain("not a timer primitive");
    expect(text).toContain("systemctl --user list-timers");
  });

  it("self: follows repository rules and restarts without a model prompt", () => {
    const text = renderHelpTopic("self", INPUT);
    expect(text).toContain("AGENTS.md and CONTRACTS.md");
    expect(text).toContain("preserve other sessions' edits");
    expect(text).toContain('systemctl --user restart ghostd.service');
    expect(text).toContain('journalctl --user -t ghostd');
    expect(text).toContain('omarchy-restart-shell');
    expect(text).not.toContain('ghost say');
    expect(text).not.toContain('git restore');
    expect(text).not.toContain('branch from upstream master');
  });

  it("background: the detached recipe that wakes the conversation", () => {
    const text = renderHelpTopic("background", INPUT);
    expect(text).toContain("systemd-run --user --scope --quiet --unit=\"ghost-job-<name>-$(date +%s)\" -p CPUWeight=20");
    expect(text).toContain("setsid -f bash -c");
    expect(text).toContain("$XDG_RUNTIME_DIR/<name>.log");
    expect(text).not.toContain("/tmp/job.log");
    expect(text).toContain("`systemctl --user stop <unit>` ends it");
    expect(text).toContain("ghost say --follow-up");
    expect(text).toContain("`$GHOST` and `$GHOST_SESSION`");
    expect(text).toContain("end when this turn's headless run does");
  });

  it("machine: a minutely script in the ghost's namespace that wakes it while heating and near harm, instructs agents, fixes least drastic first", () => {
    const text = renderHelpTopic("machine", INPUT);
    expect(text).toContain("# ghost-timer-v1-4-aria-machine-watch.service");
    expect(text).toContain("ExecStart=/bin/bash %h/.config/ghost/machine-watch.sh");
    expect(text).toContain("OnCalendar=minutely");
    expect(text).toContain("list-unit-files '*-machine-watch.timer'");
    expect(text).toContain("/usr/bin/ghost event machine \"$kind-$(date +%Y%m%d%H)\" --thread \"${kind/heating/heat}\" --ghost aria");
    expect(text).toContain("(( status == 0 || status == 6 ))");
    expect(text).toContain("$t >= $c - 5");
    expect(text).toContain("$fan >= 0.95 * $max");
    expect(text).toContain("a < 0.05 * t");
    expect(text).toContain("$1 + 0 >= 97");
    expect(text).toContain("`systemctl --user freeze <unit>` (`thaw` resumes it exactly)");
    expect(text).toContain("never freeze or stop it");
    expect(text).toContain("ask before throttling or stopping it");
    expect(text).toContain("the command that undoes it");
    expect(text).toContain("~/.config/omarchy/hooks/battery-low.d/");
    expect(text).toContain("instruct that agent now, before anything is throttled");
    expect(text).toContain("--tools SendMessage,ToolSearch");
    expect(text).toContain("ghost say --follow-up -s <id>");
  });

  describe("machine watch script", () => {
    /** Runs the recipe's script with every outside tool stubbed, and returns the events it would send. */
    function watch(home: string, { fan, kernel = "" }: { fan: number; kernel?: string }): { thread: string; id: string; payload: string }[] {
      const bin = join(home, "bin");
      mkdirSync(bin, { recursive: true });
      const events = join(home, "events");
      rmSync(events, { force: true });
      const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
      stub("sensors", `echo '${JSON.stringify({ chip: { "Fan 1": { fan1_input: fan, fan1_max: 1000 }, Heat: { temp1_input: 40 } } })}'`);
      stub("journalctl", `printf '%s' ${JSON.stringify(kernel)}`);
      stub("systemd-cgtop", "true");
      stub("fake-ghost", `printf '%s\\t%s\\t%s\\n' "$5" "$3" "\${10}" >>"${events}"`);
      const text = renderHelpTopic("machine", { ...INPUT, cliPath: join(bin, "fake-ghost") });
      const script = /\`\`\`bash\n([\s\S]*?)\`\`\`/.exec(text)?.[1] ?? "";
      const run = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_RUNTIME_DIR: home } });
      expect(run.status, run.stderr).toBe(0);
      let sent = "";
      try { sent = readFileSync(events, "utf8"); } catch { return []; }
      return sent.trim().split("\n").filter((line) => /^[a-z]+\t/.test(line)).map((line) => {
        const [thread = "", id = "", payload = ""] = line.split("\t");
        return { thread, id, payload };
      });
    }

    it("wakes only after fans stay above half speed, and a cool check resets the count", () => {
      const home = mkdtempSync(join(tmpdir(), "machine-watch-"));
      try {
        expect(watch(home, { fan: 600 })).toEqual([]);
        expect(watch(home, { fan: 600 })).toEqual([]);
        expect(watch(home, { fan: 300 })).toEqual([]);
        expect(watch(home, { fan: 600 })).toEqual([]);
        expect(watch(home, { fan: 600 })).toEqual([]);
        const [event] = watch(home, { fan: 600 });
        expect(event?.thread).toBe("heat");
        expect(event?.id).toMatch(/^heating-\d{10}$/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("wakes on the first kernel thermal warning, as heat rather than heating", () => {
      const home = mkdtempSync(join(tmpdir(), "machine-watch-"));
      try {
        const [event] = watch(home, { fan: 200, kernel: "smc: SMC Thermal pressure initiated Sleep" });
        expect(event?.thread).toBe("heat");
        expect(event?.id).toMatch(/^heat-\d{10}$/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("stays quiet with ordinary fans and a quiet kernel", () => {
      const home = mkdtempSync(join(tmpdir(), "machine-watch-"));
      try {
        for (let check = 0; check < 4; check += 1) expect(watch(home, { fan: 400 })).toEqual([]);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  it("crashes: a minutely journal watch in the ghost's namespace, crashes hourly and failed services daily, diagnosis without changes", () => {
    const text = renderHelpTopic("crashes", INPUT);
    expect(text).toContain("# ghost-timer-v1-4-aria-crash-watch.service");
    expect(text).toContain("ExecStart=/bin/bash %h/.config/ghost/crash-watch.sh");
    expect(text).toContain("StateDirectory=ghost/crash-watch");
    expect(text).toContain("cursor_file=$STATE_DIRECTORY/cursor");
    expect(text).toContain("OnCalendar=minutely");
    expect(text).toContain("list-unit-files '*-crash-watch.timer'");
    expect(text).toContain("crash=fc2e22bc6ee647b6b90729ab34a250b1 failure=d9b373ed55a64feb8242e02dbe79a49c");
    expect(text).toContain("journalctl -q -n 0 --cursor-file=");
    expect(text).toContain("--after-cursor=\"$cursor\" MESSAGE_ID=\"$crash\" MESSAGE_ID=\"$failure\"");
    expect(text).toContain("+%Y%m%d%H");
    expect(text).toContain("+%Y%m%d)");
    expect(text).toContain("$name == *.service && $name != *-crash-watch.service");
    expect(text).toContain("!= core-dump");
    expect(text).toContain("_SYSTEMD_INVOCATION_ID=\"$run\" + USER_INVOCATION_ID=\"$run\"");
    expect(text).toContain("/usr/bin/ghost event \"$source\" \"$name-$id\" --thread \"$name\" --ghost aria");
    expect(text).toContain("[[ $name == cmTC_* ]] && name=\"\"");
    expect(text).toContain("it titles the conversation");
    expect(text).toContain("(( status == 0 || status == 6 )) || { failed=1; break; }");
    expect(text).toContain("ignore='^$'");
    expect(text).toContain("Change, file, restart, or send nothing.");
    expect(text).toContain("the owner's yes in this conversation is what applies it");
    expect(text).toContain("diagnose-crash");
  });

  it("crashes: the watch skips systemd-run's generated units but not named services or their core dumps", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghost-crash-watch-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(dir, "cursor"), "start\n");
      const crash = "fc2e22bc6ee647b6b90729ab34a250b1";
      const failure = "d9b373ed55a64feb8242e02dbe79a49c";
      const failed = (unit: string, cursor: string) => ({ MESSAGE_ID: failure, USER_UNIT: unit, UNIT_RESULT: "oom-kill", __REALTIME_TIMESTAMP: "1793664000000000", __CURSOR: cursor });
      const entries = [
        failed("run-p303424-i315724.service", "c1"),
        failed("run-u42.service", "c2"),
        failed("run-backup.service", "c3"),
        failed("syncthing.service", "c4"),
        { MESSAGE_ID: crash, COREDUMP_COMM: "node", COREDUMP_PID: "7", COREDUMP_UID: "1000", COREDUMP_SIGNAL_NAME: "SIGSEGV", COREDUMP_USER_UNIT: "run-p1-i2.service", MESSAGE: "trace", __REALTIME_TIMESTAMP: "1793664000000000", __CURSOR: "c5" },
      ];
      writeFileSync(join(dir, "journal.json"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      writeFileSync(join(bin, "journalctl"), `#!/bin/bash\n[[ " $* " == *" -o json "* ]] && cat ${JSON.stringify(join(dir, "journal.json"))}\nexit 0\n`, { mode: 0o755 });
      const cli = join(bin, "ghost");
      writeFileSync(cli, `#!/bin/bash\ncat > /dev/null\nprintf '%s %s\\n' "$2" "$3" >> ${JSON.stringify(join(dir, "events"))}\n`, { mode: 0o755 });
      const text = renderHelpTopic("crashes", { ...INPUT, cliPath: cli });
      const script = text.slice(text.indexOf("```bash\n") + 8, text.indexOf("\n```", text.indexOf("```bash\n")));
      writeFileSync(join(dir, "crash-watch.sh"), script);
      const run = spawnSync("/bin/bash", [join(dir, "crash-watch.sh")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STATE_DIRECTORY: dir }, encoding: "utf8" });
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(readFileSync(join(dir, "events"), "utf8").trim().split("\n")).toEqual([
        "unit run-backup.service-20261103",
        "unit syncthing.service-20261103",
        "crash node-2026110300",
      ]);
      expect(readFileSync(join(dir, "cursor"), "utf8")).toBe("c5\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("harnesses: the delegate launch path, its refusals, and the handoff note", () => {
    const text = renderHelpTopic("harnesses", INPUT);
    expect(text).toContain("Your turns run in this conversation's own directory");
    expect(text).toContain("only when it needs those; otherwise do it yourself");
    expect(text).not.toContain("orchestrator");
    expect(text).toContain("cd <project-dir> && ghost delegate <harness> -- <args>");
    expect(text).toContain("respects that project's settings");
    expect(text).toContain("refuses an uninstalled harness (exit 5)");
    expect(text).toContain("exits with its status");
    expect(text).toContain("`ghost harnesses` lists installed agents and informational usage");
    expect(text).toContain("`ghost delegate` gives claude and codex runs your desktop tools");
    expect(text).toContain("--owner-named");
    expect(text).toContain("--permission-mode acceptEdits");
    expect(text).toContain("--allowedTools Bash");
    expect(text).not.toContain("~/.local/state/omarchy");
    expect(text).toContain("handoff note");
    expect(text).toContain("Never spend a window you were not asked to spend.");
  });

  it("harnesses: herdr runs in Ghost's own session with owner-named, owner-authenticated harnesses", () => {
    const text = renderHelpTopic("harnesses", INPUT);
    expect(text).toContain("every command takes `--session ghost`");
    expect(text).toContain("systemd-run --user --unit=herdr-ghost herdr --session ghost server");
    expect(text).toContain("Install only harnesses the owner names, with `mise use -g <harness>`");
    expect(text).toContain("never read, type, or store a credential");
    expect(text).toContain("`--wait` alone is not proof");
    expect(text).toContain("after `ghost harnesses` confirms it is installed");
  });

  it("memory: exact search first, Recall for unknown wording, the source file over any index", () => {
    const text = renderHelpTopic("memory", INPUT);
    expect(text).toContain("`board.md` at its root");
    expect(text).toContain("rg -n -i '<term>' <folder>");
    expect(text).toContain("Recall through its `recall` skill");
    expect(text).toContain("without it, use filenames and `rg`");
    expect(text).toContain("then the source file itself before relying on one");
    expect(text).toContain("whenever a task needs them, from the first turn on");
    expect(text).toContain("keep both claims and tell the owner which is uncertain");
    expect(text).toContain("dead end (what was tried, why it failed)");
    expect(text).toContain("dating what you add");
    expect(text).toContain("only when the owner asks or a timer they approved runs it");
    expect(text).toContain("Trash with `gio trash`, never `rm`");
    expect(text).toContain("keep its original restorable: `cp -p \"$f\" \"$f~\" && gio trash \"$f~\"`");
    expect(text).toContain("mark a superseded fact with what replaced it and when");
    expect(text).toContain("only an empty note or a duplicate you merged. Then report each changed and trashed path");
    expect(text).toContain("daily timer (`ghost help timers`, `OnCalendar=daily`)");
    expect(text).toContain("only if `systemctl --user list-unit-files '*-tidy-notes.timer'` lists none; never install it unasked");
    expect(text).toContain("Never preload the directory, read it wholesale, or keep an index or memory store of your own");
    expect(text).toContain("A Recall index over folders the owner chose, the whole directory included, is theirs to search");
    expect(text).toContain("`skills/<name>/SKILL.md`");
  });

  it("dictation: transcribes audio with the installed Voxtype and toggles spoken submit only on request", () => {
    const text = renderHelpTopic("dictation", INPUT);
    expect(text).toContain("ffmpeg -i <input> -ar 16000 -ac 1 /tmp/<name>.wav");
    expect(text).toContain("voxtype -q transcribe /tmp/<name>.wav");
    expect(text).toContain("Read the output before using it");
    expect(text).not.toContain("Processing");
    expect(text).not.toMatch(/video/iu);
    expect(text).toContain("Only when the owner asks");
    expect(text).toContain("`voxtype config set text.smart_auto_submit true`");
    expect(text).toContain("`voxtype config set text.smart_auto_submit false`");
    expect(text).toContain("`systemctl --user restart voxtype`");
  });
});
