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
 * Click trash → styled confirm dialog stating the message will be removed
 * from the history record AND the model context → POST
 * `/api/delete-message/delete` → the session snapshot refreshes and the
 * transcript shows the placeholder row. A refusal surfaces the host's reason
 * code as localized copy.
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

		/** Localized copy. Keys mirror the refusal codes the host returns. */
		const zh = {
			delete: "删除",
			deleteAria: "删除这条消息",
			confirmTitle: "删除这条消息？",
			confirmBody: "将从历史记录和模型上下文中删除这条消息（日志原文保留，可恢复）。",
			cancel: "取消",
			close: "关闭",
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
			cancel: "Cancel",
			close: "Close",
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
				const parts = key.split(".");
				let value = dictionary;
				for (const part of parts) value = value?.[part];
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
				for (let hops = 0; fiber !== undefined && hops < 30; hops += 1, fiber = fiber.return) {
					const props = fiber.memoizedProps;
					if (typeof onSessionId === "function" && typeof props?.sessionId === "string") {
						onSessionId(props.sessionId);
					}
					const node = props?.node;
					if (node !== undefined && node !== null && typeof node === "object") {
						const kind = node.kind ?? "";
						if (kind === "user" || kind === "steering") {
							const seq = node.data?.seq ?? node.location?.seq;
							if (typeof seq === "number") return seq;
						}
					}
				}
			} catch {
				// Fiber layout changed; fall through to the refusal below.
			}
			return undefined;
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
		// Confirm dialog — a plain-DOM replica of the primitives Modal +
		// Button pair (the same structure RiskConfirmation composes): blurred
		// mask, 380px card, header with close glyph, description, footer with
		// outline-cancel + primary-confirm. Escape / mask / close all cancel.
		// Resolves true only on confirm.
		// ------------------------------------------------------------------

		function openConfirmDialog({ title, description, confirmLabel, cancelLabel, closeLabel }) {
			return new Promise((resolve) => {
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

				dialog.append(header, body, footer);
				root.append(mask, dialog);

				const finish = (answer) => {
					document.removeEventListener("keydown", onKeyDown, true);
					root.remove();
					opener?.focus?.();
					resolve(answer);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") finish(false);
				};

				mask.addEventListener("click", () => finish(false));
				closeButton.addEventListener("click", () => finish(false));
				cancelButton.addEventListener("click", () => finish(false));
				confirmButton.addEventListener("click", () => finish(true));
				document.addEventListener("keydown", onKeyDown, true);

				document.body.appendChild(root);
				confirmButton.focus();
			});
		}

		// ------------------------------------------------------------------
		// Shared confirm-then-delete flow used by both mounts.
		// ------------------------------------------------------------------
		function makeDeleteFlow(t) {
			return async function runDelete(sessionId, seq) {
				const confirmed = await openConfirmDialog({
					title: t("confirmTitle"),
					description: t("confirmBody"),
					confirmLabel: t("delete"),
					cancelLabel: t("cancel"),
					closeLabel: t("close")
				});
				if (!confirmed) return { ok: false, cancelled: true };
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
		function enhanceUserRow(strip, sessionIdOf, t) {
			for (const stale of strip.querySelectorAll(":scope > button[data-dsh-delete-icon]")) stale.remove();
			if (strip.hasAttribute(STRIP_MARK)) return;
			const copyButton = strip.querySelector(":scope > button");
			if (copyButton === null) return;

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
						const sessionId = sessionIdOf();
						if (sessionId === undefined) {
							window.alert(`${t("failed")}: ${t("reason.not-found")}`);
							return;
						}
						// Resolve the row identity through a REACT-OWNED sibling: the
						// injected trash never passed through React, so it carries no
						// __reactFiber$ key and walking IT always came up empty. The
						// copy button is re-queried at click time so the anchor can
						// never go stale across host re-renders.
						const fiberAnchor = strip.querySelector(":scope > button:not([data-dsh-delete-icon])");
						const seq = seqFromFiber(fiberAnchor, (id) => sessionIdOf.note(id));
						if (typeof seq !== "number") {
							console.warn("[delete-message] could not resolve seq for this user row; refusing to guess");
							window.alert(`${t("failed")}: ${t("reason.not-found")}`);
							return;
						}
						const outcome = await makeDeleteFlow(t)(sessionId, seq);
						if (outcome?.ok) console.info("[delete-message] user message deleted (session %s seq %d)", sessionId, seq);
						else if (outcome?.cancelled !== true && outcome?.error !== undefined) {
							const reasonKey = `reason.${outcome.error}`;
							const reason = t(reasonKey);
							window.alert(`${t("failed")}: ${reason === reasonKey ? outcome.error : reason}`);
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
		function startDomEnhancement(sessionIdOf, t) {
			const disposers = [];
			let lastSweep = 0;
			const sweepStrayIcons = (now) => {
				if (now - lastSweep < 1500) return;
				lastSweep = now;
				for (const icon of document.querySelectorAll("button[data-dsh-delete-icon]")) {
					const strip = icon.parentElement;
					if (strip === null || !looksLikeActionsStrip(strip) || !strip.hasAttribute(STRIP_MARK)) {
						icon.remove();
					}
				}
			};
			const observer = new MutationObserver((mutations) => {
				sweepStrayIcons(Date.now());
				for (const mutation of mutations) {
					for (const node of mutation.addedNodes) {
						if (!(node instanceof Element)) continue;
						const candidates = [node, ...node.querySelectorAll("*")];
						for (const el of candidates) {
							if (!el.matches("[data-time-hover-root]")) continue;
							if (el.hasAttribute("data-turn-tail")) continue;
							if (el.hasAttribute("data-pending-steering")) continue;
							for (const child of el.children) {
								if (child.hasAttribute(STRIP_MARK)) continue;
								if (!looksLikeActionsStrip(child)) continue;
								const disposer = enhanceUserRow(child, sessionIdOf, t);
								if (typeof disposer === "function") disposers.push(disposer);
							}
						}
					}
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });
			console.info("[delete-message] DOM enhancement active (user rows)");
			return () => {
				observer.disconnect();
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

					const onDelete = async () => {
						if (typeof sessionId !== "string" || busy) return;
						if (typeof resolved !== "number") {
							setFailure(t("reason.not-found"));
							return;
						}
						setBusy(true);
						setFailure(null);
						const outcome = await makeDeleteFlow(t)(sessionId, resolved);
						setBusy(false);
						if (outcome?.ok) console.info("[delete-message] assistant message deleted (session %s seq %d)", sessionId, resolved);
						else if (outcome?.cancelled !== true && outcome?.error !== undefined) {
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
				startDomEnhancement(() => sessionIds.current(), detectDomLocale() === "en" ? translateWith(en) : translateWith(zh));
			} catch (error) {
				console.error("[delete-message] DOM enhancement failed to start:", error);
			}
		}

		const exports_ = {
			inject,
			apply,
			findSeqByMessageId,
			seqFromFiber,
			enhanceUserRow,
			startDomEnhancement,
			looksLikeActionsStrip,
			ACTIONS_TOKEN,
			translateWith,
			detectDomLocale,
			Tooltip,
			attachTooltip,
			openConfirmDialog,
			injectStyleOnce,
			TrashGlyph,
			TRASH_SVG_HTML,
			zh,
			en,
			NS,
			ACTION_CLASS,
			BUBBLE_CLASS,
			STRIP_MARK,
			STATUS_PATH,
			DELETE_PATH
		};
		console.info("[delete-message] factory ready; exports:", Object.keys(exports_).join(", "));
		return exports_;
	}
});
