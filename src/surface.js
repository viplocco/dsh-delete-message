/**
 * Deletion eligibility over a session event log.
 *
 * Pure functions over `readonly SessionEvent[]` — no cordis, no host imports —
 * so every rule here is testable in plain Node. The host half calls these with
 * `session.events` before it will append anything.
 *
 * ## What "delete" means here (and what it must never mean)
 *
 * The persistence contract is append-only: committed events are never removed.
 * Deleting therefore means APPENDING one placeholder `user/message` whose
 * `surfaceOp` is `{ op: 'replace', start: seq, end: seq }`. After that append:
 *
 * - `deriveMessages()` (the LLM context) no longer projects the shadowed node;
 * - the transcript renders the placeholder instead of the original message;
 * - the raw log keeps every original byte, so nothing is unrecoverable.
 *
 * This is the same mechanism `/compact` uses ("any surface-replacing producer
 * may use it", dsh-session SurfaceOp), which is why it is upgrade-safe where
 * rewriting the JSONL artifact is not.
 *
 * ## The rules
 *
 * v0.1 is deliberately conservative. A message is deletable when:
 *
 * 1. its event exists, and is a surface node of type `user/message` or
 *    `assistant/message`;
 * 2. it is currently on the surface (`surfaceOp === 'append'`) — already-
 *    shadowed nodes are gone from the context; deleting them again would only
 *    stack placeholders;
 * 3. it does not carry tool-call blocks (an assistant message that invoked a
 *    tool is load-bearing for its paired `tool/result`; pruning half a pair
 *    corrupts derived history). v1 refuses; a future version may delete the
 *    whole call+result unit together;
 * 4. its turn is closed — nothing inside the still-open turn (from the last
 *    `turn/start` without a matching `turn/end`) may be deleted while the
 *    agent is mid-flight through it.
 *
 * @module dsh-delete-message/surface
 */

/** Surface node types this plugin may replace. Tool results are out by rule 3. */
export const DELETABLE_TYPES = new Set(["user/message", "assistant/message"]);

/** Machine-readable refusal reasons; the client maps these to localized copy. */
export const REFUSALS = {
	NOT_FOUND: "not-found",
	NOT_SURFACE_TYPE: "not-surface-type",
	ALREADY_SHADOWED: "already-shadowed",
	HAS_TOOL_CALLS: "has-tool-calls",
	OPEN_TURN: "open-turn"
};

/**
 * Test whether an assistant message's content carries any tool-use block.
 *
 * The exact block shape lives in `@deepseek-ai/dsh-llm`'s ContentBlock union
 * (type-tagged objects); rather than import the host package — and drag its
 * Context augmentation into every test program — this walks for any object
 * whose `type` mentions a tool invocation. Verified against real logs during
 * integration; a stricter check belongs behind the host contract, not here.
 *
 * @param {unknown} content - the message's content block array.
 * @returns whether any block looks like a tool call.
 */
export function hasToolUse(content) {
	if (!Array.isArray(content)) return false;
	return content.some((block) => {
		if (block === null || typeof block !== "object") return false;
		const type = /** @type {{type?: unknown}} */ (block).type;
		return typeof type === "string" && /tool/i.test(type);
	});
}

/**
 * Whether the turn containing `seq` is still open in THIS log.
 *
 * The whole log is the truth about closure: a `turn/end` that exists anywhere
 * after the enclosing `turn/start` closes that turn even though it sits at a
 * higher seq than the candidate — a finished earlier turn must stay deletable
 * while later turns run. Walks to the candidate's enclosing bracket (the last
 * `turn/start` at or before `seq`), then looks ahead for its closing marker,
 * stopping at the next bracket boundary.
 *
 * @param {readonly {seq: number, type: string}[]} events - the full log, in seq order.
 * @param {number} seq - the candidate event's seq.
 * @returns whether the enclosing turn has no closing `turn/end`.
 */
