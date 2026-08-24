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
 * Surface nodes removable as part of a whole-reply deletion. Assistant
 * messages (tool-calling or not) and their paired tool results go together —
 * removing half of a call/result pair would leave orphan entries the next
 * model request rejects. Machine-INJECTED context (a user/message whose
 * source kind is not "user" — plugin splices like the runtime-context note)
 * belongs to the visible unit too; real user words are NEVER candidates.
 */
export const TURN_UNIT_TYPES = new Set(["assistant/message", "tool/result"]);

/** A prior deletion placeholder — machine chrome from THIS plugin, never a boundary. */
export function isDeletionPlaceholder(event) {
	return event.type === "user/message"
		&& typeof event.data?.id === "string"
		&& event.data.id.startsWith("deleted-");
}

/** A REAL user input: typed by the user, not injected, not one of our placeholders. */
export function isRealUserInput(event) {
	return event.type === "user/message"
		&& event.data?.source?.kind === "user"
		&& !isDeletionPlaceholder(event);
}

/**
 * The user-input window containing `seq`: strictly between the previous and
 * the next REAL user input. By construction no real user input lies INSIDE
 * the window, so any row anchored within it is machine material — which is
 * what makes range-hiding safe even on code paths that cannot see node kinds.
 *
 * @returns `{ start, end }` where either bound may be `null` (open side).
 */
export function userWindowOf(events, seq) {
	let start = null;
	let end = null;
	for (const event of events) {
		if (!isRealUserInput(event)) continue;
		if (event.seq < seq) start = event.seq;
		else if (event.seq > seq) {
			end = event.seq;
			break;
		}
	}
	return { start, end };
}

/** Whether `seq` sits strictly inside the window (null bounds are open sides). */
export function inUserWindow(window, seq) {
	if (typeof seq !== "number") return false;
	if (window.start !== null && seq <= window.start) return false;
	if (window.end !== null && seq >= window.end) return false;
	return true;
}

/** A live member of a reply unit: unshadowed assistant/tool material, injected context, or an old placeholder. */
export function isTurnUnitMember(event) {
	if (isDeletionPlaceholder(event)) return true;
	if (event.surfaceOp !== "append") return false;
	if (TURN_UNIT_TYPES.has(event.type)) return true;
	return event.type === "user/message" && event.data?.source?.kind !== "user";
}

/**
 * Whether EVERY removable member inside the window is already shadowed — i.e.
 * the whole visible unit has been deleted (possibly across several clicks),
 * so any remaining row anchored inside it is stale chrome (tool/call summaries
 * and the like) a client should hide on sight.
 */
export function turnUnitCleared(events, window) {
	if (!window) return false;
	let members = 0;
	for (const event of events) {
		if (!inUserWindow(window, event.seq)) continue;
		if (!isTurnUnitMember(event)) continue;
		members += 1;
		if (!shadowedBy(events, event.seq)) return false;
	}
	return members > 0;
}

/**
 * Locate the turn bracket enclosing `seq`.
 *
 * @param {readonly any[]} events - full log, in seq order.
 * @param {number} seq - candidate event's seq.
 * @returns `{ start, end, open }` with `end` = the closing turn/end seq and
 *   `open: false`, or `{ start, open: true }` when the bracket never closes,
 *   or `undefined` when the seq sits before/outside every bracket.
 */
export function enclosingTurnBracket(events, seq) {
	let start = -1;
	for (const event of events) {
		if (event.seq > seq) break;
		if (event.type === "turn/start") start = event.seq;
	}
	if (start === -1) return undefined;
	for (const event of events) {
		if (event.seq <= start) continue;
		if (event.type === "turn/start") return { start, open: true };
		if (event.type === "turn/end") return { start, end: event.seq, open: false };
	}
	return { start, open: true };
}

/**
 * Plan one deletion as the user perceives it: for an ASSISTANT target, the
 * unit is its USER-INPUT WINDOW — everything between the previous and the
 * next real user input (assistant messages, tool results, machine-injected
 * context). The transcript renders those as many separate rows (per-step
 * think/prose nodes, per-tool call nodes), so replacing only the closing
 * message left the wall of tool activity on screen while its final prose
 * vanished. Because the window is bounded by real user inputs BY
 * CONSTRUCTION, no user row can ever fall inside the hide range — the safety
 * property holds even on client paths that cannot see node kinds. Real user
 * inputs act as boundaries and are never members; steering splits windows.
 * Previously-shadowed members are skipped, so re-clicking a half-deleted
 * reply cleans up the rest in one action.
 *
 * A USER-message target keeps single-node semantics (clicking delete on your
 * own row must never erase anything else).
 *
 * @param {readonly any[]} events - the session's full event snapshot, in seq order.
 * @param {number} seq - the surface node the user asked to delete.
 * @returns `{ ok: true, mode: "single"|"turn", seqs: number[], range? }` or
 *   `{ ok: false, reason }` using the same REFUSALS vocabulary. `range`
 *   (turn mode) is the `{ start, end }` window bounds (either `null` when
 *   open-ended) for client-side chrome hiding — including non-surface
 *   tool/call rows that no replacement could ever cite.
 */
export function planDeletion(events, seq) {
	if (!Number.isSafeInteger(seq) || seq < 0) return { ok: false, reason: REFUSALS.NOT_FOUND };
	const target = events.find((event) => event.seq === seq);
	if (target === undefined) return { ok: false, reason: REFUSALS.NOT_FOUND };
	if (!DELETABLE_TYPES.has(target.type)) return { ok: false, reason: REFUSALS.NOT_SURFACE_TYPE };

	// User rows: exactly the old single-node contract, all its rules intact.
	if (target.type === "user/message") {
		const verdict = assessDeletion(events, seq);
		return verdict.ok ? { ok: true, mode: "single", seqs: [seq] } : verdict;
	}

	// Assistant target: the whole user-input window. Safety while the agent is
	// still working through the enclosing turn stays non-negotiable.
	const bracket = enclosingTurnBracket(events, seq);
	if (bracket !== undefined && bracket.open) return { ok: false, reason: REFUSALS.OPEN_TURN };

	const window = userWindowOf(events, seq);
	const seqs = [];
	for (const event of events) {
		if (!inUserWindow(window, event.seq)) continue;
		if (!isTurnUnitMember(event)) continue;
		if (shadowedBy(events, event.seq)) continue;
		seqs.push(event.seq);
	}
	// The clicked node may already be shadowed (a prior partial delete); what
	// matters is whether ANY live member of the unit remains to remove.
	if (seqs.length === 0) return { ok: false, reason: REFUSALS.ALREADY_SHADOWED };
	return { ok: true, mode: "turn", seqs, range: { start: window.start, end: window.end } };
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
