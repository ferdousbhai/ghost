import { describe, expect, it } from "vitest";
import { RemoteServe } from "../src/remote-serve.js";
import type { CommandRunner } from "../src/tailscale-identity.js";
import { FAKE_TARGET, fakeTailscale, missingBinary, ok } from "./helpers/fake-tailscale.js";

describe("RemoteServe status", () => {
  it("derives an HTTPS URL, owner, and guest policy from Tailscale JSON", async () => {
    const status = await new RemoteServe(7717, {
      run: fakeTailscale({ scheme: "https" }).run,
      guests: "none",
    }).status();

    expect(status).toEqual({
      enabled: true,
      state: "on",
      scheme: "https",
      hostname: "ghostbox.example.ts.net",
      url: "https://ghostbox.example.ts.net/",
      tailscale: { installed: true, running: true, loggedIn: true, operator: true, certs: true },
      guests: "none",
      owner: "owner@example.com",
      problem: null,
    });
  });

  it("uses plain HTTP on port 80 when the tailnet has no certificates", async () => {
    const status = await new RemoteServe(7717, { run: fakeTailscale({ certs: false, scheme: "http" }).run }).status();
    expect(status).toMatchObject({ enabled: true, scheme: "http", url: "http://ghostbox.example.ts.net/", tailscale: { certs: false } });
  });

  it("reports a stopped daemon as unavailable", async () => {
    const status = await new RemoteServe(7717, { run: fakeTailscale({ backendState: "Stopped" }).run }).status();
    expect(status).toMatchObject({
      enabled: false,
      state: "unavailable",
      tailscale: { installed: true, running: false },
      problem: { code: "tailscale_stopped" },
    });
  });

  it("reports a missing tailscale binary with its install action", async () => {
    const status = await new RemoteServe(7717, { run: missingBinary() }).status();
    expect(status).toMatchObject({
      state: "unavailable",
      tailscale: { installed: false },
      problem: { code: "tailscale_missing", action: "omarchy-install-service-tailscale" },
    });
  });
});

describe("RemoteServe mutations", () => {
  it("uses the HTTPS and HTTP command lines selected by certificate availability", async () => {
    for (const certs of [true, false]) {
      const fake = fakeTailscale({ certs });
      const status = await new RemoteServe(7717, { run: fake.run }).enable();
      expect(fake.calls).toContainEqual(certs
        ? ["serve", "--bg", "--https=443", FAKE_TARGET]
        : ["serve", "--bg", "--http=80", FAKE_TARGET]);
      expect(status).toMatchObject({ enabled: true, scheme: certs ? "https" : "http", problem: null });
    }
  });

  it("turns off only the listener that is on, and nothing when none is", async () => {
    const fake = fakeTailscale({ certs: false, scheme: "http" });
    const remote = new RemoteServe(7717, { run: fake.run });
    expect(await remote.disable()).toMatchObject({ enabled: false, state: "off", problem: null });
    expect(fake.calls.filter((args) => args[0] === "serve" && args[2] === "off")).toEqual([["serve", "--http=80", "off"]]);
    fake.calls.length = 0;
    await remote.disable();
    expect(fake.calls.some((args) => args[2] === "off")).toBe(false);
  });

  it("turns an operator failure into the stable problem and remembers it until a write is accepted", async () => {
    const fake = fakeTailscale();
    let denied = true;
    const run: CommandRunner = async (args) => (args[1] === "--bg" && denied
      ? { stdout: "", stderr: "Access denied.\nUse 'sudo tailscale set --operator=$USER'.", code: 1 }
      : fake.run(args));
    const remote = new RemoteServe(7717, { run });
    expect(await remote.enable()).toMatchObject({
      tailscale: { operator: false },
      problem: { code: "operator_required", message: "Access denied.", action: "sudo tailscale set --operator=$USER" },
    });
    expect(await remote.status()).toMatchObject({ state: "off", tailscale: { operator: false }, problem: { code: "operator_required" } });
    denied = false;
    expect(await remote.enable()).toMatchObject({ state: "on", tailscale: { operator: true }, problem: null });
  });

  it("re-applies Serve only when the scheme the tailnet supports changed", async () => {
    const fake = fakeTailscale({ certs: false, scheme: "http" });
    const remote = new RemoteServe(7717, { run: fake.run });
    await remote.ensure();
    expect(fake.calls.filter((args) => args[0] === "serve" && args[1] !== "status")).toEqual([]);
    fake.certs = true;
    await remote.ensure();
    expect(fake.calls.filter((args) => args[0] === "serve" && args[1] !== "status")).toEqual([
      ["serve", "--http=80", "off"],
      ["serve", "--bg", "--https=443", FAKE_TARGET],
    ]);
  });
});

describe("RemoteServe QR", () => {
  it("returns qrencode SVG output with the exact URL command line", async () => {
    const calls: string[][] = [];
    const qrRun: CommandRunner = async (args) => {
      calls.push([...args]);
      return ok("<svg>qr</svg>");
    };
    const remote = new RemoteServe(7717, { run: fakeTailscale().run, qrRun });
    await expect(remote.qrSvg("https://ghostbox.example.ts.net/")).resolves.toBe("<svg>qr</svg>");
    expect(calls).toEqual([["-t", "SVG", "-o", "-", "https://ghostbox.example.ts.net/"]]);
  });
});
