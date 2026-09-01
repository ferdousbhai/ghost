import { chmod, link, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  boundedSignal,
  classifyLauncherStderr,
  classifyScopeStatus,
  readStageDiagnostic,
  serializeLifecycleDiagnostic,
  type LifecycleDiagnostic,
} from "./native-task-scope-integration-diagnostic.js";

const UNIT = "ghost-task-11111111-1111-4111-8111-111111111111.scope";
const RECEIPT = "ghost-task-receipt:v1:task-11111111-1111-4111-8111-111111111111:11111111111111111111111111111111";
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function privateRoot(): Promise<string> {
  const root = join(tmpdir(), `ghost-scope-diagnostic-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  roots.push(root);
  return root;
}

function validStatus(): string {
  return `Id=${UNIT}\nLoadState=loaded\nActiveState=active\nDescription=${RECEIPT}\n`;
}

function diagnostic(): LifecycleDiagnostic {
  return {
    version: 1,
    launcherExitCode: 1,
    launcherSignal: "none",
    launcherFailure: "registration",
    scopeObservedOwnedLoaded: false,
    scopeStatus: classifyScopeStatus(UNIT, RECEIPT, {
      stdout: validStatus(),
      exitCode: 0,
    }),
    fixture: {
      state: "valid",
      private: true,
      stage: "waiting_input",
      failure: "stdin_or_protocol",
    },
  };
}

describe("real systemd integration diagnostics", () => {
  it("classifies bounded launcher output without projecting raw text", () => {
    expect(classifyLauncherStderr("Failed to start transient scope unit: denied", false))
      .toBe("registration");
    expect(classifyLauncherStderr("Failed at step CHDIR spawning /private/path", false))
      .toBe("exec_or_chdir");
    expect(classifyLauncherStderr("JSONDecodeError: private input", false))
      .toBe("stdin_or_protocol");
    expect(classifyLauncherStderr("Resource temporarily unavailable", false))
      .toBe("resource");
    expect(classifyLauncherStderr("", false)).toBe("none");
    expect(classifyLauncherStderr("owner-secret=/private/path", false)).toBe("other");
    expect(classifyLauncherStderr("Failed to start transient scope unit", true)).toBe("other");

    const serialized = serializeLifecycleDiagnostic(diagnostic());
    expect(serialized).not.toContain("denied");
    expect(serialized).not.toContain("/private/path");
    expect(serialized).not.toContain("owner-secret");
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(2 * 1024);

    const hostile = diagnostic() as unknown as Record<string, unknown>;
    hostile.launcherSignal = "/private/path";
    hostile.launcherFailure = "owner-secret";
    hostile.scopeStatus = {
      ...(hostile.scopeStatus as object),
      activeState: "owner-secret",
      description: "/private/path",
    };
    hostile.fixture = {
      state: "owner-secret",
      private: "yes",
      stage: "/private/path",
      failure: "owner-secret",
    };
    const hostileSerialized = serializeLifecycleDiagnostic(
      hostile as unknown as LifecycleDiagnostic,
    );
    expect(hostileSerialized).not.toContain("owner-secret");
    expect(hostileSerialized).not.toContain("/private/path");
  });

  it("accepts only canonical private regular stage receipts", async () => {
    const root = await privateRoot();
    const stage = join(root, "stage.json");
    const source = JSON.stringify({ failure: "none", stage: "entered", version: 1 });
    await writeFile(stage, source, { mode: 0o600 });
    await expect(readStageDiagnostic(stage)).resolves.toEqual({
      state: "valid",
      private: true,
      stage: "entered",
      failure: "none",
    });

    await chmod(stage, 0o644);
    await expect(readStageDiagnostic(stage)).resolves.toMatchObject({
      state: "invalid",
      private: false,
    });
    await chmod(stage, 0o600);
    const linked = join(root, "linked.json");
    await link(stage, linked);
    await expect(readStageDiagnostic(stage)).resolves.toMatchObject({ state: "invalid" });
    await rm(linked);
    await rm(stage);
    await symlink("missing", stage);
    await expect(readStageDiagnostic(stage)).resolves.toMatchObject({ state: "invalid" });
  });

  it("rejects raw or noncanonical stage payloads without projecting them", async () => {
    const root = await privateRoot();
    const stage = join(root, "stage.json");
    await writeFile(stage, JSON.stringify({
      failure: "owner-secret",
      stage: "/private/path",
      version: 1,
    }), { mode: 0o600 });
    const fixture = await readStageDiagnostic(stage);
    expect(fixture).toEqual({
      state: "invalid",
      private: false,
      stage: "none",
      failure: "other",
    });
    const serialized = serializeLifecycleDiagnostic({ ...diagnostic(), fixture });
    expect(serialized).not.toContain("owner-secret");
    expect(serialized).not.toContain("/private/path");
  });

  it("reduces exact scope properties to bounded comparisons", () => {
    expect(classifyScopeStatus(UNIT, RECEIPT, {
      stdout: validStatus(),
      exitCode: 0,
    })).toEqual({
      exitCode: 0,
      shape: "valid",
      id: "unit",
      loadState: "loaded",
      activeState: "active",
      description: "receipt",
    });
    expect(classifyScopeStatus(UNIT, RECEIPT, {
      stdout: `Description=${UNIT}\nActiveState=inactive\nId=${UNIT}\nLoadState=not-found\n`,
      exitCode: 0,
    })).toMatchObject({
      shape: "valid",
      id: "unit",
      loadState: "not-found",
      activeState: "inactive",
      description: "unit",
    });
    expect(classifyScopeStatus(UNIT, RECEIPT, {
      stdout: `${validStatus()}RawSecret=/private/path\n`,
      exitCode: 0,
    })).toMatchObject({ shape: "invalid" });
    expect(serializeLifecycleDiagnostic(diagnostic())).not.toContain(UNIT);
    expect(serializeLifecycleDiagnostic(diagnostic())).not.toContain(RECEIPT);
  });

  it("bounds launcher signals to a safe enum shape", () => {
    expect(boundedSignal("SIGKILL")).toBe("SIGKILL");
    expect(boundedSignal("SIGTERM")).toBe("SIGTERM");
    expect(boundedSignal("/private/path")).toBe("none");
    expect(boundedSignal(null)).toBe("none");
  });
});
