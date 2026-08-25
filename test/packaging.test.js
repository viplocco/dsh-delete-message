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
					{ seq: 1, type: "user/message", surfaceOp: "append", data: { id: "u1", role: "user", source: { kind: "user" }, content: [] } },
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

			// The refusal paths return the rule codes verbatim: an unknown seq is
			// not-found, and a chrome anchor (the turn/end boundary — the shape a
			// retry/error row cites) plans its user-input window like any other
			// unit trigger: here the window's live assistant message goes.
			const missing = await plugin.deleteMessage(sessions, {}, { sessionId: "s1", seq: 99 });
			assert.equal(missing.ok, false);
			assert.equal(missing.error, "not-found");
			const viaChrome = await plugin.deleteMessage(sessions, {}, { sessionId: "s1", seq: 3 });
			assert.equal(viaChrome.ok, true);
			assert.deepEqual(viaChrome.replaced, [2]);
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

		it("deleteMessage with scope=step deletes only the owning step", async () => {
			const appends = [];
			const session = {
				events: [
					{ seq: 0, type: "turn/start" },
					{ seq: 1, type: "user/message", surfaceOp: "append", data: { id: "u1", role: "user", source: { kind: "user" }, content: [] } },
					{ seq: 2, type: "assistant/message", surfaceOp: "append", data: { message: { id: "a1", role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "tool_use", id: "t1" }] } } },
					{ seq: 3, type: "tool/call" },
					{ seq: 4, type: "tool/result", surfaceOp: "append", data: { message: { id: "r1", role: "user", source: { kind: "tool", callId: "t1" }, content: [] } } },
					{ seq: 5, type: "assistant/message", surfaceOp: "append", data: { message: { id: "a2", role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: "step 2 answer" }] } } },
					{ seq: 6, type: "turn/end" }
				],
				append(type, data, opts) {
					appends.push({ type, data, opts });
					return { seq: this.events.length };
				}
			};
			const sessions = { get: (id) => (id === "s1" ? session : undefined) };

			// scope=step on a tool/call chrome anchor → only step 1 goes.
			const stepResult = await plugin.deleteMessage(sessions, {}, { sessionId: "s1", seq: 3, scope: "step" });
			assert.equal(stepResult.ok, true);
			assert.equal(stepResult.mode, "step");
			// assistant/msg(2) + tool/result(4); step 2's reply(5) survives.
			assert.deepEqual(stepResult.replaced.sort((a, b) => a - b), [2, 4]);
			assert.equal(appends.length, 2);

			// Without scope, same anchor → unit mode replaces the whole window
			// including step 2's reply.
			const unitResult = await plugin.deleteMessage(sessions, {}, { sessionId: "s1", seq: 3 });
			assert.equal(unitResult.ok, true);
			assert.equal(unitResult.mode, "unit");
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

	// v0.1.5: chrome-row trash (context / tool-call / model-retry / turn-error
	// / assistant-step THINK card) must (a) cover the think disclosure inside
	// step nodes and (b) hide until the message row is hovered — visibility,
	// not mere opacity, so a hidden icon is truly unclickable.
	it("covers the step THINK card and hover-hides chrome icons", () => {
		const source = readFileSync(`${root}src/client.js`, "utf8");
		assert.match(source, /\[data-variant="think"\] \[data-disclosure-row\]/, "THINK card anchor selector missing");
		assert.match(source, /data-dshdm-autohide/, "autohide marker missing");
		assert.match(source, /visibility:hidden/, "autohide must use visibility:hidden, not opacity only");
		assert.match(source, /\[data-chat-flow-key\]:hover button\[data-dsh-delete-icon\]\[data-dshdm-autohide\]/);
	});

	// Regression (v0.1.2): every jsx() call must carry a props object. The
	// host's React 18.3.1 throws "Cannot convert undefined or null to object"
	// on single-argument jsx(), which crashed the slot entry on first render;
	// the error boundary then abdicated it and the delete button silently
	// never appeared on assistant messages.
	it("never calls jsx with a missing props object", () => {
		const source = readFileSync(`${root}src/client.js`, "utf8");
		assert.match(source, /jsx\(TrashGlyph,\s*\{\}\)/, "single-arg jsx(TrashGlyph) crashes React 18");
		assert.doesNotMatch(source, /jsx\(\s*[A-Za-z_$][\w$]*\s*\)/, "every jsx call needs an explicit props object");
	});

	// Regression (v0.1.2): native title tooltips render as an OS bordered box
	// that reads as a second "delete button"; hover feedback must come from
	// the shared bubble instead.
	it("uses no native title tooltips and no window.confirm", () => {
		const source = readFileSync(`${root}src/client.js`, "utf8");
		assert.doesNotMatch(source, /setAttribute\(\s*"title"/, "native title attributes are forbidden on injected controls");
		assert.doesNotMatch(source, /\.title\s*=/, "native title attributes are forbidden on injected controls");
		assert.doesNotMatch(source, /window\.confirm/, "confirmations go through the styled dialog replica");
	});

	// Regression (v0.1.2 follow-up): requiring the `sessions` service handed
	// the plugin a lazy accessor that threw "cannot get required service
	// sessions in inactive context" on first click. Session ids must arrive
	// through passive capture only.
	it("never resolves the sessions service", () => {
		const source = readFileSync(`${root}src/client.js`, "utf8");
		assert.doesNotMatch(source, /["']sessions["']/, "inject list and ctx access must not mention the sessions service");
		assert.match(source, /makeSessionIdSource\(\)/, "session ids come from capture, not from a service");
	});

	// Regression (v0.1.2 follow-up): plain "div with a button" matching once
	// enhanced third-party portals inside a message row, doubling the icon.
	// The host strip is identified by its CSS-modules `*_actions` token and
	// marked on enhancement so repeat scans are no-ops.
	it("identifies actions strips by their *_actions class token and marks them", () => {
		const source = readFileSync(`${root}src/client.js`, "utf8");
		assert.match(source, /const ACTIONS_TOKEN = \//, "strip qualification must require the host's *_actions token");
		assert.match(source, /_actions\)\(\?:/, "the token regex must anchor on <hash>_actions");
		assert.match(source, /looksLikeActionsStrip\(/);
		assert.match(source, /STRIP_MARK\s*=\s*"data-dsh-delete-enhanced"/);
		assert.match(source, /strip\.hasAttribute\(STRIP_MARK\)/);
		assert.doesNotMatch(source, /querySelectorAll\(":scope div/, "descendant-div scans caused duplicate icons");
	});

	// Regression (v0.1.2 follow-up): a render crash used to abdicate the whole
	// slot entry silently; the entry now carries its own error boundary that
	// logs and degrades to a warning glyph.
	it("wraps the assistant control in an error boundary", () => {
		const source = readFileSync(`${root}src/client.js`, "utf8");
		assert.match(source, /class DeleteControlBoundary extends react\.Component/);
		assert.match(source, /getDerivedStateFromError/);
	});

	it("inlines the official ic_ds_trash_outline_16 geometry", () => {
		const source = readFileSync(`${root}src/client.js`, "utf8");
		assert.match(source, /M14\.4782 4\.84067L14\.2138 10\.1152/, "trash glyph must be the official primitives path");
	});

	// Regression (v0.1.2 follow-up): ConversationSnapshot.chat.nodes is a
	// ChatNodeStore (get/values object), NOT an array — iterating it directly
	// threw "nodes is not iterable" on every render and the boundary showed a
	// permanent ⚠ instead of the button.
	it("reads chat nodes through the ChatNodeStore contract", () => {
		const source = readFileSync(`${root}src/client.js`, "utf8");
		assert.match(source, /typeof store\.values === "function"/, "nodes must be read via values() when it is a store");
		assert.doesNotMatch(source, /const nodes = snapshot\.chat\?\.nodes \?\? \[\];/, "the old array assumption must not return");
	});

	// Regression (v0.1.2 follow-up): the injected trash never passed through
	// React and carries no __reactFiber$ key — row identity must come from a
	// React-owned sibling button queried at click time.
	it("resolves user-row seq from a react-owned sibling, not the injected icon", () => {
		const source = readFileSync(`${root}src/client.js`, "utf8");
		assert.match(source, /:scope > button:not\(\[data-dsh-delete-icon\]\)/);
	});
});
