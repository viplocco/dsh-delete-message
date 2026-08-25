/**
 * HTTP fence and route wiring against stubs — no real server, no real host.
 *
 * The fence rules are the point: a mutating surface MUST refuse non-loopback
 * peers and foreign Host headers on EVERY route, preflight and delete alike.
 *
 * @module test/http.test.js
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DELETE_PATH,
	STATUS_PATH,
	attachRoutes,
	hostNameOf,
	isLoopbackAddress,
	parseQuery,
	readJsonBody,
	screenRequest
} from "../src/http.js";
import * as plugin from "../src/plugin.js";

function fakeReq({ remote = "127.0.0.1", host = "127.0.0.1:3080", url = "/" } = {}) {
	return { socket: { remoteAddress: remote }, headers: { host }, url };
}

describe("screenRequest", () => {
	it("accepts loopback peers on loopback hosts", () => {
		for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]) {
			assert.equal(screenRequest(fakeReq({ remote })), undefined, remote);
		}
	});

	it("refuses LAN and remote peers", () => {
		for (const remote of ["192.168.1.20", "10.0.0.5", "::ffff:192.168.1.20", "", null]) {
			const verdict = screenRequest(fakeReq({ remote }));
			assert.equal(verdict?.status, 403, String(remote));
		}
	});

	it("refuses foreign Host headers even from loopback peers", () => {
		const verdict = screenRequest(fakeReq({ host: "evil.example.com" }));
		assert.equal(verdict?.status, 403);
	});
});

describe("isLoopbackAddress / hostNameOf", () => {
	it("recognizes the IPv6-mapped loopback Node actually reports", () => {
		assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
		assert.equal(isLoopbackAddress("::ffff:127.0.0.2"), true);
		assert.equal(isLoopbackAddress("fe80::1"), false);
	});
	it("strips ports and brackets", () => {
		assert.equal(hostNameOf("127.0.0.1:3080"), "127.0.0.1");
		assert.equal(hostNameOf("[::1]:3080"), "::1");
		assert.equal(hostNameOf(undefined), "");
	});
});

describe("parseQuery / readJsonBody", () => {
	it("parses query params tolerantly", () => {
		assert.deepEqual(parseQuery("/x?sessionId=s1&seq=3"), { sessionId: "s1", seq: "3" });
		assert.deepEqual(parseQuery("not a url"), {});
	});
	it("parses JSON bodies and rejects junk", async () => {
		const parsed = await readJsonBody({
			on: (name, fn) => {
				if (name === "data") fn(Buffer.from(JSON.stringify({ a: 1 })));
				if (name === "end") fn();
			}
		});
		assert.deepEqual(parsed, { a: 1 });

		await assert.rejects(
			readJsonBody({
				on: (name, fn) => {
					if (name === "data") fn(Buffer.from("{broken"));
					if (name === "end") fn();
				}
			}),
			(error) => error.statusCode === 400
		);
	});
});

describe("attachRoutes wiring", () => {
	function stubCtx() {
		const effects = [];
		return {
			effects,
			// Host semantics: ctx.effect(fn, label) RUNS fn now and registers its
			// disposer — the stub must do both or the routes never attach.
			effect(fn, label) {
				const result = fn();
				effects.push({ fn, label });
				return result;
			}
		};
	}
	function stubServer() {
		const routes = new Map();
		return {
			routes,
			register(opts) {
				routes.set(opts.path, opts.handler);
			}
		};
	}

	function makeDeps() {
		const session = {
			events: [
				{ seq: 0, type: "turn/start" },
				{ seq: 1, type: "user/message", surfaceOp: "append", data: { content: [{ type: "text" }] } },
				{ seq: 2, type: "assistant/message", surfaceOp: "append", data: { message: { content: [{ type: "text" }] } } },
				{ seq: 3, type: "turn/end" }
			],
			appends: [],
			append(type, data, opts) {
				this.appends.push({ type, data, opts });
			}
		};
		const logger = { info() {}, warn() {}, error() {} };
		const sessions = { get: (id) => (id === "s1" ? session : undefined) };
		return {
			logger,
			sessions,
			session,
			// Same assembly plugin.apply performs — the real verdict logic, not a
			// parallel stub that could drift from it.
			buildStatus: (sessionId, seq) => plugin.buildStatus(sessions, sessionId, seq),
			deleteMessage: (body) => plugin.deleteMessage(sessions, { logger }, body)
		};
	}

	function makeRes() {
		const res = {
			statusCode: 0,
			headers: null,
			body: "",
			writeHead(status, headers) {
				res.statusCode = status;
				res.headers = headers;
			},
			end(text) {
				res.body = text;
			}
		};
		return res;
	}

	it("registers both routes through ctx.effect for disposal", () => {
		const ctx = stubCtx();
		const server = stubServer();
		const deps = makeDeps();
		assert.equal(attachRoutes(ctx, server, deps), true);
		assert.deepEqual(
			ctx.effects.map((entry) => entry.label),
			[`delete-message: route ${STATUS_PATH}`, `delete-message: route ${DELETE_PATH}`]
		);
		assert.ok(server.routes.has(STATUS_PATH) && server.routes.has(DELETE_PATH));
	});

	it("status answers the live verdict", async () => {
		const ctx = stubCtx();
		const server = stubServer();
		const deps = makeDeps();
		attachRoutes(ctx, server, deps);
		const res = makeRes();
		await server.routes.get(STATUS_PATH)(fakeReq({ url: `${STATUS_PATH}?sessionId=s1&seq=1` }), res);
		const payload = JSON.parse(res.body);
		assert.equal(res.statusCode, 200);
		assert.equal(payload.deletable, true);
	});

	it("delete appends the replace and answers ok", async () => {
		const ctx = stubCtx();
		const server = stubServer();
		const deps = makeDeps();
		attachRoutes(ctx, server, deps);
		const res = makeRes();
		const req = fakeReq({ url: DELETE_PATH });
		req.method = "POST";
		// Feed the handler's readJsonBody by faking the request stream.
		req.on = (name, fn) => {
			if (name === "data") fn(Buffer.from(JSON.stringify({ sessionId: "s1", seq: 1 })));
			if (name === "end") fn();
		};
		await server.routes.get(DELETE_PATH)(req, res);
		const payload = JSON.parse(res.body);
		assert.equal(res.statusCode, 200);
		assert.equal(payload.ok, true);
		assert.equal(deps.session.appends.length, 1);
		assert.deepEqual(deps.session.appends[0].opts.surfaceOp, { op: "replace", start: 1, end: 1 });
	});

	it("the fence guards the mutating route too", async () => {
		const ctx = stubCtx();
		const server = stubServer();
		const deps = makeDeps();
		attachRoutes(ctx, server, deps);
		const res = makeRes();
		const req = fakeReq({ remote: "192.168.1.9", url: DELETE_PATH });
		req.on = (name, fn) => {
			if (name === "end") fn();
		};
		await server.routes.get(DELETE_PATH)(req, res);
		assert.equal(res.statusCode, 403);
		assert.equal(deps.session.appends.length, 0);
	});
});

describe("buildStatus reports a BOUNDED client-hide window", () => {
	// The client persists status.window into its deletion ledger on
	// windowCleared healing. A right-open window (`end: null`) once persisted
	// covered every row appended AFTER it — all future assistant replies were
	// hidden on sight. Regression contract: end is always a safe integer.
	it("clamps the window past the last real user input", async () => {
		const session = {
			events: [
				{ seq: 0, type: "turn/start" },
				{ seq: 1, type: "user/message", surfaceOp: "append", data: { source: { kind: "user" }, content: [] } },
				{ seq: 2, type: "assistant/message", surfaceOp: "append", data: { message: { content: [] } } },
				{ seq: 3, type: "llm/retry" },
				{ seq: 4, type: "turn/end" }
			]
		};
		const sessions = { get: (id) => (id === "s1" ? session : undefined) };
		const payload = await plugin.buildStatus(sessions, "s1", 2);
		assert.equal(payload.live, true);
		assert.equal(payload.windowCleared, false);
		assert.equal(payload.window.start, 1);
		assert.equal(payload.window.end, 5, "lastEventSeq+1 — never null");
	});

	it("keeps an existing right bound untouched", async () => {
		const session = {
			events: [
				{ seq: 0, type: "turn/start" },
				{ seq: 1, type: "user/message", surfaceOp: "append", data: { source: { kind: "user" }, content: [] } },
				{ seq: 2, type: "assistant/message", surfaceOp: "append", data: { message: { content: [] } } },
				{ seq: 3, type: "turn/end" },
				{ seq: 4, type: "turn/start" },
				{ seq: 5, type: "user/message", surfaceOp: "append", data: { source: { kind: "user" }, content: [] } },
				{ seq: 6, type: "assistant/message", surfaceOp: "append", data: { message: { content: [] } } },
				{ seq: 7, type: "turn/end" }
			]
		};
		const sessions = { get: (id) => (id === "s1" ? session : undefined) };
		const payload = await plugin.buildStatus(sessions, "s1", 2);
		assert.deepEqual(payload.window, { start: 1, end: 5 });
	});
});
