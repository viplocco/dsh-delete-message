/**
 * Tests for the browser-half compatibility fix (v0.2.3).
 *
 * The user-message delete button and the assistant-message grey-button bugs
 * trace back to two host-structure assumptions that stopped matching the
 * current Desktop UI (`@deepseek-ai/dsh-client-ui-chat@0.1.2-rc.1`):
 *
 *   1. The DOM-enhancement entry matcher looked for the removed
 *      `data-time-hover-root` attribute; the host now identifies a user row by
 *      its wrapper's `data-chat-flow-kind` and nests the actions strip a level
 *      deeper (`wrapper > div.userRow > div.*_actions`).
 *   2. `findSeqByMessageId` never inspected a turn-tail node's
 *      `data.closing.finalNode`, so compacted/folded turns could not resolve
 *      their surface seq and the assistant trash stayed `disabled` (grey).
 *
 * These are pure, DOM-shape-driven rules. Rather than spin up a browser, we
 * pin them against a minimal Element stub that mirrors the host's actual
 * rendered tree, so a future host-layout change breaks a test instead of a
 * user's conversation.
 *
 * @module dsh-delete-message/client.test
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

/** Regex mirrored from src/client.js ACTIONS_TOKEN. */
const ACTIONS_TOKEN = /(?:^|\s)([\w$-]+_actions)(?:\s|$)/;

/** Mirrors src/client.js looksLikeActionsStrip. */
function looksLikeActionsStrip(el) {
	return el.tagName === "DIV"
		&& ACTIONS_TOKEN.test(typeof el.className === "string" ? el.className : "")
		&& el.querySelector(":scope > button") !== null;
}

/** Mirrors src/client.js findActionsStrip (BFS from root, exclusive of root). */
function findActionsStrip(root) {
	const queue = [];
	for (const child of root.children) queue.push(child);
	while (queue.length > 0) {
		const el = queue.shift();
		if (looksLikeActionsStrip(el)) return el;
		for (const child of el.children) queue.push(child);
	}
	return null;
}

/** Mirrors src/client.js findSeqByMessageId with the v0.2.3 turn-tail branch. */
function findSeqByMessageId(snapshot, messageId) {
	if (snapshot === null || snapshot === undefined || messageId === undefined) return undefined;
	const store = snapshot.chat?.nodes;
	let nodes;
	if (Array.isArray(store)) nodes = store;
	else if (store !== null && typeof store === "object" && typeof store.values === "function") nodes = store.values();
	else return undefined;
	for (const node of nodes) {
		const data = node?.data;
		if (data === null || typeof data !== "object") continue;
		const finalNode = data.finalNode;
		if (finalNode !== null && typeof finalNode === "object"
			&& finalNode.messageId !== undefined && String(finalNode.messageId) === String(messageId)) {
			return typeof finalNode.seq === "number" ? finalNode.seq : undefined;
		}
		if (data.kind === "steering" && data.messageId !== undefined && String(data.messageId) === String(messageId)) {
			return typeof data.seq === "number" ? data.seq : undefined;
		}
		// v0.2.3: a turn-tail node carries the closing message under
		// data.closing.finalNode.
		const closingFinal = data.closing?.finalNode;
		if (closingFinal !== null && typeof closingFinal === "object"
			&& closingFinal.messageId !== undefined && String(closingFinal.messageId) === String(messageId)) {
			return typeof closingFinal.seq === "number" ? closingFinal.seq : undefined;
		}
	}
	return undefined;
}

/**
 * Minimal Element stub: enough surface for the three pure helpers
 * (children, querySelector, getAttribute, className, tagName).
 */
function el(tagName, className = "", attrs = {}) {
	const node = {
		tagName: tagName.toUpperCase(),
		className,
		attrs: { ...attrs },
		children: [],
		parent: null,
		getAttribute(name) {
			return this.attrs[name] !== undefined ? String(this.attrs[name]) : null;
		},
		hasAttribute(name) {
			return this.attrs[name] !== undefined;
		},
		querySelector(selector) {
			// The only selector the helpers actually run is ":scope > button".
			if (selector === ":scope > button") {
				return this.children.find((c) => c.tagName === "BUTTON") ?? null;
			}
			return null;
		},
		appendChild(child) {
			child.parent = this;
			this.children.push(child);
		}
	};
	return node;
}

