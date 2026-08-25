/**
 * The write-path HTTP surface: one preflight query and one delete route.
 *
 * ## The fence is stricter than TokenLedger's
 *
 * These routes MUTATE a session. `httpServer.register({ kind: 'exact' })` sits
 * outside the RPC trust boundary — nothing upstream screens the caller — so
 * this module does it itself, on the observed peer socket address. A GET panel
 * leaking figures to a LAN peer would be bad; a POST deleting history for one
 * would be worse. Loopback only, Host header checked as the second condition,
 * same two-condition rule as the read-only plugin, applied to every route.
 *
 * ## Why preflight exists
 *
 * The client needs to know whether an icon should render enabled, disabled, or
 * not at all — and WHY (tool-call row? mid-turn? already deleted?). That
 * verdict comes from `assessDeletion` over the live log; exposing it as GET
 * `/status` keeps the click path honest: POST re-runs the exact same check and
 * refuses with the same reason codes, so the UI can never show an icon the
 * host will not honour.
 *
 * @module dsh-delete-message/http
 */

import { createRequire } from "node:module";

/**
 * This package's version, read from its own manifest.
 *
 * Reported on every payload because an install being behind is invisible from
 * both sides otherwise — the symptom of a stale copy is identical to the
 * symptom of a broken one.
 */
export const VERSION = (() => {
	try {
		return createRequire(import.meta.url)("../package.json").version;
	} catch {
		return "unknown";
	}
})();

/** Route prefix. Exact registrations, so each path is spelled out. */
export const BASE_PATH = "/api/delete-message";
export const STATUS_PATH = `${BASE_PATH}/status`;
export const DELETE_PATH = `${BASE_PATH}/delete`;

/**
 * Service names tried in order for the web server.
 *
 * Both are real names shipped by real versions of `dsh-host-webserver`; which
 * one a composition resolves depends on its harness version. Checked against
 * the running composition, never against npm's dist-tags (see
 * docs/DESIGN.md § "host contract").
 */
export const WEB_SERVER_NAMES = ["webServer", "httpServer"];

/**
 * Loopback test for a bare address.
 *
 * IPv6-mapped IPv4 (`::ffff:127.0.0.1`) is what Node reports on a dual-stack
 * listener, so it has to be recognized or every local request looks foreign.
 */
export function isLoopbackAddress(address) {
	if (typeof address !== "string" || address === "") return false;
	const bare = address.startsWith("::ffff:") ? address.slice(7) : address;
	if (bare === "::1" || bare === "localhost") return true;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** Host header without its port, tolerating a bracketed IPv6 literal. */
export function hostNameOf(header) {
	if (typeof header !== "string" || header === "") return "";
	if (header.startsWith("[")) return header.slice(1, header.indexOf("]"));
	const colon = header.lastIndexOf(":");
	return colon === -1 ? header : header.slice(0, colon);
}

/**
 * Decide whether a request may be served.
 *
 * @param {import("node:http").IncomingMessage} req - the incoming request.
 * @returns `undefined` when acceptable, otherwise `{ status, body }` to send.
 */
export function screenRequest(req) {
	const remote = req.socket?.remoteAddress ?? "";
	if (!isLoopbackAddress(remote)) {
		return { status: 403, body: { ok: false, error: "forbidden-origin" } };
	}
	const host = hostNameOf(req.headers.host ?? "");
	if (host !== "" && host !== "localhost" && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) && host !== "[::1]") {
		return { status: 403, body: { ok: false, error: "forbidden-host" } };
	}
	return undefined;
}

/** Parse a URL's query string into a plain object. */
export function parseQuery(url) {
	const query = {};
	try {
		for (const [key, value] of new URL(url ?? "/", "http://localhost").searchParams) query[key] = value;
	} catch {
		// Malformed URL: an empty query makes every required-param check fail
		// downstream, which is the correct outcome anyway.
	}
	return query;
}

/** Read and parse a JSON request body, bounded. */
export function readJsonBody(req, limitBytes = 64 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > limitBytes) {
				reject(Object.assign(new Error("body too large"), { statusCode: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(Object.assign(new Error("invalid JSON body"), { statusCode: 400 }));
			}
		});
		req.on("error", reject);
	});
}

/**
 * Register the routes on a context that already has the web server.
 *
 * @param {any} ctx - cordis context (used for effect disposal).
 * @param {{ register: (opts: any) => any }} httpServer - resolved web server.
 * @param {{ logger?: any, sessions: any }} deps - live session store + logger.
 * @returns true, so the caller can report that a surface exists.
 */
export function attachRoutes(ctx, httpServer, deps) {
	const logger = deps.logger;

	const send = (res, status, value) => {
		const body = JSON.stringify(value);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-cache"
		});
		res.end(body);
	};

	const route = (path, build, label) => {
		ctx.effect(
			() =>
				httpServer.register({
					kind: "exact",
					path,
					handler: async (req, res) => {
						const refused = screenRequest(req);
						if (refused !== undefined) return send(res, refused.status, refused.body);
						try {
							await build(req, res);
						} catch (error) {
							const status = error?.statusCode ?? 500;
							// A failed delete is this plugin's problem, never the harness's.
							logger?.warn?.("delete-message: %s failed: %s", path, error?.message ?? error);
							send(res, status, { ok: false, error: status === 500 ? "internal" : error.message });
						}
					}
				}),
			`delete-message: route ${path}`
		);
		logger?.info?.("delete-message: serving %s (%s)", path, label);
	};

	route(
		STATUS_PATH,
		async (req, res) => {
			const query = parseQuery(req.url);
			send(res, 200, await deps.buildStatus(query.sessionId, query.seq, query.scope));
		},
		"deletion preflight"
	);

	route(
		DELETE_PATH,
		async (req, res) => {
			const body = await readJsonBody(req);
			send(res, 200, await deps.deleteMessage(body));
		},
		"surface replace"
	);

	return true;
}

/**
 * Register the routes, waiting for whichever web server name resolves.
 *
 * Reached through a nested `inject` rather than the plugin's own: Cordis's
 * `inject` has no optional form, so declaring `webServer` required would stop
 * the plugin from loading in compositions without one.
 *
 * @param {any} ctx - cordis context.
 * @param {{ logger?: any, sessions: any }} deps - live session store + logger.
 * @returns whether a wait was scheduled or the routes attached immediately.
 */
export function registerRoutes(ctx, deps) {
	if (typeof ctx.inject !== "function") {
		for (const name of WEB_SERVER_NAMES) {
			const immediate = typeof ctx.get === "function" ? ctx.get(name) : undefined;
			if (immediate !== undefined && typeof immediate.register === "function") return attachRoutes(ctx, immediate, deps);
		}
		return false;
	}

	// A nested inject that never fires is invisible: no error, no log, and the
	// only symptom is a 404 that says nothing about the host. So the wait
	// announces itself, and says so again if still waiting.
	deps.logger?.info?.("delete-message: waiting for %s to serve %s", WEB_SERVER_NAMES.join(" or "), BASE_PATH);
	let attached = false;
	const nagging = setTimeout(() => {
		if (attached) return;
		deps.logger?.warn?.("delete-message: still no web server after 10s — icons will fail silently");
	}, 10_000);
	nagging.unref?.();

	for (const name of WEB_SERVER_NAMES) {
		ctx.inject([name], (scoped) => {
			const server = scoped?.[name];
			if (attached || server === undefined || typeof server.register !== "function") return;
			attached = true;
			clearTimeout(nagging);
			attachRoutes(scoped, server, deps);
			deps.logger?.info?.("delete-message: serving %s via %s", BASE_PATH, name);
		});
	}
	return true;
}
