/**
 * Packaging contract — the three declarations a DSH bundle must keep true.
 *
 * A plugin whose manifest drifts from its files fails here at `pnpm test`, not
 * as a silent 404 in a browser three restarts later. Mirrors the failure modes
 * documented in TokenLedger's HOST-CONTRACT: bare-name entries, one-file client
 * graph, exports that resolve.
 *
 * @module test/packaging.test.js
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(`${root}${path}`, "utf8"));

describe("package.json dsh contract", () => {
	const manifest = readJson("package.json");

	it("declares the host-half bundle patch", () => {
		assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
		assert.ok(existsSync(`${root}cordis.patch.yml`), "cordis.patch.yml must ship");
	});

	it("declares a web client with the modules its code requires", () => {
		const client = manifest.dsh?.client;
		assert.equal(client?.platform, "web");
		for (const needed of ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-primitives"]) {
			assert.ok(client.inject.includes(needed), `missing inject ${needed}`);
		}
	});

	it("keeps the bare package name the patch entry requires", () => {
		// The client-module scanner resolves <name>/package.json; a subpath entry
		// would be cached as "not a client package" and the icons never load.
		const patch = readFileSync(`${root}cordis.patch.yml`, "utf8");
		assert.match(patch, /name:\s*dsh-delete-message\s*$/m, "entry name must be the bare package name");
	});
});

describe("exports resolve to real files", () => {
	const manifest = readJson("package.json");

	for (const [subpath, target] of Object.entries(manifest.exports)) {
		it(`${subpath} → ${target} exists`, () => {
			assert.ok(existsSync(`${root}${target}`), `${target} missing`);
		});
	}
});

let plugin;
try {
	plugin = await import("../src/plugin.js");
} catch (error) {
	it("plugin module imports", () => {
		throw error;
	});
}

describe("host half loads and answers", () => {
	if (plugin !== undefined) {
		it("exposes the cordis faces", () => {
			assert.equal(plugin.name, "delete-message");
			assert.deepEqual(plugin.inject, ["sessions"]);
			assert.equal(typeof plugin.apply, "function");
		});

		it("deleteMessage refuses without a live session", async () => {
			const sessions = { get: () => undefined };
			const outcome = await plugin.deleteMessage(sessions, {}, { sessionId: "s1", seq: 3 });
			assert.equal(outcome.ok, false);
			assert.equal(outcome.error, "not-found");
		});

		it("deleteMessage appends a surface replace for a deletable node", async () => {
			const appends = [];
			const session = {
				events: [
					{ seq: 0, type: "turn/start" },
					{ seq: 1, type: "user/message", surfaceOp: "append", data: { content: [] } },
					{ seq: 2, type: "assistant/message", surfaceOp: "append", data: { message: { content: [{ type: "text" }] } } },
					{ seq: 3, type: "turn/end" }
				],
				append(type, data, opts) {
					appends.push({ type, data, opts });
					return { seq: this.events.length };
				}
			};
			const sessions = { get: (id) => (id === "s1" ? session : undefined) };

			const good = await plugin.deleteMessage(sessions, { locale: "zh" }, { sessionId: "s1", seq: 1 });
			assert.equal(good.ok, true);
			assert.equal(appends.length, 1);
			assert.equal(appends[0].type, "user/message");
			assert.deepEqual(appends[0].opts.surfaceOp, { op: "replace", start: 1, end: 1 });
			assert.deepEqual(appends[0].opts.sourceEventSeqs, [1]);
			assert.equal(appends[0].data.role, "user");

			// The refusal paths return the rule codes verbatim: a turn boundary
			// is not a surface node, and an unknown seq is not-found.
			const boundary = await plugin.deleteMessage(sessions, {}, { sessionId: "s1", seq: 3 });
			assert.equal(boundary.ok, false);
			assert.equal(boundary.error, "not-surface-type");
			const missing = await plugin.deleteMessage(sessions, {}, { sessionId: "s1", seq: 99 });
			assert.equal(missing.ok, false);
			assert.equal(missing.error, "not-found");
		});

		it("buildStatus reports live + verdict", async () => {
			const session = { events: [{ seq: 1, type: "user/message", surfaceOp: "append", data: {} }] };
			const sessions = { get: (id) => (id === "s1" ? session : undefined) };
			const status = await plugin.buildStatus(sessions, "s1", "1");
			assert.equal(status.live, true);
			assert.equal(status.deletable, true);
			const cold = await plugin.buildStatus(sessions, "gone", "1");
			assert.equal(cold.live, false);
		});
	}
});

describe("browser half is one self-contained file", () => {
	it("registers through __ModuleLoader__ with the bundle id", () => {
		const source = readFileSync(`${root}src/client.js`, "utf8");
		assert.match(source, /__ModuleLoader__\.load\(\{\s*id:\s*"dsh-delete-message"/);
		// No ESM imports: the served bundle runs inside the module loader's
		// factory sandbox where the only require is the synchronous one.
		assert.doesNotMatch(source, /^\s*import\s/m, "client.js must not use static imports");
	});

	it("mounts the assistant-actions slot by its exact declared name", () => {
		const source = readFileSync(`${root}src/client.js`, "utf8");
		assert.match(source, /conversation\.chat\.assistant-actions/);
	});
});
