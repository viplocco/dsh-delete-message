/**
 * Deletion-eligibility rules, each as a table row a regression can point at.
 *
 * @module test/surface.test.js
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessDeletion, buildPlaceholder, hasToolUse, insideOpenTurn, REFUSALS } from "../src/surface.js";

/** Event factory — only the fields the rules read. */
function event(seq, type, extra = {}) {
	return { seq, type, ...extra };
}

function closedTurnLog() {
	// seq 0 turn/start … 1 user … 2 assistant … 3 tool/result … 4 turn/end,
	// then a second closed turn 5..8. Every message is a plain append.
	return [
		event(0, "turn/start"),
		event(1, "user/message", { surfaceOp: "append", data: { content: [{ type: "text", text: "hi" }] } }),
		event(2, "assistant/message", { surfaceOp: "append", data: { message: { content: [{ type: "text", text: "hello" }] } } }),
		event(3, "tool/result", { surfaceOp: "append" }),
		event(4, "turn/end"),
		event(5, "turn/start"),
		event(6, "user/message", { surfaceOp: "append", data: { content: [{ type: "text", text: "again" }] } }),
		event(7, "assistant/message", { surfaceOp: "append", data: { message: { content: [{ type: "text", text: "answer" }] } } }),
		event(8, "turn/end")
	];
}

describe("assessDeletion", () => {
	it("accepts a plain user message in a closed turn", () => {
		assert.deepEqual(assessDeletion(closedTurnLog(), 1), { ok: true });
	});

	it("accepts a plain assistant message in a closed turn", () => {
		assert.deepEqual(assessDeletion(closedTurnLog(), 7), { ok: true });
	});

	it("refuses an unknown seq with not-found", () => {
		assert.deepEqual(assessDeletion(closedTurnLog(), 99), { ok: false, reason: REFUSALS.NOT_FOUND });
	});

	it("refuses non-safe-integer and negative seqs with not-found", () => {
		for (const bad of [NaN, 1.5, -1, Infinity]) {
			assert.deepEqual(assessDeletion(closedTurnLog(), bad), { ok: false, reason: REFUSALS.NOT_FOUND });
		}
	});

	it("refuses tool results — they are never deletable alone", () => {
		const verdict = assessDeletion(closedTurnLog(), 3);
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason, /not-surface-type|has-tool-calls/);
	});

	it("refuses log-only events (turn boundaries)", () => {
		assert.deepEqual(assessDeletion(closedTurnLog(), 0), { ok: false, reason: REFUSALS.NOT_SURFACE_TYPE });
		assert.deepEqual(assessDeletion(closedTurnLog(), 4), { ok: false, reason: REFUSALS.NOT_SURFACE_TYPE });
	});

	it("refuses an already-shadowed node", () => {
		const events = [
			...closedTurnLog(),
			{
				seq: 9,
				type: "user/message",
				surfaceOp: { op: "replace", start: 1, end: 1 },
				sourceEventSeqs: [1],
				data: { role: "user", content: [{ type: "text", text: "[deleted]" }] }
			}
		];
		assert.deepEqual(assessDeletion(events, 1), { ok: false, reason: REFUSALS.ALREADY_SHADOWED });
		// The replacement node itself is deletable again? No — its surfaceOp is
		// also a replace object, so it refuses the same way.
		assert.deepEqual(assessDeletion(events, 9), { ok: false, reason: REFUSALS.ALREADY_SHADOWED });
	});

	it("refuses an assistant message that invoked tools", () => {
		const events = [
			event(0, "turn/start"),
			event(1, "assistant/message", {
				surfaceOp: "append",
				data: { message: { content: [{ type: "tool_use", id: "t1" }, { type: "text", text: "running…" }] } }
			}),
			event(2, "tool/result", { surfaceOp: "append" }),
			event(3, "turn/end")
		];
		assert.deepEqual(assessDeletion(events, 1), { ok: false, reason: REFUSALS.HAS_TOOL_CALLS });
	});

	it("refuses any node inside an open turn", () => {
		const events = [
			...closedTurnLog(),
			event(9, "turn/start"),
			event(10, "user/message", { surfaceOp: "append", data: { content: [] } }),
			event(11, "assistant/message", { surfaceOp: "append", data: { message: { content: [{ type: "text", text: "thinking" }] } } })
		];
		assert.deepEqual(assessDeletion(events, 10), { ok: false, reason: REFUSALS.OPEN_TURN });
		assert.deepEqual(assessDeletion(events, 7), { ok: true }); // earlier closed turns stay fine
	});
});

describe("insideOpenTurn", () => {
	it("is false before any turn starts", () => {
		assert.equal(insideOpenTurn([event(0, "session/title")], 0), false);
	});
	it("is true while the bracket is unclosed, false once the end lands — even at a higher seq", () => {
		const events = [event(0, "turn/start"), event(1, "user/message")];
		assert.equal(insideOpenTurn(events, 1), true);
		events.push(event(2, "turn/end"), event(3, "user/message"));
		// The whole log is the truth about closure: the end at seq 2 finishes
		// the bracket containing seq 1, so that earlier message is deletable
		// even while later turns run.
		assert.equal(insideOpenTurn(events, 1), false);
		assert.equal(insideOpenTurn(events, 2), false);
	});
});

describe("hasToolUse", () => {
	it("detects tool-ish blocks case-insensitively and tolerates junk", () => {
		assert.equal(hasToolUse([{ type: "text" }]), false);
		assert.equal(hasToolUse([{ type: "tool_use" }]), true);
		assert.equal(hasToolUse([{ type: "ToolCall" }]), true);
		assert.equal(hasToolUse([]), false);
		assert.equal(hasToolUse(undefined), false);
		assert.equal(hasToolUse([{ noType: true }, null, "x"]), false);
	});
});

describe("buildPlaceholder", () => {
	it("produces a JSON-safe user-role payload with fresh ids", () => {
		const first = buildPlaceholder("[已删]");
		const second = buildPlaceholder("[已删]");
		assert.equal(first.role, "user");
		assert.deepEqual(first.content, [{ type: "text", text: "[已删]" }]);
		assert.notEqual(first.id, second.id);
		JSON.stringify(first); // must not throw (losslessly serializable)
	});
});
