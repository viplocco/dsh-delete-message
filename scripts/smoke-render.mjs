/**
 * Smoke: load the bundle the way the client module system would, apply it
 * against a stub ctx, then REALLY render the registered assistant-actions
 * component with the host's React 18.3.1 + react-dom — the exact path that
 * crashed (single-arg jsx) and silently abdicated in v0.1.1.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dshModules = "C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules";
const nodeRequire = createRequire(import.meta.url);

/**
 * Resolve a node_modules root that holds BOTH `react` and `react-dom` in the
 * SAME tree. The host's npm layout re-hoists occasionally — react-dom once
 * lived at `<dsh>/node_modules/react-dom` and now nests under a package's own
 * node_modules — so a single hardcoded path breaks between restarts. Loading
 * react and react-dom/server from one shared root keeps the pairing coherent
 * (react-dom/server must render the same React instance the bundle factory
 * receives).
 */
function reactRoot() {
	const candidates = [
		join(dshModules, "@deepseek-ai", "dsh-client-ui-trajectory", "node_modules"),
		dshModules
	];
	for (const root of candidates) {
		if (existsSync(join(root, "react", "package.json")) && existsSync(join(root, "react-dom", "package.json"))) {
			return root;
		}
	}
	// Last resort: walk a bounded depth under the global npm tree for any
	// sibling react+react-dom pair, so an unrelated dependency can serve as
	// the harness React even if the dsh packages stop shipping it.
	const walk = [];
	(function scan(dir, depth) {
		if (depth > 6) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === ".bin") continue;
			const full = join(dir, entry.name);
			if (entry.name === "react" || entry.name === "react-dom") walk.push(full);
			scan(full, depth + 1);
		}
	})(join(dshModules, ".."), 0);
	for (const p of walk.filter((x) => /[\\/]react-dom$/.test(x))) {
		const root = dirnameOf(p);
		if (existsSync(join(root, "react", "package.json"))) return root;
	}
	return dshModules;
}
function dirnameOf(p) {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i === -1 ? p : p.slice(0, i);
}

const reactRootDir = reactRoot();
const react = nodeRequire(`${reactRootDir}/react`);
const jsxRuntime = nodeRequire(`${reactRootDir}/react/jsx-runtime`);
const { renderToStaticMarkup } = nodeRequire(`${reactRootDir}/react-dom/server`);

const source = readFileSync(fileURLToPath(new URL("../src/client.js", import.meta.url)), "utf8");

// Minimal browser stubs for the factory's top level.
globalThis.window = globalThis;
globalThis.document = {
	body: {},
	head: { appendChild() {} },
	getElementById: () => null,
	createElement: () => ({
		dataset: {},
		style: {},
		setAttribute() {},
		addEventListener() {},
		appendChild() {},
		append() {},
		focus() {},
		remove() {}
	})
};
globalThis.MutationObserver = class {
	observe() {}
	disconnect() {}
};
let registered;
globalThis.window.__ModuleLoader__ = {
	load: (handoff) => {
		const fakeRequire = (spec) => {
			if (spec === "react") return react;
			if (spec === "react/jsx-runtime") return jsxRuntime;
			throw new Error(`unexpected require(${spec})`);
		};
		registered = handoff.factory(fakeRequire);
	}
};

// Execute the bundle source in this context.
new Function(source)();

if (!registered || typeof registered.apply !== "function") throw new Error("bundle did not register a plugin");

// Stub ctx: capture the slot registration, exercise ctx.effect.
const captured = {};
const ctx = {
	effect: (fn, label) => {
		fn();
		return () => {};
	},
	locale: { register: (ns, dicts) => { captured.localeNs = ns; } },
	slots: {
		inject: (name, callback) => {
			captured.slotName = name;
			captured.dispose = callback();
		},
		register: (options, component) => {
			captured.options = options;
			captured.Component = component;
			return () => {};
		}
	}
};
registered.apply(ctx);

console.log("slot:", captured.slotName);
console.log("register options:", JSON.stringify(captured.options));
if (captured.options?.locale !== registered.NS) throw new Error("registration must declare locale NS");

