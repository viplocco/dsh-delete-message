/**
 * Deletion-eligibility rules, each as a table row a regression can point at.
 *
 * @module test/surface.test.js
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessDeletion, buildPlaceholder, enclosingTurnBracket, hasToolUse, insideOpenTurn, planDeletion, REFUSALS } from "../src/surface.js";

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

	// Regression: the v0.1 placeholder shipped WITHOUT `source`. Append accepted
	// it (no message-shape check there), the record persisted, and the session
	// then refused to load forever after — assertMessageEventShape demands a
	// `{ kind }` source at the reload boundary.
	it("carries a user source so the persisted event survives load validation", () => {
		const placeholder = buildPlaceholder("[deleted]");
		assert.deepEqual(placeholder.source, { kind: "user" });
	});
});

/**
 * A multi-step tool-call reply, bracketed [0..9], initiated by a REAL user
 * input INSIDE the bracket (the shape real logs show — turn/start precedes
 * the user's message):
 *    0 turn/start
 *    1 user input "run the checks"      ← window boundary
 *    2 injected context (plugin source)
 *    3 assistant message invoking a tool
 *    4 tool/result
 *    5 assistant narration text
 *    6 assistant message invoking a second tool
 *    7 tool/result
 *    8 closing assistant prose          ← the delete click lands here
 *    9 turn/end
 * then an independent closed turn 10..12.
 */
function multiStepTurnLog() {
	const append = (seq, type, extra = {}) => event(seq, type, { surfaceOp: "append", ...extra });
	const asst = (seq, id, content) => append(seq, "assistant/message", { data: { message: { id, role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content } } });
	return [
		append(0, "turn/start"),
		append(1, "user/message", { data: { id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "run the checks" }] } }),
		append(2, "user/message", { data: { id: "ctx-1", role: "user", source: { kind: "plugin" }, content: [] } }),
		asst(3, "a1", [{ type: "tool_use", id: "t1" }]),
		append(4, "tool/result", { data: { message: { id: "r1", role: "user", source: { kind: "tool", callId: "t1" }, content: [{ type: "tool-result", toolCallId: "t1", content: [] }] } } }),
		asst(5, "a2", [{ type: "text", text: "narration" }]),
		asst(6, "a3", [{ type: "tool_use", id: "t2" }]),
		append(7, "tool/result", { data: { message: { id: "r2", role: "user", source: { kind: "tool", callId: "t2" }, content: [{ type: "tool-result", toolCallId: "t2", content: [] }] } } }),
		asst(8, "a4", [{ type: "text", text: "final answer" }]),
		append(9, "turn/end"),
		append(10, "turn/start"),
		append(11, "user/message", { data: { id: "u2", role: "user", source: { kind: "user" }, content: [] } }),
		append(12, "turn/end")
	];
}

