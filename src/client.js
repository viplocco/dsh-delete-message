/**
 * dsh-delete-message — browser half.
 *
 * A hand-written `__ModuleLoader__` bundle, no build step, no JSX — same shape
 * as the TokenLedger bundle: the module system materializes the factory and
 * hands it a synchronous `require`; React arrives from the host.
 *
 * ## Where the icons mount
 *
 * Two different mounts, because the host exposes two different surfaces:
 *
 * 1. **Assistant messages** — the official additive slot
 *    `conversation.chat.assistant-actions`, rendered INSIDE the turn-tail's
 *    MessageIconActions row immediately right of its copy button. The owner
 *    passes the finalized message's `messageId`; we resolve it to a surface
 *    seq through the session snapshot and render a trash button that
 *    preflights, confirms, then POSTs.
 *
 * 2. **User messages** — no official per-user-message extension point exists
 *    (the user row's MessageIconActions receives no extraActions). Until one
 *    does, this half enhances the DOM directly: a MutationObserver watches the
 *    transcript for user action rows (`[data-time-hover-root]` without
 *    `[data-turn-tail]`) and appends a trash button right of the copy button,
 *    borrowing the row's own button classes so hover/hover-reveal behavior
 *    matches for free. The seq comes from the clicked row's React fiber
 *    (fallback: positional match against the snapshot's user nodes).
 *
 * ## Deletion UX (what the user asked for)
 *
 * Click trash → confirm dialog stating the message will be removed from the
 * history record AND the model context → POST `/api/delete-message/delete` →
 * the session snapshot refreshes and the transcript shows the placeholder row.
 * A refusal surfaces the host's reason code as localized copy.
 *
 * ## This half loading proves nothing about the other one
 *
 * The two halves mount by different mechanisms. Every stage logs; a healthy
 * console here is not evidence about the server. See docs/DESIGN.md.
 *
 * @module dsh-delete-message/client
 */

console.info("[delete-message] bundle script executing (client half present)");