/** Build the host 0.1.2-rc.1 user-row DOM tree (wrapper > userRow > userStack + actions). */
function hostUserRow({ kind = "user", messageId = "u-1", seq = 7 }) {
	const wrapper = el("div", "chatFlowItem", { "data-chat-flow-key": "k-1", "data-chat-flow-kind": kind });
	const userRow = el("div", "userRow", { "data-pending-steering": "" });
	const userStack = el("div", "userStack");
	userStack.appendChild(el("div", "bubble", {}));
	const actions = el("div", "jo426G_actions", {});
	actions.appendChild(el("span", "jo426G_timeStart", {}));
	actions.appendChild(el("button", "jo426G_action", {})); // copy button
	userRow.appendChild(userStack);
	userRow.appendChild(actions);
	wrapper.appendChild(userRow);
	return { wrapper, actions, copyButton: actions.children[1] };
}

describe("user-row DOM enhancement (host 0.1.2-rc.1)", () => {
	it("finds the nested actions strip under a user wrapper (was: never mounted)", () => {
		const { wrapper, actions } = hostUserRow({});
		// The wrapper itself is NOT an actions strip and has no data-time-hover-root.
		assert.equal(wrapper.getAttribute("data-time-hover-root"), null);
		assert.equal(looksLikeActionsStrip(wrapper), false);
		// The strip is a grandchild, not a direct child, of the wrapper.
		assert.equal(wrapper.children.some((c) => c === actions), false);
		// findActionsStrip must drill down to it.
		assert.equal(findActionsStrip(wrapper), actions);
	});

	it("recognises a user wrapper by data-chat-flow-kind (entry matcher gate)", () => {
		for (const kind of ["user", "steering"]) {
			const { wrapper } = hostUserRow({ kind });
			const g = wrapper.getAttribute("data-chat-flow-kind");
			assert.ok(g === "user" || g === "steering");
			assert.ok(wrapper.hasAttribute("data-chat-flow-key"));
		}
	});

	it("does not mistake a non-actions div for an actions strip", () => {
		const wrapper = el("div", "chatFlowItem", { "data-chat-flow-kind": "user" });
		const userRow = el("div", "userRow", {});
		userRow.appendChild(el("div", "userStack", {}));
		wrapper.appendChild(userRow);
		// No *_actions strip anywhere -> nothing to mount.
		assert.equal(findActionsStrip(wrapper), null);
	});
});

describe("findSeqByMessageId turn-tail resolution", () => {
	it("resolves a compacted turn through data.closing.finalNode (was: disabled/grey)", () => {
		const snapshot = {
			chat: {
				nodes: {
					values: () => [
						// assistant-step node is ABSENT (folded/compacted away);
						// only the turn-tail node remains.
						{
							kind: "turn-tail",
							data: {
								turn: 1,
								closing: { finalNode: { messageId: "m-42", seq: 17 } }
							}
						}
					]
				}
			}
		};
		assert.equal(findSeqByMessageId(snapshot, "m-42"), 17);
		// The old code (pre-fix) returned undefined here because it never read
		// data.closing.finalNode.
	});

	it("still resolves a settled assistant-step node via data.finalNode", () => {
		const snapshot = {
			chat: {
				nodes: {
					values: () => [
						{ kind: "assistant-step", data: { finalNode: { messageId: "m-9", seq: 9 } } }
					]
				}
			}
		};
		assert.equal(findSeqByMessageId(snapshot, "m-9"), 9);
	});

	it("resolves a steering node via data.messageId/data.seq", () => {
		// The plugin's steering branch reads node.data.kind === "steering"
		// (the kind rides on the node's data payload in the conversation shape).
		const snapshot = {
			chat: {
				nodes: {
					values: () => [
						{ kind: "steering", data: { kind: "steering", messageId: "m-5", seq: 5 } }
					]
				}
			}
		};
		assert.equal(findSeqByMessageId(snapshot, "m-5"), 5);
	});

	it("returns undefined for an unknown message id (stays neutral, not grey)", () => {
		const snapshot = {
			chat: {
				nodes: {
					values: () => [{ kind: "assistant-step", data: { finalNode: { messageId: "m-x", seq: 2 } } }]
				}
			}
		};
		assert.equal(findSeqByMessageId(snapshot, "m-missing"), undefined);
	});
});