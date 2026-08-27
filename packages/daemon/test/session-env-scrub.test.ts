import { afterEach, describe, expect, it } from "vitest";
import { findProviderCredentialEnv } from "../src/env-scrub.js";
import { SessionHost } from "../src/session-host.js";
import { makeTempGhosts, type TempGhosts } from "./helpers/fixtures.js";

let temp: TempGhosts | null = null;
let host: SessionHost | null = null;

afterEach(async () => {
  await host?.disposeAll();
  host = null;
  temp?.cleanup();
  temp = null;
});

describe("SessionHost provider environment", () => {
  it("removes nonstandard catalog tokens before a Pi session can be created", () => {
    const parentEnv = { ...process.env };
    const hostile = {
      GITLAB_TOKEN: "hostile-gitlab",
      HF_TOKEN: "hostile-hf",
      HUGGINGFACE_HUB_TOKEN: "hostile-huggingface",
    } as const;
    Object.assign(process.env, hostile);

    try {
      temp = makeTempGhosts();
      host = new SessionHost({
        registry: temp.registry,
        ownerHome: temp.ownerHome,
        offline: true,
      });

      for (const name of Object.keys(hostile)) expect(process.env[name]).toBeUndefined();
      expect(findProviderCredentialEnv(process.env)).toEqual([]);
    } finally {
      for (const name of Object.keys(process.env)) {
        if (!(name in parentEnv)) delete process.env[name];
      }
      Object.assign(process.env, parentEnv);
    }
    expect(process.env).toMatchObject(parentEnv);
  });
});