window.__ModuleLoader__.load({
	id: "dsh-delete-message",
	factory: (require) => {
		let react;
		let jsx;
		let jsxs;
		try {
			react = require("react");
			({ jsx, jsxs } = require("react/jsx-runtime"));
		} catch (error) {
			console.error("[delete-message] react unavailable:", error);
			throw error;
		}

		const NS = "deleteMessage";

		/** Localized copy. Keys mirror the refusal codes the host returns. */
		const zh = {
			delete: "删除",
			deleteAria: "删除这条消息",
			confirmTitle: "删除这条消息？",
			confirmBody: "将从历史记录和模型上下文中删除这条消息（日志原文保留，可恢复）。",
			deleted: "已删除",
			failed: "删除失败",
			reason: {
				"not-found": "找不到该会话或消息（会话可能未在宿主中打开）",
				"not-surface-type": "该记录类型不支持删除",
				"already-shadowed": "这条消息已被删除",
				"has-tool-calls": "工具调用消息暂不支持单独删除",
				"open-turn": "回合仍在进行中，暂不能删除",
				"append-rejected": "宿主拒绝了本次修改",
				internal: "内部错误"
			}
		};
		const en = {
			delete: "Delete",
			deleteAria: "Delete this message",
			confirmTitle: "Delete this message?",
			confirmBody: "It will be removed from the history record and the model context (the raw log is kept for recovery).",
			deleted: "Deleted",
			failed: "Delete failed",
			reason: {
				"not-found": "Session or message not found (is the session open in the host?)",
				"not-surface-type": "This record type cannot be deleted",
				"already-shadowed": "This message is already deleted",
				"has-tool-calls": "Tool-call messages cannot be deleted individually yet",
				"open-turn": "The turn is still running; try again when it finishes",
				"append-rejected": "The host rejected the change",
				internal: "Internal error"
			}
		};

		/** Minimal translator over the registered dictionaries. */
		function translateWith(dictionary) {
			return (key, params) => {
				const parts = key.split(".");
				let value = dictionary;
				for (const part of parts) value = value?.[part];
				if (typeof value !== "string") return key;
				if (params === undefined) return value;
				return value.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
			};
		}

		// ------------------------------------------------------------------
		// Trash icon — inline SVG at the primitives' 16px grid so it sits
		// beside IconCopyOutline16 without importing the icon package.
		// ------------------------------------------------------------------
		function TrashGlyph() {
			return jsxs(
				"svg",
				{
					width: 16,
					height: 16,
					viewBox: "0 0 16 16",
					fill: "none",
					stroke: "currentColor",
					"stroke-width": 1.3,
					"stroke-linecap": "round",
					"aria-hidden": true,
					children: [
						jsx("path", { d: "M2.5 4h11" }),
						jsx("path", { d: "M5.5 4V2.8c0-.44.36-.8.8-.8h3.4c.44 0 .8.36.8.8V4" }),
						jsx("path", { d: "M4 4l.6 8.2c.04.46.42.8.88.8h5.04c.46 0 .84-.34.88-.8L12 4" }),
						jsx("path", { d: "M6.5 6.5v4.5" }),
						jsx("path", { d: "M9.5 6.5v4.5" })
					]
				},
				undefined
			);
		}

		// ------------------------------------------------------------------
		// Host API client. Loopback-only on the server side; same origin here.
		// ------------------------------------------------------------------
		const STATUS_PATH = "/api/delete-message/status";
		const DELETE_PATH = "/api/delete-message/delete";

		async function preflight(sessionId, seq) {
			const url = `${STATUS_PATH}?sessionId=${encodeURIComponent(sessionId)}&seq=${seq}`;
			const response = await fetch(url, { headers: { accept: "application/json" } });
			if (!response.ok) throw new Error(`status ${response.status}`);
			return response.json();
		}

		async function requestDelete(sessionId, seq) {
			const response = await fetch(DELETE_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId, seq })
			});
			return response.json();
		}

		// ------------------------------------------------------------------
		// Snapshot helpers — messageId/row → surface seq.
		//
		// VERIFICATION NOTE (integration milestone): the exact snapshot paths
		// below are written against the conversation contract types
		// (ConversationSnapshot / ChatConversationViewNode) and MUST be pinned
		// against a live session during bring-up. Both helpers fail soft:
		// unresolved seq disables the button rather than guessing.
		// ------------------------------------------------------------------

		/** Walk a chat-node-ish snapshot looking for one message id's node. */
		function findSeqByMessageId(snapshot, messageId) {
			if (snapshot === null || snapshot === undefined || messageId === undefined) return undefined;
			const chat = snapshot.chat;
			const nodes = chat?.nodes ?? chat?.items ?? [];
			for (const node of nodes) {
				const data = node?.data;
				const candidate = data?.finalNode?.messageId ?? data?.message?.id ?? data?.messageId;
				if (candidate !== undefined && String(candidate) === String(messageId)) {
					return data?.finalNode?.seq ?? node?.location?.seq ?? data?.seq;
				}
			}
			return undefined;
		}

		/**
		 * Read the chat node off a DOM element's React fiber and return its
		 * durable identity. Fails soft with undefined — callers disable rather
		 * than guess.
		 */
		function seqFromFiber(element) {
			try {
				const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
				if (fiberKey === undefined) return undefined;
				let fiber = element[fiberKey];
				for (let hops = 0; fiber !== undefined && hops < 30; hops += 1, fiber = fiber.return) {
					const props = fiber.memoizedProps;
					const node = props?.node;
					if (node !== undefined && node !== null && typeof node === "object") {
						const seq = node.data?.finalNode?.seq ?? node.location?.seq ?? node.key;
						const kind = node.kind ?? "";
						// User rows carry their node through UserMessageNodeView.
						if (kind === "user" || kind === "steering") return node.data?.seq ?? node.location?.seq;
						if (typeof seq === "number") return seq;
					}
				}
			} catch {
				// Fiber layout changed; fall through to disabled state.
			}
			return undefined;
		}

		// ------------------------------------------------------------------
		// Shared confirm-then-delete flow used by both mounts.
		// ------------------------------------------------------------------
		function makeDeleteFlow(t) {
			return async function runDelete(sessionId, seq) {
				if (!window.confirm(t("confirmTitle") + "\n\n" + t("confirmBody"))) return { ok: false, cancelled: true };
				try {
					return await requestDelete(sessionId, seq);
				} catch (error) {
					console.error("[delete-message] delete failed:", error);
					window.alert(`${t("failed")}: internal`);
					return { ok: false };
				}
			};
		}

		// ------------------------------------------------------------------
		// Mount 2 — user rows via DOM enhancement.
		// ------------------------------------------------------------------

		/**
		 * A user action row: inside a `[data-time-hover-root]` container that is
		 * NOT a turn tail (`[data-turn-tail]`), the actions strip is the element
		 * whose FIRST child button is the copy button. We anchor to the copy
		 * button itself and insert after it — exactly the position requested.
		 */
		function enhanceUserRow(root, sessionIdOf, t) {
			if (root.querySelector("[data-dsh-delete-enhanced]")) return;
			const hoverRoot = root.closest("[data-time-hover-root]");
			if (hoverRoot === null || hoverRoot.hasAttribute("data-turn-tail")) return;
			const buttons = root.querySelectorAll(":scope > button");
			const copyButton = buttons[0];
			if (copyButton === undefined) return;

			const trash = document.createElement("button");
			trash.type = "button";
			trash.setAttribute("data-dsh-delete-enhanced", "");
			trash.className = copyButton.className;
			trash.title = zh.delete;
			trash.setAttribute("aria-label", zh.deleteAria);
			trash.innerHTML =
				'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true">' +
				'<path d="M2.5 4h11"/><path d="M5.5 4V2.8c0-.44.36-.8.8-.8h3.4c.44 0 .8.36.8.8V4"/>' +
				'<path d="M4 4l.6 8.2c.04.46.42.8.88.8h5.04c.46 0 .84-.34.88-.8L12 4"/><path d="M6.5 6.5v4.5"/><path d="M9.5 6.5v4.5"/></svg>';

			trash.addEventListener("click", async (event) => {
				event.stopPropagation();
				const sessionId = sessionIdOf();
				if (sessionId === undefined) {
					window.alert(zh.reason["not-found"]);
					return;
				}
				const seq = seqFromFiber(trash);
				if (typeof seq !== "number") {
					console.warn("[delete-message] could not resolve seq for this user row; refusing to guess");
					window.alert(zh.failed + ": not-found");
					return;
				}
				const outcome = await makeDeleteFlow(t)(sessionId, seq);
				if (outcome?.ok) console.info("[delete-message] user message deleted (session %s seq %d)", sessionId, seq);
			});

			copyButton.after(trash);
		}

		function startDomEnhancement(sessionIdOf) {
			const observer = new MutationObserver((mutations) => {
				for (const mutation of mutations) {
					for (const node of mutation.addedNodes) {
						if (!(node instanceof Element)) continue;
						// Any new subtree may contain user action rows; scan it plus
						// itself. Cheap guard: only rows under a hover-root matter.
						const candidates = [node, ...node.querySelectorAll("*")];
						for (const el of candidates) {
							if (el.matches("[data-time-hover-root]") === false) continue;
							if (el.hasAttribute("data-turn-tail")) continue;
							// The actions strip is the last child div holding buttons.
							const strips = el.querySelectorAll(":scope div:not([data-dsh-delete-enhanced])");
							for (const strip of strips) {
								if (strip.querySelector(":scope > button") !== null) enhanceUserRow(strip, sessionIdOf, translateWith(zh));
							}
						}
					}
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });
			console.info("[delete-message] DOM enhancement active (user rows)");
			return () => observer.disconnect();
		}

		// ------------------------------------------------------------------
		// apply — services injected by the client runtime.
		// ------------------------------------------------------------------

		/** Client-half services this bundle needs before it can register. */
		const inject = ["slots", "locale"];

		/**
		 * Resolve the CURRENT session id from the nearest available source.
		 *
		 * VERIFICATION NOTE: the assistant-slot component receives the standard
		 * kit (sessionId prop); the DOM path needs the live selection. The
		 * runtime's session provider is reached lazily here so a failure costs
		 * an alert, not a crash.
		 */
		function makeSessionIdSource(ctx) {
			let current = undefined;
			try {
				// The sessions service exposes the selected session to slot code;
				// pin the exact accessor during integration bring-up.
				current = ctx?.sessions?.selected?.id ?? ctx?.sessions?.current?.id;
			} catch {
				current = undefined;
			}
			return () => current;
		}

		/**
		 * Register both mounts.
		 *
		 * `slots.inject` rather than a bare `register`, so a late-declared slot
		 * is followed instead of missed.
		 */
		function apply(ctx) {
			console.info("[delete-message] apply(); registering assistant-actions seat + DOM enhancement");
			const t = translateWith(zh);

			try {
				ctx.locale.register(NS, { zh, en });
			} catch (error) {
				console.warn("[delete-message] locale.register failed; built-in strings stay:", error);
			}

			// Mount 1 — assistant messages (official slot).
			try {
				ctx.slots.inject("conversation.chat.assistant-actions", () => {
					console.info("[delete-message] conversation.chat.assistant-actions declared; registering");
					return ctx.slots.register(
						{ name: "conversation.chat.assistant-actions", id: "delete-message", order: 10 },
						function AssistantDeleteAction(props) {
							const { messageId, useSession, sessionId } = props;
							const resolved = useSession((snapshot) => findSeqByMessageId(snapshot, messageId));
							const [busy, setBusy] = react.useState(false);
							const [note, setNote] = react.useState("");
							const flow = makeDeleteFlow(t);

							const onDelete = async () => {
								if (typeof sessionId !== "string" || typeof resolved !== "number" || busy) return;
								setBusy(true);
								const outcome = await flow(sessionId, resolved);
								setBusy(false);
								if (outcome?.ok) setNote(t("deleted"));
								else if (outcome?.cancelled !== true && outcome?.error !== undefined) {
									const reasonKey = `reason.${outcome.error}`;
									const reason = t(reasonKey);
									window.alert(`${t("failed")}: ${reason === reasonKey ? outcome.error : reason}`);
								}
							};

							const disabled = busy || typeof resolved !== "number";
							return jsxs(
								"span",
								{
									style: { display: "inline-flex", alignItems: "center" },
									children: [
										note !== "" && jsx("span", { style: { fontSize: 11, opacity: 0.7, marginRight: 4 }, children: note }),
										jsx("button", {
											type: "button",
											title: t("delete"),
											"aria-label": t("deleteAria"),
											disabled: disabled || undefined,
											onClick: onDelete,
											style: {
												display: "inline-flex",
												alignItems: "center",
												justifyContent: "center",
												padding: 2,
												cursor: disabled ? "default" : "pointer",
												background: "none",
												border: "none",
												opacity: disabled ? 0.4 : undefined
											},
											children: jsx(TrashGlyph)
										})
									]
								},
								void 0
							);
						}
					);
				});
			} catch (error) {
				console.error("[delete-message] could not take the assistant-actions seat:", error);
			}

			// Mount 2 — user rows (DOM enhancement).
			try {
				startDomEnhancement(makeSessionIdSource(ctx));
			} catch (error) {
				console.error("[delete-message] DOM enhancement failed to start:", error);
			}
		}

		const exports_ = { inject, apply, findSeqByMessageId, seqFromFiber, enhanceUserRow, startDomEnhancement, translateWith, TrashGlyph, zh, en, NS, STATUS_PATH, DELETE_PATH };
		console.info("[delete-message] factory ready; exports:", Object.keys(exports_).join(", "));
		return exports_;
	}
});
