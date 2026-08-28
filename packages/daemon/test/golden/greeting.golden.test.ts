/**
 * Golden: the greeting flow, end to end over HTTP.
 *
 * `POST /api/ghosts/:name/greeting` is the line that opens an empty chat. It is
 * the one Ghost surface driven by a *second* model — `roles.smol_model` — and
 * its contract is unusually easy to break quietly: every failure must come back
 * as `200 {greeting: null}`, never a 5xx, and the prompt must keep ghost context
 * and shared Documents names fenced as data.
 *
 * This fixture drives the real route, the real `SessionHost.greeting` cache, and
 * the real `generateGreeting` against a scripted smol runtime, and records both
 * halves: the exact prompt the smol model was asked, and the exact HTTP body the
 * shell would receive — for a written ghost, an un-met ghost, a model that
 * answers instead of greeting, a model that errors, and a ghost with no usable
 * smol model at all.
 *
 * The one injected value is the clock. `SessionHost` builds the greeting context
 * with `localTimeString()`, which is the machine's zone and the current minute;
 * the generator below swaps in a pinned string before building the prompt, so
 * the prompt text in the fixture is the real one with a stable clock rather than
 * a redacted one. Everything else — the memory budget, the shallow Documents
 * index, the
 * "days since your last conversation" line — is what the route actually
 * assembled. See ./harness.ts for the shared normalisation rules.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MachineDocuments } from "@ghost/extensions";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import {
  buildGreetingContext,
  generateGreeting,
  type GreetingContextInput,
} from "../../src/greeting.js";
import { startDaemonServer, type ListeningServer } from "../../src/server.js";
import { SessionHost, type GreetingGenerator } from "../../src/session-host.js";
import type { SmolModel, SmolRuntime } from "../../src/smol.js";
import { makeTempGhosts, seedGhost, type TempGhosts } from "../helpers/fixtures.js";
import { fetchNoReuse as fetch } from "../helpers/http-fetch.js";
import { expectGolden, Normalizer, type GoldenSection } from "./harness.js";

let temp: TempGhosts | null = null;
let host: SessionHost | null = null;
let listening: ListeningServer | null = null;

afterEach(async () => {
  await listening?.close();
  listening = null;
  await host?.disposeAll();
  host = null;
  temp?.cleanup();
  temp = null;
});

const LOCAL_TIME = "Sunday, 15 February 2026 at 19:40 (Europe/Berlin)";

const CHARACTER = `# casper

You are casper, a letterpress printer. You answer in short sentences.
`;

function memoryFile(content: string): string {
  return `${content}\n`;
}

/**
 * Two models, both credentialed, so `resolveSmolModel` has a real ranking to
 * do: the fixture records which one it picked.
 */
const SMOL_MODELS: SmolModel[] = [
  {
    provider: "ghost-local",
    id: "mock-ghost-1",
    name: "Mock Ghost 1",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    provider: "ghost-local",
    id: "mock-ghost-smol",
    name: "Mock Ghost Smol",
    cost: { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.06 },
  },
];

type ScriptedReply =
  | { kind: "text"; text: string }
  | { kind: "stop-error" }
  | { kind: "throw"; message: string };

interface ScriptedSmol {
  runtime: SmolRuntime;
  prompts: string[];
  models: string[];
}

function scriptedSmol(reply: ScriptedReply, credentialed = true): ScriptedSmol {
  const prompts: string[] = [];
  const models: string[] = [];
  const runtime = {
    getModels: () => SMOL_MODELS,
    getModel: (provider: string, id: string) =>
      SMOL_MODELS.find((model) => model.provider === provider && model.id === id),
    hasConfiguredAuth: () => credentialed,
    isUsingSubscription: () => false,
    isUsingOAuth: () => false,
    complete: async (model: SmolModel, context: Context): Promise<AssistantMessage> => {
      models.push(`${model.provider}/${model.id}`);
      prompts.push(String((context.messages[0] as { content: unknown }).content));
      if (reply.kind === "throw") throw new Error(reply.message);
      if (reply.kind === "stop-error") {
        return {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "error",
          errorMessage: "the smol provider fell over",
        } as unknown as AssistantMessage;
      }
      return {
        role: "assistant",
        content: [{ type: "text", text: reply.text }],
        stopReason: "stop",
      } as unknown as AssistantMessage;
    },
  } as unknown as SmolRuntime;
  return { runtime, prompts, models };
}

/**
 * The real generator with the clock pinned: `generateGreeting` still resolves
 * the model, builds the prompt, runs the completion, and cleans the result.
 */
function pinnedGenerator(smol: ScriptedSmol): GreetingGenerator {
  return async ({ context }) =>
    generateGreeting({
      runtime: smol.runtime,
      context: { ...context, localTime: LOCAL_TIME },
    });
}

interface Case {
  readonly label: string;
  readonly reply: ScriptedReply;
  readonly written: boolean;
  readonly credentialed?: boolean;
  readonly postTwice?: boolean;
}

