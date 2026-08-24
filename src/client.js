/**
 * dsh-delete-message — browser half.
 *
 * A hand-written `__ModuleLoader__` bundle, no build step, no JSX compiler —
 * same shape as the TokenLedger bundle: the module system materializes the
 * factory and hands it a synchronous `require`; React arrives from the host.
 *
 * ## Where the icons mount
 *
 * Two different mounts, because the host exposes two different surfaces:
 *
 * 1. **Assistant messages** — the official additive slot
 *    `conversation.chat.assistant-actions`, rendered INSIDE the turn-tail's
 *    MessageIconActions row immediately right of its copy button (same seat
 *    the official feedback plugin uses). The slot component receives the
 *    finalized message's `messageId` plus the standard kit (`sessionId`,
 *    `useSession`, `t`); it resolves the surface seq through the session
 *    snapshot and renders a trash button that confirms, then POSTs.
 *
 * 2. **User messages** — no official per-user-message extension point exists
 *    (the user row's MessageIconActions receives no extraActions). This half
 *    enhances the DOM directly: a MutationObserver watches the transcript for
 *    user action rows (`[data-time-hover-root]` without `[data-turn-tail]`
 *    or `[data-pending-steering]`), finds THE actions strip — a DIRECT child
 *    div of the row that holds a direct-child button — and inserts one trash
 *    button right after the copy button, borrowing the row's own button
 *    classes so box size, padding, hover reveal and hover background match
 *    for free. The strip is marked on enhancement; nested strips (JSON-block
 *    headers etc.) never qualify, so exactly one icon lands per row.
 *
 * ## Styling contract (v0.1.2)
 *
 * Everything the user sees mirrors the host's copy-button language:
 *
 * - Icon: the official `ic_ds_trash_outline_16` glyph path from
 *   `@deepseek-ai/dsh-client-ui-primitives`, inlined (the primitives module is
 *   bundled into its consumers, not requirable from plugin bundles).
 * - Button chrome: the assistant mount ships the exact `.p-xYUq_action`
 *   declarations under a stable class; the DOM mount borrows the live copy
 *   button's classes.
 * - Hover bubble: a faithful re-implementation of the primitives `Tooltip`
 *   (cloned anchor + fixed-position bubble with the same paddings, radius,
 *   colors, transform and fade) — native `title` attributes are NOT used,
 *   because the OS-level tooltip renders as an alien bordered box that reads
 *   as a second "delete button".
 * - Confirm dialog: a plain-DOM replica of the primitives `Modal` + `Button`
 *   (mask blur, 380px card, header/close/description/footer geometry, outline
 *   cancel + primary confirm), used by BOTH mounts — no native browser
 *   confirm bar anywhere.
 *
 * ## Deletion UX
 *
 * Click trash → styled confirm dialog whose body is picked by the mount's
 * STATIC role — the user-row copy states the single-message scope, the
 * assistant-row copy names the whole reply unit (thinking, tool calls,
 * injected context) — then POST `/api/delete-message/delete`. A refusal
 * opens a styled notice carrying the localized reason — raw machine codes
 * never reach the screen.
 *
 * ## Why visual removal is ours, not the host's
 *
 * The host builds the human transcript from APPEND-origin surface events BY
 * DESIGN (client-runtime surface.ts: "a landed replacement would erase
 * conversation the user already saw"). A landed surface replace therefore
 * keeps the original rows visible forever, and the placeholder itself never
 * renders. So after a successful delete THIS plugin hides the rows: a
 * per-session seq ledger (localStorage) feeds a sweeper over the chat's
 * `[data-chat-flow-key]` node wrappers, resolving every row's seq through
 * React fibers exactly like the user-row mount. Rows deleted before this
 * browser knew (another tab, another day) are healed by one `/status`
 * preflight per unresolved row: `already-shadowed` marks the ledger too.
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
		const ACTION_CLASS = "dshdm-action";
		const BUBBLE_CLASS = "dshdm-bubble";
		const STRIP_MARK = "data-dsh-delete-enhanced";

		/**
		 * Localized copy. Keys mirror the refusal codes the host returns.
		 *
		 * FLAT DOTTED KEYS, deliberately: the host LocaleRuntime looks a key up
		 * as `dicts[ns][locale][key]` with NO nested-path walking, so v0.1.2's
		 * nested `reason: { ... }` object made every `reason.*` lookup fall
		 * back to the raw code — the UI literally showed "already-shadowed".
		 */
		const zh = {
			delete: "删除",
			deleteAria: "删除这条消息",
			confirmTitle: "删除这条消息？",
			// Role-aware confirm bodies. Each mount knows its row kind statically
			// (assistant slot vs user-row enhancement), so runDelete picks the
			// key from the role argument — the user never has to parse a
			// conditional "if this is an assistant reply" sentence.
			confirmBodyUser: "将从会话记录和模型上下文中删除这条消息；原始日志保留，可恢复。",
			confirmBodyAssistant: "将删除这条回复及其思考、工具调用与注入的上下文；原始日志保留，可恢复。",
			// Fallback for an unknown role (defensive; both call sites pass one).
			confirmBody: "将从历史记录和模型上下文中删除这条消息（日志原文保留，可恢复）。",
			cancel: "取消",
			close: "关闭",
			noticeOk: "知道了",
			deleted: "已删除",
			failed: "删除失败",
			"reason.not-found": "找不到该会话或消息（会话可能未在宿主中打开）",
			"reason.not-surface-type": "该记录类型不支持删除",
			"reason.already-shadowed": "这条消息已被删除",
			"reason.has-tool-calls": "工具调用消息暂不支持单独删除",
			"reason.open-turn": "回合仍在进行中，暂不能删除",
			"reason.append-rejected": "宿主拒绝了本次修改",
			"reason.internal": "内部错误"
		};
		const en = {
			delete: "Delete",
			deleteAria: "Delete this message",
			confirmTitle: "Delete this message?",
			confirmBodyUser: "This message will be removed from the conversation and the model context; the raw log is kept for recovery.",
			confirmBodyAssistant: "This reply will be removed together with its thinking, tool calls, and injected context; the raw log is kept for recovery.",
			// Fallback for an unknown role (defensive; both call sites pass one).
			confirmBody: "This message will be removed from the conversation and the model context (the raw log is kept for recovery).",
			cancel: "Cancel",
			close: "Close",
			noticeOk: "Dismiss",
			deleted: "Deleted",
			failed: "Delete failed",
			"reason.not-found": "Message or session not found. Make sure the session is open.",
			"reason.not-surface-type": "This type of record cannot be deleted.",
			"reason.already-shadowed": "This message has already been deleted.",
			"reason.has-tool-calls": "Messages with tool calls cannot be deleted individually yet.",
			"reason.open-turn": "This turn is still in progress. Try again once it finishes.",
			"reason.append-rejected": "The host rejected this change.",
			"reason.internal": "Internal error."
		};

		/**
		 * The host locale service resolves via browser languages plus a Host
		 * preference. The DOM-enhancement path has no hook into that face, so it
		 * repeats the documented browser heuristic; the React path always uses
		 * the kit's real translator instead.
		 */
		function detectDomLocale() {
			try {
				for (const tag of [...(navigator.languages ?? []), navigator.language]) {
					if (typeof tag !== "string") continue;
					const primary = tag.toLowerCase().split("-")[0];
					if (primary === "zh" || primary === "en") return primary;
				}
			} catch {
				// navigator unavailable — fall through to the default below.
			}
			return "zh";
		}

		/** Minimal translator over the registered dictionaries. */
		function translateWith(dictionary) {
			return (key, params) => {
				// Flat hit first — parity with the host LocaleRuntime's one-level
				// lookup — then the dotted-path walk for nested shapes.
				let value = dictionary[key];
				if (typeof value !== "string") {
					value = dictionary;
					for (const part of key.split(".")) value = value?.[part];
				}
				if (typeof value !== "string") return key;
				if (params === undefined) return value;
				return value.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
			};
		}

		// ------------------------------------------------------------------
		// Official glyphs, inlined from @deepseek-ai/dsh-client-ui-primitives
		// (ic_ds_trash_outline_16 / ic_ds_close_outline_16) so the icons sit
		// beside IconCopyOutline16 with identical geometry and ink.
		// ------------------------------------------------------------------
		const TRASH_PATH =
			"M14.4782 4.84067L14.2138 10.1152C14.1102 12.1872 14.067 13.0115 13.3866 13.9607C13.1044 14.3546 12.7498 14.6912 12.3424 14.9535C11.8239 15.2872 11.2415 15.4316 10.5585 15.4998C9.88727 15.5668 9.04946 15.5656 7.99998 15.5656C6.95051 15.5656 6.1127 15.5668 5.44142 15.4998C4.75851 15.4316 4.17602 15.2872 3.65753 14.9535C3.25012 14.6912 2.89559 14.3546 2.61332 13.9607C1.93296 13.0115 1.88979 12.1872 1.78619 10.1152L1.52179 4.84067L2.89006 4.77277L3.15343 10.0463C3.26221 12.2218 3.32452 12.6015 3.72646 13.1624C3.90825 13.4161 4.13686 13.6334 4.39927 13.8023C4.66204 13.9714 5.00263 14.0792 5.57825 14.1367C6.16562 14.1953 6.92298 14.1963 7.99998 14.1963C9.07699 14.1963 9.83434 14.1953 10.4217 14.1367C10.9973 14.0792 11.3379 13.9714 11.6007 13.8023C11.8631 13.6334 12.0917 13.4161 12.2735 13.1624C12.6755 12.6015 12.7378 12.2218 12.8465 10.0463L13.1099 4.77277L14.4782 4.84067ZM5.43011 6.22849H6.7994V11.3909H5.43011V6.22849ZM9.20056 6.22849H10.5699V11.3909H9.20056V6.22849ZM8.53597 0.434431C9.17976 0.434431 9.6522 0.426926 10.0966 0.571258C10.2357 0.616451 10.3717 0.672554 10.502 0.738948C10.9182 0.951107 11.2464 1.29099 11.7015 1.74612L12.4978 2.54136H15.3742V3.91169H0.625732V2.54136H3.50218L4.29845 1.74612C4.75358 1.29099 5.08174 0.951107 5.49801 0.738948C5.62831 0.672554 5.76425 0.616451 5.90334 0.571258C6.34776 0.426926 6.82021 0.434431 7.46399 0.434431H8.53597ZM7.46399 1.80476C6.73208 1.80476 6.51641 1.81187 6.32617 1.87369C6.25545 1.89667 6.18668 1.92533 6.12041 1.95907C5.96398 2.03878 5.82348 2.16253 5.44142 2.54136H10.5585C10.1765 2.16253 10.036 2.03878 9.87955 1.95907C9.81329 1.92533 9.74452 1.89667 9.6738 1.87369C9.48356 1.81187 9.26789 1.80476 8.53597 1.80476H7.46399Z";
		const CLOSE_PATHS = [
			"M14.1168 13.197L13.197 14.1167L1.8833 2.80303L2.80309 1.88324L14.1168 13.197Z",
			"M13.197 1.88326L14.1168 2.80305L2.80309 14.1168L1.8833 13.197L13.197 1.88326Z"
		];

		function TrashGlyph() {
			return jsx("svg", {
				width: 16,
				height: 16,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": true,
				children: jsx("path", { d: TRASH_PATH, fill: "currentColor" })
			});
		}

		const TRASH_SVG_HTML =
			'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
			`<path d="${TRASH_PATH}" fill="currentColor"/></svg>`;

		// ------------------------------------------------------------------
		// Style sheet — verbatim values lifted from the host sources:
		// action button = MessageIconActions.module.css `.action`;
		// bubble = Tooltip.module.css `.bubble` (+ placement transforms);
		// dialog = Modal.module.css root/mask/dialog/header/title/close/
		//          description/footer; buttons = Button.module.css base/md/
		//          outline/primary; failure line = feedback plugin's `.failure`.
		// ------------------------------------------------------------------
		const STYLE_ID = "dsh-delete-message-style";
		const STYLE_TEXT = `
.${ACTION_CLASS}{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex}
.${ACTION_CLASS}:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.${ACTION_CLASS}:disabled{cursor:default;opacity:.4}
.dshdm-failure{color:var(--dsw-alias-label-tertiary);padding-left:4px;font-size:13px;line-height:28px}
.${BUBBLE_CLASS}{position:fixed;z-index:100;width:max-content;max-width:50vw;padding:3px 7px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-size:13px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;pointer-events:none;animation:dshdm-tooltip-in .15s var(--ds-ease-in-out)}
.${BUBBLE_CLASS}[data-side=right]{transform:translateY(-50%)}
.${BUBBLE_CLASS}[data-side=bottom]{transform:translate(-50%)}
.${BUBBLE_CLASS}[data-side=top]{transform:translate(-50%,-100%)}
@keyframes dshdm-tooltip-in{0%{opacity:0}}
@media(prefers-reduced-motion:reduce){.${BUBBLE_CLASS}{animation:none}}
.dshdm-modal-root{position:fixed;top:0;right:0;bottom:0;left:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px}
.dshdm-modal-mask{position:absolute;top:0;right:0;bottom:0;left:0;background:var(--dsw-alias-bg-mask-1);-webkit-backdrop-filter:var(--dsw-mask-blur);backdrop-filter:var(--dsw-mask-blur)}
.dshdm-modal-dialog{position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(380px,100%);padding:0 0 24px;overflow:hidden;border:1px solid var(--dsw-alias-border-inverted);border-radius:24px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3)}
.dshdm-modal-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.dshdm-modal-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshdm-modal-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:8px;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dshdm-modal-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshdm-modal-description{margin:0;padding:0 24px;font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary)}
.dshdm-modal-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}
.dshdm-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:18px;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent;padding:0 14px;height:36px}
.dshdm-btn:disabled{cursor:not-allowed;opacity:.4}
.dshdm-btn-outline{border:1px solid var(--dsw-alias-border-l2);background:transparent}
.dshdm-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshdm-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dshdm-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
[data-dsh-delete-hidden]{display:none!important}
`;

		function injectStyleOnce() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const tag = document.createElement("style");
			tag.id = STYLE_ID;
			tag.dataset.plugin = "dsh-delete-message";
			tag.textContent = STYLE_TEXT;
			document.head.appendChild(tag);
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
		// Shapes pinned against the conversation contract types (and against a
		// live crash): ConversationSnapshot.chat is a ChatSnapshot whose `nodes`
		// is a ChatNodeStore — a plain object with get(key)/values() — NOT an
		// array; iterating it directly throws "nodes is not iterable". Settled
		// assistant nodes carry data.finalNode.{messageId,seq}; steering nodes
		// carry data.messageId/data.seq. Both helpers fail soft: unresolved seq
		// disables the button rather than guessing.
		// ------------------------------------------------------------------

		/** Walk the chat snapshot looking for one message id's deletable node. */
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
				if (
					finalNode !== null && typeof finalNode === "object" &&
					finalNode.messageId !== undefined && String(finalNode.messageId) === String(messageId)
				) {
					return typeof finalNode.seq === "number" ? finalNode.seq : undefined;
				}
				if (data.kind === "steering" && data.messageId !== undefined && String(data.messageId) === String(messageId)) {
					return typeof data.seq === "number" ? data.seq : undefined;
				}
			}
			return undefined;
		}

		/**
		 * Read the chat node off a DOM element's React fiber and return its
		 * durable identity. User/steering rows carry their node through
		 * UserMessageNodeView with the seq at node.data.seq. As a side benefit,
		 * any `sessionId` string seen on walked props feeds session-id capture
		 * (slot components receive it through the standard kit). Fails soft
		 * with undefined — callers refuse rather than guess.
		 */
		function seqFromFiber(element, onSessionId) {
			try {
				const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
				if (fiberKey === undefined) return undefined;
				let fiber = element[fiberKey];
				for (let hops = 0; fiber !== undefined && hops < 50; hops += 1, fiber = fiber.return) {
					const props = fiber.memoizedProps;
					// Resolve the row identity BEFORE the passive session-id feed:
					// the node-carrying fiber is the payoff, and a throwing feed must
					// never abort the walk (v0.1.3 passed a getter-only function where
					// `.note()` was expected, so the first sessionId-carrying fiber
					// TypeError'd and the row came back unresolved → "not found").
					const node = props?.node;
					if (node !== undefined && node !== null && typeof node === "object") {
						const kind = node.kind ?? "";
						if (kind === "user" || kind === "steering") {
							const seq = node.data?.seq ?? node.location?.seq;
							if (typeof seq === "number") return seq;
						}
					}
					if (typeof onSessionId === "function" && typeof props?.sessionId === "string") {
						try {
							onSessionId(props.sessionId);
						} catch {
							// Best-effort capture; never let it derail identity resolution.
						}
					}
				}
			} catch {
				// Fiber layout changed; fall through to the refusal below.
			}
			return undefined;
		}

		// ------------------------------------------------------------------
		// Visual removal — the transcript-side counterpart of a landed
		// surface replace. The host keeps append-origin rows visible by
		// design, so hiding deleted rows is entirely this plugin's job.
		//
		// Identity: every chat node renders inside a ChatNodeSeat wrapper
		// carrying [data-chat-anchor-key]/[data-chat-flow-key]; probing any
		// React-owned element inside it and walking fibers reaches the view
		// component whose props.node names the row kind and seq:
		//   user/steering/context → data.seq
		//   assistant-step        → data.finalNode.seq
		//   turn-tail             → data.closing.finalNode.seq
		// Ledger: per-session deleted-seq set persisted in localStorage so
		// hides survive reloads. Healing: rows whose ledger state is unknown
		// get ONE /status preflight — `already-shadowed` marks the ledger,
		// which is how rows deleted in another tab or before install vanish
		// here too.
		// ------------------------------------------------------------------

		const HIDDEN_MARK = "data-dsh-delete-hidden";
		const LEDGER_PREFIX = "dsh-delete-message:deleted:v2:";
		const LEDGER_CAP = 400;
		const rowSeqCache = new WeakMap();
		const rowKindCache = new WeakMap();
		const preflightTried = new WeakSet();

		/** querySelectorAll that survives minimal DOM stubs (smoke harness). */
		function safeQueryAll(root, selector) {
			try {
				return Array.from((root ?? document).querySelectorAll(selector));
			} catch {
				return [];
			}
		}

		/**
		 * Read one chat-node identity off ANY React-owned element inside a
		 * row. Extends {@link seqFromFiber} with the assistant/turn-tail/
		 * context kinds the hider needs; user/steering behavior is identical.
		 */
		function resolveRowSeq(element, onSessionId) {
			try {
				const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
				if (fiberKey === undefined) return undefined;
				let fiber = element[fiberKey];
				for (let hops = 0; fiber !== undefined && hops < 60; hops += 1, fiber = fiber.return) {
					const props = fiber.memoizedProps;
					const node = props?.node;
					if (node !== undefined && node !== null && typeof node === "object") {
						const data = node.data;
						let seq;
						switch (node.kind ?? "") {
							case "user":
							case "steering":
							case "context":
								seq = typeof data?.seq === "number" ? data.seq : undefined;
								break;
							case "assistant":
							case "assistant-step":
								seq = typeof data?.finalNode?.seq === "number" ? data.finalNode.seq : undefined;
								break;
							case "turn-tail":
								seq = typeof data?.closing?.finalNode?.seq === "number" ? data.closing.finalNode.seq : undefined;
								break;
							case "tool-call":
							case "model-retry":
								// These rows are chrome over NON-surface events; their
								// identity is the node's top-level anchorSeq (present on
								// every chat node kind), not anything inside data.
								seq = typeof node.anchorSeq === "number" ? node.anchorSeq : undefined;
								break;
							default:
								break;
						}
						if (typeof seq === "number") {
							// Record WHICH kind produced the seq: the hider needs the row
							// role to keep turn-window ranges off real user/steering rows.
							rowKindCache.set(element, String(node.kind ?? ""));
							return seq;
						}
					}
					if (typeof onSessionId === "function" && typeof props?.sessionId === "string") {
						try {
							onSessionId(props.sessionId);
						} catch {
							// Best-effort capture; never let it derail identity resolution.
						}
					}
				}
			} catch {
				// Fiber layout changed; the caller treats this as unresolved.
			}
			return undefined;
		}

		/**
		 * Probe candidates inside one flow-item wrapper, best-first: the hover
		 * root's first button (user rows + turn tails), the hover root itself,
		 * then direct element children of the wrapper (assistant-step nodes
		 * render NO wrapper div — the flow-item's children ARE the markdown
		 * elements whose fibers lead to AssistantNodeView).
		 */
		function probeElementsFor(wrapper) {
			const probes = [];
			if (!(wrapper instanceof Element)) return probes;
			const hover = wrapper.querySelector("[data-time-hover-root]");
			if (hover !== null) {
				const button = hover.querySelector("button");
				if (button !== null) probes.push(button);
				probes.push(hover);
			}
			// Try the first few direct element children — for assistant-step and
			// similar rows the flow-item div has no hover root and its children
			// are the content elements directly rendered by the node view.
			for (const child of wrapper.children) {
				if (probes.length >= 6) break;
				if (child instanceof Element) probes.push(child);
			}
			return probes;
		}

		/** Resolve a flow-item wrapper's surface seq via its probe chain. */
		function resolveWrapperSeq(wrapper, onSessionId) {
			for (const probe of probeElementsFor(wrapper)) {
				const seq = resolveRowSeq(probe, onSessionId);
				if (typeof seq === "number") {
					const kind = rowKindCache.get(probe);
					if (typeof kind === "string") rowKindCache.set(wrapper, kind);
					return seq;
				}
			}
			return undefined;
		}

		/**
		 * Per-session deletion ledger, version 2: exact deleted seqs PLUS whole
		 * turn ranges. A range is what hides rows that no surface replacement
		 * could ever cite — tool/call summary nodes anchor at non-surface
		 * events inside the turn. Old plain-array values are still readable.
		 */
		const ledgerMemory = new Map();
		function ledgerFor(sessionId) {
			let entry = ledgerMemory.get(sessionId);
			if (entry === undefined) {
				entry = { seqs: new Set(), ranges: [] };
				try {
					const raw = window.localStorage.getItem(LEDGER_PREFIX + sessionId);
					if (raw !== null) {
						const parsed = JSON.parse(raw);
						if (Array.isArray(parsed)) {
							for (const value of parsed) if (Number.isSafeInteger(value)) entry.seqs.add(value);
						} else if (parsed !== null && typeof parsed === "object") {
							for (const value of Array.isArray(parsed.s) ? parsed.s : []) {
								if (Number.isSafeInteger(value)) entry.seqs.add(value);
							}
							for (const pair of Array.isArray(parsed.r) ? parsed.r : []) {
								const start = Array.isArray(pair) ? pair[0] : undefined;
								const end = Array.isArray(pair) ? pair[1] : undefined;
								const okStart = start === null || Number.isSafeInteger(start);
								const okEnd = end === null || Number.isSafeInteger(end);
								if (okStart && okEnd && (start !== null || end !== null)) {
									entry.ranges.push({ start, end });
								}
							}
						}
					}
				} catch {
					// Storage unavailable (privacy mode, stubbed window) — the
					// in-memory entry still covers this page's lifetime.
				}
				ledgerMemory.set(sessionId, entry);
			}
			return entry;
		}
		function persistLedger(sessionId, entry) {
			try {
				window.localStorage.setItem(
					LEDGER_PREFIX + sessionId,
					JSON.stringify({
						s: [...entry.seqs].slice(-LEDGER_CAP),
						r: entry.ranges.slice(-64).map((range) => [range.start, range.end])
					})
				);
			} catch {
				// Same fallback as read: page-lifetime only.
			}
		}
		function ledgerHas(sessionId, seq) {
			const entry = ledgerFor(sessionId);
			if (entry.seqs.has(seq)) return true;
			// Range bounds are EXCLUSIVE — each bound IS a real user input, so the
			// boundary seqs themselves are live user rows that must read uncovered.
			// v0.1.3 compared inclusively here (`>=`/`<=`, with a null bound
			// coercing to 0), so after every turn delete this read the two
			// neighboring user inputs as covered chrome and the sweeper hid them:
			// "deleting one reply eats the surrounding user prompts".
			return entry.ranges.some((range) =>
				(range.start === null || seq > range.start) && (range.end === null || seq < range.end)
			);
		}
		function ledgerMark(sessionId, seq) {
			const entry = ledgerFor(sessionId);
			entry.seqs.add(seq);
			persistLedger(sessionId, entry);
		}
		function ledgerMarkRange(sessionId, range) {
			if (!range || (range.start === null && range.end === null)) return;
			const start = Number.isSafeInteger(range.start) ? range.start : null;
			const end = Number.isSafeInteger(range.end) ? range.end : null;
			if (start === null && end === null) return;
			const entry = ledgerFor(sessionId);
			// Absorb into an existing fully-bounded OVERLAPPING range when
			// possible. The comparison is strict on both sides: two windows that
			// merely TOUCH at a shared real-user-input bound must stay separate —
			// an inclusive merge ([10,20]+[20,30] → [10,30]) would re-cover the
			// shared boundary row under the exclusive semantics above.
			let absorbed = false;
			if (start !== null && end !== null) {
				for (const existing of entry.ranges) {
					if (existing.start !== null && existing.end !== null && start < existing.end && end > existing.start) {
						existing.start = Math.min(existing.start, start);
						existing.end = Math.max(existing.end, end);
						absorbed = true;
						break;
					}
				}
			}
			if (!absorbed) entry.ranges.push({ start, end });
			persistLedger(sessionId, entry);
		}

		/** Normalize one seq or a list into a clean number array. */
		function asSeqList(seqOrSeqs) {
			if (typeof seqOrSeqs === "number") return [seqOrSeqs];
			return Array.isArray(seqOrSeqs) ? seqOrSeqs.filter((value) => typeof value === "number") : [];
		}

		/** Extract the replaced-seq list from a delete response (array, number, or fallback). */
		function replacedSeqsOf(outcome, fallback) {
			const list = asSeqList(outcome?.replaced);
			if (list.length > 0) return list;
			return typeof fallback === "number" ? [fallback] : [];
		}

		/**
		 * Normalize a hide request into `{ seqs: Set<number>, ranges: [] }`.
		 * Accepts a number, a list, a `{seqs,ranges}` plan, or a delete outcome
		 * shape (`{replaced, mode, range}`).
		 */
		function asPlan(input) {
			if (input !== null && typeof input === "object" && !Array.isArray(input)) {
				const seqs = new Set(asSeqList(input.seqs ?? input.replaced));
				const ranges = [];
				const rawRanges = Array.isArray(input.ranges) ? input.ranges : input.range !== undefined ? [input.range] : [];
				for (const range of rawRanges) {
					if (range !== null && typeof range === "object") {
						const start = Number.isSafeInteger(range.start) ? range.start : null;
						const end = Number.isSafeInteger(range.end) ? range.end : null;
						if (start !== null || end !== null) ranges.push({ start, end });
					}
				}
				return { seqs, ranges };
			}
			return { seqs: new Set(asSeqList(input)), ranges: [] };
		}

		/**
		 * Whether a resolved/anchored seq is covered by the plan's exact set or
		 * any window. Window bounds are the REAL user inputs themselves and are
		 * EXCLUSIVE — a user row's own seq can never be covered even on code
		 * paths that cannot see node kinds.
		 */
		function planCovers(plan, seq) {
			if (typeof seq !== "number") return false;
			if (plan.seqs.has(seq)) return true;
			return plan.ranges.some((range) =>
				(range.start === null || seq > range.start) && (range.end === null || seq < range.end)
			);
		}

		/**
		 * Record successful deletes and hide every rendered row they cover,
		 * right now — instant feedback, independent of any observer timing.
		 */
		function hideRowsBySeq(sessionId, planInput) {
			if (typeof sessionId !== "string") return;
			const plan = asPlan(planInput);
			if (plan.seqs.size === 0 && plan.ranges.length === 0) return;
			for (const seq of plan.seqs) ledgerMark(sessionId, seq);
			for (const range of plan.ranges) ledgerMarkRange(sessionId, range);
			for (const wrapper of safeQueryAll(document, "[data-chat-flow-key]")) {
				let resolved = rowSeqCache.get(wrapper);
				// Never trust a cached placeholder — a failed early resolution must
				// not block the authoritative post-delete sweep.
				if (typeof resolved !== "number") {
					resolved = resolveWrapperSeq(wrapper, () => {});
					if (typeof resolved === "number") rowSeqCache.set(wrapper, resolved);
				}
				if (planCovers(plan, resolved)) wrapper.setAttribute(HIDDEN_MARK, "");
			}
		}

		/**
		 * Hide every wrapper whose ChatNode identity is covered by the plan by
		 * reading the session snapshot directly and matching
		 * {@link data-chat-anchor-key} — zero fiber walks. A node matches when
		 * ANY of its identities (top-level anchorSeq — present on every chat
		 * node kind, including tool/call summaries — or the per-kind data
		 * fields) is covered. Range coverage skips user/steering kinds so real
		 * user steering words inside the turn survive a turn deletion.
		 */
		function hideRowsForSeqViaChatNodes(sessionId, planInput, snapshot) {
			if (typeof sessionId !== "string" || snapshot === null || snapshot === undefined) return;
			const plan = asPlan(planInput);
			if (plan.seqs.size === 0 && plan.ranges.length === 0) return;
			for (const seq of plan.seqs) ledgerMark(sessionId, seq);
			for (const range of plan.ranges) ledgerMarkRange(sessionId, range);
			const keys = new Set();
			let nodeCount = 0;
			for (const node of snapshot.chat?.nodes?.values() ?? []) {
				nodeCount += 1;
				if (node === null || typeof node !== "object") continue;
				const data = node.data;
				const identities = [
					node.anchorSeq,
					data?.finalNode?.seq,
					data?.closing?.finalNode?.seq,
					data?.seq
				].filter((value) => typeof value === "number");
				const hit = identities.some((value) => plan.seqs.has(value)) ||
					(node.kind !== "user" && node.kind !== "steering" && identities.some((value) => planCovers(plan, value)));
				if (hit) keys.add(node.key);
			}
			let matched = 0;
			for (const wrapper of safeQueryAll(document, "[data-chat-flow-key]")) {
				const anchor = wrapper.getAttribute("data-chat-anchor-key");
				if (anchor !== null && keys.has(anchor)) {
					wrapper.setAttribute(HIDDEN_MARK, "");
					matched += 1;
				}
			}
			// Diagnostic breadcrumb on the document root: planned size, matched
			// chat nodes, matched DOM wrappers, and the total wrapper count.
			try {
				document.documentElement.setAttribute(
					"data-dshdm-last-hide",
					`seqs=${plan.seqs.size} ranges=${plan.ranges.length} keys=${keys.size}/${nodeCount} wrappers=${matched}`
				);
			} catch {}
		}

		/**
		 * One sweeper unit over a `[data-chat-flow-key]` wrapper: resolve its
		 * seq once, hide it when the ledger knows better, else preflight once
		 * to heal rows deleted outside this browser's knowledge. Safe to call
		 * repeatedly; every expensive step is cached per element.
		 */
		function processFlowItem(wrapper, source) {
			if (!(wrapper instanceof Element) || wrapper.hasAttribute(HIDDEN_MARK)) return;
			const sessionId = source.current();
			if (typeof sessionId !== "string") return; // capture pending — later sweeps retry
			let seq = rowSeqCache.get(wrapper);
			if (seq === undefined && !rowSeqCache.has(wrapper)) {
				const resolved = resolveWrapperSeq(wrapper, (id) => source.note(id));
				// Only cache a successful resolution: a failed early sweep must
				// leave the wrapper retryable for hideRowsBySeq and later sweeps.
				if (typeof resolved === "number") {
					seq = resolved;
					rowSeqCache.set(wrapper, seq);
				}
			}
			if (typeof seq !== "number") return;
			// Real user words hide ONLY through their own exact deleted seq — the
			// single-mode delete of that very row. Turn-window ranges never apply
			// to user/steering rows because the bounds ARE such rows; for the
			// same reason the windowCleared preflight below stays chrome-only.
			// (v0.1.3 regression guard: inclusive ledger comparisons once made
			// this sweeper hide both neighboring user inputs of a turn delete.)
			const kind = rowKindCache.get(wrapper);
			const isUserRole = kind === "user" || kind === "steering";
			if (isUserRole ? ledgerFor(sessionId).seqs.has(seq) : ledgerHas(sessionId, seq)) {
				wrapper.setAttribute(HIDDEN_MARK, "");
				return;
			}
			if (!preflightTried.has(wrapper)) {
				preflightTried.add(wrapper);
				void preflight(sessionId, seq)
					.then((status) => {
						if (status?.live !== true) return;
						if (status.reason === "already-shadowed") {
							ledgerMark(sessionId, seq);
							if (wrapper.isConnected) wrapper.setAttribute(HIDDEN_MARK, "");
						} else if (!isUserRole && status.windowCleared === true && status.window !== undefined) {
							// The whole reply unit is deleted server-side; this row is
							// stale chrome (a tool/call summary) anchored inside the
							// user-input window. Record the window so reloads hide it
							// without a server round trip, and hide it now. Windows are
							// bounded by real user inputs, so this can never cover a
							// real user row.
							ledgerMarkRange(sessionId, status.window);
							if (wrapper.isConnected) wrapper.setAttribute(HIDDEN_MARK, "");
						}
					})
					.catch(() => {
						// Preflight unreachable or refused — leave the row alone;
						// the click path remains authoritative.
					});
			}
		}

		// ------------------------------------------------------------------
		// Tooltip — a faithful port of the primitives implementation for both
		// consumers: the React side clones its anchor child exactly like
		// `Tooltip.js`; the DOM side wires the same show/hide/flip/fit logic
		// onto a raw element. The bubble reuses the host's visual contract:
		// fixed position, 8px gap toward the anchor, viewport-edge clamping,
		// bottom→top flip when there is no room below.
		// ------------------------------------------------------------------

		const EDGE_MARGIN = 12;

		function placeBubble(bubble, rect, side) {
			bubble.dataset.side = side;
			const x = rect.left + rect.width / 2;
			const y = side === "bottom" ? rect.bottom + 8 : rect.top - 8;
			bubble.style.left = `${x}px`;
			bubble.style.top = `${y}px`;
			const measured = bubble.getBoundingClientRect();
			let dx = 0;
			if (measured.right > window.innerWidth - EDGE_MARGIN) dx = window.innerWidth - EDGE_MARGIN - measured.right;
			if (measured.left + dx < EDGE_MARGIN) dx = EDGE_MARGIN - measured.left;
			bubble.style.left = `${x + dx}px`;
		}

		function flipSide(rect, bubbleHeight, side) {
			if (side !== "bottom") return side;
			const fitsBelow = rect.bottom + 8 + bubbleHeight <= window.innerHeight - EDGE_MARGIN;
			const fitsAbove = rect.top - 8 - bubbleHeight >= EDGE_MARGIN;
			return !fitsBelow && fitsAbove ? "top" : side;
		}

		function Tooltip({ label, side = "bottom", children }) {
			const anchorRef = react.useRef(null);
			const bubbleRef = react.useRef(null);
			const [pos, setPos] = react.useState(null);
			const [placement, setPlacement] = react.useState(side);
			const resolvedLabel = pos === null ? null : typeof label === "function" ? label() : label;
			react.useLayoutEffect(() => {
				if (pos === null) return;
				const el = bubbleRef.current;
				if (el === null) return;
				el.style.left = `${pos.x}px`;
				const r = el.getBoundingClientRect();
				let dx = 0;
				if (r.right > window.innerWidth - EDGE_MARGIN) dx = window.innerWidth - EDGE_MARGIN - r.right;
				if (r.left + dx < EDGE_MARGIN) dx = EDGE_MARGIN - r.left;
				el.style.left = `${pos.x + dx}px`;
				setPlacement((current) => flipSide(pos, r.height, current));
			}, [pos, resolvedLabel]);
			const show = () => {
				const el = anchorRef.current;
				if (el === null) return;
				const r = el.getBoundingClientRect();
				setPlacement(side);
				setPos({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom });
			};
			const hide = () => setPos(null);
			const mergedRef = (el) => {
				anchorRef.current = el;
			};
			return jsxs(react.Fragment, {
				children: [
					react.cloneElement(children, {
						ref: mergedRef,
						onMouseEnter: (event) => {
							children.props.onMouseEnter?.(event);
							show();
						},
						onMouseLeave: (event) => {
							children.props.onMouseLeave?.(event);
							hide();
						},
						onFocus: (event) => {
							children.props.onFocus?.(event);
							show();
						},
						onBlur: (event) => {
							children.props.onBlur?.(event);
							hide();
						}
					}),
					pos !== null && jsx("span", {
						ref: bubbleRef,
						className: BUBBLE_CLASS,
						"data-side": placement,
						style: { left: pos.x, top: placement === "bottom" ? pos.bottom + 8 : pos.top - 8 },
						role: "tooltip",
						children: resolvedLabel
					})
				]
			});
		}

		/**
		 * Attach the same tooltip behavior to a plain-DOM button (user-row
		 * mount). Hover shows the bubble below the anchor; keyboard focus shows
		 * it immediately; leave/blur removes it. Returns a disposer.
		 */
		function attachTooltip(el, getLabel) {
			let bubble = null;
			const remove = () => {
				bubble?.remove();
				bubble = null;
			};
			const show = () => {
				remove();
				bubble = document.createElement("span");
				bubble.className = BUBBLE_CLASS;
				bubble.role = "tooltip";
				bubble.textContent = String(getLabel());
				document.body.appendChild(bubble);
				const anchorRect = el.getBoundingClientRect();
				const side = flipSide(anchorRect, bubble.getBoundingClientRect().height, "bottom");
				placeBubble(bubble, anchorRect, side);
			};
			const onEnter = () => show();
			const onLeave = () => remove();
			el.addEventListener("mouseenter", onEnter);
			el.addEventListener("mouseleave", onLeave);
			el.addEventListener("focus", show);
			el.addEventListener("blur", onLeave);
			return () => {
				el.removeEventListener("mouseenter", onEnter);
				el.removeEventListener("mouseleave", onLeave);
				el.removeEventListener("focus", show);
				el.removeEventListener("blur", onLeave);
				remove();
			};
		}

		// ------------------------------------------------------------------
		// Dialogs — plain-DOM replicas of the primitives Modal + Button pair
		// (the same structure RiskConfirmation composes): blurred mask, 380px
		// card, header with close glyph, description, footer buttons.
		// openConfirmDialog = outline-cancel + primary-confirm (Escape / mask
		// / close all cancel). openNoticeDialog = single primary button; it
		// replaces window.alert everywhere — a native alert was exactly the
		// "wrong dialog" the user reported on the user-row path.
		// ------------------------------------------------------------------

		function buildModalCard({ title, description, closeLabel }) {
			const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			const root = document.createElement("div");
			root.className = "dshdm-modal-root";
			root.setAttribute("role", "presentation");

			const mask = document.createElement("div");
			mask.className = "dshdm-modal-mask";
			mask.setAttribute("aria-hidden", "true");

			const dialog = document.createElement("div");
			dialog.className = "dshdm-modal-dialog";
			dialog.setAttribute("role", "dialog");
			dialog.setAttribute("aria-modal", "true");
			dialog.setAttribute("aria-label", title);

			const header = document.createElement("div");
			header.className = "dshdm-modal-header";
			const heading = document.createElement("h2");
			heading.className = "dshdm-modal-title";
			heading.textContent = title;
			const closeButton = document.createElement("button");
			closeButton.type = "button";
			closeButton.className = "dshdm-modal-close";
			closeButton.setAttribute("aria-label", closeLabel);
			closeButton.innerHTML =
				'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
				CLOSE_PATHS.map((d) => `<path d="${d}" fill="currentColor"/>`).join("") +
				"</svg>";
			header.append(heading, closeButton);

			const body = document.createElement("p");
			body.className = "dshdm-modal-description";
			body.textContent = description;

			dialog.append(header, body);
			root.append(mask, dialog);
			return { opener, root, mask, dialog, closeButton };
		}

		function openConfirmDialog({ title, description, confirmLabel, cancelLabel, closeLabel }) {
			const card = buildModalCard({ title, description, closeLabel });
			return new Promise((resolve) => {
				const footer = document.createElement("div");
				footer.className = "dshdm-modal-footer";
				const cancelButton = document.createElement("button");
				cancelButton.type = "button";
				cancelButton.className = "dshdm-btn dshdm-btn-outline";
				cancelButton.textContent = cancelLabel;
				const confirmButton = document.createElement("button");
				confirmButton.type = "button";
				confirmButton.className = "dshdm-btn dshdm-btn-primary";
				confirmButton.textContent = confirmLabel;
				footer.append(cancelButton, confirmButton);
				card.dialog.append(footer);

				const finish = (answer) => {
					document.removeEventListener("keydown", onKeyDown, true);
					card.root.remove();
					card.opener?.focus?.();
					resolve(answer);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") finish(false);
				};

				card.mask.addEventListener("click", () => finish(false));
				card.closeButton.addEventListener("click", () => finish(false));
				cancelButton.addEventListener("click", () => finish(false));
				confirmButton.addEventListener("click", () => finish(true));
				document.addEventListener("keydown", onKeyDown, true);

				document.body.appendChild(card.root);
				confirmButton.focus();
			});
		}

		/** Single-button modal notice. Resolves once dismissed. */
		function openNoticeDialog({ title, description, okLabel, closeLabel }) {
			const card = buildModalCard({ title, description, closeLabel });
			return new Promise((resolve) => {
				const footer = document.createElement("div");
				footer.className = "dshdm-modal-footer";
				const okButton = document.createElement("button");
				okButton.type = "button";
				okButton.className = "dshdm-btn dshdm-btn-primary";
				okButton.textContent = okLabel;
				footer.append(okButton);
				card.dialog.append(footer);

				const finish = () => {
					document.removeEventListener("keydown", onKeyDown, true);
					card.root.remove();
					card.opener?.focus?.();
					resolve(true);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") finish();
				};

				card.mask.addEventListener("click", finish);
				card.closeButton.addEventListener("click", finish);
				okButton.addEventListener("click", finish);
				document.addEventListener("keydown", onKeyDown, true);

				document.body.appendChild(card.root);
				okButton.focus();
			});
		}

		// ------------------------------------------------------------------
		// Shared confirm-then-delete flow used by both mounts. The `role`
		// argument ("user" | "assistant") is STATIC knowledge of the calling
		// mount — the assistant slot only renders on assistant replies, the
		// DOM enhancement only on user rows — so the confirm body states the
		// actual scope for that role instead of hedging with "if this is an
		// assistant reply".
		// ------------------------------------------------------------------
		function makeDeleteFlow(t) {
			return async function runDelete(sessionId, seq, role) {
				const bodyKey = role === "assistant" ? "confirmBodyAssistant" : role === "user" ? "confirmBodyUser" : "confirmBody";
				const confirmed = await openConfirmDialog({
					title: t("confirmTitle"),
					description: t(bodyKey),
					confirmLabel: t("delete"),
					cancelLabel: t("cancel"),
					closeLabel: t("close")
				});
				if (!confirmed) return { ok: false, cancelled: true };
				try {
					return await requestDelete(sessionId, seq);
				} catch (error) {
					console.error("[delete-message] delete failed:", error);
					void openNoticeDialog({
						title: t("failed"),
						description: t("reason.internal"),
						okLabel: t("noticeOk"),
						closeLabel: t("close")
					});
					return { ok: false };
				}
			};
		}

		// ------------------------------------------------------------------
		// Mount 2 — user rows via DOM enhancement.
		// ------------------------------------------------------------------

		/**
		 * The host's MessageIconActions strip is identifiable by its CSS-modules
		 * token: every build composes it as "<hash>_actions" (+ a feature-level
		 * "<hash>_actions"). Third-party wrappers that happen to sit inside a
		 * message row (rewind triggers, portals) never carry such a token, which
		 * is what keeps the enhancement from multiplying icons across them.
		 */
		const ACTIONS_TOKEN = /(?:^|\s)([\w$-]+_actions)(?:\s|$)/;

		function looksLikeActionsStrip(el) {
			return el.tagName === "DIV" && ACTIONS_TOKEN.test(typeof el.className === "string" ? el.className : "") && el.querySelector(":scope > button") !== null;
		}

		/**
		 * Enhance ONE actions strip: the caller has already narrowed it to a
		 * direct-child div of the hover root carrying an `*_actions` class token,
		 * and this guard keeps the work idempotent across observer batches. Any
		 * stray trash copies from earlier runs inside THIS strip are removed
		 * first (keep exactly one). The trash button borrows the copy button's
		 * live class list (box, padding, radius, hover background, hover-reveal
		 * inheritance), uses the official trash glyph, and gets NO native title
		 * — the shared bubble covers it.
		 */
		function enhanceUserRow(strip, source, t) {
			for (const stale of strip.querySelectorAll(":scope > button[data-dsh-delete-icon]")) stale.remove();
			if (strip.hasAttribute(STRIP_MARK)) return;
			const copyButton = strip.querySelector(":scope > button");
			if (copyButton === null) return;

			// Passive identity capture at mount: one fiber walk over the host
			// button feeds any props.sessionId into the shared source BEFORE
			// any click, so the first click on a fresh page already has it.
			seqFromFiber(copyButton, (id) => source.note(id));

			const trash = document.createElement("button");
			trash.type = "button";
			trash.className = copyButton.className;
			trash.setAttribute("aria-label", t("deleteAria"));
			trash.setAttribute("data-dsh-delete-icon", "");
			trash.innerHTML = TRASH_SVG_HTML;
			const disposeTooltip = attachTooltip(trash, () => t("delete"));

			trash.addEventListener("click", (event) => {
				event.stopPropagation();
				void (async () => {
					try {
						// Identity FIRST, refusal SECOND. The fiber walk doubles as
						// the passive sessionId feed; v0.1.2 checked the captured id
						// before walking and could alert without ever having looked.
						const anchors = [];
						const hostButton = strip.querySelector(":scope > button:not([data-dsh-delete-icon])");
						if (hostButton !== null) anchors.push(hostButton);
						const wrapper = strip.closest("[data-chat-flow-key]");
						if (wrapper !== null) anchors.push(...probeElementsFor(wrapper));
						let seq;
						for (const anchor of anchors) {
							const resolved = seqFromFiber(anchor, (id) => source.note(id));
							if (typeof resolved === "number") {
								seq = resolved;
								break;
							}
						}
						const sessionId = source.current();
						if (typeof seq !== "number" || typeof sessionId !== "string") {
							console.warn("[delete-message] user row identity unresolved; refusing to guess");
							void openNoticeDialog({
								title: t("failed"),
								description: t("reason.not-found"),
								okLabel: t("noticeOk"),
								closeLabel: t("close")
							});
							return;
						}
						const outcome = await makeDeleteFlow(t)(sessionId, seq, "user");
						if (outcome?.ok) {
							const seqs = replacedSeqsOf(outcome, seq);
							console.info("[delete-message] message(s) deleted (session %s, %d node(s))", sessionId, seqs.length);
							hideRowsBySeq(sessionId, seqs);
						} else if (outcome?.error === "already-shadowed") {
							// The server already replaced this node (a prior delete landed
							// but the row was never hidden). That IS a successful delete —
							// hide it like one, do not surface a failure dialog.
							console.info("[delete-message] user seq %d already shadowed; hiding row (session %s)", seq, sessionId);
							hideRowsBySeq(sessionId, [seq]);
						} else if (outcome?.cancelled !== true && outcome?.error !== undefined) {
							const reasonKey = `reason.${outcome.error}`;
							const reason = t(reasonKey);
							void openNoticeDialog({
								title: t("failed"),
								description: reason === reasonKey ? outcome.error : reason,
								okLabel: t("noticeOk"),
								closeLabel: t("close")
							});
						}
					} catch (error) {
						console.error("[delete-message] user-row delete flow crashed:", error);
					}
				})();
			});

			copyButton.after(trash);
			strip.setAttribute(STRIP_MARK, "");
			console.info("[delete-message] trash mounted into a user actions strip");
			return disposeTooltip;
		}

		/**
		 * Watch the transcript for user action rows. A qualifying row is a
		 * `[data-time-hover-root]` that is neither a turn tail nor a pending
		 * steering bubble; ITS ACTIONS STRIP is a DIRECT child div whose class
		 * list carries the host's `*_actions` module token AND which holds at
		 * least one direct-child button (the copy button). Class-token matching
		 * is what excludes third-party wrappers injected into the same row —
		 * plain "div with a button" once enhanced a rewind portal too, doubling
		 * the icon. The strip mark makes repeat scans no-ops.
		 */
		function startDomEnhancement(source, t) {
			const disposers = [];
			const retryTimers = [];
			let lastSweep = 0;
			let lastFlowSweep = 0;
			const sweepStrayIcons = (now) => {
				if (now - lastSweep < 1500) return;
				lastSweep = now;
				for (const icon of safeQueryAll(document, "button[data-dsh-delete-icon]")) {
					const strip = icon.parentElement;
					if (strip === null || !looksLikeActionsStrip(strip) || !strip.hasAttribute(STRIP_MARK)) {
						icon.remove();
					}
				}
			};
			/** Hide transcript rows whose seq the ledger (or a healed preflight) knows is deleted. */
			const sweepFlowItems = () => {
				const now = Date.now();
				if (now - lastFlowSweep < 800) return;
				lastFlowSweep = now;
				for (const wrapper of safeQueryAll(document, "[data-chat-flow-key]")) processFlowItem(wrapper, source);
			};
			const flowItemsWithin = (node) => {
				if (!(node instanceof Element)) return [];
				return node.hasAttribute("data-chat-flow-key")
					? [node]
					: safeQueryAll(node, "[data-chat-flow-key]");
			};
			const observer = new MutationObserver((mutations) => {
				sweepStrayIcons(Date.now());
				sweepFlowItems();
				for (const mutation of mutations) {
					for (const node of mutation.addedNodes) {
						if (!(node instanceof Element)) continue;
						for (const wrapper of flowItemsWithin(node)) processFlowItem(wrapper, source);
						const candidates = [node, ...node.querySelectorAll("*")];
						for (const el of candidates) {
							if (!el.matches("[data-time-hover-root]")) continue;
							if (el.hasAttribute("data-turn-tail")) continue;
							if (el.hasAttribute("data-pending-steering")) continue;
							for (const child of el.children) {
								if (child.hasAttribute(STRIP_MARK)) continue;
								if (!looksLikeActionsStrip(child)) continue;
								const disposer = enhanceUserRow(child, source, t);
								if (typeof disposer === "function") disposers.push(disposer);
							}
						}
					}
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });
			// Initial pass plus a short retry ladder: the passive session-id
			// capture can land after the first paint, so deferred rows (and
			// their preflight healing) re-evaluate once it does.
			sweepFlowItems();
			for (const delay of [400, 1200, 3000]) {
				retryTimers.push(setTimeout(() => {
					sweepFlowItems();
				}, delay));
			}
			console.info("[delete-message] DOM enhancement active (user rows + deleted-row hider)");
			return () => {
				observer.disconnect();
				for (const timer of retryTimers.splice(0)) clearTimeout(timer);
				for (const dispose of disposers.splice(0)) dispose();
			};
		}

		// ------------------------------------------------------------------
		// apply — services injected by the client runtime.
		// ------------------------------------------------------------------

		/**
		 * Client-half services this bundle needs before it can register.
		 *
		 * NO `sessions` here: requiring it hands the plugin a lazy accessor
		 * that throws "cannot get required service sessions in inactive
		 * context" on first touch. The current session id is captured instead —
		 * assistant-slot renders report theirs, and the DOM path harvests any
		 * `props.sessionId` seen while walking fibers.
		 */
		const inject = ["slots", "locale"];

		/**
		 * Capture-only session-id source. Values arrive from two passive feeds:
		 * every assistant-actions render notes its kit-provided sessionId, and
		 * user-row fiber walks note whatever they pass through. No service is
		 * ever resolved, so nothing can throw.
		 */
		function makeSessionIdSource() {
			let lastKnown;
			return {
				note(sessionId) {
					if (typeof sessionId === "string") lastKnown = sessionId;
				},
				current() {
					return lastKnown;
				}
			};
		}

		/**
		 * Register both mounts.
		 *
		 * `slots.inject` rather than a bare `register`, so a late-declared slot
		 * is followed instead of missed. The registration declares `locale: NS`
		 * so the slot system hands the component the real namespace translator,
		 * exactly like the official feedback entry does.
		 */
		function apply(ctx) {
			console.info("[delete-message] apply(); registering assistant-actions seat + DOM enhancement");
			injectStyleOnce();

			try {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "delete-message: dictionaries");
			} catch (error) {
				console.warn("[delete-message] locale.register failed; built-in strings stay:", error);
			}

			const sessionIds = makeSessionIdSource();

			// Mirror the slot ledger's supervision seam into our log: if the
			// assistant entry ever misbehaves, the crash reason lands in the
			// console under our tag instead of vanishing into the boundary.
			try {
				if (typeof ctx.slots.onEntryError === "function") {
					ctx.slots.onEntryError((slotKey, entry, error) => {
						if (slotKey !== "conversation.chat.assistant-actions") return;
						console.error("[delete-message] assistant-actions entry error:", error);
					});
				}
			} catch (error) {
				console.warn("[delete-message] onEntryError subscription failed:", error);
			}

			// Mount 1 — assistant messages (official slot).
			try {
				/**
				 * Crash shield: a render error inside the control is logged and
				 * downgraded to a small warning glyph, so the ENTRY ITSELF never
				 * abdicates again (v0.1.1 lost the seat to a single jsx() typo and
				 * looked exactly like "the button does not exist").
				 */
				class DeleteControlBoundary extends react.Component {
					constructor(props) {
						super(props);
						this.state = { error: null };
					}
					static getDerivedStateFromError(error) {
						return { error };
					}
					componentDidCatch(error, info) {
						console.error("[delete-message] assistant control crashed (entry kept alive):", error, info?.componentStack ?? "");
					}
					componentDidUpdate(prevProps) {
						// Self-recovery: a transient crash (e.g. an unexpected snapshot
						// shape mid-load) must not stick forever — retry the control
						// whenever the target message changes.
						if (this.state.error !== null && prevProps.messageId !== this.props.messageId) {
							this.setState({ error: null });
						}
					}
					render() {
						if (this.state.error !== null) {
							return jsx("span", { className: "dshdm-failure", role: "status", children: "⚠" });
						}
						return jsx(AssistantDeleteControl, this.props);
					}
				}

				function AssistantDeleteControl(props) {
					const { messageId, sessionId, useSession, t: translate } = props;
					const t = typeof translate === "function" ? translate : translateWith(zh);
					sessionIds.note(typeof sessionId === "string" ? sessionId : undefined);
					// The standard kit provides useSession; substitute an inert hook
					// ONLY if that ever changes, keeping hook order stable so a
					// missing face degrades to a disabled button instead of a crash.
					const safeUseSession = typeof useSession === "function" ? useSession : () => undefined;
					const resolved = safeUseSession((snapshot) => findSeqByMessageId(snapshot, messageId));
					const snapshot = safeUseSession((s) => s);
					const [busy, setBusy] = react.useState(false);
					const [failure, setFailure] = react.useState(null);
					const buttonRef = react.useRef(null);
					// The shared DOM tooltip instead of the React Tooltip clone: one
					// less moving part inside the slot entry, identical bubble.
					react.useEffect(() => {
						const el = buttonRef.current;
						if (el === null) return undefined;
						return attachTooltip(el, () => t("delete"));
					}, [t]);

					// On every snapshot revision, hide every ledger-tracked row via
					// the chat-node key path — this is the authoritative load-time
					// sweep (fiber-based resolution from the DOM path may fail for
					// assistant-step rows whose wrapper has no hover root). The whole
					// ledger goes in as one plan: exact seqs plus turn ranges, so
					// stale tool/call chrome inside a deleted turn heals too.
					react.useEffect(() => {
						if (snapshot === null || snapshot === undefined) return;
						const sid = sessionIds.current();
						if (typeof sid !== "string") return;
						const entry = ledgerFor(sid);
						if (entry.seqs.size === 0 && entry.ranges.length === 0) return;
						hideRowsForSeqViaChatNodes(sid, { seqs: [...entry.seqs], ranges: entry.ranges }, snapshot);
					}, [snapshot]);

					const onDelete = async () => {
						if (typeof sessionId !== "string" || busy) return;
						if (typeof resolved !== "number") {
							setFailure(t("reason.not-found"));
							return;
						}
						setBusy(true);
						setFailure(null);
						const outcome = await makeDeleteFlow(t)(sessionId, resolved, "assistant");
						setBusy(false);
						if (outcome?.ok) {
							const plan = {
								seqs: replacedSeqsOf(outcome, resolved),
								ranges: outcome?.mode === "turn" && outcome?.range !== undefined ? [outcome.range] : []
							};
							console.info("[delete-message] assistant reply deleted (session %s, %d node(s), mode %s)", sessionId, plan.seqs.length, outcome?.mode ?? "single");
							hideRowsBySeq(sessionId, plan);
							hideRowsForSeqViaChatNodes(sessionId, plan, snapshot);
						} else if (outcome?.error === "already-shadowed") {
							// The server already replaced this node (a prior delete landed
							// but rows were never hidden). Treat as a visual success.
							console.info("[delete-message] assistant seq %d already shadowed; hiding row (session %s)", resolved, sessionId);
							hideRowsBySeq(sessionId, [resolved]);
							hideRowsForSeqViaChatNodes(sessionId, [resolved], snapshot);
						} else if (outcome?.cancelled !== true && outcome?.error !== undefined) {
							const reasonKey = `reason.${outcome.error}`;
							const reason = t(reasonKey);
							setFailure(reason === reasonKey ? outcome.error : reason);
						}
					};

					const disabled = busy || typeof resolved !== "number";
					return jsxs(react.Fragment, {
						children: [
							failure !== null && jsx("span", { className: "dshdm-failure", role: "status", children: failure }),
							jsx("button", {
								ref: buttonRef,
								type: "button",
								className: ACTION_CLASS,
								"aria-label": t("deleteAria"),
								disabled: disabled || undefined,
								onClick: onDelete,
								children: jsx(TrashGlyph, {})
							})
						]
					});
				}

				ctx.slots.inject("conversation.chat.assistant-actions", () => {
					console.info("[delete-message] conversation.chat.assistant-actions declared; registering");
					return ctx.slots.register(
						{ name: "conversation.chat.assistant-actions", id: "delete-message", order: 10, locale: NS },
						DeleteControlBoundary
					);
				});
			} catch (error) {
				console.error("[delete-message] could not take the assistant-actions seat:", error);
			}

			// Mount 2 — user rows (DOM enhancement).
			try {
				startDomEnhancement(sessionIds, detectDomLocale() === "en" ? translateWith(en) : translateWith(zh));
			} catch (error) {
				console.error("[delete-message] DOM enhancement failed to start:", error);
			}
		}

		const exports_ = {
			inject,
			apply,
			findSeqByMessageId,
			seqFromFiber,
			resolveRowSeq,
			probeElementsFor,
			resolveWrapperSeq,
			processFlowItem,
			hideRowsBySeq,
			hideRowsForSeqViaChatNodes,
			asSeqList,
			replacedSeqsOf,
			asPlan,
			planCovers,
			ledgerHas,
			ledgerMark,
			ledgerMarkRange,
			ledgerFor,
			openConfirmDialog,
			openNoticeDialog,
			safeQueryAll,
			enhanceUserRow,
			startDomEnhancement,
			looksLikeActionsStrip,
			ACTIONS_TOKEN,
			translateWith,
			detectDomLocale,
			Tooltip,
			attachTooltip,
			injectStyleOnce,
			TrashGlyph,
			TRASH_SVG_HTML,
			zh,
			en,
			NS,
			ACTION_CLASS,
			BUBBLE_CLASS,
			STRIP_MARK,
			HIDDEN_MARK,
			LEDGER_PREFIX,
			STATUS_PATH,
			DELETE_PATH
		};
		console.info("[delete-message] factory ready; exports:", Object.keys(exports_).join(", "));
		return exports_;
	}
});