// Render with the kit-shaped props. messageId resolves to seq 7 via the
// assistant-step node's data.finalNode. The snapshot mirrors the REAL
// ConversationSnapshot: chat.nodes is a ChatNodeStore (get/values), NOT an
// array — iterating it directly once threw "nodes is not iterable".
const chatNodes = [
	{ key: "u1", kind: "user", data: { kind: "user", seq: 1, time: 0, content: [], source: {} } },
	{
		key: "a1",
		kind: "assistant-step",
		data: {
			status: "settled",
			turn: 1,
			step: 1,
			blocks: [],
			time: 0,
			finalNode: { kind: "assistant", seq: 7, messageId: "m-1" }
		}
	}
];
const snapshot = {
	chat: {
		nodes: {
			get: (key) => chatNodes.find((node) => node.key === key),
			values: () => chatNodes
		}
	}
};
const useSession = (selector) => selector(snapshot);
const html = renderToStaticMarkup(
	jsxRuntime.jsx(captured.Component, { messageId: "m-1", sessionId: "s-1", useSession })
);

console.log("rendered:", html.slice(0, 160) + "…");
for (const expected of ['class="dshdm-action"', "aria-label"]) {
	if (!html.includes(expected)) throw new Error(`rendered markup missing ${expected}`);
}
if (!html.includes("<svg")) throw new Error("trash glyph svg missing");
if (html.includes(" disabled")) throw new Error("button must be enabled when the seq resolves");

// Unresolved messageId → disabled button, no crash.
const disabledHtml = renderToStaticMarkup(
	jsxRuntime.jsx(captured.Component, { messageId: "missing", sessionId: "s-1", useSession })
);
if (!disabledHtml.includes("disabled")) throw new Error("unresolved seq must disable the button");

