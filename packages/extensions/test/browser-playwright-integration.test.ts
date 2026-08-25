/**
 * Opt-in system-Chromium coverage for policy that a fake BrowserContext cannot
 * prove. Run with GHOST_BROWSER_INTEGRATION=1; the ordinary suite still pins the
 * launch option without requiring a browser on every developer machine.
 */
import { rm, mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  findChromiumExecutable,
  PlaywrightBrowserBackend,
} from "../src/extensions/browser-playwright.js";

const integration = process.env["GHOST_BROWSER_INTEGRATION"] === "1";
const describeIntegration = integration ? describe : describe.skip;

let backend: PlaywrightBrowserBackend | undefined;
let seedingContext: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
let server: Server | undefined;
let profileDir: string | undefined;

afterEach(async () => {
  await seedingContext?.close();
  seedingContext = undefined;
  await backend?.close();
  backend = undefined;
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
  }
  server = undefined;
  if (profileDir) await rm(profileDir, { recursive: true, force: true });
  profileDir = undefined;
});

describeIntegration("Playwright network-policy integration", () => {
  it("removes a persisted controller before it can bypass context routing", async () => {
    const executablePath = await findChromiumExecutable();
    if (!executablePath) throw new Error("GHOST_BROWSER_INTEGRATION needs system Chromium");

    let workerRequests = 0;
    server = createServer((request, response) => {
      if (request.url === "/worker.js") {
        workerRequests += 1;
        response.writeHead(200, {
          "content-type": "text/javascript",
          "service-worker-allowed": "/",
        });
        response.end(`self.addEventListener("install", () => self.skipWaiting());
        self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
        self.addEventListener("fetch", event => {
          event.respondWith(new Response("service-worker bypass"));
        });`);
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><title>service worker policy probe</title>
        <body>network response: ${request.url}</body>`);
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    profileDir = await mkdtemp(join(tmpdir(), "ghost-browser-service-worker-"));
    const origin = `http://127.0.0.1:${port}`;

    // Seed a genuinely active controller, then close Chromium without clearing
    // its persistent profile. A fresh-profile test cannot exercise this bypass.
    seedingContext = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: true,
      chromiumSandbox: true,
    });
    const seedPage = seedingContext.pages()[0] ?? await seedingContext.newPage();
    await seedPage.goto(`${origin}/seed`);
    await seedPage.evaluate(async () => {
      const serviceWorker = (navigator as unknown as {
        serviceWorker: {
          register: (url: string) => Promise<unknown>;
          ready: Promise<unknown>;
        };
      }).serviceWorker;
      await serviceWorker.register("/worker.js");
      await serviceWorker.ready;
    });
    await seedPage.waitForFunction(() =>
      (navigator as unknown as { serviceWorker: { controller: unknown } })
        .serviceWorker.controller !== null
    );
    expect(await seedPage.evaluate(async () => (await fetch("/controlled-before")).text()))
      .toBe("service-worker bypass");
    await seedingContext.close();
    seedingContext = undefined;

    backend = new PlaywrightBrowserBackend(
      profileDir,
      { executablePath, headless: true, launchTimeoutMs: 10_000 },
      {
        // This integration isolates the Playwright interception boundary; URL
        // classification/DNS policy has resolver-seam coverage elsewhere.
        checkUrl: async (url) => url,
        checkAddress: () => undefined,
      },
    );
    await backend.open(`${origin}/controlled-after`, { timeoutMs: 10_000 });

    const result = await backend.javascript(`(async () => {
      const networkText = document.body.textContent.trim();
      await navigator.serviceWorker.register("/worker.js");
      const ready = await Promise.race([
        navigator.serviceWorker.ready.then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 1_000))
      ]);
      return {
        controller: navigator.serviceWorker.controller !== null,
        registrations: (await navigator.serviceWorker.getRegistrations()).length,
        ready,
        networkText
      };
    })()`, { timeoutMs: 10_000 });

    expect(result.value).toMatchObject({
      controller: false,
      registrations: 0,
      ready: false,
      networkText: "network response: /controlled-after",
    });
    expect(workerRequests).toBe(1);
  }, 30_000);
});
