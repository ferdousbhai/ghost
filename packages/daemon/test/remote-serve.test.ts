import { describe, expect, it } from "vitest";
import { RemoteServe } from "../src/remote-serve.js";
import type { CommandRunner } from "../src/command-runner.js";
import { FAKE_TARGET, fakeTailscale, missingBinary } from "./helpers/fake-tailscale.js";

describe("RemoteServe status", () => {
  it("derives an HTTPS URL, owner, and guest policy from Tailscale JSON", async () => {
    const status = await new RemoteServe(7717, {
      run: fakeTailscale({ https: true }).run,
      guests: "none",
    }).status();

    expect(status).toEqual({
      state: "on",
      hostname: "ghostbox.example.ts.net",
      guests: "none",
      owner: "owner@example.com",
      app: null,
      problem: null,
    });
  });

  it("links the first app to this machine only once Serve is on HTTPS", async () => {
    const apps = ["https://summonghost.com", "https://lab.summonghost.com"];
    expect((await new RemoteServe(7717, { run: fakeTailscale({ https: true }).run, apps }).status()).app)
      .toEqual({ origin: "https://summonghost.com", url: "https://summonghost.com/#add=ghostbox.example.ts.net" });
    for (const listeners of [{ http: true, certs: false }, {}]) {
      expect((await new RemoteServe(7717, { run: fakeTailscale(listeners).run, apps }).status()).app)
        .toEqual({ origin: "https://summonghost.com", url: null });
    }
  });

  it("links a conversation in the first app only while there is an app link", async () => {
    const linked = new RemoteServe(7717, { run: fakeTailscale({ https: true }).run, apps: ["https://summonghost.com"] });
    expect(await linked.conversationUrl("casper", "c 1"))
      .toBe("https://summonghost.com/#/ghostbox.example.ts.net/casper/c%201");
    for (const serve of [
      new RemoteServe(7717, { run: fakeTailscale({ https: true }).run, apps: [] }),
      new RemoteServe(7717, { run: fakeTailscale({ certs: false, http: true }).run, apps: ["https://summonghost.com"] }),
      new RemoteServe(7717, { run: fakeTailscale().run, apps: ["https://summonghost.com"] }),
    ]) expect(await serve.conversationUrl("casper", "c1")).toBeNull();
  });

  it("reports a plain-HTTP entry an earlier version wrote as off, since no app can use it", async () => {
    const status = await new RemoteServe(7717, { run: fakeTailscale({ certs: false, http: true }).run }).status();
    expect(status).toMatchObject({ state: "off", problem: null });
  });

  it("reports a stopped daemon as unavailable", async () => {
    const status = await new RemoteServe(7717, { run: fakeTailscale({ backendState: "Stopped" }).run }).status();
    expect(status).toMatchObject({
      state: "unavailable",
      problem: { code: "tailscale_stopped" },
    });
  });

  it("reports a missing tailscale binary with its install action", async () => {
    const status = await new RemoteServe(7717, { run: missingBinary() }).status();
    expect(status).toMatchObject({
      state: "unavailable",
      problem: { code: "tailscale_missing", action: "omarchy-install-service-tailscale" },
    });
  });
});

describe("RemoteServe machines", () => {
  it("lists the owner's other untagged nodes, online or not", async () => {
    expect(await new RemoteServe(7717, { run: fakeTailscale().run }).machines()).toEqual([
      { hostname: "laptop.example.ts.net", online: true },
      { hostname: "phone.example.ts.net", online: false },
    ]);
    expect(await new RemoteServe(7717, { run: fakeTailscale().run, owner: "Partner@Example.com" }).machines())
      .toEqual([{ hostname: "partner.example.ts.net", online: true }]);
  });

  it("is a 503 when Tailscale does not answer", async () => {
    await expect(new RemoteServe(7717, { run: missingBinary() }).machines()).rejects.toMatchObject({ code: "tailscale_unavailable", status: 503 });
  });
});

describe("RemoteServe mutations", () => {
  it("serves over HTTPS, and without certificates writes nothing and says how to get them", async () => {
    const served = fakeTailscale({ certs: true });
    expect(await new RemoteServe(7717, { run: served.run }).enable()).toMatchObject({ state: "on", problem: null });
    expect(served.calls).toContainEqual(["serve", "--bg", "--https=443", FAKE_TARGET]);

    const refused = fakeTailscale({ certs: false });
    expect(await new RemoteServe(7717, { run: refused.run }).enable()).toMatchObject({
      state: "off",
      problem: { code: "https_required", message: expect.stringContaining("HTTPS Certificates") },
    });
    expect(refused.calls.filter((args) => args[0] === "serve" && args[1] !== "status")).toEqual([]);
  });

  it("clears a plain-HTTP entry an earlier version wrote, on enable and on disable", async () => {
    for (const certs of [true, false]) {
      const fake = fakeTailscale({ certs, http: true });
      await new RemoteServe(7717, { run: fake.run }).enable();
      expect(fake.calls.filter((args) => args[0] === "serve" && args[1] !== "status")).toEqual([
        ["serve", "--http=80", "off"],
        ...(certs ? [["serve", "--bg", "--https=443", FAKE_TARGET]] : []),
      ]);
    }
    const fake = fakeTailscale({ certs: false, http: true });
    const remote = new RemoteServe(7717, { run: fake.run });
    expect(await remote.disable()).toMatchObject({ state: "off", problem: null });
    expect(fake.calls.filter((args) => args[0] === "serve" && args[2] === "off")).toEqual([["serve", "--http=80", "off"]]);
    expect(fake.http).toBe(false);
  });

  it("turns off both listeners when an HTTPS one and an earlier version's HTTP one are on", async () => {
    const fake = fakeTailscale({ https: true, http: true });
    const remote = new RemoteServe(7717, { run: fake.run });
    expect(await remote.status()).toMatchObject({ state: "on" });
    expect(await remote.disable()).toMatchObject({ state: "off", problem: null });
    expect(fake.calls.filter((args) => args[0] === "serve" && args[2] === "off"))
      .toEqual([["serve", "--https=443", "off"], ["serve", "--http=80", "off"]]);
    expect([fake.https, fake.http]).toEqual([false, false]);
  });

  it("turns off only the listener that is on, and nothing when none is", async () => {
    const fake = fakeTailscale({ https: true });
    const remote = new RemoteServe(7717, { run: fake.run });
    expect(await remote.disable()).toMatchObject({ state: "off", problem: null });
    expect(fake.calls.filter((args) => args[0] === "serve" && args[2] === "off")).toEqual([["serve", "--https=443", "off"]]);
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
      problem: { code: "operator_required", message: "Access denied.", action: "sudo tailscale set --operator=$USER" },
    });
    expect(await remote.status()).toMatchObject({ state: "off", problem: { code: "operator_required" } });
    denied = false;
    expect(await remote.enable()).toMatchObject({ state: "on", problem: null });
  });

});