// findSeqByMessageId contract checks.
const eq = (a, b, msg) => {
	if (a !== b) throw new Error(`${msg}: got ${a}`);
};
eq(registered.findSeqByMessageId(snapshot, "m-1"), 7, "assistant messageId resolves to finalNode.seq");
eq(registered.findSeqByMessageId(snapshot, undefined), undefined, "undefined id fails soft");
eq(registered.findSeqByMessageId(null, "m-1"), undefined, "null snapshot fails soft");
eq(
	registered.findSeqByMessageId({ chat: { nodes: [{ data: { kind: "steering", messageId: "st-1", seq: 4 } }] } }, "st-1"),
	4,
	"plain-array nodes still resolve"
);
eq(
	registered.findSeqByMessageId({ chat: { nodes: { noValuesHere: true } } }, "m-1"),
	undefined,
	"a non-iterable nodes store must fail soft, not throw (live regression)"
);
eq(registered.translateWith(registered.zh)("reason.open-turn"), "回合仍在进行中，暂不能删除", "zh reason lookup");
eq(registered.translateWith(registered.zh)("reason.already-shadowed"), "这条消息已被删除", "flat zh reason lookup");
if (typeof registered.zh["reason.already-shadowed"] !== "string") throw new Error("reason keys must be FLAT dotted strings (host LocaleRuntime does one-level lookup only)");
// Role-aware confirm bodies must exist in both dictionaries — runDelete picks
// one of these by the calling mount's static role.
for (const [dict, name] of [[registered.zh, "zh"], [registered.en, "en"]]) {
	for (const key of ["confirmBodyUser", "confirmBodyAssistant", "confirmBodyContext", "confirmBodyStep", "confirmBody"]) {
		if (typeof dict[key] !== "string") throw new Error(`${name}.${key} missing`);
	}
	// v0.2: scope-differentiated titles and tooltips.
	for (const key of ["confirmTitleStep", "confirmTitleWindow", "tooltipStep", "tooltipWindow"]) {
		if (typeof dict[key] !== "string") throw new Error(`${name}.${key} missing`);
	}
}
// Ledger round-trip over a stubbed localStorage.
const ledgetStore = new Map();
globalThis.window.localStorage = {
	getItem: (key) => (ledgetStore.has(key) ? ledgetStore.get(key) : null),
	setItem: (key, value) => ledgetStore.set(key, String(value)),
	removeItem: (key) => ledgetStore.delete(key)
};
registered.ledgerMark("s-ledger", 42);
registered.ledgerMark("s-ledger", 43);
if (!registered.ledgerHas("s-ledger", 42) || !registered.ledgerHas("s-ledger", 43)) throw new Error("ledger round-trip failed");
// v2 persistence shape: { s: exact seqs, r: turn ranges } — NOT the plain
// array v1 wrote (that assertion broke when ranges landed).
const persisted = JSON.parse(ledgetStore.get(`${registered.LEDGER_PREFIX}s-ledger`));
if (!persisted || !Array.isArray(persisted.s) || persisted.s.join(",") !== "42,43" || !Array.isArray(persisted.r)) {
	throw new Error("ledger persistence malformed");
}
// Regression (v0.1.3 → fix): turn-window bounds are EXCLUSIVE — each bound IS
// a real user input, so boundary seqs must read uncovered while strictly
// inside rows stay covered. The old inclusive comparison made the sweeper hide
// BOTH neighboring user inputs of every turn delete ("deleting one reply eats
// the surrounding user prompts").
registered.ledgerMarkRange("s-ranges", { start: 10, end: 20 });
if (registered.ledgerHas("s-ranges", 10)) throw new Error("window start (a real user input) must NOT be covered");
if (registered.ledgerHas("s-ranges", 20)) throw new Error("window end (a real user input) must NOT be covered");
if (!registered.ledgerHas("s-ranges", 11) || !registered.ledgerHas("s-ranges", 19)) {
	throw new Error("rows strictly inside the window must be covered");
}
// Open START stays open (harmless: future rows exceed the bounded end), and a
// null start must not coerce to 0.
registered.ledgerMarkRange("s-open-start", { start: null, end: 30 });
if (!registered.ledgerHas("s-open-start", 5) || registered.ledgerHas("s-open-start", 30)) {
	throw new Error("null start must be an open side, not zero");
}
// Regression (2026-08-29): a RIGHT-OPEN range must be REFUSED outright. It used
// to persist verbatim and cover every FUTURE row above the deleted window —
// "delete the latest reply and afterwards no assistant reply ever renders".
registered.ledgerMarkRange("s-open-end", { start: 30, end: null });
if (registered.ledgerHas("s-open-end", 9999) || registered.ledgerHas("s-open-end", 31)) {
	throw new Error("a right-unbounded range must never enter the ledger");
}
const openEndRaw = ledgetStore.get(`${registered.LEDGER_PREFIX}s-open-end`);
if (openEndRaw !== undefined && openEndRaw !== null && JSON.parse(openEndRaw).r.length !== 0) {
	throw new Error("a refused range must not persist");
}
// Legacy ledgers written by the poisoned build self-heal on load: right-open
// entries drop, exact seqs and bounded ranges survive.
ledgetStore.set(
	`${registered.LEDGER_PREFIX}s-legacy`,
	JSON.stringify({ s: [5], r: [[30, null], [10, 20]] })
);
const legacy = registered.ledgerFor("s-legacy");
if (!legacy.seqs.has(5) || legacy.ranges.length !== 1 || legacy.ranges[0].start !== 10 || legacy.ranges[0].end !== 20) {
	throw new Error("legacy right-open ranges must be dropped on load, bounded ones kept");
}
if (registered.ledgerHas("s-legacy", 9999)) {
	throw new Error("a dropped legacy range must not cover future rows");
}
// Two windows touching at a shared real-user-input bound must NOT merge — an
// inclusive merge ([10,20]+[20,30] → [10,30]) would re-cover seq 20.
registered.ledgerMarkRange("s-adjacent", { start: 10, end: 20 });
registered.ledgerMarkRange("s-adjacent", { start: 20, end: 30 });
if (registered.ledgerHas("s-adjacent", 20)) throw new Error("a shared boundary user input must stay uncovered after adjacent marks");
const adjacent = JSON.parse(ledgetStore.get(`${registered.LEDGER_PREFIX}s-adjacent`));
if (!adjacent || adjacent.r.length !== 2) throw new Error("touching windows must persist as two separate ranges");
// Genuinely overlapping windows still coalesce.
registered.ledgerMarkRange("s-overlap", { start: 10, end: 20 });
registered.ledgerMarkRange("s-overlap", { start: 15, end: 25 });
const overlap = JSON.parse(ledgetStore.get(`${registered.LEDGER_PREFIX}s-overlap`));
if (!overlap || overlap.r.length !== 1 || overlap.r[0][0] !== 10 || overlap.r[0][1] !== 25) {
	throw new Error("overlapping windows must coalesce");
}
eq(registered.detectDomLocale().length > 0, true, "dom locale heuristic returns something");

