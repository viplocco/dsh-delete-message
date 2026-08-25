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

/**
 * Whether a user/message row is MACHINE-INJECTED context (source kind is
 * present and explicitly not "user") — as opposed to a REAL user input or a
 * sourceless row. Only rows with an explicit non-user source (plugin splices
 * like the runtime-context note, skill-catalog reminders) act as unit
 * triggers; a row without a source keeps single-node semantics.
 */
export function isMachineInjectedUserInput(event) {
	return event.type === "user/message"
		&& event.data?.source !== undefined
		&& event.data?.source !== null
		&& event.data.source.kind !== "user"
		&& !isDeletionPlaceholder(event);
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
 * Clamp a user-input window into a SAFE persistent hide-range for clients.
 *
 * The semantic window may be open on either side (`null` bound = "until the
 * next/previous real user input"). Open sides are correct while ASSESSING the
 * live log, but a range the CLIENT persists must never stay right-open: seqs
 * only grow upward, so every reply appended AFTER the deletion point would
 * fall inside an open-ended range forever — the sweeper would hide each newly
 * streamed assistant row on sight ("delete the latest reply and the
 * conversation never renders again"). Clamping the right side to
 * `lastEventSeq + 1` keeps full coverage of everything that exists NOW —
 * including chrome anchored after the last member (llm/retry chains,
 * turn-error banners) — while excluding, by append-only monotonicity, every
 * future event. A left-open bound is harmless once the right side is bounded:
 * future rows exceed `end`, so they can never fall in from below.
 *
 * @param {readonly {seq: number}} events - full log, any order.
 * @param {{start: number|null, end: number|null}|undefined} window - semantic window.
 * @returns `{ start, end }` with `end` always a safe integer.
 */
export function boundClientWindow(events, window) {
	if (!window) return window;
	let lastSeq = -1;
	for (const event of events) if (event.seq > lastSeq) lastSeq = event.seq;
	return { start: window.start ?? null, end: window.end ?? lastSeq + 1 };
}

/**
 * Plan the window-mode deletion shared by every UNIT trigger — assistant
 * replies AND machine-injected context rows. The unit is the target's
 * USER-INPUT WINDOW: everything between the previous and the next real user
 * input (assistant messages, tool results, machine-injected context).
 *
 * The transcript renders a unit as many separate rows (per-step think/prose
 * nodes, per-tool call nodes), so replacing only the closing message left the
 * wall of tool activity on screen while its final prose vanished. Because the
 * window is bounded by real user inputs BY CONSTRUCTION, no user row can ever
 * fall inside the hide range — the safety property holds even on client paths
 * that cannot see node kinds. Real user inputs act as boundaries and are
 * never members; steering splits windows. Previously-shadowed members are
 * skipped, so re-clicking a half-deleted reply cleans up the rest in one
 * action.
 *
 * Why injected context is also a unit trigger: a turn that failed or was
 * interrupted before any `assistant/message` landed (a 502 retry chain, a
 * mid-stream abort) leaves only its machine-injected rows on the surface.
 * They keep re-entering the model context on every later request, yet had no
 * delete affordance — the assistant-actions seat mounts inside an assistant
 * bubble that never existed. Treating an injected row as a unit trigger
 * closes that gap without touching the real-user-input boundary invariant.
 *
 * @param {readonly any[]} events - the session's full event snapshot, in seq order.
 * @param {number} seq - the surface node the user asked to delete.
 * @param {"turn"|"unit"} mode - which trigger produced this plan (kept distinct so logs/clients can tell an assistant-reply delete from a context-row delete of the same window).
 * @returns `{ ok: true, mode, seqs: number[], range }` or
 *   `{ ok: false, reason }` using the same REFUSALS vocabulary. `range`
 *   is the `{ start, end }` window bounds RIGHT-BOUNDED via
 *   {@link boundClientWindow} (never `null` on the end side) so a client may
 *   persist it safely — covering every chrome row that exists today,
 *   including non-surface tool/call rows no replacement could ever cite,
 *   while never swallowing rows appended later.
 */
function planUnitDeletion(events, seq, mode) {
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
	return { ok: true, mode, seqs, range: boundClientWindow(events, window) };
}

/**
 * Plan a STEP-level deletion: the owning assistant/message plus its directly
 * paired tool/results — NOT the whole user-input window. Multi-step turns
 * keep their other steps intact.
 *
 * The owning assistant/message is found by direct match (target IS one) or by
 * scanning backward (tool/call summaries, tool/results and other chrome
 * anchored after their calling reply). Collection then walks forward from the
 * assistant message, gathering every live `tool/result` until the next
 * `assistant/message`, real user input, or turn/end boundary. This is correct
 * without parsing callIds because a valid log always places tool/results
 * immediately after their calling reply.
 *
 * Machine-injected context rows between steps are deliberately KEPT — they
 * belong to the step's environment, not to the assistant's work product.
 *
 * @returns `{ ok:true, mode:"step", seqs, range:{start, end} }` where range
 *   covers this step's tool/call chrome rows for client-side hiding.
 */
export function planStepDeletion(events, seq) {
	if (!Number.isSafeInteger(seq) || seq < 0) return { ok: false, reason: REFUSALS.NOT_FOUND };
	const target = events.find((event) => event.seq === seq);
	if (target === undefined) return { ok: false, reason: REFUSALS.NOT_FOUND };

	// 1. Find the owning assistant/message.
	let assistantSeq = null;
	if (DELETABLE_TYPES.has(target.type) && target.type === "assistant/message") {
		assistantSeq = seq;
	} else {
		for (const e of [...events].reverse()) {
			if (e.seq >= seq) continue;
			if (e.type === "assistant/message") { assistantSeq = e.seq; break; }
			if (e.type === "user/message" && isRealUserInput(e)) break;
		}
	}
	if (assistantSeq === null) return { ok: false, reason: REFUSALS.NOT_FOUND };

	// 2. Open-turn guard.
	const bracket = enclosingTurnBracket(events, seq);
	if (bracket !== undefined && bracket.open) return { ok: false, reason: REFUSALS.OPEN_TURN };

	// 3. Collect the assistant message + its paired tool/results.
	const seqs = [];
	let maxSeq = assistantSeq;
	let collecting = false;
	for (const e of events) {
		if (e.seq < assistantSeq) continue;
		if (e.seq === assistantSeq) {
			collecting = true;
			if (!shadowedBy(events, e.seq)) seqs.push(e.seq);
			continue;
		}
		if (!collecting) continue;
		if (e.type === "assistant/message") break;
		if (e.type === "user/message" && isRealUserInput(e)) break;
		if (e.type === "turn/end") break;
		if (e.type === "tool/result" && !shadowedBy(events, e.seq)) {
			seqs.push(e.seq);
			if (e.seq > maxSeq) maxSeq = e.seq;
		}
	}

	if (seqs.length === 0) return { ok: false, reason: REFUSALS.ALREADY_SHADOWED };
	return { ok: true, mode: "step", seqs, range: { start: assistantSeq, end: maxSeq } };
}

/**
 * Plan one deletion as the user perceives it.
 *
 * Trigger kinds and modes:
 *
 * - A REAL user input (typed by the user, not injected, not one of our
 *   placeholders) keeps single-node semantics — clicking delete on your own
 *   row must never erase anything else.
 * - An ASSISTANT message expands to its whole user-input window
 *   (mode `"turn"`).
 * - A MACHINE-INJECTED `user/message` (source kind is not `"user"`, e.g. the
 *   plugin/skill-catalog context rows) expands to the same window
 *   (mode `"unit"`). This is the entry point for turns that failed or were
 *   interrupted before any assistant reply landed: their injected rows are
 *   the only deletable surface left, so without a unit trigger they would
 *   pollute the model context forever.
 * - ANY OTHER event seq — the transcript also renders rows anchored at
 *   NON-surface events (tool/call summaries, retry-chain entries, turn
 *   errors), and a trash click there has no surface node to cite. These act
 *   as window-unit triggers too (mode `"unit"`): same window, same members,
 *   same refusal rules. The window bounds stay real user inputs either way.
 * - With `scope === "step"`, an assistant/message target (or any anchor that
 *   resolves backward to one) deletes ONLY that step: the assistant message
 *   plus its paired tool/results — other steps in the same window survive
 *   (mode `"step"`). Used by Think-card and tool-call-card trash buttons for
 *   granular control in multi-step turns.
 *
 * @param {readonly any[]} events - the session's full event snapshot, in seq order.
 * @param {number} seq - the surface node (or chrome anchor) the user asked to delete.
 * @param {string} [scope] - optional deletion scope: `"step"` for per-step granularity; omit for legacy routing.
 * @returns `{ ok: true, mode: "single"|"turn"|"unit"|"step", seqs: number[], range? }` —
 *   `range` (turn/unit/step) is always RIGHT-BOUNDED for safe client persistence.
 */
export function planDeletion(events, seq, scope) {
	if (!Number.isSafeInteger(seq) || seq < 0) return { ok: false, reason: REFUSALS.NOT_FOUND };

	if (scope === "step") return planStepDeletion(events, seq);

	const target = events.find((event) => event.seq === seq);
	if (target === undefined) return { ok: false, reason: REFUSALS.NOT_FOUND };

	// User 行：真实用户输入（source.kind === "user"）或缺少 source 的行保持
	// 单节点契约；只有显式非 user 源的机器注入行（插件拼接如运行时上下文
	// 注记、skill-catalog 提醒）才是单元触发器——让失败/中断回合滞留的注入
	// 行也能用与助手回复相同的窗口语义一次清理。
	if (target.type === "user/message") {
		if (isMachineInjectedUserInput(target)) {
			return planUnitDeletion(events, seq, "unit");
		}
		const verdict = assessDeletion(events, seq);
		return verdict.ok ? { ok: true, mode: "single", seqs: [seq] } : verdict;
	}

	// Assistant target: the whole user-input window.
	if (DELETABLE_TYPES.has(target.type)) {
		return planUnitDeletion(events, seq, "turn");
	}

	// Chrome anchor (tool/call summary, llm/retry row, turn error, …): the
	// rendered row cites a NON-surface event, so there is nothing to replace
	// at this seq itself — but the row visibly belongs to a user-input window,
	// and deleting that whole unit is exactly what the click means. Same
	// window semantics as every other unit trigger; open turns still refuse.
	return planUnitDeletion(events, seq, "unit");
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