export function insideOpenTurn(events, seq) {
	let enclosingStart = -1;
	for (const event of events) {
		if (event.type !== "turn/start") continue;
		if (event.seq <= seq) enclosingStart = event.seq;
		else break;
	}
	if (enclosingStart === -1) return false; // not inside any turn bracket
	for (const event of events) {
		if (event.seq <= enclosingStart) continue;
		if (event.type === "turn/start") break; // reached the next bracket unclosed
		if (event.type === "turn/end") return false; // closed after our candidate
	}
	return true;
}

/**
 * Whether any LATER event shadows the node at `seq`.
 *
 * A replacement lives at a higher seq and cites its victims twice: in its
 * `surfaceOp.replace` span and (by contract, mandatorily) in
 * `sourceEventSeqs`. Either citation counts — checking only the span would
 * miss a producer that cites honestly but spans differently, and the seqs list
 * is the one the surface contract validates as complete.
 *
 * @param {readonly any[]} events - full log, in seq order.
 * @param {number} seq - candidate surface node.
 * @returns whether a later replace event claims this seq.
 */
export function shadowedBy(events, seq) {
	return events.some((event) => {
		if (event.seq <= seq) return false;
		const op = event.surfaceOp;
		if (op === undefined || op === null || typeof op !== "object") return false;
		if (Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.includes(seq)) return true;
		return op.start <= seq && seq <= op.end;
	});
}

/**
 * Decide whether one surface node can be replaced by a deletion placeholder.
 *
 * @param {readonly any[]} events - the session's full event snapshot, in seq order.
 * @param {number} seq - the surface node the user asked to delete.
 * @returns `{ ok: true }` or `{ ok: false, reason: REFUSALS[...] }`.
 */
export function assessDeletion(events, seq) {
	if (!Number.isSafeInteger(seq) || seq < 0) return { ok: false, reason: REFUSALS.NOT_FOUND };
	const target = events.find((event) => event.seq === seq);
	if (target === undefined) return { ok: false, reason: REFUSALS.NOT_FOUND };
	if (!DELETABLE_TYPES.has(target.type)) return { ok: false, reason: REFUSALS.NOT_SURFACE_TYPE };

	// Rule 2 — off-surface now means gone-from-context already. Two ways to be
	// off it: the node's own entry is a replace (it IS a placeholder), or a
	// later event's replace cites it. Both refuse the same way; deleting an
	// already-deleted message would only stack placeholders.
	if (!target.surfaceOp || target.surfaceOp !== "append" || shadowedBy(events, seq)) {
		return { ok: false, reason: REFUSALS.ALREADY_SHADOWED };
	}

	// Rule 3 — refuse to strand a tool result's call site.
	if (target.type === "assistant/message" && hasToolUse(target.data?.message?.content ?? target.data?.content)) {
		return { ok: false, reason: REFUSALS.HAS_TOOL_CALLS };
	}

	// Rule 4 — never cut into a turn the agent is still working through.
	if (insideOpenTurn(events, seq)) return { ok: false, reason: REFUSALS.OPEN_TURN };

	return { ok: true };
}

/**
 * Build the placeholder `user/message` payload that replaces a deleted node.
 *
 * Mirrors compaction's checkpoint shape: a user-role message whose text says
 * what happened. Kept short on purpose — it becomes model-visible context, and
 * the whole point of the feature is spending fewer tokens on history, not
 * renaming it.
 *
 * The `source: { kind: "user" }` marker is NOT cosmetic. `Session.append`
 * validates JSON-serializability and the surface contract but never the message
 * shape, while the persistence/query boundary (`assertMessageEventShape`)
 * rejects any message whose source lacks a non-empty string `kind`. A sourceless
 * placeholder therefore appends cleanly, poisons the durable log, and makes the
 * whole session refuse to load on the next start — discovered the hard way in
 * v0.1.0 (session event "message has invalid source"). `{ kind: "user" }` is
 * the vocabulary every first-party user-message producer uses.
 *
 * @param {string} [text] - localized placeholder copy.
 * @returns a JSON-safe UserMessage-shaped payload (without envelope fields).
 */
export function buildPlaceholder(text = "[message deleted]") {
	return {
		id: `deleted-${crypto.randomUUID()}`,
		role: "user",
		source: { kind: "user" },
		content: [{ type: "text", text }]
	};
}
