/**
 * Smoke: load the bundle the way the client module system would, apply it
 * against a stub ctx, then REALLY render the registered assistant-actions
 * component with the host's React 18.3.1 + react-dom — the exact path that
 * crashed (single-arg jsx) and silently abdicated in v0.1.1.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const hostModules = "C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules";
const nodeRequire = createRequire(import.meta.url);
const react = nodeRequire(`${hostModules}/react`);
const jsxRuntime = nodeRequire(`${hostModules}/react/jsx-runtime`);
const { renderToStaticMarkup } = nodeRequire(`${hostModules}/react-dom/server`);

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
eq(registered.detectDomLocale().length > 0, true, "dom locale heuristic returns something");

console.log("SMOKE OK — assistant slot renders without crashing; seq resolution contract holds");