// ---------------------------------------------------------------------
// Preflight verdict cache + icon graying (v0.2 hardening) — logic-level
// assertions over a stubbed fetch. The live UI path (hover/click gates)
// is covered by tmp-probe/verify-preflight.mjs in a real browser.
// ---------------------------------------------------------------------
const pfT = registered.translateWith(registered.zh);
function fakeButton() {
	const attrs = new Map();
	return {
		setAttribute: (n, v) => attrs.set(n, String(v)),
		removeAttribute: (n) => attrs.delete(n),
		hasAttribute: (n) => attrs.has(n),
		getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null)
	};
}
const pfCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
	pfCalls.push(String(url));
	const u = String(url);
	if (u.includes("seq=9")) return { ok: true, json: async () => ({ ok: true, live: true, deletable: false, reason: "open-turn" }) };
	if (u.includes("seq=13")) return { ok: false, status: 500, json: async () => ({}) };
	return { ok: true, json: async () => ({ ok: true, live: true, deletable: true, mode: "single", count: 1 }) };
};
registered.verdictCache.clear();

const pfMain = async () => {
	// Key separates session/seq/scope — step and window verdicts must not mix.
	const k1 = registered.verdictKey("s-pf", 7, undefined);
	const k2 = registered.verdictKey("s-pf", 7, "step");
	if (k1 === k2) throw new Error("scope must be part of the verdict key");

	// Deletable verdict caches; a second ask serves the SAME object with zero
	// extra fetches.
	const v7a = await registered.requestVerdict("s-pf", 7, undefined);
	if (v7a?.deletable !== true) throw new Error("seq 7 should read deletable");
	const callsAfterFirst = pfCalls.length;
	const v7b = await registered.requestVerdict("s-pf", 7, undefined);
	if (v7b !== v7a) throw new Error("fresh cache must return the identical verdict object");
	if (pfCalls.length !== callsAfterFirst) throw new Error("cached ask must not refetch");

	// Refusal caches too — and grays a button; already-shadowed never grays.
	const v9 = await registered.requestVerdict("s-pf", 9, undefined);
	if (v9?.deletable !== false || v9?.reason !== "open-turn") throw new Error("seq 9 should read refused(open-turn)");
	const btn = fakeButton();
	registered.applyIconState(btn, v9);
	if (!btn.hasAttribute("data-dshdm-gray") || btn.getAttribute("aria-disabled") !== "true") throw new Error("refused verdict must gray the icon");
	registered.applyIconState(btn, { live: true, deletable: false, reason: "already-shadowed" });
	if (btn.hasAttribute("data-dshdm-gray")) throw new Error("already-shadowed must NOT gray (silent visual success)");
	registered.applyIconState(btn, null);
	if (btn.hasAttribute("data-dshdm-gray")) throw new Error("no verdict must leave the icon neutral");

	// localizedReason: known code localizes, unknown machine code falls back raw.
	if (registered.localizedReason(pfT, "open-turn") !== pfT("reason.open-turn")) throw new Error("known reason must localize");
	if (registered.localizedReason(pfT, "some-future-code") !== "some-future-code") throw new Error("unknown reason must fall back raw");

	// Lazy TTL: backdate entries directly — refused expires at 4s, deletable at 30s.
	registered.verdictCache.get(registered.verdictKey("s-pf", 9, undefined)).at = Date.now() - 4500;
	if (registered.cachedVerdict("s-pf", 9, undefined) !== undefined) throw new Error("expired refusal must re-ask");
	registered.verdictCache.get(registered.verdictKey("s-pf", 7, undefined)).at = Date.now() - 31000;
	if (registered.cachedVerdict("s-pf", 7, undefined) !== undefined) throw new Error("expired deletable verdict must re-ask");
	await registered.requestVerdict("s-pf", 7, undefined); // refetch after expiry

	// Unreachable /status resolves undefined (fail-open), no throw.
	const vDead = await registered.requestVerdict("s-pf", 13, undefined);
	if (vDead !== undefined) throw new Error("failed preflight must resolve undefined, not throw");

	// In-flight dedup: two concurrent asks for one uncached key fetch once.
	const before = pfCalls.length;
	const [p1, p2] = [registered.requestVerdict("s-pf", 21, "step"), registered.requestVerdict("s-pf", 21, "step")];
	const [r1, r2] = await Promise.all([p1, p2]);
	if (r1 !== r2) throw new Error("concurrent asks must share one verdict object");
	if (pfCalls.length - before !== 1) throw new Error(`concurrent asks must dedupe into ONE fetch, got ${pfCalls.length - before}`);
};

