/**
 * dsh-delete-message — host half.
 *
 * Serves the deletion seam: the browser asks "can I delete seq N of session S"
 * and "delete it", and this half answers by checking the live log and, when
 * every rule holds, appending ONE placeholder `user/message` whose
 * `surfaceOp` is `{ op: 'replace', start: seq, end: seq }`.
 *
 * ## Why append-only replace instead of rewriting the artifact
 *
 * The persistence contract is append-only (`SessionPersistence` exposes no
 * delete). Rewriting `session.jsonl.zstd` in place would break the contiguous-
 * seq contract for every downstream consumer — the SQLite projection's
 * watermark, fork lineage, checkpoint sources — and race the live write-behind
 * buffer. A surface replace is what compaction itself does; it is validated,
 * crash-safe, and keeps the raw log intact. See docs/DESIGN.md.
 *
 * ## Why only LIVE sessions in v0.1
 *
 * The icon renders on messages the user is looking at right now, and a session
 * being rendered in the web UI is live in this process (`ctx.sessions.get(id)`).
 * Editing a cold session from disk has no safe primitive yet; that is future
 * work (fork-rebuild), not silent file surgery. A not-live id refuses with
 * `session-not-live`.
 *
 * ## Failure containment
 *
 * Every route handler wraps its body. A refused delete returns the machine
 * reason code from `assessDeletion`; an unexpected error logs with stack and
 * returns `internal`. This plugin never takes the harness down over its own
 * feature.
 *
 * @module dsh-delete-message/plugin
 */

import { assessDeletion, buildPlaceholder, REFUSALS } from "./surface.js";
import { VERSION, registerRoutes } from "./http.js";

export { VERSION };

export const name = "delete-message";

/**
 * Services this plugin cannot start without.
 *
 * **An array, never an object** — Cordis reads an object `inject` as a
 * name→intercept map, so `{ required, optional }` would ask for two services
 * literally named "required" and "optional" and hang the whole host pending
 * (the TokenLedger incident, see docs/DESIGN.md § "host contract").
 *
 * Only `sessions` is required: the live store. The web server is waited on via
 * nested inject inside `registerRoutes`, because Cordis has no optional
 * dependency form.
 */
export const inject = ["sessions"];

/** Localized placeholder copy appended into the model context. */
const PLACEHOLDER_ZH = "[此消息已被用户删除]";
const PLACEHOLDER_EN = "[message deleted by user]";

/**
 * Build one deletion verdict payload for the preflight route.
 *
 * @param {any} sessions - the live SessionStore service.
 * @param {string | undefined} sessionId - target session id.
 * @param {string | undefined} seqParam - candidate surface node seq.
 */
export async function buildStatus(sessions, sessionId, seqParam) {
	const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
	if (session === undefined) return { ok: true, live: false, reason: "session-not-live" };
	const seq = Number(seqParam);
	const verdict = assessDeletion(session.events, seq);
	return {
		ok: true,
		live: true,
		deletable: verdict.ok,
		reason: verdict.ok ? undefined : verdict.reason,
		version: VERSION
	};
}

/**
 * Execute one deletion: re-check, then append the surface replace.
 *
 * POST re-runs the exact check the preflight served — the log may have grown
 * between icon render and click (a turn finished, a tool result landed) — so
 * the UI can never talk the host into a delete it would refuse now.
 *
 * @param {any} sessions - the live SessionStore service.
 * @param {{ logger?: any }} loggerLike - logger face.
 * @param {{ sessionId?: unknown, seq?: unknown }} body - request payload.
 * @returns the route payload.
 */
export async function deleteMessage(sessions, loggerLike, body) {
	const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
	const seq = Number(body?.seq);
	if (sessionId === "" || !Number.isSafeInteger(seq)) {
		return { ok: false, error: "bad-request", detail: "sessionId and integer seq are required" };
	}
	const session = sessions.get(sessionId);
	if (session === undefined) return { ok: false, error: REFUSALS.NOT_FOUND, detail: "session-not-live" };

	const events = session.events;
	const verdict = assessDeletion(events, seq);
	if (!verdict.ok) {
		return { ok: false, error: verdict.reason };
	}

	// The placeholder is user-role regardless of what it replaces — exactly how
	// compaction ships summaries ("deriveMessages() then renders the summary as
	// a user-role message"). One shape, one derivation rule, no new vocabulary.
	const placeholderText = localeOf(loggerLike) === "zh" ? PLACEHOLDER_ZH : PLACEHOLDER_EN;
	try {
		session.append(
			"user/message",
			buildPlaceholder(placeholderText),
			{ surfaceOp: { op: "replace", start: seq, end: seq }, sourceEventSeqs: [seq] }
		);
	} catch (error) {
		// Surface-contract violations throw at the append site by design. Log
		// with stack — swallowed refusals cost days (HOST-CONTRACT § 5).
		loggerLike?.logger?.error?.("delete-message: append rejected: %s", error?.stack ?? error);
		return { ok: false, error: "append-rejected", detail: String(error?.message ?? error) };
	}
	loggerLike?.logger?.info?.("delete-message: session %s seq %d replaced", sessionId, seq);
	return { ok: true, replaced: seq, version: VERSION };
}

/**
 * Best-effort locale pick for placeholder copy.
 *
 * The host half has no per-request locale; the harness UI language lives
 * client-side. v0.1 sniffs nothing smarter than navigator-less defaulting and
 * accepts an explicit hint from the client later — the copy is cosmetic to the
 * rules either way.
 */
function localeOf(loggerLike) {
	return loggerLike?.locale === "zh" ? "zh" : "en";
}

/**
 * Plugin apply — called by cordis with the injected services.
 *
 * @param {any} ctx - owning context carrying `sessions`.
 */
export function apply(ctx) {
	const sessions = ctx.sessions;
	const logger = ctx.logger;

	registerRoutes(ctx, {
		logger,
		sessions,
		buildStatus: (sessionId, seq) => buildStatus(sessions, sessionId, seq),
		deleteMessage: (body) => deleteMessage(sessions, { logger }, body)
	});
}