const CASES: readonly Case[] = [
  {
    label: "a written ghost, a model that greets",
    reply: { kind: "text", text: '  "Evening. The Vandercook again?"  ' },
    written: true,
    postTwice: true,
  },
  {
    label: "an un-met ghost — onboarding, and no character sketch in the prompt",
    reply: { kind: "text", text: "I do not know you yet. Who am I to you?" },
    written: false,
  },
  {
    label: "a model that answers instead of greeting — rejected, not trimmed",
    reply: {
      kind: "text",
      text:
        "As an AI assistant I should follow the system prompt above. Here is a full answer to "
        + "your question about the Vandercook, which is a cylinder proof press manufactured in "
        + "Rochester, New York, and used for pulling proofs of metal type and linoleum blocks, "
        + "and which you should service by first removing the rollers and cleaning the bearings "
        + "with a solvent appropriate to the rubber compound.",
    },
    written: true,
  },
  {
    label: "a smol provider that errors",
    reply: { kind: "stop-error" },
    written: true,
  },
  {
    label: "a smol provider that throws",
    reply: { kind: "throw", message: "connection reset" },
    written: true,
  },
  {
    label: "no credentialed smol model at all",
    reply: { kind: "text", text: "Evening." },
    written: true,
    credentialed: false,
  },
];

async function postGreeting(
  base: string,
  ghost: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}/api/ghosts/${ghost}/greeting`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return { status: response.status, body: await response.json() };
}

describe("golden: greeting flow", () => {
  it("pins the smol prompt and every route outcome, success and failure", async () => {
    const sections: GoldenSection[] = [];
    const normalizer = new Normalizer();

    // One standalone assertion of the prompt builder on a fully-populated
    // context, so the fixture holds the shape the route only partly exercises.
    const reference: GreetingContextInput = {
      ghostName: "casper",
      character: "You are casper, a letterpress printer.",
      memoryLines: ["- owner-prefers-short.md: The owner wants short answers"],
      documents: {
        root: "/home/owner/Documents",
        lines: ['- file: "press.md"'],
        chars: 19,
        omitted: 0,
        total: 1,
      },
      localTime: LOCAL_TIME,
      daysSinceLastConversation: 12,
      onboarding: false,
    };
    sections.push({
      title: "reference prompt (fully populated context, 12 days since last talk)",
      body: String((buildGreetingContext(reference).messages[0] as { content: unknown }).content),
    });

    for (const testCase of CASES) {
      // A fresh root, host, and server per case: the greeting cache is keyed on
      // (ghost, character fingerprint), so sharing one would make later cases
      // depend on earlier ones.
      temp = makeTempGhosts();
      temp.registry.ensureRoot();
      const documentsRoot = join(temp.root, ".documents");
      mkdirSync(documentsRoot);
      if (testCase.written) {
        seedGhost(temp.root, {
          name: "casper",
          character: CHARACTER,
          memory: {
            "owner-prefers-short.md": memoryFile(
              "The owner wants short answers. Keep replies to a line or two.",
            ),
          },
        });
        writeFileSync(join(documentsRoot, "press.md"), "# Restoring the Vandercook\n\nRollers first.\n");
        writeFileSync(join(documentsRoot, "ledger.md"), "# Ledger\n\nToo much.\n");
      } else {
        // The registry's own seed is the definition of "never been met".
        temp.registry.create("casper");
      }
      const smol = scriptedSmol(testCase.reply, testCase.credentialed ?? true);
      host = new SessionHost({
        registry: temp.registry,
        ownerHome: temp.ownerHome,
        offline: true,
        extensionOptions: { documents: new MachineDocuments(documentsRoot) },
        greeting: { generate: pinnedGenerator(smol) },
      });
      listening = await startDaemonServer({
        registry: temp.registry,
        host,
        port: 0,
        // Auth is a separate contract with its own suite.
        apiToken: null,
      });
      const base = `http://127.0.0.1:${listening.port}`;

      const first = await postGreeting(base, "casper");
      const lines = [
        `POST /api/ghosts/casper/greeting -> ${first.status} ${normalizer.line(first.body)}`,
      ];
      if (testCase.postTwice) {
        const second = await postGreeting(base, "casper");
        lines.push(
          `POST again (cached)          -> ${second.status} ${normalizer.line(second.body)}`,
        );
      }
      lines.push(`smol completions: ${smol.models.length}`);
      lines.push(`smol model resolved: ${smol.models.join(", ") || "(none — no completion ran)"}`);

      sections.push({ title: `route: ${testCase.label}`, body: lines.join("\n") });
      sections.push({
        title: `prompt: ${testCase.label}`,
        body: smol.prompts.length > 0
          ? smol.prompts.join(`\n${"~".repeat(40)}\n`)
          : "(no prompt — the model was never reached)",
      });

      await listening.close();
      listening = null;
      await host.disposeAll();
      host = null;
      temp.cleanup();
      temp = null;
    }

    // A ghost that is not there is still a client bug, not a missing greeting.
    temp = makeTempGhosts();
    temp.registry.ensureRoot();
    host = new SessionHost({
      registry: temp.registry,
      ownerHome: temp.ownerHome,
      offline: true,
    });
    listening = await startDaemonServer({
      registry: temp.registry,
      host,
      port: 0,
      apiToken: null,
    });
    const missing = await postGreeting(`http://127.0.0.1:${listening.port}`, "nobody");
    expect(missing.status).toBe(404);
    sections.push({
      title: "route: an unknown ghost is a 404, not a null greeting",
      body: `POST /api/ghosts/nobody/greeting -> ${missing.status} ${normalizer.line(missing.body)}`,
    });

    expectGolden("greeting-flow", sections);
  });
});
