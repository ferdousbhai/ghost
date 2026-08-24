#!/usr/bin/env node
/**
 * Tree-shake the vendored model catalog down to ghost's provider allowlist.
 *
 * Part of the sovereignty work in issue #3, phase 1. Upstream
 * `@oh-my-pi/pi-catalog` bundles every provider omp has ever spoken to; ghost
 * keeps the ones a ghost can actually be bound to. The allowlist and its
 * justification live in `vendor/pi-catalog/shake.config.json`.
 *
 * The rewrite is purely subtractive at the top level: surviving providers keep
 * their model records byte-for-byte, so `src/models.json.d.ts` stays accurate
 * and every `getBundledModels()` consumer keeps its shape.
 *
 * Usage:
 *   node scripts/shake-catalog.mjs            # shake in place, report the delta
 *   node scripts/shake-catalog.mjs --check    # report only, exit 1 if a shake is due
 *   node scripts/shake-catalog.mjs --resync   # restore models.json from the
 *                                             # installed upstream tarball, then shake
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = resolve(ROOT, "vendor/pi-catalog");
const MODELS = resolve(VENDOR, "src/models.json");
const CONFIG = resolve(VENDOR, "shake.config.json");

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check");
const RESYNC = args.has("--resync");

/** models.json is tab-indented with no trailing newline; match it exactly. */
const serialize = (value) => JSON.stringify(value, null, "\t");

function fail(message) {
	console.error(`shake-catalog: ${message}`);
	process.exit(1);
}

function upstreamModelsPath() {
	const { version } = JSON.parse(readFileSync(resolve(VENDOR, "package.json"), "utf8"));
	const path = resolve(
		ROOT,
		`node_modules/.pnpm/@oh-my-pi+pi-catalog@${version}/node_modules/@oh-my-pi/pi-catalog/src/models.json`,
	);
	if (!existsSync(path)) {
		fail(
			`upstream models.json for ${version} not found at ${path}\n` +
				`  --resync needs the upstream tarball in the store. Temporarily drop the\n` +
				`  "@oh-my-pi/pi-catalog" override from pnpm-workspace.yaml, pnpm install, retry.`,
		);
	}
	return path;
}

/** Per src/models.json.d.ts: provider -> modelId -> row, and every row carries `api`. */
function validate(catalog) {
	for (const [provider, models] of Object.entries(catalog)) {
		if (models === null || typeof models !== "object" || Array.isArray(models)) {
			fail(`provider "${provider}" is not a model record`);
		}
		for (const [id, row] of Object.entries(models)) {
			if (row === null || typeof row !== "object" || Array.isArray(row)) {
				fail(`"${provider}/${id}" is not an object`);
			}
			if (typeof row.api !== "string") {
				fail(`"${provider}/${id}" has no string "api" field`);
			}
		}
	}
}

const count = (catalog) => ({
	providers: Object.keys(catalog).length,
	models: Object.values(catalog).reduce((sum, models) => sum + Object.keys(models).length, 0),
});

const kib = (bytes) => `${(bytes / 1024).toFixed(0)} KiB`;
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const size = (bytes) => (bytes >= 1024 * 1024 ? mib(bytes) : kib(bytes));

const config = JSON.parse(readFileSync(CONFIG, "utf8"));
if (!Array.isArray(config.providers) || config.providers.length === 0) {
	fail(`${CONFIG} has no non-empty "providers" array`);
}
const allowlist = new Set(config.providers);

const sourcePath = RESYNC ? upstreamModelsPath() : MODELS;
const before = readFileSync(sourcePath);
const catalog = JSON.parse(before.toString("utf8"));
validate(catalog);

// Preserve upstream key order; drop anything off the allowlist.
const shaken = {};
for (const [provider, models] of Object.entries(catalog)) {
	if (allowlist.has(provider)) shaken[provider] = models;
}

const dropped = Object.keys(catalog).filter((p) => !allowlist.has(p));
const absent = config.providers.filter((p) => !(p in catalog)).sort();

const after = Buffer.from(serialize(shaken), "utf8");
validate(JSON.parse(after.toString("utf8")));

const b = count(catalog);
const a = count(shaken);
const label = RESYNC ? "upstream" : "before";

console.log(`shake-catalog  ${MODELS.slice(ROOT.length + 1)}`);
console.log(
	`  ${label.padEnd(6)} ${String(before.length).padStart(9)} B  ${size(before.length).padStart(9)}  ${b.providers} providers  ${b.models} models`,
);
console.log(
	`  after  ${String(after.length).padStart(9)} B  ${size(after.length).padStart(9)}  ${a.providers} providers  ${a.models} models`,
);
const saved = before.length - after.length;
console.log(
	`  saved  ${String(saved).padStart(9)} B  ${size(saved).padStart(9)}  ${((saved / before.length) * 100).toFixed(1)}%  ` +
		`(-${b.providers - a.providers} providers, -${b.models - a.models} models)`,
);
if (dropped.length > 0) console.log(`  dropped: ${dropped.join(", ")}`);
if (absent.length > 0) {
	console.log(`  allowlisted but not bundled (runtime-discovered, expected): ${absent.join(", ")}`);
}

if (before.equals(after)) {
	console.log("  already shaken; nothing to write");
	process.exit(0);
}

if (CHECK_ONLY) {
	console.error("  --check: models.json is not shaken to the current allowlist");
	process.exit(1);
}

writeFileSync(MODELS, after);
console.log(`  wrote ${MODELS.slice(ROOT.length + 1)}`);