describe("planDeletion (user-input windows)", () => {
	it("expands an assistant target to the whole live window between user inputs", () => {
		const verdict = planDeletion(multiStepTurnLog(), 8);
		assert.deepEqual(verdict, {
			ok: true,
			mode: "turn",
			seqs: [2, 3, 4, 5, 6, 7, 8],
			range: { start: 1, end: 11 }
		});
	});

	it("never covers the initiating user row — its seq is a window bound", () => {
		const verdict = planDeletion(multiStepTurnLog(), 8);
		assert.equal(verdict.seqs.includes(1), false);
		assert.equal(planCoversLike(verdict.range, 1), false);
		assert.equal(planCoversLike(verdict.range, 11), false);
	});

	it("includes machine-injected context in the unit", () => {
		const verdict = planDeletion(multiStepTurnLog(), 8);
		assert.equal(verdict.seqs.includes(2), true);
	});

	it("keeps single semantics for a USER-message target", () => {
		assert.deepEqual(planDeletion(multiStepTurnLog(), 1), { ok: true, mode: "single", seqs: [1] });
	});

	it("cleans up a partially deleted reply on re-click (skips shadowed members)", () => {
		const events = [
			...multiStepTurnLog(),
			{
				seq: 13,
				type: "user/message",
				surfaceOp: { op: "replace", start: 8, end: 8 },
				sourceEventSeqs: [8],
				data: { id: "deleted-x", role: "user", source: { kind: "user" }, content: [] }
			}
		];
		// The closing node is already shadowed; assessDeletion refuses it, but
		// the plan still removes every remaining live member of the window.
		assert.deepEqual(planDeletion(events, 8), {
			ok: true,
			mode: "turn",
			seqs: [2, 3, 4, 5, 6, 7],
			range: { start: 1, end: 11 }
		});
	});

	it("refuses when every window member is already shadowed", () => {
		const base = multiStepTurnLog();
		const extra = [];
		for (const seq of [2, 3, 4, 5, 6, 7, 8]) {
			extra.push({
				seq: 20 + seq,
				type: "user/message",
				surfaceOp: { op: "replace", start: seq, end: seq },
				sourceEventSeqs: [seq],
				data: { id: `deleted-${seq}`, role: "user", source: { kind: "user" }, content: [] }
			});
		}
		assert.deepEqual(planDeletion([...base, ...extra], 8), { ok: false, reason: REFUSALS.ALREADY_SHADOWED });
	});

	it("refuses an open turn", () => {
		const events = [...multiStepTurnLog(), event(13, "turn/start"), event(14, "user/message", { surfaceOp: "append" })];
		// Target inside the NEW open bracket → open-turn refusal.
		assert.deepEqual(planDeletion(events, 14), { ok: false, reason: REFUSALS.OPEN_TURN });
		// An assistant node in that open bracket is refused the same way.
		const events2 = [...events, event(15, "assistant/message", { surfaceOp: "append", data: { message: { id: "a9", role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text" }] } } })];
		assert.deepEqual(planDeletion(events2, 15), { ok: false, reason: REFUSALS.OPEN_TURN });
		// Earlier CLOSED replies stay plannable even while a later one runs.
		assert.equal(planDeletion(events, 8).ok, true);
	});

	it("steering splits the window: each side is its own unit", () => {
		const append = (seq, type, extra = {}) => event(seq, type, { surfaceOp: "append", ...extra });
		const asst = (seq, id, content) => append(seq, "assistant/message", { data: { message: { id, role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content } } });
		const events = [
			append(0, "turn/start"),
			append(1, "user/message", { data: { id: "u1", role: "user", source: { kind: "user" }, content: [] } }),
			append(2, "user/message", { data: { id: "ctx", role: "user", source: { kind: "plugin" }, content: [] } }),
			asst(3, "a1", [{ type: "text", text: "working" }]),
			append(4, "tool/result", { data: { message: { id: "r1", role: "user", source: { kind: "tool", callId: "t1" }, content: [] } } }),
			asst(5, "a2", [{ type: "text", text: "narration" }]),
			append(6, "user/message", { data: { id: "steer", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "focus!" }] } }),
			asst(7, "a3", [{ type: "text", text: "final answer" }]),
			append(8, "turn/end"),
			append(9, "turn/start"),
			append(10, "user/message", { data: { id: "u2", role: "user", source: { kind: "user" }, content: [] } }),
			append(11, "turn/end")
		];
		// Deleting the post-steering closing prose covers ONLY (6, 10).
		const after = planDeletion(events, 7);
		assert.deepEqual(after.seqs, [7]);
		assert.deepEqual(after.range, { start: 6, end: 10 });
		assert.equal(after.seqs.includes(6), false);
		// Deleting the pre-steering part covers (1, 6) and leaves the steering
		// word itself untouched.
		const before = planDeletion(events, 5);
		assert.deepEqual(before.seqs, [2, 3, 4, 5]);
		assert.deepEqual(before.range, { start: 1, end: 6 });
		assert.equal(before.seqs.includes(6), false);
	});

	it("falls back to single semantics for standalone nodes outside any bracket", () => {
		const events = [
			event(0, "session/title"),
			event(1, "user/message", { surfaceOp: "append", data: { id: "solo", role: "user", source: { kind: "user" }, content: [] } })
		];
		assert.deepEqual(planDeletion(events, 1), { ok: true, mode: "single", seqs: [1] });
	});
});

/** Local mirror of the client's exclusive-bound window test. */
function planCoversLike(range, seq) {
	if (typeof seq !== "number") return false;
	return (range.start === null || seq > range.start) && (range.end === null || seq < range.end);
}

describe("enclosingTurnBracket", () => {
	it("finds the bracket and its end", () => {
		assert.deepEqual(enclosingTurnBracket(multiStepTurnLog(), 5), { start: 0, end: 9, open: false });
	});
	it("reports an unclosed bracket as open", () => {
		const events = [event(0, "turn/start"), event(1, "user/message")];
		assert.deepEqual(enclosingTurnBracket(events, 1), { start: 0, open: true });
	});
	it("is undefined before any bracket", () => {
		assert.equal(enclosingTurnBracket([event(5, "session/title")], 5), undefined);
	});
});
