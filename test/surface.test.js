/**
 * Deletion-eligibility rules, each as a table row a regression can point at.
 *
 * @module test/surface.test.js
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessDeletion, boundClientWindow, buildPlaceholder, enclosingTurnBracket, hasToolUse, insideOpenTurn, planDeletion, REFUSALS } from "../src/surface.js";

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

describe("planDeletion (unit mode via machine-injected context)", () => {
	it("expands an injected context row to the whole live window (mode unit)", () => {
		// multiStepTurnLog: seq 2 is the machine-injected plugin row.
		assert.deepEqual(planDeletion(multiStepTurnLog(), 2), {
			ok: true,
			mode: "unit",
			seqs: [2, 3, 4, 5, 6, 7, 8],
			range: { start: 1, end: 11 }
		});
	});

	it("never covers the real user boundary rows", () => {
		const verdict = planDeletion(multiStepTurnLog(), 2);
		assert.equal(verdict.seqs.includes(1), false);
		assert.equal(verdict.seqs.includes(11), false);
		assert.equal(planCoversLike(verdict.range, 1), false);
		assert.equal(planCoversLike(verdict.range, 11), false);
	});

	it("keeps single semantics for a REAL user message (source kind user)", () => {
		assert.deepEqual(planDeletion(multiStepTurnLog(), 1), { ok: true, mode: "single", seqs: [1] });
	});

	it("cleans a failed turn that produced NO assistant message", () => {
		// The screenshot shape: user prompt + three machine-injected context
		// rows, then a closed turn with nothing else — a 502 retry chain.
		const append = (seq, type, extra = {}) => event(seq, type, { surfaceOp: "append", ...extra });
		const events = [
			append(0, "turn/start"),
			append(1, "user/message", { data: { id: "u1", role: "user", source: { kind: "user" }, content: [] } }),
			append(2, "user/message", { data: { id: "ctx-1", role: "user", source: { kind: "plugin" }, content: [] } }),
			append(3, "user/message", { data: { id: "ctx-2", role: "user", source: { kind: "plugin" }, content: [] } }),
			append(4, "user/message", { data: { id: "ctx-3", role: "user", source: { kind: "skill-catalog" }, content: [] } }),
			append(5, "turn/end")
		];
		const verdict = planDeletion(events, 2);
		assert.deepEqual(verdict, { ok: true, mode: "unit", seqs: [2, 3, 4], range: { start: 1, end: 6 } });
		// The user prompt is a boundary and must survive.
		assert.equal(verdict.seqs.includes(1), false);
	});

	it("refuses an injected target inside an open turn", () => {
		const append = (seq, type, extra = {}) => event(seq, type, { surfaceOp: "append", ...extra });
		const events = [
			append(0, "turn/start"),
			append(1, "user/message", { data: { id: "u1", role: "user", source: { kind: "user" }, content: [] } }),
			append(2, "user/message", { data: { id: "ctx-1", role: "user", source: { kind: "plugin" }, content: [] } })
			// no turn/end — still streaming
		];
		assert.deepEqual(planDeletion(events, 2), { ok: false, reason: REFUSALS.OPEN_TURN });
	});

	it("skips already-shadowed members on a partially deleted unit", () => {
		const base = multiStepTurnLog();
		const extra = [
			{
				seq: 20,
				type: "user/message",
				surfaceOp: { op: "replace", start: 8, end: 8 },
				sourceEventSeqs: [8],
				data: { id: "deleted-8", role: "user", source: { kind: "user" }, content: [] }
			}
		];
		const verdict = planDeletion([...base, ...extra], 2);
		assert.deepEqual(verdict, { ok: true, mode: "unit", seqs: [2, 3, 4, 5, 6, 7], range: { start: 1, end: 11 } });
	});

	it("refuses when the whole unit is already shadowed", () => {
		const base = multiStepTurnLog();
		const extra = [];
		for (const seq of [2, 3, 4, 5, 6, 7, 8]) {
			extra.push({
				seq: 30 + seq,
				type: "user/message",
				surfaceOp: { op: "replace", start: seq, end: seq },
				sourceEventSeqs: [seq],
				data: { id: `deleted-${seq}`, role: "user", source: { kind: "user" }, content: [] }
			});
		}
		assert.deepEqual(planDeletion([...base, ...extra], 2), { ok: false, reason: REFUSALS.ALREADY_SHADOWED });
	});

	it("routes an already-shadowed injected row to unit cleanup when members remain", () => {
		const base = multiStepTurnLog();
		const extra = [
			{
				seq: 20,
				type: "user/message",
				surfaceOp: { op: "replace", start: 2, end: 2 },
				sourceEventSeqs: [2],
				data: { id: "deleted-2", role: "user", source: { kind: "user" }, content: [] }
			}
		];
		// The clicked injected row is itself shadowed, but live members remain —
		// the unit still plans them (mirrors assistant-mode tolerance).
		assert.deepEqual(planDeletion([...base, ...extra], 2), {
			ok: true,
			mode: "unit",
			seqs: [3, 4, 5, 6, 7, 8],
			range: { start: 1, end: 11 }
		});
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

describe("planDeletion (chrome anchors over non-surface events)", () => {
	// The transcript renders rows anchored at NON-surface events — tool/call
	// summaries, llm/retry chain entries, turn errors. A trash click there has
	// no surface node to cite, so the anchor plans its whole user-input window.
	function chromeAnchorLog() {
		const append = (seq, type, extra = {}) => event(seq, type, { surfaceOp: "append", ...extra });
		return [
			append(0, "turn/start"),
			append(1, "user/message", { data: { id: "u1", role: "user", source: { kind: "user" }, content: [] } }),
			append(2, "user/message", { data: { id: "ctx", role: "user", source: { kind: "plugin" }, content: [] } }),
			append(3, "assistant/message", { data: { message: { id: "a1", role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "tool_use", id: "t1" }] } } }),
			event(4, "tool/call"),                                   // non-surface chrome
			append(5, "tool/result", { data: { message: { id: "r1", role: "user", source: { kind: "tool", callId: "t1" }, content: [] } } }),
			event(6, "llm/retry"),                                   // non-surface chrome
			event(7, "llm/retry-started"),                           // non-surface chrome
			append(8, "turn/end")
		];
	}

	it("a tool/call summary anchor plans the window (assistant + result + injections)", () => {
		assert.deepEqual(planDeletion(chromeAnchorLog(), 4), {
			ok: true,
			mode: "unit",
			seqs: [2, 3, 5],
			range: { start: 1, end: 9 }
		});
	});

	it("an llm/retry anchor plans the same window", () => {
		assert.deepEqual(planDeletion(chromeAnchorLog(), 6).seqs, [2, 3, 5]);
		assert.deepEqual(planDeletion(chromeAnchorLog(), 7).seqs, [2, 3, 5]);
	});

	it("a chrome anchor never pulls in the boundary user row", () => {
		const verdict = planDeletion(chromeAnchorLog(), 4);
		assert.equal(verdict.seqs.includes(1), false);
	});

	it("refuses a chrome anchor inside an open turn", () => {
		const events = [...chromeAnchorLog().slice(0, -1)];
		events.push(
			event(9, "turn/end"),
			event(10, "turn/start"),
			event(11, "user/message", { surfaceOp: "append", data: { id: "u2", role: "user", source: { kind: "user" }, content: [] } }),
			event(12, "tool/call")
		);
		// seq 12 sits inside the OPEN bracket started at 10 → open-turn.
		assert.deepEqual(planDeletion(events, 12), { ok: false, reason: REFUSALS.OPEN_TURN });
	});

	it("refuses with already-shadowed when a chrome anchor's window has no live members", () => {
		// An event before ANY user input has no window members at all.
		assert.deepEqual(planDeletion([event(0, "session/title")], 0), { ok: false, reason: REFUSALS.ALREADY_SHADOWED });
	});
});

describe("planDeletion scope=step (per-step granular deletion)", () => {
	// A multi-step turn modeled on real logs:
	//   step 1: Think + 3 Glob calls → assistant/msg(3) + tool/results(5,7,9)
	//   step 2: retry failed, no reply
	function stepTurnLog() {
		const append = (seq, type, extra = {}) => event(seq, type, { surfaceOp: "append", ...extra });
		const asst = (seq, id, content) => append(seq, "assistant/message", { data: { message: { id, role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content } } });
		return [
			append(0, "turn/start"),
			append(1, "user/message", { data: { id: "u1", role: "user", source: { kind: "user" }, content: [] } }),
			append(2, "user/message", { data: { id: "ctx1", role: "user", source: { kind: "plugin" }, content: [] } }),
			asst(3, "a1", [{ type: "tool_use", id: "t1" }]),
			event(4, "tool/call"),
			append(5, "tool/result", { data: { message: { id: "r1", role: "user", source: { kind: "tool", callId: "t1" }, content: [] } } }),
			event(6, "tool/call"),
			asst(7, "a2", [{ type: "text", text: "step 1 answer" }]),
			append(8, "turn/end")
		];
	}

	it("deletes only the owning assistant/message + its tool/results (mode step)", () => {
		// Target seq 4 (tool/call chrome anchor) → owning assistant is seq 3.
		// Collection walks forward: assistant(3) + tool/result(5). Stops at
		// assistant(7) (next step).
		assert.deepEqual(planDeletion(stepTurnLog(), 4, "step"), {
			ok: true,
			mode: "step",
			seqs: [3, 5],
			range: { start: 3, end: 5 }
		});
	});

	it("an assistant/message target deletes just itself when it has no tools", () => {
		assert.deepEqual(planDeletion(stepTurnLog(), 7, "step"), {
			ok: true,
			mode: "step",
			seqs: [7],
			range: { start: 7, end: 7 }
		});
	});

	it("other steps in the same turn survive a step deletion", () => {
		const verdict = planDeletion(stepTurnLog(), 4, "step");
		assert.equal(verdict.seqs.includes(7), false, "step 2's reply must survive");
	});

	it("machine-injected context rows are NOT collected in step mode", () => {
		const verdict = planDeletion(stepTurnLog(), 4, "step");
		assert.equal(verdict.seqs.includes(2), false, "injected context must stay");
	});

	it("real user input is never collected", () => {
		const verdict = planDeletion(stepTurnLog(), 4, "step");
		assert.equal(verdict.seqs.includes(1), false);
	});

	it("refuses with open-turn for an unsettled step", () => {
		const events = [...stepTurnLog().slice(0, -1)]; // remove turn/end
		events.push(event(9, "turn/start"), event(10, "assistant/message", { surfaceOp: "append", data: { message: { content: [] } } }));
		assert.deepEqual(planDeletion(events, 10, "step"), { ok: false, reason: REFUSALS.OPEN_TURN });
	});

	it("backward-scans from a tool/result to find the owning assistant", () => {
		// Target the tool/result at seq 5 directly.
		const verdict = planDeletion(stepTurnLog(), 5, "step");
		assert.deepEqual(verdict.seqs, [3, 5]);
	});

	it("skips already-shadowed members and collects remaining live ones", () => {
		const base = stepTurnLog();
		const shadow = {
			seq: 20, type: "user/message",
			surfaceOp: { op: "replace", start: 3, end: 3 },
			sourceEventSeqs: [3],
			data: { id: "deleted-3", role: "user", source: { kind: "user" }, content: [] }
		};
		const verdict = planDeletion([...base, shadow], 4, "step");
		// assistant(3) is shadowed; tool/result(5) still live → collected.
		assert.deepEqual(verdict.seqs, [5]);
	});

	it("without scope, routing stays backward-compatible", () => {
		// Same target WITHOUT scope → unit mode (whole window), not step.
		const verdict = planDeletion(stepTurnLog(), 4);
		assert.equal(verdict.mode, "unit");
		assert.notEqual(verdict.mode, "step");
	});
});

describe("boundClientWindow (persistent hide-range right-bounding)", () => {
	// Regression contract for 2026-08-29: a client PERSISTS the reported range
	// in its deletion ledger. A right-open window (`end: null`) once stored
	// covered every row appended AFTER the delete point, so the sweeper hid all
	// future assistant replies — "delete the latest reply and the conversation
	// never renders again". The reported range must therefore always carry a
	// safe-integer end while still covering everything that exists today.
	it("clamps an open end to lastEventSeq + 1", () => {
		const events = [event(0, "turn/start"), event(3, "user/message"), event(9, "turn/end")];
		assert.deepEqual(boundClientWindow(events, { start: 3, end: null }), { start: 3, end: 10 });
		assert.deepEqual(boundClientWindow(events, { start: null, end: null }), { start: null, end: 10 });
	});
	it("keeps an existing bound and tolerates a missing window", () => {
		const events = [event(0, "turn/start"), event(5, "turn/end")];
		assert.deepEqual(boundClientWindow(events, { start: 1, end: 4 }), { start: 1, end: 4 });
		assert.equal(boundClientWindow(events, undefined), undefined);
	});

	it("a LAST-turn delete reports a bounded range that never covers future rows", () => {
		const append = (seq, type, extra = {}) => event(seq, type, { surfaceOp: "append", ...extra });
		const user = (seq, id) => append(seq, "user/message", { data: { id, role: "user", source: { kind: "user" }, content: [] } });
		const asstText = (seq, id) => append(seq, "assistant/message", { data: { message: { id, role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: "x" }] } } });
		const events = [
			append(0, "turn/start"),
			user(1, "u1"),
			asstText(2, "a1"),
			append(3, "turn/end"),
			append(4, "turn/start"),
			user(5, "u2"),
			asstText(6, "a2"),
			append(7, "llm/retry"), // chrome after the last member
			append(8, "turn/end")
		];
		// Deleting turn 2's reply — the LAST unit of the session, the exact bug
		// shape: no later real user input exists to close the window.
		const verdict = planDeletion(events, 6);
		assert.equal(verdict.ok, true);
		assert.equal(verdict.range.end, 9, "end must be lastEventSeq+1, not null");
		assert.equal(planCoversLike(verdict.range, 8), true, "chrome inside the deleted unit stays covered");
		assert.equal(planCoversLike(verdict.range, 9), false, "the clamp bound itself is exclusive");
		assert.equal(planCoversLike(verdict.range, 100), false, "FUTURE appends must never fall inside");
	});
});