pfMain()
	.then(() => {
		globalThis.fetch = realFetch;

		// -----------------------------------------------------------------
		// Delete-flow transitions (pending dialog + row leave animation) —
		// logic-level contracts; the live UI path is covered by
		// tmp-probe/verify-transition.mjs in a real browser.
		// -----------------------------------------------------------------

		// The pending label ships in BOTH dictionaries (flat key, host rule).
		for (const [dict, name] of [[registered.zh, "zh"], [registered.en, "en"]]) {
			if (typeof dict.deleting !== "string" || dict.deleting === "") throw new Error(`${name}.deleting missing`);
		}
		eq(registered.translateWith(registered.zh)("deleting"), "删除中…", "zh pending label");

		// The stylesheet must carry every transition contract piece: modal
		// entrance/exit, spinner, inline error line, row-leave collapse, and a
		// reduced-motion escape hatch for each decorative animation.
		const styleText = source;
		for (const marker of [
			"@keyframes dshdm-modal-in",
			"@keyframes dshdm-fade-out",
			"data-dshdm-closing",
			".dshdm-spinner{",
			"@keyframes dshdm-spin",
			".dshdm-modal-error[hidden]{display:none}",
			"[data-dshdm-leaving]",
			"prefers-reduced-motion"
		]) {
			if (!styleText.includes(marker)) throw new Error(`STYLE_TEXT missing ${marker}`);
		}
		if (registered.LEAVE_ATTR !== "data-dshdm-leaving") throw new Error("LEAVE_ATTR drifted from the CSS selector");

		// hideRowsBySeqAnimated marks the ledger + clears verdicts SYNCHRONOUSLY
		// — before any animation timer can fire. A mid-animation React rebuild
		// heals through this ledger via the sweeper, so ordering is load-bearing.
		registered.verdictCache.clear();
		registered.verdictCache.set(registered.verdictKey("s-anim", 77, undefined), { at: Date.now(), status: { ok: true, live: true, deletable: true } });
		registered.hideRowsBySeqAnimated("s-anim", [77]);
		if (!registered.ledgerHas("s-anim", 77)) throw new Error("animated hide must mark the ledger synchronously");
		if (registered.verdictCache.size !== 0) throw new Error("animated hide must clear stale verdicts synchronously");
		// Empty plan is a no-op (no ledger write, no throw).
		registered.hideRowsBySeqAnimated("s-anim2", []);
		if (registered.ledgerFor("s-anim2").seqs.size !== 0) throw new Error("empty plan must not touch the ledger");
		// Chat-node variant keeps the same synchronous-ledger contract.
		registered.hideRowsViaChatNodesAnimated("s-anim3", [78], {
			chat: { nodes: { values: () => [{ key: "k1", kind: "assistant-step", data: { finalNode: { seq: 78 } } }] } }
		});
		if (!registered.ledgerHas("s-anim3", 78)) throw new Error("chat-node animated hide must mark the ledger synchronously");
		// Invalid snapshot fails soft, exactly like the instant variant.
		registered.hideRowsViaChatNodesAnimated("s-anim4", [79], null);
		if (registered.ledgerFor("s-anim4").seqs.size !== 0) throw new Error("null snapshot must be a no-op");
		// animateRowsOut with nothing eligible resolves silently.
		registered.animateRowsOut([]);

		console.log("SMOKE OK — assistant slot renders without crashing; seq resolution contract holds");
		console.log("SMOKE OK — preflight verdict cache + icon graying contract holds");
		console.log("SMOKE OK — delete-flow transitions (pending state machine styles + animated hide contracts) hold");
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
